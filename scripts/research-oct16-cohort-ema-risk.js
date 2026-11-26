import fs from 'node:fs'
import path from 'node:path'

const root = process.cwd()
const date = '2026-10-16'
const dayStart = Date.parse('2026-10-15T18:30:00Z')
const dayEnd = dayStart + 24 * 60 * 60_000
const hhmm = ms => new Date(ms + 330 * 60_000).toISOString().slice(11, 16)
const round = n => Number(n.toFixed(4))
const cohort = fs.readFileSync(path.join(root, 'reports/2026-10-05-to-2026-10-16-ema10-ema20-over-1p5-trend-legs.csv'), 'utf8')
  .trim().split(/\r?\n/).slice(1).map(line => {
    const [date, symbol, side, crossoverTime, entryTime, entryPrice, oppositeCrossoverTime] = line.split(',')
    return { date, symbol, side, crossoverTime, entryTime, entryPrice: Number(entryPrice), oppositeCrossoverTime }
  }).filter(row => row.date === date)

const periods = [5, 8, 10, 12, 15, 20, 30, 50]
const pairs = periods.flatMap((fast, i) => periods.slice(i + 1).map(slow => [fast, slow]))
const targets = Array.from({ length: 21 }, (_, i) => round(0.5 + i * 0.1))
const cache = new Map()

function load(symbol) {
  if (cache.has(symbol)) return cache.get(symbol)
  const rows = fs.readFileSync(path.join(root, 'db/candles', `${symbol}.jsonl`), 'utf8').trim().split(/\r?\n/)
    .map(line => JSON.parse(line)).filter(row => row.time * 1000 >= dayStart && row.time * 1000 < dayEnd &&
      [row.open, row.high, row.low, row.close].every(Number.isFinite) && row.open > 0 &&
      row.high >= Math.max(row.open, row.close) && row.low <= Math.min(row.open, row.close))
    .sort((a, b) => a.time - b.time)
  const unique = rows.filter((row, i) => !i || row.time !== rows[i - 1].time)
  for (const period of periods) {
    let value
    for (const row of unique) {
      value = value === undefined ? row.close : row.close * 2 / (period + 1) + value * (period - 1) / (period + 1)
      row[`ema${period}`] = value
    }
  }
  const depthFile = path.join(root, 'db/cash-depth', date, symbol, `${symbol}.jsonl`)
  const depth = fs.existsSync(depthFile) ? fs.readFileSync(depthFile, 'utf8').trim().split(/\r?\n/)
    .map(line => { try { return JSON.parse(line) } catch { return null } })
    .filter(row => row && Number.isFinite(Date.parse(row.receivedAt)))
    .sort((a, b) => Date.parse(a.receivedAt) - Date.parse(b.receivedAt)) : []
  const result = { rows: unique, depth }
  cache.set(symbol, result)
  return result
}

function depthAt(depth, signalEnd) {
  let lo = 0, hi = depth.length
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (Date.parse(depth[mid].receivedAt) <= signalEnd) lo = mid + 1
    else hi = mid
  }
  const row = depth[lo - 1]
  if (!row) return { available: false }
  const bid = Number(row.data?.bid_price1), ask = Number(row.data?.ask_price1)
  const bidSize = [1, 2, 3, 4, 5].reduce((sum, n) => sum + (Number(row.data?.[`bid_size${n}`]) || 0), 0)
  const askSize = [1, 2, 3, 4, 5].reduce((sum, n) => sum + (Number(row.data?.[`ask_size${n}`]) || 0), 0)
  return { available: true, receivedAt: row.receivedAt, ageSeconds: round((signalEnd - Date.parse(row.receivedAt)) / 1000),
    bid, ask, spreadPct: bid > 0 ? round(100 * (ask - bid) / bid) : null,
    fiveLevelBidSize: bidSize, fiveLevelAskSize: askSize,
    imbalance: bidSize + askSize ? round((bidSize - askSize) / (bidSize + askSize)) : null }
}

function baseSignal(leg, pair) {
  const { rows, depth } = load(leg.symbol)
  const [fast, slow] = pair
  const start = rows.findIndex(row => hhmm(row.time * 1000) === leg.crossoverTime)
  const end = rows.findIndex(row => hhmm(row.time * 1000) === leg.oppositeCrossoverTime)
  if (start < 1 || end < start + 1) return null
  const dir = leg.side === 'BUY' ? 1 : -1
  let signalIndex = pair[0] === 10 && pair[1] === 20 ? start : -1
  if (signalIndex < 0) for (let i = Math.max(start, slow - 1); i < end; i++) {
    const before = rows[i - 1][`ema${fast}`] - rows[i - 1][`ema${slow}`]
    const after = rows[i][`ema${fast}`] - rows[i][`ema${slow}`]
    if (dir * after > 0 && dir * before <= 0) { signalIndex = i; break }
  }
  if (signalIndex < 0 || signalIndex + 2 >= end ||
      rows[signalIndex + 1].time !== rows[signalIndex].time + 60 ||
      rows[signalIndex + 2].time !== rows[signalIndex + 1].time + 60) return null
  const entryIndex = signalIndex + 2
  const entry = rows[entryIndex]
  const signal = rows[signalIndex + 1]
  const signalEnd = signal.time * 1000 + 60_000
  return { leg, pair: `${fast}/${slow}`, rows, end, entryIndex, entryPrice: entry.open, dir,
    crossoverTime: hhmm(rows[signalIndex].time * 1000), signalTime: hhmm(signal.time * 1000), entryTime: hhmm(entry.time * 1000),
    signalClose: signal.close, emaFast: round(signal[`ema${fast}`]), emaSlow: round(signal[`ema${slow}`]),
    depth: depthAt(depth, signalEnd) }
}

function replay(base, targetPct) {
  const { rows, end, entryIndex, entryPrice, dir } = base
  const stopPrice = entryPrice * (1 - dir * 0.005)
  const targetPrice = entryPrice * (1 + dir * targetPct / 100)
  let worst = 0
  for (let i = entryIndex; i <= end + 1 && i < rows.length; i++) {
    const row = rows[i]
    if (i > entryIndex && row.time !== rows[i - 1].time + 60) return null
    if (i === end + 1) {
      const ret = dir * 100 * (row.open / entryPrice - 1)
      return { exitTime: hhmm(row.time * 1000), exitPrice: row.open, exitReason: 'ema10/20 reversal', returnPct: round(ret), maxAdversePct: round(worst) }
    }
    const adverse = dir === 1 ? 100 * (row.low / entryPrice - 1) : 100 * (1 - row.high / entryPrice)
    worst = Math.min(worst, adverse)
    const stopAtOpen = dir === 1 ? row.open <= stopPrice : row.open >= stopPrice
    const stopInBar = dir === 1 ? row.low <= stopPrice : row.high >= stopPrice
    const targetInBar = dir === 1 ? row.high >= targetPrice : row.low <= targetPrice
    if (stopAtOpen || stopInBar) {
      const price = stopAtOpen ? row.open : stopPrice
      return { exitTime: hhmm(row.time * 1000), exitPrice: round(price), exitReason: 'stop', returnPct: round(dir * 100 * (price / entryPrice - 1)), maxAdversePct: round(worst), sameBarTargetAlsoHit: targetInBar }
    }
    if (targetInBar) return { exitTime: hhmm(row.time * 1000), exitPrice: round(targetPrice), exitReason: 'target', returnPct: round(dir * 100 * (targetPrice / entryPrice - 1)), maxAdversePct: round(worst) }
  }
  return null
}

function summarize(trades, target) {
  const winners = trades.filter(t => t.exitReason === 'target').length
  const stops = trades.filter(t => t.exitReason === 'stop').length
  const total = trades.reduce((sum, t) => sum + t.returnPct, 0)
  return { pair: trades[0]?.pair ?? null, targetPct: target, tradeCount: trades.length, winners,
    stops, otherExits: trades.length - winners - stops, winRatePct: round(100 * winners / (trades.length || 1)),
    stopRatePct: round(100 * stops / (trades.length || 1)), averageReturnPct: round(total / (trades.length || 1)),
    totalReturnPct: round(total), maximumAdverseExcursionPct: trades.length ? round(Math.min(...trades.map(t => t.maxAdversePct))) : null,
    worstDay: trades.length ? { date, totalReturnPct: round(total) } : null }
}

const candidates = []
for (const pair of pairs) {
  const bases = cohort.map(leg => baseSignal(leg, pair)).filter(Boolean)
  for (const target of targets) {
    const trades = bases.map(base => {
      const result = replay(base, target)
      return result && { date, symbol: base.leg.symbol, side: base.leg.side, pair: base.pair, crossoverTime: base.crossoverTime,
        signalTime: base.signalTime, entryTime: base.entryTime, entryPrice: round(base.entryPrice),
        stopPrice: round(base.entryPrice * (1 - base.dir * 0.005)), targetPrice: round(base.entryPrice * (1 + base.dir * target / 100)),
        signalClose: base.signalClose, emaFast: base.emaFast, emaSlow: base.emaSlow,
        depth: base.depth, ...result }
    }).filter(Boolean)
    candidates.push({ summary: summarize(trades, target), trades })
  }
}
const feasible = candidates.filter(x => x.summary.tradeCount && x.summary.winRatePct >= 80 && x.summary.stopRatePct <= 20 && x.summary.totalReturnPct >= 5)
  .sort((a, b) => b.summary.totalReturnPct - a.summary.totalReturnPct || b.summary.tradeCount - a.summary.tradeCount)
const best = feasible[0] || candidates.filter(x => x.summary.tradeCount).sort((a, b) => b.summary.totalReturnPct - a.summary.totalReturnPct)[0]
const baseline = candidates.find(x => x.summary.pair === '10/20' && x.summary.targetPct === 0.5)
const output = { scope: 'Only the ten October 16 legs in the preselected 159-leg EMA10/20 >1.5% cohort',
  method: 'Session-seeded one-minute EMAs; recorded cohort crossover for pair 10/20 and first same-direction crossover within each leg for other pairs. Wait one entire next one-minute candle; use indicators and latest received depth by its completion; enter at following candle open. 0.5% fixed stop and fixed target from 0.5% to 2.5%. Intrabar stop takes priority if stop and target both touched. If neither hits, exit at the open after the completed opposite 10/20 crossover candle. Depth is descriptive, not optimized. Gross unweighted percentage sum, no fees/spread/slippage; historical pair/target selection on this same day is in-sample.',
  dataNote: 'IRFC cohort CSV records its 10/20 signal at 09:39; current candle-file recalculation places that cross at 09:38. The 09:39 recorded cohort signal is used for the 10/20 replay.',
  search: { pairs: pairs.length, targetLevels: targets.length, tested: candidates.length, feasible: feasible.length },
  baseline: baseline.summary, best: best.summary, bestTrades: best.trades,
  feasibleSummaries: feasible.slice(0, 20).map(x => x.summary) }
let n = 1, file
do { file = path.join(root, 'reports', `2026-10-16-cohort-ema-risk-search${n === 1 ? '' : `-${n}`}.json`); n++ } while (fs.existsSync(file))
fs.writeFileSync(file, JSON.stringify(output, null, 2) + '\n')
console.log(JSON.stringify({ file, search: output.search, baseline: output.baseline, best: output.best, bestTrades: output.bestTrades }, null, 2))
