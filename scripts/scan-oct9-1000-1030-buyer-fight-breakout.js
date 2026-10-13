import fs from "node:fs"
import fsp from "node:fs/promises"
import path from "node:path"
import readline from "node:readline"

const root = typeof nodeRepl === "undefined" ? process.cwd() : nodeRepl.cwd
const day = "2026-10-09"
const scanWindow = globalThis.BUYER_FIGHT_SCAN_WINDOW || {
  start: `${day}T04:30:00.000Z`, end: `${day}T05:00:00.000Z`, label: "1000-1030",
}
const depthRoot = path.join(root, "db", "cash-depth", day)
const candleRoot = path.join(root, "db", "candles")
const output = path.join(root, "csv", `${day}-${scanWindow.label}-buyer-fight-breakout.csv`)
const start = Date.parse(scanWindow.start)
const end = Date.parse(scanWindow.end)
const IST_OFFSET = 330 * 60_000

const mean = (values) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : NaN
const pct = (value, base) => base > 0 ? (value / base - 1) * 100 : NaN
const clamp = (value, low = 0, high = 1) => Math.min(high, Math.max(low, value))
const round = (value, digits = 3) => Number.isFinite(value) ? Number(value.toFixed(digits)) : null
const indiaTime = (at) => new Date(at + IST_OFFSET).toISOString().slice(11, 16)

async function* records(filename) {
  const input = fs.createReadStream(filename, { encoding: "utf8" })
  const lines = readline.createInterface({ input, crlfDelay: Infinity })
  try {
    for await (const line of lines) {
      if (!line.trim()) continue
      try { yield JSON.parse(line) } catch { /* Ignore an incomplete final record. */ }
    }
  } finally {
    lines.close()
    input.destroy()
  }
}

function book(fields) {
  let bidSize = 0, askSize = 0, bid2 = 0, ask2 = 0
  let bid = NaN, ask = NaN, bid1 = NaN, ask1 = NaN
  for (let level = 1; level <= 5; level++) {
    const bp = Number(fields[`bid_price${level}`]), ap = Number(fields[`ask_price${level}`])
    const bs = Number(fields[`bid_size${level}`]), as = Number(fields[`ask_size${level}`])
    if (![bp, ap, bs, as].every(Number.isFinite) || bp <= 0 || ap <= bp || bs < 0 || as < 0) return null
    if (level === 1) { bid = bp; ask = ap; bid1 = bs; ask1 = as }
    bidSize += bs; askSize += as
    if (level <= 2) { bid2 += bs; ask2 += as }
  }
  return { bid, ask, bid1, ask1, mid: (bid + ask) / 2,
    full: (bidSize - askSize) / (bidSize + askSize || 1),
    top2: (bid2 - ask2) / (bid2 + ask2 || 1) }
}

async function readCandles(symbol) {
  const rows = []
  for await (const row of records(path.join(candleRoot, `${symbol}.jsonl`))) {
    const at = Number(row.time) * 1000
    if (at < start || at >= end) continue
    const candle = { at, open: Number(row.open), high: Number(row.high), low: Number(row.low),
      close: Number(row.close), volume: Number(row.volume) }
    if (Object.values(candle).every(Number.isFinite)) rows.push(candle)
  }
  return rows.sort((left, right) => left.at - right.at)
}

async function readDepthMinutes(symbol) {
  const fields = {}, bySecond = new Map(), volumeByMinute = new Map()
  let previousVolume = null, previousTradePrice = null, lastDirection = 0
  for await (const record of records(path.join(depthRoot, symbol, `${symbol}.jsonl`))) {
    const at = Date.parse(record.receivedAt)
    if (!Number.isFinite(at) || at >= end) break
    if (record.kind === "checkpoint" || record.book) {
      for (const key of Object.keys(fields)) delete fields[key]
      Object.assign(fields, record.data)
    } else if (record.kind === "update") Object.assign(fields, record.data)
    else continue
    const currentBook = book(fields)
    const cumulativeVolume = Number(record.marketContext?.cumulativeVolume)
    const tradePrice = Number(record.marketContext?.price)
    if (at >= start && currentBook) bySecond.set(Math.floor(at / 1000), { at, ...currentBook })
    if (!Number.isFinite(cumulativeVolume) || cumulativeVolume < 0 ||
        !Number.isFinite(tradePrice) || tradePrice <= 0) continue
    if (previousVolume === null || cumulativeVolume < previousVolume) {
      previousVolume = cumulativeVolume; previousTradePrice = tradePrice; continue
    }
    const delta = cumulativeVolume - previousVolume
    previousVolume = cumulativeVolume
    if (delta <= 0) continue
    let direction = 0
    if (currentBook) {
      if (tradePrice >= currentBook.ask) direction = 1
      else if (tradePrice <= currentBook.bid) direction = -1
    }
    if (!direction) {
      if (tradePrice > previousTradePrice) direction = 1
      else if (tradePrice < previousTradePrice) direction = -1
      else direction = lastDirection
    }
    if (at >= start) {
      const minute = Math.floor(at / 60_000) * 60_000
      if (!volumeByMinute.has(minute)) volumeByMinute.set(minute, { buy: 0, sell: 0 })
      if (direction > 0) volumeByMinute.get(minute).buy += delta
      else if (direction < 0) volumeByMinute.get(minute).sell += delta
    }
    if (direction) lastDirection = direction
    previousTradePrice = tradePrice
  }

  const samples = [...bySecond.values()].sort((left, right) => left.at - right.at)
  let previous = null
  for (const sample of samples) {
    sample.ofi = 0
    if (previous) {
      let flow = sample.bid > previous.bid ? sample.bid1
        : sample.bid === previous.bid ? sample.bid1 - previous.bid1 : -previous.bid1
      flow -= sample.ask < previous.ask ? sample.ask1
        : sample.ask === previous.ask ? sample.ask1 - previous.ask1 : -sample.ask1
      sample.ofi = flow / ((sample.bid1 + sample.ask1 + previous.bid1 + previous.ask1) / 2 || 1)
    }
    previous = sample
  }
  const grouped = new Map()
  for (const sample of samples) {
    const minute = Math.floor(sample.at / 60_000) * 60_000
    if (!grouped.has(minute)) grouped.set(minute, [])
    grouped.get(minute).push(sample)
  }
  return [...grouped].map(([at, rows]) => {
    const volume = volumeByMinute.get(at) || { buy: 0, sell: 0 }
    const classified = volume.buy + volume.sell
    return { at, updates: rows.length, openMid: rows[0].mid, closeMid: rows.at(-1).mid,
      highMid: Math.max(...rows.map((row) => row.mid)), lowMid: Math.min(...rows.map((row) => row.mid)),
      full: mean(rows.map((row) => row.full)), top2: mean(rows.map((row) => row.top2)),
      ofi: mean(rows.slice(1).map((row) => row.ofi)), buy: volume.buy, sell: volume.sell,
      buyShare: classified ? volume.buy / classified : 0.5 }
  }).sort((left, right) => left.at - right.at)
}

function regressionR2(values) {
  if (values.length < 3) return 0
  const mx = (values.length - 1) / 2, my = mean(values)
  let covariance = 0, vx = 0, vy = 0
  values.forEach((value, index) => {
    const dx = index - mx, dy = value - my
    covariance += dx * dy; vx += dx * dx; vy += dy * dy
  })
  return vx && vy ? covariance ** 2 / (vx * vy) : 0
}

function efficiency(values) {
  const travel = values.slice(1).reduce((sum, value, index) => sum + Math.abs(value - values[index]), 0)
  return travel ? Math.abs(values.at(-1) - values[0]) / travel : 0
}

function combinedBuyShare(minutes) {
  const buy = minutes.reduce((sum, row) => sum + row.buy, 0)
  const sell = minutes.reduce((sum, row) => sum + row.sell, 0)
  return buy + sell ? buy / (buy + sell) : 0.5
}

function evaluate(symbol, candles, depth) {
  if (candles.length < 15 || depth.length < 15) return null
  const depthMap = new Map(depth.map((row) => [row.at, row]))
  let best = null
  for (let index = 10; index + 4 < candles.length; index++) {
    const prior = candles.slice(index - 10, index)
    const pickup = candles.slice(index, index + 5)
    const priorDepth = prior.map((row) => depthMap.get(row.at))
    const pickupDepth = pickup.map((row) => depthMap.get(row.at))
    if (priorDepth.some((row) => !row || row.updates < 3) || pickupDepth.some((row) => !row || row.updates < 3)) continue

    const priorHigh = Math.max(...prior.map((row) => row.high))
    const breakout = pickup[0].close > priorHigh
    const fightBuyShare = combinedBuyShare(priorDepth)
    const fightPositiveDepth = priorDepth.filter((row) => (row.full + row.top2) / 2 > 0).length / priorDepth.length
    const fightImbalance = mean(priorDepth.map((row) => (row.full + row.top2) / 2))
    const fightOfi = mean(priorDepth.map((row) => row.ofi))
    const priorCloses = [prior[0].open, ...prior.map((row) => row.close)]
    const fightEfficiency = efficiency(priorCloses)
    const fightRange = pct(Math.max(...prior.map((row) => row.high)), Math.min(...prior.map((row) => row.low)))

    const pickupReturn = pct(pickup.at(-1).close, pickup[0].open)
    const pickupR2 = regressionR2(pickup.map((row) => row.close))
    const pickupBuyShare = combinedBuyShare(pickupDepth)
    const pickupImbalance = mean(pickupDepth.map((row) => (row.full + row.top2) / 2))
    const pickupOfi = mean(pickupDepth.map((row) => row.ofi))
    const greenCandles = pickup.filter((row) => row.close > row.open).length
    const totalPickupVolume = pickup.reduce((sum, row) => sum + row.volume, 0)
    const greenVolumeShare = totalPickupVolume ? pickup.filter((row) => row.close > row.open)
      .reduce((sum, row) => sum + row.volume, 0) / totalPickupVolume : 0
    const priorFiveVolume = prior.slice(-5).reduce((sum, row) => sum + row.volume, 0)
    const pickupVolumeRatio = priorFiveVolume ? totalPickupVolume / priorFiveVolume : 0
    const returnTo1030 = pct(candles.at(-1).close, pickup[0].close)

    if (!(breakout && fightBuyShare >= 0.50 && fightPositiveDepth >= 0.40 &&
      fightRange >= 0.15 && fightEfficiency <= 0.80 && pickupReturn >= 0.20 &&
      pickupR2 >= 0.45 && pickupBuyShare >= 0.52 && pickupImbalance > 0 &&
      greenCandles >= 3 && greenVolumeShare >= 0.50 && pickupVolumeRatio >= 0.80)) continue

    const fightScore = 15 * clamp((fightBuyShare - 0.50) / 0.20) +
      10 * clamp(fightPositiveDepth / 0.80) + 10 * clamp((fightImbalance + 0.05) / 0.20) +
      5 * clamp((fightOfi + 0.05) / 0.20) + 10 * clamp(1 - fightEfficiency / 0.80)
    const pickupScore = 15 * clamp(pickupReturn / 1.0) + 10 * pickupR2 +
      10 * clamp((pickupBuyShare - 0.50) / 0.25) +
      5 * clamp((pickupImbalance + 0.02) / 0.18) +
      5 * greenVolumeShare + 5 * clamp(pickupVolumeRatio / 2)
    const candidate = { symbol, pickupAt: pickup[0].at + 60_000, totalScore: fightScore + pickupScore,
      fightScore, pickupScore, fightBuyShare, fightPositiveDepth, fightImbalance, fightOfi,
      fightEfficiency, fightRange, priorHigh, breakoutClose: pickup[0].close, pickupReturn,
      pickupR2, pickupBuyShare, pickupImbalance, pickupOfi, greenCandles,
      greenVolumeShare, pickupVolumeRatio, returnTo1030 }
    if (!best || candidate.totalScore > best.totalScore) best = candidate
  }
  return best
}

const symbols = (await fsp.readdir(depthRoot, { withFileTypes: true }))
  .filter((entry) => entry.isDirectory()).map((entry) => entry.name)
const rows = []
let cursor = 0
await Promise.all(Array.from({ length: 10 }, async () => {
  while (cursor < symbols.length) {
    const symbol = symbols[cursor++]
    try {
      const [candles, depth] = await Promise.all([readCandles(symbol), readDepthMinutes(symbol)])
      const result = evaluate(symbol, candles, depth)
      if (result) rows.push(result)
    } catch (error) {
      console.error(`${symbol}: ${error.message}`)
    }
  }
}))
rows.sort((left, right) => right.totalScore - left.totalScore || right.pickupReturn - left.pickupReturn)

const columns = ["rank", "symbol", "pickup_time", "score", "fight_score", "pickup_score",
  "fight_buy_share_pct", "fight_positive_depth_minutes_pct", "fight_depth_imbalance",
  "fight_ofi", "fight_range_pct", "fight_efficiency", "prior_high", "breakout_close",
  "pickup_5m_return_pct", "pickup_trend_r2", "pickup_buy_share_pct", "pickup_depth_imbalance",
  "pickup_ofi", "green_candles_of_5", "green_volume_share_pct", "pickup_volume_ratio",
  "return_from_breakout_to_window_end_pct"]
const csv = [columns.join(",")]
rows.forEach((row, index) => csv.push([
  index + 1, row.symbol, indiaTime(row.pickupAt), round(row.totalScore, 2),
  round(row.fightScore, 2), round(row.pickupScore, 2), round(row.fightBuyShare * 100, 1),
  round(row.fightPositiveDepth * 100, 1), round(row.fightImbalance), round(row.fightOfi),
  round(row.fightRange), round(row.fightEfficiency), round(row.priorHigh), round(row.breakoutClose),
  round(row.pickupReturn), round(row.pickupR2), round(row.pickupBuyShare * 100, 1),
  round(row.pickupImbalance), round(row.pickupOfi), row.greenCandles,
  round(row.greenVolumeShare * 100, 1), round(row.pickupVolumeRatio), round(row.returnTo1030),
].join(",")))
await fsp.writeFile(output, `${csv.join("\n")}\n`)

export const result = {
  output, stocksScanned: symbols.length, qualifyingStocks: rows.length,
  top: rows.slice(0, 15).map((row, index) => ({ rank: index + 1, symbol: row.symbol,
    pickupTime: indiaTime(row.pickupAt), score: round(row.totalScore, 2),
    fightBuyShare: round(row.fightBuyShare * 100, 1),
    fightPositiveDepthMinutes: round(row.fightPositiveDepth * 100, 1),
    fightImbalance: round(row.fightImbalance), fightRange: round(row.fightRange),
    fightEfficiency: round(row.fightEfficiency), breakoutClose: round(row.breakoutClose),
    pickup5mReturn: round(row.pickupReturn), pickupTrendR2: round(row.pickupR2),
    pickupBuyShare: round(row.pickupBuyShare * 100, 1), pickupImbalance: round(row.pickupImbalance),
    pickupOfi: round(row.pickupOfi), greenCandles: row.greenCandles,
    greenVolumeShare: round(row.greenVolumeShare * 100, 1),
    volumeRatio: round(row.pickupVolumeRatio), returnTo1030: round(row.returnTo1030) })),
}

if (typeof nodeRepl === "undefined") console.log(JSON.stringify(result, null, 2))
