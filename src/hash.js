import { createHash } from "node:crypto";

/** 键序稳定的序列化，用于对任意记录生成可复现的摘要。 */
export function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

/** 对结构化记录生成内容摘要。 */
export function digestOf(value) {
  return sha256(stableStringify(value));
}
