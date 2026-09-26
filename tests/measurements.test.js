import assert from "node:assert/strict";
import test from "node:test";

import { EventStore } from "../src/store.js";
import { registerLot } from "../src/lineage.js";
import { invalidateCalibration, recordCalibration } from "../src/calibration.js";
import {
  confirmExclusion,
  effectiveMeasurements,
  ingestMeasurement,
  requestExclusion,
  startRun,
} from "../src/measurements.js";

const analyst = { id: "u-ana", role: "analyst" };
const second = { id: "u-sec", role: "analyst" };
const at = (time) => `2026-09-21T${time}+08:00`;

function seeded() {
  const store = new EventStore();
  registerLot(store, { lot_id: "LOT-1", material: "鹰嘴豆", quantity: 1000, unit: "g", actor: analyst, now: at("08:00:00") });
  recordCalibration(store, {
    instrument_id: "INS-A", certificate_id: "CERT-A-01",
    valid_from: at("08:00:00"), valid_until: at("18:00:00"), actor: analyst, now: at("08:05:00"),
  });
  startRun(store, { run_id: "R-1", study_id: "ST-1", sample_id: "LOT-1", instrument_id: "INS-A", actor: analyst, now: at("10:00:00") });
  return store;
}

function ingest(store, overrides = {}) {
  return ingestMeasurement(store, {
    run_id: "R-1", device_serial: "DEV-1", curve_digest: "CURVE-1", content_hash: "H1",
    curve_ref: "s3://curves/1", actor: analyst, now: at("10:05:00"), ...overrides,
  });
}

test("重复测量必须填写理由并关联原测量", () => {
  const store = seeded();
  const { measurement_id } = ingest(store);
  assert.throws(
    () => ingest(store, { curve_digest: "CURVE-2", content_hash: "H2", repeat_of: measurement_id }),
    /理由/,
  );
  const repeated = ingest(store, { curve_digest: "CURVE-2", content_hash: "H2", repeat_of: measurement_id, reason: "首次曲线基线漂移" });
  assert.equal(repeated.status, "ingested");
  const event = store.byAggregate("measurement_series", repeated.measurement_id)[0];
  assert.equal(event.payload.repeat_of, measurement_id);
  assert.equal(event.payload.reason, "首次曲线基线漂移");
});

test("人工剔除需理由及第二人确认，确认前仍计入", () => {
  const store = seeded();
  const { measurement_id } = ingest(store);
  ingest(store, { curve_digest: "CURVE-2", content_hash: "H2" });

  assert.throws(() => requestExclusion(store, { measurement_id, reason: " ", actor: analyst, now: at("10:10:00") }), /理由/);
  const exclusionId = requestExclusion(store, { measurement_id, reason: "探头滑移", actor: analyst, now: at("10:10:00") });
  assert.throws(() => confirmExclusion(store, { exclusion_id: exclusionId, actor: analyst, now: at("10:11:00") }), /第二人/);

  let effective = effectiveMeasurements(store, "R-1");
  assert.equal(effective.length, 2);
  assert.equal(effective.find((m) => m.measurement_id === measurement_id).exclusion_pending, true);

  confirmExclusion(store, { exclusion_id: exclusionId, actor: second, now: at("10:12:00") });
  effective = effectiveMeasurements(store, "R-1");
  assert.equal(effective.length, 1);
  assert.equal(effective[0].curve_digest, "CURVE-2");
});

test("校准失效冻结运行后禁止接收曲线", () => {
  const store = seeded();
  invalidateCalibration(store, {
    instrument_id: "INS-A", affected_from: at("09:30:00"), affected_until: at("10:30:00"),
    reason: "标准砝码复核超差", actor: analyst, now: at("11:00:00"),
  });
  assert.throws(() => ingest(store, { now: at("10:06:00") }), /冻结/);
});
