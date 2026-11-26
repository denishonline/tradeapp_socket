const fs = require('node:fs')
const path = require('node:path')

const ROOT = process.cwd()
const TARGET = process.argv[2] || '2026-10-22'
if (!/^2026-10-(?:16|19|21|22|23)$/.test(TARGET)) throw new Error('Pass a supported session date, for example: 2026-10-16')
const CANDLES = path.join(ROOT, 'db', 'candles')
const IST = 330 * 60_000
const stamp = time => new Date(time * 1000 + IST).toISOString().slice(0, 16).replace('T', ' ')
const dateOf = time => stamp(time).slice(0, 10)
const round = (value, digits = 3) => Number.isFinite(value) ? Number(value.toFixed(digits)) : null
const pct = (value, base) => 100 * (value / base - 1)
const csv = value => value == null ? '' : String(value)

function aggregate15(rows) {
  const bars = []
  for (const row of rows) {
    const local = new Date(row.time * 1000 + IST)
    const minute = local.getUTCHours() * 60 + local.getUTCMinutes()
    if (minute < 555 || minute >= 930) continue
    const key = `${dateOf(row.time)}|${Math.floor((minute - 555) / 15)}`
    let bar = bars.at(-1)
    if (!bar || bar.key !== key) { bar = { key, time: row.time, close: +row.close }; bars.push(bar) }
    bar.time = row.time
    bar.close = +row.close
  }
  return bars.filter(bar => {
    const local = new Date(bar.time * 1000 + IST)
    const minute = local.getUTCHours() * 60 + local.getUTCMinutes()
    return (minute - 555) % 15 === 14
  }).map(bar => ({ ...bar, complete: bar.time + 60 }))
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

const results = []
for (const filename of fs.readdirSync(CANDLES).filter(x => x.endsWith('.jsonl') && x !== 'NIFTY50.jsonl')) {
  const symbol = filename.slice(0, -6)
  const rows = fs.readFileSync(path.join(CANDLES, filename), 'utf8').trim().split(/\r?\n/)
    .map(line => JSON.parse(line)).filter(x => Number.isFinite(+x.open) && Number.isFinite(+x.close))
    .sort((a, b) => a.time - b.time)
  const today = rows.filter(row => dateOf(row.time) === TARGET)
  if (!today.length) continue
  const priorDayLast = [...rows].reverse().find(row => row.time < today[0].time)
  if (!priorDayLast) continue
  const relatedDateGapPct = pct(+today[0].open, +priorDayLast.close)
  if (Math.abs(relatedDateGapPct) >= 1.5) continue
  const bars15 = rsi9Series(aggregate15(rows))
  let ema50 = null, ema200 = null, averageGain = null, averageLoss = null, seedGain = 0, seedLoss = 0, previous = null
  const last30CandleBodies = []
  for (let index = 0; index < rows.length; index++) {
    const candle = rows[index], close = +candle.close
    ema50 = ema50 == null ? close : ema50 + 2 / 51 * (close - ema50)
    ema200 = ema200 == null ? close : ema200 + 2 / 201 * (close - ema200)
    if (previous != null) {
      const delta = close - previous, gain = Math.max(delta, 0), loss = Math.max(-delta, 0)
      if (averageGain == null) { seedGain += gain; seedLoss += loss; if (index === 100) { averageGain = seedGain / 100; averageLoss = seedLoss / 100 } }
      else { averageGain = (99 * averageGain + gain) / 100; averageLoss = (99 * averageLoss + loss) / 100 }
    }
    previous = close
    const candleBodyPct = pct(close, +candle.open)
    const last30WithCurrent = [...last30CandleBodies, Math.abs(candleBodyPct)].slice(-30)
    if (dateOf(candle.time) !== TARGET || averageGain == null) {
      last30CandleBodies.push(Math.abs(candleBodyPct))
      if (last30CandleBodies.length > 30) last30CandleBodies.shift()
      continue
    }
    const rsi100 = averageLoss === 0 ? (averageGain === 0 ? 50 : 100) : 100 - 100 / (1 + averageGain / averageLoss)
    const emaGapPct = 100 * (1 - ema50 / ema200)
    const priceGapPct = 100 * (1 - close / ema50)
    if (!(emaGapPct > 1 && priceGapPct > 1 && rsi100 < 40 && last30WithCurrent.length === 30 && last30WithCurrent.every(value => value <= 2))) {
      last30CandleBodies.push(Math.abs(candleBodyPct))
      if (last30CandleBodies.length > 30) last30CandleBodies.shift()
      continue
    }
    const available = bars15.filter(bar => bar.complete <= candle.time)
    const current = available.at(-1), prior = available.at(-2)
    const bearish15 = current && prior && [current.rsi9, current.ema3, current.wma21, prior.rsi9, prior.ema3, prior.wma21].every(Number.isFinite) &&
      current.rsi9 < 40 && current.rsi9 < current.wma21 && current.ema3 > current.rsi9 && current.ema3 < current.wma21 && current.wma21 > 35 &&
      current.rsi9 < prior.rsi9 && current.ema3 < prior.ema3 && current.wma21 < prior.wma21
    if (bearish15) {
      results.push({ date: TARGET, stock: symbol, signalTime: stamp(candle.time).slice(11), relatedDateGapPct: round(relatedDateGapPct), maxAbsBodyPctLast30: round(Math.max(...last30WithCurrent)), ema50BelowEma200Pct: round(emaGapPct), priceBelowEma50Pct: round(priceGapPct), rsi100: round(rsi100, 2), timeframe15Complete: stamp(current.complete).slice(11), rsi9_15m: round(current.rsi9, 2), ema3Rsi9_15m: round(current.ema3, 2), wma21Rsi9_15m: round(current.wma21, 2), priorRsi9_15m: round(prior.rsi9, 2), priorEma3Rsi9_15m: round(prior.ema3, 2), priorWma21Rsi9_15m: round(prior.wma21, 2) })
      break
    }
    last30CandleBodies.push(Math.abs(candleBodyPct))
    if (last30CandleBodies.length > 30) last30CandleBodies.shift()
  }
}
results.sort((a, b) => a.signalTime.localeCompare(b.signalTime) || a.stock.localeCompare(b.stock))
const header = ['date', 'stock', 'signal_time_ist', 'related_date_open_gap_pct', 'max_abs_open_close_pct_last30', 'ema50_below_ema200_pct', 'price_below_ema50_pct', 'rsi100', 'latest_completed_15m_time', 'rsi9_15m', 'ema3_rsi9_15m', 'wma21_rsi9_15m', 'prior_rsi9_15m', 'prior_ema3_rsi9_15m', 'prior_wma21_rsi9_15m']
const lines = [header.join(','), ...results.map(row => [row.date, row.stock, row.signalTime, row.relatedDateGapPct, row.maxAbsBodyPctLast30, row.ema50BelowEma200Pct, row.priceBelowEma50Pct, row.rsi100, row.timeframe15Complete, row.rsi9_15m, row.ema3Rsi9_15m, row.wma21Rsi9_15m, row.priorRsi9_15m, row.priorEma3Rsi9_15m, row.priorWma21Rsi9_15m].map(csv).join(','))]
const output = path.join(ROOT, 'reports', `${TARGET}-ema50-rsi100-15m-rsi9-sell-confirmation-wma21-above-35-last30-body-under-2-gap-under-1p5.csv`)
fs.writeFileSync(output, lines.join('\n') + '\n')
console.log(JSON.stringify({ output, count: results.length, results: results.map(x => ({ stock: x.stock, time: x.signalTime, rsi9_15m: x.rsi9_15m, ema3Rsi9_15m: x.ema3Rsi9_15m, wma21Rsi9_15m: x.wma21Rsi9_15m })) }, null, 2))
