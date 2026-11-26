import fs from 'node:fs'
import path from 'node:path'
import { analyzeDepthSession } from './report-oct16-0930-six-stock-depth-behavior.js'
import { analyzeOpeningCandles } from './analyze-oct16-opening-candle-concentration.js'

const root = process.cwd()
const cases = [
  ['2026-10-12', []],
  ['2026-10-13', []],
  ['2026-10-14', ['BSE', 'TATAELXSI']],
  ['2026-10-15', ['PGEL', 'PERSISTENT', 'CAMS', 'LICI']],
  ['2026-10-16', []],
]
const unwanted = new Set(cases.flatMap(([date, symbols]) => symbols.map(symbol => `${date}:${symbol}`)))
const round = (n, places = 3) => Number.isFinite(n) ? Number(n.toFixed(places)) : null
const pct = (a, b) => 100 * (a / b - 1)
const mean = xs => xs.reduce((a, b) => a + b, 0) / xs.length

function candles(symbol, date) {
  const start = Date.parse(`${date}T09:15:00+05:30`) / 1000
  const end = Date.parse(`${date}T15:30:00+05:30`) / 1000
  const unique = new Map()
  const file = path.join(root, 'db/candles', `${symbol}.jsonl`)
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!line) continue
    let row
    try { row = JSON.parse(line) } catch { continue }
    if (row.time >= start && row.time < end && !unique.has(row.time)) unique.set(row.time, row)
  }
  return [...unique.values()].sort((a, b) => a.time - b.time)
}

const rows = []
for (const [date] of cases) {
  const experimentalFile = path.join(root, 'reports', `${date}-0930-consolidated-screen-replay-experimental-followthrough.json`)
  const baseFile = path.join(root, 'reports', `${date}-0930-consolidated-screen-replay.json`)
  const screen = JSON.parse(fs.readFileSync(fs.existsSync(experimentalFile) ? experimentalFile : baseFile, 'utf8'))
  for (const candidate of screen.rows.filter(row => row.stage >= 7)) {
    const { symbol } = candidate
    const bars = candles(symbol, date)
    const opening = bars.slice(0, 15)
    if (opening.length !== 15) throw new Error(`Missing opening candles: ${date} ${symbol}`)
    const closes = opening.map(r => r.close)
    const peak = Math.max(...opening.map(r => r.high))
    const trough = Math.min(...opening.map(r => r.low))
    const early = opening.slice(0, 10)
    const late = opening.slice(10)
    const last = opening.at(-1).close
    const openingReturn = pct(last, opening[0].open)
    const pathLength = opening.reduce((sum, r, i) => sum + Math.abs(Math.log(r.close / (i ? opening[i - 1].close : r.open))), 0)
    const drawdown = opening.reduce((state, r) => {
      state.peak = Math.max(state.peak, r.high)
      state.max = Math.min(state.max, pct(r.low, state.peak))
      return state
    }, { peak: opening[0].open, max: 0 }).max
    const depth = analyzeDepthSession(symbol, date)
    const depthMinutes = depth.minutes ?? []
    const shape = analyzeOpeningCandles(symbol, date)
    const post = bars.filter(r => r.time >= Date.parse(`${date}T09:30:00+05:30`) / 1000)
    const to = time => bars.find(r => r.time === Date.parse(`${date}T${time}:00+05:30`) / 1000)?.close
    const firstHour = post.filter(r => r.time < Date.parse(`${date}T10:30:00+05:30`) / 1000)
    rows.push({ date, symbol, unwanted: unwanted.has(`${date}:${symbol}`), experimentalExcluded: Boolean(candidate.experimentalFollowthroughExclusion),
      openReturnPct: round(openingReturn), prePeakToClosePct: round(pct(last, peak)),
      preLowToClosePct: round(pct(last, trough)), preMaxDrawdownPct: round(drawdown),
      prePathEfficiencyPct: round(100 * Math.abs(Math.log(last / opening[0].open)) / pathLength),
      first10ReturnPct: round(pct(early.at(-1).close, early[0].open)),
      last5ReturnPct: round(pct(late.at(-1).close, late[0].close)),
      last3ReturnPct: round(pct(last, opening[11].close)),
      last5VolumeSharePct: round(100 * late.reduce((s, r) => s + r.volume, 0) / opening.reduce((s, r) => s + r.volume, 0)),
      redMinutes: opening.filter(r => r.close < r.open).length,
      downSteps: opening.filter((r, i) => r.close < (i ? opening[i - 1].close : r.open)).length,
      avgLast5BidSharePct: depthMinutes.length >= 5 ? round(mean(depthMinutes.slice(-5).map(r => r.bidSharePct))) : null,
      avgFirst5BidSharePct: depthMinutes.length >= 5 ? round(mean(depthMinutes.slice(0, 5).map(r => r.bidSharePct))) : null,
      last5BidDominantMinutes: depthMinutes.slice(-5).filter(r => r.bidSharePct > 50).length,
      last5MidMovePct: depthMinutes.length >= 6 ? round(pct(depthMinutes.at(-1).mid, depthMinutes.at(-6).mid)) : null,
      depthFirstToLastBidShareChange: round(depth.lastBidSharePct - depth.firstBidSharePct),
      top2PositiveStepSharePct: shape.top2PositiveStepSharePct,
      largestBodyPct: shape.largestBodyPct,
      volumeChangePct: candidate.volumeChangePct,
      angleChangeDeg: candidate.angleChangeDeg,
      previousCloseMovePct: candidate.movePct,
      quoteMidMovePct: candidate.quoteMidMovePct,
      bidDominantMinutes: candidate.bidDominantMinutes,
      close1000Vs0929Pct: round(pct(to('09:59'), last)),
      close1030Vs0929Pct: round(pct(to('10:29'), last)),
      close1100Vs0929Pct: round(pct(to('10:59'), last)),
      dayCloseVs0929Pct: round(pct(bars.at(-1).close, last)),
      firstHourMaxHighPct: round(pct(Math.max(...firstHour.map(r => r.high)), last)),
      firstHourMinLowPct: round(pct(Math.min(...firstHour.map(r => r.low)), last)),
      firstHourRedMinutes: firstHour.filter(r => r.close < r.open).length,
    })
  }
}
const output = { method: 'Pre-09:30 features use candles and depth available by 09:30 IST. Later candle moves are descriptive outcomes only and are not inputs to any signal.', rows }
const features = Object.keys(rows[0]).filter(key => typeof rows[0][key] === 'number' && !key.startsWith('close') &&
  !key.startsWith('dayClose') && !key.startsWith('firstHour'))
const conditions = []
for (const feature of features) {
  const values = [...new Set(rows.map(row => row[feature]))].sort((a, b) => a - b)
  for (const threshold of values.slice(0, -1).map((value, i) => (value + values[i + 1]) / 2)) {
    for (const direction of ['<', '>']) {
      const selected = rows.filter(row => direction === '<' ? row[feature] < threshold : row[feature] > threshold)
      const removed = selected.filter(row => row.unwanted)
      const collateral = selected.filter(row => !row.unwanted)
      if (removed.length && !collateral.length) conditions.push({ feature, direction, threshold: round(threshold),
        removed: removed.map(row => `${row.date}:${row.symbol}`) })
    }
  }
}
output.zeroCollateralSingleConditions = conditions.sort((a, b) => b.removed.length - a.removed.length).slice(0, 30)
let n = 1, file
do { file = path.join(root, 'reports', `2026-10-12-to-16-0930-opening-followthrough-analysis${n === 1 ? '' : `-${n}`}.json`); n++ } while (fs.existsSync(file))
fs.writeFileSync(file, JSON.stringify(output, null, 2) + '\n', { flag: 'wx' })
console.log(JSON.stringify({ file, rows }, null, 2))
