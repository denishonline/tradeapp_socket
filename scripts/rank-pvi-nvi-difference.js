#!/usr/bin/env node
import fs from "node:fs"
import path from "node:path"

const ROOT = process.cwd()
const IST_OFFSET_MS = 330 * 60_000
const targetDate = process.argv[2] || "2026-10-28"
const cutoffMinute = Number(process.argv[3] || 570) // 09:30 IST; use completed candles before this minute
const dateOf = (seconds) => new Date(seconds * 1000 + IST_OFFSET_MS).toISOString().slice(0, 10)
const minuteOf = (seconds) => { const d = new Date(seconds * 1000 + IST_OFFSET_MS); return d.getUTCHours() * 60 + d.getUTCMinutes() }
const round = (value, digits = 3) => Number.isFinite(value) ? Number(value.toFixed(digits)) : null

function rowsFor(symbol) {
  const file = path.join(ROOT, "db", "candles", `${symbol}.jsonl`)
  if (!fs.existsSync(file)) return []
  return fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean).flatMap((line) => {
    try {
      const row = JSON.parse(line)
      return Number.isFinite(Number(row.time)) && Number.isFinite(Number(row.close)) && Number.isFinite(Number(row.volume)) ? [{ ...row, time: Number(row.time), close: Number(row.close), volume: Number(row.volume) }] : []
    } catch { return [] }
  }).sort((left, right) => left.time - right.time)
}

function evaluate(symbol) {
  const all = rowsFor(symbol)
  const dates = [...new Set(all.map((row) => dateOf(row.time)))].sort()
  if (!dates.includes(targetDate)) return null
  const selected = dates.slice(-10)
  const calculation = all.filter((row) => selected.includes(dateOf(row.time)) && (dateOf(row.time) !== targetDate || minuteOf(row.time) < cutoffMinute))
  let pvi = 1000, nvi = 1000, previous = null
  const series = calculation.map((row) => {
    const change = previous && previous.close !== 0 ? (row.close - previous.close) / previous.close : 0
    if (previous && row.volume > previous.volume) pvi *= 1 + change
    if (previous && row.volume < previous.volume) nvi *= 1 + change
    previous = row
    return { ...row, pvi, nvi }
  }).filter((row) => dateOf(row.time) === targetDate && minuteOf(row.time) < cutoffMinute)
  const last = series.at(-1)
  return last ? { stock: symbol, asOf: "09:30", candle: `${String(Math.floor(minuteOf(last.time) / 60)).padStart(2, "0")}:${String(minuteOf(last.time) % 60).padStart(2, "0")}`, pvi: round(last.pvi), nvi: round(last.nvi), difference: round(last.pvi - last.nvi), close: round(last.close) } : null
}

const stocks = JSON.parse(fs.readFileSync(path.join(ROOT, "db", "stocks"), "utf8"))
  .map((symbol) => String(symbol).trim().toUpperCase()).filter(Boolean)
const ranked = stocks.map(evaluate).filter(Boolean).sort((left, right) => right.difference - left.difference)
const top10 = ranked.slice(0, 10)
const output = path.join(ROOT, "reports", `${targetDate}-0930-pvi-minus-nvi-top10.json`)
fs.writeFileSync(output, `${JSON.stringify({ targetDate, asOf: "09:30 IST", method: "PVI minus NVI using latest 10 available dates and completed candles through 09:29 IST; PVI updates on higher-volume candles and NVI on lower-volume candles.", top10 }, null, 2)}\n`)
console.table(top10.map((row, index) => ({ Rank: index + 1, Stock: row.stock, Candle: row.candle, PVI: row.pvi, NVI: row.nvi, "PVI-NVI": row.difference, Close: row.close })))
console.log(`Saved ${output}`)
