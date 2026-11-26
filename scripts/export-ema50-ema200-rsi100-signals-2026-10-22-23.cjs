const fs = require('node:fs')
const path = require('node:path')

const ROOT = process.cwd()
const DATES = new Set(['2026-10-22', '2026-10-23'])
const CANDLES = path.join(ROOT, 'db', 'candles')
const stamp = time => new Date(time * 1000 + 330 * 60_000).toISOString().slice(0, 16).replace('T', ' ')
const round = (value, digits = 3) => Number.isFinite(value) ? Number(value.toFixed(digits)) : null
const pct = (value, base) => 100 * (value / base - 1)
const csv = value => value == null ? '' : String(value)
function angleOfLast20(values) {
  if (values.length < 20) return null
  const y = values.slice(-20), meanX = 9.5, meanY = y.reduce((sum, value) => sum + value, 0) / 20
  const numerator = y.reduce((sum, value, index) => sum + (index - meanX) * (value - meanY), 0)
  const denominator = y.reduce((sum, _value, index) => sum + (index - meanX) ** 2, 0)
  return Math.atan(numerator / denominator) * 180 / Math.PI
}

const results = []
for (const filename of fs.readdirSync(CANDLES).filter(x => x.endsWith('.jsonl') && x !== 'NIFTY50.jsonl')) {
  const symbol = filename.slice(0, -6)
  const rows = fs.readFileSync(path.join(CANDLES, filename), 'utf8').trim().split(/\r?\n/)
    .map(line => JSON.parse(line)).filter(x => Number.isFinite(+x.open) && Number.isFinite(+x.close))
    .sort((a, b) => a.time - b.time)
  for (const targetDate of DATES) {
    const today = rows.filter(x => stamp(x.time).slice(0, 10) === targetDate)
    if (!today.length) continue
    const prior = [...rows].reverse().find(x => x.time < today[0].time)
    if (!prior) continue
    const relatedDateGapPct = pct(+today[0].open, +prior.close)
    if (Math.abs(relatedDateGapPct) >= 2) continue
    let ema50 = null, ema200 = null, averageGain = null, averageLoss = null, seedGain = 0, seedLoss = 0
    let averageGain14 = null, averageLoss14 = null, seedGain14 = 0, seedLoss14 = 0, previous = null
    // This keeps the last 120 available market candles across session boundaries.
    // Overnight hours add no candles and therefore do not dilute the average.
    const priorGaps = []
    const rsi14Values = []
    const rsi100Values = []
    for (let index = 0; index < rows.length; index++) {
      const candle = rows[index], close = +candle.close, date = stamp(candle.time).slice(0, 10)
      ema50 = ema50 === null ? close : ema50 + 2 / 51 * (close - ema50)
      ema200 = ema200 === null ? close : ema200 + 2 / 201 * (close - ema200)
      if (previous != null) {
        const delta = close - previous, gain = Math.max(delta, 0), loss = Math.max(-delta, 0)
        if (averageGain === null) {
          seedGain += gain; seedLoss += loss
          if (index === 100) { averageGain = seedGain / 100; averageLoss = seedLoss / 100 }
        } else { averageGain = (99 * averageGain + gain) / 100; averageLoss = (99 * averageLoss + loss) / 100 }
        if (averageGain14 === null) {
          seedGain14 += gain; seedLoss14 += loss
          if (index === 14) { averageGain14 = seedGain14 / 14; averageLoss14 = seedLoss14 / 14 }
        } else { averageGain14 = (13 * averageGain14 + gain) / 14; averageLoss14 = (13 * averageLoss14 + loss) / 14 }
      }
      previous = close
      if (averageGain14 !== null) rsi14Values.push(averageLoss14 === 0 ? (averageGain14 === 0 ? 50 : 100) : 100 - 100 / (1 + averageGain14 / averageLoss14))
      const rsi100 = averageGain === null ? null : averageLoss === 0 ? (averageGain === 0 ? 50 : 100) : 100 - 100 / (1 + averageGain / averageLoss)
      if (rsi100 !== null) rsi100Values.push(rsi100)
      const absoluteEmaGapPct = Math.abs(100 * (1 - ema50 / ema200))
      if (date !== targetDate || averageGain === null) {
        priorGaps.push(absoluteEmaGapPct)
        continue
      }
      const ema50BelowEma200Pct = 100 * (1 - ema50 / ema200)
      const priceBelowEma50Pct = 100 * (1 - close / ema50)
      const pre120AvgGapPct = priorGaps.length < 120 ? null : priorGaps.slice(-120).reduce((sum, gap) => sum + gap, 0) / 120
      if (ema50BelowEma200Pct > 1 && priceBelowEma50Pct > 1 && rsi100 < 40) {
        results.push({ date: targetDate, stock: symbol, time: stamp(candle.time).slice(11), pre120AvgGapPct: round(pre120AvgGapPct), relatedDateGapPct: round(relatedDateGapPct), ema50BelowEma200Pct: round(ema50BelowEma200Pct), priceBelowEma50Pct: round(priceBelowEma50Pct), rsi100: round(rsi100, 2), rsi14TrendAngleLast20Deg: round(angleOfLast20(rsi14Values), 2), rsi100TrendAngleLast20Deg: round(angleOfLast20(rsi100Values), 2) })
        break
      }
      priorGaps.push(absoluteEmaGapPct)
    }
  }
}
results.sort((a, b) => a.date.localeCompare(b.date) || a.time.localeCompare(b.time) || a.stock.localeCompare(b.stock))
const header = ['date', 'stock', 'time_ist', 'pre120_avg_absolute_ema50_ema200_gap_pct', 'related_date_open_gap_pct', 'ema50_below_ema200_pct', 'price_below_ema50_pct', 'rsi100', 'rsi14_trend_angle_last20_deg', 'rsi100_trend_angle_last20_deg']
const lines = [header.join(','), ...results.map(row => [row.date, row.stock, row.time, row.pre120AvgGapPct, row.relatedDateGapPct, row.ema50BelowEma200Pct, row.priceBelowEma50Pct, row.rsi100, row.rsi14TrendAngleLast20Deg, row.rsi100TrendAngleLast20Deg].map(csv).join(','))]
const output = path.join(ROOT, 'reports', '2026-10-22-to-23-ema50-ema200-rsi100-first-signals-with-prior-session-rsi14-rsi100-angles.csv')
fs.writeFileSync(output, lines.join('\n') + '\n')
console.log(JSON.stringify({ output, total: results.length, byDate: Object.fromEntries([...DATES].map(date => [date, results.filter(x => x.date === date).length])), withPre120: results.filter(x => x.pre120AvgGapPct != null).length }, null, 2))
