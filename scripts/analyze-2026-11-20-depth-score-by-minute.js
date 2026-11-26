import fs from 'node:fs'
import path from 'node:path'

const root = process.cwd(), date = '2026-11-20', minuteMs = 60_000
const symbols = ['INDUSINDBK', 'APOLLOHOSP', 'UNIONBANK', 'AXISBANK', 'PERSISTENT', 'BAJFINANCE', 'INDHOTEL']
const throughMinutes = Array.from({ length: 11 }, (_, index) => `09:${String(15 + index).padStart(2, '0')}`)
const start = Date.parse(`${date}T09:15:00+05:30`), end = Date.parse(`${date}T09:26:00+05:30`)
const round = (x, p = 3) => Number.isFinite(x) ? Number(x.toFixed(p)) : null
const pct = (to, from) => from ? 100 * (to / from - 1) : null
const clock = at => new Date(at + 330 * minuteMs).toISOString().slice(11, 16)
const read = file => fs.readFileSync(file, 'utf8').split(/\r?\n/).flatMap(line => { try { return line.trim() ? [JSON.parse(line)] : [] } catch { return [] } })

function snapshots(symbol) {
  const file = path.join(root, 'db', 'cash-depth', date, symbol, `${symbol}.jsonl`)
  if (!fs.existsSync(file)) return []
  const fields = {}, out = []
  let previous = null
  for (const event of read(file)) {
    const at = Date.parse(event.receivedAt)
    if (!Number.isFinite(at) || at < start || at >= end) continue
    if (event.kind === 'checkpoint') for (const key of Object.keys(fields)) delete fields[key]
    for (const [key, value] of Object.entries(event.data ?? {})) fields[key] = value
    const bp = +fields.bid_price1, ap = +fields.ask_price1
    const bids = Array.from({ length: 5 }, (_, i) => +fields[`bid_size${i + 1}`])
    const asks = Array.from({ length: 5 }, (_, i) => +fields[`ask_size${i + 1}`])
    if (![bp, ap, ...bids, ...asks].every(Number.isFinite) || bp <= 0 || ap <= bp) continue
    const bidTotal = bids.reduce((a, b) => a + b, 0), askTotal = asks.reduce((a, b) => a + b, 0), mid = (bp + ap) / 2
    const ofi = previous && at - previous.at <= 90_000 ? (bp >= previous.bp ? bids[0] : 0) - (bp <= previous.bp ? previous.bid1 : 0) - (ap <= previous.ap ? asks[0] : 0) + (ap >= previous.ap ? previous.ask1 : 0) : 0
    out.push({ at, minute: clock(at), bp, ap, mid, bid1: bids[0], bidTotal, askTotal, spreadBps: 10_000 * (ap - bp) / mid, ofi })
    previous = { at, bp, ap, bid1: bids[0], ask1: asks[0] }
  }
  return out
}

function score(items) {
  if (items.length < 2) return { score: null, checks: {} }
  const first = items[0], last = items.at(-1), mids = items.map(x => x.mid), maxMid = Math.max(...mids)
  const groups = Map.groupBy(items, x => x.minute), mins = [...groups.keys()].sort().map(minute => {
    const rows = groups.get(minute)
    return { minute, mid: rows.reduce((s, x) => s + x.mid, 0) / rows.length, bid: rows.reduce((s, x) => s + x.bidTotal, 0) / rows.length, ask: rows.reduce((s, x) => s + x.askTotal, 0) / rows.length }
  })
  const bidUp = items.slice(1).filter((x, i) => x.bp > items[i].bp).length, bidDown = items.slice(1).filter((x, i) => x.bp < items[i].bp).length
  const askUp = items.slice(1).filter((x, i) => x.ap > items[i].ap).length, askDown = items.slice(1).filter((x, i) => x.ap < items[i].ap).length
  const minBidRatio = Math.min(...mins.map(x => x.bid)) / mins[0].bid, maxAskRatio = Math.max(...mins.map(x => x.ask)) / mins[0].ask
  const spreads = [...items].map(x => x.spreadBps).sort((a, b) => a - b), p90Spread = spreads[Math.floor((spreads.length - 1) * .9)]
  const cumulativeOfi = items.reduce((s, x) => s + x.ofi, 0), checks = {
    midpointStairStepHigher: last.mid > first.mid && mins.every((x, i) => !i || x.mid >= mins[i - 1].mid),
    bestBidStepsHigher: last.bp > first.bp && bidUp > bidDown,
    bidRefillsAtHigherLevels: last.bid1 >= first.bid1 * .7 && minBidRatio >= .7,
    offersAbsorbed: items.filter(x => x.ofi > 0).length > items.filter(x => x.ofi < 0).length,
    noPersistentAskWall: maxAskRatio <= 1.5,
    asksRetreatUpward: last.ap >= first.ap && askUp >= askDown,
    topFiveBidSupportStable: minBidRatio >= .7,
    positiveOrderFlowImbalance: cumulativeOfi > 0,
    spreadOrderly: last.spreadBps <= first.spreadBps * 1.25 && p90Spread <= first.spreadBps * 1.5,
    noAdverseDepthReversal: 10_000 * (last.mid / maxMid - 1) >= -5
  }
  return { score: Object.values(checks).filter(Boolean).length, checks }
}

const rows = []
for (const symbol of symbols) {
  const all = snapshots(symbol)
  for (const through of throughMinutes) {
    const at = Date.parse(`${date}T${through}:00+05:30`) + minuteMs
    const result = score(all.filter(x => x.at < at))
    rows.push({ symbol, through, score: result.score, passed: result.score === 10, failed: Object.entries(result.checks).filter(([, value]) => !value).map(([key]) => key) })
  }
}
const qualifyingRuns = symbols.map(symbol => {
  const series = rows.filter(row => row.symbol === symbol && row.score != null)
  for (let index = 0; index <= series.length - 3; index++) {
    if (series.slice(index, index + 3).every(row => row.score > 8)) return { symbol, start: series[index].through, end: series[index + 2].through, scores: series.slice(index, index + 3).map(row => row.score) }
  }
  return { symbol, start: null, end: null, scores: [] }
}).filter(row => row.start)
let suffix = 1, file
do { file = path.join(root, 'reports', `2026-11-20-depth-score-by-minute-0925${suffix === 1 ? '' : `-${suffix}`}.json`); suffix++ } while (fs.existsSync(file))
fs.writeFileSync(file, `${JSON.stringify({ date, window: 'Cumulative 09:15 through each completed minute', consecutiveRule: 'Three consecutive completed minutes with score >8/10', rows, qualifyingRuns }, null, 2)}\n`, { flag: 'wx' })
console.table(rows.map(row => ({ Stock: row.symbol, Through: row.through, 'Score / 10': row.score ?? '-', '10/10': row.passed ? 'YES' : '' })))
console.log('Three-minute runs with score >8/10')
console.table(qualifyingRuns)
console.log(`Report: ${file}`)
