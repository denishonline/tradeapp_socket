import fs from 'node:fs'
import path from 'node:path'
import { depthUpdateFields } from '../ui/market-depth.js'

// Examples:
// node scripts/scan-opening-confirmations-at-cutoff.js --cutoff "2026-11-20 09:24"
// node scripts/scan-opening-confirmations-at-cutoff.js --cutoff "2026-11-20T09:24:00+05:30" --symbols INDUSINDBK,AXISBANK
// Add --no-save to avoid creating a report, or --json to also print full JSON.

const root = process.cwd()
const MINUTE = 60_000

function args() {
  const parsed = {}
  for (let i = 2; i < process.argv.length; i++) {
    const item = process.argv[i]
    if (!item.startsWith('--')) continue
    const key = item.slice(2)
    parsed[key] = process.argv[i + 1]?.startsWith('--') || process.argv[i + 1] == null ? true : process.argv[++i]
  }
  return parsed
}

function parseCutoff(value) {
  if (!value) throw new Error('Missing --cutoff. Example: --cutoff "2026-11-20 09:24"')
  const normalized = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}$/.test(value)
    ? `${value.replace(' ', 'T')}:00+05:30`
    : value
  const at = Date.parse(normalized)
  if (!Number.isFinite(at)) throw new Error(`Invalid --cutoff: ${value}`)
  return at
}

const options = args()
const cutoffAt = parseCutoff(options.cutoff)
const cutoffDate = new Date(cutoffAt + 330 * MINUTE).toISOString().slice(0, 10)
const sectorBuckets = JSON.parse(fs.readFileSync(path.join(root, 'db', 'stocks_sector_wise'), 'utf8'))
const fullUniverse = [...new Set(Object.entries(sectorBuckets).flatMap(([key, value]) => key === '_meta' || !Array.isArray(value) ? [] : value))].sort()
const symbols = options.symbols
  ? String(options.symbols).split(',').map(x => x.trim().replace(/^NSE:/i, '').replace(/-EQ$/i, '').toUpperCase()).filter(Boolean)
  : fullUniverse
if (!symbols.length) throw new Error('The stock universe is empty.')

const sessionStart = Date.parse(`${cutoffDate}T09:15:00+05:30`)
const signalWindowEnd = Date.parse(`${cutoffDate}T09:30:00+05:30`)
if (cutoffAt < sessionStart) throw new Error('Cutoff is before the 09:15 IST session start.')

const round = (value, digits = 3) => Number.isFinite(value) ? Number(value.toFixed(digits)) : null
const pct = (to, from) => from ? 100 * (to / from - 1) : null
const istStamp = at => new Date(at + 330 * MINUTE).toISOString().slice(0, 19).replace('T', ' ')
const clock = at => istStamp(at).slice(11, 16)
const readJsonl = file => fs.readFileSync(file, 'utf8').split(/\r?\n/).flatMap(line => {
  if (!line.trim()) return []
  try { return [JSON.parse(line)] } catch { return [] }
})

function loadCompletedCandles(symbol) {
  const file = path.join(root, 'db', 'candles', `${symbol}.jsonl`)
  if (!fs.existsSync(file)) return { current: [], sessions: new Map() }
  let ema10, ema20
  const session = [], sessions = new Map()
  for (const row of readJsonl(file)) {
    const at = Number(row.time) * 1000, completedAt = at + MINUTE, close = +row.close
    if (!Number.isFinite(at) || !Number.isFinite(close) || completedAt > cutoffAt) continue
    ema10 = ema10 == null ? close : ema10 + 2 / 11 * (close - ema10)
    ema20 = ema20 == null ? close : ema20 + 2 / 21 * (close - ema20)
    const stamp = istStamp(at), date = stamp.slice(0, 10), minute = stamp.slice(11, 16)
    const item = { at, completedAt, date, minute, open: +row.open, high: +row.high, low: +row.low, close, volume: +row.volume || 0, ema10, ema20 }
    if (minute >= '09:15' && minute <= '15:29') {
      if (!sessions.has(date)) sessions.set(date, [])
      sessions.get(date).push(item)
    }
    if (at >= sessionStart && at < signalWindowEnd) {
      session.push(item)
    }
  }
  let priceVolume = 0, volume = 0
  const current = session.map(row => {
    priceVolume += ((row.high + row.low + row.close) / 3) * row.volume
    volume += row.volume
    return { ...row, vwap: volume ? priceVolume / volume : row.close }
  })
  return { current, sessions }
}

function windowMetrics(rows, count) {
  const window = rows.filter(x => x.minute >= '09:15').slice(0, count)
  if (window.length !== count) return null
  const high = Math.max(...window.map(x => x.high)), low = Math.min(...window.map(x => x.low)), last = window.at(-1)
  const volume = window.reduce((sum, x) => sum + x.volume, 0)
  const path = window.slice(1).reduce((sum, x, index) => sum + Math.abs(x.close - window[index].close), 0)
  return { returnPct: pct(last.close, window[0].open), volume, rangePct: pct(high, low), efficiency: Math.abs(last.close - window[0].open) / (path || Math.abs(last.close - window[0].open) || 1) }
}

function priorComparisons(loaded, index) {
  const count = index + 1, current = windowMetrics(loaded.current, count)
  const previousDates = [...loaded.sessions.keys()].filter(date => date < cutoffDate).sort().slice(-10)
  const prior = previousDates.map(date => windowMetrics(loaded.sessions.get(date), count)).filter(Boolean)
  if (!current || prior.length < 10) return null
  const mean = values => values.reduce((sum, value) => sum + value, 0) / values.length
  const result = { efficiency: round(current.efficiency), returnVsMax10Pct: round(current.returnPct - Math.max(...prior.map(x => x.returnPct))) }
  for (const n of [1, 3, 5, 10]) {
    const sample = prior.slice(-n)
    result[`beatReturnCount${n}`] = sample.filter(x => current.returnPct > x.returnPct).length
    result[`volumeRatio${n}`] = round(current.volume / mean(sample.map(x => x.volume)))
    result[`rangeRatio${n}`] = round(current.rangePct / mean(sample.map(x => x.rangePct)))
  }
  return result
}

function loadDepthMinutes(symbol) {
  const file = path.join(root, 'db', 'cash-depth', cutoffDate, symbol, `${symbol}.jsonl`)
  if (!fs.existsSync(file)) return []
  const fields = {}, buckets = new Map()
  let previous = null
  for (const record of readJsonl(file)) {
    const at = Date.parse(record.receivedAt)
    if (!Number.isFinite(at) || at < sessionStart || at > cutoffAt || at >= signalWindowEnd) continue
    if (record.kind === 'checkpoint') for (const key of Object.keys(fields)) delete fields[key]
    const update = depthUpdateFields(record.data)
    if (!update) continue
    for (const [key, value] of update) fields[key] = value
    const bids = Array.from({ length: 5 }, (_, i) => Number(fields[`bid_size${i + 1}`]))
    const asks = Array.from({ length: 5 }, (_, i) => Number(fields[`ask_size${i + 1}`]))
    const bid = Number(fields.bid_price1), ask = Number(fields.ask_price1)
    if (![...bids, ...asks, bid, ask].every(Number.isFinite) || bid <= 0 || ask <= bid) continue
    const bidSum = bids.reduce((a, b) => a + b, 0), askSum = asks.reduce((a, b) => a + b, 0)
    const validPrevious = previous && at - previous.at <= 90_000 ? previous : null
    const ofi = validPrevious
      ? (bid >= validPrevious.bid ? bids[0] : 0) - (bid <= validPrevious.bid ? validPrevious.bid1 : 0)
        - (ask <= validPrevious.ask ? asks[0] : 0) + (ask >= validPrevious.ask ? validPrevious.ask1 : 0)
      : 0
    const minuteAt = Math.floor(at / MINUTE) * MINUTE
    const bucket = buckets.get(minuteAt) ?? { at: minuteAt, snapshots: 0, bidShare: 0, imbalance: 0, ofi: 0, firstMid: (bid + ask) / 2, lastMid: (bid + ask) / 2 }
    bucket.snapshots++
    bucket.bidShare += 100 * bidSum / (bidSum + askSum || 1)
    bucket.imbalance += 100 * (bidSum - askSum) / (bidSum + askSum || 1)
    bucket.ofi += ofi
    bucket.lastMid = (bid + ask) / 2
    buckets.set(minuteAt, bucket)
    previous = { at, bid, ask, bid1: bids[0], ask1: asks[0] }
  }
  return [...buckets.values()].sort((a, b) => a.at - b.at).map(x => ({
    ...x, minute: clock(x.at), bidShare: x.bidShare / x.snapshots, imbalance: x.imbalance / x.snapshots
  }))
}

function scoreCandidate(rows, depth, index) {
  const opening = rows.slice(0, index + 1), row = rows[index]
  const recent = rows.slice(Math.max(0, index - 2), index + 1)
  const observed = depth.filter(x => x.at < row.completedAt)
  const recentDepth = observed.slice(-3)
  if (recent.length < 3 || !recentDepth.length) return null
  const openingReturn = pct(row.close, rows[0].open)
  const rangeHigh = Math.max(...opening.map(x => x.high)), rangeLow = Math.min(...opening.map(x => x.low))
  const recoveryFromLow = pct(row.close, rangeLow)
  const closeLocation = 100 * (row.close - rangeLow) / (rangeHigh - rangeLow || 1)
  const recentReturn = pct(row.close, recent[0].open)
  const depthMove = pct(recentDepth.at(-1).lastMid, recentDepth[0].firstMid)
  const snapshots = recentDepth.reduce((sum, x) => sum + x.snapshots, 0)
  const bidShare = recentDepth.reduce((sum, x) => sum + x.bidShare * x.snapshots, 0) / snapshots
  const lastTwo = recentDepth.slice(-2)
  const lastTwoImbalance = lastTwo.reduce((sum, x) => sum + x.imbalance, 0) / lastTwo.length
  const lastTwoOfi = lastTwo.reduce((sum, x) => sum + x.ofi, 0)
  const checks = {
    openingMove: openingReturn >= 0.25 || recoveryFromLow >= 0.50,
    emaTrend: row.ema10 > row.ema20,
    emaExpanding: index > 0 && (row.ema10 - row.ema20) > (rows[index - 1].ema10 - rows[index - 1].ema20),
    vwap: row.close > row.vwap,
    rangeLocation: closeLocation >= 70,
    recentCandles: recent.filter(x => x.close > x.open).length >= 2,
    recentReturn: recentReturn >= 0.15,
    depthPrice: depthMove >= 0.08,
    depthTracksPrice: Math.abs(depthMove - recentReturn) <= 0.55,
    depthPressure: bidShare <= 45 || lastTwoImbalance >= 3 || lastTwoOfi > 0
  }
  const score = Object.values(checks).filter(Boolean).length
  const qualified = score >= 8 && checks.openingMove && checks.vwap && checks.rangeLocation && checks.recentCandles && checks.depthPrice
    && (checks.emaTrend || (checks.emaExpanding && recoveryFromLow >= 0.50))
  return { index, score, qualified, checks, openingReturn, recoveryFromLow, closeLocation, recentReturn, depthMove, bidShare, lastTwoImbalance }
}

function scan(symbol) {
  const loaded = loadCompletedCandles(symbol), rows = loaded.current, depth = loadDepthMinutes(symbol)
  if (!rows.length) return { symbol, status: 'NO_COMPLETED_CANDLES' }
  if (!depth.length) return { symbol, status: 'NO_DEPTH' }
  const candidates = rows.flatMap((row, index) => index >= 2 && row.minute <= '09:29' ? [scoreCandidate(rows, depth, index)].filter(Boolean) : [])
  const chosen = candidates.find(x => x.qualified)
  const watch = chosen ? null : candidates.sort((a, b) => b.score - a.score || a.index - b.index)[0]
  const selected = chosen ?? watch
  if (!selected) return { symbol, status: 'NO_CANDIDATE_BY_CUTOFF' }
  const signal = rows[selected.index], entry = rows[selected.index + 1]
  const prior = priorComparisons(loaded, selected.index)
  return {
    symbol,
    status: chosen ? (entry ? 'ENTRY_READY' : 'SIGNAL_CONFIRMED_ENTRY_PENDING') : 'WATCH_ONLY_NOT_QUALIFIED',
    side: 'BUY', score: selected.score,
    signalCandle: signal.minute, signalKnownAt: istStamp(signal.completedAt),
    entryCandle: entry?.minute ?? null, entryKnownAt: entry ? istStamp(entry.completedAt) : null, entryPrice: entry ? round(entry.close) : null,
    signalClose: round(signal.close), openingReturnPct: round(selected.openingReturn), recoveryFromLowPct: round(selected.recoveryFromLow),
    closeLocationPct: round(selected.closeLocation), recentReturnPct: round(selected.recentReturn),
    emaGapBps: round(10_000 * (signal.ema10 - signal.ema20) / signal.close), closeVsVwapPct: round(pct(signal.close, signal.vwap)),
    depthMidpointMovePct: round(selected.depthMove), meanBidSharePct: round(selected.bidShare), depthLast2ImbalancePct: round(selected.lastTwoImbalance),
    prior,
    checks: selected.checks
  }
}

const results = symbols.map(scan).sort((a, b) =>
  (a.signalKnownAt ?? '9999').localeCompare(b.signalKnownAt ?? '9999') || a.symbol.localeCompare(b.symbol))
for (const row of results) {
  if (!row.signalKnownAt) continue
  const peers = results.filter(peer => peer.signalKnownAt === row.signalKnownAt && Number.isFinite(peer.openingReturnPct))
  row.openingReturnRank = 1 + peers.filter(peer => peer.openingReturnPct > row.openingReturnPct).length
  const p = row.prior
  row.automaticAPlus = Boolean(p && row.score === 10 && row.openingReturnPct >= 0.5 && p.beatReturnCount5 === 5 && p.beatReturnCount10 >= 9
    && p.efficiency >= 1.3 && p.rangeRatio10 >= 1.2 && p.volumeRatio10 >= 0.7 && p.volumeRatio10 <= 3
    && row.openingReturnRank <= 55 && row.depthMidpointMovePct >= 0.5 && row.meanBidSharePct <= 53 && p.returnVsMax10Pct <= 1)
}
const strictSignals = results.filter(row => row.status === 'ENTRY_READY' || row.status === 'SIGNAL_CONFIRMED_ENTRY_PENDING')
const automaticSignals = strictSignals.filter(row => row.automaticAPlus)
const report = {
  cutoffIST: istStamp(cutoffAt),
  date: cutoffDate,
  universeSource: options.symbols ? '--symbols' : 'db/stocks_sector_wise',
  universeCount: symbols.length,
  strictSignalCount: strictSignals.length,
  automaticAPlusCount: automaticSignals.length,
  rule: 'All 215 stocks are scanned chronologically. The default table displays every Base Momentum signal: the strict 8/10 point-in-time confirmation with a next-completed-candle entry. Recovery watches and failed candidates are excluded unless --show-all is used. A+ is a diagnostic tag only and does not affect inclusion. Only data known by cutoff is used.',
  results
}

let reportFile = path.join(root, 'reports', `${cutoffDate}-${clock(cutoffAt).replace(':', '')}-opening-confirmations-cutoff.json`), suffix = 2
while (fs.existsSync(reportFile)) reportFile = path.join(root, 'reports', `${cutoffDate}-${clock(cutoffAt).replace(':', '')}-opening-confirmations-cutoff-${suffix++}.json`)
if (!options['no-save']) fs.writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' })
const displayedRows = options['show-all'] ? results : strictSignals
const table = displayedRows.map(row => ({
  Symbol: row.symbol,
  Side: row.side ?? '-',
  Status: row.status,
  Score: row.score ?? '-',
  'Signal known IST': row.signalKnownAt?.slice(11, 16) ?? '-',
  'Entry known IST': row.entryKnownAt?.slice(11, 16) ?? '-',
  'Entry price': row.entryPrice ?? '-',
  'Open/Recovery %': row.openingReturnPct == null ? '-' : `${row.openingReturnPct}/${row.recoveryFromLowPct}`,
  'Depth move %': row.depthMidpointMovePct ?? '-',
  'A+': row.automaticAPlus ? 'YES' : '-'
}))
console.log(`Opening confirmations at ${report.cutoffIST} IST`)
console.log(`Scanned ${symbols.length} stocks; found ${strictSignals.length} Base Momentum signals and ${automaticSignals.length} automatic A+ tags; displaying ${displayedRows.length} ${options['show-all'] ? 'scan statuses' : 'passing signals'}.`)
if (automaticSignals.length) console.log(`Automatic A+: ${automaticSignals.map(row => `${row.signalKnownAt.slice(11, 16)} ${row.symbol}`).join(', ')}`)
if (!options.quiet) console.table(table)
console.log(options['no-save'] ? 'Report not saved (--no-save).' : `Detailed report: ${reportFile}`)
if (options.json) console.log(JSON.stringify({ ...report, reportFile: options['no-save'] ? null : reportFile }, null, 2))
