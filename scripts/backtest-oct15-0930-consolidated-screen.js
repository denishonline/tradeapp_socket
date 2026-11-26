import fs from 'node:fs'
import path from 'node:path'
import { volumeByDate } from './report-oct16-0930-volume-vs-prior4.js'
import { analyzeDepthSession } from './report-oct16-0930-six-stock-depth-behavior.js'
import { analyzeOpeningCandles } from './analyze-oct16-opening-candle-concentration.js'

const root = process.cwd()
const sessionDates = ['2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09',
  '2026-10-12', '2026-10-13', '2026-10-14', '2026-10-15', '2026-10-16']
const date = process.argv[2] ?? '2026-10-15'
const dateIndex = sessionDates.indexOf(date)
if (dateIndex < 4) throw new Error(`Need four prior scoped sessions for ${date}`)
const prior = sessionDates.slice(dateIndex - 4, dateIndex)
const previousDate = prior.at(-1)
const symbols = [...new Set(JSON.parse(fs.readFileSync(path.join(root, 'db/stocks'), 'utf8'))
  .map(value => String(value).trim().toUpperCase().replace(/-EQ$/, '')))]
const round = (value, digits = 4) => Number.isFinite(value) ? Number(value.toFixed(digits)) : null
const mean = values => values.reduce((sum, value) => sum + value, 0) / values.length
const priorStart = Date.parse(`${previousDate}T09:15:00+05:30`) / 1000
const priorEnd = Date.parse(`${previousDate}T15:30:00+05:30`) / 1000
const currentStart = Date.parse(`${date}T09:15:00+05:30`) / 1000
const currentEnd = Date.parse(`${date}T09:30:00+05:30`) / 1000

function previousCloseMove(symbol) {
  const file = path.join(root, 'db/candles', `${symbol}.jsonl`)
  const unique = new Map()
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue
    let row
    try { row = JSON.parse(line) } catch { continue }
    if (!Number.isFinite(row.time) || !Number.isFinite(row.close) || row.close <= 0 ||
      !((row.time >= priorStart && row.time < priorEnd) || (row.time >= currentStart && row.time < currentEnd))) continue
    if (!unique.has(row.time)) unique.set(row.time, row)
  }
  const rows = [...unique.values()].sort((a, b) => a.time - b.time)
  const before = rows.filter(row => row.time >= priorStart && row.time < priorEnd).at(-1)
  const now = rows.filter(row => row.time >= currentStart && row.time < currentEnd).at(-1)
  return before && now ? { previousClose: before.close, currentClose: now.close,
    movePct: round(100 * (now.close / before.close - 1), 4) } : null
}

function screen(symbol) {
  const row = { symbol, stage: 0 }
  const file = path.join(root, 'db/candles', `${symbol}.jsonl`)
  if (!fs.existsSync(file)) return { ...row, failure: 'missing candles' }
  const sessions = volumeByDate(symbol, [...prior, date])
  row.completeCandles = [...prior, date].every(day => sessions[day]?.candles === 15)
  if (!row.completeCandles) return { ...row, failure: 'incomplete opening candles' }
  row.previous4AverageVolume = round(mean(prior.map(day => sessions[day].volume)), 2)
  row.volumeTo0930 = sessions[date].volume
  row.volumeChangePct = round(100 * (row.volumeTo0930 / row.previous4AverageVolume - 1), 2)
  if (!(row.volumeChangePct > 0)) return { ...row, failure: 'volume change <= 0%' }
  row.stage = 1
  row.previous4AverageAngleDeg = round(mean(prior.map(day => sessions[day].trendAngleDeg)), 4)
  row.currentAngleDeg = sessions[date].trendAngleDeg
  row.angleChangeDeg = round(row.currentAngleDeg - row.previous4AverageAngleDeg, 4)
  if (!(row.angleChangeDeg > 2)) return { ...row, failure: 'angle change <= 2 degrees' }
  row.stage = 2
  const depth = analyzeDepthSession(symbol, date)
  row.depthAvailable = depth.available
  row.depthObservedMinutes = depth.observedMinutes ?? 0
  row.bidDominantMinutes = depth.bidDominantMinutes ?? null
  row.quoteMidMovePct = depth.quoteMidMovePct ?? null
  row.meanSpreadBps = depth.meanMinuteEndSpreadBps ?? null
  if (!(row.bidDominantMinutes > 4)) return { ...row, failure: 'bid-dominant minutes <= 4 or missing depth' }
  row.stage = 3
  if (!(row.quoteMidMovePct > 0)) return { ...row, failure: 'quote midpoint move <= 0%' }
  row.stage = 4
  if (!(row.meanSpreadBps > 2)) return { ...row, failure: 'average spread <= 2 bps' }
  row.stage = 5
  const previousClose = previousCloseMove(symbol)
  if (!previousClose) return { ...row, failure: 'missing previous close or 09:29 close' }
  Object.assign(row, previousClose)
  if (row.movePct < -0.4) return { ...row, failure: 'previous-close move < -0.4%' }
  row.stage = 6
  const shape = analyzeOpeningCandles(symbol, date)
  row.top2PositiveStepSharePct = shape.top2PositiveStepSharePct
  row.largestBodyPct = shape.largestBodyPct
  row.concentratedCandleExclusion = row.top2PositiveStepSharePct > 48.5 && row.largestBodyPct < 0.65
  if (row.concentratedCandleExclusion) return { ...row, failure: 'concentrated-candle exclusion' }
  row.stage = 7
  return { ...row, eligible: true }
}

const rows = symbols.map(screen)
const stageCounts = Object.fromEntries([1, 2, 3, 4, 5, 6, 7].map(stage => [`afterRule${stage}`, rows.filter(row => row.stage >= stage).length]))
const eligible = rows.filter(row => row.eligible).sort((a, b) => b.angleChangeDeg - a.angleChangeDeg || a.symbol.localeCompare(b.symbol))
const output = { date, cutoffIST: '09:30', universe: 'All unique symbols in db/stocks', priorFourDates: prior,
  previousCloseDate: previousDate, rules: [
    '09:15–09:29 volume > 0% above four-session same-window average',
    '09:15–09:29 log-close trend angle > four-session same-window average by 2 degrees',
    'bid-dominant minute-end five-level books > 4',
    'first-to-last available quote midpoint move > 0%',
    'equal-minute average spread > 2 basis points',
    '09:29 close versus previous session final close >= -0.4%',
    'exclude if top-two positive minute moves share > 48.5% AND largest candle body < 0.65%',
  ],
  method: 'All features and depth events are cut off at 09:30 IST; the thresholds were carried unchanged from the October 16 screen. Each rule is applied sequentially. This is an eligibility replay, not a trade-return backtest.',
  symbolsScanned: symbols.length, stageCounts, eligibleCount: eligible.length,
  eligibleSymbols: eligible.map(row => row.symbol), eligible, rows }
let n = 1, json
do { json = path.join(root, 'reports', `${date}-0930-consolidated-screen-replay${n === 1 ? '' : `-${n}`}.json`); n++ } while (fs.existsSync(json))
fs.writeFileSync(json, JSON.stringify(output, null, 2) + '\n', { flag: 'wx' })
const cols = ['symbol','stage','failure','eligible','volumeChangePct','angleChangeDeg','bidDominantMinutes',
  'quoteMidMovePct','meanSpreadBps','movePct','top2PositiveStepSharePct','largestBodyPct']
const csvVal = value => { const s = value == null ? '' : String(value); return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s }
let csv = json.replace(/\.json$/, '.csv')
fs.writeFileSync(csv, cols.join(',') + '\n' + rows.map(row => cols.map(col => csvVal(row[col])).join(',')).join('\n') + '\n', { flag: 'wx' })
console.log(JSON.stringify({ json, csv, symbolsScanned: symbols.length, stageCounts, eligibleCount: eligible.length, eligible }, null, 2))
