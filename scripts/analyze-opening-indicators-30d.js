#!/usr/bin/env node
import fs from "node:fs"
import path from "node:path"

const ROOT = process.cwd()
const IST_OFFSET_MS = 330 * 60_000
const symbol = (process.argv[2] || "VOLTAS").toUpperCase()
const targetDate = process.argv[3] || "2026-10-28"
const dateOf = (seconds) => new Date(seconds * 1000 + IST_OFFSET_MS).toISOString().slice(0, 10)
const minuteOf = (seconds) => { const d = new Date(seconds * 1000 + IST_OFFSET_MS); return d.getUTCHours() * 60 + d.getUTCMinutes() }
const round = (value, digits = 3) => Number.isFinite(value) ? Number(value.toFixed(digits)) : null
const file = path.join(ROOT, "db", "candles", `${symbol}.jsonl`)
const all = fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line)).map((row) => ({ ...row, time: Number(row.time), open: Number(row.open), high: Number(row.high), low: Number(row.low), close: Number(row.close), volume: Number(row.volume), date: dateOf(Number(row.time)), minute: minuteOf(Number(row.time)) })).sort((a, b) => a.time - b.time)
const dates = [...new Set(all.map((row) => row.date))].filter((date) => date <= targetDate)
const sessions = dates.slice(-31)
const metrics = []
for (let index = 1; index < sessions.length; index += 1) {
  const date = sessions[index]
  const previousDate = sessions[index - 1]
  const day = all.filter((row) => row.date === date)
  const previous = all.filter((row) => row.date === previousDate)
  const opening = day.filter((row) => row.minute >= 555 && row.minute <= 565)
  const first5 = day.filter((row) => row.minute >= 555 && row.minute <= 559)
  const at925 = day.find((row) => row.minute === 565)
  const at1030 = day.find((row) => row.minute === 630)
  if (!opening.length || !first5.length || !at925 || !previous.length) continue
  const open = opening[0].open
  const prevClose = previous.at(-1).close
  const prevHigh = Math.max(...previous.map((row) => row.high))
  const movePct = (at925.close / open - 1) * 100
  const rangePct = (Math.max(...opening.map((row) => row.high)) / Math.min(...opening.map((row) => row.low)) - 1) * 100
  const volume5 = first5.reduce((sum, row) => sum + row.volume, 0)
  const volume925 = at925.volume
  const greenPct = opening.filter((row) => row.close > row.open).length / opening.length * 100
  const closeVsPrevHighPct = (at925.close / prevHigh - 1) * 100
  const accelTo1030Pct = at1030 ? (at1030.close / at925.close - 1) * 100 : null
  metrics.push({ date, movePct, rangePct, volume5, volume925, gapPct: (open / prevClose - 1) * 100, greenPct, closeVsPrevHighPct, accelTo1030Pct })
}
const target = metrics.at(-1)
const history = metrics.slice(0, -1)
const fields = [
  ["Opening move to 09:25", "movePct", "%"],
  ["09:15–09:25 range", "rangePct", "%"],
  ["09:15–09:19 volume", "volume5", ""],
  ["09:25 candle volume", "volume925", ""],
  ["Opening gap", "gapPct", "%"],
  ["Green-candle share", "greenPct", "%"],
  ["Close vs prior-day high", "closeVsPrevHighPct", "%"],
  ["09:25→10:30 return", "accelTo1030Pct", "%"],
]
const outputRows = fields.map(([indicator, key, unit]) => {
  const values = history.map((row) => row[key]).filter(Number.isFinite)
  const sorted = [...values].sort((a, b) => a - b)
  const rank = Number.isFinite(target[key]) ? 100 * values.filter((value) => value <= target[key]).length / values.length : null
  const max = sorted.at(-1)
  const maxRow = history.find((row) => row[key] === max)
  return { INDICATOR: indicator, [`VALUE_${targetDate}`]: round(target[key]), UNIT: unit, PRIOR_30D_AVG: round(values.reduce((sum, value) => sum + value, 0) / values.length), PRIOR_30D_MAX: round(max), MAX_DATE: maxRow?.date || "", PERCENTILE: round(rank, 1) }
})
const output = path.join(ROOT, "reports", `${symbol}-${targetDate}-opening-indicators-vs-30d.json`)
fs.writeFileSync(output, `${JSON.stringify({ symbol, targetDate, priorSessions: history.length, rows: outputRows }, null, 2)}\n`)
console.table(outputRows)
console.log(`Saved ${output}`)
