import { createHash } from "node:crypto";

/** 链起点使用的固定前序哈希。 */
export const GENESIS_HASH = "GENESIS";

/**
 * 将任意 JSON 值序列化为键序稳定的规范字符串，
 * 保证同一内容永远得到同一摘要。
 */
export function canonicalize(value) {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalize(item)).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

/** 事件哈希覆盖事件正文与前序哈希，形成防篡改链。 */
export function hashEvent(eventBody, prevHash) {
  return sha256(`${canonicalize(eventBody)}|${prevHash}`);
}

/**
 * 追加式事件存储：只增不改，事件写入后即冻结，
 * 任何对历史事件的改写都会破坏哈希链并被 verify() 发现。
 */
export class EventStore {
  #events = [];

  /** 追加一条事件，返回冻结后的存储形态（含 prev_hash 与 hash）。
   *  入参若已带 hash/prev_hash（如从其它存储重放），先剥离再入链，
   *  因此同一事件序列重放得到的链完全一致（幂等）。 */
  append(event) {
    const { hash: _oldHash, prev_hash: _oldPrev, ...body } = event;
    const prevHash = this.#events.length === 0 ? GENESIS_HASH : this.#events[this.#events.length - 1].hash;
    const stored = Object.freeze({ ...body, prev_hash: prevHash, hash: hashEvent(body, prevHash) });
    this.#events.push(stored);
    return stored;
  }

  /** 返回全部事件的浅拷贝数组（事件本身已冻结）。 */
  all() {
    return [...this.#events];
  }

  get size() {
    return this.#events.length;
  }

  /** 逐条重放校验哈希链，任何篡改或断链都返回 false。 */
  verify() {
    let prevHash = GENESIS_HASH;
    for (const stored of this.#events) {
      const { hash, prev_hash, ...body } = stored;
      if (prev_hash !== prevHash) return false;
      if (hashEvent(body, prevHash) !== hash) return false;
      prevHash = hash;
    }
    return true;
  }
}
