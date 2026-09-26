import { digestOf } from "./hash.js";
import { isUnblinded } from "./blinding.js";
import { lineageProjection } from "./lineage.js";
import { effectiveMeasurements } from "./measurements.js";

function reportCreated(store, reportId) {
  return store.byAggregate("report", reportId).find((event) => event.event_type === "REPORT_CREATED") ?? null;
}

export function reportState(store, reportId) {
  const created = reportCreated(store, reportId);
  if (!created) throw new Error(`报告不存在：${reportId}`);
  const signed = store.byAggregate("report", reportId).find((event) => event.event_type === "REPORT_SIGNED") ?? null;
  return {
    report_id: reportId,
    study_id: created.payload.study_id,
    run_ids: created.payload.run_ids,
    set_digest: created.payload.set_digest,
    signed: signed !== null,
    signed_at: signed?.occurred_at ?? null,
    conclusion: signed?.payload.conclusion ?? null,
  };
}

/** 创建报告即固定试验集合；集合摘要对运行顺序不敏感。 */
export function createReport(store, { report_id, study_id, run_ids, actor, now }) {
  if (reportCreated(store, report_id)) throw new Error(`报告已存在：${report_id}`);
  if (!Array.isArray(run_ids) || run_ids.length === 0) throw new Error("报告必须引用确定的试验集合");
  const fixed = [...new Set(run_ids)].sort();
  for (const runId of fixed) {
    if (!store.byAggregate("experiment_run", runId).some((event) => event.event_type === "RUN_STARTED")) {
      throw new Error(`运行不存在：${runId}`);
    }
  }
  return store.emit({
    event_type: "REPORT_CREATED", aggregate_type: "report", aggregate_id: report_id,
    occurred_at: now ?? new Date().toISOString(),
    summary: `创建报告 ${report_id}（研究 ${study_id}，试验集合 ${fixed.length} 个运行）`,
    actor,
    payload: { study_id, run_ids: fixed, set_digest: digestOf(fixed) },
  });
}

/** 签署结论：研究须已解盲；签署后试验集合与结论不可再改。 */
export function signReport(store, { report_id, conclusion, actor, now }) {
  const state = reportState(store, report_id);
  if (state.signed) throw new Error(`报告已签署：${report_id}`);
  if (!conclusion || conclusion.trim() === "") throw new Error("签署报告必须填写结论");
  if (!isUnblinded(store, state.study_id)) throw new Error("解盲前不得签署结论");
  return store.emit({
    event_type: "REPORT_SIGNED", aggregate_type: "report", aggregate_id: report_id,
    occurred_at: now ?? new Date().toISOString(),
    summary: `签署报告 ${report_id}：${conclusion}`,
    actor,
    payload: { conclusion, set_digest: state.set_digest, signed_by: actor },
  });
}

/** 签署后才到达、且属于报告试验集合的测量：只标记为迟到，不进入报告。 */
export function lateMeasurements(store, reportId) {
  const state = reportState(store, reportId);
  if (!state.signed) return [];
  const signedMs = Date.parse(state.signed_at);
  const runs = new Set(state.run_ids);
  return store.byType("MEASUREMENT_INGESTED")
    .filter((event) => runs.has(event.payload.run_id) && Date.parse(event.occurred_at) > signedMs)
    .map((event) => event.aggregate_id);
}

/** 补录数据只能以附录形式挂在已签署报告之后，原结论与集合摘要不变。 */
export function addAddendum(store, { report_id, measurement_ids, reason, actor, now }) {
  const state = reportState(store, report_id);
  if (!state.signed) throw new Error("仅已签署报告需要补录附录");
  if (!reason || reason.trim() === "") throw new Error("补录附录必须填写理由");
  if (!Array.isArray(measurement_ids) || measurement_ids.length === 0) throw new Error("附录必须引用至少一条测量");
  return store.emit({
    event_type: "REPORT_ADDENDUM", aggregate_type: "report", aggregate_id: report_id,
    occurred_at: now ?? new Date().toISOString(),
    summary: `报告 ${report_id} 附录：补录 ${measurement_ids.length} 条测量（${reason}）`,
    actor, payload: { measurement_ids, reason },
  });
}

/** 报告证据：固定集合内的运行及其有效测量；签署后迟到的测量不计入。 */
export function reportEvidence(store, reportId) {
  const state = reportState(store, reportId);
  const signedMs = state.signed ? Date.parse(state.signed_at) : null;
  const runs = state.run_ids.map((runId) => {
    const started = store.byAggregate("experiment_run", runId).find((event) => event.event_type === "RUN_STARTED");
    return { run_id: runId, occurred_at: started.occurred_at, ...started.payload };
  });
  const measurements = state.run_ids
    .flatMap((runId) => effectiveMeasurements(store, runId))
    .filter((measurement) => signedMs === null || Date.parse(measurement.occurred_at) <= signedMs);
  return {
    report_id: reportId,
    study_id: state.study_id,
    set_digest: state.set_digest,
    signed: state.signed,
    conclusion: state.conclusion,
    runs,
    measurements,
  };
}

function collectAncestors(nodes, sampleId, acc) {
  if (acc.has(sampleId)) return acc;
  acc.add(sampleId);
  const node = nodes.get(sampleId);
  for (const parent of node?.parents ?? []) collectAncestors(nodes, parent.sample_id, acc);
  return acc;
}

/** 从报告追到原料批次与仪器校准证据。 */
export function traceReport(store, reportId) {
  const evidence = reportEvidence(store, reportId);
  const nodes = lineageProjection(store);
  const sampleIds = new Set();
  for (const run of evidence.runs) collectAncestors(nodes, run.sample_id, sampleIds);
  const samples = [...sampleIds].map((id) => nodes.get(id)).filter(Boolean);
  const instrumentIds = [...new Set(evidence.runs.map((run) => run.instrument_id))];
  return {
    report_id: reportId,
    set_digest: evidence.set_digest,
    lots: samples.filter((node) => node.kind === "lot"),
    samples,
    runs: evidence.runs,
    measurements: evidence.measurements,
    instruments: instrumentIds,
    calibration_evidence: instrumentIds.flatMap((id) => store.byAggregate("instrument", id)),
  };
}

/**
 * 复核用盲样数据包：解盲前只含盲码、过程参数与曲线摘要，不含配方标识；
 * 同一事件流导出的数据包摘要一致，可复现核对。
 */
export function exportBlindPackage(store, vault, { study_id }) {
  const issued = store.byAggregate("study", study_id).filter((event) => event.event_type === "BLIND_CODE_ISSUED");
  if (issued.length === 0) throw new Error(`研究没有已签发的盲码：${study_id}`);
  const unblinded = isUnblinded(store, study_id);
  const entries = issued
    .map((event) => {
      const { blind_code, sample_id } = event.payload;
      const runs = store.byType("RUN_STARTED")
        .filter((run) => run.payload.sample_id === sample_id)
        .map((run) => ({
          run_id: run.aggregate_id,
          process_params: run.payload.process_params ?? null,
          calibration_certificate: run.payload.calibration_certificate ?? null,
          measurements: effectiveMeasurements(store, run.aggregate_id).map((measurement) => ({
            measurement_id: measurement.measurement_id,
            curve_digest: measurement.curve_digest,
            curve_ref: measurement.curve_ref,
            content_hash: measurement.content_hash,
            repeat_of: measurement.repeat_of,
          })),
        }))
        .sort((a, b) => a.run_id.localeCompare(b.run_id));
      const entry = { blind_code, runs };
      if (unblinded) entry.formula_id = vault.reveal(study_id, blind_code)?.formula_id ?? null;
      return entry;
    })
    .sort((a, b) => a.blind_code.localeCompare(b.blind_code));
  const pkg = { study_id, blind: !unblinded, entries };
  return { ...pkg, package_digest: digestOf(pkg) };
}
