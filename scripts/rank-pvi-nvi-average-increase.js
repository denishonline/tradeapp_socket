#!/usr/bin/env node
import fs from "node:fs"
import path from "node:path"

const ROOT = process.cwd()
const IST_OFFSET_MS = 330 * 60_000
const targetDate = process.argv[2] || "2026-10-28"
const endMinute = Number(process.argv[3] || 559)
const lookback = Number(process.argv[4] || 10)
const topN = Number(process.argv[5] || 10)
const dateOf = (seconds) => new Date(seconds * 1000 + IST_OFFSET_MS).toISOString().slice(0, 10)
const minuteOf = (seconds) => { const d = new Date(seconds * 1000 + IST_OFFSET_MS); return d.getUTCHours() * 60 + d.getUTCMinutes() }
const timeOf = (seconds) => { const d = new Date(seconds * 1000 + IST_OFFSET_MS); return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}` }
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
  const all = readCandles(symbol)
  const dates = [...new Set(all.map((row) => dateOf(row.time)))].sort()
  const targetIndex = dates.indexOf(targetDate)
  if (targetIndex < 1) return null
  const previousDate = dates[targetIndex - 1]
  const previous = all.filter((row) => dateOf(row.time) === previousDate)
  const current = all.filter((row) => dateOf(row.time) === targetDate && minuteOf(row.time) <= endMinute).slice(0, 5)
  const rows = [...previous.slice(-(lookback - current.length)), ...current]
  if (rows.length < 2) return null
  let pvi = 1000
  let nvi = 1000
  for (let index = 1; index < rows.length; index += 1) {
    const prior = rows[index - 1]
    const row = rows[index]
    const change = prior.close !== 0 ? (row.close - prior.close) / prior.close : 0
    if (row.volume > prior.volume) pvi *= 1 + change
    if (row.volume < prior.volume) nvi *= 1 + change
  }
  const pviIncrease = (pvi / 1000 - 1) * 100
  const nviIncrease = (nvi / 1000 - 1) * 100
  return { STOCK: symbol, CANDLES: rows.length, START: timeOf(rows[0].time), END: timeOf(rows.at(-1).time), PVI: round(pvi), NVI: round(nvi), "PVI %": round(pviIncrease), "NVI %": round(nviIncrease), "AVERAGE %": round((pviIncrease + nviIncrease) / 2) }
}

const stocksFile = path.join(ROOT, "db", "stocks")
const symbols = fs.existsSync(stocksFile) && fs.readFileSync(stocksFile, "utf8").trim()
  ? JSON.parse(fs.readFileSync(stocksFile, "utf8")).map((symbol) => String(symbol).trim().toUpperCase()).filter(Boolean)
  : []
const rows = symbols.map(evaluate).filter(Boolean).sort((a, b) => b["AVERAGE %"] - a["AVERAGE %"])
const output = path.join(ROOT, "reports", `${targetDate}-0920-pvi-nvi-average-increase.json`)
fs.writeFileSync(output, `${JSON.stringify({ targetDate, window: "previous session final 5 candles + target session first 5 candles", method: "PVI and NVI reset to 1000 at the start of the 10-candle window; PVI updates on higher-volume candles and NVI on lower-volume candles; ranking score is (PVI increase + NVI increase) / 2.", rows: rows.slice(0, topN) }, null, 2)}\n`)
console.table(rows.slice(0, topN))
console.log(`Ranked ${rows.length} stocks; saved ${output}`)
