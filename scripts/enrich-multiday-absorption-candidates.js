import fs from "node:fs"
import path from "node:path"

const ROOT = process.cwd()
const DATES = ["2026-10-05", "2026-10-06", "2026-10-07", "2026-10-08", "2026-10-09", "2026-10-12", "2026-10-13"]
const MINUTE = 60_000, OFFSET = 330 * MINUTE
const stocks = [...new Set(JSON.parse(fs.readFileSync(path.join(ROOT, "db", "stocks"), "utf8")))]
const pct = (value, base) => base > 0 ? (value / base - 1) * 100 : NaN
const round = (value, digits = 3) => Number.isFinite(value) ? Number(value.toFixed(digits)) : null
const median = (values) => {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b)
  if (!sorted.length) return NaN
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}
const dateKey = (at) => new Date(at + OFFSET).toISOString().slice(0, 10)
const timeKey = (at) => new Date(at + OFFSET).toISOString().slice(11, 16)
const parseCsv = (filename) => {
  const [header, ...lines] = fs.readFileSync(filename, "utf8").trim().split(/\r?\n/)
  const fields = header.split(",")
  return lines.map((line) => Object.fromEntries(line.split(",").map((value, index) => [fields[index], value])))
}

const buckets = new Map()
for (const symbol of stocks) {
  const sessions = new Map()
  for (const line of fs.readFileSync(path.join(ROOT, "db", "candles", `${symbol}.jsonl`), "utf8").split(/\r?\n/)) {
    if (!line.trim()) continue
    try {
      const value = JSON.parse(line), at = Number(value.time) * 1000, date = dateKey(at)
      if (!DATES.includes(date)) continue
      if (!sessions.has(date)) sessions.set(date, [])
      sessions.get(date).push({ at, open: Number(value.open), close: Number(value.close) })
    } catch {}
  }
  for (const [date, rows] of sessions) {
    rows.sort((a, b) => a.at - b.at)
    for (let index = 0; index < rows.length; index++) {
      const row = rows[index], history = rows.slice(0, index + 1)
      const ret = (length) => history.length >= length ? pct(row.close, history.at(-length).open) : NaN
      const key = `${date}|${timeKey(row.at)}`
      if (!buckets.has(key)) buckets.set(key, [])
      buckets.get(key).push({ day: pct(row.close, rows[0].open), ret3: ret(3), ret10: ret(10), ret30: ret(30) })
    }
  }
}

const breadth = new Map([...buckets].map(([key, values]) => [key, {
  breadthStocks: values.length,
  breadthPositivePct: 100 * values.filter((row) => row.day > 0).length / values.length,
  breadthAbove05Pct: 100 * values.filter((row) => row.day >= 0.5).length / values.length,
  breadthMedianDayPct: median(values.map((row) => row.day)),
  breadthReturn3PositivePct: 100 * values.filter((row) => row.ret3 > 0).length / values.filter((row) => Number.isFinite(row.ret3)).length,
  breadthReturn10PositivePct: 100 * values.filter((row) => row.ret10 > 0).length / values.filter((row) => Number.isFinite(row.ret10)).length,
  breadthMedianReturn3Pct: median(values.map((row) => row.ret3)),
  breadthMedianReturn10Pct: median(values.map((row) => row.ret10)),
  breadthMedianReturn30Pct: median(values.map((row) => row.ret30))
}]))

const candidates = DATES.flatMap((date) => parseCsv(path.join(ROOT, "csv", `${date}-absorption-breakout-broad-candidates.csv`)))
  .map((row) => {
    const setupBreadth = breadth.get(`${row.date}|${row.setupTime}`) ?? {}
    const signalBreadth = breadth.get(`${row.date}|${row.signalTime}`) ?? {}
    return { ...row,
      ...Object.fromEntries(Object.entries(setupBreadth).map(([key, value]) => [key, round(value)])),
      signalBreadthPositivePct: round(signalBreadth.breadthPositivePct),
      signalBreadthMedianDayPct: round(signalBreadth.breadthMedianDayPct),
      signalBreadthReturn3PositivePct: round(signalBreadth.breadthReturn3PositivePct),
      signalBreadthMedianReturn3Pct: round(signalBreadth.breadthMedianReturn3Pct) }
  })

const fields = Object.keys(candidates[0] ?? {})
const output = path.join(ROOT, "csv", "2026-10-05-to-13-absorption-breakout-broad-enriched.csv")
fs.writeFileSync(output, [fields.join(","), ...candidates.map((row) => fields.map((field) => row[field] ?? "").join(","))].join("\n") + "\n")
console.log(JSON.stringify({ output, candidates: candidates.length, breadthBuckets: breadth.size }, null, 2))
