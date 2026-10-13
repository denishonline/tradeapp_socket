import fs from "node:fs"
import fsp from "node:fs/promises"
import path from "node:path"
import readline from "node:readline"

const root = typeof nodeRepl === "undefined" ? process.cwd() : nodeRepl.cwd
const day = "2026-10-09"
const depthRoot = path.join(root, "db", "cash-depth", day)
const output = path.join(root, "csv", "2026-10-09-0930-depth-buying-activity.csv")
const IST_OFFSET = 330 * 60_000

const round = (value, digits = 2) => Number.isFinite(value) ? Number(value.toFixed(digits)) : null
const indiaDate = (at) => new Date(at + IST_OFFSET).toISOString().slice(0, 10)
const indiaTime = (at) => new Date(at + IST_OFFSET).toISOString().slice(11, 19)
const windowStart = Date.parse(`${day}T03:45:00.000Z`)
const windowEnd = Date.parse(`${day}T04:00:00.000Z`)

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

async function scan(symbol) {
  const filename = path.join(depthRoot, symbol, `${symbol}.jsonl`)
  const fields = {}
  let firstAt = null, lastAt = null, previousVolume = null, previousPrice = null, lastDirection = 0
  let volumeEvents = 0, executedVolume = 0, buyVolume = 0, sellVolume = 0, unknownVolume = 0
  let quoteSamples = 0, bidDominantSamples = 0

  for await (const record of records(filename)) {
    const at = Date.parse(record.receivedAt)
    if (!Number.isFinite(at) || indiaDate(at) !== day || at < windowStart || at >= windowEnd) continue
    if (record.kind === "checkpoint" || record.book) {
      for (const key of Object.keys(fields)) delete fields[key]
      Object.assign(fields, record.data)
    } else if (record.kind === "update") Object.assign(fields, record.data)
    else continue

    const bid = Number(fields.bid_price1), ask = Number(fields.ask_price1)
    const bidSize = [1, 2, 3, 4, 5].reduce((sum, level) => sum + (Number(fields[`bid_size${level}`]) || 0), 0)
    const askSize = [1, 2, 3, 4, 5].reduce((sum, level) => sum + (Number(fields[`ask_size${level}`]) || 0), 0)
    if (Number.isFinite(bid) && Number.isFinite(ask) && ask > bid) {
      quoteSamples++
      if (bidSize > askSize) bidDominantSamples++
    }

    const cumulativeVolume = Number(record.marketContext?.cumulativeVolume)
    const price = Number(record.marketContext?.price)
    if (!Number.isFinite(cumulativeVolume) || cumulativeVolume < 0) continue
    if (firstAt === null) firstAt = at
    lastAt = at
    if (previousVolume === null || cumulativeVolume < previousVolume) {
      previousVolume = cumulativeVolume
      if (Number.isFinite(price) && price > 0) previousPrice = price
      continue
    }

    const delta = cumulativeVolume - previousVolume
    previousVolume = cumulativeVolume
    if (delta <= 0) continue
    volumeEvents++
    executedVolume += delta

    let direction = 0
    if (Number.isFinite(price) && price > 0 && Number.isFinite(bid) && Number.isFinite(ask) && ask > bid) {
      if (price >= ask) direction = 1
      else if (price <= bid) direction = -1
    }
    if (!direction && Number.isFinite(price) && Number.isFinite(previousPrice)) {
      if (price > previousPrice) direction = 1
      else if (price < previousPrice) direction = -1
    }
    if (!direction) direction = lastDirection
    if (direction > 0) buyVolume += delta
    else if (direction < 0) sellVolume += delta
    else unknownVolume += delta
    if (direction) lastDirection = direction
    if (Number.isFinite(price) && price > 0) previousPrice = price
  }

  if (firstAt === null || lastAt === null) return null
  const observedMinutes = Math.max((lastAt - firstAt) / 60_000, 1 / 60)
  const classified = buyVolume + sellVolume
  return {
    symbol, firstAt, lastAt, observedMinutes, volumeEvents, executedVolume, buyVolume, sellVolume,
    unknownVolume, eventRate: volumeEvents / observedMinutes,
    executedVolumeRate: executedVolume / observedMinutes,
    buyVolumeRate: buyVolume / observedMinutes,
    buyShare: classified ? 100 * buyVolume / classified : 0,
    bidDominance: quoteSamples ? 100 * bidDominantSamples / quoteSamples : 0,
  }
}

const symbols = (await fsp.readdir(depthRoot, { withFileTypes: true }))
  .filter((entry) => entry.isDirectory()).map((entry) => entry.name)
const rows = []
let cursor = 0
await Promise.all(Array.from({ length: 12 }, async () => {
  while (cursor < symbols.length) {
    const symbol = symbols[cursor++]
    try {
      const row = await scan(symbol)
      if (row) rows.push(row)
    } catch (error) {
      console.error(`${symbol}: ${error.message}`)
    }
  }
}))

function percentile(field, value) {
  const sorted = rows.map((row) => row[field]).sort((left, right) => left - right)
  let below = 0
  while (below < sorted.length && sorted[below] < value) below++
  let through = below
  while (through < sorted.length && sorted[through] === value) through++
  const midpoint = (below + through - 1) / 2
  return sorted.length > 1 ? 100 * midpoint / (sorted.length - 1) : 100
}

for (const row of rows) {
  row.eventPercentile = percentile("eventRate", row.eventRate)
  row.buySpeedPercentile = percentile("buyVolumeRate", row.buyVolumeRate)
  row.buySharePercentile = percentile("buyShare", row.buyShare)
  row.score = 0.40 * row.eventPercentile + 0.40 * row.buySpeedPercentile +
    0.20 * row.buySharePercentile
}
rows.sort((left, right) => right.score - left.score || right.buyVolumeRate - left.buyVolumeRate)

const columns = ["rank", "symbol", "score", "observed_from", "observed_to", "volume_change_events",
  "events_per_minute", "executed_volume", "executed_shares_per_minute", "inferred_buy_volume",
  "buy_shares_per_minute", "inferred_buy_share_pct", "inferred_sell_volume", "unclassified_volume",
  "five_level_bid_dominance_pct"]
const csv = [columns.join(",")]
rows.forEach((row, index) => csv.push([
  index + 1, row.symbol, round(row.score), indiaTime(row.firstAt), indiaTime(row.lastAt), row.volumeEvents,
  round(row.eventRate), row.executedVolume, round(row.executedVolumeRate), row.buyVolume,
  round(row.buyVolumeRate), round(row.buyShare), row.sellVolume, row.unknownVolume,
  round(row.bidDominance),
].join(",")))
await fsp.writeFile(output, `${csv.join("\n")}\n`)

export const result = {
  output, stocksScanned: symbols.length, stocksWithData: rows.length,
  method: "40% volume-change event rate + 40% inferred buy-volume speed + 20% inferred buy share",
  top: rows.slice(0, 15).map((row, index) => ({
    rank: index + 1, symbol: row.symbol, score: round(row.score), events: row.volumeEvents,
    eventsPerMinute: round(row.eventRate), executedVolume: row.executedVolume,
    executedSharesPerMinute: round(row.executedVolumeRate), inferredBuyVolume: row.buyVolume,
    buySharesPerMinute: round(row.buyVolumeRate), buyShare: round(row.buyShare),
    bidDominance: round(row.bidDominance), observedFrom: indiaTime(row.firstAt), observedTo: indiaTime(row.lastAt),
  })),
}

if (typeof nodeRepl === "undefined") console.log(JSON.stringify(result, null, 2))
