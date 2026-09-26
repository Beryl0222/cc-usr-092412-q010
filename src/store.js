import { validateEvent } from "./validator.js";

function deepFreeze(value) {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const key of Object.keys(value)) deepFreeze(value[key]);
    Object.freeze(value);
  }
  return value;
}

/**
 * 追加式事件存储：记录一经接收即深冻结，标识不得重复，
 * 更正只能通过携带 supersedes 的后继事件完成。
 */
export class EventStore {
  #events = [];
  #byId = new Map();

  append(event) {
    const errors = validateEvent(event);
    if (errors.length > 0) throw new Error(`事件不符合约定：${errors.join("；")}`);
    if (this.#byId.has(event.event_id)) throw new Error(`事件标识重复：${event.event_id}`);
    const record = deepFreeze(structuredClone(event));
    this.#events.push(record);
    this.#byId.set(record.event_id, record);
    return record;
  }

  /** 组装并追加一条事件：自动分配事件标识与聚合内版本号。 */
  emit(fields) {
    return this.append({
      event_id: `EVT-${String(this.#events.length + 1).padStart(4, "0")}`,
      version: this.nextVersion(fields.aggregate_type, fields.aggregate_id),
      ...fields,
    });
  }

  get(eventId) {
    return this.#byId.get(eventId) ?? null;
  }

  all() {
    return [...this.#events];
  }

  byType(eventType) {
    return this.#events.filter((event) => event.event_type === eventType);
  }

  byAggregate(aggregateType, aggregateId) {
    return this.#events.filter(
      (event) => event.aggregate_type === aggregateType && (aggregateId === undefined || event.aggregate_id === aggregateId),
    );
  }

  nextVersion(aggregateType, aggregateId) {
    return this.byAggregate(aggregateType, aggregateId).length + 1;
  }
}
