import assert from "node:assert/strict";
import test from "node:test";

import { DomainError, LineageService } from "../src/lineage/service.js";
import { EventStore } from "../src/lineage/store.js";
import { validateEvent } from "../src/validator.js";

// 固定时钟：每次调用递增一分钟，保证事件时间确定且单调
function makeClock(start = "2026-09-25T08:00:00.000Z") {
  let tick = 0;
  return () => new Date(Date.parse(start) + tick++ * 60_000).toISOString();
}

const blindAdmin = { id: "u-blind", role: "blind_admin" };
const formulator = { id: "u-form", role: "formulator" };
const analyst = { id: "u-ana", role: "analyst" };
const analyst2 = { id: "u-ana2", role: "analyst" };
const operator = { id: "u-op", role: "operator" };
const qa = { id: "u-qa", role: "qa" };
const reviewer = { id: "u-rev", role: "reviewer" };

/**
 * 搭好一条完整试验链：
 * 原料批次 → 预处理 → 分样(S1,S2) → 参数/校准 → 盲码 → 运行 R1(完成)、R2
 */
function setupStudy({ minCompletedRuns = 1 } = {}) {
  const svc = new LineageService({ clock: makeClock() });
  svc.registerIngredientLot({ lotId: "LOT-1", material: "鹰嘴豆", quantity: { value: 1000, unit: "g" }, actor: formulator });
  svc.recordPretreatment({
    batchId: "PRE-1",
    inputs: [{ refId: "LOT-1", quantity: { value: 800, unit: "g" } }],
    method: "浸泡蒸煮",
    parameters: { soakHours: 12 },
    output: { quantity: { value: 780, unit: "g" } },
    actor: formulator,
  });
  svc.splitSample({
    parentId: "PRE-1",
    children: [
      { sampleId: "S-1", quantity: { value: 380, unit: "g" } },
      { sampleId: "S-2", quantity: { value: 380, unit: "g" } },
    ],
    loss: { value: 20 },
    actor: formulator,
  });
  svc.registerProcessParameters({ paramSetId: "PP-1", version: 1, content: { probe: "P/36R", speedMmS: 1 }, actor: formulator });
  svc.registerCalibration({
    calibrationId: "CAL-1",
    deviceSerial: "DEV-01",
    version: 3,
    validFrom: "2026-09-01T00:00:00.000Z",
    validTo: "2026-10-01T00:00:00.000Z",
    actor: qa,
  });
  const [codeA, codeB] = svc.generateBlindCodes({
    studyId: "STUDY-1",
    formulas: ["FORMULA-A", "FORMULA-B"],
    conditions: { minCompletedRuns },
    actor: blindAdmin,
  });
  svc.assignBlindCode({ studyId: "STUDY-1", sampleId: "S-1", blindCode: codeA, actor: blindAdmin });
  svc.assignBlindCode({ studyId: "STUDY-1", sampleId: "S-2", blindCode: codeB, actor: blindAdmin });
  svc.startRun({ runId: "R-1", blindCode: codeA, paramSetId: "PP-1", paramVersion: 1, calibrationId: "CAL-1", deviceSerial: "DEV-01", actor: operator });
  svc.startRun({ runId: "R-2", blindCode: codeB, paramSetId: "PP-1", paramVersion: 1, calibrationId: "CAL-1", deviceSerial: "DEV-01", actor: operator });
  svc.attachCurve({ runId: "R-1", curveId: "C-1", digest: "digest-c1", contentHash: "hash-c1", actor: operator });
  svc.completeRun({ runId: "R-1", actor: operator });
  return { svc, codeA, codeB };
}

// ------------------------------------------------------------ 不可变事件链

test("事件一经写入不可改写，哈希链可校验且能发现篡改", () => {
  const { svc } = setupStudy();
  assert.equal(svc.store.verify(), true);
  const original = svc.store.all();
  const first = original[0];
  assert.throws(() => {
    first.summary = "篡改";
  }, TypeError); // 事件已冻结
  // 忠实重放：同一事件序列在新存储中重现同一条链（终端摘要一致）
  const replayed = new EventStore();
  for (const event of original) replayed.append({ ...event });
  assert.equal(replayed.verify(), true);
  assert.equal(replayed.all().at(-1).hash, original.at(-1).hash);
  // 篡改重放：改动任一历史事件内容，整条链的终端摘要随之改变
  const forged = new EventStore();
  forged.append({ ...original[0], summary: "伪造摘要" });
  for (const event of original.slice(1)) forged.append({ ...event });
  assert.notEqual(forged.all().at(-1).hash, original.at(-1).hash);
});

test("服务产生的每条事件都符合既有事件信封约定", () => {
  const { svc } = setupStudy();
  for (const event of svc.store.all()) {
    assert.deepEqual(validateEvent(event), [], `事件 ${event.event_type} 缺少基础字段`);
  }
});

// ------------------------------------------------------------ 谱系与数量守恒

test("谱系把原料、预处理、分样、参数、校准、运行、曲线不可变地连起来", () => {
  const { svc } = setupStudy();
  const lineage = svc.traceLineage("C-1");
  const ids = lineage.nodes.map((n) => n.id).sort();
  assert.deepEqual(ids, ["CAL-1", "C-1", "LOT-1", "PP-1@1", "PRE-1", "R-1", "S-1"].sort());
  const relations = lineage.edges.map((e) => e.relation);
  for (const expected of ["pretreated_into", "split_into", "tested_in", "used_parameters", "used_calibration", "produced"]) {
    assert.ok(relations.includes(expected), `缺少谱系关系 ${expected}`);
  }
});

test("分样与合样保持数量守恒，透支与不平衡都被拒绝", () => {
  const svc = new LineageService({ clock: makeClock() });
  svc.registerIngredientLot({ lotId: "LOT-X", material: "芸豆", quantity: { value: 500, unit: "g" }, actor: formulator });
  // 子样 + 损耗超出母样 → 拒绝
  assert.throws(
    () =>
      svc.splitSample({
        parentId: "LOT-X",
        children: [{ sampleId: "SX-1", quantity: { value: 480, unit: "g" } }],
        loss: { value: 30 },
        actor: formulator,
      }),
    (error) => error instanceof DomainError && error.code === "CONSERVATION_VIOLATED",
  );
  svc.splitSample({
    parentId: "LOT-X",
    children: [
      { sampleId: "SX-1", quantity: { value: 200, unit: "g" } },
      { sampleId: "SX-2", quantity: { value: 200, unit: "g" } },
    ],
    loss: { value: 50 },
    actor: formulator,
  });
  assert.equal(svc.lots.get("LOT-X").available, 50); // 500 - 200 - 200 - 50
  // 合样：投入合计 ≠ 产出 + 损耗 → 拒绝
  assert.throws(
    () =>
      svc.mergeSamples({
        inputs: [
          { refId: "SX-1", quantity: { value: 100, unit: "g" } },
          { refId: "SX-2", quantity: { value: 100, unit: "g" } },
        ],
        output: { sampleId: "MX-1", quantity: { value: 190, unit: "g" } },
        loss: { value: 5 },
        actor: formulator,
      }),
    (error) => error instanceof DomainError && error.code === "CONSERVATION_VIOLATED",
  );
  svc.mergeSamples({
    inputs: [
      { refId: "SX-1", quantity: { value: 100, unit: "g" } },
      { refId: "SX-2", quantity: { value: 100, unit: "g" } },
    ],
    output: { sampleId: "MX-1", quantity: { value: 195, unit: "g" } },
    loss: { value: 5 },
    actor: formulator,
  });
  assert.equal(svc.samples.get("MX-1").available, 195);
  assert.equal(svc.samples.get("SX-1").available, 100);
});

test("过程参数同一版本不得覆盖，更正必须升版本", () => {
  const svc = new LineageService({ clock: makeClock() });
  svc.registerProcessParameters({ paramSetId: "PP-9", version: 1, content: { speedMmS: 1 }, actor: formulator });
  assert.throws(
    () => svc.registerProcessParameters({ paramSetId: "PP-9", version: 1, content: { speedMmS: 2 }, actor: formulator }),
    (error) => error.code === "DUPLICATE_VERSION",
  );
  svc.registerProcessParameters({ paramSetId: "PP-9", version: 2, content: { speedMmS: 2 }, actor: formulator });
});

// ------------------------------------------------------------ 盲码隔离与解盲

test("盲码由独立角色生成，解盲前分析员看不到配方", () => {
  const { svc, codeA } = setupStudy();
  // 非盲码管理员不能生成盲码、不能绑定
  assert.throws(
    () => svc.generateBlindCodes({ studyId: "STUDY-2", formulas: ["F"], actor: analyst }),
    (error) => error.code === "ROLE_DENIED",
  );
  assert.throws(
    () => svc.assignBlindCode({ studyId: "STUDY-1", sampleId: "S-2", blindCode: codeA, actor: analyst }),
    (error) => error.code === "ROLE_DENIED",
  );
  // 分析员视图：只有盲码，没有配方
  const sampleView = svc.viewSample({ sampleId: "S-1", actor: analyst });
  assert.equal(sampleView.blindCode, codeA);
  assert.equal("formulaId" in sampleView, false);
  const runView = svc.viewRun({ runId: "R-1", actor: analyst });
  assert.equal("formulaId" in runView, false);
  // 封存事件对分析员脱敏，对盲码管理员可见
  const sealedForAnalyst = svc.listEvents({ actor: analyst }).find((e) => e.event_type === "BLIND_MAPPING_SEALED");
  assert.equal(sealedForAnalyst.data.redacted, true);
  const sealedForAdmin = svc.listEvents({ actor: blindAdmin }).find((e) => e.event_type === "BLIND_MAPPING_SEALED");
  assert.equal(sealedForAdmin.data.mapping[codeA], "FORMULA-A");
});

test("解盲条件未满足时拒绝解盲，满足后配方可见且动作留痕", () => {
  const { svc } = setupStudy({ minCompletedRuns: 2 }); // 需要 2 条完成运行，当前只有 R-1
  assert.throws(
    () => svc.requestUnblind({ studyId: "STUDY-1", actor: qa }),
    (error) => error.code === "UNBLIND_CONDITIONS_UNMET",
  );
  // 未决剔除单同样阻止解盲
  svc.attachCurve({ runId: "R-2", curveId: "C-2", digest: "digest-c2", contentHash: "hash-c2", actor: operator });
  svc.completeRun({ runId: "R-2", actor: operator });
  svc.recordMeasurement({ runId: "R-2", measurementId: "M-1", value: 42, unit: "N", actor: analyst });
  const exclusionId = svc.requestExclusion({ targetType: "measurement", targetId: "M-1", reason: "探头打滑", actor: analyst });
  assert.throws(
    () => svc.requestUnblind({ studyId: "STUDY-1", actor: qa }),
    (error) => error.code === "UNBLIND_CONDITIONS_UNMET",
  );
  svc.rejectExclusion({ exclusionId, actor: analyst2 });
  svc.requestUnblind({ studyId: "STUDY-1", actor: qa });
  assert.equal(svc.viewRun({ runId: "R-1", actor: analyst }).formulaId, "FORMULA-A");
  assert.ok(svc.store.all().some((e) => e.event_type === "UNBLINDED"));
});

// ------------------------------------------------------------ 校准失效冻结

test("校准失效只冻结受影响区间内的运行，其余运行不受影响", () => {
  const svc = new LineageService({ clock: makeClock() });
  svc.registerIngredientLot({ lotId: "LOT-C", material: "扁豆", quantity: { value: 500, unit: "g" }, actor: formulator });
  svc.splitSample({ parentId: "LOT-C", children: [{ sampleId: "SC-1", quantity: { value: 200, unit: "g" } }], actor: formulator });
  svc.registerProcessParameters({ paramSetId: "PP-C", version: 1, content: {}, actor: formulator });
  svc.registerCalibration({ calibrationId: "CAL-OLD", deviceSerial: "DEV-01", version: 2, validFrom: "2026-09-01T00:00:00.000Z", validTo: "2026-10-01T00:00:00.000Z", actor: qa });
  svc.registerCalibration({ calibrationId: "CAL-NEW", deviceSerial: "DEV-01", version: 3, validFrom: "2026-09-01T00:00:00.000Z", validTo: "2026-10-01T00:00:00.000Z", actor: qa });
  const [code] = svc.generateBlindCodes({ studyId: "STUDY-C", formulas: ["F-C"], actor: blindAdmin });
  svc.assignBlindCode({ studyId: "STUDY-C", sampleId: "SC-1", blindCode: code, actor: blindAdmin });
  svc.startRun({ runId: "R-OLD", blindCode: code, paramSetId: "PP-C", paramVersion: 1, calibrationId: "CAL-OLD", deviceSerial: "DEV-01", actor: operator });
  svc.startRun({ runId: "R-NEW", blindCode: code, paramSetId: "PP-C", paramVersion: 1, calibrationId: "CAL-NEW", deviceSerial: "DEV-01", actor: operator });
  const frozen = svc.invalidateCalibration({
    calibrationId: "CAL-OLD",
    reason: "期间核查发现力值漂移",
    affectedFrom: "2026-09-25T00:00:00.000Z",
    affectedTo: "2026-09-26T00:00:00.000Z",
    actor: qa,
  });
  assert.deepEqual(frozen, ["R-OLD"]); // 只冻结用旧校准的运行
  assert.equal(svc.viewRun({ runId: "R-OLD", actor: analyst }).status, "frozen");
  assert.equal(svc.viewRun({ runId: "R-NEW", actor: analyst }).status, "active");
  // 冻结运行拒绝写入，也不得更改；凭新校准可重新启用
  assert.throws(
    () => svc.attachCurve({ runId: "R-OLD", curveId: "C-OLD", digest: "d", contentHash: "h", actor: operator }),
    (error) => error.code === "RUN_FROZEN",
  );
  svc.requalifyRun({ runId: "R-OLD", calibrationId: "CAL-NEW", reason: "换新校准后复测确认", actor: qa });
  assert.equal(svc.viewRun({ runId: "R-OLD", actor: analyst }).status, "active");
});

// ------------------------------------------------------------ 测量复核

test("重复测量必须给出理由，人工剔除需理由及第二人确认", () => {
  const { svc } = setupStudy();
  svc.recordMeasurement({ runId: "R-1", measurementId: "M-1", value: 50, unit: "N", actor: analyst });
  // 重复测量无理由 → 拒绝
  assert.throws(
    () => svc.recordMeasurement({ runId: "R-1", measurementId: "M-2", value: 51, unit: "N", repeatOf: "M-1", actor: analyst }),
    (error) => error.code === "REASON_REQUIRED",
  );
  svc.recordMeasurement({ runId: "R-1", measurementId: "M-2", value: 51, unit: "N", repeatOf: "M-1", reason: "首次曲线起始段异常", actor: analyst });
  // 剔除无理由 → 拒绝；申请人自审 → 拒绝
  assert.throws(
    () => svc.requestExclusion({ targetType: "measurement", targetId: "M-2", reason: " ", actor: analyst }),
    (error) => error.code === "REASON_REQUIRED",
  );
  const exclusionId = svc.requestExclusion({ targetType: "measurement", targetId: "M-2", reason: "重复测量偏离超差", actor: analyst });
  assert.throws(
    () => svc.confirmExclusion({ exclusionId, actor: analyst }),
    (error) => error.code === "SECOND_PERSON_REQUIRED",
  );
  svc.confirmExclusion({ exclusionId, actor: analyst2 });
  assert.equal(svc.viewRun({ runId: "R-1", actor: analyst }).measurements.find((m) => m.measurementId === "M-2").excluded, true);
});

// ------------------------------------------------------------ 报告与补录隔离

test("已签署报告的试验集合冻结，补录数据被隔离且可见，修订产生新版本", () => {
  const { svc } = setupStudy();
  svc.recordMeasurement({ runId: "R-1", measurementId: "M-1", value: 50, unit: "N", actor: analyst });
  svc.createReport({ reportId: "RPT-1", runIds: ["R-1"], conclusion: "配方A硬度显著高于对照", actor: analyst });
  svc.signReport({ reportId: "RPT-1", actor: qa });
  // 签署后补录：允许记录，但打标记、不进快照
  const late = svc.recordMeasurement({ runId: "R-1", measurementId: "M-2", value: 52, unit: "N", actor: analyst });
  assert.equal(late.postSignature, true);
  const report = svc.getReport({ reportId: "RPT-1" });
  assert.deepEqual(report.snapshot[0].measurements, ["M-1"]); // 快照不变
  assert.deepEqual(report.lateMeasurements.map((m) => m.measurementId), ["M-2"]); // 补录单列
  // 已签署报告引用的对象不能剔除
  const exclusionId = svc.requestExclusion({ targetType: "measurement", targetId: "M-1", reason: "事后想剔除", actor: analyst });
  assert.throws(
    () => svc.confirmExclusion({ exclusionId, actor: analyst2 }),
    (error) => error.code === "SIGNED_REPORT_IMMUTABLE",
  );
  // 完整性核验通过；补录数据没有悄悄进入
  const audit = svc.auditReport({ reportId: "RPT-1" });
  assert.equal(audit.intact, true);
  assert.equal(audit.lateMeasurements.length, 1);
  // 变更只能走修订：新版本引用旧版
  svc.attachCurve({ runId: "R-2", curveId: "C-2", digest: "digest-c2", contentHash: "hash-c2", actor: operator });
  svc.completeRun({ runId: "R-2", actor: operator });
  const revised = svc.reviseReport({ reportId: "RPT-1", newReportId: "RPT-2", runIds: ["R-1", "R-2"], conclusion: "补充配方B后结论不变", actor: analyst });
  assert.equal(revised.version, 2);
  assert.equal(revised.supersedes, "RPT-1");
  assert.equal(svc.getReport({ reportId: "RPT-1" }).status, "signed"); // 旧版原样保留
});

// ------------------------------------------------------------ 批量采集

test("批量采集：失败留检查点可续传，重传不重复计数，内容不同进调查", () => {
  const { svc } = setupStudy();
  svc.startIngestionBatch({ batchId: "BATCH-1", deviceSerial: "DEV-01", actor: operator });
  const items = [
    { runId: "R-1", blindCode: svc.runs.get("R-1").blindCode, curveDigest: "dg-1", contentHash: "ch-1" },
    { runId: "R-404", blindCode: "BLD-XXXX", curveDigest: "dg-2", contentHash: "ch-2" }, // 运行不存在 → 失败
    { runId: "R-2", blindCode: svc.runs.get("R-2").blindCode, curveDigest: "dg-3", contentHash: "ch-3" },
  ];
  const first = svc.ingestBatchItems({ batchId: "BATCH-1", items });
  assert.equal(first.status, "paused");
  assert.equal(first.checkpoint.nextIndex, 1); // 断在第 2 条
  assert.equal(first.stats.ingested, 1);
  // 暂停中不能直接重灌，必须显式续传
  assert.throws(() => svc.ingestBatchItems({ batchId: "BATCH-1", items }), (error) => error.code === "BATCH_PAUSED");
  // 修正失败条目后从检查点继续
  items[1] = { runId: "R-2", blindCode: svc.runs.get("R-2").blindCode, curveDigest: "dg-2", contentHash: "ch-2" };
  const resumed = svc.resumeIngestionBatch({ batchId: "BATCH-1", items });
  assert.equal(resumed.status, "completed");
  assert.equal(resumed.stats.ingested, 3);
  // 重传：同设备 + 同摘要 → 不重复计数
  svc.startIngestionBatch({ batchId: "BATCH-2", deviceSerial: "DEV-01", actor: operator });
  const dup = svc.ingestBatchItems({ batchId: "BATCH-2", items: [items[0], items[0]] });
  assert.equal(dup.stats.duplicates, 2);
  assert.equal(svc.runs.get("R-1").curves.filter((c) => c.digest === "dg-1").length, 1);
  // 同一曲线标识重传但内容不同 → 进入调查
  svc.startIngestionBatch({ batchId: "BATCH-3", deviceSerial: "DEV-01", actor: operator });
  const conflict = svc.ingestBatchItems({
    batchId: "BATCH-3",
    items: [{ runId: "R-1", blindCode: svc.runs.get("R-1").blindCode, curveId: "C-1", curveDigest: "dg-1-tampered", contentHash: "ch-x" }],
  });
  assert.equal(conflict.stats.investigations, 1);
  const investigations = svc.listInvestigations({ status: "open" });
  assert.equal(investigations.length, 1);
  svc.resolveInvestigation({ investigationId: investigations[0].investigationId, decision: "确认为传输错误，以首次上传为准", actor: qa });
  assert.equal(svc.listInvestigations({ status: "open" }).length, 0);
});

// ------------------------------------------------------------ 复核数据包

test("复核人数据包可追溯到原料与仪器证据，未解盲不泄露配方，且可复现", () => {
  const { svc } = setupStudy();
  svc.recordMeasurement({ runId: "R-1", measurementId: "M-1", value: 50, unit: "N", actor: analyst });
  svc.createReport({ reportId: "RPT-1", runIds: ["R-1"], conclusion: "配方A硬度达标", actor: analyst });
  svc.signReport({ reportId: "RPT-1", actor: qa });
  const pkg = svc.buildReviewerPackage({ reportId: "RPT-1", actor: reviewer });
  // 从报告追到原料批次与校准证据
  const nodeIds = pkg.lineage.nodes.map((n) => n.id);
  for (const expected of ["RPT-1", "R-1", "S-1", "PRE-1", "LOT-1", "CAL-1", "PP-1@1", "C-1"]) {
    assert.ok(nodeIds.includes(expected), `数据包谱系缺少 ${expected}`);
  }
  assert.equal(pkg.calibrations[0].calibrationId, "CAL-1");
  assert.equal(pkg.parameters[0].content.probe, "P/36R");
  // 未解盲：不含配方标识
  assert.equal(pkg.blinded, true);
  assert.equal("formulaId" in pkg.runs[0], false);
  assert.equal(JSON.stringify(pkg).includes("FORMULA-A"), false);
  // 可复现：同一状态重复构建，清单摘要一致
  const again = svc.buildReviewerPackage({ reportId: "RPT-1", actor: reviewer });
  assert.equal(again.manifest, pkg.manifest);
  // 解盲后数据包才携带配方标识
  svc.requestUnblind({ studyId: "STUDY-1", actor: qa });
  const unblinded = svc.buildReviewerPackage({ reportId: "RPT-1", actor: reviewer });
  assert.equal(unblinded.runs[0].formulaId, "FORMULA-A");
});
