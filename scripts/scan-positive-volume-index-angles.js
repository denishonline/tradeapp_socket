#!/usr/bin/env node
import fs from "node:fs"
import path from "node:path"

const ROOT = process.cwd()
const IST_OFFSET_MS = 330 * 60_000
const dateArg = process.argv[2] || ""
const startMinute = Number(process.argv[3] || 555)
const endMinute = Number(process.argv[4] || 560)
const dateOf = (seconds) => new Date(seconds * 1000 + IST_OFFSET_MS).toISOString().slice(0, 10)
const minuteOf = (seconds) => { const d = new Date(seconds * 1000 + IST_OFFSET_MS); return d.getUTCHours() * 60 + d.getUTCMinutes() }
const timeOf = (minute) => `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`
const round = (value, digits = 3) => Number.isFinite(value) ? Number(value.toFixed(digits)) : null

function readCandles(symbol) {
  const file = path.join(ROOT, "db", "candles", `${symbol}.jsonl`)
  if (!fs.existsSync(file)) return []
  return fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean).flatMap((line) => {
    try {
      const row = JSON.parse(line)
      return Number.isFinite(Number(row.time)) && Number.isFinite(Number(row.close)) && Number.isFinite(Number(row.volume)) ? [{
        ...row, time: Number(row.time), close: Number(row.close), volume: Number(row.volume), open: Number(row.open), high: Number(row.high), low: Number(row.low),
      }] : []
    } catch { return [] }
  }).sort((left, right) => left.time - right.time)
}

function angleSeries(rows, field) {
  if (rows.length < 2 || !Number.isFinite(rows[0][field]) || rows[0][field] === 0) return null
  const values = rows.map((row) => row[field])
  const n = values.length, xBar = (n - 1) / 2, yBar = values.reduce((sum, value) => sum + value, 0) / n
  const denominator = values.reduce((sum, _value, index) => sum + (index - xBar) ** 2, 0)
  const slope = values.reduce((sum, value, index) => sum + (index - xBar) * (value - yBar), 0) / denominator
  return { slope, angle: Math.atan((slope / values[0]) * 100) * 180 / Math.PI, start: values[0], end: values.at(-1), changePct: (values.at(-1) / values[0] - 1) * 100 }
}

function evaluate(symbol, requestedDate) {
  const all = readCandles(symbol)
  if (!all.length) return null
  const dates = [...new Set(all.map((row) => dateOf(row.time)))].sort()
  const targetDate = requestedDate || dates.at(-1)
  if (!dates.includes(targetDate)) return null
  const selectedDates = dates.filter((availableDate) => availableDate <= targetDate).slice(-10)
  if (!selectedDates.includes(targetDate)) return null
  const calculation = all.filter((row) => selectedDates.includes(dateOf(row.time)) && (dateOf(row.time) !== targetDate || minuteOf(row.time) <= endMinute))
  let pvi = 1000, nvi = 1000, pviEma = null, nviEma = null, previous = null
  const series = calculation.map((row) => {
    const change = previous && previous.close !== 0 ? (row.close - previous.close) / previous.close : 0
    if (previous && row.volume > previous.volume) pvi *= 1 + change
    if (previous && row.volume < previous.volume) nvi *= 1 + change
    pviEma = pviEma === null ? pvi : pvi * (2 / 256) + pviEma * (254 / 256)
    nviEma = nviEma === null ? nvi : nvi * (2 / 256) + nviEma * (254 / 256)
    previous = row
    return { ...row, pvi, pviEma, nvi, nviEma }
  }).filter((row) => dateOf(row.time) === targetDate && minuteOf(row.time) >= startMinute && minuteOf(row.time) <= endMinute)
  if (series.length < 2) return null
  const pviAngle = angleSeries(series, "pvi"), pviEmaAngle = angleSeries(series, "pviEma")
  const nviAngle = angleSeries(series, "nvi"), nviEmaAngle = angleSeries(series, "nviEma")
  if (![pviAngle, pviEmaAngle, nviAngle, nviEmaAngle].every(Boolean)) return null
  return {
    stock: symbol, date: targetDate, candles: series.length,
    pviAngleDeg: round(pviAngle.angle), pviEmaAngleDeg: round(pviEmaAngle.angle), nviAngleDeg: round(nviAngle.angle), nviEmaAngleDeg: round(nviEmaAngle.angle),
    pviChangePct: round(pviAngle.changePct), pviEmaChangePct: round(pviEmaAngle.changePct), nviChangePct: round(nviAngle.changePct), nviEmaChangePct: round(nviEmaAngle.changePct),
    pviAtEnd: round(pviAngle.end), pviEmaAtEnd: round(pviEmaAngle.end), nviAtEnd: round(nviAngle.end), nviEmaAtEnd: round(nviEmaAngle.end),
  }
}

const symbols = fs.readFileSync(path.join(ROOT, "db", "stocks"), "utf8").trim()
  ? JSON.parse(fs.readFileSync(path.join(ROOT, "db", "stocks"), "utf8")).map((symbol) => String(symbol).trim().toUpperCase()).filter(Boolean)
  : []
const results = symbols.map((symbol) => evaluate(symbol, dateArg)).filter(Boolean)
const positive = results.filter((row) => row.pviAngleDeg > 0 && row.pviEmaAngleDeg > 0 && row.nviAngleDeg > 0 && row.nviEmaAngleDeg > 0)
  .sort((left, right) => Math.min(right.pviAngleDeg, right.pviEmaAngleDeg, right.nviAngleDeg, right.nviEmaAngleDeg) - Math.min(left.pviAngleDeg, left.pviEmaAngleDeg, left.nviAngleDeg, left.nviEmaAngleDeg))
const targetDate = positive[0]?.date || dateArg || "latest"
const result = { targetDate, window: `${timeOf(startMinute)}–${timeOf(endMinute)} IST`, method: "PVI/NVI start at 1000; PVI updates on higher-volume candles, NVI updates on lower-volume candles; both EMAs use length 255. Angle is normalized linear-regression slope over the selected minutes.", matched: positive }
const output = path.join(ROOT, "reports", `${targetDate}-0915-0920-positive-volume-index-angles.json`)
fs.writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`)
console.table(positive.map((row) => ({ Stock: row.stock, PVI: `${row.pviAngleDeg}°`, "PVI-EMA": `${row.pviEmaAngleDeg}°`, NVI: `${row.nviAngleDeg}°`, "NVI-EMA": `${row.nviEmaAngleDeg}°`, "PVI Δ%": row.pviChangePct, "NVI Δ%": row.nviChangePct })))
console.log(`Matched ${positive.length} of ${results.length} stocks; saved ${output}`)
