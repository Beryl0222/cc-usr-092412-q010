/** 豆类结构食品试验库使用的领域事件信封。 */
export interface DomainEvent {
  event_id: string;
  event_type: DomainEventType;
  aggregate_type: AggregateType;
  aggregate_id: string;
  occurred_at: string;
  version: number;
  summary: string;
  /** 触发事件的操作者；盲码、剔除、签署等动作据此做角色校验。 */
  actor?: Actor | null;
  /** 封存事件（如配方↔盲码映射）：解盲前正文仅对盲码管理员可见。 */
  sealed?: boolean;
  /** 事件负载，结构随 event_type 而定。 */
  data?: Record<string, unknown>;
  /** 哈希链：前序事件摘要与本事件摘要，由存储层写入。 */
  prev_hash?: string;
  hash?: string;
}

export type Role = "formulator" | "blind_admin" | "analyst" | "operator" | "qa" | "reviewer";

export interface Actor {
  id: string;
  role: Role;
}

export type AggregateType =
  | "ingredient_lot"
  | "pretreatment_batch"
  | "sample"
  | "parameter_set"
  | "instrument_run"
  | "curve_file"
  | "calibration_record"
  | "study"
  | "measurement"
  | "measurement_series"
  | "report"
  | "ingestion_batch"
  | "investigation"
  | "scaleup_trial";

export type DomainEventType =
  | "FORMULA_FROZEN"
  | "LOT_REGISTERED"
  | "PRETREATMENT_RECORDED"
  | "SAMPLE_SPLIT"
  | "SAMPLES_MERGED"
  | "PARAMS_REGISTERED"
  | "BLIND_CODES_GENERATED"
  | "BLIND_MAPPING_SEALED"
  | "BLIND_CODE_ASSIGNED"
  | "UNBLINDED"
  | "CALIBRATION_REGISTERED"
  | "CALIBRATION_INVALIDATED"
  | "RUN_STARTED"
  | "RUN_COMPLETED"
  | "RUN_FROZEN"
  | "RUN_REQUALIFIED"
  | "CURVE_ATTACHED"
  | "MEASUREMENT_INGESTED"
  | "MEASUREMENT_RECORDED"
  | "EXCLUSION_REQUESTED"
  | "EXCLUSION_CONFIRMED"
  | "EXCLUSION_REJECTED"
  | "REPORT_CREATED"
  | "REPORT_SIGNED"
  | "INGESTION_BATCH_STARTED"
  | "INGESTION_CHECKPOINT"
  | "INGESTION_BATCH_COMPLETED"
  | "INVESTIGATION_OPENED"
  | "INVESTIGATION_RESOLVED"
  | "PANEL_COMPLETED"
  | "SCALEUP_REVIEWED";
