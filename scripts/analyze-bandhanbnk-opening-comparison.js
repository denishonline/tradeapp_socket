import fs from 'node:fs'

const file = 'db/candles/BANDHANBNK.jsonl'
const dates = ['2026-10-22', '2026-10-23']
const ist = seconds => new Date(seconds * 1000 + 330 * 60_000).toISOString().slice(0, 16).replace('T', ' ')
const day = seconds => ist(seconds).slice(0, 10)
const time = seconds => ist(seconds).slice(11)
const round = value => Number(value.toFixed(4))
const rows = fs.readFileSync(file, 'utf8').trim().split(/\r?\n/).map(JSON.parse).sort((a, b) => a.time - b.time)
let ema10, ema20, ema50, ema200, previous, averageGain, averageLoss
const opening = Object.fromEntries(dates.map(date => [date, []]))
for (const row of rows) {
  const close = Number(row.close)
  ema10 = ema10 == null ? close : ema10 + 2 / 11 * (close - ema10)
  ema20 = ema20 == null ? close : ema20 + 2 / 21 * (close - ema20)
  ema50 = ema50 == null ? close : ema50 + 2 / 51 * (close - ema50)
  ema200 = ema200 == null ? close : ema200 + 2 / 201 * (close - ema200)
  if (previous != null) {
    const change = close - previous, gain = Math.max(change, 0), loss = Math.max(-change, 0)
    if (averageGain == null) { averageGain = (averageGain ?? 0) + gain; averageLoss = (averageLoss ?? 0) + loss }
    else { averageGain = (13 * averageGain + gain) / 14; averageLoss = (13 * averageLoss + loss) / 14 }
  }
  previous = close
  const localDay = day(row.time), localTime = time(row.time)
  if (dates.includes(localDay) && localTime >= '09:15' && localTime <= '09:29') opening[localDay].push({ ...row, ema10, ema20, ema50, ema200, rsi14: averageLoss === 0 ? (averageGain === 0 ? 50 : 100) : 100 - 100 / (1 + averageGain / averageLoss) })
}
const result = {}
for (const date of dates) {
  const bars = opening[date], first = bars[0], last = bars.at(-1)
  const previousSession = rows.filter(row => day(row.time) < date && time(row.time) >= '09:15' && time(row.time) <= '15:29').at(-1)
  const ranges = bars.map(row => row.high - row.low), bodies = bars.map(row => Math.abs(row.close - row.open))
  const volume = bars.reduce((sum, row) => sum + Number(row.volume || 0), 0)
  const high = Math.max(...bars.map(row => row.high)), low = Math.min(...bars.map(row => row.low))
  result[date] = { bars: bars.length, firstOpen: first.open, firstClose: first.close, lastClose: last.close, high, low,
    openingGapPct: previousSession ? round(100 * (first.open / previousSession.close - 1)) : null,
    movePct: round(100 * (last.close / first.open - 1)), rangePct: round(100 * (high / low - 1)),
    totalVolume: volume, averageVolume: round(volume / bars.length), up: bars.filter(row => row.close > row.open).length,
    down: bars.filter(row => row.close < row.open).length, flat: bars.filter(row => row.close === row.open).length,
    averageRange: round(ranges.reduce((sum, value) => sum + value, 0) / bars.length),
    averageBody: round(bodies.reduce((sum, value) => sum + value, 0) / bars.length),
    ema10Vs20Pct: round(100 * (last.ema10 / last.ema20 - 1)), ema50Vs200Pct: round(100 * (last.ema50 / last.ema200 - 1)),
    priceVsEma200Pct: round(100 * (last.close / last.ema200 - 1)), rsi14: round(last.rsi14) }
}
console.log(JSON.stringify(result, null, 2))
