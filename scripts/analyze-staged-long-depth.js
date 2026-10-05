import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const filename = process.argv[2] || path.join(os.tmpdir(), "tradeapp_staged_replay.json")
const result = JSON.parse(fs.readFileSync(filename, "utf8").replace(/^\uFEFF/, ""))
const signals = result.signals
const fields = {
  candleScore: (s) => s.candleScore,
  rsi14: (s) => s.indicators.rsi14,
  mfi14: (s) => s.indicators.mfi14,
  return5Pct: (s) => s.indicators.return5Pct,
  return10Pct: (s) => s.indicators.return10Pct,
  return20Pct: (s) => s.indicators.return20Pct,
  return30Pct: (s) => s.indicators.return30Pct,
  prior3VolumeMultiple10: (s) => s.indicators.prior3VolumeMultiple10,
  trendEfficiency20: (s) => s.indicators.trendEfficiency20,
  atr14Pct: (s) => s.indicators.atr14Pct,
  volumeMultiple20: (s) => s.indicators.volumeMultiple20,
  confirmVolumeMultiple20: (s) => s.confirmVolumeMultiple20,
  confirm3VolumeMultiple20: (s) => s.confirm3VolumeMultiple20,
  confirmCloseLocation: (s) => s.confirmCloseLocation,
  driftPct: (s) => s.driftPct,
  vwapGapPct: (s) => (s.price / s.indicators.vwap - 1) * 100,
  ema20GapPct: (s) => (s.price / s.indicators.ema20 - 1) * 100,
  depthImbalance: (s) => s.depthImbalance,
  top2Imbalance: (s) => s.top2Imbalance,
  orderImbalance: (s) => s.orderImbalance,
  bestLevelImbalance: (s) => s.bestLevelImbalance,
  spreadPct: (s) => s.spreadPct,
  depthFullSlope: (s) => s.depthFullEnd - s.depthFullStart,
  depthTop2Slope: (s) => s.depthTop2End - s.depthTop2Start,
  bidSupportedFraction: (s) => s.bidSupportedFraction,
  askAbsorptionFraction: (s) => s.askAbsorptionFraction,
  bookVolumeChangePct: (s) => s.bookVolumeChangePct,
  bidVolumeChangePct: (s) => s.bidVolumeChangePct,
  askVolumeChangePct: (s) => s.askVolumeChangePct,
  midReturnPct: (s) => s.midReturnPct,
  ofiNormalized: (s) => s.ofiNormalized,
  ofiPositiveMinutes: (s) => s.ofiPositiveMinutes,
  minDepthSamples: (s) => s.minDepthSamples,
}

function median(values) {
  if (!values.length) return null
  const ordered = values.slice().sort((a, b) => a - b)
  return Number(ordered[Math.floor(ordered.length / 2)].toFixed(3))
}

function summary(rows) {
  return { count: rows.length,
    target: rows.filter((row) => row.outcome === "Target reached").length,
    stopped: rows.filter((row) => row.outcome === "Stopped").length,
    unresolved: rows.filter((row) => row.outcome === "Unresolved").length }
}

console.log(`Replay ${result.date}: ${JSON.stringify(summary(signals))}`)
console.log("Target hits:")
console.table(signals.filter((signal) => signal.outcome === "Target reached").map((s) => ({
  symbol: s.symbol, signalAt: s.signalAt, pattern: s.pattern, candleScore: s.candleScore,
  rsi14: Number(s.indicators.rsi14.toFixed(1)), mfi14: Number(s.indicators.mfi14.toFixed(1)),
  volumeMultiple20: Number(s.indicators.volumeMultiple20.toFixed(1)),
  depthImbalance: s.depthImbalance, top2Imbalance: s.top2Imbalance,
})))
console.log("Feature medians by outcome:")
console.table(Object.entries(fields).map(([name, get]) => ({
  feature: name,
  target: median(signals.filter((s) => s.outcome === "Target reached").map(get).filter(Number.isFinite)),
  stopped: median(signals.filter((s) => s.outcome === "Stopped").map(get).filter(Number.isFinite)),
  unresolved: median(signals.filter((s) => s.outcome === "Unresolved").map(get).filter(Number.isFinite)),
})))

const gates = {
  score7: (s) => s.candleScore >= 7,
  score8: (s) => s.candleScore >= 8,
  rsi55to75: (s) => s.indicators.rsi14 >= 55 && s.indicators.rsi14 <= 75,
  mfi60: (s) => s.indicators.mfi14 >= 60,
  aboveVwap: (s) => s.indicators.checks.aboveVwap,
  emaBullish: (s) => s.indicators.checks.emaBullish,
  breakout: (s) => s.indicators.checks.breakout,
  volumeExpansion: (s) => s.indicators.checks.volumeExpansion,
  strongClose: (s) => s.indicators.checks.strongClose,
  spreadUnder01: (s) => s.spreadPct <= 0.1,
  orderPositive: (s) => s.orderImbalance > 0,
  improvingFull: (s) => s.depthFullEnd > s.depthFullStart,
  improvingTop2: (s) => s.depthTop2End > s.depthTop2Start,
  depthSamples3: (s) => s.minDepthSamples >= 3,
  askAbsorption: (s) => s.pattern === "Ask absorption",
  bidSupported: (s) => s.pattern === "Bid supported",
  recentLull: (s) => s.indicators.prior3VolumeMultiple10 <= 0.6,
  notExtended30: (s) => s.indicators.return30Pct <= 0.3,
  positiveTrendEfficiency: (s) => s.indicators.trendEfficiency20 >= 0.2,
  atrUnder04: (s) => s.indicators.atr14Pct <= 0.4,
  depthPersistent60: (s) => Math.max(s.bidSupportedFraction, s.askAbsorptionFraction) >= 0.6,
  depthPersistent75: (s) => Math.max(s.bidSupportedFraction, s.askAbsorptionFraction) >= 0.75,
  bidBuilds: (s) => s.bidVolumeChangePct >= 0,
  askFalls: (s) => s.askVolumeChangePct <= 0,
  midPositive: (s) => s.midReturnPct > 0,
  ofiPositive: (s) => s.ofiNormalized > 0,
  ofiPositive2Minutes: (s) => s.ofiPositiveMinutes >= 2,
  bestLevelPositive: (s) => s.bestLevelImbalance > 0,
  confirmVolumeExpansion: (s) => s.confirmVolumeMultiple20 >= 1.2,
  confirm3VolumeExpansion: (s) => s.confirm3VolumeMultiple20 >= 1.2,
  confirmStrongClose: (s) => s.confirmCloseLocation >= 0.7,
  confirmBreakout20: (s) => s.confirmAbovePrior20High,
  driftAbove015: (s) => s.driftPct >= 0.15,
}
console.log("Individual gates:")
console.table(Object.entries(gates).map(([name, predicate]) => ({ gate: name, ...summary(signals.filter(predicate)) })))
console.log("Selected combinations:")
const combos = [
  ["score7", "aboveVwap"],
  ["score7", "rsi55to75", "mfi60"],
  ["score7", "rsi55to75", "mfi60", "spreadUnder01"],
  ["score7", "volumeExpansion", "breakout"],
  ["score7", "aboveVwap", "improvingTop2"],
  ["score7", "mfi60", "depthSamples3", "spreadUnder01"],
  ["score8", "mfi60", "spreadUnder01", "improvingTop2"],
  ["recentLull", "notExtended30"],
  ["recentLull", "notExtended30", "depthPersistent60"],
  ["notExtended30", "depthPersistent60", "midPositive"],
  ["positiveTrendEfficiency", "depthPersistent60", "bidBuilds"],
  ["mfi60", "depthPersistent60", "midPositive"],
  ["ofiPositive", "bestLevelPositive"],
  ["ofiPositive2Minutes", "bidSupported", "positiveTrendEfficiency"],
  ["ofiPositive2Minutes", "bidSupported", "mfi60", "midPositive"],
  ["confirmVolumeExpansion", "confirmBreakout20", "depthPersistent60"],
  ["confirmStrongClose", "driftAbove015", "ofiPositive"],
  ["confirm3VolumeExpansion", "ofiPositive", "bestLevelPositive"],
]
console.table(combos.map((names) => ({ filters: names.join(" + "),
  ...summary(signals.filter((signal) => names.every((name) => gates[name](signal)))) })))
