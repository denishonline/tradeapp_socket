import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const value = (name, fallback) => {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : fallback
}
const positionalDate = args.find((arg) => /^\d{4}-\d{2}-\d{2}$/.test(arg))
const date = value('--date', positionalDate || '2026-11-04')
const windowSize = Number(value('--window', '10'))
const startClock = value('--from-time', '09:15')
const endClock = value('--to-time', '15:30')
const side = String(value('--side', 'BOTH')).toUpperCase()
if (!['BUY', 'SELL', 'BOTH'].includes(side)) throw new Error('--side must be BUY, SELL, or BOTH')
const requestedSymbol = value('--symbol', '').toUpperCase().replace(/-EQ$/, '')
const thresholds = {
  pvi: Number(value('--pvi-min', '10')),
  nvi: Number(value('--nvi-min', '60')),
  rsi: Number(value('--rsi-min', '60')),
  pvt: Number(value('--pvt-min', '60')),
  ema20: Number(value('--ema20-max', '20')),
  signalReturn: Number(value('--signal-return-limit', '0.5')),
}

const epoch = (clock) => Date.parse(`${date}T${clock}:00+05:30`) / 1000
const start = epoch(startClock)
const end = epoch(endClock)
const sessionStart = epoch('09:15')
const pct = (endValue, startValue) => startValue ? 100 * (endValue / startValue - 1) : 0
const round = (number, digits = 2) => Number(number.toFixed(digits))
const clock = (unix) => new Date(unix * 1000).toLocaleTimeString('en-IN', {
  timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false,
})

function indicators(candles) {
  const alpha = 2 / 21
  const pvi = Array(candles.length).fill(1000)
  const nvi = Array(candles.length).fill(1000)
  const pvt = Array(candles.length).fill(0)
  const ema20 = Array(candles.length)
  const rsi = Array(candles.length).fill(null)
  ema20[0] = candles[0].close
  let averageGain = 0
  let averageLoss = 0

  for (let index = 1; index < candles.length; index++) {
    const current = candles[index]
    const previous = candles[index - 1]
    const priceChange = current.close / previous.close - 1
    pvi[index] = current.volume > previous.volume ? pvi[index - 1] * (1 + priceChange) : pvi[index - 1]
    nvi[index] = current.volume < previous.volume ? nvi[index - 1] * (1 + priceChange) : nvi[index - 1]
    pvt[index] = pvt[index - 1] + current.volume * priceChange
    ema20[index] = alpha * current.close + (1 - alpha) * ema20[index - 1]
    const change = current.close - previous.close
    const gain = Math.max(change, 0)
    const loss = Math.max(-change, 0)
    if (index <= 14) {
      averageGain += gain
      averageLoss += loss
      if (index === 14) {
        averageGain /= 14
        averageLoss /= 14
        rsi[index] = averageLoss === 0 ? 100 : 100 - 100 / (1 + averageGain / averageLoss)
      }
    } else {
      averageGain = (averageGain * 13 + gain) / 14
      averageLoss = (averageLoss * 13 + loss) / 14
      rsi[index] = averageLoss === 0 ? 100 : 100 - 100 / (1 + averageGain / averageLoss)
    }
  }
  return { pvi, nvi, pvt, ema20, rsi }
}

function increasingPercent(values, first, last) {
  let increases = 0
  let comparisons = 0
  for (let index = first + 1; index <= last; index++) {
    if (!Number.isFinite(values[index]) || !Number.isFinite(values[index - 1])) continue
    comparisons++
    if (values[index] > values[index - 1]) increases++
  }
  return comparisons ? 100 * increases / comparisons : 0
}

function decreasingPercent(values, first, last) {
  let decreases = 0
  let comparisons = 0
  for (let index = first + 1; index <= last; index++) {
    if (!Number.isFinite(values[index]) || !Number.isFinite(values[index - 1])) continue
    comparisons++
    if (values[index] < values[index - 1]) decreases++
  }
  return comparisons ? 100 * decreases / comparisons : 0
}

const candleDirectory = path.join(root, 'db', 'candles')
const signals = []
for (const file of fs.readdirSync(candleDirectory).filter((name) => name.endsWith('.jsonl') && name !== 'NIFTY50.jsonl' && (!requestedSymbol || name === `${requestedSymbol}.jsonl`))) {
  const candles = fs.readFileSync(path.join(candleDirectory, file), 'utf8').trim().split(/\r?\n/).map(JSON.parse)
  const sessionOpenIndex = candles.findIndex((candle) => candle.time >= sessionStart)
  if (sessionOpenIndex < 0 || candles[sessionOpenIndex].time > end) continue
  const sessionOpen = candles[sessionOpenIndex].open
  const previousClose = candles[sessionOpenIndex - 1]?.close ?? sessionOpen
  const firstToday = candles.findIndex((candle) => candle.time >= start)
  if (firstToday < 20) continue
  const lastToday = candles.findLastIndex((candle) => candle.time <= end)
  if (lastToday < firstToday + windowSize - 1) continue
  const metrics = indicators(candles)

  const foundSides = new Set()
  for (let last = firstToday + windowSize - 1; last <= lastToday; last++) {
    const first = last - windowSize + 1
    if (candles[first].time < start || candles[last].time > end) continue
    if (candles[last].time - candles[first].time !== (windowSize - 1) * 60) continue
    const pviUp = increasingPercent(metrics.pvi, first, last)
    const nviUp = increasingPercent(metrics.nvi, first, last)
    const rsiUp = increasingPercent(metrics.rsi, first, last)
    const pvtUp = increasingPercent(metrics.pvt, first, last)
    const ema20Change = pct(metrics.ema20[last], metrics.ema20[first])
    const signalReturn = pct(candles[last].close, previousClose)
    const intradayReturn = pct(candles[last].close, sessionOpen)
    const pviDown = decreasingPercent(metrics.pvi, first, last)
    const nviDown = decreasingPercent(metrics.nvi, first, last)
    const rsiDown = decreasingPercent(metrics.rsi, first, last)
    const pvtDown = decreasingPercent(metrics.pvt, first, last)
    const buyPass = pviUp > thresholds.pvi && nviUp > thresholds.nvi && rsiUp > thresholds.rsi && pvtUp > thresholds.pvt && ema20Change < thresholds.ema20 && signalReturn < thresholds.signalReturn
    const sellPass = pviDown > thresholds.pvi && nviDown > thresholds.nvi && rsiDown > thresholds.rsi && pvtDown > thresholds.pvt && ema20Change > -thresholds.ema20 && signalReturn > -thresholds.signalReturn
    for (const signalSide of ['BUY', 'SELL']) {
      if (foundSides.has(signalSide) || (side !== 'BOTH' && side !== signalSide)) continue
      if ((signalSide === 'BUY' && !buyPass) || (signalSide === 'SELL' && !sellPass)) continue
      signals.push({
        Date: date,
        Stock: file.replace('.jsonl', ''),
        Side: signalSide,
        Window: `${clock(candles[first].time)}-${clock(candles[last].time)}`,
        'Signal time': clock(candles[last].time),
        'PVI direction %': round(signalSide === 'BUY' ? pviUp : pviDown),
        'NVI direction %': round(signalSide === 'BUY' ? nviUp : nviDown),
        'RSI direction %': round(signalSide === 'BUY' ? rsiUp : rsiDown),
        'PVT direction %': round(signalSide === 'BUY' ? pvtUp : pvtDown),
        'EMA20 change %': round(ema20Change, 4),
        'Gap-inclusive return %': round(signalReturn, 4),
        'Intraday return %': round(intradayReturn, 4),
      })
      foundSides.add(signalSide)
    }
    if ((side === 'BOTH' && foundSides.size === 2) || (side !== 'BOTH' && foundSides.has(side))) break
  }
}

signals.sort((a, b) => a['Signal time'].localeCompare(b['Signal time']) || a.Stock.localeCompare(b.Stock))
console.log(`Rolling ${windowSize}-candle ${side} signals for ${date} (${startClock}-${endClock} IST)`)
console.log(`BUY: PVI/NVI/RSI/PVT increasing > thresholds, EMA20 change <${thresholds.ema20}%, gap-inclusive previous-close-to-signal return <${thresholds.signalReturn}%. SELL: decreasing > thresholds, EMA20 change >-${thresholds.ema20}%, gap-inclusive return >-${thresholds.signalReturn}%.`)
console.table(signals)
console.log(`Total signals: ${signals.length}`)
