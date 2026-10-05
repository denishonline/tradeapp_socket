import fs from "node:fs"
import path from "node:path"
import readline from "node:readline"
import { readdir } from "node:fs/promises"

const root = process.cwd()
const depthRoot = path.join(root, "db", "cash-depth")
const windowMinutes = Number(process.argv[2] ?? 20)
if (!Number.isInteger(windowMinutes) || windowMinutes < 5 || windowMinutes > 240) {
  throw new Error("Usage: node scripts/analyze-cash-depth-moves.js [lookback-minutes]")
}
const date = (await readdir(depthRoot, { withFileTypes: true }))
  .filter((entry) => entry.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(entry.name))
  .map((entry) => entry.name)
  .sort()
  .at(-1)
if (!date) throw new Error("No cash-depth date folder found")
const dateDirectory = path.join(depthRoot, date)
const files = []
for (const entry of await readdir(dateDirectory, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue
  const filename = path.join(dateDirectory, entry.name, `${entry.name}.jsonl`)
  if (fs.existsSync(filename)) files.push({ symbol: entry.name, filename })
}

async function* records(filename) {
  const input = fs.createReadStream(filename, { encoding: "utf8" })
  const lines = readline.createInterface({ input, crlfDelay: Infinity })
  try {
    for await (const line of lines) {
      if (!line.trim()) continue
      try { yield JSON.parse(line) } catch { /* Ignore an incomplete final row. */ }
    }
  } finally { lines.close(); input.destroy() }
}

function bookMetrics(data) {
  let bid = 0, ask = 0
  const bids = [], asks = []
  for (let level = 1; level <= 5; level++) {
    const bp = Number(data[`bid_price${level}`]), bq = Number(data[`bid_size${level}`])
    const ap = Number(data[`ask_price${level}`]), aq = Number(data[`ask_size${level}`])
    if (![bp, bq, ap, aq].every(Number.isFinite) || bp <= 0 || ap <= 0 || bq < 0 || aq < 0) return null
    bids.push(bp); asks.push(ap); bid += bq; ask += aq
    if (level > 1 && (bp > bids[level - 2] || ap < asks[level - 2])) return null
  }
  if (bids[0] >= asks[0] || bid + ask === 0) return null
  const mid = (bids[0] + asks[0]) / 2
  return { imbalance: (bid - ask) / (bid + ask), mid }
}

const stocks = []
let earliestAt = Infinity, latestAt = 0
for (const file of files) {
  const raw = {}, depth = [], prices = new Map(), volumes = new Map()
  let lastAt = 0
  for await (const record of records(file.filename)) {
    const at = Date.parse(record.receivedAt)
    if (!Number.isFinite(at)) continue
    const localDate = new Date(at + 330 * 60_000).toISOString().slice(0, 10)
    if (localDate !== date) continue
    earliestAt = Math.min(earliestAt, at)
    latestAt = Math.max(latestAt, at)
    if (lastAt && at - lastAt > 90_000) for (const key of Object.keys(raw)) delete raw[key]
    lastAt = at
    if (record.kind === "checkpoint" || record.book) {
      for (const key of Object.keys(raw)) delete raw[key]
      Object.assign(raw, record.data)
    } else if (record.kind === "update") Object.assign(raw, record.data)
    else continue
    const book = bookMetrics(raw)
    if (book) depth.push({ at, ...book })

    const context = record.marketContext
    const price = Number(context?.price)
    const priceAt = Date.parse(context?.priceAt) || at
    const volume = Number(context?.cumulativeVolume)
    if (Number.isFinite(price) && price > 0 && priceAt <= at + 1_000) {
      const second = Math.floor(priceAt / 1000)
      prices.set(second, { at: priceAt, price })
      if (Number.isSafeInteger(volume) && volume >= 0) volumes.set(second, volume)
    }
  }
  if (depth.length && prices.size) stocks.push({ symbol: file.symbol, depth, prices: [...prices.values()].sort((a, b) => a.at - b.at), volumes })
}

function indiaTime(at) {
  return new Intl.DateTimeFormat("en-IN", {
    timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  }).format(new Date(at))
}
const results = []
for (const stock of stocks) {
  const base = stock.prices[0].price
  let upCrossing = null, downCrossing = null
  for (const point of stock.prices) {
    const changePct = (point.price / base - 1) * 100
    if (!upCrossing && changePct >= 3) upCrossing = { ...point, changePct }
    if (!downCrossing && changePct <= -3) downCrossing = { ...point, changePct }
  }
  for (const [direction, crossing] of [["up", upCrossing], ["down", downCrossing]]) {
    if (!crossing) continue
    const start = crossing.at - windowMinutes * 60_000
    const depth = stock.depth.filter((sample) => sample.at >= start && sample.at <= crossing.at)
    const prices = stock.prices.filter((point) => point.at >= start && point.at <= crossing.at)
    if (!depth.length || !prices.length) continue
    const imbalances = depth.map((sample) => sample.imbalance)
    const average = (items) => items.length ? items.reduce((sum, value) => sum + value, 0) / items.length : 0
    const third = Math.max(1, Math.floor(imbalances.length / 3))
    const first = prices[0].price, last = prices.at(-1).price
    let green = 0, peak = prices[0].price, maxDrawdown = 0
    for (let i = 1; i < prices.length; i++) {
      if (prices[i].price > prices[i - 1].price) green++
      peak = Math.max(peak, prices[i].price)
      maxDrawdown = Math.max(maxDrawdown, (peak - prices[i].price) / peak * 100)
    }
    const volumeSamples = [...stock.volumes.entries()].filter(([second]) => second * 1000 >= start && second * 1000 <= crossing.at).sort((a, b) => a[0] - b[0])
    const volumeAdded = volumeSamples.length > 1 ? Math.max(0, volumeSamples.at(-1)[1] - volumeSamples[0][1]) : null
    results.push({
      symbol: stock.symbol,
      direction,
      crossingAt: indiaTime(crossing.at),
      moveFromCaptureStartPct: Number(crossing.changePct.toFixed(2)),
      priorWindowReturnPct: Number(((last / first - 1) * 100).toFixed(2)),
      meanDepthImbalance: Number(average(imbalances).toFixed(3)),
      depthImbalanceShift: Number((average(imbalances.slice(-third)) - average(imbalances.slice(0, third))).toFixed(3)),
      priorWindowGreenTicks: green,
      priorWindowMaxDrawdownPct: Number(maxDrawdown.toFixed(2)),
      volumeAddedShares: volumeAdded,
      depthSamples: depth.length,
      priorDepthWindowStart: indiaTime(start),
    })
  }
}
results.sort((a, b) => a.crossingAt.localeCompare(b.crossingAt) || a.symbol.localeCompare(b.symbol))
console.log(`Cash-depth move analysis for ${date}: ${indiaTime(earliestAt)}–${indiaTime(latestAt)} IST. Move threshold is ±3% from each stock's first captured cash-depth price; depth metrics use the ${windowMinutes} minutes before its first crossing.`)
if (results.length) console.table(results)
else console.log("No stock crossed +3% or -3% from its first captured cash-depth price in the available data.")
console.log("This is descriptive history. Visible depth changes cannot identify executions versus cancellations and do not establish causation.")
