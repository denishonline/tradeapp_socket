import fs from 'node:fs'
import path from 'node:path'
import apiV3 from 'fyers-api-v3'
import { CONSTANT } from '../constant.js'
import { getFromStorage } from '../utils.js'

const symbol = String(process.argv[2] ?? 'BAJAJ-AUTO').replace(/[\\\s]+/g, '').replace(/^NSE:/i, '').replace(/-EQ$/i, '')
const targetDate = process.argv[3] ?? new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date())
const jsonOutput = process.argv.includes('--json')
const option = (name, fallback) => { const index = process.argv.indexOf(name); return index >= 0 ? process.argv[index + 1] ?? fallback : fallback }
const orderBlockFilter = String(option('--ob-filter', 'none')).toLowerCase()
const refreshFyers = process.argv.includes('--refresh-fyers')
const cutoff = option('--cutoff', '15:30')
const timeframe = Number(option('--tf', '5'))
const includeOpeningOrigin = process.argv.includes('--include-opening-origin')
const activeOnly = process.argv.includes('--active-only')
const includeEarlyCandidates = process.argv.includes('--early-candidates')
const requestedSide = String(option('--side', 'all')).toLowerCase()
if (!['none', 'atr', 'range'].includes(orderBlockFilter)) throw new Error('--ob-filter must be none, atr, or range')
if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(cutoff)) throw new Error('--cutoff must use HH:MM')
if (!['all', 'buy', 'sell'].includes(requestedSide)) throw new Error('--side must be all, buy, or sell')
if (!Number.isInteger(timeframe) || timeframe < 1 || timeframe > 60) throw new Error('--tf must be an integer from 1 to 60')
const root = process.cwd()
const local = epoch => new Date(epoch * 1000 + 330 * 60_000).toISOString().slice(0, 16).replace('T', ' ')

const unique = new Map()
const candleFile = path.join(root, 'db', 'candles', `${symbol}.jsonl`)
const sourceCandles = (fs.existsSync(candleFile) ? fs.readFileSync(candleFile, 'utf8') : '').split(/\r?\n/).flatMap(line => {
  if (!line.trim()) return []
  try { return [JSON.parse(line)] } catch { return [] }
})
if (refreshFyers) {
  const token = String(getFromStorage('token') || '').trim()
  if (!token) throw new Error('FYERS token unavailable. Run AutoLogin first.')
  const client = new apiV3.fyersModel({ enableLogging: false })
  client.setAppId(CONSTANT.appId)
  client.setAccessToken(token)
  const response = await client.getHistory({ symbol: `NSE:${symbol}-EQ`, resolution: '1', date_format: '1', range_from: targetDate, range_to: targetDate, cont_flag: '1' })
  if (response?.s !== 'ok' || !Array.isArray(response.candles)) throw new Error(response?.message || 'FYERS history unavailable')
  sourceCandles.push(...response.candles.map(row => ({ time: +row[0], open: +row[1], high: +row[2], low: +row[3], close: +row[4], volume: +row[5] })))
}
for (const x of sourceCandles) {
  const stamp = local(+x.time), date = stamp.slice(0, 10), minute = stamp.slice(11)
  if (date > targetDate || minute < '09:15' || minute > '15:29' || (date === targetDate && minute >= cutoff)) continue
  unique.set(stamp, { stamp, date, minute, open: +x.open, high: +x.high, low: +x.low, close: +x.close, volume: +x.volume })
}
const one = [...unique.values()].sort((a, b) => a.stamp.localeCompare(b.stamp))
const buckets = new Map()
for (const x of one) {
  const [h, m] = x.minute.split(':').map(Number)
  const offset = (h * 60 + m) - (9 * 60 + 15)
  const startMinutes = 9 * 60 + 15 + Math.floor(offset / timeframe) * timeframe
  const bucketMinute = `${String(Math.floor(startMinutes / 60)).padStart(2, '0')}:${String(startMinutes % 60).padStart(2, '0')}`
  const key = `${x.date} ${bucketMinute}`
  const b = buckets.get(key)
  if (!b) buckets.set(key, { stamp: key, date: x.date, minute: bucketMinute, open: x.open, high: x.high, low: x.low, close: x.close, volume: x.volume, count: 1 })
  else { b.high = Math.max(b.high, x.high); b.low = Math.min(b.low, x.low); b.close = x.close; b.volume += x.volume; b.count++ }
}
const bars = [...buckets.values()].filter(x => x.count === timeframe).sort((a, b) => a.stamp.localeCompare(b.stamp))

// Pine ta.atr(200): true range followed by Wilder RMA seeded with the first 200 values.
const trs = bars.map((x, i) => i === 0 ? x.high - x.low : Math.max(x.high - x.low, Math.abs(x.high - bars[i - 1].close), Math.abs(x.low - bars[i - 1].close)))
const atr = Array(bars.length).fill(NaN)
if (bars.length >= 200) {
  atr[199] = trs.slice(0, 200).reduce((a, b) => a + b, 0) / 200
  for (let i = 200; i < bars.length; i++) atr[i] = (atr[i - 1] * 199 + trs[i]) / 200
}
let cumulativeTrueRange = 0
const cumulativeMeanRange = trs.map((value, index) => { cumulativeTrueRange += value; return index ? cumulativeTrueRange / index : NaN })
const volatility = orderBlockFilter === 'atr' ? atr : orderBlockFilter === 'range' ? cumulativeMeanRange : Array(bars.length).fill(NaN)
const parsedHighs = bars.map((x, i) => Number.isFinite(volatility[i]) && x.high - x.low >= 2 * volatility[i] ? x.low : x.high)
const parsedLows = bars.map((x, i) => Number.isFinite(volatility[i]) && x.high - x.low >= 2 * volatility[i] ? x.high : x.low)

const makePivot = () => ({ level: NaN, previousLevel: NaN, crossed: false, index: -1 })
const swingHigh = makePivot(), swingLow = makePivot(), internalHigh = makePivot(), internalLow = makePivot()
let swingLeg = 0, internalLeg = 0, internalTrend = 0
const active = [], events = [], earlyCandidates = []

function updateStructure(i, size, internal) {
  if (i < size) return
  const candidate = bars[i - size]
  const recent = bars.slice(i - size + 1, i + 1)
  const newLegHigh = candidate.high > Math.max(...recent.map(x => x.high))
  const newLegLow = candidate.low < Math.min(...recent.map(x => x.low))
  const oldLeg = internal ? internalLeg : swingLeg
  let nextLeg = oldLeg
  if (newLegHigh) nextLeg = 0
  else if (newLegLow) nextLeg = 1
  if (internal) internalLeg = nextLeg; else swingLeg = nextLeg
  if (nextLeg === oldLeg) return
  const pivot = nextLeg - oldLeg === 1 ? (internal ? internalLow : swingLow) : (internal ? internalHigh : swingHigh)
  pivot.previousLevel = pivot.level
  pivot.level = nextLeg - oldLeg === 1 ? candidate.low : candidate.high
  pivot.crossed = false
  pivot.index = i - size
}

function createBlock(i, pivot, bias, tag) {
  const from = pivot.index, to = i
  if (from < 0 || to <= from) return
  // FYERS-calibrated rule: the 09:15 auction/opening-range candle is not an
  // internal order-block origin. Its gap/range otherwise hides the first
  // actionable intraday block (notably POLICYBZR on 2026-11-16).
  const candidates = []
  for (let j = from; j < to; j++) {
    if (includeOpeningOrigin || bars[j].minute !== '09:15') candidates.push(j)
  }
  if (!candidates.length) return
  let origin = candidates[0]
  if (bias === -1) {
    for (const j of candidates.slice(1)) if (parsedHighs[j] > parsedHighs[origin]) origin = j
  } else {
    for (const j of candidates.slice(1)) if (parsedLows[j] < parsedLows[origin]) origin = j
  }
  const block = { bias, high: parsedHighs[origin], low: parsedLows[origin], origin, confirmation: i, tag, invalidatedAt: null }
  active.unshift(block)
  if (active.length > 100) active.pop()
  events.push(block)
}

for (let i = 0; i < bars.length; i++) {
  const oldInternalHigh = internalHigh.level, oldInternalLow = internalLow.level
  updateStructure(i, 50, false)
  updateStructure(i, 5, true)
  const previousClose = i ? bars[i - 1].close : NaN
  if (Number.isFinite(internalHigh.level) && bars[i].close > internalHigh.level && previousClose <= oldInternalHigh && !internalHigh.crossed && internalHigh.level !== swingHigh.level) {
    const tag = internalTrend === -1 ? 'CHoCH' : 'BOS'
    internalHigh.crossed = true
    internalTrend = 1
    createBlock(i, internalHigh, 1, tag)
  }
  if (Number.isFinite(internalLow.level) && bars[i].close < internalLow.level && previousClose >= oldInternalLow && !internalLow.crossed && internalLow.level !== swingLow.level) {
    const tag = internalTrend === 1 ? 'CHoCH' : 'BOS'
    internalLow.crossed = true
    internalTrend = -1
    createBlock(i, internalLow, -1, tag)
  }
  // Causal warning only: local-high bearish rejection using information known
  // at this candle close. It is not an SMC confirmation and may fail/repaint.
  if (includeEarlyCandidates && i >= 20 && bars[i].minute !== '09:15') {
    const range = bars[i].high - bars[i].low || 1
    const priorRanges = bars.slice(i - 20, i).map(bar => bar.high - bar.low).sort((a, b) => a - b)
    const medianRange = priorRanges[Math.floor(priorRanges.length / 2)] || range
    const localHigh = bars[i].high >= Math.max(...bars.slice(i - 3, i).map(bar => bar.high))
    const localLow = bars[i].low <= Math.min(...bars.slice(i - 3, i).map(bar => bar.low))
    const bearishRejection = bars[i].close < bars[i].open
      && Math.abs(bars[i].close - bars[i].open) / range >= 0.45
      && (bars[i].close - bars[i].low) / range <= 0.35
      && range / medianRange >= 0.8
    const bullishRejection = bars[i].close > bars[i].open
      && Math.abs(bars[i].close - bars[i].open) / range >= 0.45
      && (bars[i].close - bars[i].low) / range >= 0.65
      && range / medianRange >= 0.8
    if (localHigh && bearishRejection) earlyCandidates.push({ bias: -1, origin: i, signal: i })
    if (localLow && bullishRejection) earlyCandidates.push({ bias: 1, origin: i, signal: i })
  }
  for (let j = active.length - 1; j >= 0; j--) {
    const ob = active[j]
    if ((ob.bias === -1 && bars[i].high > ob.high) || (ob.bias === 1 && bars[i].low < ob.low)) {
      ob.invalidatedAt = i
      active.splice(j, 1)
    }
  }
}

const endStamp = index => {
  const date = new Date(`${bars[index].date}T${bars[index].minute}:00+05:30`)
  date.setMinutes(date.getMinutes() + timeframe)
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  }).format(date).replace(',', '')
}
const today = events.filter(x => bars[x.confirmation].date === targetDate)
const confirmedResult = today.map(x => ({
  Symbol: symbol,
  Status: 'CONFIRMED',
  Side: x.bias === 1 ? 'Bullish' : 'Bearish',
  Structure: x.tag,
  'Origin candle': bars[x.origin].stamp,
  'Zone low': x.low,
  'Zone high': x.high,
  'Confirmation candle': bars[x.confirmation].stamp,
  'Confirmed at': endStamp(x.confirmation),
  'Invalidated at': x.invalidatedAt === null ? null : bars[x.invalidatedAt].stamp,
  'Active at end': x.invalidatedAt === null
}))
const candidateResult = includeEarlyCandidates ? earlyCandidates.filter(x => bars[x.origin].date === targetDate).map(x => ({
  Symbol: symbol,
  Status: 'EARLY_CANDIDATE',
  Side: x.bias === 1 ? 'Bullish' : 'Bearish',
  Structure: 'Rejection warning',
  'Origin candle': bars[x.origin].stamp,
  'Zone low': bars[x.origin].low,
  'Zone high': bars[x.origin].high,
  'Confirmation candle': null,
  'Confirmed at': endStamp(x.signal),
  'Invalidated at': null,
  'Active at end': true
})) : []
const result = [...confirmedResult, ...candidateResult]
  .sort((a, b) => a['Confirmed at'].localeCompare(b['Confirmed at']) || a.Status.localeCompare(b.Status))
  .filter(x => requestedSide === 'all' || (requestedSide === 'buy' ? x.Side === 'Bullish' : x.Side === 'Bearish'))
  .filter(x => !activeOnly || x['Active at end'])
const displayed = activeOnly ? result.slice(-10) : result
if (jsonOutput) console.log(JSON.stringify(result))
else {
  console.log(`${symbol} | ${timeframe}-minute | ${targetDate} through ${cutoff} IST | FYERS-calibrated SMC internal order blocks | display count 10 | filter ${orderBlockFilter}`)
  if (displayed.length) console.table(displayed)
  else console.log(includeEarlyCandidates ? 'No confirmed block or early candidate was found.' : 'No internal order block was confirmed on this session.')
}
