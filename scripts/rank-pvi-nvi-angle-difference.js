#!/usr/bin/env node
import fs from "node:fs"
import path from "node:path"

const ROOT = process.cwd()
const IST_OFFSET_MS = 330 * 60_000
const targetDate = process.argv[2] || ""
const startMinute = Number(process.argv[3] || 555)
const endMinute = Number(process.argv[4] || 570)
const topN = Number(process.argv[5] || 10)

const dateOf = (seconds) => new Date(seconds * 1000 + IST_OFFSET_MS).toISOString().slice(0, 10)
const minuteOf = (seconds) => {
  const date = new Date(seconds * 1000 + IST_OFFSET_MS)
  return date.getUTCHours() * 60 + date.getUTCMinutes()
}
const round = (value, digits = 3) => Number.isFinite(value) ? Number(value.toFixed(digits)) : null

function angle(rows, field) {
  const values = rows.map((row) => row[field])
  if (values.length < 2 || !Number.isFinite(values[0]) || values[0] === 0) return null
  const n = values.length
  const xBar = (n - 1) / 2
  const yBar = values.reduce((sum, value) => sum + value, 0) / n
  const denominator = values.reduce((sum, _value, index) => sum + (index - xBar) ** 2, 0)
  const slope = values.reduce((sum, value, index) => sum + (index - xBar) * (value - yBar), 0) / denominator
  return Math.atan((slope / values[0]) * 100) * 180 / Math.PI
}

function readCandles(symbol) {
  const file = path.join(ROOT, "db", "candles", `${symbol}.jsonl`)
  if (!fs.existsSync(file)) return []
  return fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean).flatMap((line) => {
    try {
      const row = JSON.parse(line)
      const candle = { ...row, time: Number(row.time), close: Number(row.close), volume: Number(row.volume) }
      return Number.isFinite(candle.time) && Number.isFinite(candle.close) && Number.isFinite(candle.volume) ? [candle] : []
    } catch {
      return []
    }
  }).sort((left, right) => left.time - right.time)
}

function evaluate(symbol, requestedDate) {
  const all = readCandles(symbol)
  if (!all.length) return null
  const dates = [...new Set(all.map((row) => dateOf(row.time)))].sort()
  const date = requestedDate || dates.at(-1)
  if (!dates.includes(date)) return null
  const selectedDates = dates.slice(-10)
  if (!selectedDates.includes(date)) return null
  const calculation = all.filter((row) => selectedDates.includes(dateOf(row.time)) && (dateOf(row.time) !== date || minuteOf(row.time) <= endMinute))
  let pvi = 1000
  let nvi = 1000
  let pviEma = null
  let nviEma = null
  let previous = null
  const series = []
  for (const row of calculation) {
    const change = previous && previous.close !== 0 ? (row.close - previous.close) / previous.close : 0
    if (previous && row.volume > previous.volume) pvi *= 1 + change
    if (previous && row.volume < previous.volume) nvi *= 1 + change
    pviEma = pviEma === null ? pvi : pvi * (2 / 256) + pviEma * (254 / 256)
    nviEma = nviEma === null ? nvi : nvi * (2 / 256) + nviEma * (254 / 256)
    previous = row
    if (dateOf(row.time) === date && minuteOf(row.time) >= startMinute && minuteOf(row.time) <= endMinute) {
      series.push({ ...row, pvi, pviEma, nvi, nviEma })
    }
  }
  if (series.length < 2) return null
  const pviAngle = angle(series, "pvi")
  const pviEmaAngle = angle(series, "pviEma")
  const nviAngle = angle(series, "nvi")
  const nviEmaAngle = angle(series, "nviEma")
  if (![pviAngle, pviEmaAngle, nviAngle, nviEmaAngle].every(Number.isFinite)) return null
  return {
    STOCK: symbol,
    CANDLES: series.length,
    PVI: round(pviAngle),
    NVI: round(nviAngle),
    "PVI-NVI": round(pviAngle - nviAngle),
    "ABS DIFF": round(Math.abs(pviAngle - nviAngle)),
    "PVI-EMA": round(pviEmaAngle),
    "NVI-EMA": round(nviEmaAngle),
  }
}

const stockFile = path.join(ROOT, "db", "stocks")
const symbols = fs.existsSync(stockFile) && fs.readFileSync(stockFile, "utf8").trim()
  ? JSON.parse(fs.readFileSync(stockFile, "utf8")).map((symbol) => String(symbol).trim().toUpperCase()).filter(Boolean)
  : []
const rows = symbols.map((symbol) => evaluate(symbol, targetDate)).filter(Boolean)
  .sort((left, right) => right["PVI-NVI"] - left["PVI-NVI"])
const date = rows[0] ? targetDate || rows[0].DATE : targetDate || "latest"
const output = path.join(ROOT, "reports", `${date}-0915-${String(Math.floor(endMinute / 60)).padStart(2, "0")}${String(endMinute % 60).padStart(2, "0")}-pvi-nvi-angle-difference.json`)
fs.writeFileSync(output, `${JSON.stringify({ date, window: `${String(Math.floor(startMinute / 60)).padStart(2, "0")}:${String(startMinute % 60).padStart(2, "0")}–${String(Math.floor(endMinute / 60)).padStart(2, "0")}:${String(endMinute % 60).padStart(2, "0")} IST`, method: "PVI/NVI start at 1000; PVI updates on higher-volume candles; NVI updates on lower-volume candles; both EMAs use length 255; angles are normalized linear-regression slopes over the selected minutes.", rows: rows.slice(0, topN) }, null, 2)}\n`)
console.table(rows.slice(0, topN))
console.log(`Ranked ${rows.length} stocks; top ${Math.min(topN, rows.length)} shown; saved ${output}`)
