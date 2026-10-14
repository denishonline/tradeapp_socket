import fs from "node:fs"
import path from "node:path"
import readline from "node:readline"

const ROOT = process.cwd()
const CANDLE_ROOT = path.join(ROOT, "db", "candles")
const DEPTH_ROOT = path.join(ROOT, "db", "cash-depth")
const MINUTE = 60_000
const IST_OFFSET = 330 * MINUTE
const DATE_COUNT = 5
const STOCK_COUNT = 30
const TARGET_PCT = 1
const STOP_PCT = 0.5

function commandLineOptions(commandLine) {
  const options = { cutoff: null }
  const positional = []
  for (let index = 0; index < commandLine.length; index++) {
    const value = commandLine[index]
    if (value === "--cutoff") options.cutoff = commandLine[++index]
    else if (value.startsWith("--cutoff=")) options.cutoff = value.slice("--cutoff=".length)
    else if (value === "--help" || value === "-h") options.help = true
    else positional.push(value)
  }
  if (!options.cutoff && positional.length) options.cutoff = positional.join(" ")
  return options
}

function usage() {
  return [
    "Usage:",
    "  node scripts/scan-low-cross-ema-depth-signals.js",
    "  node scripts/scan-low-cross-ema-depth-signals.js --cutoff \"2026-10-14 12:00\"",
    "  node scripts/scan-low-cross-ema-depth-signals.js --cutoff 12:00",
    "",
    "Cutoff is an as-of timestamp in IST. HH:MM uses the newest saved depth date.",
    "Candles must be completed and depth records/entries must exist at or before the cutoff.",
  ].join("\n")
}

// Historical rule derived from 8-14 October 2026. It intentionally emits only
// bullish signals because no bearish rule survived the chronological check.
const RULE = Object.freeze({
  maximumClosingTop2Imbalance: -0.40,
  minimumOneMinuteOfi: 0.10,
  maximumThreeMinuteFullImbalance: 0.05,
  minimumOneMinuteUpdates: 10,
  minimumOneMinuteSpanSeconds: 45,
  minimumThreeMinuteSpanSeconds: 150,
  maximumDepthGapSeconds: 15,
  maximumEntryLatencySeconds: 15,
})

const round = (value, digits = 4) => Number.isFinite(value) ? Number(value.toFixed(digits)) : null
const pct = (value, base) => base > 0 ? (value / base - 1) * 100 : NaN
const mean = (values) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : NaN
const indiaDate = (at) => new Date(at + IST_OFFSET).toISOString().slice(0, 10)
const indiaTime = (at) => new Date(at + IST_OFFSET).toISOString().slice(11, 19)
const dateTime = (at) => `${indiaDate(at)} ${indiaTime(at)}`

function lowerBound(rows, at) {
  let low = 0, high = rows.length
  while (low < high) {
    const middle = (low + high) >>> 1
    if (rows[middle].at < at) low = middle + 1
    else high = middle
  }
  return low
}

function csvValue(value) {
  const text = value == null ? "" : String(value)
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
}

async function* records(filename) {
  const input = fs.createReadStream(filename, { encoding: "utf8" })
  const lines = readline.createInterface({ input, crlfDelay: Infinity })
  try {
    for await (const line of lines) {
      if (!line.trim()) continue
      try { yield JSON.parse(line) } catch { /* Ignore an incomplete final line. */ }
    }
  } finally {
    lines.close()
    input.destroy()
  }
}

function allAvailableDates() {
  if (!fs.existsSync(DEPTH_ROOT)) throw new Error(`Missing depth directory: ${DEPTH_ROOT}`)
  return fs.readdirSync(DEPTH_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(entry.name))
    .map((entry) => entry.name).sort()
}

function cutoffTimestamp(raw, newestDate) {
  if (!raw) return Infinity
  const input = String(raw).trim()
  let normalized
  if (/^\d{2}:\d{2}(:\d{2})?$/.test(input)) {
    normalized = `${newestDate}T${input}${input.length === 5 ? ":00" : ""}+05:30`
  } else if (/^\d{4}-\d{2}-\d{2}$/.test(input)) {
    normalized = `${input}T15:30:00+05:30`
  } else if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2})?$/.test(input)) {
    normalized = `${input.replace(" ", "T")}${input.length === 16 ? ":00" : ""}+05:30`
  } else normalized = input
  const parsed = Date.parse(normalized)
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid cutoff '${raw}'. Use an IST value such as 2026-10-14 12:00.`)
  }
  return parsed
}

function availableDates(allDates, cutoffAt) {
  const dates = allDates.filter((date) =>
    Date.parse(`${date}T09:15:00+05:30`) <= cutoffAt)
  if (dates.length < DATE_COUNT) {
    throw new Error(`Need ${DATE_COUNT} dated depth archives; found ${dates.length}`)
  }
  return dates.slice(-DATE_COUNT)
}

function candleFiles() {
  if (!fs.existsSync(CANDLE_ROOT)) throw new Error(`Missing candle directory: ${CANDLE_ROOT}`)
  return fs.readdirSync(CANDLE_ROOT)
    .filter((filename) => filename.endsWith(".jsonl"))
    .sort()
}

function loadSelectedCandles(filename, selectedDates, cutoffAt) {
  const wanted = new Set(selectedDates)
  const rows = fs.readFileSync(path.join(CANDLE_ROOT, filename), "utf8")
    .split(/\r?\n/).flatMap((line) => {
      if (!line.trim()) return []
      try {
        const value = JSON.parse(line), at = Number(value.time) * 1000
        if (!Number.isFinite(at) || at + MINUTE > cutoffAt || !wanted.has(indiaDate(at))) return []
        const row = { at, open: Number(value.open), high: Number(value.high),
          low: Number(value.low), close: Number(value.close), volume: Number(value.volume) }
        return Object.values(row).every(Number.isFinite) ? [row] : []
      } catch { return [] }
    }).sort((left, right) => left.at - right.at)

  const counts = Object.fromEntries(selectedDates.map((date) => [date, 0]))
  for (const row of rows) counts[indiaDate(row.at)]++
  return { rows, counts }
}

function addEmaAndCrosses(candles) {
  let ema15 = null, ema30 = null, previousSign = 0
  const crosses = []
  for (let index = 0; index < candles.length; index++) {
    const row = candles[index]
    ema15 = ema15 == null ? row.close : 2 / 16 * row.close + 14 / 16 * ema15
    ema30 = ema30 == null ? row.close : 2 / 31 * row.close + 29 / 31 * ema30
    row.ema15 = ema15
    row.ema30 = ema30
    row.emaDiff = ema15 - ema30
    row.emaSign = row.emaDiff > 0 ? 1 : row.emaDiff < 0 ? -1 : 0
    if (index >= 29 && previousSign && row.emaSign && row.emaSign !== previousSign) {
      crosses.push({ index, at: row.at, signalAt: row.at + MINUTE,
        side: row.emaSign > 0 ? "BUY" : "SELL", direction: row.emaSign })
    }
    if (index >= 29 && row.emaSign) previousSign = row.emaSign
  }
  return crosses
}

function rankStocks(selectedDates, cutoffAt) {
  const loaded = []
  const maximumByDate = Object.fromEntries(selectedDates.map((date) => [date, 0]))
  for (const filename of candleFiles()) {
    const symbol = filename.slice(0, -6)
    const candleData = loadSelectedCandles(filename, selectedDates, cutoffAt)
    for (const date of selectedDates) maximumByDate[date] = Math.max(maximumByDate[date], candleData.counts[date])
    loaded.push({ symbol, ...candleData })
  }

  // Missing data must not make a stock appear artificially quiet. A stock must
  // have at least 95% of the best candle coverage seen on every selected date.
  const eligible = loaded.filter((stock) => selectedDates.every((date) =>
    maximumByDate[date] >= 30 && stock.counts[date] >= Math.floor(maximumByDate[date] * 0.95)))
  for (const stock of eligible) stock.crosses = addEmaAndCrosses(stock.rows)
  eligible.sort((left, right) => left.crosses.length - right.crosses.length ||
    left.symbol.localeCompare(right.symbol))
  return { ranked: eligible.slice(0, STOCK_COUNT), eligibleCount: eligible.length, maximumByDate }
}

function completeBook(fields) {
  let bidSize = 0, askSize = 0, bid2 = 0, ask2 = 0
  for (let level = 1; level <= 5; level++) {
    const bidPrice = Number(fields[`bid_price${level}`])
    const askPrice = Number(fields[`ask_price${level}`])
    const currentBid = Number(fields[`bid_size${level}`])
    const currentAsk = Number(fields[`ask_size${level}`])
    if (![bidPrice, askPrice, currentBid, currentAsk].every(Number.isFinite) ||
        bidPrice <= 0 || askPrice <= bidPrice || currentBid < 0 || currentAsk < 0) return null
    bidSize += currentBid
    askSize += currentAsk
    if (level <= 2) { bid2 += currentBid; ask2 += currentAsk }
  }
  const bid = Number(fields.bid_price1), ask = Number(fields.ask_price1)
  const bid1 = Number(fields.bid_size1), ask1 = Number(fields.ask_size1)
  return { bid, ask, bid1, ask1, mid: (bid + ask) / 2,
    full: (bidSize - askSize) / (bidSize + askSize || 1),
    top2: (bid2 - ask2) / (bid2 + ask2 || 1) }
}

async function loadDepth(symbol, selectedDates, cutoffAt) {
  const samples = []
  for (const date of selectedDates) {
    const filename = path.join(DEPTH_ROOT, date, symbol, `${symbol}.jsonl`)
    if (!fs.existsSync(filename)) continue
    const fields = {}
    let previous = null, lastTradeDirection = 0
    for await (const record of records(filename)) {
      const at = Date.parse(record.receivedAt)
      if (!Number.isFinite(at) || indiaDate(at) !== date) continue
      if (at > cutoffAt) continue
      if (previous && at - previous.at > 90_000) {
        previous = null
        lastTradeDirection = 0
        for (const key of Object.keys(fields)) delete fields[key]
      }
      if (record.kind === "checkpoint" || record.book) {
        for (const key of Object.keys(fields)) delete fields[key]
        Object.assign(fields, record.data)
      } else if (record.kind === "update") Object.assign(fields, record.data)
      else continue

      const book = completeBook(fields)
      const marketPrice = Number(record.marketContext?.price)
      const volume = Number(record.marketContext?.cumulativeVolume)
      if (!book || !(marketPrice > 0) || !Number.isFinite(volume)) continue
      let ofi = 0, traded = 0, signed = 0
      if (previous) {
        let rawOfi = book.bid > previous.bid ? book.bid1
          : book.bid === previous.bid ? book.bid1 - previous.bid1 : -previous.bid1
        rawOfi -= book.ask < previous.ask ? book.ask1
          : book.ask === previous.ask ? book.ask1 - previous.ask1 : -previous.ask1
        ofi = rawOfi / ((book.bid1 + book.ask1 + previous.bid1 + previous.ask1) / 2 || 1)
        traded = Math.max(0, volume - previous.volume)
        if (marketPrice > previous.price) lastTradeDirection = 1
        else if (marketPrice < previous.price) lastTradeDirection = -1
        signed = traded * lastTradeDirection
      }
      samples.push({ at, price: marketPrice, volume, ofi, traded, signed, ...book })
      previous = { at, price: marketPrice, volume, ...book }
    }
  }
  return samples.sort((left, right) => left.at - right.at)
}

function depthWindow(samples, from, to) {
  const rows = samples.slice(lowerBound(samples, from), lowerBound(samples, to))
  if (!rows.length) return null
  const gaps = rows.slice(1).map((row, index) => (row.at - rows[index].at) / 1000)
  return { updates: rows.length, spanSec: (rows.at(-1).at - rows[0].at) / 1000,
    maxGapSec: gaps.length ? Math.max(...gaps) : Infinity,
    full: mean(rows.map((row) => row.full)), top2: mean(rows.map((row) => row.top2)),
    closingFull: rows.at(-1).full, closingTop2: rows.at(-1).top2,
    ofi: mean(rows.map((row) => row.ofi)) }
}

function executableOutcome(samples, signalAt, nextSignalAt) {
  const entryIndex = lowerBound(samples, signalAt), entry = samples[entryIndex]
  if (!entry || entry.at - signalAt > RULE.maximumEntryLatencySeconds * 1000 ||
      indiaDate(entry.at) !== indiaDate(signalAt)) return null
  const entryPrice = entry.ask
  const stopPrice = entryPrice * (1 - STOP_PCT / 100)
  const targetPrice = entryPrice * (1 + TARGET_PCT / 100)
  const hasNextCross = Number.isFinite(nextSignalAt)
  const endIndex = hasNextCross ? lowerBound(samples, nextSignalAt) : samples.length
  const path = samples.slice(entryIndex, endIndex)
  let outcome = hasNextCross ? "CROSS_EXIT" : "OPEN"
  let exit = null, maximum = -Infinity, minimum = Infinity
  for (const row of path) {
    const currentReturn = pct(row.bid, entryPrice)
    maximum = Math.max(maximum, currentReturn)
    minimum = Math.min(minimum, currentReturn)
    if (row.bid >= targetPrice) { outcome = "TARGET"; exit = row; break }
    if (row.bid <= stopPrice) { outcome = "STOP"; exit = row; break }
  }
  if (!exit && hasNextCross) {
    const next = samples[endIndex]
    exit = next && next.at - nextSignalAt <= RULE.maximumEntryLatencySeconds * 1000
      ? next : path.at(-1)
  }
  return { entryAt: entry.at, entryPrice, targetPrice, stopPrice, outcome,
    outcomeAt: exit?.at ?? null, outcomePrice: exit?.bid ?? null,
    outcomeReturnPct: exit ? pct(exit.bid, entryPrice) : null,
    mfePct: Number.isFinite(maximum) ? maximum : null,
    maePct: Number.isFinite(minimum) ? minimum : null }
}

async function scanStock(stock, selectedDates, cutoffAt) {
  const samples = await loadDepth(stock.symbol, selectedDates, cutoffAt)
  const signals = []
  for (let crossIndex = 0; crossIndex < stock.crosses.length; crossIndex++) {
    const cross = stock.crosses[crossIndex]
    if (cross.side !== "BUY") continue
    const oneMinute = depthWindow(samples, cross.signalAt - MINUTE, cross.signalAt)
    const threeMinute = depthWindow(samples, cross.signalAt - 3 * MINUTE, cross.signalAt)
    if (!oneMinute || !threeMinute ||
        oneMinute.updates < RULE.minimumOneMinuteUpdates ||
        oneMinute.spanSec < RULE.minimumOneMinuteSpanSeconds ||
        threeMinute.spanSec < RULE.minimumThreeMinuteSpanSeconds ||
        oneMinute.maxGapSec > RULE.maximumDepthGapSeconds ||
        threeMinute.maxGapSec > RULE.maximumDepthGapSeconds ||
        oneMinute.closingTop2 > RULE.maximumClosingTop2Imbalance ||
        oneMinute.ofi < RULE.minimumOneMinuteOfi ||
        threeMinute.full > RULE.maximumThreeMinuteFullImbalance) continue

    const nextCross = stock.crosses[crossIndex + 1]
    const outcome = executableOutcome(samples, cross.signalAt, nextCross?.signalAt ?? Infinity)
    if (!outcome) continue
    signals.push({
      date: indiaDate(cross.signalAt), time: indiaTime(cross.signalAt), symbol: stock.symbol,
      crossCount: stock.crosses.length, side: "BUY", entry: round(outcome.entryPrice, 2),
      target: round(outcome.targetPrice, 2), stop: round(outcome.stopPrice, 2),
      outcome: outcome.outcome, outcomeAt: outcome.outcomeAt ? dateTime(outcome.outcomeAt) : "",
      outcomeReturnPct: round(outcome.outcomeReturnPct), mfePct: round(outcome.mfePct),
      maePct: round(outcome.maePct), nextCrossAt: nextCross ? dateTime(nextCross.signalAt) : "",
      closeTop2: round(oneMinute.closingTop2), ofi1m: round(oneMinute.ofi),
      fullBook3m: round(threeMinute.full),
    })
  }
  return signals
}

const options = commandLineOptions(process.argv.slice(2))
if (options.help) {
  console.log(usage())
  process.exit(0)
}
const savedDates = allAvailableDates()
if (!savedDates.length) throw new Error("No dated cash-depth archives found")
const cutoffAt = cutoffTimestamp(options.cutoff, savedDates.at(-1))
const selectedDates = availableDates(savedDates, cutoffAt)
const { ranked, eligibleCount, maximumByDate } = rankStocks(selectedDates, cutoffAt)
if (ranked.length < STOCK_COUNT) {
  throw new Error(`Only ${ranked.length} stocks have adequate candle coverage; need ${STOCK_COUNT}`)
}

console.log(`Dates: ${selectedDates.join(", ")}`)
console.log(`Cutoff: ${Number.isFinite(cutoffAt) ? `${dateTime(cutoffAt)} IST` : "none (all saved data)"}`)
console.log(`Eligible stocks: ${eligibleCount}; selected lowest-cross stocks: ${ranked.length}`)
console.log(`Maximum candles by date: ${JSON.stringify(maximumByDate)}`)
console.log("Top 30 stocks by lowest EMA15/EMA30 crossover count:")
console.table(ranked.map((stock, index) => ({ rank: index + 1, symbol: stock.symbol,
  crossCount: stock.crosses.length, candles: stock.rows.length })))

const signals = []
for (let index = 0; index < ranked.length; index++) {
  const stock = ranked[index]
  process.stderr.write(`Scanning depth ${index + 1}/${ranked.length}: ${stock.symbol}\n`)
  signals.push(...await scanStock(stock, selectedDates, cutoffAt))
}
signals.sort((left, right) => left.date.localeCompare(right.date) ||
  left.time.localeCompare(right.time) || left.symbol.localeCompare(right.symbol))

const cutoffSlug = Number.isFinite(cutoffAt) ? `-cutoff-${indiaDate(cutoffAt)}-${indiaTime(cutoffAt).replaceAll(":", "")}` : ""
const output = path.join(ROOT, "csv", `${selectedDates[0]}-to-${selectedDates.at(-1)}${cutoffSlug}-low-cross-ema-depth-signals.csv`)
fs.mkdirSync(path.dirname(output), { recursive: true })
const columns = signals.length ? Object.keys(signals[0]) : ["date", "time", "symbol", "side"]
fs.writeFileSync(output, `${[columns.join(","), ...signals.map((row) =>
  columns.map((column) => csvValue(row[column])).join(","))].join("\n")}\n`)

console.log(`Signal CSV: ${output}`)
console.log(`All qualifying signals (${signals.length}), chronological:`)
console.table(signals)
