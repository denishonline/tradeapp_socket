import fs from 'node:fs'
import path from 'node:path'
import { volumeByDate } from './report-oct16-0930-volume-vs-prior4.js'
import { analyzeDepthSession } from './report-oct16-0930-six-stock-depth-behavior.js'

const root = process.cwd()
const prior = ['2026-10-12', '2026-10-13', '2026-10-14', '2026-10-15']
const date = '2026-10-16'
const symbols = [...new Set(JSON.parse(fs.readFileSync(path.join(root, 'db/stocks'), 'utf8'))
  .map(value => String(value).trim().toUpperCase().replace(/-EQ$/, '')))]
const round = (value, digits = 4) => Number.isFinite(value) ? Number(value.toFixed(digits)) : null
const mean = values => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null
const unique = (stem, ext) => {
  let n = 1, file
  do { file = path.join(root, 'reports', `${stem}${n === 1 ? '' : `-${n}`}.${ext}`); n++ } while (fs.existsSync(file))
  return file
}

function check(symbol) {
  const candleFile = path.join(root, 'db/candles', `${symbol}.jsonl`)
  if (!fs.existsSync(candleFile)) return { symbol, eligible: false, failures: ['missing candle file'] }
  const sessions = volumeByDate(symbol)
  const completeCandles = [...prior, date].every(day => sessions[day]?.candles === 15)
  const priorVolumeAvg = mean(prior.map(day => sessions[day].volume))
  const volumeChangePct = priorVolumeAvg > 0 ? round(100 * (sessions[date].volume / priorVolumeAvg - 1), 2) : null
  const priorAngleAvg = prior.every(day => Number.isFinite(sessions[day].trendAngleDeg))
    ? mean(prior.map(day => sessions[day].trendAngleDeg)) : null
  const angleChangeDeg = Number.isFinite(priorAngleAvg) && Number.isFinite(sessions[date].trendAngleDeg)
    ? round(sessions[date].trendAngleDeg - priorAngleAvg, 4) : null

  const depth = analyzeDepthSession(symbol, date)
  const minutes = depth.minutes || []
  const aligned = minutes.filter(row => row.minute >= '09:16' && row.minute <= '09:29')
  const fullAlignedDepth = aligned.length === 14 && aligned[0].minute === '09:16' && aligned.at(-1).minute === '09:29'
  const alignedQuoteMidMovePct = fullAlignedDepth ? round(100 * (aligned.at(-1).mid / aligned[0].mid - 1), 3) : null
  const checks = {
    completeCandles,
    volumeChangeAbove0: Number.isFinite(volumeChangePct) && volumeChangePct > 0,
    angleChangeAbove2Deg: Number.isFinite(angleChangeDeg) && angleChangeDeg > 2,
    bidDominantMinutesAbove4: depth.available && depth.bidDominantMinutes > 4,
    quoteMidMoveAbove0: depth.available && depth.quoteMidMovePct > 0,
    meanSpreadAbove2Bps: depth.available && depth.meanMinuteEndSpreadBps > 2,
  }
  const failures = Object.entries(checks).filter(([, passed]) => !passed).map(([name]) => name)
  const eligible = failures.length === 0
  return { symbol, eligible, eligibleWithAlignedMinuteEndQuote: eligible && alignedQuoteMidMovePct > 0,
    checks, failures, previous4AverageVolume: round(priorVolumeAvg, 2),
    volumeTo0930: sessions[date].volume, volumeChangePct,
    previous4AverageAngleDeg: round(priorAngleAvg, 4), october16AngleDeg: sessions[date].trendAngleDeg,
    angleChangeDeg, depthAvailable: depth.available, depthObservedMinutes: depth.observedMinutes ?? 0,
    bidDominantMinutes: depth.bidDominantMinutes ?? null,
    quoteMidMovePct: depth.quoteMidMovePct ?? null,
    alignedQuoteMidMovePct, meanSpreadBps: depth.meanMinuteEndSpreadBps ?? null,
    meanBidSharePct: depth.meanMinuteEndBidSharePct ?? null,
    depthFirstBookAt: depth.firstBookAt ?? null, depthLastBookAt: depth.lastBookAt ?? null }
}

const rows = symbols.map(check)
const eligible = rows.filter(row => row.eligible).sort((a, b) => b.angleChangeDeg - a.angleChangeDeg || a.symbol.localeCompare(b.symbol))
const eligibleAligned = rows.filter(row => row.eligibleWithAlignedMinuteEndQuote)
const checkPassCounts = Object.fromEntries(Object.keys(rows.find(row => row.checks)?.checks || {})
  .map(name => [name, rows.filter(row => row.checks?.[name]).length]))
const output = { date, cutoffIST: '09:30', universe: 'All unique symbols in db/stocks',
  comparisonDates: prior, thresholds: { volumeChangePct: '> 0', angleChangeDeg: '> 2', bidDominantMinutes: '> 4',
    quoteMidMovePct: '> 0', meanSpreadBps: '> 2' },
  method: 'Volume and log-close regression angle use all fifteen one-minute candles from 09:15–09:29 IST on each date. Previous-four-day values are arithmetic means of the four same-window daily values. October 16 depth uses only events received before 09:30. A bid-dominant minute has more displayed bid than ask size across five levels in its last valid book. Quote midpoint move is first valid to last valid October 16 book; average spread weights observed minutes equally. No future data is used to decide the 09:30 screen.',
  sensitivity: 'The aligned alternative compares the 09:16 minute-end and 09:29 minute-end midpoints, requiring fourteen observed minutes. Primary eligibility uses the previously reported first-to-last-book midpoint definition.',
  caveat: 'Displayed depth is not executed buy/sell volume. This is a same-day screen, not a return backtest.',
  symbolsScanned: rows.length, depthAvailable: rows.filter(row => row.depthAvailable).length,
  checkPassCounts, eligibleCount: eligible.length, eligibleAlignedCount: eligibleAligned.length,
  eligibleSymbols: eligible.map(row => row.symbol), eligibleAlignedSymbols: eligibleAligned.map(row => row.symbol), rows }
const stem = '2026-10-16-0930-all-stocks-five-check-screen'
const json = unique(stem, 'json')
fs.writeFileSync(json, JSON.stringify(output, null, 2) + '\n', { flag: 'wx' })
const csv = unique(stem, 'csv')
const columns = ['symbol', 'eligible', 'eligibleWithAlignedMinuteEndQuote', 'volumeTo0930', 'previous4AverageVolume',
  'volumeChangePct', 'october16AngleDeg', 'previous4AverageAngleDeg', 'angleChangeDeg',
  'bidDominantMinutes', 'quoteMidMovePct', 'alignedQuoteMidMovePct', 'meanSpreadBps', 'meanBidSharePct',
  'depthObservedMinutes', 'failures']
const esc = value => { const s = value == null ? '' : String(value); return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s }
fs.writeFileSync(csv, columns.join(',') + '\n' + rows.map(row => columns.map(col => esc(row[col])).join(',')).join('\n') + '\n', { flag: 'wx' })
console.log(JSON.stringify({ json, csv, symbolsScanned: output.symbolsScanned, depthAvailable: output.depthAvailable,
  checkPassCounts, eligibleCount: eligible.length, eligibleAlignedCount: eligibleAligned.length,
  eligible, alignedOnlyDifference: eligible.filter(row => !row.eligibleWithAlignedMinuteEndQuote).map(row => row.symbol) }, null, 2))
