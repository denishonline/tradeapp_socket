import fs from "node:fs"
import fsp from "node:fs/promises"
import path from "node:path"
import readline from "node:readline"

const root = typeof nodeRepl === "undefined" ? process.cwd() : nodeRepl.cwd
const day = globalThis.DEPTH_TICK_SCAN_DAY || "2026-10-08"
const depthRoot = path.join(root, "db", "cash-depth", day)
const candleRoot = path.join(root, "db", "candles")
const output = path.join(root, "csv", `${day}-0930-negative-day-buy-volume-upside-each-depth.csv`)
const windowStart = Date.parse(`${day}T03:45:00.000Z`)
const windowEnd = Date.parse(`${day}T04:00:00.000Z`)

const round = (value, digits = 3) => Number.isFinite(value) ? Number(value.toFixed(digits)) : null
const pct = (value, base) => base > 0 ? (value / base - 1) * 100 : NaN

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

async function previousClose(symbol) {
  let previous = null
  for await (const row of records(path.join(candleRoot, `${symbol}.jsonl`))) {
    const at = Number(row.time) * 1000
    const close = Number(row.close)
    if (!Number.isFinite(at) || !Number.isFinite(close) || close <= 0 || at >= windowStart) continue
    if (!previous || at > previous.at) previous = { at, close }
  }
  return previous?.close ?? NaN
}

async function scan(symbol) {
  const fields = {}
  let firstAt = null, lastAt = null, previousMid = null
  let previousVolume = null, previousTradePrice = null, lastDirection = 0, lastPrice = NaN
  let depthTicks = 0, upTicks = 0, downTicks = 0, cumulativeUpPct = 0, cumulativeDownPct = 0
  let volumeEvents = 0, executedVolume = 0, buyVolume = 0, sellVolume = 0, unknownVolume = 0

  for await (const record of records(path.join(depthRoot, symbol, `${symbol}.jsonl`))) {
    const at = Date.parse(record.receivedAt)
    if (!Number.isFinite(at) || at < windowStart || at >= windowEnd) continue
    if (record.kind === "checkpoint" || record.book) {
      for (const key of Object.keys(fields)) delete fields[key]
      Object.assign(fields, record.data)
    } else if (record.kind === "update") Object.assign(fields, record.data)
    else continue

    const bid = Number(fields.bid_price1), ask = Number(fields.ask_price1)
    if (!Number.isFinite(bid) || !Number.isFinite(ask) || bid <= 0 || ask <= bid) continue
    const mid = (bid + ask) / 2
    if (firstAt === null) firstAt = at
    lastAt = at
    depthTicks++
    if (previousMid !== null) {
      const change = pct(mid, previousMid)
      if (change > 0) { upTicks++; cumulativeUpPct += change }
      else if (change < 0) { downTicks++; cumulativeDownPct += -change }
    }
    previousMid = mid

    const cumulativeVolume = Number(record.marketContext?.cumulativeVolume)
    const tradePrice = Number(record.marketContext?.price)
    if (Number.isFinite(tradePrice) && tradePrice > 0) lastPrice = tradePrice
    if (!Number.isFinite(cumulativeVolume) || cumulativeVolume < 0 ||
        !Number.isFinite(tradePrice) || tradePrice <= 0) continue
    if (previousVolume === null || cumulativeVolume < previousVolume) {
      previousVolume = cumulativeVolume
      previousTradePrice = tradePrice
      continue
    }
    const delta = cumulativeVolume - previousVolume
    previousVolume = cumulativeVolume
    if (delta <= 0) continue
    volumeEvents++
    executedVolume += delta

    let direction = 0
    if (tradePrice >= ask) direction = 1
    else if (tradePrice <= bid) direction = -1
    else if (tradePrice > previousTradePrice) direction = 1
    else if (tradePrice < previousTradePrice) direction = -1
    else direction = lastDirection
    if (direction > 0) buyVolume += delta
    else if (direction < 0) sellVolume += delta
    else unknownVolume += delta
    if (direction) lastDirection = direction
    previousTradePrice = tradePrice
  }

  if (firstAt === null || lastAt === null || !Number.isFinite(lastPrice)) return null
  const referenceClose = await previousClose(symbol)
  const minutes = Math.max((lastAt - firstAt) / 60_000, 1 / 60)
  const classified = buyVolume + sellVolume
  const directionalTicks = upTicks + downTicks
  return {
    symbol, referenceClose, lastPrice, dayReturn: pct(lastPrice, referenceClose),
    depthTicks, depthTicksPerMinute: depthTicks / minutes,
    upTicks, upTicksPerMinute: upTicks / minutes,
    upwardDistancePerMinute: cumulativeUpPct / minutes,
    upwardTickShare: directionalTicks ? 100 * upTicks / directionalTicks : 0,
    upwardDistanceShare: cumulativeUpPct + cumulativeDownPct
      ? 100 * cumulativeUpPct / (cumulativeUpPct + cumulativeDownPct) : 0,
    volumeEvents, executedVolume, buyVolume, sellVolume, unknownVolume,
    buySharesPerMinute: buyVolume / minutes,
    buyShare: classified ? 100 * buyVolume / classified : 0,
  }
}

const symbols = (await fsp.readdir(depthRoot, { withFileTypes: true }))
  .filter((entry) => entry.isDirectory()).map((entry) => entry.name)
const allRows = []
let cursor = 0
await Promise.all(Array.from({ length: 12 }, async () => {
  while (cursor < symbols.length) {
    const symbol = symbols[cursor++]
    try {
      const row = await scan(symbol)
      if (row) allRows.push(row)
    } catch (error) {
      console.error(`${symbol}: ${error.message}`)
    }
  }
}))

function percentile(field, value) {
  const sorted = allRows.map((row) => row[field]).sort((left, right) => left - right)
  let below = 0
  while (below < sorted.length && sorted[below] < value) below++
  let through = below
  while (through < sorted.length && sorted[through] === value) through++
  return sorted.length > 1 ? 100 * ((below + through - 1) / 2) / (sorted.length - 1) : 100
}

for (const row of allRows) {
  row.buySpeedPercentile = percentile("buySharesPerMinute", row.buySharesPerMinute)
  row.upDistancePercentile = percentile("upwardDistancePerMinute", row.upwardDistancePerMinute)
  row.upTickRatePercentile = percentile("upTicksPerMinute", row.upTicksPerMinute)
  row.score = 0.50 * row.buySpeedPercentile + 0.30 * row.upDistancePercentile +
    0.20 * row.upTickRatePercentile
}
const rows = allRows.filter((row) => row.dayReturn < 0 && row.buyShare > 50)
rows.sort((left, right) => right.score - left.score || right.buySharesPerMinute - left.buySharesPerMinute)

const columns = ["rank", "symbol", "score", "previous_close", "price_at_0930", "day_return_pct",
  "buy_volume", "buy_shares_per_minute", "buy_share_pct", "up_depth_ticks",
  "up_depth_ticks_per_minute", "cumulative_up_distance_pct_per_minute", "up_tick_share_pct",
  "up_distance_share_pct", "total_depth_ticks", "depth_ticks_per_minute"]
const csv = [columns.join(",")]
rows.forEach((row, index) => csv.push([
  index + 1, row.symbol, round(row.score, 2), round(row.referenceClose), round(row.lastPrice),
  round(row.dayReturn), row.buyVolume, round(row.buySharesPerMinute, 2), round(row.buyShare, 2),
  row.upTicks, round(row.upTicksPerMinute, 2), round(row.upwardDistancePerMinute, 4),
  round(row.upwardTickShare, 2), round(row.upwardDistanceShare, 2), row.depthTicks,
  round(row.depthTicksPerMinute, 2),
].join(",")))
await fsp.writeFile(output, `${csv.join("\n")}\n`)

export const result = {
  output, day, stocksScanned: symbols.length, eligibleStocks: rows.length,
  method: "50% BUY-volume speed + 30% cumulative upward midpoint distance speed + 20% upward depth-tick rate",
  top: rows.slice(0, 15).map((row, index) => ({
    rank: index + 1, symbol: row.symbol, score: round(row.score, 2),
    previousClose: round(row.referenceClose), priceAt0930: round(row.lastPrice),
    dayReturn: round(row.dayReturn), buyVolume: row.buyVolume,
    buySharesPerMinute: round(row.buySharesPerMinute, 2), buyShare: round(row.buyShare, 2),
    upDepthTicks: row.upTicks, upDepthTicksPerMinute: round(row.upTicksPerMinute, 2),
    upwardDistancePctPerMinute: round(row.upwardDistancePerMinute, 4),
    upwardTickShare: round(row.upwardTickShare, 2),
    upwardDistanceShare: round(row.upwardDistanceShare, 2), depthTicks: row.depthTicks,
  })),
}

if (typeof nodeRepl === "undefined") console.log(JSON.stringify(result, null, 2))
