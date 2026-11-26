import fs from 'node:fs'
import path from 'node:path'

const root = process.cwd()
const [date, inputArg] = process.argv.slice(2)
if (!/^\d{4}-\d{2}-\d{2}$/.test(date ?? '') || !inputArg) throw new Error('Usage: node scripts/build-11of12-depth-feature-dataset.js YYYY-MM-DD REPORT_JSON')
const input = path.resolve(root, inputArg)
const candidates = JSON.parse(fs.readFileSync(input, 'utf8')).trades
const depthRoot = path.join(root, 'db', 'cash-depth', date)
const toMs = time => Date.parse(`${date}T${time}:00+05:30`)
const mean = a => a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN
const round = (x, p = 4) => Number.isFinite(x) ? +x.toFixed(p) : null
const quantile = (a, p) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor((s.length - 1) * p)] : NaN }
const std = a => { const m = mean(a); return Math.sqrt(mean(a.map(x => (x - m) ** 2))) }

function loadDepth(symbol) {
  const file = path.join(depthRoot, symbol, `${symbol}.jsonl`), state = {}, out = []
  if (!fs.existsSync(file)) return out
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!line) continue
    let e; try { e = JSON.parse(line) } catch { continue }
    const t = Date.parse(e.receivedAt)
    if (!Number.isFinite(t)) continue
    if (e.kind === 'checkpoint') for (const key of Object.keys(state)) delete state[key]
    Object.assign(state, e.data ?? {})
    let bidSize = 0, askSize = 0, bidOrders = 0, askOrders = 0, valid = true
    for (let level = 1; level <= 5; level++) {
      const bp = +state[`bid_price${level}`], ap = +state[`ask_price${level}`]
      const bs = +state[`bid_size${level}`], as = +state[`ask_size${level}`]
      if (![bp, ap, bs, as].every(Number.isFinite) || ap <= bp) { valid = false; break }
      bidSize += bs; askSize += as
      if (Number.isFinite(+state[`bid_order${level}`])) bidOrders += +state[`bid_order${level}`]
      if (Number.isFinite(+state[`ask_order${level}`])) askOrders += +state[`ask_order${level}`]
    }
    if (!valid || bidSize + askSize <= 0) continue
    const bp = +state.bid_price1, ap = +state.ask_price1, b1 = +state.bid_size1, a1 = +state.ask_size1, mid = (bp + ap) / 2
    out.push({ t, bidShare: 100 * bidSize / (bidSize + askSize), topBidShare: 100 * b1 / (b1 + a1 || 1), orderBidShare: 100 * bidOrders / (bidOrders + askOrders || 1), spreadBps: 10000 * (ap - bp) / mid, mid, bidSize, askSize })
  }
  return out
}

function features(depth, start, end) {
  const w = depth.filter(x => x.t >= start && x.t < end)
  if (w.length < 5) return null
  const bidShares = w.map(x => x.bidShare), third = Math.max(1, Math.floor(w.length / 3)), first = w.slice(0, third), last = w.slice(-third)
  const mids = w.map(x => x.mid)
  return {
    snapshots: w.length,
    bidShareMean: mean(bidShares), bidShareMedian: quantile(bidShares, .5), bidShareMin: Math.min(...bidShares), bidShareMax: Math.max(...bidShares),
    bidShareP25: quantile(bidShares, .25), bidShareP75: quantile(bidShares, .75), bidShareStd: std(bidShares), bidShareLast: w.at(-1).bidShare,
    bidShareDelta: w.at(-1).bidShare - w[0].bidShare, bidShareLateVsEarly: mean(last.map(x => x.bidShare)) - mean(first.map(x => x.bidShare)),
    bidAbove50Pct: 100 * bidShares.filter(x => x > 50).length / bidShares.length, bidAbove55Pct: 100 * bidShares.filter(x => x > 55).length / bidShares.length,
    bidAbove60Pct: 100 * bidShares.filter(x => x > 60).length / bidShares.length, topBidShareMean: mean(w.map(x => x.topBidShare)),
    orderBidShareMean: mean(w.map(x => x.orderBidShare)), spreadMeanBps: mean(w.map(x => x.spreadBps)), spreadMaxBps: Math.max(...w.map(x => x.spreadBps)),
    midReturnPct: 100 * (mids.at(-1) / mids[0] - 1), midRangePct: 100 * (Math.max(...mids) / Math.min(...mids) - 1),
    bidSizeLateVsEarlyPct: 100 * (mean(last.map(x => x.bidSize)) / mean(first.map(x => x.bidSize)) - 1),
    askSizeLateVsEarlyPct: 100 * (mean(last.map(x => x.askSize)) / mean(first.map(x => x.askSize)) - 1),
    bookRatioLateVsEarly: mean(last.map(x => x.bidSize / x.askSize)) - mean(first.map(x => x.bidSize / x.askSize)),
  }
}

const bySymbol = Map.groupBy(candidates, x => x.symbol), rows = []
let completed = 0
for (const [symbol, signals] of bySymbol) {
  const depth = loadDepth(symbol)
  for (const signal of signals) {
    const f = features(depth, toMs(signal.originTime) + 60_000, toMs(signal.signalTime) + 60_000)
    if (f) rows.push({ ...signal, ...Object.fromEntries(Object.entries(f).map(([k, v]) => [k, round(v)])) })
  }
  completed++
  if (completed % 50 === 0) process.stdout.write(`\rDepth ${completed}/${bySymbol.size}; rows ${rows.length}`)
}
process.stdout.write('\n')
const output = { date, input, candidates: candidates.length, rowsWithDepth: rows.length, rows }
let n = 1, file
do { file = path.join(root, 'reports', `${date}-11of12-depth-features${n === 1 ? '' : `-${n}`}.json`); n++ } while (fs.existsSync(file))
fs.writeFileSync(file, JSON.stringify(output, null, 2) + '\n', { flag: 'wx' })
console.log(JSON.stringify({ file, candidates: output.candidates, rowsWithDepth: output.rowsWithDepth }, null, 2))
