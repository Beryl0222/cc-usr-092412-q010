import assert from "node:assert/strict";
import test from "node:test";

import { EventStore } from "../src/store.js";
import { registerLot } from "../src/lineage.js";
import { recordCalibration } from "../src/calibration.js";
import { effectiveMeasurements, ingestMeasurement, startRun } from "../src/measurements.js";
import { batchProgress, openBatch, recordCheckpoint, resumeBatch } from "../src/acquisition.js";

const operator = { id: "u-op", role: "instrument_operator" };
const at = (time) => `2026-09-21T${time}+08:00`;

function seeded() {
  const store = new EventStore();
  registerLot(store, { lot_id: "LOT-1", material: "鹰嘴豆", quantity: 1000, unit: "g", actor: operator, now: at("08:00:00") });
  recordCalibration(store, {
    instrument_id: "INS-A", certificate_id: "CERT-A-01",
    valid_from: at("08:00:00"), valid_until: at("18:00:00"), actor: operator, now: at("08:05:00"),
  });
  for (const runId of ["R-1", "R-2", "R-3"]) {
    startRun(store, { run_id: runId, study_id: "ST-1", sample_id: "LOT-1", instrument_id: "INS-A", actor: operator, now: at("09:00:00") });
  }
  return store;
}

test("单个运行失败后从检查点续采，已完成运行不重采", () => {
  const store = seeded();
  openBatch(store, { batch_id: "B-1", run_ids: ["R-1", "R-2", "R-3"], actor: operator, now: at("09:05:00") });
  recordCheckpoint(store, { batch_id: "B-1", run_id: "R-1", status: "completed", actor: operator, now: at("09:10:00") });
  recordCheckpoint(store, { batch_id: "B-1", run_id: "R-2", status: "failed", reason: "探头脱落", actor: operator, now: at("09:15:00") });

  const pending = resumeBatch(store, { batch_id: "B-1", actor: operator, now: at("09:20:00") });
  assert.deepEqual(pending, ["R-2", "R-3"]);
  assert.equal(store.byType("BATCH_RESUMED").length, 1);

  assert.throws(
    () => recordCheckpoint(store, { batch_id: "B-1", run_id: "R-1", status: "completed", actor: operator, now: at("09:21:00") }),
    /不重复记录/,
  );
  recordCheckpoint(store, { batch_id: "B-1", run_id: "R-2", status: "completed", actor: operator, now: at("09:25:00") });
  recordCheckpoint(store, { batch_id: "B-1", run_id: "R-3", status: "completed", actor: operator, now: at("09:30:00") });
  assert.deepEqual(batchProgress(store, "B-1").pending, []);
  assert.throws(() => resumeBatch(store, { batch_id: "B-1", actor: operator, now: at("09:31:00") }), /没有待续运行/);
});

test("同设备序号与曲线摘要的重传不重复计数，内容不同进入调查", () => {
  const store = seeded();
  const first = ingestMeasurement(store, {
    run_id: "R-1", device_serial: "DEV-1", curve_digest: "CURVE-1", content_hash: "H1",
    curve_ref: "s3://curves/1", actor: operator, now: at("09:10:00"),
  });
  assert.equal(first.status, "ingested");

  const retry = ingestMeasurement(store, {
    run_id: "R-1", device_serial: "DEV-1", curve_digest: "CURVE-1", content_hash: "H1",
    curve_ref: "s3://curves/1", actor: operator, now: at("09:11:00"),
  });
  assert.equal(retry.status, "duplicate");
  assert.equal(retry.measurement_id, first.measurement_id);
  assert.equal(store.byType("MEASUREMENT_INGESTED").length, 1);

  const conflict = ingestMeasurement(store, {
    run_id: "R-1", device_serial: "DEV-1", curve_digest: "CURVE-1", content_hash: "H-CHANGED",
    curve_ref: "s3://curves/1b", actor: operator, now: at("09:12:00"),
  });
  assert.equal(conflict.status, "investigation");
  assert.equal(store.byType("INVESTIGATION_OPENED").length, 1);
  // 被隔离的传输不计入有效测量
  assert.equal(effectiveMeasurements(store, "R-1").length, 1);
});
