#!/usr/bin/env node
import fs from "node:fs"
import path from "node:path"

const ROOT = process.cwd()
const IST_OFFSET_MS = 330 * 60_000
const targetDate = process.argv[2] || "2026-10-28"
const startMinute = 555
const endMinute = Number(process.argv[3] || 560)
const topN = Number(process.argv[4] || 10)
const dateOf = (seconds) => new Date(seconds * 1000 + IST_OFFSET_MS).toISOString().slice(0, 10)
const minuteOf = (seconds) => { const d = new Date(seconds * 1000 + IST_OFFSET_MS); return d.getUTCHours() * 60 + d.getUTCMinutes() }
const round = (value, digits = 3) => Number.isFinite(value) ? Number(value.toFixed(digits)) : null

function readCandles(symbol) {
  const file = path.join(ROOT, "db", "candles", `${symbol}.jsonl`)
  if (!fs.existsSync(file)) return []
  return fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean).flatMap((line) => {
    try {
      const row = JSON.parse(line)
      const candle = { time: Number(row.time), close: Number(row.close), volume: Number(row.volume) }
      return [candle].every((item) => [item.time, item.close, item.volume].every(Number.isFinite)) ? [candle] : []
    } catch { return [] }
  }).sort((a, b) => a.time - b.time)
}

function evaluate(symbol) {
  const rows = readCandles(symbol).filter((row) => dateOf(row.time) === targetDate && minuteOf(row.time) >= startMinute && minuteOf(row.time) <= endMinute)
  if (rows.length < 2) return null
  let pvi = 1000
  for (let index = 1; index < rows.length; index += 1) {
    const previous = rows[index - 1]
    const row = rows[index]
    const change = previous.close !== 0 ? (row.close - previous.close) / previous.close : 0
    if (row.volume > previous.volume) pvi *= 1 + change
  }
  return { STOCK: symbol, CANDLES: rows.length, PVI: round(pvi), "PVI CHANGE %": round((pvi / 1000 - 1) * 100) }
}

const stocksFile = path.join(ROOT, "db", "stocks")
const symbols = fs.existsSync(stocksFile) && fs.readFileSync(stocksFile, "utf8").trim()
  ? JSON.parse(fs.readFileSync(stocksFile, "utf8")).map((symbol) => String(symbol).trim().toUpperCase()).filter(Boolean)
  : []
const rows = symbols.map(evaluate).filter(Boolean).sort((a, b) => b["PVI CHANGE %"] - a["PVI CHANGE %"])
const output = path.join(ROOT, "reports", `${targetDate}-0915-0920-opening-pvi-ranking.json`)
fs.writeFileSync(output, `${JSON.stringify({ targetDate, window: "09:15–09:20 IST", method: "PVI resets to 1000 at 09:15 for each stock; subsequent candles update only when volume is greater than the immediately previous candle volume.", rows: rows.slice(0, topN) }, null, 2)}\n`)
console.table(rows.slice(0, topN))
console.log(`Ranked ${rows.length} stocks; saved ${output}`)
