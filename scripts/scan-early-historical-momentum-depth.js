import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'

const ROOT = process.cwd(), IST = 330 * 60_000
const cutoffArg = process.argv[2] || '2026-11-19T09:19:00+05:30'
const cutoffMs = Date.parse(cutoffArg)
if (!Number.isFinite(cutoffMs)) throw new Error('Usage: node scripts/scan-early-historical-momentum-depth.js YYYY-MM-DDTHH:MM:SS+05:30')
const localIso = (ms) => new Date(ms + IST).toISOString().slice(0, 19)
const cutoffLocal = localIso(cutoffMs), date = cutoffLocal.slice(0, 10), cutoffMinute = cutoffLocal.slice(11, 16)
const pct = (a, b) => b ? 100 * (a / b - 1) : NaN
const round = (x, p = 3) => Number.isFinite(x) ? Number(x.toFixed(p)) : null
const universe = JSON.parse(fs.readFileSync(path.join(ROOT, 'db', 'stocks_sector_wise'), 'utf8'))
const symbols = [...new Set(Object.entries(universe).filter(([k]) => k !== '_meta').flatMap(([, v]) => v))].sort()

async function candles(symbol) {
  const file = path.join(ROOT, 'db', 'candles', `${symbol}.jsonl`); if (!fs.existsSync(file)) return []
  const out = [], input = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity })
  for await (const line of input) try {
    const x = JSON.parse(line), z = localIso(Number(x.time) * 1000), day = z.slice(0, 10), minute = z.slice(11, 16)
    if (day < date && minute >= '09:15' && minute <= '15:29' || day === date && minute >= '09:15' && minute < cutoffMinute) out.push({ day, minute, open: +x.open, high: +x.high, low: +x.low, close: +x.close, volume: +x.volume || 0 })
  } catch {}
  return out
}

async function depthBullish(symbol) {
  const file = path.join(ROOT, 'db', 'cash-depth', date, symbol, `${symbol}.jsonl`); if (!fs.existsSync(file)) return false
  const fields = {}, mids = [], input = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity })
  for await (const line of input) try {
    const e = JSON.parse(line), at = Date.parse(e.receivedAt), minute = localIso(at).slice(11, 16)
    if (at >= cutoffMs || minute < '09:15') continue
    if (e.kind === 'checkpoint') for (const k of Object.keys(fields)) delete fields[k]
    Object.assign(fields, e.data || {})
    const bid = +fields.bid_price1, ask = +fields.ask_price1
    if (bid > 0 && ask > bid) mids.push((bid + ask) / 2)
  } catch {}
  if (mids.length < 2) return false
  return mids.at(-1) > mids[0] && mids.slice(1).filter((x, i) => x >= mids[i]).length / (mids.length - 1) >= .55
}

function features(rows, day) {
  const b = rows.filter((x) => x.day === day && x.minute < cutoffMinute)
  if (!b.length) return null
  const volume = b.reduce((s, x) => s + x.volume, 0), vwap = volume ? b.reduce((s, x) => s + ((x.high + x.low + x.close) / 3) * x.volume, 0) / volume : NaN
  const hi = Math.max(...b.map((x) => x.high)), lo = Math.min(...b.map((x) => x.low)), close = b.at(-1).close
  return { bars: b.length, returnPct: pct(close, b[0].open), volume, closeVsVwap: pct(close, vwap), closeLocation: hi > lo ? 100 * (close - lo) / (hi - lo) : 50, rising: b.slice(1).filter((x, i) => x.close > b[i].close).length, greenPct: 100 * b.filter((x) => x.close > x.open).length / b.length }
}

function hasBullishThreeMinuteBos(rows) {
  const buckets = new Map()
  for (const x of rows) {
    const [h, m] = x.minute.split(':').map(Number), offset = h * 60 + m - 555
    const start = 555 + Math.floor(offset / 3) * 3, minute = `${String(Math.floor(start / 60)).padStart(2, '0')}:${String(start % 60).padStart(2, '0')}`, key = `${x.day} ${minute}`
    const b = buckets.get(key)
    if (!b) buckets.set(key, { day: x.day, minute, high: x.high, low: x.low, close: x.close, count: 1 })
    else { b.high = Math.max(b.high, x.high); b.low = Math.min(b.low, x.low); b.close = x.close; b.count++ }
  }
  const bars = [...buckets.values()].filter((x) => x.count === 3).sort((a, b) => `${a.day} ${a.minute}`.localeCompare(`${b.day} ${b.minute}`))
  let level = NaN, pivotIndex = -1, crossed = false, leg = 0, trend = 0
  for (let i = 0; i < bars.length; i++) {
    if (i >= 5) {
      const candidate = bars[i - 5], recent = bars.slice(i - 4, i + 1), high = candidate.high > Math.max(...recent.map((x) => x.high)), low = candidate.low < Math.min(...recent.map((x) => x.low)), next = high ? 0 : low ? 1 : leg
      if (next !== leg) { leg = next; if (next === 0) { level = candidate.high; pivotIndex = i - 5; crossed = false } }
    }
    if (Number.isFinite(level) && !crossed && pivotIndex >= 0 && bars[i].close > level && (i === 0 || bars[i - 1].close <= level)) {
      const tag = trend === -1 ? 'CHoCH' : 'BOS'; crossed = true; trend = 1
      const confirmedAtMinutes = Number(bars[i].minute.slice(0, 2)) * 60 + Number(bars[i].minute.slice(3)) + 3
      const confirmedAt = `${String(Math.floor(confirmedAtMinutes / 60)).padStart(2, '0')}:${String(confirmedAtMinutes % 60).padStart(2, '0')}`
      if (bars[i].day === date && tag === 'BOS' && confirmedAt <= cutoffMinute) return { candle: bars[i].minute, confirmedAt }
    }
  }
  return null
}

const signals = []
for (let i = 0; i < symbols.length; i++) {
  const symbol = symbols[i]
  process.stdout.write(`\rScanning ${i + 1}/${symbols.length} ${symbol}`.padEnd(52))
  const rows = await candles(symbol), days = [...new Set(rows.map((x) => x.day))].sort(), current = features(rows, date)
  const prior = days.filter((x) => x < date).slice(-10).map((x) => features(rows, x)).filter((x) => x && current && x.bars === current.bars)
  if (!current || prior.length < 10 || current.returnPct <= 0) continue
  const returnRank = 1 + prior.filter((x) => x.returnPct > current.returnPct).length, volumeRank = 1 + prior.filter((x) => x.volume > current.volume).length
  const depth = await depthBullish(symbol)
  const bos3m = hasBullishThreeMinuteBos(rows)
  const pass = returnRank <= 1 && current.closeVsVwap > 0 && current.closeLocation >= 65 && current.rising >= 2 && current.greenPct >= 70 && (volumeRank <= 5 || depth) && bos3m
  if (pass) signals.push({ Symbol: symbol, Signal: cutoffMinute, '3m BOS candle': bos3m.candle, '3m BOS confirmed': bos3m.confirmedAt, 'Return rank': returnRank, 'Volume rank': volumeRank, 'Opening return %': round(current.returnPct), 'Above VWAP %': round(current.closeVsVwap), 'Green %': round(current.greenPct, 0), 'Close location %': round(current.closeLocation, 0), 'Bullish depth': depth ? 'YES' : 'NO' })
}
process.stdout.write('\n')
signals.sort((a, b) => b['Opening return %'] - a['Opening return %'] || a.Symbol.localeCompare(b.Symbol))
let n = 1, report
do { report = path.join(ROOT, 'reports', `${date}-${cutoffMinute.replace(':', '')}-early-historical-momentum-depth${n === 1 ? '' : `-${n}`}.json`); n++ } while (fs.existsSync(report))
fs.writeFileSync(report, `${JSON.stringify({ cutoff: cutoffArg, chronology: 'Only completed candles/depth received before cutoff; prior ten completed sessions only.', rules: { bullishThreeMinuteBosConfirmedByCutoff: true, returnRankMax: 1, volumeRankMaxOrBullishDepth: 5, greenPctMin: 70, closeLocationMin: 65, closeAboveVwap: true, risingTransitionsMin: 2 }, signalCount: signals.length, signals }, null, 2)}\n`, { flag: 'wx' })
console.table(signals)
console.log(`Signals: ${signals.length}; report: ${report}`)
