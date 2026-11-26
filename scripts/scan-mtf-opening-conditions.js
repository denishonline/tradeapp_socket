#!/usr/bin/env node
import fs from "node:fs"
import path from "node:path"

const arg = name => { const index = process.argv.indexOf(name); return index >= 0 ? process.argv[index + 1] : null }
const ROOT = process.cwd(), DATE = arg("--date") || "2026-11-03"
const timeArg = arg("--time") || "09:30"
const [cutoffHour, cutoffMinute] = timeArg.split(":").map(Number)
const OPEN = 555, CUTOFF = cutoffHour * 60 + cutoffMinute, IST = 330 * 60_000
const timeOf = epoch => { const s = new Date(epoch * 1000 + IST).toISOString().slice(11, 16); return +s.slice(0, 2) * 60 + +s.slice(3) }
const dateOf = epoch => new Date(epoch * 1000 + IST).toISOString().slice(0, 10)
const pct = (a, b) => b ? 100 * (a / b - 1) : NaN
const round = (v, d = 4) => Number.isFinite(v) ? +v.toFixed(d) : null
const median = a => { const s = a.filter(Number.isFinite).sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : NaN }
const stocks = JSON.parse(fs.readFileSync(path.join(ROOT, "db", "stocks"), "utf8"))
const cache = new Map()
function load(symbol) {
  if (cache.has(symbol)) return cache.get(symbol)
  const rows = fs.readFileSync(path.join(ROOT, "db", "candles", `${symbol}.jsonl`), "utf8").trim().split(/\r?\n/).filter(Boolean).map(JSON.parse).sort((a, b) => a.time - b.time).map(row => ({ ...row, date: dateOf(row.time), minute: timeOf(row.time) }))
  cache.set(symbol, rows); return rows
}
function aggregate(rows, size) {
  const byDate = Map.groupBy(rows, row => row.date), bars = []
  for (const [date, dayRows] of byDate) {
    const opening = dayRows.filter(row => row.minute >= OPEN && row.minute < 900)
    for (let start = OPEN; start < 900; start += size) {
      const block = opening.filter(row => row.minute >= start && row.minute < start + size)
      if (block.length !== size) continue
      bars.push({ date, minute: start, time: block[0].time, open: block[0].open, high: Math.max(...block.map(row => row.high)), low: Math.min(...block.map(row => row.low)), close: block.at(-1).close, volume: block.reduce((sum, row) => sum + (Number(row.volume) || 0), 0) })
    }
  }
  return bars.sort((a, b) => a.time - b.time)
}
function pviNviTrends(symbol) {
  const rows = load(symbol).filter(row => row.time <= Math.floor(Date.parse(`${DATE}T${String(Math.floor(CUTOFF / 60)).padStart(2, "0")}:${String(CUTOFF % 60).padStart(2, "0")}:00+05:30`) / 1000))
  let pvi = 1000, nvi = 1000, pviEma = 1000, nviEma = 1000
  const alpha = 2 / 256, spreads = []
  for (let index = 1; index < rows.length; index++) {
    const previous = rows[index - 1], row = rows[index]
    if (previous.close && row.volume > previous.volume) pvi *= 1 + (row.close - previous.close) / previous.close
    if (previous.close && row.volume < previous.volume) nvi *= 1 + (row.close - previous.close) / previous.close
    pviEma = alpha * pvi + (1 - alpha) * pviEma
    nviEma = alpha * nvi + (1 - alpha) * nviEma
    if (row.date === DATE && row.minute >= OPEN && row.minute < CUTOFF) spreads.push({ pviSpread: pvi - pviEma, nviSpread: nvi - nviEma })
  }
  const last30 = spreads.slice(-30)
  const pviEmaSpreadDecreasing = last30.length === 30 && last30.at(-1).pviSpread < last30[0].pviSpread
  const nviEmaSpreadIncreasing = last30.length === 30 && last30.at(-1).nviSpread > last30[0].nviSpread
  return { pviEmaSpreadDecreasing, nviEmaSpreadIncreasing, pviNviBothTrue: pviEmaSpreadDecreasing && nviEmaSpreadIncreasing }
}
function assess(symbol, size, niftyBars) {
  const bars = aggregate(load(symbol), size), current = bars.filter(row => row.date === DATE && row.minute + size <= CUTOFF)
  if (!current.length) return null
  const priorDates = [...new Set(bars.map(row => row.date).filter(date => date < DATE))].sort().slice(-10)
  const prior = priorDates.map(date => bars.filter(row => row.date === date && row.minute >= OPEN && row.minute + size <= CUTOFF))
  if (prior.length < 10 || prior.some(rows => !rows.length)) return null
  const currentVolume = current.reduce((sum, row) => sum + row.volume, 0)
  const priorVolumes = prior.map(rows => rows.reduce((sum, row) => sum + row.volume, 0))
  const volumeAcceleration = currentVolume / median(priorVolumes)
  const niftyCurrent = niftyBars.filter(row => row.date === DATE && row.minute + size <= CUTOFF)
  if (!niftyCurrent.length) return null
  const stockReturn = pct(current.at(-1).close, current[0].open), niftyReturn = pct(niftyCurrent.at(-1).close, niftyCurrent[0].open)
  const allBefore = bars.filter(row => row.time <= current.at(-1).time)
  let ema = null; const series = allBefore.map(row => { ema = ema == null ? row.close : (2 / 21) * row.close + (19 / 21) * ema; return { ...row, ema } })
  const tail = series.slice(-60), angle = tail.length > 1 ? Math.atan((tail.at(-1).ema - tail[0].ema) / (tail.length - 1)) * 180 / Math.PI : NaN
  return { symbol, timeframe: `${size}m`, bars: current.length, volumeAcceleration, stockReturn, niftyReturn, relativeStrength: stockReturn - niftyReturn, ema20Angle: angle, volumePass: volumeAcceleration >= .8, relativePass: stockReturn - niftyReturn > .3, anglePass: angle > 15, ...(size === 1 ? pviNviTrends(symbol) : {}) }
}
const niftyBySize = new Map([1, 5, 15].map(size => [size, aggregate(load("NIFTY50"), size)]))
const rows = stocks.flatMap(symbol => [1, 5, 15].map(size => assess(symbol, size, niftyBySize.get(size))).filter(Boolean))
const passing = stocks.map(symbol => {
  const byTf = rows.filter(row => row.symbol === symbol), ok = byTf.length === 3 && byTf.every(row => row.volumePass && row.relativePass && row.anglePass)
  return { symbol, ok, timeframes: byTf }
}).filter(row => row.ok)
const output = { date: DATE, cutoff: `${timeArg} IST (bars ending at cutoff; latest included one-minute candle is the prior minute)`, methodology: "For each timeframe, current cumulative opening volume is compared with the median of the previous ten sessions over the same opening window. Relative strength is stock opening return minus matching NIFTY50 return. EMA20 angle is measured over the last 60 completed timeframe bars ending at the cutoff; angle is raw price-units per bar converted with atan, matching the existing strategy's raw-angle convention. PVI/NVI diagnostics use EMA255 and the latest 30 completed one-minute candles.", pviNviEmaLength: 255, thresholds: { volumeAcceleration: ">= 0.8", relativeStrength: "> 0.30 percentage points", ema20Angle: "> 15 degrees" }, passing, audit: rows }
let n = 1, file
const timeLabel = timeArg.replace(":", "")
do { file = path.join(ROOT, "reports", `${DATE}-${timeLabel}-mtf-opening-conditions${n === 1 ? "" : `-${n}`}.json`); n++ } while (fs.existsSync(file))
fs.writeFileSync(file, `${JSON.stringify(output, null, 2)}\n`, { flag: "wx" })
console.log(`Report: ${file}`)
console.table(passing.map(row => {
  const oneMinute = row.timeframes.find(timeframe => timeframe.timeframe === "1m")
  return { Stock: row.symbol, "1m": "PASS", "5m": "PASS", "15m": "PASS", "All 9": "PASS", "Last 30 1m PVI-EMA255 decreasing": oneMinute.pviEmaSpreadDecreasing, "Last 30 1m NVI-EMA255 increasing": oneMinute.nviEmaSpreadIncreasing, "PVI/NVI both true": oneMinute.pviNviBothTrue }
}))
console.log(`Stocks passing all 9 conditions: ${passing.length}`)
console.log(`Comma-separated symbols: ${passing.map(row => `NSE:${row.symbol}-EQ`).join(",")}`)
