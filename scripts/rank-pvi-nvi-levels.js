#!/usr/bin/env node
import fs from "node:fs"
import path from "node:path"

const ROOT = process.cwd()
const IST_OFFSET_MS = 330 * 60_000
const requestedDate = process.argv[2] || ""
const endMinute = Number(process.argv[3] || 560)
const topN = Number(process.argv[4] || 10)
const dateOf = (seconds) => new Date(seconds * 1000 + IST_OFFSET_MS).toISOString().slice(0, 10)
const minuteOf = (seconds) => {
  const date = new Date(seconds * 1000 + IST_OFFSET_MS)
  return date.getUTCHours() * 60 + date.getUTCMinutes()
}
const timeOf = (seconds) => {
  const date = new Date(seconds * 1000 + IST_OFFSET_MS)
  return `${String(date.getUTCHours()).padStart(2, "0")}:${String(date.getUTCMinutes()).padStart(2, "0")}`
}
const round = (value, digits = 3) => Number.isFinite(value) ? Number(value.toFixed(digits)) : null

function readCandles(symbol) {
  const file = path.join(ROOT, "db", "candles", `${symbol}.jsonl`)
  if (!fs.existsSync(file)) return []
  return fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean).flatMap((line) => {
    try {
      const row = JSON.parse(line)
      const candle = { ...row, time: Number(row.time), close: Number(row.close), volume: Number(row.volume) }
      return [candle].every((item) => [item.time, item.close, item.volume].every(Number.isFinite)) ? [candle] : []
    } catch {
      return []
    }
  }).sort((left, right) => left.time - right.time)
}

function evaluate(symbol) {
  const all = readCandles(symbol)
  if (!all.length) return null
  const dates = [...new Set(all.map((row) => dateOf(row.time)))].sort()
  const date = requestedDate || dates.at(-1)
  if (!dates.includes(date)) return null
  const selectedDates = dates.filter((availableDate) => availableDate <= date).slice(-10)
  if (!selectedDates.includes(date)) return null
  const calculation = all.filter((row) => selectedDates.includes(dateOf(row.time)) && (dateOf(row.time) !== date || minuteOf(row.time) <= endMinute))
  let pvi = 1000
  let nvi = 1000
  let previous = null
  let last = null
  for (const row of calculation) {
    const change = previous && previous.close !== 0 ? (row.close - previous.close) / previous.close : 0
    if (previous && row.volume > previous.volume) pvi *= 1 + change
    if (previous && row.volume < previous.volume) nvi *= 1 + change
    previous = row
    if (dateOf(row.time) === date) last = row
  }
  if (!last) return null
  return { STOCK: symbol, AT: timeOf(last.time), PVI: round(pvi), NVI: round(nvi) }
}

const stocksFile = path.join(ROOT, "db", "stocks")
const symbols = fs.existsSync(stocksFile) && fs.readFileSync(stocksFile, "utf8").trim()
  ? JSON.parse(fs.readFileSync(stocksFile, "utf8")).map((symbol) => String(symbol).trim().toUpperCase()).filter(Boolean)
  : []
const results = symbols.map(evaluate).filter(Boolean)
const date = results[0] ? (requestedDate || "latest") : requestedDate || "latest"
const topPvi = [...results].sort((a, b) => b.PVI - a.PVI).slice(0, topN)
const topNvi = [...results].sort((a, b) => b.NVI - a.NVI).slice(0, topN)
const output = path.join(ROOT, "reports", `${date}-0920-pvi-nvi-level-ranking.json`)
fs.writeFileSync(output, `${JSON.stringify({ date, window: "09:15–09:20 IST", method: "PVI and NVI start at 1000 and are updated across the latest 10 available sessions; PVI updates on higher-volume candles and NVI on lower-volume candles.", topPvi, topNvi }, null, 2)}\n`)
console.log("Top PVI")
console.table(topPvi)
console.log("Top NVI")
console.table(topNvi)
console.log(`Ranked ${results.length} stocks; saved ${output}`)
