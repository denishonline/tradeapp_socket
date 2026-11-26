import fs from 'node:fs'
import path from 'node:path'

const root = process.cwd()
const targetDate = process.argv[2] ?? new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit'
}).format(new Date())

if (!/^\d{4}-\d{2}-\d{2}$/.test(targetDate)) {
  throw new Error('Usage: node scripts/rank-0930-five-factor-strength.js YYYY-MM-DD')
}

const windowStart = 9 * 60 + 15
const windowEnd = 9 * 60 + 30
const metricKeys = ['rsi14', 'trendAngleDeg', 'momentumPct', 'mfi14', 'emaGapExpansionPct']
const metricLabels = {
  rsi14: 'RSI-14',
  trendAngleDeg: 'trend angle',
  momentumPct: '09:15 open to 09:29 close momentum',
  mfi14: 'MFI-14',
  emaGapExpansionPct: 'EMA-9/EMA-45 gap expansion'
}
const round = (value, places = 4) => Number.isFinite(value) ? Number(value.toFixed(places)) : null

function istParts(epochSeconds) {
  const local = new Date(Number(epochSeconds) * 1000 + 330 * 60_000)
  return {
    date: local.toISOString().slice(0, 10),
    minute: local.getUTCHours() * 60 + local.getUTCMinutes()
  }
}

function availableSessions() {
  const file = path.join(root, 'db', 'candles', 'NIFTY50.jsonl')
  const counts = new Map()
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue
    let row
    try { row = JSON.parse(line) } catch { continue }
    const { date, minute } = istParts(row.time)
    if (minute >= windowStart && minute < windowEnd) {
      if (!counts.has(date)) counts.set(date, new Set())
      counts.get(date).add(minute)
    }
  }
  return [...counts].filter(([, minutes]) => minutes.size === 15).map(([date]) => date).sort()
}

function readWindow(symbol, requiredDates) {
  const file = path.join(root, 'db', 'candles', `${symbol}.jsonl`)
  if (!fs.existsSync(file)) return new Map()
  const wanted = new Set(requiredDates)
  const byDate = new Map(requiredDates.map(date => [date, new Map()]))
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue
    let row
    try { row = JSON.parse(line) } catch { continue }
    const { date, minute } = istParts(row.time)
    if (!wanted.has(date) || minute < windowStart || minute >= windowEnd) continue
    const candle = {
      open: Number(row.open), high: Number(row.high), low: Number(row.low),
      close: Number(row.close), volume: Number(row.volume)
    }
    if (!Object.values(candle).every(Number.isFinite) || candle.close <= 0 || candle.open <= 0 || candle.volume < 0) continue
    byDate.get(date).set(minute, candle)
  }
  return new Map([...byDate].map(([date, minutes]) => [date,
    [...minutes].sort((a, b) => a[0] - b[0]).map(([, candle]) => candle)
  ]))
}

function rsi14(closes) {
  if (closes.length !== 15) return null
  let gains = 0, losses = 0
  for (let i = 1; i < closes.length; i++) {
    const change = closes[i] - closes[i - 1]
    if (change > 0) gains += change
    else losses -= change
  }
  if (losses === 0) return gains === 0 ? 50 : 100
  return 100 - 100 / (1 + gains / losses)
}

function mfi14(rows) {
  if (rows.length !== 15) return null
  let positive = 0, negative = 0
  for (let i = 1; i < rows.length; i++) {
    const previous = (rows[i - 1].high + rows[i - 1].low + rows[i - 1].close) / 3
    const current = (rows[i].high + rows[i].low + rows[i].close) / 3
    const flow = current * rows[i].volume
    if (current > previous) positive += flow
    else if (current < previous) negative += flow
  }
  if (negative === 0) return positive === 0 ? 50 : 100
  return 100 - 100 / (1 + positive / negative)
}

function trendAngle(closes) {
  const logs = closes.map(Math.log)
  const xMean = (logs.length - 1) / 2
  const yMean = logs.reduce((sum, value) => sum + value, 0) / logs.length
  let covariance = 0, xVariance = 0
  logs.forEach((value, index) => {
    covariance += (index - xMean) * (value - yMean)
    xVariance += (index - xMean) ** 2
  })
  const slopePctPerMinute = 100 * covariance / xVariance
  return Math.atan(slopePctPerMinute) * 180 / Math.PI
}

function emaGapExpansion(rows) {
  let ema9 = rows[0].close, ema45 = rows[0].close
  const initialGap = 100 * (ema9 / ema45 - 1)
  for (let i = 1; i < rows.length; i++) {
    ema9 = (2 / 10) * rows[i].close + (8 / 10) * ema9
    ema45 = (2 / 46) * rows[i].close + (44 / 46) * ema45
  }
  return 100 * (ema9 / ema45 - 1) - initialGap
}

function metrics(rows) {
  if (rows.length !== 15) return null
  const closes = rows.map(row => row.close)
  const values = {
    rsi14: rsi14(closes),
    trendAngleDeg: trendAngle(closes),
    momentumPct: 100 * (rows.at(-1).close / rows[0].open - 1),
    mfi14: mfi14(rows),
    emaGapExpansionPct: emaGapExpansion(rows)
  }
  return Object.values(values).every(Number.isFinite) ? values : null
}

function assignCrossSectionScores(rows, key) {
  const sorted = [...rows].sort((a, b) => a.todayMetrics[key] - b.todayMetrics[key])
  for (let start = 0; start < sorted.length;) {
    let end = start
    while (end + 1 < sorted.length && sorted[end + 1].todayMetrics[key] === sorted[start].todayMetrics[key]) end++
    const averageRankIndex = (start + end) / 2
    const score = sorted.length === 1 ? 10 : 10 * averageRankIndex / (sorted.length - 1)
    for (let i = start; i <= end; i++) sorted[i].todayScores[key] = score
    start = end + 1
  }
}

function ownHistoryScore(current, prior) {
  const lower = prior.filter(value => value < current).length
  const equal = prior.filter(value => value === current).length
  return 10 * (lower + 0.5 * equal) / prior.length
}

function uniqueOutput(directory, base, extension) {
  let suffix = 1
  while (true) {
    const name = `${base}${suffix === 1 ? '' : `-${suffix}`}.${extension}`
    const file = path.join(root, directory, name)
    if (!fs.existsSync(file)) return file
    suffix++
  }
}

function csvValue(value) {
  const text = value == null ? '' : String(value)
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
}

const sessions = availableSessions()
if (!sessions.includes(targetDate)) throw new Error(`${targetDate} does not have all 15 NIFTY50 opening candles through 09:29.`)
const priorDates = sessions.filter(date => date < targetDate).slice(-5)
if (priorDates.length !== 5) throw new Error(`${targetDate} needs five earlier complete sessions; found ${priorDates.length}.`)

const stocksFile = path.join(root, 'db', 'stocks')
const stockRows = JSON.parse(fs.readFileSync(stocksFile, 'utf8'))
const symbols = [...new Set(stockRows.map(value => {
  const raw = typeof value === 'string' ? value : value?.symbol ?? value?.name ?? ''
  return String(raw).trim().toUpperCase().replace(/-EQ$/, '')
}).filter(Boolean))]
const requiredDates = [...priorDates, targetDate]
const eligible = [], excluded = []

for (const symbol of symbols) {
  const windows = readWindow(symbol, requiredDates)
  const missingDates = requiredDates.filter(date => windows.get(date)?.length !== 15)
  if (missingDates.length) {
    excluded.push({ symbol, reason: 'incomplete 09:15-09:29 window', dates: missingDates })
    continue
  }
  const byDate = Object.fromEntries(requiredDates.map(date => [date, metrics(windows.get(date))]))
  if (Object.values(byDate).some(value => value == null)) {
    excluded.push({ symbol, reason: 'invalid metric', dates: [] })
    continue
  }
  eligible.push({ symbol, todayMetrics: byDate[targetDate], priorMetrics: Object.fromEntries(priorDates.map(date => [date, byDate[date]])), todayScores: {}, historyScores: {} })
}

if (!eligible.length) throw new Error('No stocks have complete data for all six sessions.')
for (const key of metricKeys) assignCrossSectionScores(eligible, key)
for (const row of eligible) {
  for (const key of metricKeys) {
    row.historyScores[key] = ownHistoryScore(row.todayMetrics[key], priorDates.map(date => row.priorMetrics[date][key]))
  }
  row.todayScore = metricKeys.reduce((sum, key) => sum + row.todayScores[key], 0)
  row.historyScore = metricKeys.reduce((sum, key) => sum + row.historyScores[key], 0)
  row.totalScore = row.todayScore + row.historyScore
}

eligible.sort((a, b) => b.totalScore - a.totalScore || b.todayScore - a.todayScore || a.symbol.localeCompare(b.symbol))
const ranking = eligible.map((row, index) => ({
  rank: index + 1,
  symbol: `${row.symbol}-EQ`,
  totalScore: round(row.totalScore, 2),
  todayScore: round(row.todayScore, 2),
  ownFiveSessionScore: round(row.historyScore, 2),
  metrics: Object.fromEntries(metricKeys.map(key => [key, {
    value: round(row.todayMetrics[key]),
    todayUniverseScore: round(row.todayScores[key], 2),
    ownFiveSessionScore: round(row.historyScores[key], 2),
    priorValues: Object.fromEntries(priorDates.map(date => [date, round(row.priorMetrics[date][key])]))
  }]))
}))

const methodology = {
  purpose: 'Bullish-strength ranking; higher signed values receive higher scores.',
  dataWindowIST: '09:15 through 09:29 inclusive (15 completed one-minute candles, known at 09:30).',
  todayScore: 'For each factor, midrank percentile across all eligible stocks scaled from 0 to 10; five factors total 50.',
  ownFiveSessionScore: 'For each factor, 10 × (number of prior values below today + 0.5 × ties) / 5; five factors total 50.',
  factors: {
    rsi14: 'RSI from the 14 close-to-close changes in the 15-candle window.',
    trendAngleDeg: 'atan(least-squares log-close slope × 100), in degrees.',
    momentumPct: 'Percentage return from the 09:15 open to the 09:29 close.',
    mfi14: 'MFI from 14 typical-price changes, weighted by one-minute volume.',
    emaGapExpansionPct: 'Signed EMA-9 minus EMA-45 percentage gap at 09:29, with both EMAs reset to the 09:15 close.'
  }
}

const report = {
  generatedAt: new Date().toISOString(), targetDate, priorDates,
  source: 'db/candles/<SYMBOL>.jsonl', universeFile: 'db/stocks',
  universeCount: symbols.length, eligibleCount: eligible.length, excludedCount: excluded.length,
  methodology, top10: ranking.slice(0, 10), ranking, excluded
}
const base = `${targetDate}-0930-five-factor-strength-ranking`
const jsonFile = uniqueOutput('reports', base, 'json')
const csvFile = uniqueOutput('csv', base, 'csv')
fs.writeFileSync(jsonFile, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' })

const headers = ['rank', 'symbol', 'total_score', 'today_score', 'own_5_session_score',
  ...metricKeys.flatMap(key => [`${key}_value`, `${key}_today_score`, `${key}_own5_score`])]
const csvRows = ranking.map(row => [row.rank, row.symbol, row.totalScore, row.todayScore, row.ownFiveSessionScore,
  ...metricKeys.flatMap(key => [row.metrics[key].value, row.metrics[key].todayUniverseScore, row.metrics[key].ownFiveSessionScore])])
fs.writeFileSync(csvFile, [headers, ...csvRows].map(row => row.map(csvValue).join(',')).join('\n') + '\n', { flag: 'wx' })

console.log(JSON.stringify({ targetDate, priorDates, universeCount: symbols.length, eligibleCount: eligible.length,
  excludedCount: excluded.length, jsonFile, csvFile, top10: ranking.slice(0, 10).map(row => ({
    rank: row.rank, symbol: row.symbol, totalScore: row.totalScore, todayScore: row.todayScore,
    ownFiveSessionScore: row.ownFiveSessionScore,
    values: Object.fromEntries(metricKeys.map(key => [metricLabels[key], row.metrics[key].value]))
  })) }, null, 2))
