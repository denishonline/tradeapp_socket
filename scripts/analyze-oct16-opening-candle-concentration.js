import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = process.cwd()
const round = (n, digits = 3) => Number.isFinite(n) ? Number(n.toFixed(digits)) : null
const sum = xs => xs.reduce((a, b) => a + b, 0)
const top = (xs, n) => [...xs].sort((a, b) => b - a).slice(0, n)
const median = xs => { const sorted = [...xs].sort((a, b) => a - b); return sorted[Math.floor(sorted.length / 2)] }

export function analyzeOpeningCandles(symbol, date, cutoff = '09:30') {
  const start = Date.parse(`${date}T09:15:00+05:30`) / 1000
  const end = Date.parse(`${date}T${cutoff}:00+05:30`) / 1000
  const file = path.join(root, 'db/candles', `${symbol}.jsonl`)
  const byTime = new Map()
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue
    let r
    try { r = JSON.parse(line) } catch { continue }
    if (r.time < start || r.time >= end || byTime.has(r.time)) continue
    byTime.set(r.time, r)
  }
  const bars = [...byTime.values()].sort((a, b) => a.time - b.time)
  if (bars.length < 2) return { symbol, candles: bars.length }
  const body = bars.map(r => 100 * Math.abs(r.close / r.open - 1))
  const range = bars.map(r => 100 * (r.high - r.low) / r.open)
  const step = bars.map((r, i) => 100 * (r.close / (i ? bars[i - 1].close : r.open) - 1))
  const gap = bars.map((r, i) => i ? 100 * (r.open / bars[i - 1].close - 1) : 0)
  const positiveStep = step.map(x => Math.max(x, 0))
  const volume = bars.map(r => r.volume)
  const meanLog = sum(bars.map(r => Math.log(r.close))) / bars.length
  const meanX = (bars.length - 1) / 2
  const slope = sum(bars.map((r, i) => (i - meanX) * (Math.log(r.close) - meanLog))) / sum(bars.map((_, i) => (i - meanX) ** 2))
  const fitted = bars.map((_, i) => meanLog + slope * (i - meanX))
  const ssTotal = sum(bars.map(r => (Math.log(r.close) - meanLog) ** 2))
  const ssResidual = sum(bars.map((r, i) => (Math.log(r.close) - fitted[i]) ** 2))
  return { symbol, candles: bars.length, netReturnPct: round(100 * (bars.at(-1).close / bars[0].open - 1)),
    greenBars: bars.filter(r => r.close > r.open).length,
    largestBodyPct: round(Math.max(...body)), secondBodyPct: round(top(body, 2)[1]),
    largestRangePct: round(Math.max(...range)), rangeMedianPct: round(median(range)),
    largestRangeToMedian: round(Math.max(...range) / median(range)),
    top2RangeSharePct: round(100 * sum(top(range, 2)) / sum(range)),
    top2PositiveStepSharePct: round(100 * sum(top(positiveStep, 2)) / sum(positiveStep)),
    largestPositiveStepPct: round(Math.max(...positiveStep)), largestPositiveGapPct: round(Math.max(...gap)),
    top2VolumeSharePct: round(100 * sum(top(volume, 2)) / sum(volume)),
    largestVolumeSharePct: round(100 * Math.max(...volume) / sum(volume)),
    pathEfficiencyPct: round(100 * Math.abs(Math.log(bars.at(-1).close / bars[0].open)) / sum(step.map(x => Math.abs(x / 100)))),
    logCloseTrendR2: round(1 - ssResidual / ssTotal),
    maxHighToFinalClosePct: round(100 * (Math.max(...bars.map(r => r.high)) / bars.at(-1).close - 1)) }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
const selected = JSON.parse(fs.readFileSync(path.join(root, 'reports/2026-10-16-0930-fourteen-screen-stocks-prev-close-exclude-below-minus0p4.json'), 'utf8')).eligibleSymbols
const rows = selected.map(symbol => analyzeOpeningCandles(symbol, '2026-10-16'))
let n = 1, file
do { file = path.join(root, 'reports', `2026-10-16-0930-twelve-stock-opening-candle-shape${n === 1 ? '' : `-${n}`}.json`); n++ } while (fs.existsSync(file))
fs.writeFileSync(file, JSON.stringify({ windowIST: '09:15–09:29', source: 'db/candles/<SYMBOL>.jsonl', rows }, null, 2) + '\n', { flag: 'wx' })
console.log(JSON.stringify({ file, rows }, null, 2))
}
