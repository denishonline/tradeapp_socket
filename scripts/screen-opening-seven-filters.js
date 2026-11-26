import fs from 'node:fs'
import path from 'node:path'
import { volumeByDate } from './report-oct16-0930-volume-vs-prior4.js'
import { analyzeDepthSession } from './report-oct16-0930-six-stock-depth-behavior.js'
import { analyzeOpeningCandles } from './analyze-oct16-opening-candle-concentration.js'
import { indicators, aggregate } from './research-ema-coverage.js'

const root = process.cwd()
const sessionDates = fs.readdirSync(path.join(root, 'db', 'cash-depth'), { withFileTypes: true })
  .filter(entry => entry.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(entry.name))
  .map(entry => entry.name).sort()
const args = process.argv.slice(2), date = args[0]
const cutoffIndex = args.indexOf('--cutoff')
const positionalCutoff = args[1] && !args[1].startsWith('--') ? args[1] : null
const cutoff = cutoffIndex >= 0 ? args[cutoffIndex + 1] : (positionalCutoff ?? '09:30')
const followthroughFilter = !args.includes('--no-followthrough-filter')
const knownArgs = new Set([date, positionalCutoff, '--cutoff', cutoffIndex >= 0 ? args[cutoffIndex + 1] : null,
  '--experimental-followthrough', '--no-followthrough-filter'])
if (!date || args.some(arg => !knownArgs.has(arg)) || !/^\d{2}:\d{2}$/.test(cutoff)) {
  throw new Error('Usage: node scripts/screen-opening-seven-filters.js YYYY-MM-DD [HH:MM | --cutoff HH:MM] [--no-followthrough-filter]')
}
const [hour, minute] = cutoff.split(':').map(Number)
const endMinute = hour * 60 + minute
const requestedCandleCount = endMinute - (9 * 60 + 15)
if (requestedCandleCount < 2 || endMinute > 15 * 60 + 30 || minute > 59) {
  throw new Error('Cutoff must be between 09:17 and 15:30 IST, at a whole minute')
}
if (followthroughFilter && endMinute < 9 * 60 + 30) {
  throw new Error('The follow-through rule needs the completed 09:15-09:29 window; use a cutoff of 09:30 or later, or pass --no-followthrough-filter')
}
const dateIndex = sessionDates.indexOf(date)
if (dateIndex < 4) throw new Error(`Need four prior available sessions for ${date}`)
const prior = sessionDates.slice(dateIndex - 4, dateIndex)
const previousDate = prior.at(-1)
function availableWindow() {
  const file = path.join(root, 'db/candles/NIFTY50.jsonl'), minutes = new Set()
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue
    let row
    try { row = JSON.parse(line) } catch { continue }
    const local = new Date(+row.time * 1000 + 330 * 60_000)
    if (!Number.isFinite(+row.time) || local.toISOString().slice(0, 10) !== date) continue
    const value = local.getUTCHours() * 60 + local.getUTCMinutes()
    if (value >= 9 * 60 + 15 && value < endMinute) minutes.add(value)
  }
  const ordered = [...minutes].sort((a, b) => a - b)
  if (!ordered.length) throw new Error(`No ${date} candles found before ${cutoff}`)
  const start = ordered[0], end = ordered.at(-1) + 1
  if (ordered.length !== end - start) throw new Error(`Target candle window has internal gaps on ${date}`)
  return { start, end, count: ordered.length, complete: start === 9 * 60 + 15 && end === endMinute }
}
const targetWindow = availableWindow()
const candleCount = targetWindow.count
const symbols = [...new Set(JSON.parse(fs.readFileSync(path.join(root, 'db/stocks'), 'utf8'))
  .map(value => String(value).trim().toUpperCase().replace(/-EQ$/, '')))]
const round = (value, digits = 4) => Number.isFinite(value) ? Number(value.toFixed(digits)) : null
const mean = values => values.reduce((sum, value) => sum + value, 0) / values.length
const priorStart = Date.parse(`${previousDate}T09:15:00+05:30`) / 1000
const priorEnd = Date.parse(`${previousDate}T15:30:00+05:30`) / 1000
const hhmm = value => `${String(Math.floor(value / 60)).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}`
const currentStart = Date.parse(`${date}T${hhmm(targetWindow.start)}:00+05:30`) / 1000
const currentEnd = Date.parse(`${date}T${hhmm(targetWindow.end)}:00+05:30`) / 1000

function indicatorCandles(symbol, end = Date.parse(`${date}T09:30:00+05:30`) / 1000) {
  const file = path.join(root, 'db/candles', `${symbol}.jsonl`), unique = new Map()
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue
    let raw
    try { raw = JSON.parse(line) } catch { continue }
    if (!Number.isFinite(raw.time) || raw.time < currentStart || raw.time >= end || unique.has(raw.time)) continue
    const candle = { t: raw.time * 1000, o: +raw.open, h: +raw.high, l: +raw.low, c: +raw.close, v: +raw.volume }
    if (Object.values(candle).every(Number.isFinite)) unique.set(raw.time, candle)
  }
  return [...unique.values()].sort((a, b) => a.t - b.t)
}

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
  const sessions = volumeByDate(symbol, [...prior, date], targetWindow.end, targetWindow.start)
  row.completeCandles = [...prior, date].every(day => sessions[day]?.candles === candleCount)
  if (!row.completeCandles) return { ...row, failure: 'incomplete opening candles' }
  row.previous4AverageVolume = round(mean(prior.map(day => sessions[day].volume)), 2)
  row.volumeToCutoff = sessions[date].volume
  row.volumeChangePct = round(100 * (row.volumeToCutoff / row.previous4AverageVolume - 1), 2)
  if (!(row.volumeChangePct > 0)) return { ...row, failure: 'volume change <= 0%' }
  row.stage = 1
  row.previous4AverageAngleDeg = round(mean(prior.map(day => sessions[day].trendAngleDeg)), 4)
  row.currentAngleDeg = sessions[date].trendAngleDeg
  row.angleChangeDeg = round(row.currentAngleDeg - row.previous4AverageAngleDeg, 4)
  if (!(row.angleChangeDeg > 2)) return { ...row, failure: 'angle change <= 2 degrees' }
  row.stage = 2
  const depth = analyzeDepthSession(symbol, date, cutoff)
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
  if (!previousClose) return { ...row, failure: 'missing previous close or last completed close' }
  Object.assign(row, previousClose)
  if (row.movePct < -0.4) return { ...row, failure: 'previous-close move < -0.4%' }
  row.stage = 6
  const shape = analyzeOpeningCandles(symbol, date, hhmm(targetWindow.end))
  if (shape.candles !== candleCount) return { ...row, failure: 'incomplete candle-shape window' }
  row.top2PositiveStepSharePct = shape.top2PositiveStepSharePct
  row.largestBodyPct = shape.largestBodyPct
  row.concentratedCandleExclusion = row.top2PositiveStepSharePct > 48.5 && row.largestBodyPct < 0.65
  if (row.concentratedCandleExclusion) return { ...row, failure: 'concentrated-candle exclusion' }
  row.stage = 7
  if (followthroughFilter) {
    const opening = indicatorCandles(symbol, currentEnd)
    if (opening.length !== candleCount) return { ...row, failure: 'incomplete follow-through candle window' }
    const oneMinute = indicators(opening).at(-1)?.f ?? {}
    const fiveMinute = aggregate(opening, 5).at(-1)?.f ?? {}
    row.followthroughTop2SharePct = row.top2PositiveStepSharePct
    row.followthroughSlope3PctPerMinute = round(oneMinute.slope3, 6)
    row.followthroughFiveMinuteFit3 = round(fiveMinute.fit3, 6)
    row.followthroughExclusion =
      (row.followthroughTop2SharePct < 43.002 && row.followthroughSlope3PctPerMinute > 0.020558) ||
      row.followthroughFiveMinuteFit3 > 0.990772
    if (row.followthroughExclusion) return { ...row, failure: 'opening-followthrough exclusion' }
    row.stage = 8
  }
  return { ...row, eligible: true }
}

const rows = symbols.map(screen)
const finalStage = followthroughFilter ? 8 : 7
const stageCounts = Object.fromEntries(Array.from({ length: finalStage }, (_, i) => i + 1).map(stage => [`afterRule${stage}`, rows.filter(row => row.stage >= stage).length]))
const eligible = rows.filter(row => row.eligible).sort((a, b) => b.angleChangeDeg - a.angleChangeDeg || a.symbol.localeCompare(b.symbol))
const lastCandleDate = new Date(Date.parse(`${date}T${hhmm(targetWindow.end)}:00+05:30`) - 60_000)
const lastCandle = new Date(lastCandleDate.getTime() + 330 * 60_000).toISOString().slice(11, 16)
const window = `${hhmm(targetWindow.start)}-${lastCandle}`
const output = { date, cutoffIST: cutoff, candleWindowIST: window, universe: 'All unique symbols in db/stocks', priorFourDates: prior,
  previousCloseDate: previousDate, rules: [
    `${window} volume > 0% above four-session same-window average`,
    `${window} log-close trend angle > four-session same-window average by 2 degrees`,
    'bid-dominant minute-end five-level books > 4',
    'first-to-last available quote midpoint move > 0%',
    'equal-minute average spread > 2 basis points',
    `last completed close before ${cutoff} versus previous session final close >= -0.4%`,
    'exclude if top-two positive minute moves share > 48.5% AND largest candle body < 0.65%',
    ...(followthroughFilter ? ['OPENING FOLLOW-THROUGH: exclude if (top-two positive-step share < 43.002% AND last-three-minute log-close slope > 0.020558%/minute) OR completed five-minute three-bar trend R-squared > 0.990772'] : []),
  ],
  method: `All features and depth events are cut off at ${cutoff} IST. Candle comparisons use the target session's contiguous available window (${window}) on the target and four prior sessions.${targetWindow.complete ? '' : ' The requested candle window was incomplete in local storage, so unavailable edge minutes were excluded consistently from all five sessions.'} The original thresholds were carried from the October 16 screen. Each rule is applied sequentially. This is an eligibility replay, not a trade-return backtest.${followthroughFilter ? ' The eighth filter was fitted in-sample to six user-marked October 14-15 stocks and is not independently validated.' : ''}`,
  symbolsScanned: symbols.length, stageCounts, eligibleCount: eligible.length,
  eligibleSymbols: eligible.map(row => row.symbol), eligible, rows }
let n = 1, json
const modeSuffix = followthroughFilter ? '-followthrough' : '-seven-rules-only'
do { json = path.join(root, 'reports', `${date}-${cutoff.replace(':', '')}-consolidated-screen-replay${modeSuffix}${n === 1 ? '' : `-${n}`}.json`); n++ } while (fs.existsSync(json) || fs.existsSync(json.replace(/\.json$/, '.csv')))
fs.writeFileSync(json, JSON.stringify(output, null, 2) + '\n', { flag: 'wx' })
const cols = ['symbol','stage','failure','eligible','volumeChangePct','angleChangeDeg','bidDominantMinutes',
  'quoteMidMovePct','meanSpreadBps','movePct','top2PositiveStepSharePct','largestBodyPct',
  'followthroughSlope3PctPerMinute','followthroughFiveMinuteFit3','followthroughExclusion']
const csvVal = value => { const s = value == null ? '' : String(value); return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s }
let csv = json.replace(/\.json$/, '.csv')
fs.writeFileSync(csv, cols.join(',') + '\n' + rows.map(row => cols.map(col => csvVal(row[col])).join(',')).join('\n') + '\n', { flag: 'wx' })
console.log(`Date: ${date} | cutoff: ${cutoff} IST | scanned: ${symbols.length} | eligible: ${eligible.length}`)
console.log(`Passed each rule: ${Object.values(stageCounts).join(' -> ')}`)
console.log(`JSON: ${json}\nCSV: ${csv}`)
console.log('Stock'.padEnd(16) + 'Volume vs prior 4'.padStart(19) + 'Trend-angle change'.padStart(21) + 'Bid-dominant minutes'.padStart(23))
for (const row of eligible) console.log(row.symbol.padEnd(16) + `${row.volumeChangePct.toFixed(2)}%`.padStart(19) + `${row.angleChangeDeg.toFixed(4)} deg`.padStart(21) + String(row.bidDominantMinutes).padStart(23))
