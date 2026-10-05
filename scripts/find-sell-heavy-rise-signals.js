import fs from "node:fs"
import path from "node:path"
import readline from "node:readline"
import { readFile, readdir } from "node:fs/promises"

const root = process.cwd()
const depthRoot = path.join(root, "db", "cash-depth")
const legacyRoot = path.join(root, "db", "option-depth")
const historyRoot = path.join(root, "db", "market-history")
const minutes = Number(process.argv[2] ?? 20)
if (!Number.isInteger(minutes) || minutes < 5 || minutes > 240) throw new Error("Usage: node scripts/find-sell-heavy-rise-signals.js [window-minutes]")

const dateDirs = (await readdir(depthRoot, { withFileTypes: true })).filter((entry) => entry.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(entry.name)).map((entry) => entry.name).sort()
const date = dateDirs.at(-1)
if (!date) throw new Error("No dated cash-depth history found")
const dateDirectory = path.join(depthRoot, date)
const stocks = new Map()
for (const entry of await readdir(dateDirectory, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue
  const filename = path.join(dateDirectory, entry.name, `${entry.name}.jsonl`)
  if (fs.existsSync(filename)) stocks.set(entry.name, { symbol: entry.name, cashFilename: filename })
}
for (const entry of await readdir(legacyRoot, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue
  const filename = path.join(legacyRoot, entry.name, `${entry.name}.json`)
  if (!fs.existsSync(filename)) continue
  const stock = stocks.get(entry.name) ?? { symbol: entry.name }
  stock.legacyFilename = filename
  stocks.set(entry.name, stock)
}

async function* jsonLines(filename) {
  const input = fs.createReadStream(filename, { encoding: "utf8" })
  const lines = readline.createInterface({ input, crlfDelay: Infinity })
  try {
    for await (const line of lines) {
      if (!line.trim()) continue
      try { yield JSON.parse(line) } catch { /* Ignore a partial final line. */ }
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
  return { imbalance: (bid - ask) / (bid + ask), mid: (bids[0] + asks[0]) / 2 }
}

const depthByStock = new Map()
let earliestAt = Infinity, latestAt = 0
for (const stock of stocks.values()) {
  const records = []
  if (stock.legacyFilename) {
    try {
      const stored = JSON.parse(await readFile(stock.legacyFilename, "utf8"))
      for (const entry of stored.history ?? []) records.push({ receivedAt: entry.receivedAt, kind: "checkpoint", data: entry.data })
    } catch { /* Skip malformed legacy history. */ }
  }
  if (stock.cashFilename) for await (const record of jsonLines(stock.cashFilename)) records.push(record)
  records.sort((a, b) => Date.parse(a.receivedAt) - Date.parse(b.receivedAt))
  const raw = {}, samples = []
  let lastAt = 0
  for (const record of records) {
    const at = Date.parse(record.receivedAt)
    if (!Number.isFinite(at) || new Date(at + 330 * 60_000).toISOString().slice(0, 10) !== date) continue
    earliestAt = Math.min(earliestAt, at); latestAt = Math.max(latestAt, at)
    if (lastAt && at - lastAt > 90_000) for (const key of Object.keys(raw)) delete raw[key]
    lastAt = at
    if (record.kind === "checkpoint" || record.book) {
      for (const key of Object.keys(raw)) delete raw[key]
      Object.assign(raw, record.data)
    } else if (record.kind === "update") Object.assign(raw, record.data)
    else continue
    const metrics = bookMetrics(raw)
    if (metrics) samples.push({ at, ...metrics })
  }
  if (samples.length) depthByStock.set(stock.symbol, samples)
}
if (!Number.isFinite(earliestAt) || !latestAt) throw new Error(`No usable depth updates found for ${date}`)

const pricesByStock = new Map()
const marketHistoryDirectory = path.join(historyRoot, date)
let historyFiles = []
try { historyFiles = (await readdir(marketHistoryDirectory, { withFileTypes: true })).filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl")) }
catch { /* Depth mid prices remain available as a fallback. */ }
const orderedHistoryFiles = []
for (const entry of historyFiles) {
  const filename = path.join(marketHistoryDirectory, entry.name)
  for await (const record of jsonLines(filename)) {
    const at = Date.parse(record.receivedAt)
    if (Number.isFinite(at)) orderedHistoryFiles.push({ filename, firstAt: at })
    break
  }
}
orderedHistoryFiles.sort((a, b) => a.firstAt - b.firstAt)
for (const file of orderedHistoryFiles) {
  if (file.firstAt > latestAt) continue
  for await (const record of jsonLines(file.filename)) {
    if (record.kind !== "price") continue
    const at = Date.parse(record.receivedAt)
    const match = /^NSE:(.+)-EQ$/i.exec(record.data?.symbol ?? "")
    const price = Number(record.data?.ltp), volume = Number(record.data?.vol_traded_today)
    if (!match || !Number.isFinite(at) || at < earliestAt || at > latestAt || !Number.isFinite(price) || price <= 0) continue
    const symbol = match[1].toUpperCase()
    const points = pricesByStock.get(symbol) ?? []
    points.push({ at, price, volume: Number.isSafeInteger(volume) && volume >= 0 ? volume : null })
    pricesByStock.set(symbol, points)
  }
}
for (const points of pricesByStock.values()) points.sort((a, b) => a.at - b.at)

const indiaTime = (value) => new Intl.DateTimeFormat("en-IN", {
  timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
}).format(new Date(value))
const firstEnd = Math.ceil((earliestAt + minutes * 60_000) / 60_000) * 60_000
const lastEnd = Math.floor(latestAt / 60_000) * 60_000
const active = new Set(), signals = []

for (let end = firstEnd; end <= lastEnd; end += 60_000) {
  const start = end - minutes * 60_000
  for (const [symbol, depth] of depthByStock) {
    const d = depth.filter((sample) => sample.at >= start && sample.at <= end)
    const pricePoints = pricesByStock.get(symbol) ?? []
    let prices = pricePoints.filter((sample) => sample.at >= start && sample.at <= end)
    if (!prices.length) prices = d.map((sample) => ({ at: sample.at, price: sample.mid, volume: null }))
    const minuteBars = new Map()
    for (const sample of prices) {
      const minute = Math.floor(sample.at / 60_000)
      const bar = minuteBars.get(minute) ?? { at: minute * 60_000, open: sample.price, high: sample.price, low: sample.price, close: sample.price }
      bar.high = Math.max(bar.high, sample.price); bar.low = Math.min(bar.low, sample.price); bar.close = sample.price
      minuteBars.set(minute, bar)
    }
    const bars = [...minuteBars.values()].sort((a, b) => a.at - b.at)
    let matched = false, returnPct = 0
    if (bars.length >= Math.max(5, Math.ceil(minutes * 0.5)) && d.length >= Math.max(10, minutes)) {
      const firstPrice = bars[0].open, lastPrice = bars.at(-1).close
      returnPct = (lastPrice / firstPrice - 1) * 100
      const imbalances = d.map((sample) => sample.imbalance)
      const mean = (xs) => xs.reduce((sum, value) => sum + value, 0) / xs.length
      const third = Math.max(1, Math.floor(imbalances.length / 3))
      const shift = mean(imbalances.slice(-third)) - mean(imbalances.slice(0, third))
      let peak = bars[0].high, drawdown = 0, green = 0, path = 0
      for (let i = 0; i < bars.length; i++) {
        if (i) {
          path += Math.abs(bars[i].close - bars[i - 1].close)
          if (bars[i].close > bars[i - 1].close) green++
        }
        peak = Math.max(peak, bars[i].high)
        drawdown = Math.max(drawdown, (peak - bars[i].low) / peak * 100)
      }
      const averageImbalance = mean(imbalances)
      matched = returnPct >= 0.4 && returnPct <= 1.3 && averageImbalance <= -0.1 && shift >= 0.1 &&
        green >= Math.ceil((bars.length - 1) * 0.55) && drawdown <= 0.7
    }
    const key = `${symbol}`
    if (matched && !active.has(key)) signals.push({ time: indiaTime(end), symbol, returnPct: Number(returnPct.toFixed(3)), behavior: "Rise despite sell-heavy depth" })
    if (matched) active.add(key)
    else active.delete(key)
  }
}

console.log(`Sell-heavy rise signals for ${date}: ${indiaTime(earliestAt)}–${indiaTime(latestAt)} IST; ${minutes}-minute windows; signal times checked each minute.`)
if (signals.length) console.table(signals)
else console.log("No matching signals in the available depth history.")
console.log("Consecutive qualifying windows for the same stock are grouped into one signal at the first qualifying time.")
