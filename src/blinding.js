import { randomBytes } from "node:crypto";

import { digestOf } from "./hash.js";
import { lineageProjection } from "./lineage.js";

export const CUSTODIAN_ROLE = "blinding_custodian";

/**
 * 盲码映射密封库：盲码 → 配方 的映射只存在于此处，
 * 事件流中只出现映射摘要；解盲前仅盲态管理员可读。
 */
export class BlindingVault {
  #studies = new Map();

  #study(studyId) {
    let study = this.#studies.get(studyId);
    if (!study) {
      study = { sealed: true, mappings: new Map() };
      this.#studies.set(studyId, study);
    }
    return study;
  }

  record(studyId, blindCode, mapping) {
    this.#study(studyId).mappings.set(blindCode, mapping);
  }

  unseal(studyId) {
    this.#study(studyId).sealed = false;
  }

  reveal(studyId, blindCode) {
    return this.#study(studyId).mappings.get(blindCode) ?? null;
  }

  codes(studyId) {
    return [...this.#study(studyId).mappings.keys()];
  }
}

export function isUnblinded(store, studyId) {
  return store.byAggregate("study", studyId).some((event) => event.event_type === "STUDY_UNBLINDED");
}

/** 由独立的盲态管理员签发盲码；事件只记录映射摘要，配方标识留在密封库。 */
export function issueBlindCode(store, vault, { study_id, sample_id, formula_id, actor, now }) {
  if (actor?.role !== CUSTODIAN_ROLE) throw new Error("盲码只能由盲态管理员签发");
  if (!lineageProjection(store).has(sample_id)) throw new Error(`样品不存在：${sample_id}`);
  const salt = randomBytes(8).toString("hex");
  const blindCode = `BLIND-${String(vault.codes(study_id).length + 1).padStart(3, "0")}`;
  vault.record(study_id, blindCode, { sample_id, formula_id, salt });
  store.emit({
    event_type: "BLIND_CODE_ISSUED", aggregate_type: "study", aggregate_id: study_id,
    occurred_at: now ?? new Date().toISOString(),
    summary: `签发盲码 ${blindCode}（样品 ${sample_id}）`,
    actor,
    payload: { blind_code: blindCode, sample_id, mapping_digest: digestOf({ formula_id, salt }) },
  });
  return blindCode;
}

/** 解盲前置条件：研究内运行全部终结、剔除申请全部确认、调查全部结案。 */
export function unblindConditions(store, studyId) {
  const reasons = [];
  const terminal = new Set(
    store.all()
      .filter((event) => event.event_type === "RUN_COMPLETED" || event.event_type === "RUN_FAILED")
      .map((event) => event.aggregate_id),
  );
  const openRuns = store.byType("RUN_STARTED").filter(
    (event) => event.payload?.study_id === studyId && !terminal.has(event.aggregate_id),
  );
  if (openRuns.length > 0) reasons.push(`存在未结束运行：${openRuns.map((event) => event.aggregate_id).join("、")}`);

  const resolvedExclusions = new Set(
    store.all()
      .filter((event) => event.event_type === "EXCLUSION_CONFIRMED" || event.event_type === "EXCLUSION_REJECTED")
      .map((event) => event.payload.exclusion_id),
  );
  const studyMeasurements = new Set(
    store.byType("MEASUREMENT_INGESTED")
      .filter((event) => event.payload?.study_id === studyId)
      .map((event) => event.aggregate_id),
  );
  const pendingExclusions = store.byType("EXCLUSION_REQUESTED").filter(
    (event) => studyMeasurements.has(event.aggregate_id) && !resolvedExclusions.has(event.payload.exclusion_id),
  );
  if (pendingExclusions.length > 0) reasons.push(`存在待确认的剔除申请：${pendingExclusions.map((event) => event.payload.exclusion_id).join("、")}`);

  const resolvedInvestigations = new Set(store.byType("INVESTIGATION_RESOLVED").map((event) => event.aggregate_id));
  const openInvestigations = store.byType("INVESTIGATION_OPENED").filter(
    (event) => event.payload?.study_id === studyId && !resolvedInvestigations.has(event.aggregate_id),
  );
  if (openInvestigations.length > 0) reasons.push(`存在未结案调查：${openInvestigations.map((event) => event.aggregate_id).join("、")}`);

  return { ok: reasons.length === 0, reasons };
}

export function unblind(store, vault, { study_id, actor, now }) {
  if (actor?.role !== CUSTODIAN_ROLE) throw new Error("解盲只能由盲态管理员执行");
  if (isUnblinded(store, study_id)) throw new Error(`研究已解盲：${study_id}`);
  const conditions = unblindConditions(store, study_id);
  if (!conditions.ok) throw new Error(`解盲条件未满足：${conditions.reasons.join("；")}`);
  vault.unseal(study_id);
  return store.emit({
    event_type: "STUDY_UNBLINDED", aggregate_type: "study", aggregate_id: study_id,
    occurred_at: now ?? new Date().toISOString(),
    summary: `研究 ${study_id} 解盲`,
    actor, payload: { study_id },
  });
}

/** 读取盲码对应配方：解盲前对非盲态管理员隔离。 */
export function revealFormula(store, vault, { study_id, blind_code, actor }) {
  if (!isUnblinded(store, study_id) && actor?.role !== CUSTODIAN_ROLE) {
    throw new Error("解盲前配方映射处于隔离状态，仅盲态管理员可见");
  }
  const mapping = vault.reveal(study_id, blind_code);
  if (!mapping) throw new Error(`未知盲码：${blind_code}`);
  return mapping;
}
