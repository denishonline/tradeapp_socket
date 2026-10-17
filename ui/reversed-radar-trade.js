export const RADAR_TARGET_PCT = 0.4
export const RADAR_STOP_PCT = 0.4

export function reversedTrade(entry, originalDirection) {
  const direction = String(originalDirection).toUpperCase() === "SELL" ? "BUY" : "SELL"
  const sign = direction === "BUY" ? 1 : -1
  return {
    direction,
    stop: entry * (1 - sign * RADAR_STOP_PCT / 100),
    target: entry * (1 + sign * RADAR_TARGET_PCT / 100),
    exitPlan: {
      type: "fixed_target_stop",
      targetFraction: RADAR_TARGET_PCT / 100,
      stopFraction: RADAR_STOP_PCT / 100,
    },
  }
}

export function resolveReversedPrice(signal, price) {
  if (signal.direction === "SELL") {
    if (price >= signal.stop) return "Stopped"
    if (price <= signal.target) return "Target reached"
  } else {
    if (price <= signal.stop) return "Stopped"
    if (price >= signal.target) return "Target reached"
  }
  return null
}

export function resolveReversedCandle(signal, candle) {
  // If both boundaries occur inside one candle, use the stop first so the
  // one-minute result cannot claim an unknowable optimistic sequence.
  if (signal.direction === "SELL") {
    if (candle.high >= signal.stop) return "Stopped"
    if (candle.low <= signal.target) return "Target reached"
  } else {
    if (candle.low <= signal.stop) return "Stopped"
    if (candle.high >= signal.target) return "Target reached"
  }
  return null
}
