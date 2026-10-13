import fsp from "node:fs/promises"
import path from "node:path"
import {
  readCandles, readDepth, scoreAt, indiaTime, pct, round,
} from "./replay-depth-candle-flip-scalper.js"

const root = typeof nodeRepl === "undefined" ? process.cwd() : nodeRepl.cwd
const day = "2026-10-09"
const depthRoot = path.join(root, "db", "cash-depth", day)
const output = path.join(root, "csv", "2026-10-09-repeat-depth-flip-scalping.csv")
const clamp = (value, low = -1, high = 1) => Math.min(high, Math.max(low, value))

function splitScore(metrics) {
  const depth =
    20 * clamp(metrics.ofi / 0.12) +
    15 * clamp(metrics.top2 / 0.12) +
    10 * clamp(metrics.full / 0.08) +
    10 * clamp(metrics.midReturn / 0.08) +
    5 * clamp((metrics.buyAligned - metrics.sellAligned) / 0.65)
  return { depth, candle: metrics.score - depth }
}

function bullish(metrics, sample) {
  if (!metrics) return false
  const score = splitScore(metrics)
  const spread = pct(sample.ask, sample.bid)
  return metrics.score >= 40 && score.depth >= 25 && score.candle >= 8 &&
    metrics.ofi >= 0.03 && metrics.top2 >= 0.02 && metrics.full >= 0.02 &&
    metrics.buyAligned >= 0.55 && metrics.return3 >= 0.05 && metrics.emaGap > 0 &&
    metrics.vwapGap > 0 && metrics.greenCount >= 2 && metrics.volumeRatio >= 0.80 &&
    metrics.efficiency >= 0.20 && spread <= 0.15
}

function bearish(metrics) {
  if (!metrics) return false
  const score = splitScore(metrics)
  return metrics.score <= -15 && score.depth <= -15 && metrics.top2 < 0 && metrics.full < 0
}

function replayStock(symbol, samples, candles) {
  const metrics = samples.map((sample, index) => scoreAt(samples, index, candles))
  const trades = []
  let position = null
  let bullRun = 0
  let bearRun = 0
  let armed = true
  let lastAt = 0

  for (let index = 0; index < samples.length; index++) {
    const sample = samples[index]
    const row = metrics[index]
    const contiguous = lastAt && sample.at - lastAt <= 2_500
    lastAt = sample.at

    if (!position) {
      if (!row || row.score < 15) armed = true
      bullRun = bullish(row, sample) && (contiguous || bullRun === 0) ? bullRun + 1 : 0
      if (armed && bullRun >= 5) {
        position = {
          entryAt: sample.at, entry: sample.ask, entryIndex: index,
          entryScore: row.score, best: sample.bid, worst: sample.bid,
        }
        armed = false
        bullRun = 0
        bearRun = 0
      }
      continue
    }

    position.best = Math.max(position.best, sample.bid)
    position.worst = Math.min(position.worst, sample.bid)
    const currentReturn = pct(sample.bid, position.entry)
    const bestReturn = pct(position.best, position.entry)
    bearRun = bearish(row) && contiguous ? bearRun + 1 : bearish(row) ? 1 : 0

    let reason = null
    if (bearRun >= 4) reason = "bearish depth flip"
    else if (currentReturn <= -0.25) reason = "0.25% stop"
    else if (bestReturn >= 0.25 && bestReturn - currentReturn >= 0.12) reason = "0.12% trailing exit"
    else if (currentReturn >= 0.50) reason = "0.50% target"
    else if (sample.at - position.entryAt >= 10 * 60_000) reason = "10-minute time exit"

    if (reason) {
      trades.push({
        symbol, buyAt: position.entryAt, buy: position.entry, sellAt: sample.at, sell: sample.bid,
        returnPct: currentReturn, maxProfitPct: bestReturn,
        maxAdversePct: pct(position.worst, position.entry), holdSeconds: (sample.at - position.entryAt) / 1000,
        reason, entryScore: position.entryScore,
      })
      position = null
      bullRun = 0
      bearRun = 0
    }
  }
  return trades
}

async function scan(symbol) {
  const [samples, candles] = await Promise.all([readDepth(symbol), readCandles(symbol)])
  return replayStock(symbol, samples, candles)
}

const symbols = (await fsp.readdir(depthRoot, { withFileTypes: true }))
  .filter((entry) => entry.isDirectory()).map((entry) => entry.name)
const byStock = []
let cursor = 0
await Promise.all(Array.from({ length: 10 }, async () => {
  while (cursor < symbols.length) {
    const symbol = symbols[cursor++]
    try {
      const trades = await scan(symbol)
      if (trades.length >= 2) {
        const wins = trades.filter((trade) => trade.returnPct > 0).length
        const net = trades.reduce((sum, trade) => sum + trade.returnPct, 0)
        const average = net / trades.length
        const averageMax = trades.reduce((sum, trade) => sum + trade.maxProfitPct, 0) / trades.length
        const worst = Math.min(...trades.map((trade) => trade.maxAdversePct))
        const averageHold = trades.reduce((sum, trade) => sum + trade.holdSeconds, 0) / trades.length
        const rankScore = 35 * (wins / trades.length) + 25 * clamp(net / 1.0, 0, 1) +
          20 * clamp(trades.length / 5, 0, 1) + 20 * clamp(averageMax / 0.35, 0, 1)
        byStock.push({ symbol, trades, wins, net, average, averageMax, worst, averageHold, rankScore })
      }
    } catch (error) {
      console.error(`${symbol}: ${error.message}`)
    }
  }
}))

byStock.sort((left, right) => right.rankScore - left.rankScore || right.net - left.net)
const columns = ["rank", "symbol", "cycles", "wins", "losses", "win_rate_pct", "net_return_pct",
  "average_return_pct", "average_max_profit_pct", "worst_adverse_pct", "average_hold_seconds",
  "rank_score", "cycle_details"]
const csv = [columns.join(",")]
byStock.forEach((row, index) => {
  const details = row.trades.map((trade) =>
    `${indiaTime(trade.buyAt)} BUY ${round(trade.buy)} -> ${indiaTime(trade.sellAt)} SELL ${round(trade.sell)} ` +
    `${round(trade.returnPct)}% [${trade.reason}]`).join(" | ").replaceAll('"', '""')
  csv.push([
    index + 1, row.symbol, row.trades.length, row.wins, row.trades.length - row.wins,
    round(100 * row.wins / row.trades.length, 1), round(row.net), round(row.average),
    round(row.averageMax), round(row.worst), round(row.averageHold, 1), round(row.rankScore, 1),
    `"${details}"`,
  ].join(","))
})
await fsp.writeFile(output, `${csv.join("\n")}\n`)

export const result = {
  output, stocksScanned: symbols.length, repeatCandidates: byStock.length,
  top: byStock.slice(0, 15).map((row, index) => ({
    rank: index + 1, symbol: row.symbol, cycles: row.trades.length, wins: row.wins,
    losses: row.trades.length - row.wins, winRate: round(100 * row.wins / row.trades.length, 1),
    netReturn: round(row.net), averageReturn: round(row.average), averageMaxProfit: round(row.averageMax),
    worstAdverse: round(row.worst), averageHoldSeconds: round(row.averageHold, 1),
    rankScore: round(row.rankScore, 1),
    trades: row.trades.map((trade) => ({ buy: indiaTime(trade.buyAt), sell: indiaTime(trade.sellAt),
      returnPct: round(trade.returnPct), maxProfitPct: round(trade.maxProfitPct), reason: trade.reason })),
  })),
}

if (typeof nodeRepl === "undefined") console.log(JSON.stringify(result, null, 2))
