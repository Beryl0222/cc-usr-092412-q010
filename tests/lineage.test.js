import assert from "node:assert/strict";
import test from "node:test";

import { EventStore } from "../src/store.js";
import { applyPretreatment, lineageProjection, mergeSamples, registerLot, splitSample } from "../src/lineage.js";

const operator = { id: "u-op", role: "instrument_operator" };
const at = (time) => `2026-09-20T${time}+08:00`;

function seededStore() {
  const store = new EventStore();
  registerLot(store, { lot_id: "LOT-1", material: "鹰嘴豆", quantity: 1000, unit: "g", actor: operator, now: at("09:00:00") });
  applyPretreatment(store, {
    source_id: "LOT-1", target_id: "PRE-1",
    drawn_quantity: 400, output_quantity: 380, unit: "g",
    process_params: { 浸泡时长h: 12 }, actor: operator, now: at("09:30:00"),
  });
  return store;
}

test("分样与合样保持数量守恒", () => {
  const store = seededStore();
  splitSample(store, {
    source_id: "PRE-1",
    children: [
      { sample_id: "S-1", quantity: 150 },
      { sample_id: "S-2", quantity: 150 },
    ],
    actor: operator, now: at("10:00:00"),
  });
  mergeSamples(store, {
    source_amounts: [
      { sample_id: "S-1", quantity: 100 },
      { sample_id: "S-2", quantity: 100 },
    ],
    target_id: "MIX-1", actor: operator, now: at("10:30:00"),
  });

  const nodes = lineageProjection(store);
  assert.equal(nodes.get("LOT-1").remaining, 600);
  // 分样：子样总量 300 + 母样余量 80 = 预处理产出 380
  assert.equal(nodes.get("PRE-1").remaining, 80);
  assert.equal(nodes.get("S-1").remaining + nodes.get("S-2").remaining, 100);
  // 合样：目标量等于来源取用量之和
  assert.equal(nodes.get("MIX-1").quantity, 200);
  assert.equal(nodes.get("MIX-1").parents.length, 2);
});

test("超量分样与超量合样被拒绝", () => {
  const store = seededStore();
  assert.throws(
    () => splitSample(store, { source_id: "PRE-1", children: [{ sample_id: "S-9", quantity: 999 }], actor: operator, now: at("10:00:00") }),
    /数量守恒/,
  );
  splitSample(store, { source_id: "PRE-1", children: [{ sample_id: "S-1", quantity: 100 }], actor: operator, now: at("10:00:00") });
  assert.throws(
    () => mergeSamples(store, { source_amounts: [{ sample_id: "S-1", quantity: 500 }], target_id: "MIX-9", actor: operator, now: at("10:30:00") }),
    /数量守恒/,
  );
});

test("谱系关系不可原地改写，更正走后继记录", () => {
  const store = seededStore();
  const record = store.byAggregate("sample", "PRE-1")[0];
  assert.throws(() => {
    record.payload.output_quantity = 1;
  }, TypeError);
  assert.throws(() => {
    record.summary = "改写";
  }, TypeError);
  // 更正：以后继事件取代，原记录保持不动
  const correction = store.emit({
    event_type: "PRETREATMENT_APPLIED",
    aggregate_type: "sample",
    aggregate_id: "PRE-1",
    occurred_at: at("09:45:00"),
    summary: "更正预处理记录",
    actor: operator,
    supersedes: record.event_id,
    payload: { source_id: "LOT-1", drawn_quantity: 0, output_quantity: 380, unit: "g" },
  });
  assert.equal(correction.supersedes, record.event_id);
  assert.equal(store.byAggregate("sample", "PRE-1").length, 2);
});

test("重复登记批次被拒绝", () => {
  const store = seededStore();
  assert.throws(
    () => registerLot(store, { lot_id: "LOT-1", material: "鹰嘴豆", quantity: 1, unit: "g", actor: operator, now: at("11:00:00") }),
    /已存在/,
  );
});
