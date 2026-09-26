import { randomUUID } from "node:crypto";

import { EventStore, canonicalize, sha256 } from "./store.js";

/** 领域错误：code 供调用方程序化判断，message 面向人。 */
export class DomainError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "DomainError";
    this.code = code;
  }
}

const EPS = 1e-9;
const roundQ = (value) => Math.round(value * 1e9) / 1e9;

function assertQuantity(quantity, label) {
  if (
    !quantity ||
    typeof quantity.value !== "number" ||
    Number.isNaN(quantity.value) ||
    quantity.value < 0 ||
    typeof quantity.unit !== "string" ||
    quantity.unit.length === 0
  ) {
    throw new DomainError("INVALID_QUANTITY", `${label} 必须是 {value >= 0, unit} 结构`);
  }
}

function assertReason(reason, message) {
  if (typeof reason !== "string" || reason.trim().length === 0) {
    throw new DomainError("REASON_REQUIRED", message);
  }
}

/**
 * 盲样谱系与复现实验服务。
 *
 * 所有状态变化都以不可变事件追加到 EventStore（哈希链），
 * 服务内投影只用于查询与校验；标识、时间、版本一经写入不得原地改写，
 * 更正只能通过新的后继事件完成。
 *
 * 角色：formulator（配方）、blind_admin（盲码管理员，独立角色）、
 * analyst（分析员）、operator（仪器操作）、qa（签署/解盲复核）、reviewer（复核人）。
 */
export class LineageService {
  #store;
  #clock;

  constructor({ store, clock } = {}) {
    this.#store = store ?? new EventStore();
    this.#clock = clock ?? (() => new Date().toISOString());
    // 查询投影
    this.lots = new Map(); // lotId -> { lotId, material, unit, quantity, available }
    this.samples = new Map(); // sampleId -> { sampleId, kind, unit, available, parents, blindCode? }
    this.paramSets = new Map(); // paramSetId -> Map(version -> content)
    this.calibrations = new Map(); // calibrationId -> { ..., invalidated? }
    this.runs = new Map(); // runId -> 运行投影
    this.curves = new Map(); // curveId -> 曲线投影
    this.studies = new Map(); // studyId -> 盲态研究（含封存映射）
    this.exclusions = new Map(); // exclusionId -> 剔除单
    this.reports = new Map(); // reportId -> 报告投影
    this.ingestBatches = new Map(); // batchId -> 采集批次
    this.investigations = new Map(); // investigationId -> 调查单
    this.deviceDigests = new Map(); // deviceSerial -> Map(curveDigest -> { runId })
    this.edges = []; // 谱系边 { from, to, relation }
  }

  // ---------------------------------------------------------------- 基础

  get store() {
    return this.#store;
  }

  #emit(eventType, aggregateType, aggregateId, summary, data, actor, { sealed = false } = {}) {
    const event = {
      event_id: `evt-${randomUUID()}`,
      event_type: eventType,
      aggregate_type: aggregateType,
      aggregate_id: aggregateId,
      occurred_at: this.#clock(),
      version: this.#store.size + 1,
      summary,
      actor: actor ? { id: actor.id, role: actor.role } : null,
      sealed,
      data,
    };
    return this.#store.append(event);
  }

  #link(from, to, relation) {
    this.edges.push(Object.freeze({ from, to, relation }));
  }

  /** 查找物料节点（原料批次或样品），返回可扣减可用量的容器。 */
  #material(id) {
    if (this.lots.has(id)) return this.lots.get(id);
    if (this.samples.has(id)) return this.samples.get(id);
    throw new DomainError("MATERIAL_NOT_FOUND", `找不到物料节点：${id}`);
  }

  #consumeMaterial(id, quantity, label) {
    const node = this.#material(id);
    assertQuantity(quantity, label);
    if (quantity.unit !== node.unit) {
      throw new DomainError("UNIT_MISMATCH", `${label} 单位 ${quantity.unit} 与节点 ${id} 单位 ${node.unit} 不一致`);
    }
    if (quantity.value > node.available + EPS) {
      throw new DomainError(
        "CONSERVATION_VIOLATED",
        `${label} 需要 ${quantity.value}${quantity.unit}，节点 ${id} 仅剩 ${node.available}${node.unit}`,
      );
    }
    node.available = roundQ(node.available - quantity.value);
    return node;
  }

  // ---------------------------------------------------------- 原料与谱系

  /** 登记原料批次。 */
  registerIngredientLot({ lotId, material, quantity, actor }) {
    if (this.lots.has(lotId) || this.samples.has(lotId)) {
      throw new DomainError("DUPLICATE_ID", `物料标识已存在：${lotId}`);
    }
    assertQuantity(quantity, "批次数量");
    if (quantity.value <= 0) throw new DomainError("INVALID_QUANTITY", "批次数量必须大于 0");
    this.lots.set(lotId, {
      lotId,
      material,
      unit: quantity.unit,
      quantity: quantity.value,
      available: quantity.value,
    });
    return this.#emit("LOT_REGISTERED", "ingredient_lot", lotId, `登记原料批次 ${lotId}（${material}）`, { lotId, material, quantity }, actor);
  }

  /**
   * 登记预处理：消耗若干物料节点，产出一个预处理样品节点。
   * 投入量按可用量扣减并留痕；产出量如实记录（浸泡等工艺可吸水增重，故不强制投入=产出）。
   */
  recordPretreatment({ batchId, inputs, method, parameters = {}, output, actor }) {
    if (this.samples.has(batchId) || this.lots.has(batchId)) {
      throw new DomainError("DUPLICATE_ID", `标识已存在：${batchId}`);
    }
    if (!Array.isArray(inputs) || inputs.length === 0) {
      throw new DomainError("INVALID_INPUT", "预处理至少需要一个投入节点");
    }
    assertQuantity(output.quantity, "预处理产出量");
    const consumed = [];
    for (const input of inputs) {
      this.#consumeMaterial(input.refId, input.quantity, "预处理投入");
      consumed.push({ refId: input.refId, quantity: input.quantity });
    }
    this.samples.set(batchId, {
      sampleId: batchId,
      kind: "pretreated",
      unit: output.quantity.unit,
      available: output.quantity.value,
      parents: inputs.map((input) => input.refId),
    });
    for (const input of inputs) this.#link(input.refId, batchId, "pretreated_into");
    return this.#emit(
      "PRETREATMENT_RECORDED",
      "pretreatment_batch",
      batchId,
      `预处理 ${batchId}：${method}`,
      { batchId, inputs: consumed, method, parameters, output },
      actor,
    );
  }

  /**
   * 分样：母节点拆成若干子样，数量守恒——
   * 母样减少量 = Σ子样 + 声明损耗，超出可用量即拒绝。
   */
  splitSample({ parentId, children, loss = { value: 0 }, actor }) {
    const parent = this.#material(parentId);
    if (!Array.isArray(children) || children.length === 0) {
      throw new DomainError("INVALID_INPUT", "分样至少需要一个子样");
    }
    const lossValue = loss.value ?? 0;
    if (lossValue < 0) throw new DomainError("INVALID_QUANTITY", "损耗不能为负");
    let sum = 0;
    for (const child of children) {
      if (this.samples.has(child.sampleId) || this.lots.has(child.sampleId)) {
        throw new DomainError("DUPLICATE_ID", `子样标识已存在：${child.sampleId}`);
      }
      assertQuantity(child.quantity, `子样 ${child.sampleId} 数量`);
      if (child.quantity.unit !== parent.unit) {
        throw new DomainError("UNIT_MISMATCH", `子样 ${child.sampleId} 单位与母样不一致`);
      }
      sum += child.quantity.value;
    }
    const consumed = sum + lossValue;
    if (consumed > parent.available + EPS) {
      throw new DomainError(
        "CONSERVATION_VIOLATED",
        `分样不守恒：子样合计 ${roundQ(sum)} + 损耗 ${lossValue} = ${roundQ(consumed)}${parent.unit}，超出母样可用 ${parent.available}${parent.unit}`,
      );
    }
    parent.available = roundQ(parent.available - consumed);
    for (const child of children) {
      this.samples.set(child.sampleId, {
        sampleId: child.sampleId,
        kind: "split",
        unit: parent.unit,
        available: child.quantity.value,
        parents: [parentId],
      });
      this.#link(parentId, child.sampleId, "split_into");
    }
    return this.#emit(
      "SAMPLE_SPLIT",
      "sample",
      parentId,
      `分样 ${parentId} → ${children.map((c) => c.sampleId).join("、")}（损耗 ${lossValue}${parent.unit}）`,
      { parentId, children, loss: { value: lossValue, unit: parent.unit }, consumed, remaining: parent.available },
      actor,
    );
  }

  /**
   * 合样：多个节点合并为一个节点，数量守恒——
   * Σ各投入消耗量 = 产出量 + 声明损耗，否则拒绝。
   */
  mergeSamples({ inputs, output, loss = { value: 0 }, actor }) {
    if (this.samples.has(output.sampleId) || this.lots.has(output.sampleId)) {
      throw new DomainError("DUPLICATE_ID", `标识已存在：${output.sampleId}`);
    }
    if (!Array.isArray(inputs) || inputs.length === 0) {
      throw new DomainError("INVALID_INPUT", "合样至少需要一个投入节点");
    }
    assertQuantity(output.quantity, "合样产出量");
    const lossValue = loss.value ?? 0;
    if (lossValue < 0) throw new DomainError("INVALID_QUANTITY", "损耗不能为负");
    let sum = 0;
    let unit = null;
    for (const input of inputs) {
      const node = this.#material(input.refId);
      assertQuantity(input.quantity, `合样投入 ${input.refId}`);
      if (unit === null) unit = node.unit;
      if (node.unit !== unit) throw new DomainError("UNIT_MISMATCH", "合样投入单位不一致");
      if (input.quantity.value > node.available + EPS) {
        throw new DomainError("CONSERVATION_VIOLATED", `节点 ${input.refId} 可用量不足`);
      }
      sum += input.quantity.value;
    }
    if (output.quantity.unit !== unit) throw new DomainError("UNIT_MISMATCH", "合样产出单位与投入不一致");
    if (Math.abs(sum - (output.quantity.value + lossValue)) > EPS) {
      throw new DomainError(
        "CONSERVATION_VIOLATED",
        `合样不守恒：投入合计 ${roundQ(sum)}${unit} ≠ 产出 ${output.quantity.value} + 损耗 ${lossValue}`,
      );
    }
    for (const input of inputs) {
      const node = this.#material(input.refId);
      node.available = roundQ(node.available - input.quantity.value);
    }
    this.samples.set(output.sampleId, {
      sampleId: output.sampleId,
      kind: "merged",
      unit,
      available: output.quantity.value,
      parents: inputs.map((input) => input.refId),
    });
    for (const input of inputs) this.#link(input.refId, output.sampleId, "merged_into");
    return this.#emit(
      "SAMPLES_MERGED",
      "sample",
      output.sampleId,
      `合样 ${inputs.map((i) => i.refId).join("、")} → ${output.sampleId}`,
      { inputs, output, loss: { value: lossValue, unit } },
      actor,
    );
  }

  /** 登记过程参数集的某一版本；同一 (paramSetId, version) 不得覆盖。 */
  registerProcessParameters({ paramSetId, version, content, actor }) {
    if (!Number.isInteger(version) || version < 1) {
      throw new DomainError("INVALID_VERSION", "参数版本必须是正整数");
    }
    if (!this.paramSets.has(paramSetId)) this.paramSets.set(paramSetId, new Map());
    const versions = this.paramSets.get(paramSetId);
    if (versions.has(version)) {
      throw new DomainError("DUPLICATE_VERSION", `参数集 ${paramSetId} 版本 ${version} 已存在，参数更正须使用新版本`);
    }
    versions.set(version, Object.freeze(structuredClone(content)));
    return this.#emit(
      "PARAMS_REGISTERED",
      "parameter_set",
      paramSetId,
      `登记过程参数 ${paramSetId} v${version}`,
      { paramSetId, version, content },
      actor,
    );
  }

  // ---------------------------------------------------------- 盲码与解盲

  /**
   * 为一批配方生成盲码。只能由独立角色 blind_admin 执行。
   * 配方↔盲码映射写入封存事件（sealed），在规定条件满足并解盲前，
   * 任何非 blind_admin 角色都无法通过服务接口读到映射。
   */
  generateBlindCodes({ studyId, formulas, conditions = {}, actor }) {
    if (actor?.role !== "blind_admin") {
      throw new DomainError("ROLE_DENIED", "盲码只能由独立的盲码管理员生成");
    }
    if (this.studies.has(studyId)) throw new DomainError("DUPLICATE_ID", `研究已存在：${studyId}`);
    if (!Array.isArray(formulas) || formulas.length === 0) {
      throw new DomainError("INVALID_INPUT", "至少需要一个配方标识");
    }
    const codes = new Map();
    for (const formulaId of formulas) {
      codes.set(`BLD-${randomUUID().slice(0, 8).toUpperCase()}`, formulaId);
    }
    const study = {
      studyId,
      codes, // blindCode -> formulaId（封存）
      assignments: new Map(), // blindCode -> sampleId
      conditions: {
        minCompletedRuns: conditions.minCompletedRuns ?? 0,
        requireNoPendingExclusions: conditions.requireNoPendingExclusions ?? true,
      },
      unblinded: false,
    };
    this.studies.set(studyId, study);
    this.#emit(
      "BLIND_CODES_GENERATED",
      "study",
      studyId,
      `研究 ${studyId} 生成 ${codes.size} 个盲码（映射已封存）`,
      { studyId, blindCodes: [...codes.keys()], conditions: study.conditions },
      actor,
    );
    // 映射单独封存：解盲前对非 blind_admin 不可见
    this.#emit(
      "BLIND_MAPPING_SEALED",
      "study",
      studyId,
      `研究 ${studyId} 配方↔盲码映射封存`,
      { studyId, mapping: Object.fromEntries(codes) },
      actor,
      { sealed: true },
    );
    return [...codes.keys()];
  }

  /** 盲码管理员把盲码绑定到具体样品（分析员只知盲码，不知配方）。 */
  assignBlindCode({ studyId, sampleId, blindCode, actor }) {
    if (actor?.role !== "blind_admin") {
      throw new DomainError("ROLE_DENIED", "盲码绑定只能由盲码管理员执行");
    }
    const study = this.#study(studyId);
    if (!study.codes.has(blindCode)) throw new DomainError("BLIND_CODE_UNKNOWN", `盲码不属于研究 ${studyId}：${blindCode}`);
    if (study.assignments.has(blindCode)) throw new DomainError("BLIND_CODE_ASSIGNED", `盲码已绑定：${blindCode}`);
    const sample = this.samples.get(sampleId);
    if (!sample) throw new DomainError("MATERIAL_NOT_FOUND", `找不到样品：${sampleId}`);
    if (sample.blindCode) throw new DomainError("BLIND_CODE_ASSIGNED", `样品已绑定盲码：${sampleId}`);
    sample.blindCode = blindCode;
    study.assignments.set(blindCode, sampleId);
    return this.#emit("BLIND_CODE_ASSIGNED", "study", studyId, `样品 ${sampleId} 绑定盲码 ${blindCode}`, { studyId, sampleId, blindCode }, actor);
  }

  #study(studyId) {
    const study = this.studies.get(studyId);
    if (!study) throw new DomainError("STUDY_NOT_FOUND", `找不到研究：${studyId}`);
    return study;
  }

  #blindCodeOwner(blindCode) {
    for (const study of this.studies.values()) {
      if (study.codes.has(blindCode)) return study;
    }
    return null;
  }

  #canSeeFormula(study, actor) {
    return study.unblinded || actor?.role === "blind_admin";
  }

  /**
   * 解盲：只有满足研究登记时声明的条件（完成运行数达标、无未决剔除单）
   * 才允许；解盲动作本身留痕。
   */
  requestUnblind({ studyId, actor }) {
    if (actor?.role !== "blind_admin" && actor?.role !== "qa") {
      throw new DomainError("ROLE_DENIED", "解盲须由盲码管理员或质量角色发起");
    }
    const study = this.#study(studyId);
    if (study.unblinded) throw new DomainError("ALREADY_UNBLINDED", `研究 ${studyId} 已解盲`);
    const completed = [...this.runs.values()].filter(
      (run) => run.studyId === studyId && run.status === "completed" && !run.excluded,
    ).length;
    if (completed < study.conditions.minCompletedRuns) {
      throw new DomainError(
        "UNBLIND_CONDITIONS_UNMET",
        `解盲条件未满足：已完成运行 ${completed}，要求 ${study.conditions.minCompletedRuns}`,
      );
    }
    if (study.conditions.requireNoPendingExclusions) {
      const pending = [...this.exclusions.values()].filter(
        (ex) => ex.status === "pending" && this.#exclusionStudy(ex) === studyId,
      );
      if (pending.length > 0) {
        throw new DomainError("UNBLIND_CONDITIONS_UNMET", `解盲条件未满足：存在 ${pending.length} 张未决剔除单`);
      }
    }
    study.unblinded = true;
    return this.#emit("UNBLINDED", "study", studyId, `研究 ${studyId} 解盲`, { studyId, mapping: Object.fromEntries(study.codes) }, actor);
  }

  #exclusionStudy(exclusion) {
    const runId = exclusion.targetType === "run" ? exclusion.targetId : exclusion.runId;
    return this.runs.get(runId)?.studyId ?? null;
  }

  // ---------------------------------------------------------- 校准与运行

  /** 登记仪器校准版本及其有效区间。 */
  registerCalibration({ calibrationId, deviceSerial, version, validFrom, validTo, actor }) {
    if (this.calibrations.has(calibrationId)) {
      throw new DomainError("DUPLICATE_ID", `校准记录已存在：${calibrationId}`);
    }
    this.calibrations.set(calibrationId, { calibrationId, deviceSerial, version, validFrom, validTo, invalidated: null });
    return this.#emit(
      "CALIBRATION_REGISTERED",
      "calibration_record",
      calibrationId,
      `登记校准 ${calibrationId}（设备 ${deviceSerial}，v${version}）`,
      { calibrationId, deviceSerial, version, validFrom, validTo },
      actor,
    );
  }

  /**
   * 启动仪器运行：把盲样、过程参数版本、校准版本、设备序号不可变地
   * 绑定到一条运行上；校准失效或不在有效期内即拒绝。
   */
  startRun({ runId, blindCode, paramSetId, paramVersion, calibrationId, deviceSerial, actor }) {
    if (this.runs.has(runId)) throw new DomainError("DUPLICATE_ID", `运行已存在：${runId}`);
    const study = this.#blindCodeOwner(blindCode);
    if (!study) throw new DomainError("BLIND_CODE_UNKNOWN", `未知盲码：${blindCode}`);
    const sampleId = study.assignments.get(blindCode);
    if (!sampleId) throw new DomainError("BLIND_CODE_UNASSIGNED", `盲码尚未绑定样品：${blindCode}`);
    const params = this.paramSets.get(paramSetId)?.get(paramVersion);
    if (!params) throw new DomainError("PARAM_VERSION_UNKNOWN", `参数集 ${paramSetId} 没有版本 ${paramVersion}`);
    const calibration = this.calibrations.get(calibrationId);
    if (!calibration) throw new DomainError("CALIBRATION_UNKNOWN", `未知校准记录：${calibrationId}`);
    if (calibration.deviceSerial !== deviceSerial) {
      throw new DomainError("CALIBRATION_DEVICE_MISMATCH", `校准 ${calibrationId} 属于设备 ${calibration.deviceSerial}，不是 ${deviceSerial}`);
    }
    if (calibration.invalidated) throw new DomainError("CALIBRATION_INVALID", `校准 ${calibrationId} 已失效`);
    const now = this.#clock();
    if (now < calibration.validFrom || now > calibration.validTo) {
      throw new DomainError("CALIBRATION_EXPIRED", `校准 ${calibrationId} 在 ${now} 不在有效期 ${calibration.validFrom}~${calibration.validTo}`);
    }
    const run = {
      runId,
      studyId: study.studyId,
      blindCode,
      sampleId,
      paramSetId,
      paramVersion,
      calibrationId,
      deviceSerial,
      status: "active",
      excluded: false,
      startedAt: now,
      operator: actor?.id ?? null,
      curves: [],
      measurements: [],
    };
    this.runs.set(runId, run);
    this.#link(sampleId, runId, "tested_in");
    this.#link(`${paramSetId}@${paramVersion}`, runId, "used_parameters");
    this.#link(calibrationId, runId, "used_calibration");
    return this.#emit(
      "RUN_STARTED",
      "instrument_run",
      runId,
      `运行 ${runId}：盲码 ${blindCode}，参数 ${paramSetId} v${paramVersion}，校准 ${calibrationId}`,
      { runId, blindCode, sampleId, paramSetId, paramVersion, calibrationId, deviceSerial },
      actor,
    );
  }

  /** 挂载质构曲线文件（按内容摘要留痕）。冻结/剔除的运行拒绝写入。 */
  attachCurve({ runId, curveId, digest, contentHash, deviceSerial, actor, via = null }) {
    const run = this.#run(runId);
    this.#assertRunWritable(run);
    const id = curveId ?? `curve-${runId}-${run.curves.length + 1}`;
    if (this.curves.has(id)) throw new DomainError("DUPLICATE_ID", `曲线已存在：${id}`);
    const curve = { curveId: id, runId, digest, contentHash, deviceSerial: deviceSerial ?? run.deviceSerial, attachedAt: this.#clock(), via };
    run.curves.push(curve);
    this.curves.set(id, curve);
    this.#link(runId, id, "produced");
    return this.#emit("CURVE_ATTACHED", "curve_file", id, `运行 ${runId} 挂载曲线 ${id}（摘要 ${digest}）`, { ...curve }, actor);
  }

  /** 完成运行：至少一条曲线方可完成。 */
  completeRun({ runId, actor }) {
    const run = this.#run(runId);
    this.#assertRunWritable(run);
    if (run.curves.length === 0) throw new DomainError("RUN_INCOMPLETE", `运行 ${runId} 尚无曲线，不能完成`);
    run.status = "completed";
    return this.#emit("RUN_COMPLETED", "instrument_run", runId, `运行 ${runId} 完成`, { runId }, actor);
  }

  /**
   * 校准失效：只冻结使用了该校准且启动时间落在受影响区间内的运行，
   * 其余运行不受影响。冻结运行禁止再写入曲线/测量，也不能进入报告。
   */
  invalidateCalibration({ calibrationId, reason, affectedFrom, affectedTo, actor }) {
    const calibration = this.calibrations.get(calibrationId);
    if (!calibration) throw new DomainError("CALIBRATION_UNKNOWN", `未知校准记录：${calibrationId}`);
    assertReason(reason, "校准失效必须给出理由");
    if (calibration.invalidated) throw new DomainError("CALIBRATION_INVALID", `校准 ${calibrationId} 已失效过`);
    calibration.invalidated = { reason, at: this.#clock(), by: actor?.id ?? null };
    this.#emit(
      "CALIBRATION_INVALIDATED",
      "calibration_record",
      calibrationId,
      `校准 ${calibrationId} 失效：${reason}`,
      { calibrationId, reason, affectedFrom, affectedTo },
      actor,
    );
    const frozen = [];
    for (const run of this.runs.values()) {
      if (run.calibrationId !== calibrationId) continue;
      if (run.startedAt < affectedFrom || run.startedAt > affectedTo) continue;
      if (run.status === "frozen") continue;
      run.status = "frozen";
      run.freezeReason = `校准 ${calibrationId} 失效`;
      frozen.push(run.runId);
      this.#emit("RUN_FROZEN", "instrument_run", run.runId, `运行 ${run.runId} 因校准失效冻结`, { runId: run.runId, calibrationId, reason }, actor);
    }
    return frozen;
  }

  /** 冻结运行凭新的有效校准重新启用（留痕，需理由）。 */
  requalifyRun({ runId, calibrationId, reason, actor }) {
    const run = this.#run(runId);
    if (run.status !== "frozen") throw new DomainError("RUN_NOT_FROZEN", `运行 ${runId} 不在冻结状态`);
    assertReason(reason, "重新启用必须给出理由");
    const calibration = this.calibrations.get(calibrationId);
    if (!calibration) throw new DomainError("CALIBRATION_UNKNOWN", `未知校准记录：${calibrationId}`);
    if (calibration.deviceSerial !== run.deviceSerial) {
      throw new DomainError("CALIBRATION_DEVICE_MISMATCH", "新校准与运行设备不一致");
    }
    if (calibration.invalidated) throw new DomainError("CALIBRATION_INVALID", `校准 ${calibrationId} 已失效`);
    run.calibrationId = calibrationId;
    run.status = "active";
    delete run.freezeReason;
    return this.#emit("RUN_REQUALIFIED", "instrument_run", runId, `运行 ${runId} 凭校准 ${calibrationId} 重新启用`, { runId, calibrationId, reason }, actor);
  }

  #run(runId) {
    const run = this.runs.get(runId);
    if (!run) throw new DomainError("RUN_NOT_FOUND", `找不到运行：${runId}`);
    return run;
  }

  #assertRunWritable(run) {
    if (run.status === "frozen") throw new DomainError("RUN_FROZEN", `运行 ${run.runId} 已冻结：${run.freezeReason}`);
    if (run.excluded) throw new DomainError("RUN_EXCLUDED", `运行 ${run.runId} 已被剔除`);
  }

  // ---------------------------------------------------------- 测量与剔除

  /**
   * 记录测量。重复测量（repeatOf 指向同运行的既有测量）必须给出理由。
   * 若运行已被某份已签署报告引用，测量照常记录但打上 postSignature 标记，
   * 绝不进入该报告快照。
   */
  recordMeasurement({ runId, measurementId, value, unit, actor, repeatOf = null, reason = null }) {
    const run = this.#run(runId);
    this.#assertRunWritable(run);
    if (repeatOf !== null) {
      if (!run.measurements.some((m) => m.measurementId === repeatOf)) {
        throw new DomainError("REPEAT_TARGET_UNKNOWN", `运行 ${runId} 上没有测量 ${repeatOf}`);
      }
      assertReason(reason, "重复测量必须给出理由");
    }
    const id = measurementId ?? `meas-${runId}-${run.measurements.length + 1}`;
    if (run.measurements.some((m) => m.measurementId === id)) {
      throw new DomainError("DUPLICATE_ID", `测量已存在：${id}`);
    }
    const signedReports = [...this.reports.values()].filter((r) => r.status === "signed" && r.runIds.includes(runId));
    const measurement = {
      measurementId: id,
      runId,
      value,
      unit,
      repeatOf,
      reason,
      excluded: false,
      postSignature: signedReports.length > 0,
      signedReportIds: signedReports.map((r) => r.reportId),
      recordedAt: this.#clock(),
      actor: actor?.id ?? null,
    };
    run.measurements.push(measurement);
    this.#emit(
      "MEASUREMENT_RECORDED",
      "measurement",
      id,
      `运行 ${runId} 记录测量 ${id}${repeatOf ? "（重复测量）" : ""}${measurement.postSignature ? "（签署后补录）" : ""}`,
      { ...measurement },
      actor,
    );
    return measurement;
  }

  /** 发起人工剔除：必须给出理由，进入待确认状态。 */
  requestExclusion({ targetType, targetId, reason, actor }) {
    assertReason(reason, "人工剔除必须给出理由");
    const target = this.#exclusionTarget(targetType, targetId);
    const exclusionId = `excl-${randomUUID().slice(0, 8)}`;
    this.exclusions.set(exclusionId, {
      exclusionId,
      targetType,
      targetId,
      runId: target.runId,
      reason,
      requestedBy: actor?.id ?? null,
      status: "pending",
    });
    this.#emit(
      "EXCLUSION_REQUESTED",
      "measurement",
      targetId,
      `申请剔除 ${targetType} ${targetId}：${reason}`,
      { exclusionId, targetType, targetId, reason },
      actor,
    );
    return exclusionId;
  }

  /** 第二人确认剔除：确认人不能是申请人；已签署报告引用的对象拒绝剔除。 */
  confirmExclusion({ exclusionId, actor }) {
    const exclusion = this.#exclusion(exclusionId);
    if (exclusion.status !== "pending") throw new DomainError("EXCLUSION_CLOSED", `剔除单 ${exclusionId} 已关闭`);
    if (actor?.id === exclusion.requestedBy) {
      throw new DomainError("SECOND_PERSON_REQUIRED", "剔除确认必须由申请人之外的第二人完成");
    }
    this.#assertNotInSignedReport(exclusion);
    this.#exclusionTarget(exclusion.targetType, exclusion.targetId).excluded = true;
    exclusion.status = "confirmed";
    exclusion.confirmedBy = actor?.id ?? null;
    return this.#emit(
      "EXCLUSION_CONFIRMED",
      "measurement",
      exclusion.targetId,
      `剔除 ${exclusion.targetType} ${exclusion.targetId} 经第二人确认`,
      { exclusionId, confirmedBy: exclusion.confirmedBy },
      actor,
    );
  }

  /** 第二人驳回剔除。 */
  rejectExclusion({ exclusionId, actor }) {
    const exclusion = this.#exclusion(exclusionId);
    if (exclusion.status !== "pending") throw new DomainError("EXCLUSION_CLOSED", `剔除单 ${exclusionId} 已关闭`);
    if (actor?.id === exclusion.requestedBy) {
      throw new DomainError("SECOND_PERSON_REQUIRED", "剔除驳回必须由申请人之外的第二人完成");
    }
    exclusion.status = "rejected";
    exclusion.rejectedBy = actor?.id ?? null;
    return this.#emit("EXCLUSION_REJECTED", "measurement", exclusion.targetId, `剔除单 ${exclusionId} 被驳回`, { exclusionId }, actor);
  }

  #exclusion(exclusionId) {
    const exclusion = this.exclusions.get(exclusionId);
    if (!exclusion) throw new DomainError("EXCLUSION_NOT_FOUND", `找不到剔除单：${exclusionId}`);
    return exclusion;
  }

  #exclusionTarget(targetType, targetId) {
    if (targetType === "run") return this.#run(targetId);
    if (targetType === "measurement") {
      for (const run of this.runs.values()) {
        const found = run.measurements.find((m) => m.measurementId === targetId);
        if (found) return found;
      }
      throw new DomainError("MEASUREMENT_NOT_FOUND", `找不到测量：${targetId}`);
    }
    throw new DomainError("INVALID_TARGET", `未知剔除对象类型：${targetType}`);
  }

  #assertNotInSignedReport(exclusion) {
    const runId = exclusion.targetType === "run" ? exclusion.targetId : exclusion.runId;
    const signed = [...this.reports.values()].find((r) => r.status === "signed" && r.runIds.includes(runId));
    if (signed) {
      throw new DomainError(
        "SIGNED_REPORT_IMMUTABLE",
        `对象已被已签署报告 ${signed.reportId} 引用，不能剔除；如需变更请修订报告产生新版本`,
      );
    }
  }

  // ---------------------------------------------------------- 报告与签署

  /**
   * 形成结论：报告引用一组确定的运行，创建时对每条运行的
   * 曲线摘要、测量集合、参数版本、校准版本做快照并计算摘要。
   */
  createReport({ reportId, runIds, conclusion, actor, version = 1, supersedes = null }) {
    if (this.reports.has(reportId)) throw new DomainError("DUPLICATE_ID", `报告已存在：${reportId}`);
    if (!Array.isArray(runIds) || runIds.length === 0) throw new DomainError("INVALID_INPUT", "报告至少引用一条运行");
    const snapshot = runIds.map((runId) => {
      const run = this.#run(runId);
      if (run.status !== "completed") throw new DomainError("RUN_NOT_COMPLETED", `运行 ${runId} 未完成，不能进入报告`);
      if (run.excluded) throw new DomainError("RUN_EXCLUDED", `运行 ${runId} 已被剔除，不能进入报告`);
      const measurements = run.measurements.filter((m) => !m.excluded).map((m) => m.measurementId);
      const entry = {
        runId,
        blindCode: run.blindCode,
        paramSetId: run.paramSetId,
        paramVersion: run.paramVersion,
        calibrationId: run.calibrationId,
        deviceSerial: run.deviceSerial,
        curves: run.curves.map((c) => ({ curveId: c.curveId, digest: c.digest, contentHash: c.contentHash })),
        measurements,
      };
      entry.runDigest = sha256(canonicalize(entry));
      return entry;
    });
    const snapshotHash = sha256(canonicalize(snapshot));
    const report = {
      reportId,
      version,
      supersedes,
      runIds: [...runIds],
      conclusion,
      status: "draft",
      snapshot,
      snapshotHash,
      createdAt: this.#clock(),
      signedBy: null,
      signedAt: null,
    };
    this.reports.set(reportId, report);
    for (const runId of runIds) this.#link(runId, reportId, "concluded_in");
    return this.#emit(
      "REPORT_CREATED",
      "report",
      reportId,
      `报告 ${reportId} v${version} 形成结论，引用 ${runIds.length} 条运行（快照 ${snapshotHash.slice(0, 12)}…）`,
      { reportId, version, supersedes, runIds, conclusion, snapshotHash },
      actor,
    );
  }

  /** 签署报告：签署后试验集合与快照冻结，任何变更只能走修订产生新版本。 */
  signReport({ reportId, actor }) {
    if (actor?.role !== "qa") throw new DomainError("ROLE_DENIED", "报告须由质量角色签署");
    const report = this.#report(reportId);
    if (report.status !== "draft") throw new DomainError("REPORT_CLOSED", `报告 ${reportId} 已签署`);
    report.status = "signed";
    report.signedBy = actor.id;
    report.signedAt = this.#clock();
    return this.#emit(
      "REPORT_SIGNED",
      "report",
      reportId,
      `报告 ${reportId} v${report.version} 由 ${actor.id} 签署`,
      { reportId, version: report.version, snapshotHash: report.snapshotHash, signedBy: actor.id },
      actor,
    );
  }

  /** 修订已签署报告：产生引用旧版的新版本，旧版保持原样。 */
  reviseReport({ reportId, newReportId, runIds, conclusion, actor }) {
    const previous = this.#report(reportId);
    if (previous.status !== "signed") throw new DomainError("REPORT_NOT_SIGNED", "只有已签署报告才需要修订");
    this.createReport({ reportId: newReportId, runIds, conclusion, actor, version: previous.version + 1, supersedes: reportId });
    return this.reports.get(newReportId);
  }

  #report(reportId) {
    const report = this.reports.get(reportId);
    if (!report) throw new DomainError("REPORT_NOT_FOUND", `找不到报告：${reportId}`);
    return report;
  }

  /**
   * 读取报告：快照保持签署时原样；签署后补录到相关运行的数据
   * 单独列在 lateMeasurements，绝不悄悄并入快照。
   */
  getReport({ reportId }) {
    const report = this.#report(reportId);
    const lateMeasurements = [];
    if (report.status === "signed") {
      for (const runId of report.runIds) {
        for (const m of this.runs.get(runId).measurements) {
          if (m.postSignature && m.signedReportIds.includes(reportId)) lateMeasurements.push({ ...m });
        }
      }
    }
    return { ...report, lateMeasurements };
  }

  /**
   * 完整性核验：确认签署快照中的曲线摘要、测量集合至今未被改动，
   * 并列出被隔离在报告之外的补录数据。
   */
  auditReport({ reportId }) {
    const report = this.#report(reportId);
    const issues = [];
    for (const entry of report.snapshot) {
      const run = this.runs.get(entry.runId);
      if (!run) {
        issues.push(`运行 ${entry.runId} 已不存在`);
        continue;
      }
      for (const curve of entry.curves) {
        const current = run.curves.find((c) => c.curveId === curve.curveId);
        if (!current) issues.push(`曲线 ${curve.curveId} 缺失`);
        else if (current.digest !== curve.digest || current.contentHash !== curve.contentHash) {
          issues.push(`曲线 ${curve.curveId} 摘要被改动`);
        }
      }
      for (const measurementId of entry.measurements) {
        const current = run.measurements.find((m) => m.measurementId === measurementId);
        if (!current) issues.push(`测量 ${measurementId} 缺失`);
        else if (current.excluded) issues.push(`测量 ${measurementId} 在签署后被剔除`);
      }
    }
    return { reportId, intact: issues.length === 0, issues, lateMeasurements: this.getReport({ reportId }).lateMeasurements };
  }

  // ---------------------------------------------------------- 批量采集

  /** 开启批量采集：逐条处理、逐条检查点，单个运行失败不拖垮整批。 */
  startIngestionBatch({ batchId, deviceSerial, actor }) {
    if (this.ingestBatches.has(batchId)) throw new DomainError("DUPLICATE_ID", `采集批次已存在：${batchId}`);
    const batch = {
      batchId,
      deviceSerial,
      actor: actor ? { id: actor.id, role: actor.role } : null,
      processed: 0,
      stats: { ingested: 0, duplicates: 0, investigations: 0 },
      status: "active",
      checkpoint: { nextIndex: 0 },
    };
    this.ingestBatches.set(batchId, batch);
    this.#emit("INGESTION_BATCH_STARTED", "ingestion_batch", batchId, `采集批次 ${batchId} 开始（设备 ${deviceSerial}）`, { batchId, deviceSerial }, actor);
    return batch;
  }

  /**
   * 处理采集条目（曲线文件上传）。从上次检查点继续；
   * 某条校验失败时记录检查点并暂停，修正后用 resumeIngestionBatch 续传。
   * 幂等：同一设备序号 + 同一曲线摘要的重传不重复计数；
   * 同一运行/同一摘要但内容不一致的进入调查队列。
   */
  ingestBatchItems({ batchId, items, actor }) {
    const batch = this.#ingestBatch(batchId);
    if (batch.status === "paused") {
      throw new DomainError("BATCH_PAUSED", `批次 ${batchId} 处于暂停状态，请用 resumeIngestionBatch 从检查点继续`);
    }
    for (let i = batch.processed; i < items.length; i += 1) {
      try {
        this.#ingestOne(batch, items[i]);
      } catch (error) {
        if (!(error instanceof DomainError)) throw error;
        batch.status = "paused";
        batch.checkpoint = { nextIndex: i, error: { code: error.code, message: error.message }, item: items[i] };
        this.#emit(
          "INGESTION_CHECKPOINT",
          "ingestion_batch",
          batchId,
          `批次 ${batchId} 在第 ${i} 条暂停：${error.message}`,
          { batchId, checkpoint: batch.checkpoint, stats: { ...batch.stats } },
          actor ?? batch.actor,
        );
        return { status: "paused", checkpoint: batch.checkpoint, stats: { ...batch.stats } };
      }
      batch.processed = i + 1;
    }
    batch.status = "completed";
    batch.checkpoint = { nextIndex: items.length };
    this.#emit(
      "INGESTION_BATCH_COMPLETED",
      "ingestion_batch",
      batchId,
      `批次 ${batchId} 完成：采集 ${batch.stats.ingested}，去重 ${batch.stats.duplicates}，调查 ${batch.stats.investigations}`,
      { batchId, stats: { ...batch.stats } },
      actor ?? batch.actor,
    );
    return { status: "completed", stats: { ...batch.stats } };
  }

  /** 从检查点继续：items 为完整原始列表（可修正失败条目），从断点处接着处理。 */
  resumeIngestionBatch({ batchId, items, actor }) {
    const batch = this.#ingestBatch(batchId);
    if (batch.status !== "paused") throw new DomainError("BATCH_NOT_PAUSED", `批次 ${batchId} 不在暂停状态`);
    batch.status = "active";
    return this.ingestBatchItems({ batchId, items, actor });
  }

  #ingestBatch(batchId) {
    const batch = this.ingestBatches.get(batchId);
    if (!batch) throw new DomainError("BATCH_NOT_FOUND", `找不到采集批次：${batchId}`);
    return batch;
  }

  #ingestOne(batch, item) {
    const { runId, blindCode, curveDigest, contentHash } = item;
    const deviceSerial = item.deviceSerial ?? batch.deviceSerial;
    if (!this.deviceDigests.has(deviceSerial)) this.deviceDigests.set(deviceSerial, new Map());
    const digestIndex = this.deviceDigests.get(deviceSerial);
    // 重传去重：同设备 + 同曲线摘要
    if (digestIndex.has(curveDigest)) {
      const previous = digestIndex.get(curveDigest);
      if (previous.runId === runId) {
        batch.stats.duplicates += 1;
        return;
      }
      this.#openInvestigation(batch, item, `曲线摘要 ${curveDigest} 已属于运行 ${previous.runId}，却又随运行 ${runId} 上传`);
      batch.stats.investigations += 1;
      return;
    }
    const run = this.#run(runId); // 运行不存在 → 失败并留下检查点
    if (run.blindCode !== blindCode) {
      throw new DomainError("BLIND_CODE_MISMATCH", `运行 ${runId} 的盲码是 ${run.blindCode}，上传条目写的是 ${blindCode}`);
    }
    if (run.status === "frozen") throw new DomainError("RUN_FROZEN", `运行 ${runId} 已冻结：${run.freezeReason}`);
    // 同一曲线标识重传：内容一致按去重处理，内容不同进入调查
    if (item.curveId) {
      const existing = run.curves.find((c) => c.curveId === item.curveId);
      if (existing) {
        if (existing.digest === curveDigest && existing.deviceSerial === deviceSerial) {
          batch.stats.duplicates += 1;
        } else {
          this.#openInvestigation(
            batch,
            item,
            `曲线 ${item.curveId} 重传内容不一致：既有摘要 ${existing.digest}，新摘要 ${curveDigest}`,
          );
          batch.stats.investigations += 1;
        }
        return;
      }
    }
    this.attachCurve({
      runId,
      curveId: item.curveId,
      digest: curveDigest,
      contentHash,
      deviceSerial,
      actor: batch.actor,
      via: batch.batchId,
    });
    digestIndex.set(curveDigest, { runId });
    batch.stats.ingested += 1;
  }

  #openInvestigation(batch, item, reason) {
    const investigationId = `inv-${randomUUID().slice(0, 8)}`;
    this.investigations.set(investigationId, {
      investigationId,
      batchId: batch.batchId,
      runId: item.runId ?? null,
      reason,
      item,
      status: "open",
      openedAt: this.#clock(),
    });
    this.#emit(
      "INVESTIGATION_OPENED",
      "investigation",
      investigationId,
      `开启调查 ${investigationId}：${reason}`,
      { investigationId, batchId: batch.batchId, reason, item },
      batch.actor,
    );
    return investigationId;
  }

  listInvestigations({ status } = {}) {
    const all = [...this.investigations.values()].map((inv) => ({ ...inv }));
    return status ? all.filter((inv) => inv.status === status) : all;
  }

  /** 结案调查：给出处理决定并留痕。 */
  resolveInvestigation({ investigationId, decision, actor }) {
    const investigation = this.investigations.get(investigationId);
    if (!investigation) throw new DomainError("INVESTIGATION_NOT_FOUND", `找不到调查：${investigationId}`);
    if (investigation.status !== "open") throw new DomainError("INVESTIGATION_CLOSED", `调查 ${investigationId} 已结案`);
    assertReason(decision, "调查结案必须给出处理决定");
    investigation.status = "resolved";
    investigation.decision = decision;
    investigation.resolvedBy = actor?.id ?? null;
    return this.#emit("INVESTIGATION_RESOLVED", "investigation", investigationId, `调查 ${investigationId} 结案：${decision}`, { investigationId, decision }, actor);
  }

  // ---------------------------------------------------------- 查询与追溯

  /** 样品视图：解盲前（且非盲码管理员）不返回配方标识。 */
  viewSample({ sampleId, actor }) {
    const sample = this.samples.get(sampleId);
    if (!sample) throw new DomainError("MATERIAL_NOT_FOUND", `找不到样品：${sampleId}`);
    const view = {
      sampleId: sample.sampleId,
      kind: sample.kind,
      unit: sample.unit,
      available: sample.available,
      parents: [...sample.parents],
      blindCode: sample.blindCode ?? null,
    };
    if (sample.blindCode) {
      const study = this.#blindCodeOwner(sample.blindCode);
      if (this.#canSeeFormula(study, actor)) view.formulaId = study.codes.get(sample.blindCode);
    }
    return view;
  }

  /** 运行视图：同样按盲态脱敏。 */
  viewRun({ runId, actor }) {
    const run = this.#run(runId);
    const study = this.studies.get(run.studyId);
    const view = {
      runId: run.runId,
      blindCode: run.blindCode,
      sampleId: run.sampleId,
      status: run.status,
      excluded: run.excluded,
      paramSetId: run.paramSetId,
      paramVersion: run.paramVersion,
      calibrationId: run.calibrationId,
      deviceSerial: run.deviceSerial,
      startedAt: run.startedAt,
      curves: run.curves.map((c) => ({ ...c })),
      measurements: run.measurements.map((m) => ({ ...m })),
    };
    if (run.freezeReason) view.freezeReason = run.freezeReason;
    if (this.#canSeeFormula(study, actor)) view.formulaId = study.codes.get(run.blindCode);
    return view;
  }

  /** 事件列表：封存事件在解盲前对非盲码管理员隐藏正文。 */
  listEvents({ actor } = {}) {
    return this.#store.all().map((event) => {
      if (!event.sealed) return event;
      const study = this.studies.get(event.data?.studyId);
      if (study && this.#canSeeFormula(study, actor)) return event;
      const { data, ...rest } = event;
      return { ...rest, data: { redacted: true, note: "封存事件，解盲前不可见" } };
    });
  }

  /**
   * 谱系追溯：从任意节点（原料、样品、运行、曲线、报告）沿不可变边
   * 反向走到全部上游证据，返回节点与边。
   */
  traceLineage(targetId) {
    const visited = new Set([targetId]);
    const queue = [targetId];
    const collected = new Set();
    while (queue.length > 0) {
      const id = queue.shift();
      for (const edge of this.edges) {
        // 反向走到上游证据；同时带上运行向下产出的曲线（证据链的一环）
        const isUpstream = edge.to === id;
        const isProducedEvidence = edge.from === id && edge.relation === "produced";
        if (!isUpstream && !isProducedEvidence) continue;
        if (collected.has(edge)) continue;
        collected.add(edge);
        const next = isUpstream ? edge.from : edge.to;
        if (!visited.has(next)) {
          visited.add(next);
          queue.push(next);
        }
      }
    }
    return {
      root: targetId,
      nodes: [...visited].map((id) => this.#describeNode(id)),
      edges: [...collected],
    };
  }

  #describeNode(id) {
    if (this.lots.has(id)) {
      const lot = this.lots.get(id);
      return { id, type: "ingredient_lot", material: lot.material, quantity: { value: lot.quantity, unit: lot.unit } };
    }
    if (this.samples.has(id)) {
      const sample = this.samples.get(id);
      return { id, type: "sample", kind: sample.kind, blindCode: sample.blindCode ?? null };
    }
    if (this.runs.has(id)) {
      const run = this.runs.get(id);
      return { id, type: "instrument_run", status: run.status, blindCode: run.blindCode, deviceSerial: run.deviceSerial };
    }
    if (this.curves.has(id)) {
      const curve = this.curves.get(id);
      return { id, type: "curve_file", digest: curve.digest, contentHash: curve.contentHash };
    }
    if (this.calibrations.has(id)) {
      const cal = this.calibrations.get(id);
      return { id, type: "calibration_record", deviceSerial: cal.deviceSerial, version: cal.version, invalidated: Boolean(cal.invalidated) };
    }
    if (this.reports.has(id)) {
      const report = this.reports.get(id);
      return { id, type: "report", version: report.version, status: report.status, snapshotHash: report.snapshotHash };
    }
    const paramMatch = /^(?<paramSetId>.+)@(?<version>\d+)$/.exec(id);
    if (paramMatch && this.paramSets.get(paramMatch.groups.paramSetId)?.has(Number(paramMatch.groups.version))) {
      return { id, type: "parameter_set", paramSetId: paramMatch.groups.paramSetId, version: Number(paramMatch.groups.version) };
    }
    return { id, type: "unknown" };
  }

  /**
   * 复核人数据包：从已签署报告出发，汇集每条运行的曲线、测量、
   * 参数版本、校准证据与完整上游谱系（直到原料批次）。
   * 未解盲时不含任何配方标识；manifest 为内容摘要，同一状态重复构建结果一致，
   * 复核人可据此独立复算验证。
   */
  buildReviewerPackage({ reportId, actor }) {
    const report = this.#report(reportId);
    if (report.status !== "signed") throw new DomainError("REPORT_NOT_SIGNED", "只有已签署报告才能生成复核数据包");
    const studyIds = new Set(report.runIds.map((runId) => this.runs.get(runId).studyId));
    const revealFormula = [...studyIds].every((id) => this.#canSeeFormula(this.studies.get(id), actor));
    const lineage = this.traceLineage(reportId);
    const runs = report.runIds.map((runId) => {
      const view = this.viewRun({ runId, actor: revealFormula ? { role: "blind_admin" } : null });
      delete view.formulaId;
      if (revealFormula) view.formulaId = this.studies.get(this.runs.get(runId).studyId).codes.get(view.blindCode);
      return view;
    });
    const parameters = report.snapshot.map((entry) => ({
      paramSetId: entry.paramSetId,
      version: entry.paramVersion,
      content: structuredClone(this.paramSets.get(entry.paramSetId).get(entry.paramVersion)),
    }));
    const calibrations = [...new Set(report.snapshot.map((entry) => entry.calibrationId))].map((id) => {
      const cal = this.calibrations.get(id);
      return { calibrationId: id, deviceSerial: cal.deviceSerial, version: cal.version, validFrom: cal.validFrom, validTo: cal.validTo };
    });
    const content = {
      reportId,
      reportVersion: report.version,
      snapshotHash: report.snapshotHash,
      conclusion: report.conclusion,
      blinded: !revealFormula,
      runs,
      parameters,
      calibrations,
      lineage,
    };
    return { ...content, generatedAt: this.#clock(), recipient: actor?.id ?? null, manifest: sha256(canonicalize(content)) };
  }
}
