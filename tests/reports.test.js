import assert from "node:assert/strict";
import test from "node:test";

import { EventStore } from "../src/store.js";
import { applyPretreatment, registerLot, splitSample } from "../src/lineage.js";
import { BlindingVault, issueBlindCode, unblind } from "../src/blinding.js";
import { recordCalibration } from "../src/calibration.js";
import { completeRun, ingestMeasurement, startRun } from "../src/measurements.js";
import {
  addAddendum,
  createReport,
  exportBlindPackage,
  lateMeasurements,
  reportEvidence,
  reportState,
  signReport,
  traceReport,
} from "../src/reports.js";

const custodian = { id: "u-cust", role: "blinding_custodian" };
const analyst = { id: "u-ana", role: "analyst" };
const at = (time) => `2026-09-21T${time}+08:00`;

function seeded() {
  const store = new EventStore();
  const vault = new BlindingVault();
  registerLot(store, { lot_id: "LOT-1", material: "鹰嘴豆", quantity: 1000, unit: "g", actor: analyst, now: at("08:00:00") });
  applyPretreatment(store, {
    source_id: "LOT-1", target_id: "PRE-1", drawn_quantity: 400, output_quantity: 380, unit: "g",
    process_params: { 浸泡时长h: 12 }, actor: analyst, now: at("08:30:00"),
  });
  splitSample(store, {
    source_id: "PRE-1",
    children: [
      { sample_id: "S-1", quantity: 150 },
      { sample_id: "S-2", quantity: 150 },
    ],
    actor: analyst, now: at("08:40:00"),
  });
  recordCalibration(store, {
    instrument_id: "INS-A", certificate_id: "CERT-A-01",
    valid_from: at("08:00:00"), valid_until: at("20:00:00"), actor: analyst, now: at("08:05:00"),
  });
  issueBlindCode(store, vault, { study_id: "ST-1", sample_id: "S-1", formula_id: "FORMULA-A", actor: custodian, now: at("08:50:00") });
  issueBlindCode(store, vault, { study_id: "ST-1", sample_id: "S-2", formula_id: "FORMULA-B", actor: custodian, now: at("08:51:00") });
  startRun(store, {
    run_id: "R-1", study_id: "ST-1", sample_id: "S-1", instrument_id: "INS-A",
    process_params: { 压缩速率: "1mm/s" }, actor: analyst, now: at("10:00:00"),
  });
  startRun(store, {
    run_id: "R-2", study_id: "ST-1", sample_id: "S-2", instrument_id: "INS-A",
    process_params: { 压缩速率: "1mm/s" }, actor: analyst, now: at("10:30:00"),
  });
  ingestMeasurement(store, {
    run_id: "R-1", device_serial: "DEV-1", curve_digest: "CURVE-1", content_hash: "H1",
    curve_ref: "s3://curves/1", actor: analyst, now: at("10:05:00"),
  });
  ingestMeasurement(store, {
    run_id: "R-2", device_serial: "DEV-1", curve_digest: "CURVE-2", content_hash: "H2",
    curve_ref: "s3://curves/2", actor: analyst, now: at("10:35:00"),
  });
  completeRun(store, { run_id: "R-1", actor: analyst, now: at("10:20:00") });
  completeRun(store, { run_id: "R-2", actor: analyst, now: at("10:50:00") });
  return { store, vault };
}

test("解盲前不得签署结论；签署后试验集合固定", () => {
  const { store, vault } = seeded();
  createReport(store, { report_id: "RP-1", study_id: "ST-1", run_ids: ["R-2", "R-1"], actor: analyst, now: at("11:00:00") });
  assert.throws(() => signReport(store, { report_id: "RP-1", conclusion: "两配方硬度无显著差异", actor: analyst, now: at("11:01:00") }), /解盲前/);

  unblind(store, vault, { study_id: "ST-1", actor: custodian, now: at("11:05:00") });
  signReport(store, { report_id: "RP-1", conclusion: "两配方硬度无显著差异", actor: analyst, now: at("11:10:00") });
  const state = reportState(store, "RP-1");
  assert.deepEqual(state.run_ids, ["R-1", "R-2"]);
  assert.throws(() => signReport(store, { report_id: "RP-1", conclusion: "改写结论", actor: analyst, now: at("11:11:00") }), /已签署/);
});

test("签署后迟到的补录不进入报告，只能走附录", () => {
  const { store, vault } = seeded();
  unblind(store, vault, { study_id: "ST-1", actor: custodian, now: at("11:05:00") });
  createReport(store, { report_id: "RP-1", study_id: "ST-1", run_ids: ["R-1", "R-2"], actor: analyst, now: at("11:06:00") });
  signReport(store, { report_id: "RP-1", conclusion: "两配方硬度无显著差异", actor: analyst, now: at("11:10:00") });

  const late = ingestMeasurement(store, {
    run_id: "R-1", device_serial: "DEV-1", curve_digest: "CURVE-LATE", content_hash: "H-LATE",
    curve_ref: "s3://curves/late", actor: analyst, now: at("11:30:00"),
  });
  assert.deepEqual(lateMeasurements(store, "RP-1"), [late.measurement_id]);
  const evidence = reportEvidence(store, "RP-1");
  assert.equal(evidence.measurements.length, 2);
  assert.ok(!evidence.measurements.some((m) => m.measurement_id === late.measurement_id));

  addAddendum(store, { report_id: "RP-1", measurement_ids: [late.measurement_id], reason: "设备补传迟到曲线", actor: analyst, now: at("11:40:00") });
  const addenda = store.byAggregate("report", "RP-1").filter((event) => event.event_type === "REPORT_ADDENDUM");
  assert.equal(addenda.length, 1);
  // 原签署集合摘要不变
  assert.equal(reportState(store, "RP-1").set_digest, evidence.set_digest);
});

test("从报告追到原料批次与仪器校准证据", () => {
  const { store, vault } = seeded();
  unblind(store, vault, { study_id: "ST-1", actor: custodian, now: at("11:05:00") });
  createReport(store, { report_id: "RP-1", study_id: "ST-1", run_ids: ["R-1", "R-2"], actor: analyst, now: at("11:06:00") });
  signReport(store, { report_id: "RP-1", conclusion: "两配方硬度无显著差异", actor: analyst, now: at("11:10:00") });

  const trace = traceReport(store, "RP-1");
  assert.deepEqual(trace.lots.map((lot) => lot.sample_id), ["LOT-1"]);
  assert.ok(trace.samples.some((node) => node.sample_id === "PRE-1"));
  assert.deepEqual(trace.instruments, ["INS-A"]);
  assert.ok(trace.calibration_evidence.some((event) => event.payload.certificate_id === "CERT-A-01"));
  assert.equal(trace.measurements.length, 2);
});

test("盲样数据包不泄露配方且可复现，解盲后附映射", () => {
  const { store, vault } = seeded();
  const sealedPkg = exportBlindPackage(store, vault, { study_id: "ST-1" });
  assert.equal(sealedPkg.blind, true);
  assert.ok(!JSON.stringify(sealedPkg).includes("FORMULA-"));
  assert.deepEqual(
    sealedPkg.entries.map((entry) => entry.blind_code),
    ["BLIND-001", "BLIND-002"],
  );
  // 可复现：同一事件流再次导出，摘要一致
  assert.equal(exportBlindPackage(store, vault, { study_id: "ST-1" }).package_digest, sealedPkg.package_digest);

  unblind(store, vault, { study_id: "ST-1", actor: custodian, now: at("11:05:00") });
  const openedPkg = exportBlindPackage(store, vault, { study_id: "ST-1" });
  assert.equal(openedPkg.blind, false);
  assert.equal(openedPkg.entries[0].formula_id, "FORMULA-A");
});
