import fs from "node:fs"
import path from "node:path"
import readline from "node:readline"
import { readFile, readdir } from "node:fs/promises"

const root = process.cwd()
const cliArgs = process.argv.slice(2)
const positional = cliArgs.filter((arg) => !arg.startsWith("--"))
if (positional.length > 2) throw new Error('Usage: npm run scan:depth [minutes] ["day/month/year, h:mm:ss am/pm"]')
const args = new Map(cliArgs.map((arg) => {
  const match = arg.match(/^--([^=]+)(?:=(.*))?$/)
  return match ? [match[1], match[2] ?? "true"] : [arg, "true"]
}))
const requestedMinutes = Number(args.get("candle-window") ?? args.get("candles") ?? args.get("minutes") ?? positional[0] ?? 20)
const top = Number(args.get("top") ?? 5)
const requestedDate = args.get("date")
const requestedCutoff = args.get("cutoff") ?? positional[1]
const behaviorFilter = args.get("behavior") ?? "rebound"
const directory = path.resolve(root, args.get("directory") ?? "db/cash-depth")
const legacyDirectory = path.resolve(root, "db/option-depth")

function parseCutoff(value) {
  if (!value) return null
  const local = value.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4}),?\s+(\d{1,2}):(\d{2}):(\d{2})\s*(am|pm)$/i)
  if (local) {
    const [, day, month, year, hourText, minuteText, secondText, meridiem] = local
    const hour12 = Number(hourText), minute = Number(minuteText), second = Number(secondText)
    if (hour12 < 1 || hour12 > 12 || minute > 59 || second > 59) throw new Error("Invalid cutoff time")
    const hour = hour12 % 12 + (meridiem.toLowerCase() === "pm" ? 12 : 0)
    const utc = Date.UTC(Number(year), Number(month) - 1, Number(day), hour, minute, second) - 330 * 60_000
    const check = new Date(utc + 330 * 60_000)
    if (check.getUTCDate() !== Number(day) || check.getUTCMonth() !== Number(month) - 1 || check.getUTCFullYear() !== Number(year)) {
      throw new Error("Invalid cutoff date")
    }
    return utc
  }
  const parsed = Date.parse(value)
  if (!Number.isFinite(parsed)) throw new Error('Invalid cutoff. Use "day/month/year, h:mm:ss am/pm" in India time, or an ISO timestamp with timezone.')
  return parsed
}
const cutoffAt = parseCutoff(requestedCutoff)
const cutoffDate = cutoffAt == null ? null : new Date(cutoffAt + 330 * 60_000).toISOString().slice(0, 10)
function formatIndia(value) {
  return new Intl.DateTimeFormat("en-IN", {
    timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  }).format(new Date(value))
}

if (!Number.isInteger(requestedMinutes) || requestedMinutes < 5 || requestedMinutes > 240) {
  throw new Error("Candle window must be an integer from 5 to 240 one-minute candles")
}
if (!Number.isInteger(top) || top < 1 || top > 100) throw new Error("--top must be an integer from 1 to 100")
if (!new Set(["all", "momentum", "smooth", "rebound"]).has(behaviorFilter)) {
  throw new Error("--behavior must be all, momentum, smooth, or rebound")
}

const dateDirs = (await readdir(directory, { withFileTypes: true }))
  .filter((entry) => entry.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(entry.name))
  .map((entry) => entry.name)
  .sort()
const date = requestedDate && requestedDate !== "latest" ? requestedDate : cutoffDate ?? dateDirs.at(-1)
if (!date || !dateDirs.includes(date)) throw new Error(`No cash-depth history found for date ${date ?? "(none)"}`)

const dateDirectory = path.join(directory, date)
const stockFiles = new Map()
try {
  for (const entry of await readdir(dateDirectory, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^[A-Z0-9&._-]+$/i.test(entry.name)) continue
    const filename = path.join(dateDirectory, entry.name, `${entry.name}.jsonl`)
    if (fs.existsSync(filename)) stockFiles.set(entry.name, { symbol: entry.name, cashFilename: filename })
  }
} catch { /* Older sessions may only have option-depth history. */ }
try {
  for (const entry of await readdir(legacyDirectory, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^[A-Z0-9&._-]+$/i.test(entry.name)) continue
    const filename = path.join(legacyDirectory, entry.name, `${entry.name}.json`)
    if (!fs.existsSync(filename)) continue
    const stock = stockFiles.get(entry.name) ?? { symbol: entry.name }
    stock.legacyFilename = filename
    stockFiles.set(entry.name, stock)
  }
} catch { /* The dedicated cash-depth recorder may be the only available source. */ }
const stocks = [...stockFiles.values()]
if (!stocks.length) throw new Error(`No per-stock depth history found for ${date}`)

async function* readRecords(filename) {
  const input = fs.createReadStream(filename, { encoding: "utf8" })
  const lines = readline.createInterface({ input, crlfDelay: Infinity })
  try {
    for await (const line of lines) {
      if (!line.trim()) continue
      try { yield JSON.parse(line) }
      catch { /* Ignore a truncated final line after an unclean shutdown. */ }
    }
  } finally {
    lines.close()
    input.destroy()
  }
}

async function* readStockRecords(stock) {
  if (stock.legacyFilename) {
    const stored = JSON.parse(await readFile(stock.legacyFilename, "utf8"))
    for (const entry of stored.history ?? []) {
      const entryAt = Date.parse(entry.receivedAt)
      if (!Number.isFinite(entryAt) || new Date(entryAt + 330 * 60_000).toISOString().slice(0, 10) !== date) continue
      yield { receivedAt: entry.receivedAt, kind: "checkpoint", data: entry.data }
    }
  }
  if (stock.cashFilename) yield* readRecords(stock.cashFilename)
}

let earliestObservedAt = Infinity
let latestAvailableAt = 0
let latestBeforeCutoffAt = 0
let earliestCashObservedAt = Infinity
for (const stock of stocks) {
  for await (const record of readStockRecords(stock)) {
    const at = Date.parse(record.receivedAt)
    if (Number.isFinite(at) && at < earliestObservedAt) earliestObservedAt = at
    if (Number.isFinite(at) && at > latestAvailableAt) latestAvailableAt = at
    if (Number.isFinite(at) && at <= (cutoffAt ?? Infinity) && at > latestBeforeCutoffAt) latestBeforeCutoffAt = at
    if (stock.cashFilename && Number.isFinite(at) && at < earliestCashObservedAt) earliestCashObservedAt = at
  }
}
if (!latestAvailableAt) throw new Error("No valid depth timestamps found in the selected date")
let latestAt = latestBeforeCutoffAt || latestAvailableAt
let cutoffFallback = false
if (cutoffAt && !latestBeforeCutoffAt && cutoffAt < earliestObservedAt) {
  latestAt = latestAvailableAt
  cutoffFallback = true
}
const availableMinutes = Math.floor((latestAt - earliestObservedAt) / 60_000)
const effectiveMinutes = Math.min(requestedMinutes, availableMinutes)
if (effectiveMinutes < 5) {
  throw new Error(`Only ${Math.max(0, availableMinutes)} minutes of history are available for this cutoff; at least 5 minutes are needed to scan.`)
}
const windowStart = latestAt - effectiveMinutes * 60_000

async function loadMarketPrices() {
  const bySymbol = new Map()
  if (windowStart >= earliestCashObservedAt) return bySymbol
  const historyDirectory = path.resolve(root, "db/market-history", date)
  let entries
  try {
    entries = (await readdir(historyDirectory, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
  } catch { return bySymbol }
  const files = []
  for (const entry of entries) {
    const filename = path.join(historyDirectory, entry.name)
    for await (const record of readRecords(filename)) {
      const at = Date.parse(record.receivedAt)
      if (Number.isFinite(at)) files.push({ filename, firstAt: at })
      break
    }
  }
  files.sort((a, b) => a.firstAt - b.firstAt)
  const selected = files.filter((file, index) => file.firstAt <= latestAt && (files[index + 1]?.firstAt ?? Infinity) > windowStart)
  for (const file of selected) {
    for await (const record of readRecords(file.filename)) {
      const at = Date.parse(record.receivedAt)
      if (at < windowStart || at > latestAt || record.kind !== "price") continue
      const match = /^NSE:(.+)-EQ$/i.exec(record.data?.symbol ?? "")
      const price = Number(record.data?.ltp)
      const rawVolume = Number(record.data?.vol_traded_today)
      if (!match || !Number.isFinite(price) || price <= 0) continue
      const symbol = match[1].toUpperCase()
      const samples = bySymbol.get(symbol) ?? []
      samples.push({ at, price, volume: Number.isSafeInteger(rawVolume) && rawVolume >= 0 ? rawVolume : null })
      bySymbol.set(symbol, samples)
    }
  }
  for (const samples of bySymbol.values()) samples.sort((a, b) => a.at - b.at)
  return bySymbol
}
const marketPrices = await loadMarketPrices()

const levels = (data, side) => Array.from({ length: 5 }, (_, i) => {
  const n = i + 1
  return {
    price: Number(data[`${side}_price${n}`]),
    size: Number(data[`${side}_size${n}`]),
  }
})
function validBook(data) {
  const bids = levels(data, "bid"), asks = levels(data, "ask")
  if ([...bids, ...asks].some((level) => !Number.isFinite(level.price) || level.price <= 0 || !Number.isFinite(level.size) || level.size < 0)) return null
  if (bids[0].price >= asks[0].price || !bids[0].size || !asks[0].size) return null
  for (let i = 1; i < 5; i++) if (bids[i].price > bids[i - 1].price || asks[i].price < asks[i - 1].price) return null
  const buy = bids.reduce((sum, level) => sum + level.size, 0)
  const sell = asks.reduce((sum, level) => sum + level.size, 0)
  const mid = (bids[0].price + asks[0].price) / 2
  return { imbalance: (buy - sell) / (buy + sell), spreadPct: (asks[0].price - bids[0].price) / mid * 100, mid }
}

async function scanStock(stock) {
  const raw = {}
  const depth = []
  const pricesByMinute = new Map()
  const volumesBySecond = new Map()
  let lastRecordAt = 0

  function addPrice(priceAt, price, volume) {
    if (!Number.isFinite(price) || price <= 0 || priceAt < windowStart || priceAt > latestAt) return
    const minute = Math.floor(priceAt / 60_000)
    const bar = pricesByMinute.get(minute) ?? { at: minute * 60_000, open: price, high: price, low: price, close: price, volume: null }
    bar.high = Math.max(bar.high, price)
    bar.low = Math.min(bar.low, price)
    bar.close = price
    if (Number.isSafeInteger(volume) && volume >= 0) bar.volume = Math.max(bar.volume ?? volume, volume)
    pricesByMinute.set(minute, bar)
    if (Number.isSafeInteger(volume) && volume >= 0) volumesBySecond.set(Math.floor(priceAt / 1000), volume)
  }

  for await (const record of readStockRecords(stock)) {
    const at = Date.parse(record.receivedAt)
    if (!Number.isFinite(at) || at > latestAt || at < latestAt - 24 * 60 * 60_000) continue
    if (lastRecordAt && at - lastRecordAt > 90_000) {
      for (const key of Object.keys(raw)) delete raw[key]
    }
    lastRecordAt = at
    if (record.kind === "checkpoint" || record.book) {
      for (const key of Object.keys(raw)) delete raw[key]
      Object.assign(raw, record.data)
    } else if (record.kind === "update") {
      Object.assign(raw, record.data)
    } else continue

    if (at < windowStart) continue
    const book = validBook(raw)
    if (book) depth.push({ at, ...book })

    const context = record.marketContext
    const price = Number(context?.price ?? book?.mid)
    const volume = Number(context?.cumulativeVolume ?? raw.vol_traded_today)
    addPrice(Date.parse(context?.priceAt) || at, price, volume)
  }

  const historyPrices = marketPrices.get(stock.symbol)
  if (historyPrices?.length) {
    pricesByMinute.clear()
    volumesBySecond.clear()
    for (const sample of historyPrices) addPrice(sample.at, sample.price, sample.volume)
  }

  const bars = [...pricesByMinute.values()].sort((a, b) => a.at - b.at)
  const samples = depth.sort((a, b) => a.at - b.at)
  if (bars.length < Math.max(5, Math.ceil(effectiveMinutes * 0.5)) || samples.length < Math.max(10, effectiveMinutes)) return null

  const firstPrice = bars[0].open
  const lastPrice = bars.at(-1).close
  const returnPct = (lastPrice / firstPrice - 1) * 100
  let path = 0, peak = bars[0].high, maxDrawdownPct = 0, greenMinutes = 0
  for (let i = 0; i < bars.length; i++) {
    if (i) {
      path += Math.abs(bars[i].close - bars[i - 1].close)
      if (bars[i].close > bars[i - 1].close) greenMinutes++
    }
    peak = Math.max(peak, bars[i].high)
    maxDrawdownPct = Math.max(maxDrawdownPct, (peak - bars[i].low) / peak * 100)
  }
  const efficiency = path ? Math.abs(lastPrice - firstPrice) / path : 0
  const imbalances = samples.map((sample) => sample.imbalance)
  const meanImbalance = imbalances.reduce((sum, value) => sum + value, 0) / imbalances.length
  const third = Math.max(1, Math.floor(imbalances.length / 3))
  const mean = (items) => items.reduce((sum, value) => sum + value, 0) / items.length
  const imbalanceShift = mean(imbalances.slice(-third)) - mean(imbalances.slice(0, third))
  const volumeValues = [...volumesBySecond.entries()].sort((a, b) => a[0] - b[0]).map(([, value]) => value)
  const volumeAdded = volumeValues.length > 1 ? Math.max(0, volumeValues.at(-1) - volumeValues[0]) : 0
  let volumeUpSeconds = 0
  for (let i = 1; i < volumeValues.length; i++) if (volumeValues[i] > volumeValues[i - 1]) volumeUpSeconds++
  const result = {
    symbol: stock.symbol,
    returnPct,
    volumeAdded,
    volumeUpSeconds,
    greenMinutes,
    observedMinutes: bars.length,
    depthSamples: samples.length,
    efficiency,
    meanImbalance,
    imbalanceShift,
    maxDrawdownPct,
    meanSpreadPct: mean(samples.map((sample) => sample.spreadPct)),
  }
  result.matches = {
    momentum: returnPct >= 1.5 && volumeAdded >= 250_000 && meanImbalance < 0.1 && imbalanceShift < 0,
    smooth: returnPct > 0.5 && efficiency >= 0.09 && imbalanceShift > 0 && maxDrawdownPct <= 0.7,
    rebound: returnPct >= 0.4 && returnPct <= 1.3 && meanImbalance <= -0.1 && imbalanceShift >= 0.1 &&
      greenMinutes >= Math.ceil((bars.length - 1) * 0.55) && maxDrawdownPct <= 0.7,
  }
  return result
}

const scanned = []
for (const stock of stocks) {
  const result = await scanStock(stock)
  if (result) scanned.push(result)
}
const sorters = {
  momentum: (a, b) => b.returnPct - a.returnPct || b.volumeAdded - a.volumeAdded,
  smooth: (a, b) => b.returnPct - a.returnPct || b.efficiency - a.efficiency || b.imbalanceShift - a.imbalanceShift,
  rebound: (a, b) => b.imbalanceShift - a.imbalanceShift || b.returnPct - a.returnPct || a.maxDrawdownPct - b.maxDrawdownPct,
}
console.log(`Rise despite sell-heavy depth | ${date} | ${formatIndia(windowStart)} to ${formatIndia(latestAt)} IST | ${effectiveMinutes} one-minute candles available (requested ${requestedMinutes})`)
if (cutoffFallback) console.log(`No saved depth existed by the requested cutoff ${formatIndia(cutoffAt)} IST; scanning the latest available data instead.`)
console.log(`Stocks with sufficient observations: ${scanned.length}/${stocks.length}; missing minutes are skipped.`)
for (const [key, title] of Object.entries({
  momentum: "Momentum with high volume and no sustained bid dominance",
  smooth: "Smooth rise with improving depth",
  rebound: "Rise despite sell-heavy depth improving",
})) {
  if (behaviorFilter !== "all" && behaviorFilter !== key) continue
  const matches = scanned.filter((row) => row.matches[key]).sort(sorters[key]).slice(0, top).map((row) => ({
    symbol: row.symbol,
    returnPct: Number(row.returnPct.toFixed(3)),
    "Behaviour matched": title,
  }))
  console.log(`\n${title} (top ${top}; ${matches.length} matched)`)
  if (matches.length) console.table(matches)
  else console.log("No stocks matched this screen in the selected window.")
}
console.log("Volume-up seconds count snapshots with higher cumulative volume; it is not a trade count. These are research candidates, not trading instructions.")
