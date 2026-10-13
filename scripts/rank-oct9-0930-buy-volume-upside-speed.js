import fs from "node:fs"
import fsp from "node:fs/promises"
import path from "node:path"
import readline from "node:readline"

const root = typeof nodeRepl === "undefined" ? process.cwd() : nodeRepl.cwd
const day = globalThis.DEPTH_SPEED_SCAN_DAY || "2026-10-09"
const depthRoot = path.join(root, "db", "cash-depth", day)
const candleRoot = path.join(root, "db", "candles")
const output = path.join(root, "csv", `${day}-0930-buy-volume-upside-speed.csv`)
const negativeDayOutput = path.join(root, "csv", `${day}-0930-negative-day-buy-volume-upside-speed-last5m.csv`)
const windowStart = Date.parse(`${day}T03:45:00.000Z`)
const speedWindowStart = Date.parse(`${day}T03:55:00.000Z`)
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

function regressionSpeed(points) {
  if (points.length < 3) return { speed: NaN, r2: 0 }
  const origin = points[0].at
  const xs = points.map((point) => (point.at - origin) / 60_000)
  const ys = points.map((point) => Math.log(point.price))
  const meanX = xs.reduce((sum, value) => sum + value, 0) / xs.length
  const meanY = ys.reduce((sum, value) => sum + value, 0) / ys.length
  let covariance = 0, varianceX = 0, varianceY = 0
  for (let index = 0; index < xs.length; index++) {
    const dx = xs[index] - meanX, dy = ys[index] - meanY
    covariance += dx * dy
    varianceX += dx * dx
    varianceY += dy * dy
  }
  const slope = varianceX ? covariance / varianceX : 0
  const r2 = varianceX && varianceY ? covariance ** 2 / (varianceX * varianceY) : 0
  return { speed: slope * 100, r2 }
}

async function readPreviousClose(symbol) {
  let previous = null
  for await (const row of records(path.join(candleRoot, `${symbol}.jsonl`))) {
    const at = Number(row.time) * 1000
    const close = Number(row.close)
    if (!Number.isFinite(at) || !Number.isFinite(close) || close <= 0 || at >= windowStart) continue
    if (!previous || at > previous.at) previous = { at, close }
  }
  return previous
}

async function scan(symbol) {
  const filename = path.join(depthRoot, symbol, `${symbol}.jsonl`)
  const fields = {}
  let firstAt = null, lastAt = null, previousVolume = null, previousPrice = null, lastDirection = 0
  let volumeEvents = 0, executedVolume = 0, buyVolume = 0, sellVolume = 0
  let positiveTicks = 0, negativeTicks = 0
  const pricePoints = []

  for await (const record of records(filename)) {
    const at = Date.parse(record.receivedAt)
    if (!Number.isFinite(at) || at < windowStart || at >= windowEnd) continue
    if (record.kind === "checkpoint" || record.book) {
      for (const key of Object.keys(fields)) delete fields[key]
      Object.assign(fields, record.data)
    } else if (record.kind === "update") Object.assign(fields, record.data)
    else continue

    const cumulativeVolume = Number(record.marketContext?.cumulativeVolume)
    const price = Number(record.marketContext?.price)
    if (!Number.isFinite(cumulativeVolume) || cumulativeVolume < 0 || !Number.isFinite(price) || price <= 0) continue
    if (firstAt === null) firstAt = at
    lastAt = at
    if (previousVolume === null || cumulativeVolume < previousVolume) {
      previousVolume = cumulativeVolume
      previousPrice = price
      continue
    }
    const delta = cumulativeVolume - previousVolume
    previousVolume = cumulativeVolume
    if (delta <= 0) continue

    // Use 09:15-09:25 only to establish cumulative-volume and tick-direction baselines.
    // The actual buying-speed and upside-speed ranking uses the latest five minutes.
    if (at < speedWindowStart) {
      previousPrice = price
      continue
    }

    volumeEvents++
    executedVolume += delta
    if (price > previousPrice) positiveTicks++
    else if (price < previousPrice) negativeTicks++

    const bid = Number(fields.bid_price1), ask = Number(fields.ask_price1)
    let direction = 0
    if (Number.isFinite(bid) && Number.isFinite(ask) && ask > bid) {
      if (price >= ask) direction = 1
      else if (price <= bid) direction = -1
    }
    if (!direction) {
      if (price > previousPrice) direction = 1
      else if (price < previousPrice) direction = -1
      else direction = lastDirection
    }
    if (direction > 0) buyVolume += delta
    else if (direction < 0) sellVolume += delta
    if (direction) lastDirection = direction
    previousPrice = price
    pricePoints.push({ at, price })
  }

  if (!pricePoints.length || firstAt === null || lastAt === null) return null
  const observedMinutes = Math.max((lastAt - speedWindowStart) / 60_000, 1 / 60)
  const classified = buyVolume + sellVolume
  const trend = regressionSpeed(pricePoints)
  const previous = await readPreviousClose(symbol)
  const lastPrice = pricePoints.at(-1).price
  return {
    symbol, volumeEvents, executedVolume, buyVolume, sellVolume,
    buyVolumeRate: buyVolume / observedMinutes,
    buyShare: classified ? 100 * buyVolume / classified : 0,
    priceReturn: pct(pricePoints.at(-1).price, pricePoints[0].price),
    previousClose: previous?.close ?? NaN,
    lastPrice,
    dayReturn: previous ? pct(lastPrice, previous.close) : NaN,
    upsideSpeed: trend.speed, trendR2: trend.r2,
    positiveTickShare: positiveTicks + negativeTicks ? 100 * positiveTicks / (positiveTicks + negativeTicks) : 0,
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
  row.buySpeedPercentile = percentile("buyVolumeRate", row.buyVolumeRate)
  row.upsideSpeedPercentile = percentile("upsideSpeed", row.upsideSpeed)
  row.score = 0.50 * row.buySpeedPercentile + 0.50 * row.upsideSpeedPercentile
}
const rows = allRows.filter((row) => row.buyShare > 50 && row.priceReturn > 0 && row.upsideSpeed > 0)
rows.sort((left, right) => right.score - left.score || right.upsideSpeed - left.upsideSpeed)

const columns = ["rank", "symbol", "score", "inferred_buy_volume", "buy_shares_per_minute",
  "inferred_buy_share_pct", "price_return_to_0930_pct", "upside_speed_pct_per_minute",
  "uptrend_r2", "positive_price_tick_share_pct", "volume_change_events", "executed_volume"]
const csv = [columns.join(",")]
rows.forEach((row, index) => csv.push([
  index + 1, row.symbol, round(row.score, 2), row.buyVolume, round(row.buyVolumeRate, 2),
  round(row.buyShare, 2), round(row.priceReturn), round(row.upsideSpeed, 4), round(row.trendR2),
  round(row.positiveTickShare, 2), row.volumeEvents, row.executedVolume,
].join(",")))
await fsp.writeFile(output, `${csv.join("\n")}\n`)

const negativeDayRows = rows.filter((row) => row.dayReturn < 0)
const negativeColumns = ["rank", "symbol", "score", "previous_close", "price_at_0930",
  "day_return_pct", "inferred_buy_volume", "buy_shares_per_minute", "inferred_buy_share_pct",
  "last_5m_return_pct", "upside_speed_pct_per_minute", "uptrend_r2"]
const negativeCsv = [negativeColumns.join(",")]
negativeDayRows.forEach((row, index) => negativeCsv.push([
  index + 1, row.symbol, round(row.score, 2), round(row.previousClose), round(row.lastPrice),
  round(row.dayReturn), row.buyVolume, round(row.buyVolumeRate, 2), round(row.buyShare, 2),
  round(row.priceReturn), round(row.upsideSpeed, 4), round(row.trendR2),
].join(",")))
await fsp.writeFile(negativeDayOutput, `${negativeCsv.join("\n")}\n`)

export const result = {
  output, negativeDayOutput, stocksScanned: symbols.length, eligibleStocks: rows.length,
  method: "09:25-09:30: 50% inferred BUY-volume speed percentile + 50% upside price-speed percentile",
  top: rows.slice(0, 15).map((row, index) => ({
    rank: index + 1, symbol: row.symbol, score: round(row.score, 2),
    buyVolume: row.buyVolume, buySharesPerMinute: round(row.buyVolumeRate, 2),
    buyShare: round(row.buyShare, 2), priceReturn: round(row.priceReturn),
    upsideSpeedPctPerMinute: round(row.upsideSpeed, 4), uptrendR2: round(row.trendR2),
    positiveTickShare: round(row.positiveTickShare, 2), events: row.volumeEvents,
  })),
  negativeDayTop: negativeDayRows.slice(0, 15).map((row, index) => ({
    rank: index + 1, symbol: row.symbol, score: round(row.score, 2),
    previousClose: round(row.previousClose), priceAt0930: round(row.lastPrice),
    dayReturn: round(row.dayReturn), buyVolume: row.buyVolume,
    buySharesPerMinute: round(row.buyVolumeRate, 2), buyShare: round(row.buyShare, 2),
    openingWindowReturn: round(row.priceReturn), upsideSpeedPctPerMinute: round(row.upsideSpeed, 4),
    uptrendR2: round(row.trendR2),
  })),
}

if (typeof nodeRepl === "undefined") console.log(JSON.stringify(result, null, 2))
