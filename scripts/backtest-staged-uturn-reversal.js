import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const candleDirectory = path.join(root, 'db', 'candles')
const args = process.argv.slice(2)
const arg = (name, fallback) => {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : fallback
}
const fail = (message) => {
  console.error(message)
  process.exit(1)
}

const dateArg = arg('--date')
const fromArg = arg('--from')
const toArg = arg('--to')
const cutoffTime = arg('--time', '09:40')
const exitTime = arg('--exit-time', '15:29')
const validDate = (value) => /^\d{4}-\d{2}-\d{2}$/.test(value || '')
const validTime = (value) => /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value || '')

if (dateArg && (fromArg || toArg)) fail('Use --date or --from/--to, not both.')
if (!dateArg && (!fromArg || !toArg)) {
  fail('Usage: node scripts/backtest-staged-uturn-reversal.js --date YYYY-MM-DD [--time HH:MM]\n   or: node scripts/backtest-staged-uturn-reversal.js --from YYYY-MM-DD --to YYYY-MM-DD [--time HH:MM]')
}
const from = dateArg || fromArg
const to = dateArg || toArg
if (!validDate(from) || !validDate(to) || from > to) fail('Invalid date or date range.')
if (!validTime(cutoffTime) || !validTime(exitTime)) fail('--time and --exit-time must use HH:MM.')
if (cutoffTime <= '09:24') fail('--time must be later than 09:24.')

const thresholds = Object.freeze({
  pviIncreasing: 10,
  nviIncreasing: 30,
  rsiIncreasing: 60,
  pvtIncreasing: 60,
  ema20Change: 20,
  gapReturn0916: -0.5,
  uTurnAngle: 40,
  shallowGapUturnAngle: 34,
  shallowGapFloor: -1.0,
  closeVsVwap: 0.20,
  closeVsEma20Minimum: -0.05,
  rsi14Minimum: 47,
  deepGapReturn: -1.4,
  minimumRecovery: 30,
  recoveryHigherHighs: 1,
  recoveryHigherLows: 1,
  recoveryVwapFloor: -0.10,
  recoveryEma20Floor: -0.55,
  recoveryRsiFloor: 30,
  stopLoss: 0.80,
})

const epoch = (date, clock) => Date.parse(`${date}T${clock}:00+05:30`) / 1000
const pct = (endValue, startValue) => startValue ? 100 * (endValue / startValue - 1) : 0
const round = (value, digits = 2) => Number(value.toFixed(digits))
const clock = (unix) => new Date(unix * 1000).toLocaleTimeString('en-IN', {
  timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false,
})
const istDate = (unix) => new Date(unix * 1000).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' })
const enumerateDates = (start, finish) => {
  const dates = []
  for (let value = Date.parse(`${start}T00:00:00Z`); value <= Date.parse(`${finish}T00:00:00Z`); value += 86_400_000) {
    dates.push(new Date(value).toISOString().slice(0, 10))
  }
  return dates
}
const exactIndex = (candles, unix) => {
  let low = 0
  let high = candles.length - 1
  while (low <= high) {
    const middle = (low + high) >> 1
    if (candles[middle].time === unix) return middle
    if (candles[middle].time < unix) low = middle + 1
    else high = middle - 1
  }
  return -1
}

function indicators(candles) {
  const pvi = Array(candles.length).fill(1000)
  const nvi = Array(candles.length).fill(1000)
  const pvt = Array(candles.length).fill(0)
  const ema20 = Array(candles.length)
  const ema200 = Array(candles.length)
  const rsi = Array(candles.length).fill(null)
  let value20 = candles[0].close
  let value200 = candles[0].close
  let averageGain = 0
  let averageLoss = 0
  ema20[0] = value20
  ema200[0] = value200

  for (let index = 1; index < candles.length; index++) {
    const current = candles[index]
    const previous = candles[index - 1]
    const priceChange = current.close / previous.close - 1
    pvi[index] = current.volume > previous.volume ? pvi[index - 1] * (1 + priceChange) : pvi[index - 1]
    nvi[index] = current.volume < previous.volume ? nvi[index - 1] * (1 + priceChange) : nvi[index - 1]
    pvt[index] = pvt[index - 1] + current.volume * priceChange
    value20 = (2 / 21) * current.close + (19 / 21) * value20
    value200 = (2 / 201) * current.close + (199 / 201) * value200
    ema20[index] = value20
    ema200[index] = value200

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
  return { pvi, nvi, pvt, ema20, ema200, rsi }
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

function previousSession(candles, sessionIndex, date) {
  if (sessionIndex < 1) return null
  const previousDate = istDate(candles[sessionIndex - 1].time)
  if (previousDate >= date) return null
  return { date: previousDate, last: sessionIndex - 1, close: candles[sessionIndex - 1].close }
}

function stepOneSignal(candles, metrics, date, sessionIndex, previousClose) {
  const firstAllowed = epoch(date, '09:24')
  const cutoff = epoch(date, cutoffTime)
  const gap0916 = candles.find((candle) => candle.time === epoch(date, '09:16'))
  if (!gap0916 || !(pct(gap0916.close, previousClose) < thresholds.gapReturn0916)) return null

  for (let last = sessionIndex + 9; last < candles.length; last++) {
    const signalTime = candles[last].time
    if (signalTime < firstAllowed) continue
    if (signalTime >= cutoff) break
    const first = last - 9
    if (candles[last].time - candles[first].time !== 9 * 60) continue
    const pviIncreasing = increasingPercent(metrics.pvi, first, last)
    const nviIncreasing = increasingPercent(metrics.nvi, first, last)
    const rsiIncreasing = increasingPercent(metrics.rsi, first, last)
    const pvtIncreasing = increasingPercent(metrics.pvt, first, last)
    const ema20Change = pct(metrics.ema20[last], metrics.ema20[first])
    if (!(pviIncreasing > thresholds.pviIncreasing && nviIncreasing > thresholds.nviIncreasing &&
      rsiIncreasing > thresholds.rsiIncreasing && pvtIncreasing > thresholds.pvtIncreasing &&
      ema20Change < thresholds.ema20Change)) continue

    const sessionCandles = candles.slice(sessionIndex, last + 1)
    let lowIndex = 0
    for (let index = 1; index < sessionCandles.length; index++) {
      if (sessionCandles[index].low < sessionCandles[lowIndex].low) lowIndex = index
    }
    const dropPct = pct(sessionCandles[lowIndex].low, previousClose)
    const recoveryPctMove = pct(candles[last].close, sessionCandles[lowIndex].low)
    const declineAngle = Math.atan(dropPct / (lowIndex + 1)) * 180 / Math.PI
    const recoverySteps = sessionCandles.length - 1 - lowIndex
    const recoveryAngle = Math.atan(recoveryPctMove / (recoverySteps || 1)) * 180 / Math.PI
    const uTurnAngle = recoveryAngle - declineAngle
    const standardUTurn = uTurnAngle > thresholds.uTurnAngle
    const shallowGapUTurn = pct(gap0916.close, previousClose) > thresholds.shallowGapFloor &&
      uTurnAngle > thresholds.shallowGapUturnAngle
    if (!(standardUTurn || shallowGapUTurn)) continue

    return {
      first, last, lowIndex, sessionCandles, pviIncreasing, nviIncreasing, rsiIncreasing,
      pvtIncreasing, ema20Change, dropPct, recoveryPctMove, uTurnAngle,
      gapReturn0916: pct(gap0916.close, previousClose),
    }
  }
  return null
}

function stepTwo(candles, metrics, signal) {
  const { last, sessionCandles } = signal
  let cumulativeVolume = 0
  let vwapNumerator = 0
  for (const candle of sessionCandles) {
    cumulativeVolume += candle.volume
    vwapNumerator += ((candle.high + candle.low + candle.close) / 3) * candle.volume
  }
  const vwap = vwapNumerator / (cumulativeVolume || 1)
  const vwapDistance = pct(candles[last].close, vwap)
  const lastFive = sessionCandles.slice(-5)
  let higherHighCount = 0
  let higherLowCount = 0
  for (let index = 1; index < lastFive.length; index++) {
    if (lastFive[index].high > lastFive[index - 1].high) higherHighCount++
    if (lastFive[index].low > lastFive[index - 1].low) higherLowCount++
  }
  const ema20Distance = pct(candles[last].close, metrics.ema20[last])
  const rsi14 = metrics.rsi[last]
  const recoveryPct = 100 * signal.recoveryPctMove / Math.abs(signal.dropPct || 1)
  const strongConfirmation = vwapDistance > thresholds.closeVsVwap &&
    ema20Distance >= thresholds.closeVsEma20Minimum && rsi14 > thresholds.rsi14Minimum
  const recoveryStructure = signal.gapReturn0916 <= thresholds.deepGapReturn &&
    recoveryPct >= thresholds.minimumRecovery &&
    higherHighCount >= thresholds.recoveryHigherHighs &&
    higherLowCount >= thresholds.recoveryHigherLows &&
    vwapDistance >= thresholds.recoveryVwapFloor &&
    ema20Distance >= thresholds.recoveryEma20Floor &&
    rsi14 >= thresholds.recoveryRsiFloor
  return {
    passed: strongConfirmation || recoveryStructure,
    confirmation: strongConfirmation ? 'VWAP_EMA20_RSI' : 'EARLY_DEEP_GAP_RECOVERY',
    vwap, vwapDistance, ema20Distance, rsi14, recoveryPct, higherHighCount, higherLowCount,
  }
}

function tradeResult(candles, date, signalIndex) {
  const entryIndex = signalIndex
  if (!candles[entryIndex] || candles[entryIndex].time >= epoch(date, '15:31')) return null
  const exitCutoff = epoch(date, exitTime)
  const entryPrice = candles[entryIndex].open
  const stopPrice = entryPrice * (1 - thresholds.stopLoss / 100)
  let exitIndex = entryIndex
  let exitPrice = candles[entryIndex].close
  let exitReason = 'TIME'
  let minimumPriceBeforeExit = entryPrice

  for (let index = entryIndex; index < candles.length; index++) {
    if (candles[index].time > exitCutoff) break
    exitIndex = index
    if (candles[index].open <= stopPrice) {
      exitPrice = candles[index].open
      minimumPriceBeforeExit = Math.min(minimumPriceBeforeExit, exitPrice)
      exitReason = 'SL'
      break
    }
    if (candles[index].low <= stopPrice) {
      exitPrice = stopPrice
      minimumPriceBeforeExit = stopPrice
      exitReason = 'SL'
      break
    }
    minimumPriceBeforeExit = Math.min(minimumPriceBeforeExit, candles[index].low)
    exitPrice = candles[index].close
  }
  return {
    entryIndex, exitIndex, entryPrice, exitPrice, exitReason,
    returnPct: pct(exitPrice, entryPrice),
    maePct: pct(minimumPriceBeforeExit, entryPrice),
  }
}

const dates = enumerateDates(from, to)
const stageCounts = Object.fromEntries(dates.map((date) => [date, { Date: date, 'Step 1': 0, 'VWAP/EMA/RSI': 0, 'Recovery structure': 0, Signals: 0 }]))
const results = []

for (const filename of fs.readdirSync(candleDirectory).filter((name) => name.endsWith('.jsonl') && name !== 'NIFTY50.jsonl')) {
  const candles = fs.readFileSync(path.join(candleDirectory, filename), 'utf8').trim().split(/\r?\n/).map(JSON.parse)
  if (candles.length < 201) continue
  const metrics = indicators(candles)
  for (const date of dates) {
    const sessionIndex = exactIndex(candles, epoch(date, '09:15'))
    if (sessionIndex < 0) continue
    const previous = previousSession(candles, sessionIndex, date)
    if (!previous) continue
    const signal = stepOneSignal(candles, metrics, date, sessionIndex, previous.close)
    if (!signal) continue
    stageCounts[date]['Step 1']++
    const confirmation = stepTwo(candles, metrics, signal)
    if (!confirmation.passed) continue
    stageCounts[date][confirmation.confirmation === 'VWAP_EMA20_RSI' ? 'VWAP/EMA/RSI' : 'Recovery structure']++
    const trade = tradeResult(candles, date, signal.last + 1)
    if (!trade) continue
    stageCounts[date].Signals++
    results.push({
      Date: date,
      Stock: filename.replace('.jsonl', ''),
      'Signal time': clock(candles[signal.last].time),
      'Entry time': clock(candles[trade.entryIndex].time),
      'Entry price': round(trade.entryPrice, 4),
      'Exit time': clock(candles[trade.exitIndex].time),
      'Exit price': round(trade.exitPrice, 4),
      'Exit reason': trade.exitReason,
      'Return %': round(trade.returnPct, 4),
      'MAE %': round(trade.maePct, 4),
      'U-turn °': round(signal.uTurnAngle, 2),
      Confirmation: confirmation.confirmation,
      'VWAP distance %': round(confirmation.vwapDistance, 2),
      'EMA20 distance %': round(confirmation.ema20Distance, 2),
      'RSI(14)': round(confirmation.rsi14, 2),
      'Recovery %': round(confirmation.recoveryPct, 1),
      'Last-5 HH': confirmation.higherHighCount,
      'Last-5 HL': confirmation.higherLowCount,
    })
  }
}

results.sort((left, right) => left.Date.localeCompare(right.Date) || left['Signal time'].localeCompare(right['Signal time']) || left.Stock.localeCompare(right.Stock))
console.log(`Staged U-turn reversal scan: ${from}${from === to ? '' : ` to ${to}`} | signal cutoff ${cutoffTime} IST | SL ${thresholds.stopLoss}% | time exit ${exitTime} IST`)
console.table(Object.values(stageCounts).filter((row) => row['Step 1'] || row.Signals))
console.table(results)

const winners = results.filter((row) => row['Return %'] > 0)
const losers = results.filter((row) => row['Return %'] < 0)
const flats = results.length - winners.length - losers.length
const totalReturn = results.reduce((sum, row) => sum + row['Return %'], 0)
const byDay = new Map()
for (const row of results) byDay.set(row.Date, (byDay.get(row.Date) || 0) + row['Return %'])
const worstDay = [...byDay.entries()].sort((left, right) => left[1] - right[1])[0]
const summary = {
  Trades: results.length,
  Winners: winners.length,
  Losers: losers.length,
  Flats: flats,
  'Win rate %': results.length ? round(100 * winners.length / results.length) : 0,
  'Average return %': results.length ? round(totalReturn / results.length, 4) : 0,
  'Total return %': round(totalReturn, 4),
  'Average MAE %': results.length ? round(results.reduce((sum, row) => sum + row['MAE %'], 0) / results.length, 4) : 0,
  'Maximum adverse excursion %': results.length ? Math.min(...results.map((row) => row['MAE %'])) : 0,
  'Worst day': worstDay ? `${worstDay[0]} (${round(worstDay[1], 4)}%)` : '-',
}
console.table([summary])
