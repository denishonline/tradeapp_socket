#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ROOT = process.cwd(), CANDLES = path.join(ROOT, 'db', 'candles'), STOCKS = path.join(ROOT, 'db', 'stocks')
const IST = 330 * 60_000
const arg = name => { const i = process.argv.indexOf(name); return i < 0 ? null : process.argv[i + 1] }
const oneDate = arg('--date'), fromDate = arg('--from'), toDate = arg('--to')
const TIME = arg('--time') ?? '09:30'
const BEST_CONFIRMATION = process.argv.includes('--best-confirmation')
const validDate = value => /^\d{4}-\d{2}-\d{2}$/.test(value ?? '') && !Number.isNaN(Date.parse(`${value}T00:00:00Z`))
if (oneDate && (fromDate || toDate)) throw new Error('Use --date or --from/--to, not both.')
if (!oneDate && !(fromDate && toDate)) throw new Error('Use --date YYYY-MM-DD or --from YYYY-MM-DD --to YYYY-MM-DD.')
if (fromDate && (!validDate(fromDate) || !validDate(toDate) || fromDate > toDate)) throw new Error('Invalid --from/--to date range.')
if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(TIME)) throw new Error('--time must use HH:MM.')
if (fromDate && toDate) {
  for (let value = Date.parse(`${fromDate}T00:00:00Z`); value <= Date.parse(`${toDate}T00:00:00Z`); value += 86_400_000) {
    const date = new Date(value).toISOString().slice(0, 10)
    const args = [fileURLToPath(import.meta.url), '--date', date, '--time', TIME]
    if (BEST_CONFIRMATION) args.push('--best-confirmation')
    const child = spawnSync(process.execPath, args, { stdio: 'inherit' })
    if (child.status) process.exitCode = child.status
  }
  process.exit()
}
const DATE = oneDate
if (!validDate(DATE)) throw new Error('Invalid --date value.')
const [hh, mm] = TIME.split(':').map(Number), CUTOFF = hh * 60 + mm
const round = (x, n = 3) => Number.isFinite(x) ? +x.toFixed(n) : null
const dateAt = t => new Date(t * 1000 + IST).toISOString().slice(0, 10)
const minuteAt = t => { const d = new Date(t * 1000 + IST); return d.getUTCHours() * 60 + d.getUTCMinutes() }

function load(symbol) {
  const file = path.join(CANDLES, `${symbol}.jsonl`)
  if (!fs.existsSync(file)) return []
  return fs.readFileSync(file, 'utf8').split(/\r?\n/).flatMap(line => {
    if (!line) return []
    try {
      const x = JSON.parse(line), time = +x.time, date = dateAt(time), minute = minuteAt(time)
      if (date > DATE || minute < 555 || minute >= 930) return []
      const row = { time, date, minute, open: +x.open, high: +x.high, low: +x.low, close: +x.close, volume: +x.volume }
      return Object.values(row).slice(3).every(Number.isFinite) && row.low > 0 ? [row] : []
    } catch { return [] }
  }).sort((a, b) => a.time - b.time)
}

function aggregate(rows, minutes) {
  const groups = new Map()
  for (const r of rows) {
    const bucket = 555 + Math.floor((r.minute - 555) / minutes) * minutes, key = `${r.date}|${bucket}`
    let b = groups.get(key)
    if (!b) { b = { ...r, minute: bucket, count: 1 }; groups.set(key, b) }
    else { b.high = Math.max(b.high, r.high); b.low = Math.min(b.low, r.low); b.close = r.close; b.volume += r.volume; b.count++ }
  }
  return [...groups.values()].filter(x => x.count === minutes).sort((a, b) => a.time - b.time)
}

function vwap(rows) {
  const volume = rows.reduce((s, x) => s + x.volume, 0)
  return rows.reduce((s, x) => s + ((x.high + x.low + x.close) / 3) * x.volume, 0) / (volume || 1)
}

function ema(values, length) {
  if (!values.length) return NaN
  const alpha = 2 / (length + 1)
  let value = values[0]
  for (let i = 1; i < values.length; i++) value = alpha * values[i] + (1 - alpha) * value
  return value
}

function pvtEma255Angle(rows, minutes) {
  const dates = [...new Set(rows.map(x => x.date))].filter(x => x <= DATE).sort(), previousDate = dates.filter(x => x < DATE).at(-1)
  if (!previousDate) return null
  const source = rows.filter(x => x.date === previousDate || x.date === DATE)
  const bars = minutes === 1 ? source : aggregate(source, minutes)
  const start = bars.findIndex(x => x.date === previousDate), last = bars.length - 1
  if (start < 0 || last <= start) return null
  const pvt = Array(bars.length).fill(0), ema = Array(bars.length).fill(0), alpha = 2 / 256
  ema[0] = pvt[0]
  for (let i = 1; i < bars.length; i++) {
    const change = bars[i - 1].close ? bars[i].close / bars[i - 1].close - 1 : 0
    pvt[i] = pvt[i - 1] + bars[i].volume * change
    ema[i] = i === 1 ? pvt[i] : alpha * pvt[i] + (1 - alpha) * ema[i - 1]
  }
  const slopePctPerBar = 100 * (ema[last] - ema[start]) / (Math.abs(ema[start]) || 1) / (last - start)
  const angle = Math.atan(slopePctPerBar * 100) * 180 / Math.PI
  return { angle, pvtEma255: ema[last] }
}

function scan(symbol) {
  const allRows = load(symbol)
  const rows = allRows.filter(x => x.date < DATE || (x.date === DATE && x.minute < CUTOFF))
  const current = rows.filter(x => x.date === DATE), fullSession = allRows.filter(x => x.date === DATE), frames = []
  if (!current.length) return null
  for (const minutes of [1, 5, 15]) {
    const currentBars = minutes === 1 ? current : aggregate(current, minutes)
    const last = currentBars.at(-1)
    const w = vwap(currentBars), angle = pvtEma255Angle(rows, minutes)
    if (!last || !angle) return null
    frames.push({ minutes, close: last.close, vwap: w, vwapDistancePct: 100 * (last.close / w - 1), closeAboveVwap: last.close > w, angle: angle.angle, positiveAngle: angle.angle > 0 })
  }
  if (!frames.every(x => x.closeAboveVwap && x.positiveAngle)) return null
  const closes = rows.map(x => x.close), last = current.at(-1), ema20 = ema(closes, 20), ema50 = ema(closes, 50)
  const lastThreeBase = current.at(-4)?.close
  const lastThreeReturn = lastThreeBase ? 100 * (last.close / lastThreeBase - 1) : NaN
  const ema20Distance = 100 * (last.close / ema20 - 1), ema50Distance = 100 * (last.close / ema50 - 1)
  const bestPassed = lastThreeReturn >= .16 && lastThreeReturn <= .33 &&
    ema20Distance >= .20 && ema20Distance <= .42 &&
    ema50Distance >= .10 && ema50Distance <= .59 &&
    frames[0].vwapDistancePct >= .22 && frames[0].vwapDistancePct <= .45
  if (BEST_CONFIRMATION && !bestPassed) return null
  const fullDayOpen = fullSession[0]?.open
  const fullDayClose = fullSession.at(-1)?.close
  const hasCompleteSession = fullSession.at(-1)?.minute >= 929
  const fullDayReturn = hasCompleteSession && fullDayOpen && fullDayClose ? 100 * (fullDayClose / fullDayOpen - 1) : NaN
  return { Stock: symbol, Time: TIME, '1m close': round(frames[0].close, 4), 'Full-day return %': round(fullDayReturn), 'Last-3 return %': round(lastThreeReturn), 'EMA20 dist %': round(ema20Distance), 'EMA50 dist %': round(ema50Distance), '1m VWAP dist %': round(frames[0].vwapDistancePct), '1m PVT angle': round(frames[0].angle, 2), '5m VWAP dist %': round(frames[1].vwapDistancePct), '5m PVT angle': round(frames[1].angle, 2), '15m VWAP dist %': round(frames[2].vwapDistancePct), '15m PVT angle': round(frames[2].angle, 2) }
}

const symbols = [...new Set(JSON.parse(fs.readFileSync(STOCKS, 'utf8')).map(String).filter(Boolean))]
const hits = symbols.map(scan).filter(Boolean)
console.log(`PVT-EMA255/VWAP MTF scan: ${DATE} before ${TIME} IST | ${symbols.length} stocks checked${BEST_CONFIRMATION ? ' | BEST_CONFIRMATION' : ''}`)
console.table(hits)
console.log(`Qualifying stocks: ${hits.length}`)
