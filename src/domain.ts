/** 豆类结构食品试验库使用的领域事件信封。 */
export interface EventActor {
  id: string;
  role: string;
}

export interface DomainEvent {
  event_id: string;
  event_type: string;
  aggregate_type: string;
  aggregate_id: string;
  occurred_at: string;
  version: number;
  summary: string;
  actor?: EventActor;
  payload?: Record<string, unknown>;
  /** 更正时指向前一条被取代的事件。 */
  supersedes?: string;
}
