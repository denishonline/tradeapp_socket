import fs from "node:fs"
import fsp from "node:fs/promises"
import path from "node:path"
import readline from "node:readline"

const root = typeof nodeRepl === "undefined" ? process.cwd() : nodeRepl.cwd
// October 5 capture begins around 10:02 IST, so it cannot be used for an
// as-of-09:30 opening comparison without inventing missing order-book data.
const historyDays = ["2026-10-06", "2026-10-07", "2026-10-08"]
const currentDay = "2026-10-09"
const allDays = [...historyDays, currentDay]
const depthStartMinute = 9 * 60 + 20
const depthEndMinute = 9 * 60 + 30
const candleStartMinute = 9 * 60 + 15
const candleEndMinute = 9 * 60 + 30
const IST_OFFSET = 330 * 60_000
const depthRoot = path.join(root, "db", "cash-depth")
const candleRoot = path.join(root, "db", "candles")
const output = path.join(root, "csv", "2026-10-09-opening-depth-vs-prior-available-days.csv")

const mean = (values) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : NaN
const stddev = (values) => {
  if (values.length < 2) return 0
  const average = mean(values)
  return Math.sqrt(values.reduce((sum, value) => sum + (value - average) ** 2, 0) / (values.length - 1))
}
const median = (values) => {
  const sorted = values.filter(Number.isFinite).sort((left, right) => left - right)
  if (!sorted.length) return NaN
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}
const pct = (value, base) => base > 0 ? (value / base - 1) * 100 : NaN
const clamp = (value, minimum, maximum) => Math.min(maximum, Math.max(minimum, value))
const round = (value, digits = 3) => Number.isFinite(value) ? Number(value.toFixed(digits)) : null
const indiaDate = (at) => new Date(at + IST_OFFSET).toISOString().slice(0, 10)
const indiaMinute = (at) => {
  const local = new Date(at + IST_OFFSET)
  return local.getUTCHours() * 60 + local.getUTCMinutes()
}

async function* records(filename) {
  const input = fs.createReadStream(filename, { encoding: "utf8" })
  const lines = readline.createInterface({ input, crlfDelay: Infinity })
  try {
    for await (const line of lines) {
      if (!line.trim()) continue
      try { yield JSON.parse(line) } catch { /* Ignore an incomplete final row. */ }
    }
  } finally {
    lines.close()
    input.destroy()
  }
}

function bookMetrics(data) {
  let bidSize = 0, askSize = 0, bid2 = 0, ask2 = 0, bidOrders = 0, askOrders = 0
  let bid = NaN, ask = NaN, bid1 = NaN, ask1 = NaN
  for (let level = 1; level <= 5; level++) {
    const bidPrice = Number(data[`bid_price${level}`])
    const askPrice = Number(data[`ask_price${level}`])
    const currentBidSize = Number(data[`bid_size${level}`])
    const currentAskSize = Number(data[`ask_size${level}`])
    const currentBidOrders = Number(data[`bid_order${level}`])
    const currentAskOrders = Number(data[`ask_order${level}`])
    if (![bidPrice, askPrice, currentBidSize, currentAskSize].every(Number.isFinite) ||
        bidPrice <= 0 || askPrice <= bidPrice || currentBidSize < 0 || currentAskSize < 0) return null
    if (level === 1) {
      bid = bidPrice; ask = askPrice; bid1 = currentBidSize; ask1 = currentAskSize
    }
    bidSize += currentBidSize
    askSize += currentAskSize
    if (level <= 2) { bid2 += currentBidSize; ask2 += currentAskSize }
    if (Number.isFinite(currentBidOrders) && currentBidOrders >= 0) bidOrders += currentBidOrders
    if (Number.isFinite(currentAskOrders) && currentAskOrders >= 0) askOrders += currentAskOrders
  }
  return {
    bid, ask, bid1, ask1, mid: (bid + ask) / 2,
    full: (bidSize - askSize) / (bidSize + askSize || 1),
    top2: (bid2 - ask2) / (bid2 + ask2 || 1),
    orders: (bidOrders - askOrders) / (bidOrders + askOrders || 1),
    spreadBps: (ask / bid - 1) * 10_000,
  }
}

async function openingDepth(day, symbol) {
  const filename = path.join(depthRoot, day, symbol, `${symbol}.jsonl`)
  const fields = {}
  const bySecond = new Map()
  let lastAt = 0
  for await (const record of records(filename)) {
    const at = Date.parse(record.receivedAt)
    if (!Number.isFinite(at) || indiaDate(at) !== day) continue
    const minute = indiaMinute(at)
    if (minute >= depthEndMinute) break
    if (lastAt && at - lastAt > 90_000) for (const key of Object.keys(fields)) delete fields[key]
    lastAt = at
    if (record.kind === "checkpoint" || record.book) {
      for (const key of Object.keys(fields)) delete fields[key]
      Object.assign(fields, record.data)
    } else if (record.kind === "update") Object.assign(fields, record.data)
    else continue
    if (minute < depthStartMinute) continue
    const book = bookMetrics(fields)
    if (!book) continue
    bySecond.set(Math.floor(at / 1000), { at, ...book })
  }
  const samples = [...bySecond.values()].sort((left, right) => left.at - right.at)
  if (!samples.length) return null
  let previous = null
  for (const sample of samples) {
    sample.ofi = 0
    if (previous) {
      let flow = sample.bid > previous.bid ? sample.bid1
        : sample.bid === previous.bid ? sample.bid1 - previous.bid1 : -previous.bid1
      flow -= sample.ask < previous.ask ? sample.ask1
        : sample.ask === previous.ask ? sample.ask1 - previous.ask1 : -previous.ask1
      sample.ofi = flow / ((sample.bid1 + sample.ask1 + previous.bid1 + previous.ask1) / 2 || 1)
    }
    previous = sample
  }
  const minuteMap = new Map()
  for (const sample of samples) {
    const minute = Math.floor(sample.at / 60_000) * 60_000
    if (!minuteMap.has(minute)) minuteMap.set(minute, [])
    minuteMap.get(minute).push(sample)
  }
  const minutes = [...minuteMap.values()].map((items) => ({
    full: mean(items.map((item) => item.full)),
    top2: mean(items.map((item) => item.top2)),
    ofi: mean(items.map((item) => item.ofi)),
  }))
  return {
    ticks: samples.length,
    minutes: minutes.length,
    full: mean(samples.map((sample) => sample.full)),
    top2: mean(samples.map((sample) => sample.top2)),
    orders: mean(samples.map((sample) => sample.orders)),
    ofi: mean(samples.slice(1).map((sample) => sample.ofi)),
    positiveMinutes: minutes.filter((row) => row.full > 0 && row.top2 > 0).length / minutes.length,
    midDrift: pct(samples.at(-1).mid, samples[0].mid),
    spreadBps: mean(samples.map((sample) => sample.spreadBps)),
  }
}

function ema(values, period) {
  const multiplier = 2 / (period + 1)
  let value = values[0]
  for (const next of values.slice(1)) value = next * multiplier + value * (1 - multiplier)
  return value
}

async function openingCandles(symbol) {
  const rows = []
  const filename = path.join(candleRoot, `${symbol}.jsonl`)
  for await (const row of records(filename)) {
    const at = Number(row.time) * 1000
    if (indiaDate(at) !== currentDay) continue
    const minute = indiaMinute(at)
    if (minute >= candleEndMinute) break
    if (minute < candleStartMinute) continue
    rows.push({ at, open: Number(row.open), high: Number(row.high), low: Number(row.low),
      close: Number(row.close), volume: Number(row.volume) })
  }
  if (rows.length < 15) return null
  const selected = rows.slice(0, 15)
  const totalVolume = selected.reduce((sum, row) => sum + row.volume, 0)
  const vwap = totalVolume ? selected.reduce((sum, row) =>
    sum + row.volume * (row.high + row.low + row.close) / 3, 0) / totalVolume : NaN
  const closes = selected.map((row) => row.close)
  const travel = selected.reduce((sum, row, index) => sum +
    Math.abs(row.close - (index ? selected[index - 1].close : row.open)), 0)
  const net = selected.at(-1).close - selected[0].open
  return {
    candles: selected.length,
    return15: pct(selected.at(-1).close, selected[0].open),
    vwapGap: pct(selected.at(-1).close, vwap),
    emaGap: pct(ema(closes, 5), ema(closes, 10)),
    greenShare: selected.filter((row) => row.close > row.open).length / selected.length,
    greenVolumeShare: totalVolume ? selected.filter((row) => row.close > row.open)
      .reduce((sum, row) => sum + row.volume, 0) / totalVolume : 0,
    efficiency: travel ? net / travel : 0,
  }
}

const symbols = (await fsp.readdir(path.join(depthRoot, currentDay), { withFileTypes: true }))
  .filter((entry) => entry.isDirectory()).map((entry) => entry.name)
const depthByStock = new Map()
let cursor = 0
await Promise.all(Array.from({ length: 12 }, async () => {
  while (cursor < symbols.length) {
    const symbol = symbols[cursor++]
    const byDay = {}
    for (const day of allDays) {
      try { byDay[day] = await openingDepth(day, symbol) } catch { byDay[day] = null }
    }
    depthByStock.set(symbol, byDay)
  }
}))

const candlesByStock = new Map()
cursor = 0
await Promise.all(Array.from({ length: 12 }, async () => {
  while (cursor < symbols.length) {
    const symbol = symbols[cursor++]
    try { candlesByStock.set(symbol, await openingCandles(symbol)) } catch { candlesByStock.set(symbol, null) }
  }
}))

const features = ["full", "top2", "orders", "ofi", "positiveMinutes", "midDrift"]
const fixedFloor = { full: 0.04, top2: 0.05, orders: 0.03, ofi: 0.02,
  positiveMinutes: 0.08, midDrift: 0.04 }
const stockRows = []
const stockStd = new Map()
for (const symbol of symbols) {
  const byDay = depthByStock.get(symbol)
  const history = historyDays.map((day) => byDay?.[day]).filter((row) => row && row.minutes >= 8)
  const current = byDay?.[currentDay]
  const candles = candlesByStock.get(symbol)
  if (history.length < historyDays.length || !current || current.minutes < 8 || !candles) continue
  const baseline = Object.fromEntries(features.map((feature) =>
    [feature, mean(history.map((row) => row[feature]))]))
  const deviations = Object.fromEntries(features.map((feature) =>
    [feature, stddev(history.map((row) => row[feature]))]))
  stockStd.set(symbol, deviations)
  stockRows.push({ symbol, history, current, baseline, deviations, candles })
}
const globalStd = Object.fromEntries(features.map((feature) =>
  [feature, median(stockRows.map((row) => row.deviations[feature]))]))
const depthWeights = { full: 0.25, top2: 0.20, orders: 0.10, ofi: 0.20,
  positiveMinutes: 0.15, midDrift: 0.10 }
for (const row of stockRows) {
  row.z = {}
  for (const feature of features) {
    const denominator = Math.max(row.deviations[feature], globalStd[feature] * 0.5, fixedFloor[feature])
    row.z[feature] = clamp((row.current[feature] - row.baseline[feature]) / denominator, -3, 3)
  }
  row.depthDirection = features.reduce((sum, feature) =>
    sum + depthWeights[feature] * row.z[feature], 0)
  const absolute = features.reduce((sum, feature) =>
    sum + depthWeights[feature] * Math.abs(row.z[feature]), 0)
  row.coherence = absolute ? Math.abs(row.depthDirection) / absolute : 0
  row.depthStrength = Math.abs(row.depthDirection) * (0.5 + 0.5 * row.coherence)
  row.side = row.depthDirection >= 0 ? "BUY" : "SELL"
  row.sign = row.side === "BUY" ? 1 : -1
}

const crossStd = (feature) => Math.max(stddev(stockRows.map((row) => row.candles[feature])), 0.01)
const candleMean = Object.fromEntries(["return15", "vwapGap", "emaGap"].map((feature) =>
  [feature, mean(stockRows.map((row) => row.candles[feature]))]))
const candleStd = Object.fromEntries(["return15", "vwapGap", "emaGap"].map((feature) =>
  [feature, crossStd(feature)]))
for (const row of stockRows) {
  const candle = row.candles
  const directional = row.sign * (
    0.30 * (candle.return15 - candleMean.return15) / candleStd.return15 +
    0.20 * (candle.vwapGap - candleMean.vwapGap) / candleStd.vwapGap +
    0.15 * (candle.emaGap - candleMean.emaGap) / candleStd.emaGap +
    0.10 * (2 * candle.greenShare - 1) +
    0.15 * (2 * candle.greenVolumeShare - 1) +
    0.10 * candle.efficiency)
  row.candleStrength = Math.max(0, directional)
}

function percentileRanks(rows, getter) {
  const ordered = rows.slice().sort((left, right) => getter(left) - getter(right))
  const result = new Map()
  ordered.forEach((row, index) => result.set(row.symbol,
    ordered.length > 1 ? index / (ordered.length - 1) : 1))
  return result
}
const depthRanks = percentileRanks(stockRows, (row) => row.depthStrength)
const positiveCandleRows = stockRows.filter((row) => row.candleStrength > 0)
const candleRanks = percentileRanks(positiveCandleRows, (row) => row.candleStrength)
for (const row of stockRows) {
  row.depthScore = 70 * (depthRanks.get(row.symbol) ?? 0)
  row.candleScore = row.candleStrength > 0 ? 30 * (candleRanks.get(row.symbol) ?? 0) : 0
  row.totalScore = row.depthScore + row.candleScore
}
stockRows.sort((left, right) => right.totalScore - left.totalScore)

const columns = ["rank", "symbol", "side", "total_score", "depth_score_70", "candle_score_30",
  "depth_coherence_pct", "current_full_imbalance", "prior_opening_full_imbalance", "full_change",
  "current_top2_imbalance", "prior_opening_top2_imbalance", "top2_change", "current_ofi", "prior_opening_ofi",
  "current_positive_depth_minutes_pct", "prior_opening_positive_depth_minutes_pct", "current_mid_drift_pct",
  "prior_opening_mid_drift_pct", "depth_minutes", "depth_ticks", "candle_return_15_pct", "vwap_gap_pct",
  "ema5_vs_ema10_pct", "green_candles_pct", "green_volume_share_pct", "candle_efficiency"]
const csv = [columns.join(",")]
stockRows.forEach((row, index) => csv.push([
  index + 1, row.symbol, row.side, round(row.totalScore, 2), round(row.depthScore, 2),
  round(row.candleScore, 2), round(row.coherence * 100, 1), round(row.current.full),
  round(row.baseline.full), round(row.current.full - row.baseline.full), round(row.current.top2),
  round(row.baseline.top2), round(row.current.top2 - row.baseline.top2), round(row.current.ofi, 4),
  round(row.baseline.ofi, 4), round(row.current.positiveMinutes * 100, 1),
  round(row.baseline.positiveMinutes * 100, 1), round(row.current.midDrift), round(row.baseline.midDrift),
  row.current.minutes, row.current.ticks, round(row.candles.return15), round(row.candles.vwapGap),
  round(row.candles.emaGap), round(row.candles.greenShare * 100, 1),
  round(row.candles.greenVolumeShare * 100, 1), round(row.candles.efficiency, 3),
].join(",")))
await fsp.writeFile(output, `${csv.join("\n")}\n`)

console.log(JSON.stringify({ output, baselineDays: historyDays, excludedDay: "2026-10-05 (capture starts after 10:02 IST)", eligibleStocks: stockRows.length,
  globalHistoricalStd: Object.fromEntries(features.map((feature) => [feature, round(globalStd[feature], 4)])),
  top10: stockRows.slice(0, 10).map((row, index) => ({
    rank: index + 1, symbol: row.symbol, side: row.side, total: round(row.totalScore, 2),
    depth: round(row.depthScore, 2), candle: round(row.candleScore, 2),
    coherencePct: round(row.coherence * 100, 1), fullNow: round(row.current.full),
    fullPrior4: round(row.baseline.full), top2Now: round(row.current.top2),
    top2Prior4: round(row.baseline.top2), positiveMinutesNow: round(row.current.positiveMinutes * 100, 1),
    positiveMinutesPrior4: round(row.baseline.positiveMinutes * 100, 1),
    midDriftNow: round(row.current.midDrift), midDriftPrior4: round(row.baseline.midDrift),
    return15: round(row.candles.return15), greenVolumePct: round(row.candles.greenVolumeShare * 100, 1),
  }))
}, null, 2))
