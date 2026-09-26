import assert from "node:assert/strict";
import test from "node:test";

import { validateEvent } from "../src/validator.js";

const base = {
  event_id: "EVT-1",
  event_type: "RUN_STARTED",
  aggregate_type: "experiment_run",
  aggregate_id: "R-1",
  occurred_at: "2026-09-20T10:00:00+08:00",
  version: 1,
  summary: "开始运行",
};

test("合法事件通过校验", () => {
  assert.deepEqual(validateEvent(base), []);
});

test("未知事件类型与聚合类型被拒绝", () => {
  assert.ok(validateEvent({ ...base, event_type: "HACK" }).some((e) => e.includes("未知事件类型")));
  assert.ok(validateEvent({ ...base, aggregate_type: "ghost" }).some((e) => e.includes("未知聚合类型")));
});

test("时间与版本约束", () => {
  assert.ok(validateEvent({ ...base, occurred_at: "不是时间" }).some((e) => e.includes("occurred_at")));
  assert.ok(validateEvent({ ...base, version: 0 }).some((e) => e.includes("version")));
  assert.ok(validateEvent({}).some((e) => e.includes("缺少字段")));
});
