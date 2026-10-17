import fs from "node:fs"
import path from "node:path"
import readline from "node:readline"
import { createReadStream } from "node:fs"
import { createPersistentBidBreakout } from "../ui/persistent-bid-breakout.js"
import { createEarlyDepthBreakout } from "../ui/early-depth-breakout.js"
import { createBidSupportBreakout } from "../ui/bid-support-breakout.js"
import { createBidRecoveryRadar } from "../ui/bid-recovery-radar.js"
import { createOpeningBidRecoveryRadar } from "../ui/opening-bid-recovery.js"
import { createMultiFrameDepthSellRadar } from "../ui/multi-frame-depth-sell.js"
import { createMultiFrameDepthBuyRadar } from "../ui/multi-frame-depth-buy.js"
import { createFailedBidAbsorptionRadar } from "../ui/failed-bid-absorption.js"
import { createRevisedAbsorptionBreakoutRadar } from "../ui/revised-absorption-breakout.js"
import { createCandleDepthTargetRadar } from "../ui/candle-depth-target-radar.js"
import { createChronologicalPositiveRadar } from "../ui/chronological-positive-radar.js"

const ROOT = process.cwd()
const MINUTE = 60_000
const INDIA_OFFSET = 330 * MINUTE
const STRATEGY_FACTORIES = [
  ["Persistent Bid Absorption Breakout", createPersistentBidBreakout],
  ["Early Depth-Control Breakout", createEarlyDepthBreakout],
  ["Bid Support Breakout", createBidSupportBreakout],
  ["Bid-Dominant Recovery", createBidRecoveryRadar],
  ["Bid Supported Dip Recovery", createOpeningBidRecoveryRadar],
  ["Multi-Frame Depth Continuation", createMultiFrameDepthSellRadar],
  ["Multi-Frame Depth Recovery", createMultiFrameDepthBuyRadar],
  ["Failed Bid Absorption", createFailedBidAbsorptionRadar],
  ["Revised Absorption Breakout", createRevisedAbsorptionBreakoutRadar],
  ["Five-Candle Depth Target", createCandleDepthTargetRadar],
  ["Chronological Positive Filter", createChronologicalPositiveRadar],
]

function argumentValue(name, fallback = null) {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : fallback
}

function hasArgument(name) {
  return process.argv.includes(name)
}

function validDate(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false
  const [year, month, day] = date.split("-").map(Number)
  const parsed = new Date(Date.UTC(year, month - 1, day))
  return parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day
}

function validTime(time) {
  if (!/^\d{2}:\d{2}$/.test(time)) return false
  const [hour, minute] = time.split(":").map(Number)
  return hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59
}

function usage() {
  console.error("Usage: node scripts/backtest-chronological-positive-filter.js --date YYYY-MM-DD [--until HH:MM] [--strategy NAME] [--summary]")
  console.error("By default, all live Strategy Radar engines are replayed through the full cash-market session.")
}

function localEpoch(date, time) {
  const [year, month, day] = date.split("-").map(Number)
  const [hour, minute] = time.split(":").map(Number)
  return Date.UTC(year, month - 1, day, hour, minute) - INDIA_OFFSET
}

function indiaDate(epoch) {
  return new Date(epoch + INDIA_OFFSET).toISOString().slice(0, 10)
}

function indiaTime(epoch) {
  return new Date(epoch + INDIA_OFFSET).toISOString().slice(11, 19)
}

function readJsonLines(filename) {
  if (!fs.existsSync(filename)) return []
  return fs.readFileSync(filename, "utf8").split(/\r?\n/).filter(Boolean).flatMap((line) => {
    try { return [JSON.parse(line)] } catch { return [] }
  })
}

function stockName(symbol) {
  return String(symbol || "").trim().toUpperCase().replace(/^NSE:/, "").replace(/-EQ$/, "")
}

class MinHeap {
  constructor(compare) { this.values = []; this.compare = compare }
  get size() { return this.values.length }
  push(value) {
    const rows = this.values
    rows.push(value)
    let index = rows.length - 1
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2)
      if (this.compare(rows[parent], value) <= 0) break
      rows[index] = rows[parent]
      index = parent
    }
    rows[index] = value
  }
  pop() {
    const rows = this.values
    if (!rows.length) return null
    const first = rows[0]
    const last = rows.pop()
    if (!rows.length) return first
    let index = 0
    while (true) {
      const left = index * 2 + 1
      if (left >= rows.length) break
      const right = left + 1
      const child = right < rows.length && this.compare(rows[right], rows[left]) < 0 ? right : left
      if (this.compare(rows[child], last) >= 0) break
      rows[index] = rows[child]
      index = child
    }
    rows[index] = last
    return first
  }
}

class DepthEventSource {
  constructor(filename, symbol, startAt, endAt, order) {
    this.symbol = symbol
    this.startAt = startAt
    this.endAt = endAt
    this.order = order
    this.lastPriceKey = null
    this.pending = []
    const input = createReadStream(filename, { encoding: "utf8" })
    this.lines = readline.createInterface({ input, crlfDelay: Infinity })
    this.iterator = this.lines[Symbol.asyncIterator]()
  }

  async next() {
    if (this.pending.length) return this.pending.shift()
    while (true) {
      const next = await this.iterator.next()
      if (next.done) return null
      let record
      try { record = JSON.parse(next.value) } catch { continue }
      if (!record || !["checkpoint", "update"].includes(record.kind)) continue
      const receivedAt = Date.parse(record.receivedAt)
      if (!Number.isFinite(receivedAt) || receivedAt > this.endAt) return null
      if (receivedAt < this.startAt || indiaDate(receivedAt) !== indiaDate(this.startAt)) continue
      const data = record.data
      if (!data || typeof data.symbol !== "string") continue
      const events = []
      const price = Number(record.marketContext?.price)
      const priceAt = Date.parse(record.marketContext?.priceAt)
      const priceReceivedAt = Date.parse(record.marketContext?.priceReceivedAt)
      const priceKey = Number.isFinite(priceAt) ? `${priceAt}:${price}` : null
      if (price > 0 && priceKey && priceKey !== this.lastPriceKey) {
        this.lastPriceKey = priceKey
        const at = Number.isFinite(priceReceivedAt) ? priceReceivedAt : priceAt
        if (at >= this.startAt && at <= this.endAt) {
          events.push({ at, kind: "price", data: { symbol: data.symbol, ltp: price }, order: this.order })
        }
      }
      events.push({ at: receivedAt, kind: "depth", data, marketContext: record.marketContext, order: this.order })
      events.sort((left, right) => left.at - right.at || (left.kind === "price" ? -1 : 1))
      this.pending.push(...events)
      return this.pending.shift()
    }
  }
}

function signalReturn(signal, lastPrices, sessionEnd) {
  const direction = String(signal.direction || "BUY").toUpperCase()
  const entry = Number(signal.entry ?? signal.price)
  let exit = Number(signal.exitPrice)
  let exitBasis = "recorded"
  if (!(exit > 0)) {
    if (signal.status === "Target reached") { exit = Number(signal.target); exitBasis = "target" }
    else if (signal.status === "Stopped") { exit = Number(signal.stop); exitBasis = "stop" }
    else {
      exit = Number(lastPrices.get(signal.symbol))
      exitBasis = "end-of-replay mark"
    }
  }
  const returnPct = Number.isFinite(Number(signal.returnPct)) ? Number(signal.returnPct)
    : entry > 0 && exit > 0
      ? 100 * (direction === "SELL" ? entry / exit - 1 : exit / entry - 1)
      : 0
  return {
    strategy: signal.strategy,
    branch: signal.branch || signal.pattern || signal.metrics?.filterBranch || null,
    time: indiaTime(Date.parse(signal.time)),
    symbol: signal.symbol,
    direction,
    entry: Number.isFinite(entry) ? Number(entry.toFixed(2)) : null,
    exit: Number.isFinite(exit) ? Number(exit.toFixed(2)) : null,
    exitTime: indiaTime(Date.parse(signal.resolvedAt) || sessionEnd),
    exitBasis,
    status: signal.status === "Active" ? "EOD mark" : signal.status,
    returnPct: Number(returnPct.toFixed(2)),
    outcome: returnPct > 0 ? "WINNER" : returnPct < 0 ? "LOSER" : "FLAT",
  }
}

if (hasArgument("--help") || hasArgument("-h")) {
  usage()
  process.exit(0)
}

const date = argumentValue("--date")
const until = argumentValue("--until", "15:31")
const strategyFilter = argumentValue("--strategy")
if (!date || !validDate(date) || !validTime(until)) {
  usage()
  console.error("\n--date must be a valid date and --until must use HH:MM.")
  process.exit(1)
}

const depthDateDirectory = path.join(ROOT, "db", "cash-depth", date)
if (!fs.existsSync(depthDateDirectory)) {
  console.error(`No market-depth data found for ${date}: ${depthDateDirectory}`)
  process.exit(1)
}

const sessionStart = localEpoch(date, "09:15")
const sessionEnd = localEpoch(date, until)
if (sessionEnd <= sessionStart) {
  console.error("--until must be later than 09:15.")
  process.exit(1)
}

const symbols = fs.readdirSync(depthDateDirectory, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => stockName(entry.name))
  .filter(Boolean)
  .sort()
let clock = sessionStart

const candleCache = new Map()
function candlesFor(symbol) {
  if (!candleCache.has(symbol)) {
    const filename = path.join(ROOT, "db", "candles", `${symbol}.jsonl`)
    const rows = readJsonLines(filename)
      .filter((row) => Number.isFinite(Number(row.time)))
      .sort((left, right) => Number(left.time) - Number(right.time))
    candleCache.set(symbol, rows)
  }
  return candleCache.get(symbol)
}

const candleStore = {
  async read(symbol, { limit = Infinity } = {}) {
    return candlesFor(symbol)
      .filter((row) => Number(row.time) * 1000 + MINUTE <= clock)
      .slice(-limit)
  },
}

const radars = STRATEGY_FACTORIES.map(([name, factory]) => ({
  name,
  engine: factory({ now: () => clock }),
}))
await Promise.all(radars.map(({ engine }) => engine.seed?.(symbols, candleStore)))

const candleEvents = []
const closingPrices = new Map()
for (const symbol of symbols) {
  for (const candle of candlesFor(symbol)) {
    const at = Number(candle.time) * 1000
    if (indiaDate(at) !== date) continue
    const completedAt = at + MINUTE
    if (completedAt < sessionStart || completedAt > sessionEnd) continue
    candleEvents.push({ at: completedAt, symbol, candle })
    closingPrices.set(symbol, Number(candle.close))
  }
}
candleEvents.sort((left, right) => left.at - right.at || left.symbol.localeCompare(right.symbol))

const sources = symbols.flatMap((symbol, order) => {
  const filename = path.join(depthDateDirectory, symbol, `${symbol}.jsonl`)
  return fs.existsSync(filename) ? [new DepthEventSource(filename, symbol, sessionStart, sessionEnd, order)] : []
})
const eventHeap = new MinHeap((left, right) =>
  left.event.at - right.event.at || left.event.order - right.event.order ||
  (left.event.kind === "price" ? -1 : 1))
for (const source of sources) {
  const event = await source.next()
  if (event) eventHeap.push({ source, event })
}

let candleIndex = 0
let flushAt = sessionStart
let nextProgressAt = sessionStart + 30 * MINUTE
const lastPrices = new Map(closingPrices)
let processedDepth = 0
let processedPrices = 0
const replayStartedAt = Date.now()
console.error(`Replaying ${date} through ${STRATEGY_FACTORIES.length} live radar strategies (${symbols.length} stocks)...`)

function deliverCandle(event) {
  clock = event.at
  for (const { engine } of radars) engine.observeCandle?.(event.symbol, event.candle)
  const close = Number(event.candle.close)
  if (close > 0) lastPrices.set(event.symbol, close)
}

function deliverFlush(at) {
  clock = at
  for (const { engine } of radars) engine.flushCompleted?.(at)
}

function advanceScheduled(before, inclusive = false) {
  while (true) {
    const candleAt = candleEvents[candleIndex]?.at ?? Infinity
    const nextAt = Math.min(candleAt, flushAt)
    if (inclusive ? nextAt > before : nextAt >= before) break
    if (candleAt <= flushAt) {
      const at = candleAt
      while (candleEvents[candleIndex]?.at === at) deliverCandle(candleEvents[candleIndex++])
    } else {
      deliverFlush(flushAt)
      flushAt += 1000
    }
  }
}

while (eventHeap.size) {
  const item = eventHeap.pop()
  const { event, source } = item
  if (event.at > sessionEnd) break
  advanceScheduled(event.at)
  clock = event.at
  if (event.kind === "price") {
    processedPrices++
    const symbol = stockName(event.data.symbol)
    const price = Number(event.data.ltp)
    if (symbol && price > 0) lastPrices.set(symbol, price)
    for (const { engine } of radars) engine.observePrice?.(event.data, event.at)
  } else {
    processedDepth++
    for (const { engine } of radars) engine.observeDepth?.(event.data, event.at, event.marketContext)
  }
  if (event.at >= nextProgressAt) {
    console.error(`${indiaTime(event.at).slice(0, 5)} IST | ${processedDepth.toLocaleString("en-IN")} depth | ` +
      `${processedPrices.toLocaleString("en-IN")} price | ${((Date.now() - replayStartedAt) / 60_000).toFixed(1)} min`)
    nextProgressAt += 30 * MINUTE
  }
  const next = await source.next()
  if (next) eventHeap.push({ source, event: next })
}
advanceScheduled(sessionEnd, true)

let rawSignals = radars.flatMap(({ engine }) => engine.snapshot?.() || [])
if (strategyFilter) {
  const wanted = strategyFilter.toLowerCase()
  rawSignals = rawSignals.filter((signal) => String(signal.strategy).toLowerCase().includes(wanted))
}
const signals = rawSignals
  .map((signal) => signalReturn(signal, lastPrices, sessionEnd))
  .sort((left, right) => left.time.localeCompare(right.time) || left.strategy.localeCompare(right.strategy) ||
    left.symbol.localeCompare(right.symbol))

const byStrategy = {}
for (const name of STRATEGY_FACTORIES.map(([name]) => name)) {
  const rows = signals.filter((signal) => signal.strategy === name)
  if (strategyFilter && !name.toLowerCase().includes(strategyFilter.toLowerCase()) && !rows.length) continue
  byStrategy[name] = {
    signals: rows.length,
    winners: rows.filter((row) => row.outcome === "WINNER").length,
    losers: rows.filter((row) => row.outcome === "LOSER").length,
    flat: rows.filter((row) => row.outcome === "FLAT").length,
    winnersAbove1Pct: rows.filter((row) => row.returnPct > 1).length,
    totalReturnPct: Number(rows.reduce((sum, row) => sum + row.returnPct, 0).toFixed(2)),
  }
}

const output = {
  date,
  replayUntil: until,
  mode: "chronological replay through the same live Strategy Radar engines",
  assumptions: {
    timerFlush: "one-second chronological flush",
    candleAvailability: "one-minute candle delivered only after its minute completes",
    priceEvents: "deduplicated archived marketContext price updates",
    activeAtEnd: "marked to the final archived price",
    costsAndSlippage: "excluded",
  },
  coverage: {
    stocks: symbols.length,
    strategies: STRATEGY_FACTORIES.length,
    depthEvents: processedDepth,
    priceEvents: processedPrices,
  },
  summary: {
    signals: signals.length,
    winners: signals.filter((row) => row.outcome === "WINNER").length,
    losers: signals.filter((row) => row.outcome === "LOSER").length,
    flat: signals.filter((row) => row.outcome === "FLAT").length,
    winnersAbove1Pct: signals.filter((row) => row.returnPct > 1).length,
    totalReturnPct: Number(signals.reduce((sum, row) => sum + row.returnPct, 0).toFixed(2)),
  },
  byStrategy,
  signals,
}

const untilSuffix = until === "15:31" ? "" : `-until-${until.replace(":", "")}`
const strategySuffix = strategyFilter ? `-${strategyFilter.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}` : ""
const outputPath = path.join(ROOT, "reports", `live-radar-backtest-${date}${untilSuffix}${strategySuffix}.json`)
fs.mkdirSync(path.dirname(outputPath), { recursive: true })
fs.writeFileSync(outputPath, JSON.stringify(output, null, 2))
const consoleOutput = hasArgument("--summary") ? { ...output, signals: undefined } : output
console.log(JSON.stringify({ ...consoleOutput, output: outputPath }, null, 2))
