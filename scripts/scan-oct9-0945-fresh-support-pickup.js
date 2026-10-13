import fs from "node:fs"
import fsp from "node:fs/promises"
import path from "node:path"
import readline from "node:readline"

const root = typeof nodeRepl === "undefined" ? process.cwd() : nodeRepl.cwd
const day = "2026-10-09"
const scanWindow = globalThis.FRESH_PICKUP_SCAN_WINDOW || {
  end: `${day}T04:15:00.000Z`, label: "0945",
}
const depthRoot = path.join(root, "db", "cash-depth", day)
const candleRoot = path.join(root, "db", "candles")
const output = path.join(root, "csv", `${day}-${scanWindow.label}-fresh-support-pickup.csv`)
const start = Date.parse(`${day}T03:45:00.000Z`)
const end = Date.parse(scanWindow.end)

const mean = (values) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : NaN
const pct = (value, base) => base > 0 ? (value / base - 1) * 100 : NaN
const clamp = (value, low = 0, high = 1) => Math.min(high, Math.max(low, value))
const round = (value, digits = 3) => Number.isFinite(value) ? Number(value.toFixed(digits)) : null

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

async function readDepth(symbol) {
  const fields = {}, bySecond = new Map()
  for await (const record of records(path.join(depthRoot, symbol, `${symbol}.jsonl`))) {
    const at = Date.parse(record.receivedAt)
    if (!Number.isFinite(at) || at < start || at >= end) continue
    if (record.kind === "checkpoint" || record.book) {
      for (const key of Object.keys(fields)) delete fields[key]
      Object.assign(fields, record.data)
    } else if (record.kind === "update") Object.assign(fields, record.data)
    else continue
    const current = book(fields)
    if (current) bySecond.set(Math.floor(at / 1000), { at, ...current })
  }
  const samples = [...bySecond.values()].sort((left, right) => left.at - right.at)
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
  return samples
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

function ema(values, length) {
  const alpha = 2 / (length + 1)
  return values.reduce((value, next, index) => index ? alpha * next + (1 - alpha) * value : next)
}

function evaluate(symbol, candles, depth) {
  if (candles.length < 30 || depth.length < 60) return null
  const recent = candles.slice(-5)
  const previousFive = candles.slice(-10, -5)
  const fight = candles.slice(-15, -5)
  const supportWindow = candles.slice(-20, -5)
  const support = Math.min(...supportWindow.map((row) => row.low))
  const supportTouches = supportWindow.filter((row) => pct(row.low, support) <= 0.20).length
  const current = recent.at(-1).close
  const supportDistance = pct(current, support)
  const recentReturn = pct(current, recent[0].open)
  const recentR2 = regressionR2(recent.map((row) => row.close))
  const greenCandles = recent.filter((row) => row.close > row.open).length
  const recentVolume = recent.reduce((sum, row) => sum + row.volume, 0)
  const previousVolume = previousFive.reduce((sum, row) => sum + row.volume, 0)
  const volumeRatio = previousVolume ? recentVolume / previousVolume : 0
  const greenVolumeShare = recentVolume ? recent.filter((row) => row.close > row.open)
    .reduce((sum, row) => sum + row.volume, 0) / recentVolume : 0
  const vwap5 = recentVolume ? recent.reduce((sum, row) =>
    sum + row.volume * (row.high + row.low + row.close) / 3, 0) / recentVolume : NaN
  const closes = candles.map((row) => row.close)
  const emaGap = pct(ema(closes, 3), ema(closes, 8))
  const fightValues = [fight[0].open, ...fight.map((row) => row.close)]
  const fightEfficiency = efficiency(fightValues)
  const fightRange = pct(Math.max(...fight.map((row) => row.high)), Math.min(...fight.map((row) => row.low)))

  const recentStart = recent[0].at
  const fightStart = fight[0].at
  const recentDepth = depth.filter((row) => row.at >= recentStart)
  const fightDepth = depth.filter((row) => row.at >= fightStart && row.at < recentStart)
  if (recentDepth.length < 20 || fightDepth.length < 30) return null
  const recentImbalance = mean(recentDepth.map((row) => (row.full + row.top2) / 2))
  const recentOfi = mean(recentDepth.slice(1).map((row) => row.ofi))
  const positiveDepthShare = recentDepth.filter((row) => row.full > 0 && row.top2 > 0).length / recentDepth.length
  const depthReturn = pct(recentDepth.at(-1).mid, recentDepth[0].mid)
  const fightImbalance = mean(fightDepth.map((row) => (row.full + row.top2) / 2))
  const fightPositiveShare = fightDepth.filter((row) => row.full > 0 && row.top2 > 0).length / fightDepth.length

  const checks = {
    support_touch: supportTouches >= 1,
    above_support: supportDistance >= 0.15,
    below_one_percent: supportDistance < 1.0,
    fresh_momentum: recentReturn >= 0.10 && recentReturn < 1.0,
    smooth_recent_trend: recentR2 >= 0.50,
    green_candles: greenCandles >= 3,
    volume_expansion: volumeRatio >= 1.0,
    green_volume: greenVolumeShare >= 0.55,
    above_vwap: current > vwap5,
    ema_up: emaGap > 0,
    active_fight: fightRange >= 0.15,
    choppy_fight: fightEfficiency <= 0.70,
    fight_depth: fightPositiveShare >= 0.40,
    strong_recent_depth: recentImbalance >= 0.03,
    nonnegative_ofi: recentOfi >= -0.02,
    positive_depth_share: positiveDepthShare >= 0.45,
    rising_depth_price: depthReturn > 0,
  }

  const supportScore = 15 * clamp(supportTouches / 4) + 10 * clamp(1 - supportDistance / 1.0)
  const fightScore = 10 * clamp(1 - fightEfficiency / 0.70) + 5 * clamp(fightRange / 0.60) +
    5 * clamp((fightImbalance + 0.05) / 0.20)
  const pickupScore = 15 * clamp(recentReturn / 0.80) + 10 * recentR2 +
    10 * clamp(volumeRatio / 2) + 10 * greenVolumeShare +
    5 * clamp((recentImbalance + 0.02) / 0.18) + 5 * clamp(positiveDepthShare / 0.80) +
    5 * clamp(depthReturn / 0.50)
  return { symbol, qualified: Object.values(checks).every(Boolean),
    passedChecks: Object.values(checks).filter(Boolean).length,
    failedChecks: Object.entries(checks).filter(([, passed]) => !passed).map(([name]) => name),
    score: supportScore + fightScore + pickupScore, support, supportTouches,
    supportDistance, fightRange, fightEfficiency, fightImbalance, fightPositiveShare,
    current, recentReturn, recentR2, greenCandles, volumeRatio, greenVolumeShare,
    emaGap, vwapGap: pct(current, vwap5), recentImbalance, recentOfi,
    positiveDepthShare, depthReturn }
}

const symbols = (await fsp.readdir(depthRoot, { withFileTypes: true }))
  .filter((entry) => entry.isDirectory()).map((entry) => entry.name)
const rows = []
const audited = []
let cursor = 0
await Promise.all(Array.from({ length: 10 }, async () => {
  while (cursor < symbols.length) {
    const symbol = symbols[cursor++]
    try {
      const [candles, depth] = await Promise.all([readCandles(symbol), readDepth(symbol)])
      const result = evaluate(symbol, candles, depth)
      if (result) {
        audited.push(result)
        if (result.qualified) rows.push(result)
      }
    } catch (error) {
      console.error(`${symbol}: ${error.message}`)
    }
  }
}))
rows.sort((left, right) => right.score - left.score || right.recentReturn - left.recentReturn)
audited.sort((left, right) => right.passedChecks - left.passedChecks || right.score - left.score)

const columns = ["rank", "symbol", "score", "support", "support_touches", "distance_from_support_pct",
  "fight_range_pct", "fight_efficiency", "fight_depth_imbalance", "fight_positive_depth_pct",
  "price_at_window_end", "recent_5m_return_pct", "recent_trend_r2", "green_candles_of_5",
  "volume_ratio_5v5", "green_volume_share_pct", "ema3_ema8_gap_pct", "vwap5_gap_pct",
  "recent_depth_imbalance", "recent_ofi", "recent_positive_depth_pct", "recent_depth_return_pct"]
const csv = [columns.join(",")]
rows.forEach((row, index) => csv.push([
  index + 1, row.symbol, round(row.score, 2), round(row.support), row.supportTouches,
  round(row.supportDistance), round(row.fightRange), round(row.fightEfficiency),
  round(row.fightImbalance), round(row.fightPositiveShare * 100, 1), round(row.current),
  round(row.recentReturn), round(row.recentR2), row.greenCandles, round(row.volumeRatio),
  round(row.greenVolumeShare * 100, 1), round(row.emaGap), round(row.vwapGap),
  round(row.recentImbalance), round(row.recentOfi), round(row.positiveDepthShare * 100, 1),
  round(row.depthReturn),
].join(",")))
await fsp.writeFile(output, `${csv.join("\n")}\n`)

export const result = { output, stocksScanned: symbols.length, qualifyingStocks: rows.length,
  top: rows.slice(0, 15).map((row, index) => ({ rank: index + 1, symbol: row.symbol,
    score: round(row.score, 2), support: round(row.support), supportTouches: row.supportTouches,
    distanceFromSupport: round(row.supportDistance), fightRange: round(row.fightRange),
    fightEfficiency: round(row.fightEfficiency), fightImbalance: round(row.fightImbalance),
    priceAtWindowEnd: round(row.current), recent5mReturn: round(row.recentReturn),
    recentTrendR2: round(row.recentR2), greenCandles: row.greenCandles,
    volumeRatio: round(row.volumeRatio), greenVolumeShare: round(row.greenVolumeShare * 100, 1),
    emaGap: round(row.emaGap), vwapGap: round(row.vwapGap),
    recentDepthImbalance: round(row.recentImbalance), recentOfi: round(row.recentOfi),
    positiveDepth: round(row.positiveDepthShare * 100, 1), depthReturn: round(row.depthReturn) })),
  nearMatches: audited.slice(0, 15).map((row, index) => ({ rank: index + 1, symbol: row.symbol,
    passedChecks: row.passedChecks, failedChecks: row.failedChecks, score: round(row.score, 2),
    support: round(row.support), supportTouches: row.supportTouches,
    distanceFromSupport: round(row.supportDistance), recent5mReturn: round(row.recentReturn),
    recentTrendR2: round(row.recentR2), greenCandles: row.greenCandles,
    volumeRatio: round(row.volumeRatio), greenVolumeShare: round(row.greenVolumeShare * 100, 1),
    emaGap: round(row.emaGap), vwapGap: round(row.vwapGap), fightRange: round(row.fightRange),
    fightEfficiency: round(row.fightEfficiency), fightPositiveDepth: round(row.fightPositiveShare * 100, 1),
    recentDepthImbalance: round(row.recentImbalance), recentOfi: round(row.recentOfi),
    positiveDepth: round(row.positiveDepthShare * 100, 1), depthReturn: round(row.depthReturn) })) }

if (typeof nodeRepl === "undefined") console.log(JSON.stringify(result, null, 2))
