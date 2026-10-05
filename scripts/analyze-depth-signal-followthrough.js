import fs from "node:fs"
import path from "node:path"
import readline from "node:readline"
import { readdir } from "node:fs/promises"

const root = process.cwd()
const cashRoot = path.join(root, "db", "cash-depth")
const windowMinutes = Number(process.argv[2] ?? 20)
if (!Number.isInteger(windowMinutes) || windowMinutes < 5 || windowMinutes > 240) {
  throw new Error("Usage: node scripts/analyze-depth-signal-followthrough.js [one-minute-candles]")
}
const date = (await readdir(cashRoot, { withFileTypes: true }))
  .filter((entry) => entry.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(entry.name))
  .map((entry) => entry.name)
  .sort()
  .at(-1)
if (!date) throw new Error("No cash-depth date folder found")
const dateDirectory = path.join(cashRoot, date)
const stockFiles = []
for (const entry of await readdir(dateDirectory, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue
  const filename = path.join(dateDirectory, entry.name, `${entry.name}.jsonl`)
  if (fs.existsSync(filename)) stockFiles.push({ symbol: entry.name, filename })
}

async function* records(filename) {
  const input = fs.createReadStream(filename, { encoding: "utf8" })
  const lines = readline.createInterface({ input, crlfDelay: Infinity })
  try {
    for await (const line of lines) {
      if (!line.trim()) continue
      try { yield JSON.parse(line) } catch { /* Ignore a partial final row. */ }
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
  return { imbalance: (bid - ask) / (bid + ask) }
}

const histories = []
let earliestAt = Infinity, latestAt = 0
for (const file of stockFiles) {
  const raw = {}, depth = [], pricesBySecond = new Map()
  let lastAt = 0
  for await (const record of records(file.filename)) {
    const at = Date.parse(record.receivedAt)
    if (!Number.isFinite(at) || new Date(at + 330 * 60_000).toISOString().slice(0, 10) !== date) continue
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
    const price = Number(record.marketContext?.price)
    const priceAt = Date.parse(record.marketContext?.priceAt) || at
    if (Number.isFinite(price) && price > 0 && priceAt <= at + 1_000) {
      pricesBySecond.set(Math.floor(priceAt / 1000), { at: priceAt, price })
    }
  }
  const prices = [...pricesBySecond.values()].sort((a, b) => a.at - b.at)
  if (depth.length && prices.length) histories.push({ symbol: file.symbol, depth, prices })
}
if (!Number.isFinite(earliestAt) || !latestAt) throw new Error(`No valid cash-depth records found for ${date}`)

const mean = (values) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0
const indiaTime = (at) => new Intl.DateTimeFormat("en-IN", {
  timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
}).format(new Date(at))
const signalRows = []

for (const stock of histories) {
  const barsByMinute = new Map()
  for (const point of stock.prices) {
    const minute = Math.floor(point.at / 60_000)
    const bar = barsByMinute.get(minute) ?? { at: minute * 60_000, open: point.price, high: point.price, low: point.price, close: point.price }
    bar.high = Math.max(bar.high, point.price)
    bar.low = Math.min(bar.low, point.price)
    bar.close = point.price
    barsByMinute.set(minute, bar)
  }
  const bars = [...barsByMinute.values()].sort((a, b) => a.at - b.at)
  const firstEnd = Math.ceil((Math.max(earliestAt, stock.depth[0].at) + windowMinutes * 60_000) / 60_000) * 60_000
  const lastEnd = Math.floor(Math.min(latestAt, stock.depth.at(-1).at, stock.prices.at(-1).at) / 60_000) * 60_000
  let depthLeft = 0, depthRight = 0, barLeft = 0, barRight = 0, priceCursor = 0, previouslyMatched = false

  for (let end = firstEnd; end <= lastEnd; end += 60_000) {
    const start = end - windowMinutes * 60_000
    while (depthLeft < stock.depth.length && stock.depth[depthLeft].at < start) depthLeft++
    if (depthRight < depthLeft) depthRight = depthLeft
    while (depthRight < stock.depth.length && stock.depth[depthRight].at <= end) depthRight++
    while (barLeft < bars.length && bars[barLeft].at < Math.floor(start / 60_000) * 60_000) barLeft++
    if (barRight < barLeft) barRight = barLeft
    while (barRight < bars.length && bars[barRight].at < end) barRight++
    while (priceCursor < stock.prices.length && stock.prices[priceCursor].at <= end) priceCursor++

    const depthCount = depthRight - depthLeft, barCount = barRight - barLeft
    if (depthCount < Math.max(10, windowMinutes) || barCount < Math.max(5, Math.ceil(windowMinutes * 0.5))) {
      previouslyMatched = false
      continue
    }
    const depthWindow = stock.depth.slice(depthLeft, depthRight)
    const imbalance = depthWindow.map((sample) => sample.imbalance)
    const third = Math.max(1, Math.floor(imbalance.length / 3))
    const shift = mean(imbalance.slice(-third)) - mean(imbalance.slice(0, third))
    const selectedBars = bars.slice(barLeft, barRight)
    const firstPrice = selectedBars[0].open, lastPrice = selectedBars.at(-1).close
    const returnPct = (lastPrice / firstPrice - 1) * 100
    let peak = selectedBars[0].high, maxDrawdownPct = 0, green = 0
    for (let i = 0; i < selectedBars.length; i++) {
      if (i && selectedBars[i].close > selectedBars[i - 1].close) green++
      peak = Math.max(peak, selectedBars[i].high)
      maxDrawdownPct = Math.max(maxDrawdownPct, (peak - selectedBars[i].low) / peak * 100)
    }
    const matched = returnPct >= 0.4 && returnPct <= 1.3 && mean(imbalance) <= -0.1 && shift >= 0.1 &&
      green >= Math.ceil((selectedBars.length - 1) * 0.55) && maxDrawdownPct <= 0.7
    if (matched && !previouslyMatched) {
      const signalPrice = priceCursor ? stock.prices[priceCursor - 1].price : null
      if (signalPrice) {
        let crossing = null, maxFuturePrice = signalPrice
        for (let i = priceCursor; i < stock.prices.length; i++) {
          const point = stock.prices[i]
          maxFuturePrice = Math.max(maxFuturePrice, point.price)
          if (!crossing && point.price >= signalPrice * 1.03) crossing = point
        }
        if (crossing) signalRows.push({
          signalTime: indiaTime(end),
          symbol: stock.symbol,
          signalWindowReturnPct: Number(returnPct.toFixed(3)),
          depthImbalance: Number(mean(imbalance).toFixed(3)),
          imbalanceShift: Number(shift.toFixed(3)),
          priceAtSignal: Number(signalPrice.toFixed(2)),
          crossedPlus3At: indiaTime(crossing.at),
          minutesToPlus3: Number(((crossing.at - end) / 60_000).toFixed(1)),
          maxGainAfterSignalPct: Number(((maxFuturePrice / signalPrice - 1) * 100).toFixed(2)),
        })
      }
    }
    previouslyMatched = matched
  }
}

signalRows.sort((a, b) => a.signalTime.localeCompare(b.signalTime) || a.symbol.localeCompare(b.symbol))
console.log(`Cash-depth behavior follow-through for ${date}: ${indiaTime(earliestAt)}–${indiaTime(latestAt)} IST; ${windowMinutes}-candle sell-heavy-rise signal; outcome is a later +3% from signal price.`)
if (signalRows.length) console.table(signalRows)
else console.log("No qualifying behavior signal was followed by a +3% move in the remaining captured cash-depth history.")
console.log("This is a historical screen, not evidence that the signal causes future moves or predicts future returns.")
