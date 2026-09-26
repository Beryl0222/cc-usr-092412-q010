import { digestOf } from "./hash.js";
import { coveringCalibration, frozenRunIds } from "./calibration.js";
import { lineageProjection } from "./lineage.js";

function runStarted(store, runId) {
  return store.byAggregate("experiment_run", runId).find((event) => event.event_type === "RUN_STARTED") ?? null;
}

function requireReason(reason, message) {
  if (!reason || reason.trim() === "") throw new Error(message);
}

/** 开始一次仪器运行：样品须存在，仪器在开始时点须持有效校准，并把校准证书钉进运行记录。 */
export function startRun(store, { run_id, study_id, sample_id, instrument_id, process_params, actor, now }) {
  const occurredAt = now ?? new Date().toISOString();
  if (runStarted(store, run_id)) throw new Error(`运行已存在：${run_id}`);
  if (!lineageProjection(store).has(sample_id)) throw new Error(`样品不存在：${sample_id}`);
  const calibration = coveringCalibration(store, instrument_id, occurredAt);
  if (!calibration) throw new Error(`仪器 ${instrument_id} 在 ${occurredAt} 缺少有效校准，禁止开始运行`);
  return store.emit({
    event_type: "RUN_STARTED", aggregate_type: "experiment_run", aggregate_id: run_id,
    occurred_at: occurredAt,
    summary: `开始运行 ${run_id}（样品 ${sample_id}，仪器 ${instrument_id}）`,
    actor,
    payload: {
      study_id, sample_id, instrument_id,
      process_params: process_params ?? null,
      calibration_certificate: calibration.payload.certificate_id,
    },
  });
}

function finishRun(store, { run_id, event_type, summary, reason, actor, now }) {
  if (!runStarted(store, run_id)) throw new Error(`运行不存在：${run_id}`);
  const terminal = store
    .byAggregate("experiment_run", run_id)
    .some((event) => event.event_type === "RUN_COMPLETED" || event.event_type === "RUN_FAILED");
  if (terminal) throw new Error(`运行已终结：${run_id}`);
  return store.emit({
    event_type, aggregate_type: "experiment_run", aggregate_id: run_id,
    occurred_at: now ?? new Date().toISOString(),
    summary, actor, payload: reason ? { reason } : {},
  });
}

export function completeRun(store, { run_id, actor, now }) {
  return finishRun(store, { run_id, event_type: "RUN_COMPLETED", summary: `运行 ${run_id} 完成`, actor, now });
}

export function failRun(store, { run_id, reason, actor, now }) {
  requireReason(reason, "运行失败必须填写原因");
  return finishRun(store, { run_id, event_type: "RUN_FAILED", summary: `运行 ${run_id} 失败：${reason}`, reason, actor, now });
}

/**
 * 幂等接收曲线：以（设备序号，曲线摘要）为键。
 * 同键同内容 → 重传不重复计数；同键不同内容 → 开立调查并隔离该次传输。
 */
export function ingestMeasurement(store, { run_id, device_serial, curve_digest, content_hash, curve_ref, repeat_of = null, reason = null, actor, now }) {
  const occurredAt = now ?? new Date().toISOString();
  const run = runStarted(store, run_id);
  if (!run) throw new Error(`运行不存在：${run_id}`);
  if (frozenRunIds(store).has(run_id)) throw new Error(`运行 ${run_id} 因校准失效被冻结，禁止接收曲线`);
  if (repeat_of !== null) {
    const prior = store.byAggregate("measurement_series", repeat_of).find((event) => event.event_type === "MEASUREMENT_INGESTED");
    if (!prior) throw new Error(`被重复的测量不存在：${repeat_of}`);
    requireReason(reason, "重复测量必须填写理由");
  }

  const key = `${device_serial}|${curve_digest}`;
  const known = store.byType("MEASUREMENT_INGESTED").filter((event) => `${event.payload.device_serial}|${event.payload.curve_digest}` === key);
  for (const event of known) {
    if (event.payload.content_hash === content_hash) return { status: "duplicate", measurement_id: event.aggregate_id };
  }
  const quarantined = store.byType("INVESTIGATION_OPENED").filter((event) => event.payload.key === key);
  for (const event of quarantined) {
    if (event.payload.transmission.content_hash === content_hash) return { status: "duplicate", measurement_id: null, investigation_id: event.aggregate_id };
  }
  if (known.length > 0 || quarantined.length > 0) {
    const investigationId = `INV-${String(store.byType("INVESTIGATION_OPENED").length + 1).padStart(3, "0")}`;
    store.emit({
      event_type: "INVESTIGATION_OPENED", aggregate_type: "investigation", aggregate_id: investigationId,
      occurred_at: occurredAt,
      summary: `曲线重传内容不一致，开立调查 ${investigationId}（键 ${key}）`,
      actor,
      payload: {
        key, study_id: run.payload.study_id, run_id,
        expected_content_hash: known[0]?.payload.content_hash ?? null,
        transmission: { device_serial, curve_digest, content_hash, curve_ref },
      },
    });
    return { status: "investigation", investigation_id: investigationId };
  }

  const measurementId = `MS-${digestOf(key).slice(0, 12)}`;
  store.emit({
    event_type: "MEASUREMENT_INGESTED", aggregate_type: "measurement_series", aggregate_id: measurementId,
    occurred_at: occurredAt,
    summary: `接收曲线 ${curve_digest}（运行 ${run_id}，设备 ${device_serial}）`,
    actor,
    payload: { run_id, study_id: run.payload.study_id, device_serial, curve_digest, content_hash, curve_ref, repeat_of, reason },
  });
  return { status: "ingested", measurement_id: measurementId };
}

export function resolveInvestigation(store, { investigation_id, resolution, actor, now }) {
  requireReason(resolution, "调查结案必须填写结论");
  const opened = store.byAggregate("investigation", investigation_id).find((event) => event.event_type === "INVESTIGATION_OPENED");
  if (!opened) throw new Error(`调查不存在：${investigation_id}`);
  if (store.byAggregate("investigation", investigation_id).some((event) => event.event_type === "INVESTIGATION_RESOLVED")) {
    throw new Error(`调查已结案：${investigation_id}`);
  }
  return store.emit({
    event_type: "INVESTIGATION_RESOLVED", aggregate_type: "investigation", aggregate_id: investigation_id,
    occurred_at: now ?? new Date().toISOString(),
    summary: `调查 ${investigation_id} 结案：${resolution}`,
    actor, payload: { resolution },
  });
}

/** 申请人工剔除：必须填写理由，剔除在第二人确认前不生效。 */
export function requestExclusion(store, { measurement_id, reason, actor, now }) {
  requireReason(reason, "人工剔除必须填写理由");
  const measurement = store.byAggregate("measurement_series", measurement_id).find((event) => event.event_type === "MEASUREMENT_INGESTED");
  if (!measurement) throw new Error(`测量不存在：${measurement_id}`);
  const exclusionId = `EXC-${String(store.byType("EXCLUSION_REQUESTED").length + 1).padStart(3, "0")}`;
  store.emit({
    event_type: "EXCLUSION_REQUESTED", aggregate_type: "measurement_series", aggregate_id: measurement_id,
    occurred_at: now ?? new Date().toISOString(),
    summary: `申请剔除测量 ${measurement_id}：${reason}`,
    actor, payload: { exclusion_id: exclusionId, reason, requested_by: actor },
  });
  return exclusionId;
}

function settleExclusion(store, { exclusion_id, event_type, verb, actor, now }) {
  const request = store.byType("EXCLUSION_REQUESTED").find((event) => event.payload.exclusion_id === exclusion_id);
  if (!request) throw new Error(`剔除申请不存在：${exclusion_id}`);
  const settled = store.all().some(
    (event) =>
      (event.event_type === "EXCLUSION_CONFIRMED" || event.event_type === "EXCLUSION_REJECTED") &&
      event.payload.exclusion_id === exclusion_id,
  );
  if (settled) throw new Error(`剔除申请已处理：${exclusion_id}`);
  if (actor?.id === request.payload.requested_by?.id) throw new Error(`剔除${verb}须由第二人执行`);
  return store.emit({
    event_type, aggregate_type: "measurement_series", aggregate_id: request.aggregate_id,
    occurred_at: now ?? new Date().toISOString(),
    summary: `${verb}剔除测量 ${request.aggregate_id}（${exclusion_id}）`,
    actor, payload: { exclusion_id, settled_by: actor },
  });
}

export function confirmExclusion(store, { exclusion_id, actor, now }) {
  return settleExclusion(store, { exclusion_id, event_type: "EXCLUSION_CONFIRMED", verb: "确认", actor, now });
}

export function rejectExclusion(store, { exclusion_id, actor, now }) {
  return settleExclusion(store, { exclusion_id, event_type: "EXCLUSION_REJECTED", verb: "驳回", actor, now });
}

/** 有效测量：已确认剔除的不再计入；待确认的仍计入并标记。 */
export function effectiveMeasurements(store, runId) {
  const excluded = new Set(store.byType("EXCLUSION_CONFIRMED").map((event) => event.aggregate_id));
  const settled = new Set(
    store.all()
      .filter((event) => event.event_type === "EXCLUSION_CONFIRMED" || event.event_type === "EXCLUSION_REJECTED")
      .map((event) => event.payload.exclusion_id),
  );
  const pending = new Set(
    store.byType("EXCLUSION_REQUESTED")
      .filter((event) => !settled.has(event.payload.exclusion_id))
      .map((event) => event.aggregate_id),
  );
  return store.byType("MEASUREMENT_INGESTED")
    .filter((event) => event.payload.run_id === runId && !excluded.has(event.aggregate_id))
    .map((event) => ({
      measurement_id: event.aggregate_id,
      occurred_at: event.occurred_at,
      ...event.payload,
      exclusion_pending: pending.has(event.aggregate_id),
    }));
}
