import fs from 'node:fs'
import path from 'node:path'
import { depthUpdateFields } from '../ui/market-depth.js'

const root = process.cwd()
const requests = {
  '2026-11-19': ['VOLTAS', 'AMBER', 'IREDA', 'EICHERMOT', 'M&M', 'MARUTI', 'TVSMOTOR', 'TATATECH'],
  '2026-11-20': ['INDUSINDBK', 'APOLLOHOSP', 'UNIONBANK', 'AXISBANK', 'PERSISTENT', 'BAJFINANCE', 'INDHOTEL']
}
const MINUTE = 60_000
const round = (value, digits = 3) => Number.isFinite(value) ? Number(value.toFixed(digits)) : null
const pct = (to, from) => from ? 100 * (to / from - 1) : null
const clock = at => new Date(at + 330 * MINUTE).toISOString().slice(11, 16)
const readJsonl = file => fs.readFileSync(file, 'utf8').split(/\r?\n/).flatMap(line => {
  if (!line.trim()) return []
  try { return [JSON.parse(line)] } catch { return [] }
})

function candles(symbol, date) {
  const start = Date.parse(`${date}T09:15:00+05:30`), end = Date.parse(`${date}T15:30:00+05:30`)
  let ema10, ema20
  const all = []
  for (const row of readJsonl(path.join(root, 'db', 'candles', `${symbol}.jsonl`))) {
    const at = Number(row.time) * 1000, close = +row.close
    if (!Number.isFinite(at) || !Number.isFinite(close) || at > end) continue
    ema10 = ema10 == null ? close : ema10 + 2 / 11 * (close - ema10)
    ema20 = ema20 == null ? close : ema20 + 2 / 21 * (close - ema20)
    if (at >= start && at < end) all.push({ at, minute: clock(at), open: +row.open, high: +row.high, low: +row.low, close, volume: +row.volume || 0, ema10, ema20 })
  }
  let pv = 0, volume = 0
  return all.map(row => {
    pv += ((row.high + row.low + row.close) / 3) * row.volume
    volume += row.volume
    return { ...row, vwap: volume ? pv / volume : row.close }
  })
}

function depthMinutes(symbol, date) {
  const file = path.join(root, 'db', 'cash-depth', date, symbol, `${symbol}.jsonl`)
  if (!fs.existsSync(file)) return []
  const start = Date.parse(`${date}T09:15:00+05:30`), end = Date.parse(`${date}T09:30:00+05:30`)
  const fields = {}, buckets = new Map()
  let previous = null
  for (const record of readJsonl(file)) {
    const at = Date.parse(record.receivedAt)
    if (!Number.isFinite(at) || at < start || at >= end) continue
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
    const ofi = validPrevious ? (bid >= validPrevious.bid ? bids[0] : 0) - (bid <= validPrevious.bid ? validPrevious.bid1 : 0) - (ask <= validPrevious.ask ? asks[0] : 0) + (ask >= validPrevious.ask ? validPrevious.ask1 : 0) : 0
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
  return [...buckets.values()].sort((a, b) => a.at - b.at).map(x => ({ ...x, minute: clock(x.at), bidShare: x.bidShare / x.snapshots, imbalance: x.imbalance / x.snapshots }))
}

function candidateForIndex(rows, depth, index) {
  const opening = rows.slice(0, index + 1), row = rows[index], direction = 1
  const recent = rows.slice(Math.max(0, index - 2), index + 1)
  const observed = depth.filter(x => x.minute <= row.minute)
  if (!observed.length) return null
  const recentDepth = observed.slice(-3)
  const openingReturn = pct(row.close, rows[0].open)
  const rangeHigh = Math.max(...opening.map(x => x.high)), rangeLow = Math.min(...opening.map(x => x.low))
  const recoveryFromLow = pct(row.close, rangeLow)
  const closeLocation = 100 * (row.close - rangeLow) / (rangeHigh - rangeLow || 1)
  const depthMove = pct(recentDepth.at(-1).lastMid, recentDepth[0].firstMid)
  const weightedBidShare = recentDepth.reduce((sum, x) => sum + x.bidShare * x.snapshots, 0) / recentDepth.reduce((sum, x) => sum + x.snapshots, 0)
  const lastTwoImbalance = observed.slice(-2).reduce((sum, x) => sum + x.imbalance, 0) / Math.min(2, observed.length)
  const lastTwoOfi = observed.slice(-2).reduce((sum, x) => sum + x.ofi, 0)
  const alignedBars = recent.filter(x => direction * (x.close - x.open) > 0).length
  const checks = {
    openingMove: openingReturn >= 0.25 || recoveryFromLow >= 0.50,
    emaTrend: direction * (row.ema10 - row.ema20) > 0,
    emaExpanding: index > 0 && direction * ((row.ema10 - row.ema20) - (rows[index - 1].ema10 - rows[index - 1].ema20)) > 0,
    vwap: direction * (row.close - row.vwap) > 0,
    rangeLocation: direction > 0 ? closeLocation >= 70 : closeLocation <= 30,
    recentCandles: alignedBars >= 2,
    recentReturn: recent.length >= 2 && direction * pct(row.close, recent[0].open) >= 0.15,
    depthPrice: direction * depthMove >= 0.08,
    depthTracksPrice: Math.abs(depthMove - pct(row.close, recent[0].open)) <= 0.55,
    depthPressure: direction > 0 ? (weightedBidShare <= 45 || lastTwoImbalance >= 3 || lastTwoOfi > 0) : (weightedBidShare >= 55 || lastTwoImbalance <= -3 || lastTwoOfi < 0)
  }
  const score = Object.values(checks).filter(Boolean).length
  return { index, direction, score, checks, openingReturn, recoveryFromLow, closeLocation, depthMove, weightedBidShare, lastTwoImbalance, lastTwoOfi, alignedBars }
}

function analyze(symbol, date) {
  const rows = candles(symbol, date), depth = depthMinutes(symbol, date)
  const candidates = rows.flatMap((row, index) => index >= 2 && row.minute >= '09:17' && row.minute <= '09:29' ? [candidateForIndex(rows, depth, index)].filter(Boolean) : [])
  const qualified = candidates.filter(x => x.score >= 8 && x.checks.openingMove && x.checks.vwap && x.checks.rangeLocation && x.checks.recentCandles && x.checks.depthPrice && (x.checks.emaTrend || (x.checks.emaExpanding && x.recoveryFromLow >= 0.50)))
  const chosen = qualified[0] ?? candidates.sort((a, b) => b.score - a.score || a.index - b.index)[0]
  if (!chosen) return { date, symbol, status: 'NO_DATA' }
  const signalBar = rows[chosen.index], entry = rows[chosen.index + 1]
  if (!entry) return { date, symbol, status: 'NO_ENTRY' }
  const direction = chosen.direction, later = rows.slice(chosen.index + 2)
  const eod = rows.at(-1)
  const favorable = later.length ? Math.max(0, ...later.map(x => direction > 0 ? pct(x.high, entry.close) : -pct(x.low, entry.close))) : 0
  const adverse = later.length ? Math.min(0, ...later.map(x => direction > 0 ? pct(x.low, entry.close) : -pct(x.high, entry.close))) : 0
  const ret = direction * pct(eod.close, entry.close)
  return {
    date, symbol, side: direction > 0 ? 'BUY' : 'SELL', status: qualified.length ? 'QUALIFIED' : 'BEST_AVAILABLE',
    signalCandle: signalBar.minute, signalKnownAt: clock(signalBar.at + MINUTE), entryCandle: entry.minute, entryKnownAt: clock(entry.at + MINUTE),
    signalClose: round(signalBar.close), entryPrice: round(entry.close), score: chosen.score,
    openingReturnPct: round(chosen.openingReturn), recoveryFromLowPct: round(chosen.recoveryFromLow), closeLocationPct: round(chosen.closeLocation),
    emaGapBps: round(10_000 * (signalBar.ema10 - signalBar.ema20) / signalBar.close), closeVsVwapPct: round(pct(signalBar.close, signalBar.vwap)),
    depthMidpointMovePct: round(chosen.depthMove), meanBidSharePct: round(chosen.weightedBidShare),
    depthLast2ImbalancePct: round(chosen.lastTwoImbalance), checks: chosen.checks,
    eodReturnPct: round(ret), maximumFavorableExcursionPct: round(favorable), maximumAdverseExcursionPct: round(adverse)
  }
}

const signals = Object.entries(requests).flatMap(([date, symbols]) => symbols.map(symbol => analyze(symbol, date)))
const trades = signals.filter(x => Number.isFinite(x.eodReturnPct))
const byDate = Object.groupBy(trades, x => x.date)
const daily = Object.entries(byDate).map(([date, rows]) => ({ date, trades: rows.length, totalReturnPct: round(rows.reduce((sum, x) => sum + x.eodReturnPct, 0)) }))
const output = {
  method: 'Earliest bullish confirmation after at least three completed opening candles and no later than the 09:29 candle. A candidate scores at least 8/10 and must have an opening continuation or >=0.50% recovery from the session low, close above VWAP in the top 30% of the known opening range, at least two green candles in the latest three, a rising depth midpoint, and either bullish EMA10/20 or a bullishly expanding EMA gap during a recovery. signalKnownAt is the completed signal-candle close; entryKnownAt is the following completed candle close used as entry. Depth uses only received top-five snapshots through the signal candle. If no candidate reaches the gate, the highest-scoring candidate is marked BEST_AVAILABLE.',
  summary: {
    tradeCount: trades.length,
    winRatePct: round(100 * trades.filter(x => x.eodReturnPct > 0).length / trades.length),
    averageReturnPct: round(trades.reduce((sum, x) => sum + x.eodReturnPct, 0) / trades.length),
    totalReturnPct: round(trades.reduce((sum, x) => sum + x.eodReturnPct, 0)),
    maximumAdverseExcursionPct: round(Math.min(...trades.map(x => x.maximumAdverseExcursionPct))),
    worstDay: daily.sort((a, b) => a.totalReturnPct - b.totalReturnPct)[0]
  },
  daily: daily.sort((a, b) => a.date.localeCompare(b.date)), signals
}
let suffix = 1, file
do { file = path.join(root, 'reports', `2026-11-19-and-20-requested-opening-confirmations${suffix === 1 ? '' : `-${suffix}`}.json`); suffix++ } while (fs.existsSync(file))
fs.writeFileSync(file, `${JSON.stringify(output, null, 2)}\n`, { flag: 'wx' })
console.log(JSON.stringify({ file, summary: output.summary, signals: signals.map(x => ({ date: x.date, symbol: x.symbol, side: x.side, status: x.status, signalKnownAt: x.signalKnownAt, entryKnownAt: x.entryKnownAt, score: x.score, eodReturnPct: x.eodReturnPct, maximumAdverseExcursionPct: x.maximumAdverseExcursionPct })) }, null, 2))
