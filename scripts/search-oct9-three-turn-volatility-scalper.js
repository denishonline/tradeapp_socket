import fsp from "node:fs/promises"
import path from "node:path"
import {
  readCandles, readDepth, scoreAt, indiaTime, pct, round,
} from "./replay-depth-candle-flip-scalper.js"

const root = typeof nodeRepl === "undefined" ? process.cwd() : nodeRepl.cwd
const day = "2026-10-09"
const depthRoot = path.join(root, "db", "cash-depth", day)
const output = path.join(root, "csv", "2026-10-09-three-turn-volatility-scalper.csv")
const clamp = (value, low = -1, high = 1) => Math.min(high, Math.max(low, value))
const mean = (values) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : NaN

function depthScore(metrics) {
  return 20 * clamp(metrics.ofi / 0.12) +
    15 * clamp(metrics.top2 / 0.12) +
    10 * clamp(metrics.full / 0.08) +
    10 * clamp(metrics.midReturn / 0.08) +
    5 * clamp((metrics.buyAligned - metrics.sellAligned) / 0.65)
}

function rollingRange(samples) {
  const result = Array(samples.length).fill(0)
  const maxima = [], minima = []
  let maxHead = 0, minHead = 0
  for (let index = 0; index < samples.length; index++) {
    const expiry = samples[index].at - 5 * 60_000
    while (maxHead < maxima.length && samples[maxima[maxHead]].at < expiry) maxHead++
    while (minHead < minima.length && samples[minima[minHead]].at < expiry) minHead++
    while (maxima.length > maxHead && samples[maxima.at(-1)].price <= samples[index].price) maxima.pop()
    while (minima.length > minHead && samples[minima.at(-1)].price >= samples[index].price) minima.pop()
    maxima.push(index)
    minima.push(index)
    result[index] = pct(samples[maxima[maxHead]].price, samples[minima[minHead]].price)
  }
  return result
}

function fastOpeningScore(samples, index, candles) {
  const sample = samples[index]
  const completed = candles.filter((candle) => candle.at + 60_000 <= sample.at)
  if (completed.length < 3 || completed.length >= 10) return null
  const from = sample.at - 15_000
  const window = []
  for (let cursor = index; cursor >= 0 && samples[cursor].at >= from; cursor--) window.push(samples[cursor])
  window.reverse()
  if (window.length < 8 || sample.at - window[0].at < 9_000 ||
      window.some((row, rowIndex) => rowIndex && row.at - window[rowIndex - 1].at > 2_500)) return null
  const recent = completed.slice(-3)
  const ofi = mean(window.slice(1).map((row) => row.ofi))
  const top2 = mean(window.map((row) => row.top2))
  const full = mean(window.map((row) => row.full))
  const midReturn = pct(sample.mid, window[0].mid)
  const buyAligned = window.filter((row) => row.full > 0 && row.top2 > 0).length / window.length
  const sellAligned = window.filter((row) => row.full < 0 && row.top2 < 0).length / window.length
  const return3 = pct(recent.at(-1).close, recent[0].open)
  const totalVolume = recent.reduce((sum, row) => sum + row.volume, 0)
  const vwap = totalVolume ? recent.reduce((sum, row) =>
    sum + row.volume * (row.high + row.low + row.close) / 3, 0) / totalVolume : NaN
  const vwapGap = pct(recent.at(-1).close, vwap)
  const averageClose = mean(recent.map((row) => row.close))
  const emaGap = pct(recent.at(-1).close, averageClose)
  const path = [recent[0].open, ...recent.map((row) => row.close)]
  const travel = path.slice(1).reduce((sum, value, cursor) => sum + Math.abs(value - path[cursor]), 0)
  const efficiency = travel ? (path.at(-1) - path[0]) / travel : 0
  const greenVolume = recent.filter((row) => row.close > row.open).reduce((sum, row) => sum + row.volume, 0)
  const redVolume = recent.filter((row) => row.close < row.open).reduce((sum, row) => sum + row.volume, 0)
  const volumeDirection = totalVolume ? (greenVolume - redVolume) / totalVolume : 0
  const dScore = 20 * clamp(ofi / 0.12) + 15 * clamp(top2 / 0.12) +
    10 * clamp(full / 0.08) + 10 * clamp(midReturn / 0.08) +
    5 * clamp((buyAligned - sellAligned) / 0.65)
  const candleScore = 12 * clamp(return3 / 0.15) + 8 * clamp(vwapGap / 0.10) +
    8 * clamp(emaGap / 0.05) + 7 * clamp(volumeDirection / 0.30) +
    5 * clamp(efficiency / 0.45)
  return { score: dScore + candleScore, ofi, top2, full, midReturn, buyAligned, sellAligned,
    return3, emaGap, vwapGap, efficiency }
}

const entries = [
  { entryScore: 35, entryDepth: 20, entrySeconds: 3, entryVol: 0.20 },
  { entryScore: 45, entryDepth: 25, entrySeconds: 5, entryVol: 0.25 },
  { entryScore: 55, entryDepth: 30, entrySeconds: 5, entryVol: 0.35 },
]
const exits = [
  { reverseScore: -15, reverseSeconds: 10 },
  { reverseScore: -25, reverseSeconds: 15 },
  { reverseScore: -35, reverseSeconds: 20 },
]
const trails = [
  { trailStart: 0.50, trailGap: 0.25 },
  { trailStart: 0.80, trailGap: 0.35 },
  { trailStart: 1.00, trailGap: 0.50 },
]
const compressions = [
  { lowVol: 0.12, minimumHold: 3 * 60_000 },
  { lowVol: 0.18, minimumHold: 5 * 60_000 },
]
const parameters = []
for (const entry of entries) for (const exit of exits) for (const trail of trails)
  for (const compression of compressions) parameters.push({ ...entry, ...exit, ...trail, ...compression })

function simulate(samples, metrics, ranges, parameter) {
  const trades = []
  let position = null, entryRun = 0, reverseRun = 0, lowVolRun = 0
  let armed = true, lastAt = 0
  for (let index = 0; index < samples.length; index++) {
    const sample = samples[index], row = metrics[index]
    const contiguous = lastAt && sample.at - lastAt <= 2_500
    lastAt = sample.at
    if (!position) {
      if (!row || row.score < 10 || row.return3 <= 0) armed = true
      const dScore = row ? depthScore(row) : -Infinity
      const signal = row && row.score >= parameter.entryScore && dScore >= parameter.entryDepth &&
        ranges[index] >= parameter.entryVol && row.ofi > 0 && row.top2 > 0 && row.full > 0 &&
        row.return3 >= 0.05 && row.emaGap > 0 && row.vwapGap > 0 && row.efficiency >= 0.20
      entryRun = signal && (contiguous || entryRun === 0) ? entryRun + 1 : 0
      if (armed && entryRun >= parameter.entrySeconds && trades.length < 3) {
        position = { buyAt: sample.at, buy: sample.ask, best: sample.bid, worst: sample.bid,
          entryScore: row.score }
        armed = false
        entryRun = reverseRun = lowVolRun = 0
      }
      continue
    }

    position.best = Math.max(position.best, sample.bid)
    position.worst = Math.min(position.worst, sample.bid)
    const currentReturn = pct(sample.bid, position.buy)
    const bestReturn = pct(position.best, position.buy)
    const dScore = row ? depthScore(row) : 0
    const reversal = row && row.score <= parameter.reverseScore && dScore < 0 &&
      row.return3 < 0 && row.emaGap < 0
    reverseRun = reversal && contiguous ? reverseRun + 1 : reversal ? 1 : 0
    const compressed = sample.at - position.buyAt >= parameter.minimumHold &&
      ranges[index] <= parameter.lowVol && row && row.score < 15 && row.return3 <= 0.05
    lowVolRun = compressed && contiguous ? lowVolRun + 1 : compressed ? 1 : 0

    let reason = null
    if (currentReturn <= -0.40) reason = "0.40% stop"
    else if (bestReturn >= parameter.trailStart && bestReturn - currentReturn >= parameter.trailGap)
      reason = "volatility trailing exit"
    else if (reverseRun >= parameter.reverseSeconds) reason = "sustained reversal"
    else if (lowVolRun >= 20) reason = "low-volatility exit"
    if (!reason) continue

    trades.push({ buyAt: position.buyAt, buy: position.buy, sellAt: sample.at, sell: sample.bid,
      returnPct: currentReturn, maxProfitPct: bestReturn, maxAdversePct: pct(position.worst, position.buy),
      reason, holdSeconds: (sample.at - position.buyAt) / 1000 })
    position = null
    entryRun = reverseRun = lowVolRun = 0
  }
  if (position && trades.length < 3) {
    const sample = samples.at(-1)
    trades.push({ buyAt: position.buyAt, buy: position.buy, sellAt: sample.at, sell: sample.bid,
      returnPct: pct(sample.bid, position.buy), maxProfitPct: pct(position.best, position.buy),
      maxAdversePct: pct(position.worst, position.buy), reason: "data-end exit",
      holdSeconds: (sample.at - position.buyAt) / 1000 })
  }
  return trades
}

const summaries = parameters.map((parameter, index) => ({ index, parameter, rows: [] }))
const symbols = (await fsp.readdir(depthRoot, { withFileTypes: true }))
  .filter((entry) => entry.isDirectory()).map((entry) => entry.name)
let cursor = 0
await Promise.all(Array.from({ length: 10 }, async () => {
  while (cursor < symbols.length) {
    const symbol = symbols[cursor++]
    try {
      const [samples, candles] = await Promise.all([readDepth(symbol), readCandles(symbol)])
      const metrics = samples.map((sample, index) =>
        scoreAt(samples, index, candles) ?? fastOpeningScore(samples, index, candles))
      const ranges = rollingRange(samples)
      summaries.forEach((summary) => {
        const trades = simulate(samples, metrics, ranges, summary.parameter)
        if (!trades.length) return
        const net = trades.reduce((sum, trade) => sum + trade.returnPct, 0)
        summary.rows.push({ symbol, trades, net,
          wins: trades.filter((trade) => trade.returnPct > 0).length,
          worst: Math.min(...trades.map((trade) => trade.maxAdversePct)) })
      })
    } catch (error) {
      console.error(`${symbol}: ${error.message}`)
    }
  }
}))

summaries.forEach((summary) => {
  summary.over4 = summary.rows.filter((row) => row.net >= 4).length
  summary.profitable = summary.rows.filter((row) => row.net > 0).length
  summary.losing = summary.rows.filter((row) => row.net < 0).length
  summary.totalNet = summary.rows.reduce((sum, row) => sum + row.net, 0)
})
summaries.sort((left, right) => right.over4 - left.over4 || right.totalNet - left.totalNet ||
  left.losing - right.losing)
const best = summaries[0]
best.rows.sort((left, right) => right.net - left.net)

const columns = ["rank", "symbol", "turns", "wins", "losses", "net_return_pct", "worst_adverse_pct",
  "cycle_details"]
const csv = [columns.join(",")]
best.rows.forEach((row, index) => {
  const details = row.trades.map((trade) =>
    `${indiaTime(trade.buyAt)} BUY ${round(trade.buy)} -> ${indiaTime(trade.sellAt)} SELL ${round(trade.sell)} ` +
    `${round(trade.returnPct)}% [${trade.reason}]`).join(" | ").replaceAll('"', '""')
  csv.push([index + 1, row.symbol, row.trades.length, row.wins, row.trades.length - row.wins,
    round(row.net), round(row.worst), `"${details}"`].join(","))
})
await fsp.writeFile(output, `${csv.join("\n")}\n`)

export const result = {
  output, stocksScanned: symbols.length, parameterSetsChecked: parameters.length,
  bestParameters: best.parameter, stocksOver4: best.over4, profitableStocks: best.profitable,
  losingStocks: best.losing, totalNet: round(best.totalNet),
  top: best.rows.slice(0, 20).map((row, index) => ({ rank: index + 1, symbol: row.symbol,
    turns: row.trades.length, wins: row.wins, losses: row.trades.length - row.wins,
    netReturn: round(row.net), worstAdverse: round(row.worst),
    trades: row.trades.map((trade) => ({ buy: indiaTime(trade.buyAt), sell: indiaTime(trade.sellAt),
      returnPct: round(trade.returnPct), maxProfitPct: round(trade.maxProfitPct), reason: trade.reason })) })),
  nextBest: summaries.slice(1, 6).map((summary) => ({ parameters: summary.parameter,
    over4: summary.over4, profitable: summary.profitable, losing: summary.losing,
    totalNet: round(summary.totalNet) })),
}

if (typeof nodeRepl === "undefined") console.log(JSON.stringify(result, null, 2))
