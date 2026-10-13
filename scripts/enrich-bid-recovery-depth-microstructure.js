import fs from "node:fs"
import path from "node:path"
import readline from "node:readline"

const root = path.resolve(import.meta.dirname, "..")
const input = path.join(root, "csv", "2026-10-05-to-09-bid-supported-dip-recovery-eligible-signals-1p5-target-outcomes.csv")
const output = path.join(root, "csv", "2026-10-05-to-09-bid-supported-dip-recovery-depth-microstructure-outcomes.csv")
const minute = 60_000
const round = (value, digits = 3) => Number.isFinite(value) ? Number(value.toFixed(digits)) : ""

function csvRows(file) {
  const lines = fs.readFileSync(file, "utf8").trim().split(/\r?\n/)
  const parse = (line) => {
    const fields = []
    let value = "", quoted = false
    for (let i = 0; i < line.length; i++) {
      const char = line[i]
      if (char === '"' && line[i + 1] === '"' && quoted) { value += '"'; i++ }
      else if (char === '"') quoted = !quoted
      else if (char === "," && !quoted) { fields.push(value); value = "" }
      else value += char
    }
    fields.push(value)
    return fields
  }
  const columns = parse(lines[0])
  return lines.slice(1).map((line) => Object.fromEntries(parse(line).map((value, index) => [columns[index], value])))
}

const mean = (items, field) => items.length ? items.reduce((sum, item) => sum + item[field], 0) / items.length : NaN
const pct = (value, base) => base > 0 ? (value / base - 1) * 100 : NaN

async function readBookTicks(day, symbol) {
  const file = path.join(root, "db", "cash-depth", day, symbol, `${symbol}.jsonl`)
  if (!fs.existsSync(file)) return []
  const fields = {}
  const ticks = []
  const lines = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity })
  for await (const line of lines) {
    let row
    try { row = JSON.parse(line) } catch { continue }
    const at = Date.parse(row.receivedAt)
    if (!Number.isFinite(at)) continue
    const data = row.data || {}
    for (let level = 1; level <= 5; level++) {
      for (const side of ["bid", "ask"]) for (const field of ["price", "size", "order"]) {
        const key = `${side}_${field}${level}`
        if (Number.isFinite(Number(data[key]))) fields[key] = Number(data[key])
      }
    }
    let bids = 0, asks = 0, topBids = 0, topAsks = 0, bidOrders = 0, askOrders = 0, valid = true
    for (let level = 1; level <= 5; level++) {
      const bp = fields[`bid_price${level}`], ap = fields[`ask_price${level}`]
      const bs = fields[`bid_size${level}`], as = fields[`ask_size${level}`]
      const bo = fields[`bid_order${level}`], ao = fields[`ask_order${level}`]
      if (![bp, ap, bs, as].every(Number.isFinite) || bp <= 0 || ap <= bp || bs < 0 || as < 0) { valid = false; break }
      bids += bs; asks += as
      if (level <= 2) { topBids += bs; topAsks += as }
      if (Number.isFinite(bo) && Number.isFinite(ao) && bo >= 0 && ao >= 0) { bidOrders += bo; askOrders += ao }
    }
    if (!valid || bids + asks <= 0 || topBids + topAsks <= 0) continue
    const bestBid = fields.bid_price1, bestAsk = fields.ask_price1
    const mid = (bestBid + bestAsk) / 2
    const marketPrice = Number(row.marketContext?.price)
    const cumulativeVolume = Number(row.marketContext?.cumulativeVolume)
    ticks.push({ at, bidShare: 100 * bids / (bids + asks), top2BidShare: 100 * topBids / (topBids + topAsks),
      bidOrderShare: bidOrders + askOrders > 0 ? 100 * bidOrders / (bidOrders + askOrders) : NaN,
      spreadBps: mid > 0 ? 10_000 * (bestAsk - bestBid) / mid : NaN,
      marketPrice: Number.isFinite(marketPrice) && marketPrice > 0 ? marketPrice : mid,
      cumulativeVolume: Number.isFinite(cumulativeVolume) ? cumulativeVolume : NaN })
  }
  return ticks
}

function summarize(ticks, signalAt) {
  const end = signalAt - minute
  const selected = ticks.filter((tick) => tick.at >= end - 14 * minute && tick.at < end + minute)
  const late3 = selected.filter((tick) => tick.at >= end - 2 * minute)
  const first5 = selected.filter((tick) => tick.at < end - 9 * minute)
  const last5 = selected.filter((tick) => tick.at >= end - 4 * minute)
  const finiteOrders = selected.filter((tick) => Number.isFinite(tick.bidOrderShare))
  const firstPrice = selected.find((tick) => Number.isFinite(tick.marketPrice))?.marketPrice
  const lastPrice = [...selected].reverse().find((tick) => Number.isFinite(tick.marketPrice))?.marketPrice
  const firstVolume = selected.find((tick) => Number.isFinite(tick.cumulativeVolume))?.cumulativeVolume
  const lastVolume = [...selected].reverse().find((tick) => Number.isFinite(tick.cumulativeVolume))?.cumulativeVolume
  return {
    depthTickCount15: selected.length,
    bidShareTicks15: round(mean(selected, "bidShare")),
    bidDominantTicks15: round(selected.length ? 100 * selected.filter((tick) => tick.bidShare > 50).length / selected.length : NaN),
    top2BidShareTicks15: round(mean(selected, "top2BidShare")),
    top2BidDominantTicks15: round(selected.length ? 100 * selected.filter((tick) => tick.top2BidShare > 50).length / selected.length : NaN),
    bidOrderShareTicks15: round(mean(finiteOrders, "bidOrderShare")),
    bidOrderDominantTicks15: round(finiteOrders.length ? 100 * finiteOrders.filter((tick) => tick.bidOrderShare > 50).length / finiteOrders.length : NaN),
    bidShareLast3: round(mean(late3, "bidShare")),
    top2BidShareLast3: round(mean(late3, "top2BidShare")),
    bidShareChange5: round(mean(last5, "bidShare") - mean(first5, "bidShare")),
    top2BidShareChange5: round(mean(last5, "top2BidShare") - mean(first5, "top2BidShare")),
    spreadBps15: round(mean(selected, "spreadBps")),
    depthPriceReturn15: round(pct(lastPrice, firstPrice)),
    executedVolume15: Number.isFinite(firstVolume) && Number.isFinite(lastVolume) ? Math.max(0, lastVolume - firstVolume) : "",
  }
}

const rows = csvRows(input)
const groups = new Map()
for (const row of rows) {
  const key = `${row.day}|${row.symbol}`
  if (!groups.has(key)) groups.set(key, [])
  groups.get(key).push(row)
}
let done = 0
for (const [key, group] of groups) {
  const [day, symbol] = key.split("|")
  const ticks = await readBookTicks(day, symbol)
  for (const row of group) {
    const signalAt = Date.parse(`${row.day}T${row.time}:00+05:30`)
    Object.assign(row, summarize(ticks, signalAt))
  }
  done++
  if (done % 100 === 0) console.error(`processed ${done}/${groups.size} stock-days`)
}

const columns = Object.keys(rows[0])
const escape = (value) => `"${String(value ?? "").replaceAll('"', '""')}"`
fs.writeFileSync(output, [columns.join(","), ...rows.map((row) => columns.map((column) => escape(row[column])).join(","))].join("\n") + "\n")
console.log(JSON.stringify({ input, output, signals: rows.length, stockDays: groups.size }, null, 2))
