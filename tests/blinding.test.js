import assert from "node:assert/strict";
import test from "node:test";

import { EventStore } from "../src/store.js";
import { registerLot } from "../src/lineage.js";
import { BlindingVault, issueBlindCode, revealFormula, unblind, unblindConditions } from "../src/blinding.js";
import { recordCalibration } from "../src/calibration.js";
import {
  completeRun,
  confirmExclusion,
  ingestMeasurement,
  requestExclusion,
  resolveInvestigation,
  startRun,
} from "../src/measurements.js";

const custodian = { id: "u-cust", role: "blinding_custodian" };
const analyst = { id: "u-ana", role: "analyst" };
const second = { id: "u-sec", role: "analyst" };
const at = (time) => `2026-09-21T${time}+08:00`;

function seeded() {
  const store = new EventStore();
  const vault = new BlindingVault();
  registerLot(store, { lot_id: "LOT-1", material: "鹰嘴豆", quantity: 1000, unit: "g", actor: analyst, now: at("08:00:00") });
  recordCalibration(store, {
    instrument_id: "INS-A", certificate_id: "CERT-A-01",
    valid_from: at("08:00:00"), valid_until: at("20:00:00"), actor: analyst, now: at("08:05:00"),
  });
  issueBlindCode(store, vault, { study_id: "ST-1", sample_id: "LOT-1", formula_id: "FORMULA-A", actor: custodian, now: at("08:10:00") });
  return { store, vault };
}

test("盲码只能由盲态管理员签发，事件不含配方标识", () => {
  const { store, vault } = seeded();
  assert.throws(
    () => issueBlindCode(store, vault, { study_id: "ST-1", sample_id: "LOT-1", formula_id: "X", actor: analyst, now: at("08:11:00") }),
    /盲态管理员/,
  );
  const issued = store.byAggregate("study", "ST-1").find((event) => event.event_type === "BLIND_CODE_ISSUED");
  assert.ok(!("formula_id" in issued.payload));
  assert.ok(issued.payload.mapping_digest.length > 0);
});

test("解盲前配方映射对分析员隔离", () => {
  const { store, vault } = seeded();
  assert.throws(() => revealFormula(store, vault, { study_id: "ST-1", blind_code: "BLIND-001", actor: analyst }), /隔离/);
  assert.equal(revealFormula(store, vault, { study_id: "ST-1", blind_code: "BLIND-001", actor: custodian }).formula_id, "FORMULA-A");
});

test("解盲需运行终结、剔除确认、调查结案", () => {
  const { store, vault } = seeded();
  startRun(store, {
    run_id: "R-1", study_id: "ST-1", sample_id: "LOT-1", instrument_id: "INS-A",
    process_params: { 温度: 80 }, actor: analyst, now: at("09:00:00"),
  });
  assert.throws(() => unblind(store, vault, { study_id: "ST-1", actor: custodian, now: at("09:30:00") }), /未结束运行/);

  completeRun(store, { run_id: "R-1", actor: analyst, now: at("09:40:00") });
  const { measurement_id } = ingestMeasurement(store, {
    run_id: "R-1", device_serial: "DEV-1", curve_digest: "CURVE-1", content_hash: "H1",
    curve_ref: "s3://curves/1", actor: analyst, now: at("09:41:00"),
  });
  const exclusionId = requestExclusion(store, { measurement_id, reason: "曲线漂移", actor: analyst, now: at("09:42:00") });
  assert.throws(() => unblind(store, vault, { study_id: "ST-1", actor: custodian, now: at("09:43:00") }), /待确认的剔除/);
  confirmExclusion(store, { exclusion_id: exclusionId, actor: second, now: at("09:44:00") });

  const conflict = ingestMeasurement(store, {
    run_id: "R-1", device_serial: "DEV-1", curve_digest: "CURVE-1", content_hash: "H2",
    curve_ref: "s3://curves/1b", actor: analyst, now: at("09:45:00"),
  });
  assert.equal(conflict.status, "investigation");
  assert.throws(() => unblind(store, vault, { study_id: "ST-1", actor: custodian, now: at("09:46:00") }), /未结案调查/);
  resolveInvestigation(store, { investigation_id: conflict.investigation_id, resolution: "设备重发旧文件，以首次接收为准", actor: second, now: at("09:47:00") });

  assert.equal(unblindConditions(store, "ST-1").ok, true);
  assert.throws(() => unblind(store, vault, { study_id: "ST-1", actor: analyst, now: at("09:48:00") }), /盲态管理员/);
  unblind(store, vault, { study_id: "ST-1", actor: custodian, now: at("09:48:00") });
  assert.equal(revealFormula(store, vault, { study_id: "ST-1", blind_code: "BLIND-001", actor: analyst }).formula_id, "FORMULA-A");
});
