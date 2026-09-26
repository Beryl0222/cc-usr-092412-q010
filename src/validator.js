export const EVENT_TYPES = [
  // 既有基线事件
  "FORMULA_FROZEN",
  "PANEL_COMPLETED",
  "SCALEUP_REVIEWED",
  // 谱系：原料批次、预处理、分样、合样
  "LOT_REGISTERED",
  "PRETREATMENT_APPLIED",
  "SAMPLE_SPLIT",
  "SAMPLE_MERGED",
  // 盲态：盲码签发与解盲
  "BLIND_CODE_ISSUED",
  "STUDY_UNBLINDED",
  // 校准
  "CALIBRATION_RECORDED",
  "CALIBRATION_INVALIDATED",
  // 运行与测量
  "RUN_STARTED",
  "RUN_COMPLETED",
  "RUN_FAILED",
  "MEASUREMENT_INGESTED",
  "EXCLUSION_REQUESTED",
  "EXCLUSION_CONFIRMED",
  "EXCLUSION_REJECTED",
  // 批量采集
  "BATCH_OPENED",
  "BATCH_CHECKPOINT",
  "BATCH_RESUMED",
  // 重传冲突调查
  "INVESTIGATION_OPENED",
  "INVESTIGATION_RESOLVED",
  // 报告
  "REPORT_CREATED",
  "REPORT_SIGNED",
  "REPORT_ADDENDUM",
];

export const AGGREGATE_TYPES = [
  "ingredient_lot",
  "sample",
  "study",
  "instrument",
  "experiment_run",
  "measurement_series",
  "batch_session",
  "investigation",
  "report",
  "scaleup_trial",
];

const required = ["event_id", "event_type", "aggregate_type", "aggregate_id", "occurred_at", "version", "summary"];

export function validateEvent(record) {
  if (record === null || typeof record !== "object" || Array.isArray(record)) return ["事件必须是对象"];
  const errors = required.filter((name) => !(name in record)).map((name) => `缺少字段：${name}`);
  if ("version" in record && (!Number.isInteger(record.version) || record.version < 1)) errors.push("version 必须是正整数");
  if ("event_type" in record && !EVENT_TYPES.includes(record.event_type)) errors.push(`未知事件类型：${record.event_type}`);
  if ("aggregate_type" in record && !AGGREGATE_TYPES.includes(record.aggregate_type)) errors.push(`未知聚合类型：${record.aggregate_type}`);
  if ("occurred_at" in record && Number.isNaN(Date.parse(record.occurred_at))) errors.push("occurred_at 不是可解析的时间");
  return errors;
}
