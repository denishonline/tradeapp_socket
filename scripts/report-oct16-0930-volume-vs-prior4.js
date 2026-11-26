import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = process.cwd()
const symbols = ['TECHM', 'WIPRO', 'KPITTECH', 'TCS', 'DALBHARAT', 'INFY']
const prior = ['2026-10-12', '2026-10-13', '2026-10-14', '2026-10-15']
const target = '2026-10-16'
const allDates = [...prior, target]
const windowStart = 9 * 60 + 15, windowEnd = 9 * 60 + 30

function trendAngle(closes) {
  if (closes.length < 2 || closes.some(close => !Number.isFinite(close) || close <= 0)) return null
  const logs = closes.map(Math.log)
  const mid = (logs.length - 1) / 2
  const mean = logs.reduce((sum, n) => sum + n, 0) / logs.length
  let covariance = 0, xVariance = 0
  logs.forEach((value, i) => { covariance += (i - mid) * (value - mean); xVariance += (i - mid) ** 2 })
  const slopePctPerMinute = 100 * covariance / xVariance
  return { slopePctPerMinute, angleDeg: Math.atan(slopePctPerMinute) * 180 / Math.PI }
}

export function volumeByDate(symbol, dates = allDates, endMinute = windowEnd, startMinute = windowStart) {
  const file = path.join(root, 'db/candles', `${symbol}.jsonl`)
  const byDate = new Map(dates.map(date => [date, new Map()]))
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue
    let row
    try { row = JSON.parse(line) } catch { continue }
    const time = Number(row.time) * 1000
    const volume = Number(row.volume)
    if (!Number.isFinite(time) || !Number.isFinite(volume) || volume < 0) continue
    const local = new Date(time + 330 * 60_000)
    const date = local.toISOString().slice(0, 10)
    const minute = local.getUTCHours() * 60 + local.getUTCMinutes()
    if (!byDate.has(date) || minute < startMinute || minute >= endMinute) continue
    byDate.get(date).set(minute, { volume, close: Number(row.close) })
  }
  return Object.fromEntries([...byDate].map(([date, minutes]) => {
    const ordered = [...minutes].sort((a, b) => a[0] - b[0]).map(([, row]) => row)
    const trend = trendAngle(ordered.map(row => row.close))
    return [date, { candles: minutes.size, volume: ordered.reduce((sum, row) => sum + row.volume, 0),
      trendAngleDeg: trend === null ? null : Number(trend.angleDeg.toFixed(4)),
      slopePctPerMinute: trend === null ? null : Number(trend.slopePctPerMinute.toFixed(6)) }]
  }))
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
const results = symbols.map(symbol => {
  const sessions = volumeByDate(symbol)
  const complete = allDates.every(date => sessions[date].candles === 15)
  const average = prior.reduce((sum, date) => sum + sessions[date].volume, 0) / prior.length
  const current = sessions[target].volume
  const averageAngle = prior.reduce((sum, date) => sum + sessions[date].trendAngleDeg, 0) / prior.length
  return { symbol, sessions, complete, previous4AverageVolume: average,
    october16Volume: current,
    volumeAsPctOfAverage: Number((100 * current / average).toFixed(2)),
    increaseVsAveragePct: Number((100 * (current / average - 1)).toFixed(2)),
    previous4AverageTrendAngleDeg: Number(averageAngle.toFixed(4)),
    october16TrendAngleDeg: sessions[target].trendAngleDeg,
    angleDifferenceDeg: Number((sessions[target].trendAngleDeg - averageAngle).toFixed(4)) }
})
const output = { windowIST: '09:15:00–09:29:59 (15 one-minute candles; known by 09:30)',
  comparisonDates: prior, targetDate: target, source: 'db/candles/<SYMBOL>.jsonl',
  trendAngleMethod: 'Least-squares slope of log(one-minute close) versus minute index 0..14; multiply slope by 100 to get percent per minute; angle = atan(percent-per-minute slope) in degrees. Previous-four-day comparison is the arithmetic mean of four daily angles.',
  results }
let n = 1, file
do { file = path.join(root, 'reports', `2026-10-16-0930-six-stocks-volume-and-angle-vs-previous-four-days${n === 1 ? '' : `-${n}`}.json`); n++ } while (fs.existsSync(file))
fs.writeFileSync(file, JSON.stringify(output, null, 2) + '\n', { flag: 'wx' })
console.log(JSON.stringify({ file, results }, null, 2))
}
