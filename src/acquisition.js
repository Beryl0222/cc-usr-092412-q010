/** 批量采集：按运行计划推进检查点，单个运行失败后可从断点继续，已完成运行不重采。 */

export function openBatch(store, { batch_id, run_ids, actor, now }) {
  if (store.byAggregate("batch_session", batch_id).some((event) => event.event_type === "BATCH_OPENED")) {
    throw new Error(`采集批次已存在：${batch_id}`);
  }
  if (!Array.isArray(run_ids) || run_ids.length === 0) throw new Error("采集批次至少包含一个运行");
  return store.emit({
    event_type: "BATCH_OPENED", aggregate_type: "batch_session", aggregate_id: batch_id,
    occurred_at: now ?? new Date().toISOString(),
    summary: `开启采集批次 ${batch_id}（${run_ids.length} 个运行）`,
    actor, payload: { run_ids },
  });
}

export function batchProgress(store, batchId) {
  const opened = store.byAggregate("batch_session", batchId).find((event) => event.event_type === "BATCH_OPENED");
  if (!opened) throw new Error(`采集批次不存在：${batchId}`);
  const completed = [];
  const failed = [];
  for (const event of store.byAggregate("batch_session", batchId)) {
    if (event.event_type !== "BATCH_CHECKPOINT") continue;
    if (event.payload.status === "completed") completed.push(event.payload.run_id);
    if (event.payload.status === "failed") failed.push({ run_id: event.payload.run_id, reason: event.payload.reason ?? null });
  }
  const pending = opened.payload.run_ids.filter((runId) => !completed.includes(runId));
  return { plan: opened.payload.run_ids, completed, failed, pending };
}

export function recordCheckpoint(store, { batch_id, run_id, status, reason = null, actor, now }) {
  const progress = batchProgress(store, batch_id);
  if (!progress.plan.includes(run_id)) throw new Error(`运行 ${run_id} 不在批次 ${batch_id} 计划内`);
  if (progress.completed.includes(run_id)) throw new Error(`运行 ${run_id} 已完成，不重复记录检查点`);
  if (!["completed", "failed"].includes(status)) throw new Error(`未知检查点状态：${status}`);
  if (status === "failed" && (!reason || reason.trim() === "")) throw new Error("失败检查点必须填写原因");
  return store.emit({
    event_type: "BATCH_CHECKPOINT", aggregate_type: "batch_session", aggregate_id: batch_id,
    occurred_at: now ?? new Date().toISOString(),
    summary: `批次 ${batch_id} 检查点：${run_id} ${status === "completed" ? "完成" : `失败（${reason}）`}`,
    actor, payload: { run_id, status, reason },
  });
}

/** 从断点续采：返回尚未完成的运行（含失败待重试者），并记录续采事件。 */
export function resumeBatch(store, { batch_id, actor, now }) {
  const progress = batchProgress(store, batch_id);
  if (progress.pending.length === 0) throw new Error(`批次 ${batch_id} 没有待续运行`);
  store.emit({
    event_type: "BATCH_RESUMED", aggregate_type: "batch_session", aggregate_id: batch_id,
    occurred_at: now ?? new Date().toISOString(),
    summary: `批次 ${batch_id} 从 ${progress.pending[0]} 续采（余 ${progress.pending.length} 个运行）`,
    actor, payload: { resume_from: progress.pending[0], pending: progress.pending },
  });
  return progress.pending;
}
