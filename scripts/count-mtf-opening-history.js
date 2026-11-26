#!/usr/bin/env node
import fs from "node:fs"
import path from "node:path"

const ROOT = process.cwd(), END_DATE = "2026-11-04", OPEN = 555, CUTOFF = 570, IST = 330 * 60_000
const symbols = `ADANIENT,AMBER,DMART,BAJFINANCE,BAJAJFINSV,COCHINSHIP,GODREJPROP,GODFRYPHLP,HDFCAMC,HAL,KFINTECH,LT,LODHA,MARICO,MUTHOOTFIN,OBEROIRLTY,PAGEIND,PRESTIGE,SHRIRAMFIN,TITAN,UNOMINDA,ULTRACEMCO`.split(",")
const dateOf = epoch => new Date(epoch * 1000 + IST).toISOString().slice(0, 10)
const minuteOf = epoch => { const s = new Date(epoch * 1000 + IST).toISOString().slice(11, 16); return +s.slice(0, 2) * 60 + +s.slice(3) }
const pct = (a, b) => b ? 100 * (a / b - 1) : NaN
const median = values => { const a = values.filter(Number.isFinite).sort((x, y) => x - y); return a.length ? a[Math.floor(a.length / 2)] : NaN }
const round = (value, digits = 3) => Number.isFinite(value) ? +value.toFixed(digits) : null
const cache = new Map()
function load(symbol) {
  if (cache.has(symbol)) return cache.get(symbol)
  const file = path.join(ROOT, "db", "candles", `${symbol}.jsonl`)
  if (!fs.existsSync(file)) return []
  const rows = fs.readFileSync(file, "utf8").trim().split(/\r?\n/).filter(Boolean).map(JSON.parse).sort((a, b) => a.time - b.time).map(row => ({ ...row, date: dateOf(row.time), minute: minuteOf(row.time) }))
  cache.set(symbol, rows); return rows
}
function aggregate(rows, size) {
  const dates = [...new Set(rows.map(row => row.date))], bars = []
  for (const date of dates) {
    const opening = rows.filter(row => row.date === date && row.minute >= OPEN && row.minute < 900)
    for (let start = OPEN; start < 900; start += size) {
      const block = opening.filter(row => row.minute >= start && row.minute < start + size)
      if (block.length !== size) continue
      bars.push({ date, minute: start, time: block[0].time, open: block[0].open, high: Math.max(...block.map(row => row.high)), low: Math.min(...block.map(row => row.low)), close: block.at(-1).close, volume: block.reduce((sum, row) => sum + (Number(row.volume) || 0), 0) })
    }
  }
  return bars.sort((a, b) => a.time - b.time)
}
function assess(bars, nifty, date, size) {
  const current = bars.filter(row => row.date === date && row.minute + size <= CUTOFF)
  const priorDates = [...new Set(bars.map(row => row.date).filter(value => value < date))].sort().slice(-10)
  const prior = priorDates.map(value => bars.filter(row => row.date === value && row.minute >= OPEN && row.minute + size <= CUTOFF))
  const market = nifty.filter(row => row.date === date && row.minute + size <= CUTOFF)
  if (!current.length || prior.length < 10 || prior.some(rows => !rows.length) || !market.length) return false
  const volumeAcceleration = current.reduce((sum, row) => sum + row.volume, 0) / median(prior.map(rows => rows.reduce((sum, row) => sum + row.volume, 0)))
  const relativeStrength = pct(current.at(-1).close, current[0].open) - pct(market.at(-1).close, market[0].open)
  const before = bars.filter(row => row.time <= current.at(-1).time); let ema = null
  const emaSeries = before.map(row => { ema = ema == null ? row.close : (2 / 21) * row.close + (19 / 21) * ema; return ema })
  const tail = emaSeries.slice(-60), angle = tail.length > 1 ? Math.atan((tail.at(-1) - tail[0]) / (tail.length - 1)) * 180 / Math.PI : NaN
  return volumeAcceleration >= .8 && relativeStrength > .3 && angle > 15
}
const nifty = new Map([1, 5, 15].map(size => [size, aggregate(load("NIFTY50"), size)]))
const sessions = [...new Set(load("NIFTY50").map(row => row.date).filter(date => date < END_DATE))].sort().slice(-10)
const results = symbols.map(symbol => {
  const bars = new Map([1, 5, 15].map(size => [size, aggregate(load(symbol), size)])), passedDates = []
  for (const date of sessions) if ([1, 5, 15].every(size => assess(bars.get(size), nifty.get(size), date, size))) passedDates.push(date)
  return { symbol, count: passedDates.length, passedDates }
}).sort((a, b) => b.count - a.count || a.symbol.localeCompare(b.symbol))
console.table(results.map(row => ({ Stock: row.symbol, "Passed sessions": row.count, "Out of": sessions.length, Dates: row.passedDates.join(",") })))
const output = { endDate: END_DATE, sessions, symbols, thresholds: { volumeAcceleration: ">= 0.8", relativeStrength: "> 0.30", ema20Angle: "> 15" }, methodology: "Count of sessions where all three conditions passed on each of 1m, 5m, and 15m opening bars through 09:30 IST. Volume compares the opening cumulative total with the previous-ten-session median for the same timeframe. EMA20 angle uses the last 60 completed timeframe bars.", results }
let n = 1, file
do { file = path.join(ROOT, "reports", `mtf-opening-history-count-${END_DATE}${n === 1 ? "" : `-${n}`}.json`); n++ } while (fs.existsSync(file))
fs.writeFileSync(file, `${JSON.stringify(output, null, 2)}\n`, { flag: "wx" })
console.log(`Report: ${file}`)
console.log(`Sorted symbols: ${results.map(row => `NSE:${row.symbol}-EQ`).join(",")}`)
