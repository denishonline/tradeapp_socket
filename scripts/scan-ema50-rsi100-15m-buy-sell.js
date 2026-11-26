import fs from 'node:fs'
import path from 'node:path'

const ROOT = process.cwd()
const CANDLES = path.join(ROOT, 'db', 'candles')
const REPORTS = path.join(ROOT, 'reports')
const IST = 330 * 60_000
const LAST_SIGNAL_MINUTE = 10 * 60 // Signals only through 09:59 IST.
const args = process.argv.slice(2)
let cutoffText = null, requestedSymbol = null
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--cutoff') cutoffText = args[++i]
  else if (args[i] === '--symbol') requestedSymbol = args[++i]?.toUpperCase()
  else throw new Error('Usage: node scripts/scan-ema50-rsi100-15m-buy-sell.js --cutoff "YYYY-MM-DD HH:MM" [--symbol SYMBOL]')
}
const match = cutoffText?.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}):(\d{2})$/)
if (!match || Number(match[2]) > 23 || Number(match[3]) > 59 || (requestedSymbol && !/^[A-Z0-9-]+$/.test(requestedSymbol))) {
  throw new Error('Use --cutoff "YYYY-MM-DD HH:MM" and, if supplied, --symbol NSE_SYMBOL')
}
const [, targetDate, hour, minute] = match
const cutoffMs = Date.parse(`${targetDate}T${hour}:${minute}:00+05:30`)
const stamp = seconds => new Date(seconds * 1000 + IST).toISOString().slice(0, 16).replace('T', ' ')
const dateOf = seconds => stamp(seconds).slice(0, 10)
const round = (value, digits = 3) => Number.isFinite(value) ? Number(value.toFixed(digits)) : null
const pct = (value, base) => 100 * (value / base - 1)
const csv = value => value == null ? '' : String(value)
const minuteOf = seconds => {
  const local = new Date(seconds * 1000 + IST)
  return local.getUTCHours() * 60 + local.getUTCMinutes()
}

function aggregate15(rows, includePartial = false) {
  const bars = []
  for (const row of rows) {
    const local = new Date(row.time * 1000 + IST)
    const minutes = local.getUTCHours() * 60 + local.getUTCMinutes()
    if (minutes < 555 || minutes >= 930) continue
    const key = `${dateOf(row.time)}|${Math.floor((minutes - 555) / 15)}`
    let bar = bars.at(-1)
    if (!bar || bar.key !== key) { bar = { key, start: row.time, time: row.time, close: +row.close }; bars.push(bar) }
    bar.time = row.time
    bar.close = +row.close
  }
  return bars.filter(bar => includePartial || (() => {
    const local = new Date(bar.time * 1000 + IST)
    const minutes = local.getUTCHours() * 60 + local.getUTCMinutes()
    return (minutes - 555) % 15 === 14
  })()).map(bar => ({ ...bar, complete: bar.time + 60 }))
}

function rsi9Series(bars) {
  let previous = null, gain = 0, loss = 0, ema3 = null
  const rsiValues = []
  return bars.map((bar, index) => {
    const change = previous == null ? 0 : bar.close - previous
    previous = bar.close
    if (index <= 9) { gain += Math.max(change, 0); loss += Math.max(-change, 0) }
    if (index === 9) { gain /= 9; loss /= 9 }
    else if (index > 9) { gain = (gain * 8 + Math.max(change, 0)) / 9; loss = (loss * 8 + Math.max(-change, 0)) / 9 }
    const rsi9 = index < 9 ? null : loss === 0 ? (gain === 0 ? 50 : 100) : 100 - 100 / (1 + gain / loss)
    if (rsi9 != null) { rsiValues.push(rsi9); ema3 = ema3 == null ? rsi9 : (rsi9 + ema3) / 2 }
    const wma21 = rsiValues.length < 21 ? null : rsiValues.slice(-21).reduce((sum, value, i) => sum + value * (i + 1), 0) / 231
    return { ...bar, rsi9, ema3, wma21 }
  })
}

// Computes the incomplete 15m bar at every one-minute timestamp without using
// later candles. The prior value is always the preceding completed 15m bar.
function buildLive15States(rows, targetDate) {
  const snapshots = new Map()
  const state = { count: 0, previousClose: null, seedGain: 0, seedLoss: 0, averageGain: null, averageLoss: null, ema3: null, recentRsi: [], prior: null }
  let active = null
  const calculate = close => {
    const index = state.count
    const change = state.previousClose == null ? 0 : close - state.previousClose
    const gain = Math.max(change, 0), loss = Math.max(-change, 0)
    let seedGain = state.seedGain, seedLoss = state.seedLoss, averageGain = state.averageGain, averageLoss = state.averageLoss
    if (index <= 9) {
      seedGain += gain; seedLoss += loss
      if (index === 9) { averageGain = seedGain / 9; averageLoss = seedLoss / 9 }
    } else {
      averageGain = (8 * averageGain + gain) / 9
      averageLoss = (8 * averageLoss + loss) / 9
    }
    const rsi9 = index < 9 ? null : averageLoss === 0 ? (averageGain === 0 ? 50 : 100) : 100 - 100 / (1 + averageGain / averageLoss)
    const ema3 = rsi9 == null ? null : state.ema3 == null ? rsi9 : (rsi9 + state.ema3) / 2
    const rsiForWma = rsi9 == null ? state.recentRsi : [...state.recentRsi, rsi9]
    const wma21 = rsiForWma.length < 21 ? null : rsiForWma.slice(-21).reduce((sum, value, i) => sum + value * (i + 1), 0) / 231
    return { rsi9, ema3, wma21, seedGain, seedLoss, averageGain, averageLoss }
  }
  const completeActive = () => {
    const values = calculate(active.close)
    state.count += 1
    state.previousClose = active.close
    state.seedGain = values.seedGain
    state.seedLoss = values.seedLoss
    state.averageGain = values.averageGain
    state.averageLoss = values.averageLoss
    state.ema3 = values.ema3
    if (values.rsi9 != null) state.recentRsi = [...state.recentRsi, values.rsi9].slice(-20)
    state.prior = { start: active.start, ...values }
  }
  for (const row of rows) {
    const minute = minuteOf(row.time)
    if (minute < 555 || minute >= 930) continue
    const key = `${dateOf(row.time)}|${Math.floor((minute - 555) / 15)}`
    if (!active || active.key !== key) {
      if (active) completeActive()
      active = { key, start: row.time, close: +row.close }
    } else active.close = +row.close
    if (dateOf(row.time) === targetDate) snapshots.set(row.time, { current: { start: active.start, ...calculate(active.close) }, prior: state.prior })
  }
  return snapshots
}

const filenames = requestedSymbol ? [`${requestedSymbol}.jsonl`] : fs.readdirSync(CANDLES).filter(name => name.endsWith('.jsonl') && name !== 'NIFTY50.jsonl')
const results = []
for (const filename of filenames) {
  const file = path.join(CANDLES, filename)
  if (!fs.existsSync(file)) continue
  const symbol = filename.slice(0, -6)
  const rows = fs.readFileSync(file, 'utf8').trim().split(/\r?\n/)
    .map(line => JSON.parse(line)).filter(row => Number.isFinite(+row.open) && Number.isFinite(+row.close) && row.time * 1000 + 60_000 <= cutoffMs)
    .sort((a, b) => a.time - b.time)
  const today = rows.filter(row => dateOf(row.time) === targetDate)
  if (!today.length) continue
  const previousSessionLast = [...rows].reverse().find(row => row.time < today[0].time)
  if (!previousSessionLast) continue
  const openingGapPct = pct(+today[0].open, +previousSessionLast.close)
  if (Math.abs(openingGapPct) >= 3) continue
  const live15States = buildLive15States(rows, targetDate)

  let ema10 = null, ema20 = null, ema50 = null, ema200 = null, averageGain = null, averageLoss = null, seedGain = 0, seedLoss = 0, previous = null
  const foundSides = new Set()
  const computed = []
  const stockSignals = []
  const sessionCandles = []
  let sessionVolume = 0
  for (let index = 0; index < rows.length; index++) {
    const candle = rows[index], close = +candle.close
    ema10 = ema10 == null ? close : ema10 + 2 / 11 * (close - ema10)
    ema20 = ema20 == null ? close : ema20 + 2 / 21 * (close - ema20)
    ema50 = ema50 == null ? close : ema50 + 2 / 51 * (close - ema50)
    ema200 = ema200 == null ? close : ema200 + 2 / 201 * (close - ema200)
    if (previous != null) {
      const delta = close - previous, gain = Math.max(delta, 0), loss = Math.max(-delta, 0)
      if (averageGain == null) { seedGain += gain; seedLoss += loss; if (index === 100) { averageGain = seedGain / 100; averageLoss = seedLoss / 100 } }
      else { averageGain = (99 * averageGain + gain) / 100; averageLoss = (99 * averageLoss + loss) / 100 }
    }
    previous = close
    computed.push({ candle, ema10, ema20 })
    if (dateOf(candle.time) !== targetDate || averageGain == null) {
      continue
    }
    sessionCandles.push(candle)
    sessionVolume += +candle.volume
    if (minuteOf(candle.time) >= LAST_SIGNAL_MINUTE) continue
    const rsi100 = averageLoss === 0 ? (averageGain === 0 ? 50 : 100) : 100 - 100 / (1 + averageGain / averageLoss)
    const ema10VsEma20Pct = pct(ema10, ema20)
    const ema50VsEma200Pct = pct(ema50, ema200)
    const priceVsEma50Pct = pct(close, ema50)
    const candidateSides = ['sell', 'buy'].filter(side => !foundSides.has(side) && (side === 'sell'
      ? ema10VsEma20Pct < -0.2 && ema50VsEma200Pct < -0.5 && priceVsEma50Pct < -0.5 && rsi100 < 40
      : ema10VsEma20Pct > 0.2 && ema50VsEma200Pct > 0.5 && priceVsEma50Pct > 0.5 && rsi100 > 60
    ))
    if (!candidateSides.length) continue
    // The final 15m bar is deliberately partial, allowing a confirmation before 15m close.
    const { current, prior } = live15States.get(candle.time) || {}
    const usable15 = current && [current.rsi9, current.ema3, current.wma21].every(Number.isFinite)
    const lastFive = sessionCandles.slice(-5)
    const directionalVolumeRatio = lastFive.length === 5 ? lastFive.reduce((sum, row) => sum + +row.volume, 0) / 5 / (sessionVolume / sessionCandles.length) : null
    for (const side of candidateSides) {
      const confirmed15 = usable15 && prior && [prior.rsi9, prior.ema3, prior.wma21].every(Number.isFinite) && (side === 'sell'
        ? current.rsi9 < 40 && current.rsi9 < current.wma21 && current.ema3 > current.rsi9 && current.ema3 < current.wma21 && current.wma21 > 35
        : current.rsi9 > 60 && current.rsi9 > current.wma21 && current.ema3 < current.rsi9 && current.ema3 > current.wma21 && current.wma21 < 65)
      const prior15Aligned = side === 'sell'
        ? current.rsi9 < prior.rsi9 && current.ema3 < prior.ema3 && current.wma21 < prior.wma21
        : current.rsi9 > prior.rsi9 && current.ema3 > prior.ema3 && current.wma21 > prior.wma21
      const directionalCandles = lastFive.filter(row => side === 'sell' ? +row.close < +row.open : +row.close > +row.open).length
      const oneMinuteConfirmed = directionalCandles >= 3 && directionalVolumeRatio > 1 && directionalVolumeRatio < 1.5
      if (!confirmed15 || !prior15Aligned || !oneMinuteConfirmed) continue
      stockSignals.push({ date: targetDate, side: side.toUpperCase(), stock: symbol, signalIndex: index, signalTime: stamp(candle.time).slice(11), openingGapPct: round(openingGapPct), ema10VsEma20Pct: round(ema10VsEma20Pct), ema50VsEma200Pct: round(ema50VsEma200Pct), priceVsEma50Pct: round(priceVsEma50Pct), rsi100: round(rsi100, 2), active15mBarStart: stamp(current.start).slice(11), rsi9_15m: round(current.rsi9, 2), ema3Rsi9_15m: round(current.ema3, 2), wma21Rsi9_15m: round(current.wma21, 2), directionalCandlesLast5: directionalCandles, directionalVolumeRatio: round(directionalVolumeRatio) })
      foundSides.add(side)
    }
  }
  for (const signal of stockSignals) {
    const entry = computed[signal.signalIndex + 1]
    if (!entry || dateOf(entry.candle.time) !== targetDate) {
      results.push({ ...signal, entryTime: null, entryPrice: null, exitTime: null, exitPrice: null, exitReason: 'PENDING_NEXT_COMPLETED_CANDLE', returnPct: null })
      continue
    }
    let exit = null
    for (let index = signal.signalIndex + 2; index < computed.length; index++) {
      const previousPoint = computed[index - 1], point = computed[index]
      if (dateOf(point.candle.time) !== targetDate) break
      const reversed = signal.side === 'BUY'
        ? previousPoint.ema10 >= previousPoint.ema20 && point.ema10 < point.ema20
        : previousPoint.ema10 <= previousPoint.ema20 && point.ema10 > point.ema20
      if (reversed) { exit = point; break }
    }
    const entryPrice = +entry.candle.close, exitPrice = exit ? +exit.candle.close : null
    const returnPct = exit ? (signal.side === 'BUY' ? pct(exitPrice, entryPrice) : -pct(exitPrice, entryPrice)) : null
    results.push({ ...signal, entryTime: stamp(entry.candle.time).slice(11), entryPrice: round(entryPrice, 2), exitTime: exit ? stamp(exit.candle.time).slice(11) : null, exitPrice: exit ? round(exitPrice, 2) : null, exitReason: exit ? 'EMA10_EMA20_REVERSE_CROSS' : 'OPEN_AT_CUTOFF', returnPct: round(returnPct) })
  }
}

results.sort((a, b) => (a.side === b.side ? 0 : a.side === 'BUY' ? -1 : 1) || a.signalTime.localeCompare(b.signalTime) || a.stock.localeCompare(b.stock))
const header = ['date', 'side', 'stock', 'signal_time_ist', 'entry_time_ist', 'entry_price', 'exit_time_ist', 'exit_price', 'exit_reason', 'return_pct', 'opening_gap_pct', 'ema10_vs_ema20_pct', 'ema50_vs_ema200_pct', 'price_vs_ema50_pct', 'rsi100', 'active_15m_bar_start_ist', 'rsi9_15m', 'ema3_rsi9_15m', 'wma21_rsi9_15m', 'directional_candles_last5', 'directional_volume_ratio']
const csvRows = [header.join(','), ...results.map(row => [row.date, row.side, row.stock, row.signalTime, row.entryTime, row.entryPrice, row.exitTime, row.exitPrice, row.exitReason, row.returnPct, row.openingGapPct, row.ema10VsEma20Pct, row.ema50VsEma200Pct, row.priceVsEma50Pct, row.rsi100, row.active15mBarStart, row.rsi9_15m, row.ema3Rsi9_15m, row.wma21Rsi9_15m, row.directionalCandlesLast5, row.directionalVolumeRatio].map(csv).join(','))]
const safeCutoff = cutoffText.replace(/[ :]/g, '-')
let output = path.join(REPORTS, `ema50-rsi100-live-15m-both-${safeCutoff}.csv`), attempt = 2
while (fs.existsSync(output)) output = path.join(REPORTS, `ema50-rsi100-live-15m-both-${safeCutoff}-${attempt++}.csv`)
fs.writeFileSync(output, csvRows.join('\n') + '\n')
const sellCount = results.filter(row => row.side === 'SELL').length
const buyCount = results.filter(row => row.side === 'BUY').length
console.log(`BUY + SELL | Cutoff ${cutoffText} IST | SELL ${sellCount} | BUY ${buyCount}`)
for (const row of results) console.log(`${row.stock}  ${row.signalTime}  ${row.side}  ${row.returnPct == null ? 'OPEN' : `${row.returnPct}%`}`)
