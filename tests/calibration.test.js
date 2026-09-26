import assert from "node:assert/strict";
import test from "node:test";

import { EventStore } from "../src/store.js";
import { registerLot } from "../src/lineage.js";
import { frozenRunIds, invalidateCalibration, recordCalibration } from "../src/calibration.js";
import { startRun } from "../src/measurements.js";

const operator = { id: "u-op", role: "instrument_operator" };
const at = (time) => `2026-09-21T${time}+08:00`;

function seeded() {
  const store = new EventStore();
  registerLot(store, { lot_id: "LOT-1", material: "鹰嘴豆", quantity: 1000, unit: "g", actor: operator, now: at("08:00:00") });
  recordCalibration(store, {
    instrument_id: "INS-A", certificate_id: "CERT-A-01",
    valid_from: at("08:00:00"), valid_until: at("18:00:00"), actor: operator, now: at("08:05:00"),
  });
  recordCalibration(store, {
    instrument_id: "INS-B", certificate_id: "CERT-B-01",
    valid_from: at("08:00:00"), valid_until: at("18:00:00"), actor: operator, now: at("08:06:00"),
  });
  return store;
}

test("校准失效只冻结受影响仪器与受影响时间窗内的运行", () => {
  const store = seeded();
  startRun(store, { run_id: "R-1", study_id: "ST-1", sample_id: "LOT-1", instrument_id: "INS-A", actor: operator, now: at("10:00:00") });
  startRun(store, { run_id: "R-2", study_id: "ST-1", sample_id: "LOT-1", instrument_id: "INS-B", actor: operator, now: at("10:00:00") });
  startRun(store, { run_id: "R-3", study_id: "ST-1", sample_id: "LOT-1", instrument_id: "INS-A", actor: operator, now: at("12:00:00") });

  invalidateCalibration(store, {
    instrument_id: "INS-A", affected_from: at("09:30:00"), affected_until: at("10:30:00"),
    reason: "标准砝码复核超差", actor: operator, now: at("13:00:00"),
  });

  const frozen = frozenRunIds(store);
  assert.deepEqual([...frozen], ["R-1"]);
  assert.ok(!frozen.has("R-2"));
  assert.ok(!frozen.has("R-3"));
});

test("无有效校准或落在失效窗内不得开始运行", () => {
  const store = seeded();
  assert.throws(
    () => startRun(store, { run_id: "R-9", study_id: "ST-1", sample_id: "LOT-1", instrument_id: "INS-C", actor: operator, now: at("10:00:00") }),
    /有效校准/,
  );
  assert.throws(
    () => startRun(store, { run_id: "R-10", study_id: "ST-1", sample_id: "LOT-1", instrument_id: "INS-A", actor: operator, now: at("19:00:00") }),
    /有效校准/,
  );
  invalidateCalibration(store, {
    instrument_id: "INS-A", affected_from: at("09:30:00"), affected_until: at("10:30:00"),
    reason: "标准砝码复核超差", actor: operator, now: at("09:35:00"),
  });
  assert.throws(
    () => startRun(store, { run_id: "R-11", study_id: "ST-1", sample_id: "LOT-1", instrument_id: "INS-A", actor: operator, now: at("10:15:00") }),
    /有效校准/,
  );
});

test("运行记录钉住开始时的校准证书", () => {
  const store = seeded();
  startRun(store, { run_id: "R-1", study_id: "ST-1", sample_id: "LOT-1", instrument_id: "INS-A", actor: operator, now: at("10:00:00") });
  const started = store.byAggregate("experiment_run", "R-1").find((event) => event.event_type === "RUN_STARTED");
  assert.equal(started.payload.calibration_certificate, "CERT-A-01");
});
