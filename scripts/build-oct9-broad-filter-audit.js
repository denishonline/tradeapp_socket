import fs from "node:fs"
import path from "node:path"

const ROOT = process.cwd()
const DATE = "2026-10-09"
const MINUTE = 60_000
const DEPTH_ROOT = path.join(ROOT, "db", "cash-depth")
const CANDLE_ROOT = path.join(ROOT, "db", "candles")
const SIGNAL_ROOT = path.join(ROOT, "db", "strategy-signals")
const indiaDate = (at) => new Date(at + 330 * MINUTE).toISOString().slice(0, 10)
const sideReturn = (entry, price, side) => (side === "SELL" ? -1 : 1) * (price / entry - 1) * 100

function jsonLines(filename) {
  if (!fs.existsSync(filename)) return []
  return fs.readFileSync(filename, "utf8").split(/\r?\n/).flatMap((line) => {
    if (!line.trim()) return []
    try { return [JSON.parse(line)] } catch { return [] }
  })
}

const pathCache = new Map()
function pathAfter(signal, minutes) {
  const key = `${signal.symbol}:${signal.time}:${signal.direction}`
  if (!pathCache.has(key)) {
    const at = Date.parse(signal.time), entry = Number(signal.price), deadline = at + 30 * MINUTE
    const depthFile = path.join(DEPTH_ROOT, DATE, signal.symbol, `${signal.symbol}.jsonl`)
    const depth = jsonLines(depthFile).flatMap((row) => {
      const rowAt = Date.parse(row.receivedAt), price = Number(row.marketContext?.price)
      return rowAt > at && rowAt <= deadline && Number.isFinite(price) && price > 0
        ? [{ at: rowAt, value: sideReturn(entry, price, signal.direction) }] : []
    })
    const candleFile = path.join(CANDLE_ROOT, `${signal.symbol}.jsonl`)
    const candles = jsonLines(candleFile).flatMap((row) => {
      const rowAt = (Number(row.time) + 60) * 1000, price = Number(row.close)
      return rowAt > at && rowAt <= deadline && indiaDate(rowAt) === DATE && Number.isFinite(price) && price > 0
        ? [{ at: rowAt, value: sideReturn(entry, price, signal.direction) }] : []
    })
    pathCache.set(key, [...depth, ...candles].sort((left, right) => left.at - right.at))
  }
  return pathCache.get(key).filter((row) => row.at <= Date.parse(signal.time) + minutes * MINUTE)
}

function confirmation(signal, { progress, cancel, wait }) {
  for (const row of pathAfter(signal, wait)) {
    if (row.value <= -cancel) return { pass: false, reason: `cancelled at ${row.value.toFixed(3)}%` }
    if (row.value >= progress) return { pass: true, reason: `confirmed at ${row.value.toFixed(3)}%` }
  }
  return { pass: false, reason: `no ${progress.toFixed(2)}% confirmation within ${wait}m` }
}

function entryDecision(signal) {
  const metrics = signal.metrics || {}
  if (signal.strategy === "Bid Support Breakout") {
    const depthLed = Number(metrics.liveFlow) >= 0.30 && Number(metrics.liveVolumePace) >= 4
    const fastVolume = Number(metrics.liveFlow) >= 0.05 && Number(metrics.liveVolumePace) >= 5
    const keep = Number(metrics.trendPct) <= 1 && (depthLed || fastVolume ||
      Number(metrics.return3Pct) >= 0.15 || Number(metrics.volume5Ratio) >= 0.50)
    return { pass: keep, reason: keep ? "broad breakout quality passed"
      : "no candle, compression, or fast-volume confirmation" }
  }
  if (signal.strategy === "Multi-Frame Depth Recovery") {
    if (metrics.filterBranch === "gap_recovery" && !(Number(metrics.return3) > 0)) {
      return { pass: false, reason: "gap recovery lacked positive 3-minute return" }
    }
    if (metrics.filterBranch === "controlled_recovery" &&
        !(Number(metrics.askDrift3) <= 0.12 && Number(metrics.pullback10) <= 0.15)) {
      return { pass: false, reason: "controlled recovery had excessive ask drift or pullback" }
    }
    return { pass: true, reason: "recovery entry gate passed" }
  }
  if (signal.strategy === "Multi-Frame Depth Continuation") {
    if (metrics.filterBranch === "weak_recovery_falling_bid" &&
        !(Number(metrics.recovery15) <= 0.65 &&
          (Number(metrics.vwapGap10) <= 0.20 || Number(metrics.greenVolume15) >= 0.45))) {
      return { pass: false, reason: "recovery/VWAP/green-volume quality gate failed" }
    }
    return { pass: true, reason: "continuation entry gate passed" }
  }
  return { pass: true, reason: "no October 9 gate required" }
}

const configs = [
  ["bid-support-breakout", null],
  ["multi-frame-depth-buy", { progress: 0.08, cancel: 0.20, wait: 20 }],
  ["multi-frame-depth-sell", { progress: 0.20, cancel: 0.40, wait: 10 }],
]
const rows = []
for (const [directory, rule] of configs) {
  const filename = path.join(SIGNAL_ROOT, directory, `${DATE}.json`)
  for (const signal of JSON.parse(fs.readFileSync(filename, "utf8"))) {
    if (signal.status !== "Stopped") continue
    const entry = entryDecision(signal)
    const followThrough = entry.pass && rule ? confirmation(signal, rule) : null
    const keep = entry.pass && (!rule || followThrough.pass)
    rows.push({ date: DATE, strategy: signal.strategy, symbol: signal.symbol,
      originalStatus: signal.status, decision: keep ? "KEEP" : "FILTER",
      stage: !entry.pass ? "entry-quality" : followThrough && !followThrough.pass ? "confirmation" : "accepted",
      reason: !entry.pass ? entry.reason : followThrough?.reason || entry.reason })
  }
}

const fields = ["date", "strategy", "symbol", "originalStatus", "decision", "stage", "reason"]
const quote = (value) => `"${String(value).replaceAll('"', '""')}"`
const output = path.join(ROOT, "csv", "2026-10-09-strategy-radar-broad-filter-audit.csv")
fs.writeFileSync(output, [fields.join(","), ...rows.map((row) => fields.map((field) => quote(row[field])).join(","))].join("\n") + "\n")
console.log(JSON.stringify({ output, originalStops: rows.length,
  filteredStops: rows.filter((row) => row.decision === "FILTER").length,
  keptStops: rows.filter((row) => row.decision === "KEEP").map((row) => row.symbol), rows }, null, 2))
