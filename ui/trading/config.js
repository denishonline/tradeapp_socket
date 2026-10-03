export const DEFAULT_TREND_CONFIG = Object.freeze({
  baselineMinutes: 100,
  maxChoppiness: 45,
  minBaselineEfficiency: 0.2,
  minVolumeRatio: 1.2,
  maxVolumeRatio: 4,
  minImbalance: 0.2,
  minImbalanceShift: 0.15,
  minBidUpMoves: 3,
  minAskUpMoves: 2,
  minUpTickRatio: 0.6,
  minNearBidStrength: 1.1,
  minAskReductionEvents: 1,
  minVolumeAcceleration: 1,
  minSmoothness: 0.6,
  minRise: 0.0003,
  maxChase: 0.004,
  maxSpread: 0.0015,
  recentSeconds: 20,
  confirmSeconds: 8,
  weakSeconds: 5,
  cooldownMs: 5 * 60_000,
  staleMs: 5000,
  signalMaxAgeMs: 10_000,
  maxGapMs: 60_000,
  entryStartMinute: 9 * 60 + 15,
  entryEndMinute: 14 * 60 + 45,
  squareOffMinute: 15 * 60 + 10,
  trailingFraction: 0.003,
  optionTrailingFraction: 0.05,
  optionMaxSpread: 0.02,
  chainCacheMs: 180_000,
  maxOptionMoneyness: 0.03,
  minOptionOi: 1,
  minOptionVolume: 1,
  orderTimeoutMs: 15_000,
  apiTimeoutMs: 8000,
  estimatedCostRate: 0.001,
  capitalPerTrade: 1000,
})

export function indiaTime(ms) {
  const date = new Date(ms + 330 * 60_000)
  return { day: date.toISOString().slice(0, 10), minute: date.getUTCHours() * 60 + date.getUTCMinutes(), weekday: date.getUTCDay() }
}

export function entrySession(ms, config) {
  const { minute, weekday } = indiaTime(ms)
  return weekday > 0 && weekday < 6 && minute >= config.entryStartMinute && minute < config.entryEndMinute
}
