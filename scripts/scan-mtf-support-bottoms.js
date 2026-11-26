#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ROOT = process.cwd()
const CANDLES = path.join(ROOT, 'db', 'candles')
const STOCKS = path.join(ROOT, 'db', 'stocks')
const IST_MS = 330 * 60_000
const arg = name => { const i = process.argv.indexOf(name); return i < 0 ? null : process.argv[i + 1] }
const fromArg = arg('--from'), toArg = arg('--to')
const cutoffArg = arg('--time') ?? '15:30'
if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(cutoffArg)) throw new Error('--time must use HH:MM.')
const [cutoffHour, cutoffMinute] = cutoffArg.split(':').map(Number)
const CUTOFF = cutoffHour * 60 + cutoffMinute
if ((fromArg || toArg) && !(fromArg && toArg)) throw new Error('Use both --from YYYY-MM-DD and --to YYYY-MM-DD.')
if (fromArg && toArg) {
  if (arg('--date')) throw new Error('Use --date or --from/--to, not both.')
  for (let t = Date.parse(`${fromArg}T00:00:00Z`); t <= Date.parse(`${toArg}T00:00:00Z`); t += 86_400_000) {
    const date = new Date(t).toISOString().slice(0, 10)
    const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--date', date, '--time', cutoffArg, '--top', arg('--top') ?? '10'], { stdio: 'inherit' })
    if (child.status) process.exitCode = child.status
  }
  process.exit()
}
const DATE = arg('--date') ?? new Date(Date.now() + IST_MS).toISOString().slice(0, 10)
const TOP = Number(arg('--top') ?? 10)
const round = (x, n = 3) => Number.isFinite(x) ? +x.toFixed(n) : null
const dateAt = seconds => new Date(seconds * 1000 + IST_MS).toISOString().slice(0, 10)
const minuteAt = seconds => { const d = new Date(seconds * 1000 + IST_MS); return d.getUTCHours() * 60 + d.getUTCMinutes() }

function load(symbol) {
  const file = path.join(CANDLES, `${symbol}.jsonl`)
  if (!fs.existsSync(file)) return []
  const out = []
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!line) continue
    try {
      const x = JSON.parse(line), date = dateAt(+x.time)
      if (date > DATE) continue
      const row = { time: +x.time, date, minute: minuteAt(+x.time), open: +x.open, high: +x.high, low: +x.low, close: +x.close, volume: +x.volume }
      if (Object.values(row).slice(3).every(Number.isFinite) && row.low > 0) out.push(row)
    } catch {}
  }
  return out.sort((a, b) => a.time - b.time)
}

function aggregateMinutes(rows, minutes) {
  const groups = new Map()
  for (const r of rows) {
    const bucketMinute = 555 + Math.floor((r.minute - 555) / minutes) * minutes
    const key = `${r.date}|${bucketMinute}`
    let b = groups.get(key)
    if (!b) { b = { time: r.time, date: r.date, minute: bucketMinute, open: r.open, high: r.high, low: r.low, close: r.close, volume: r.volume, count: 1 }; groups.set(key, b) }
    else { b.high = Math.max(b.high, r.high); b.low = Math.min(b.low, r.low); b.close = r.close; b.volume += r.volume; b.count++ }
  }
  return [...groups.values()].filter(x => x.count === minutes).sort((a, b) => a.time - b.time)
}

function aggregateDaily(rows) {
  const groups = new Map()
  for (const r of rows) {
    let b = groups.get(r.date)
    if (!b) { b = { date: r.date, time: r.time, open: r.open, high: r.high, low: r.low, close: r.close, volume: r.volume }; groups.set(r.date, b) }
    else { b.high = Math.max(b.high, r.high); b.low = Math.min(b.low, r.low); b.close = r.close; b.volume += r.volume }
  }
  return [...groups.values()].sort((a, b) => a.date.localeCompare(b.date))
}

function aggregateNDay(days, n) {
  const out = []
  for (let end = days.length; end > 0; end -= n) {
    const start = Math.max(0, end - n), g = days.slice(start, end)
    out.unshift({ date: g.at(-1).date, time: g[0].time, open: g[0].open, high: Math.max(...g.map(x => x.high)), low: Math.min(...g.map(x => x.low)), close: g.at(-1).close, volume: g.reduce((s, x) => s + x.volume, 0) })
  }
  return out
}

function supportMetric(bars, lookback, maxDistance, tolerancePct) {
  const xs = bars.slice(-lookback)
  if (xs.length < Math.min(5, lookback)) return null
  const last = xs.at(-1)
  // Use the lower quartile of recent lows so one isolated spike does not define support.
  const lows = xs.map(x => x.low).sort((a, b) => a - b)
  const support = lows[Math.min(lows.length - 1, Math.floor(lows.length * 0.20))]
  const distance = 100 * (last.close / support - 1)
  const tolerance = support * tolerancePct / 100
  const touches = xs.filter(x => x.low <= support + tolerance && x.close >= support - tolerance).length
  const rejection = last.high > last.low ? (last.close - last.low) / (last.high - last.low) : .5
  const held = xs.slice(-3).every(x => x.close >= support - tolerance)
  const ready = distance >= -tolerancePct && distance <= maxDistance && touches >= 2 && held
  const proximity = Math.max(0, 1 - Math.max(0, distance) / maxDistance)
  const touchScore = Math.min(1, touches / 4)
  const score = 100 * (.55 * proximity + .25 * touchScore + .20 * rejection) * (held ? 1 : .5)
  return { support, distance, touches, rejection, held, ready, score }
}

function pviEma255Angle(allIntraday, sessionDate, minutes, cutoffMinute = CUTOFF) {
  const dates = [...new Set(allIntraday.map(x => x.date))].filter(x => x <= sessionDate).sort()
  const previousDate = dates.filter(x => x < sessionDate).at(-1)
  if (!previousDate) return null
  const source = allIntraday.filter(x => x.date === previousDate || (x.date === sessionDate && x.minute < cutoffMinute))
  const bars = minutes === 1 ? source : aggregateMinutes(source, minutes)
  const currentStart = bars.findIndex(x => x.date === sessionDate)
  if (currentStart < 0 || bars.length - currentStart < 1) return null
  const pvi = Array(bars.length).fill(1000), ema = Array(bars.length)
  ema[0] = pvi[0]
  const alpha = 2 / 256
  for (let i = 1; i < bars.length; i++) {
    const change = bars[i - 1].close ? bars[i].close / bars[i - 1].close - 1 : 0
    pvi[i] = bars[i].volume > bars[i - 1].volume ? pvi[i - 1] * (1 + change) : pvi[i - 1]
    ema[i] = alpha * pvi[i] + (1 - alpha) * ema[i - 1]
  }
  // Measure the complete previous session through today's latest completed bar.
  const startIndex = bars.findIndex(x => x.date === previousDate)
  const endIndex = bars.length - 1
  const steps = Math.max(1, endIndex - startIndex)
  const slopePctPerBar = 100 * (ema[endIndex] / ema[startIndex] - 1) / steps
  // Normalize percentage slope so the angle is independent of the PVI's absolute scale.
  const angle = Math.atan(slopePctPerBar * 100) * 180 / Math.PI
  return { angle, score: Math.max(0, Math.min(100, angle / 45 * 100)) }
}

const dailyCache = new Map()
function analyze(symbol, cutoffMinute = CUTOFF, allRows = null) {
  const all = allRows ?? load(symbol), intraday = all.filter(x => x.minute >= 555 && x.minute < 930), session = intraday.filter(x => x.date === DATE && x.minute < cutoffMinute)
  if (!session.length) return null
  let days = dailyCache.get(symbol)
  if (!days) { days = aggregateDaily(all); dailyCache.set(symbol, days) }
  const causalIntraday = intraday.filter(x => x.date < DATE || (x.date === DATE && x.minute < cutoffMinute))
  const recentIntraday = causalIntraday.slice(-300)
  const frames = {
    '1m': supportMetric(recentIntraday, 60, .80, .18),
    '5m': supportMetric(aggregateMinutes(recentIntraday, 5), 36, 1.20, .30),
    '15m': supportMetric(aggregateMinutes(recentIntraday, 15), 20, 1.80, .45),
    '1d': supportMetric(days, 20, 3.00, .70),
    '3d': supportMetric(aggregateNDay(days, 3), 12, 4.00, 1.00),
    '1w': supportMetric(aggregateNDay(days, 5), 10, 5.00, 1.30),
  }
  if (Object.values(frames).some(x => !x)) return null
  const readyCount = Object.values(frames).filter(x => x.ready).length
  const score = Object.values(frames).reduce((s, x) => s + x.score, 0) / 6
  const current = session.at(-1).close
  const pviAngles = {
    '1m': pviEma255Angle(intraday, DATE, 1, cutoffMinute),
    '5m': pviEma255Angle(intraday, DATE, 5, cutoffMinute),
    '15m': pviEma255Angle(intraday, DATE, 15, cutoffMinute),
  }
  const pviValues = Object.values(pviAngles).filter(Boolean)
  const pviScore = pviValues.length ? pviValues.reduce((s, x) => s + x.score, 0) / pviValues.length : 0
  return { symbol, current, readyCount, score, pviAngles, pviScore, frames }
}

const requestedSymbols = arg('--symbols')
const symbols = requestedSymbols
  ? requestedSymbols.split(',').map(x => x.trim().replace(/^NSE:/, '').replace(/-EQ$/, '')).filter(Boolean)
  : JSON.parse(fs.readFileSync(STOCKS, 'utf8')).map(String)
const parseMinute = value => { const [h, m] = value.split(':').map(Number); return h * 60 + m }
const minuteClock = value => `${String(Math.floor(value / 60)).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}`
const allRows = new Map(symbols.map(symbol => [symbol, load(symbol)]))
if (process.argv.includes('--minute-by-minute')) {
  const fromTime = arg('--from-time') ?? '09:16', toTime = arg('--to-time') ?? cutoffArg
  const fromMinute = parseMinute(fromTime), toMinute = parseMinute(toTime)
  if (fromMinute >= toMinute) throw new Error('--from-time must be before --to-time.')
  const firstHit = new Map()
  for (let cutoff = fromMinute; cutoff <= toMinute; cutoff++) {
    for (const symbol of symbols) {
      if (firstHit.has(symbol)) continue
      const row = analyze(symbol, cutoff, allRows.get(symbol))
      if (row && row.readyCount === 6 && row.score > 65 && row.pviScore > 65) firstHit.set(symbol, { time: minuteClock(cutoff), ...row })
    }
  }
  const hits = [...firstHit.values()].sort((a, b) => a.time.localeCompare(b.time) || b.score - a.score)
  console.log(`Minute-by-minute scan: ${DATE}, completed candles before each cutoff ${fromTime}–${toTime} IST | support >65 | PVI >65 | alignment 6/6`)
  console.table(hits.map(x => ({ Time: x.time, Stock: x.symbol, Price: round(x.current, 2), 'Support score': round(x.score, 1), 'PVI score': round(x.pviScore, 1), 'Aligned TF': `${x.readyCount}/6` })))
  console.log(`Qualifying stocks: ${hits.length}`)
  process.exit(0)
}
const rows = symbols.map(symbol => analyze(symbol, CUTOFF, allRows.get(symbol))).filter(Boolean).sort((a, b) => b.readyCount - a.readyCount || b.score - a.score).slice(0, TOP)
console.log(`Top ${TOP} multi-timeframe support-bottom stocks`)
console.table(rows.map(x => ({
  Stock: x.symbol, Price: round(x.current, 2), 'Aligned TF': `${x.readyCount}/6`, Score: round(x.score, 1),
  'PVI score': round(x.pviScore, 1), 'PVI 1m angle': round(x.pviAngles['1m']?.angle ?? 0, 1), 'PVI 5m angle': round(x.pviAngles['5m']?.angle ?? 0, 1), 'PVI 15m angle': round(x.pviAngles['15m']?.angle ?? 0, 1),
  '1m dist %': round(x.frames['1m'].distance, 2), '5m dist %': round(x.frames['5m'].distance, 2), '15m dist %': round(x.frames['15m'].distance, 2),
  '1d dist %': round(x.frames['1d'].distance, 2), '3d dist %': round(x.frames['3d'].distance, 2), '1w dist %': round(x.frames['1w'].distance, 2),
})))
const fullyAligned = rows.filter(x => x.readyCount === 6).length
console.log(`Date ${DATE}; completed candles before ${cutoffArg} IST used. Fully aligned among displayed: ${fullyAligned}/${rows.length}. Distances are close above robust support; lower is nearer support.`)

if (!requestedSymbols || !symbols.includes('NIFTY50')) {
  const nifty = analyze('NIFTY50')
  console.log('\nNIFTY50 support context')
  if (!nifty) console.log('NIFTY50: insufficient candle history for the requested date.')
  else console.table([{
    Stock: nifty.symbol, Price: round(nifty.current, 2), 'Aligned TF': `${nifty.readyCount}/6`, Score: round(nifty.score, 1),
    'PVI score': round(nifty.pviScore, 1), 'PVI 1m angle': round(nifty.pviAngles['1m']?.angle ?? 0, 1), 'PVI 5m angle': round(nifty.pviAngles['5m']?.angle ?? 0, 1), 'PVI 15m angle': round(nifty.pviAngles['15m']?.angle ?? 0, 1),
    '1m dist %': round(nifty.frames['1m'].distance, 2), '5m dist %': round(nifty.frames['5m'].distance, 2), '15m dist %': round(nifty.frames['15m'].distance, 2),
    '1d dist %': round(nifty.frames['1d'].distance, 2), '3d dist %': round(nifty.frames['3d'].distance, 2), '1w dist %': round(nifty.frames['1w'].distance, 2),
  }])
}
