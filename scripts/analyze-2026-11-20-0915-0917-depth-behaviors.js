import fs from 'node:fs'
import path from 'node:path'
import { depthUpdateFields } from '../ui/market-depth.js'

const root = process.cwd()
const args = Object.fromEntries(process.argv.slice(2).flatMap((value, index, all) => value.startsWith('--') ? [[value.slice(2), all[index + 1]?.startsWith('--') || all[index + 1] == null ? true : all[index + 1]]] : []))
const date = args.date ?? '2026-11-20'
const minimumScore = Number(args['min-score'] ?? 8)
const sectorBuckets = JSON.parse(fs.readFileSync(path.join(root, 'db', 'stocks_sector_wise'), 'utf8'))
const fullUniverse = [...new Set(Object.entries(sectorBuckets).flatMap(([key, value]) => key === '_meta' || !Array.isArray(value) ? [] : value))].sort()
const symbols = args.symbols ? String(args.symbols).split(',').map(value => value.trim().replace(/^NSE:/i, '').replace(/-EQ$/i, '').replace(/^TVSMOTORS$/i, 'TVSMOTOR').toUpperCase()).filter(Boolean) : fullUniverse
const MINUTE = 60_000
const start = Date.parse(`${date}T09:15:00+05:30`)
const throughMinute = args.through ?? '09:18'
const end = Date.parse(`${date}T${throughMinute}:00+05:30`) + MINUTE // Includes the through-minute bucket.
const round = (value, digits = 3) => Number.isFinite(value) ? Number(value.toFixed(digits)) : null
const pct = (to, from) => from ? 100 * (to / from - 1) : null
const clock = at => new Date(at + 330 * MINUTE).toISOString().slice(11, 16)

function readJsonl(file) {
  return fs.readFileSync(file, 'utf8').split(/\r?\n/).flatMap(line => {
    if (!line.trim()) return []
    try { return [JSON.parse(line)] } catch { return [] }
  })
}

function quantile(values, probability) {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * probability))]
}

function analyze(symbol) {
  const file = path.join(root, 'db', 'cash-depth', date, symbol, `${symbol}.jsonl`)
  if (!fs.existsSync(file)) return { symbol, status: 'MISSING_DEPTH' }
  const fields = {}, snapshots = []
  let previous = null
  for (const event of readJsonl(file)) {
    const at = Date.parse(event.receivedAt)
    if (!Number.isFinite(at) || at < start || at >= end) continue
    if (event.kind === 'checkpoint') for (const key of Object.keys(fields)) delete fields[key]
    const update = depthUpdateFields(event.data)
    if (!update) continue
    for (const [key, value] of update) fields[key] = value
    const bidPrices = Array.from({ length: 5 }, (_, i) => Number(fields[`bid_price${i + 1}`]))
    const askPrices = Array.from({ length: 5 }, (_, i) => Number(fields[`ask_price${i + 1}`]))
    const bids = Array.from({ length: 5 }, (_, i) => Number(fields[`bid_size${i + 1}`]))
    const asks = Array.from({ length: 5 }, (_, i) => Number(fields[`ask_size${i + 1}`]))
    if (![...bidPrices, ...askPrices, ...bids, ...asks].every(Number.isFinite) || bidPrices[0] <= 0 || askPrices[0] <= bidPrices[0]) continue
    const bidTotal = bids.reduce((sum, x) => sum + x, 0), askTotal = asks.reduce((sum, x) => sum + x, 0)
    const ofi = previous && at - previous.at <= 90_000
      ? (bidPrices[0] >= previous.bid ? bids[0] : 0) - (bidPrices[0] <= previous.bid ? previous.bid1 : 0)
        - (askPrices[0] <= previous.ask ? asks[0] : 0) + (askPrices[0] >= previous.ask ? previous.ask1 : 0)
      : 0
    snapshots.push({ at, minute: clock(at), bid: bidPrices[0], ask: askPrices[0], mid: (bidPrices[0] + askPrices[0]) / 2,
      spreadBps: 10_000 * (askPrices[0] - bidPrices[0]) / ((bidPrices[0] + askPrices[0]) / 2), bid1: bids[0], ask1: asks[0],
      bidTotal, askTotal, bidShare: 100 * bidTotal / (bidTotal + askTotal || 1), ofi })
    previous = { at, bid: bidPrices[0], ask: askPrices[0], bid1: bids[0], ask1: asks[0] }
  }
  if (snapshots.length < 4) return { symbol, status: 'INSUFFICIENT_VALID_SNAPSHOTS', snapshots: snapshots.length }
  const first = snapshots[0], last = snapshots.at(-1), mids = snapshots.map(x => x.mid)
  const grouped = Map.groupBy(snapshots, row => row.minute)
  const minutes = [...grouped.keys()].sort().map(minute => {
    const values = grouped.get(minute)
    return { minute, first: values[0], last: values.at(-1), averageBid: values.reduce((sum, x) => sum + x.bid, 0) / values.length,
      averageMid: values.reduce((sum, x) => sum + x.mid, 0) / values.length, averageBidTotal: values.reduce((sum, x) => sum + x.bidTotal, 0) / values.length,
      averageAskTotal: values.reduce((sum, x) => sum + x.askTotal, 0) / values.length }
  })
  const maxMid = Math.max(...mids), drawdownBps = 10_000 * (last.mid / maxMid - 1)
  const bidUpMoves = snapshots.slice(1).filter((row, index) => row.bid > snapshots[index].bid).length
  const bidDownMoves = snapshots.slice(1).filter((row, index) => row.bid < snapshots[index].bid).length
  const askUpMoves = snapshots.slice(1).filter((row, index) => row.ask > snapshots[index].ask).length
  const askDownMoves = snapshots.slice(1).filter((row, index) => row.ask < snapshots[index].ask).length
  const minBidTotalRatio = Math.min(...minutes.map(x => x.averageBidTotal)) / minutes[0].averageBidTotal
  const maxAskTotalRatio = Math.max(...minutes.map(x => x.averageAskTotal)) / minutes[0].averageAskTotal
  const metrics = {
    midpointMovePct: round(pct(last.mid, first.mid)), bestBidMovePct: round(pct(last.bid, first.bid)), bestAskMovePct: round(pct(last.ask, first.ask)),
    ofi: round(snapshots.reduce((sum, x) => sum + x.ofi, 0)), bidUpMoves, bidDownMoves, askUpMoves, askDownMoves,
    minBidTotalRatio: round(minBidTotalRatio), maxAskTotalRatio: round(maxAskTotalRatio), finalBidSharePct: round(last.bidShare),
    firstSpreadBps: round(first.spreadBps), finalSpreadBps: round(last.spreadBps), p90SpreadBps: round(quantile(snapshots.map(x => x.spreadBps), 0.9)), midpointDrawdownBps: round(drawdownBps), snapshots: snapshots.length
  }
  const checks = {
    midpointStairStepHigher: last.mid > first.mid && minutes.every((row, index) => !index || row.averageMid >= minutes[index - 1].averageMid),
    bestBidStepsHigher: last.bid > first.bid && bidUpMoves > bidDownMoves,
    bidRefillsAtHigherLevels: last.bid1 >= first.bid1 * 0.70 && minBidTotalRatio >= 0.70,
    offersAbsorbed: snapshots.filter(x => x.ofi > 0).length > snapshots.filter(x => x.ofi < 0).length,
    noPersistentAskWall: maxAskTotalRatio <= 1.50,
    asksRetreatUpward: last.ask >= first.ask && askUpMoves >= askDownMoves,
    topFiveBidSupportStable: minBidTotalRatio >= 0.70,
    positiveOrderFlowImbalance: snapshots.reduce((sum, x) => sum + x.ofi, 0) > 0,
    spreadOrderly: last.spreadBps <= first.spreadBps * 1.25 && quantile(snapshots.map(x => x.spreadBps), 0.9) <= first.spreadBps * 1.50,
    noAdverseDepthReversal: drawdownBps >= -5
  }
  return { symbol, status: 'OK', count: Object.values(checks).filter(Boolean).length, checks, metrics,
    minuteSummary: minutes.map(x => ({ minute: x.minute, midpoint: round(x.last.mid), bestBid: round(x.last.bid), bestAsk: round(x.last.ask), bidDepth: round(x.averageBidTotal), askDepth: round(x.averageAskTotal) })) }
}

if (!Number.isInteger(minimumScore) || minimumScore < 0 || minimumScore > 10) throw new Error('--min-score must be an integer from 0 to 10.')
const stocks = symbols.map(analyze)
const passing = stocks.filter(row => row.status === 'OK' && row.count >= minimumScore).sort((a, b) => b.count - a.count || a.symbol.localeCompare(b.symbol))
const report = {
  date, universeCount: symbols.length, minimumScore, windowIST: `09:15:00 inclusive through ${throughMinute}:59; completed depth snapshots`,
  warning: 'These are displayed-quote behaviors, not exchange-confirmed executed buying. They can be cancelled or spoofed; the count is a descriptive depth-quality score, not a trade recommendation.',
  definitions: {
    midpointStairStepHigher: 'Final midpoint higher and minute-average midpoint never falls.',
    bestBidStepsHigher: 'Final best bid higher; bid upward quote moves outnumber downward moves.',
    bidRefillsAtHigherLevels: 'Final best-bid size and each minute average top-five bid depth retain >=70% of initial values.',
    offersAbsorbed: 'Positive quote-derived OFI observations outnumber negative observations.',
    noPersistentAskWall: 'No minute-average top-five ask depth exceeds 150% of its initial value.',
    asksRetreatUpward: 'Final best ask is no lower; upward ask quote moves are at least downward moves.',
    topFiveBidSupportStable: 'Top-five bid depth never falls below 70% of initial minute-average depth.',
    positiveOrderFlowImbalance: 'Cumulative quote-derived OFI is positive.',
    spreadOrderly: 'Final spread <=125% and p90 spread <=150% of the initial spread.',
    noAdverseDepthReversal: 'Final midpoint is no more than 5 bps below its intrawindow high.'
  },
  passing, stocks
}
let suffix = 1, file
do { file = path.join(root, 'reports', `${date}-0915-${throughMinute.replace(':', '')}-bullish-depth-behaviors${suffix === 1 ? '' : `-${suffix}`}.json`); suffix++ } while (fs.existsSync(file))
fs.writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' })
console.log(`Scanned ${symbols.length} stocks; ${passing.length} passed >=${minimumScore}/10.`)
console.table(passing.map(row => ({ Stock: row.symbol, 'Count / 10': row.count, 'Midpoint %': row.metrics.midpointMovePct, 'Bid %': row.metrics.bestBidMovePct, OFI: row.metrics.ofi, 'Spread bps': row.metrics.finalSpreadBps })))
console.log(`Report: ${file}`)
