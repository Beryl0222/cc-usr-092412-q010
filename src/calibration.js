/** 仪器校准登记与失效；失效只冻结受影响时间窗内、受影响仪器上的运行。 */

function toMs(instant) {
  return Date.parse(instant);
}

function within(instant, from, until) {
  const at = toMs(instant);
  return at >= toMs(from) && (until == null || at <= toMs(until));
}

export function recordCalibration(store, { instrument_id, certificate_id, valid_from, valid_until, actor, now }) {
  if (!(toMs(valid_from) < toMs(valid_until))) throw new Error("校准有效期起止颠倒");
  return store.emit({
    event_type: "CALIBRATION_RECORDED", aggregate_type: "instrument", aggregate_id: instrument_id,
    occurred_at: now ?? new Date().toISOString(),
    summary: `登记仪器 ${instrument_id} 校准证书 ${certificate_id}（${valid_from} 至 ${valid_until}）`,
    actor,
    payload: { instrument_id, certificate_id, valid_from, valid_until },
  });
}

export function invalidateCalibration(store, { instrument_id, affected_from, affected_until = null, reason, actor, now }) {
  if (!reason || reason.trim() === "") throw new Error("校准失效必须填写理由");
  return store.emit({
    event_type: "CALIBRATION_INVALIDATED", aggregate_type: "instrument", aggregate_id: instrument_id,
    occurred_at: now ?? new Date().toISOString(),
    summary: `仪器 ${instrument_id} 校准失效（影响 ${affected_from} 起${affected_until ? ` 至 ${affected_until}` : ""}）：${reason}`,
    actor,
    payload: { instrument_id, affected_from, affected_until, reason },
  });
}

export function invalidationsFor(store, instrumentId) {
  return store.byAggregate("instrument", instrumentId).filter((event) => event.event_type === "CALIBRATION_INVALIDATED");
}

/** 覆盖指定时刻且未被失效波及的校准记录；没有则认为该校准无效。 */
export function coveringCalibration(store, instrumentId, at) {
  const invalidated = invalidationsFor(store, instrumentId).some((event) =>
    within(at, event.payload.affected_from, event.payload.affected_until),
  );
  if (invalidated) return null;
  return (
    store.byAggregate("instrument", instrumentId)
      .filter((event) => event.event_type === "CALIBRATION_RECORDED")
      .find((event) => within(at, event.payload.valid_from, event.payload.valid_until)) ?? null
  );
}

export function isCalibrationValid(store, instrumentId, at) {
  return coveringCalibration(store, instrumentId, at) !== null;
}

/** 被校准失效冻结的运行：仪器匹配且运行开始时间落在影响窗内。 */
export function frozenRunIds(store) {
  const invalidations = store.byType("CALIBRATION_INVALIDATED");
  const frozen = new Set();
  for (const run of store.byType("RUN_STARTED")) {
    for (const event of invalidations) {
      if (
        run.payload?.instrument_id === event.payload.instrument_id &&
        within(run.occurred_at, event.payload.affected_from, event.payload.affected_until)
      ) {
        frozen.add(run.aggregate_id);
      }
    }
  }
  return frozen;
}
