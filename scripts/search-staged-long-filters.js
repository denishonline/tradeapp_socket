import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const filename = process.argv[2] || path.join(os.tmpdir(), "tradeapp_staged_replay.json")
const signals = JSON.parse(fs.readFileSync(filename, "utf8").replace(/^\uFEFF/, "")).signals
const gates = {
  candleScore6: (s) => s.candleScore >= 6,
  candleScore7: (s) => s.candleScore >= 7,
  return10Positive: (s) => s.indicators.return10Pct > 0,
  return10Over02: (s) => s.indicators.return10Pct >= 0.2,
  return20Over02: (s) => s.indicators.return20Pct >= 0.2,
  return30Under03: (s) => s.indicators.return30Pct <= 0.3,
  trendEfficiency20: (s) => s.indicators.trendEfficiency20 >= 0.2,
  rsi50to75: (s) => s.indicators.rsi14 >= 50 && s.indicators.rsi14 <= 75,
  mfi50: (s) => s.indicators.mfi14 >= 50,
  volumeCurrent: (s) => s.indicators.volumeMultiple20 >= 1,
  confirmCloseStrong: (s) => s.confirmCloseLocation >= 0.7,
  confirmVolume: (s) => s.confirmVolumeMultiple20 >= 1,
  confirmBreakout20: (s) => s.confirmAbovePrior20High,
  aboveVwap: (s) => s.indicators.checks.aboveVwap,
  emaBullish: (s) => s.indicators.checks.emaBullish,
  askAbsorption: (s) => s.pattern === "Ask absorption",
  bidSupported: (s) => s.pattern === "Bid supported",
  queuePositive: (s) => s.bestLevelImbalance > 0,
  orderPositive: (s) => s.orderImbalance > 0,
  ofiPositive: (s) => s.ofiNormalized > 0,
  ofiOver003: (s) => s.ofiNormalized >= 0.03,
  ofiPositive2Min: (s) => s.ofiPositiveMinutes >= 2,
  bidPersistent50: (s) => s.bidSupportedFraction >= 0.5,
  askPersistent50: (s) => s.askAbsorptionFraction >= 0.5,
  improvingFull: (s) => s.depthFullEnd > s.depthFullStart,
  midPositive: (s) => s.midReturnPct > 0,
  midUp01: (s) => s.midReturnPct >= 0.1,
}
const names = Object.keys(gates)
function summary(rows) {
  const target = rows.filter((s) => s.outcome === "Target reached").length
  const stopped = rows.filter((s) => s.outcome === "Stopped").length
  return { count: rows.length, target, stopped, unresolved: rows.length - target - stopped,
    precision: target / (target + stopped || 1) }
}
const score = (rows) => {
  const morning = summary(rows.filter((s) => s.signalAt < "12:30"))
  const afternoon = summary(rows.filter((s) => s.signalAt >= "12:30"))
  const all = summary(rows)
  return { all, morning, afternoon }
}
console.log("Baseline", score(signals))
const combinations = []
for (let a = 0; a < names.length; a++) {
  for (let b = a; b < names.length; b++) {
    for (let c = b; c < names.length; c++) {
      const chosen = [...new Set([names[a], names[b], names[c]])]
      if (chosen.length === 1) continue
      const rows = signals.filter((signal) => chosen.every((name) => gates[name](signal)))
      const result = score(rows)
      if (result.all.count < 12 || result.morning.target + result.morning.stopped < 4 ||
          result.afternoon.target + result.afternoon.stopped < 4) continue
      combinations.push({ filters: chosen.join(" + "), ...result })
    }
  }
}
combinations.sort((a, b) =>
  Math.min(b.morning.precision, b.afternoon.precision) - Math.min(a.morning.precision, a.afternoon.precision) ||
  b.all.precision - a.all.precision || b.all.target - a.all.target)
console.table(combinations.slice(0, 30).map((row) => ({
  filters: row.filters, count: row.all.count, target: row.all.target, stopped: row.all.stopped,
  unresolved: row.all.unresolved, morning: `${row.morning.target}/${row.morning.target + row.morning.stopped}`,
  afternoon: `${row.afternoon.target}/${row.afternoon.target + row.afternoon.stopped}`,
})))
for (const row of combinations.slice(0, 3)) {
  const chosen = row.filters.split(" + ")
  console.log(row.filters)
  console.table(signals.filter((signal) => chosen.every((name) => gates[name](signal)))
    .map(({ symbol, signalAt, outcome, pattern }) => ({ symbol, signalAt, outcome, pattern })))
}
