import fs from "node:fs"
import path from "node:path"

const ROOT = process.cwd()
const DATES = ["2026-10-05", "2026-10-06", "2026-10-07", "2026-10-08", "2026-10-09", "2026-10-12", "2026-10-13", "2026-10-14"]
const MINUTE = 60_000, OFFSET = 330 * MINUTE
const stocks = [...new Set(JSON.parse(fs.readFileSync(path.join(ROOT, "db", "stocks"), "utf8")))]
const pct = (value, base) => base > 0 ? (value / base - 1) * 100 : NaN
const round = (value, digits = 3) => Number.isFinite(value) ? Number(value.toFixed(digits)) : null
const dateKey = (at) => new Date(at + OFFSET).toISOString().slice(0, 10)
const timeKey = (at) => new Date(at + OFFSET).toISOString().slice(11, 16)
const median = (values) => {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b)
  if (!sorted.length) return NaN
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}
function parseCsv(filename) {
  const [header, ...lines] = fs.readFileSync(filename, "utf8").trim().split(/\r?\n/)
  const fields = header.split(",")
  return lines.filter(Boolean).map((line) => Object.fromEntries(line.split(",").map((value, index) => [fields[index], value])))
}
function readCandles(symbol) {
  return fs.readFileSync(path.join(ROOT, "db", "candles", `${symbol}.jsonl`), "utf8").split(/\r?\n/).flatMap((line) => {
    if (!line.trim()) return []
    try {
      const row = JSON.parse(line), at = Number(row.time) * 1000
      return DATES.includes(dateKey(at)) ? [{ at, open: Number(row.open), high: Number(row.high), low: Number(row.low), close: Number(row.close), volume: Number(row.volume) }] : []
    } catch { return [] }
  }).sort((a, b) => a.at - b.at)
}
const candlesBySymbolDate = new Map(), breadthBuckets = new Map()
for (const symbol of stocks) {
  const all = readCandles(symbol)
  for (const date of DATES) {
    const rows = all.filter((row) => dateKey(row.at) === date)
    candlesBySymbolDate.set(`${symbol}|${date}`, rows)
    for (let index = 0; index < rows.length; index++) {
      const row = rows[index], history = rows.slice(0, index + 1)
      const ret = (length) => history.length >= length ? pct(row.close, history.at(-length).open) : NaN
      const key = `${date}|${timeKey(row.at)}`
      if (!breadthBuckets.has(key)) breadthBuckets.set(key, [])
      breadthBuckets.get(key).push({ day: pct(row.close, rows[0].open), ret3: ret(3), ret10: ret(10) })
    }
  }
}
const breadth = new Map([...breadthBuckets].map(([key, values]) => {
  const ret3 = values.filter((row) => Number.isFinite(row.ret3))
  const ret10 = values.filter((row) => Number.isFinite(row.ret10))
  return [key, {
    breadthStocks: values.length,
    breadthPositivePct: 100 * values.filter((row) => row.day > 0).length / values.length,
    breadthAbove05Pct: 100 * values.filter((row) => row.day >= 0.5).length / values.length,
    breadthMedianDayPct: median(values.map((row) => row.day)),
    breadthReturn3PositivePct: ret3.length ? 100 * ret3.filter((row) => row.ret3 > 0).length / ret3.length : NaN,
    breadthReturn10PositivePct: ret10.length ? 100 * ret10.filter((row) => row.ret10 > 0).length / ret10.length : NaN,
  }]
}))
function quickOutcome(row, targetPct, stopPct, horizon) {
  const candles = candlesBySymbolDate.get(`${row.symbol}|${row.date}`) || []
  const originalIndex = candles.findIndex((candle) => timeKey(candle.at) === row.signalTime)
  const index = row.branch === "opening" ? originalIndex + 1 : originalIndex
  if (originalIndex < 0 || index >= candles.length) return { outcome: "Missing", returnPct: NaN, resolvedAt: "", mfePct: NaN, maePct: NaN, bars: 0, entry: NaN, signalTime: "" }
  const entry = row.branch === "opening" ? candles[index].close : Number(row.entry)
  const future = candles.slice(index + 1, index + 1 + horizon)
  let outcome = "Timed", returnPct = future.length ? pct(future.at(-1).close, entry) : NaN, resolvedAt = future.length ? timeKey(future.at(-1).at) : ""
  for (const candle of future) {
    if (candle.low <= entry * (1 - stopPct / 100)) { outcome = "Stop"; returnPct = -stopPct; resolvedAt = timeKey(candle.at); break }
    if (candle.high >= entry * (1 + targetPct / 100)) { outcome = "Target"; returnPct = targetPct; resolvedAt = timeKey(candle.at); break }
  }
  if (future.length < horizon && outcome === "Timed") outcome = "Pending"
  return { outcome, returnPct, resolvedAt,
    mfePct: future.length ? Math.max(...future.map((candle) => pct(candle.high, entry))) : NaN,
    maePct: future.length ? Math.min(...future.map((candle) => pct(candle.low, entry))) : NaN,
    bars: future.length, entry, signalTime: timeKey(candles[index].at) }
}
const candidates = DATES.flatMap((date) => parseCsv(path.join(ROOT, "csv", `${date}-absorption-breakout-broad-candidates.csv`)))
  .map((row) => {
    const setupBreadth = breadth.get(`${row.date}|${row.setupTime}`) || {}
    const q05 = quickOutcome(row, 0.5, 0.3, 10)
    const q06 = quickOutcome(row, 0.6, 0.3, 10)
    const q07 = quickOutcome(row, 0.7, 0.3, 10)
    const q06five = quickOutcome(row, 0.6, 0.3, 5)
    return { ...row, ...Object.fromEntries(Object.entries(setupBreadth).map(([key, value]) => [key, round(value)])),
      quickEntry: round(q06.entry), quickSignalTime: q06.signalTime,
      quick05Outcome: q05.outcome, quick05ReturnPct: round(q05.returnPct), quick05ResolvedAt: q05.resolvedAt,
      quick06Outcome: q06.outcome, quick06ReturnPct: round(q06.returnPct), quick06ResolvedAt: q06.resolvedAt,
      quick06MfePct: round(q06.mfePct), quick06MaePct: round(q06.maePct), quick06Bars: q06.bars,
      quick07Outcome: q07.outcome, quick07ReturnPct: round(q07.returnPct), quick07ResolvedAt: q07.resolvedAt,
      quick06FiveOutcome: q06five.outcome, quick06FiveResolvedAt: q06five.resolvedAt }
  })
const fields = Object.keys(candidates[0])
const value = (input) => input == null ? "" : String(input)
const output = path.join(ROOT, "csv", "2026-10-05-to-14-fast-scalp-candidates.csv")
fs.writeFileSync(output, [fields.join(","), ...candidates.map((row) => fields.map((field) => value(row[field])).join(","))].join("\n") + "\n")
const summarize = (rows, field) => Object.fromEntries(["Target", "Stop", "Timed", "Pending", "Missing"].map((name) => [name, rows.filter((row) => row[field] === name).length]))
console.log(JSON.stringify({ output, candidates: candidates.length,
  train: summarize(candidates.filter((row) => row.date <= "2026-10-09"), "quick06Outcome"),
  validation: summarize(candidates.filter((row) => row.date >= "2026-10-12" && row.date <= "2026-10-13"), "quick06Outcome"),
  holdout: summarize(candidates.filter((row) => row.date === "2026-10-14"), "quick06Outcome") }, null, 2))
