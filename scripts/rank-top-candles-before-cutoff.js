import fs from "node:fs"
import path from "node:path"
import readline from "node:readline"

const ROOT = process.cwd()
const MINUTE = 60_000
const INDIA_OFFSET_MINUTES = 330
const DEPTH_ROOT = path.join(ROOT, "db", "cash-depth")

function option(name, fallback = undefined) {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 ? process.argv[index + 1] : fallback
}

function numberOption(name, fallback) {
  const value = Number(option(name, fallback))
  if (!Number.isInteger(value) || value <= 0) throw new Error(`Invalid --${name}`)
  return value
}

function parseIndiaDateTime(value) {
  const match = String(value || "").match(/^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?$/)
  if (!match) throw new Error(`Expected YYYY-MM-DDTHH:mm, received: ${value}`)
  const [, date, hour = "00", minute = "00", second = "00"] = match
  return Date.UTC(
    Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10)),
    Number(hour), Number(minute), Number(second)) - INDIA_OFFSET_MINUTES * MINUTE
}

function indiaDate(epoch) {
  return new Date(epoch + INDIA_OFFSET_MINUTES * MINUTE).toISOString().slice(0, 10)
}

function discoverSymbols() {
  const stockList = path.join(ROOT, "db", "stocks")
  if (!fs.existsSync(stockList)) throw new Error(`Missing stock list: ${stockList}`)
  const stocks = JSON.parse(fs.readFileSync(stockList, "utf8"))
  if (!Array.isArray(stocks)) throw new Error(`${stockList} must contain a JSON array`)
  return [...new Set(stocks.map((symbol) => String(symbol).trim().toUpperCase().replace(/-EQ$/, "")).filter(Boolean))]
}

function tradingDates(cutoffDate, count) {
  return fs.readdirSync(DEPTH_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(entry.name) && entry.name <= cutoffDate)
    .map((entry) => entry.name)
    .sort()
    .reverse()
    .slice(0, count)
    .reverse()
}

function bidShare(data) {
  let bids = 0
  let asks = 0
  for (let level = 1; level <= 5; level++) {
    const bidPrice = Number(data?.[`bid_price${level}`])
    const askPrice = Number(data?.[`ask_price${level}`])
    const bidSize = Number(data?.[`bid_size${level}`])
    const askSize = Number(data?.[`ask_size${level}`])
    if (![bidPrice, askPrice, bidSize, askSize].every(Number.isFinite) ||
        bidPrice <= 0 || askPrice <= bidPrice || bidSize < 0 || askSize < 0) return null
    bids += bidSize
    asks += askSize
  }
  return bids + asks > 0 ? 100 * bids / (bids + asks) : null
}

async function aggregateDepthFile(filename, cutoffEpoch, buckets, session = null) {
  const lines = readline.createInterface({ input: fs.createReadStream(filename), crlfDelay: Infinity })
  let previousVolume = null
  let previousPrice = null
  let lastTradeDirection = 0

  for await (const line of lines) {
    if (!line.trim()) continue
    let record
    try { record = JSON.parse(line) } catch { continue }

    const epoch = Date.parse(record.receivedAt)
    const price = Number(record.marketContext?.price)
    const cumulativeVolume = Number(record.marketContext?.cumulativeVolume)
    if (!Number.isFinite(epoch) || !Number.isFinite(price) || price <= 0 ||
        !Number.isFinite(cumulativeVolume) || cumulativeVolume < 0) continue
    if (epoch > cutoffEpoch) break

    if (session && epoch < session.startEpoch) {
      previousVolume = cumulativeVolume
      previousPrice = price
      continue
    }

    let executedVolume = 0
    if (previousVolume !== null && cumulativeVolume >= previousVolume) {
      executedVolume = cumulativeVolume - previousVolume
      if (previousPrice !== null) {
        if (price > previousPrice) lastTradeDirection = 1
        else if (price < previousPrice) lastTradeDirection = -1
      }
      if (executedVolume > 0) {
        const minute = Math.floor(epoch / MINUTE) * MINUTE
        const bucket = buckets.get(minute) || { epoch: minute, volume: 0, amount: 0 }
        bucket.volume += executedVolume
        bucket.amount += executedVolume * price
        buckets.set(minute, bucket)
      }
    }

    if (session) {
      session.lastPrice = price
      session.sessionLow = Math.min(session.sessionLow, price)
      session.sessionHigh = Math.max(session.sessionHigh, price)
      session.sessionVolume += executedVolume
      if (epoch >= session.finalFiveStart) {
        session.finalFiveVolume += executedVolume
        session.finalFiveSignedVolume += executedVolume * lastTradeDirection
        const share = bidShare(record.data)
        if (share !== null) {
          session.finalFiveBidShareSum += share
          session.finalFiveBidShareSamples++
        }
      }
    }
    previousVolume = cumulativeVolume
    previousPrice = price
  }
}

async function analyzeSymbol(symbol, dates, cutoffEpoch, requiredRecentCount, windowMinutes) {
  const buckets = new Map()
  const cutoffDate = indiaDate(cutoffEpoch)
  const session = {
    startEpoch: parseIndiaDateTime(`${cutoffDate}T09:15`),
    finalFiveStart: cutoffEpoch - 5 * MINUTE,
    sessionLow: Infinity,
    sessionHigh: -Infinity,
    lastPrice: null,
    sessionVolume: 0,
    finalFiveVolume: 0,
    finalFiveSignedVolume: 0,
    finalFiveBidShareSum: 0,
    finalFiveBidShareSamples: 0,
  }
  let filesRead = 0
  for (const date of dates) {
    const filename = path.join(DEPTH_ROOT, date, symbol, `${symbol}.jsonl`)
    if (!fs.existsSync(filename)) continue
    await aggregateDepthFile(filename, cutoffEpoch, buckets, date === cutoffDate ? session : null)
    filesRead++
  }

  const top = [...buckets.values()].sort((left, right) => right.amount - left.amount).slice(0, 5)
  const windowStart = cutoffEpoch - windowMinutes * MINUTE
  const recentTopCount = top.filter((candle) =>
    candle.epoch >= windowStart && candle.epoch <= cutoffEpoch).length
  const rangePosition = session.sessionHigh > session.sessionLow
    ? 100 * (session.lastPrice - session.sessionLow) /
      (session.sessionHigh - session.sessionLow) : 0
  const finalFiveDelta = session.finalFiveVolume > 0
    ? 100 * session.finalFiveSignedVolume / session.finalFiveVolume : 0
  const finalFiveBidShare = session.finalFiveBidShareSamples > 0
    ? session.finalFiveBidShareSum / session.finalFiveBidShareSamples : 0
  const finalFiveVolumeShare = session.sessionVolume > 0
    ? 100 * session.finalFiveVolume / session.sessionVolume : 0
  const passesFinalFilter = rangePosition >= 60 && finalFiveDelta > 15 &&
    finalFiveBidShare > 52 && finalFiveVolumeShare >= 1
  const qualifies = top.length === 5 && recentTopCount >= requiredRecentCount && passesFinalFilter
  return { symbol, filesRead, qualifies }
}

const cutoffArg = option("cutoff")
const cutoffDateArg = option("cutoff-date")
const cutoffTime = option("cutoff-time", "15:30")
const todayIndia = new Date(Date.now() + INDIA_OFFSET_MINUTES * MINUTE).toISOString().slice(0, 10)
const cutoffEpoch = parseIndiaDateTime(cutoffArg || `${cutoffDateArg || todayIndia}T${cutoffTime}`)
const days = numberOption("days", 5)
const windowMinutes = numberOption("window", 15)
const requiredRecentCount = numberOption("top", 5)
if (requiredRecentCount > 5) throw new Error("--top must be between 1 and 5")
const dates = tradingDates(indiaDate(cutoffEpoch), days)
if (!dates.length) throw new Error(`No cash-depth dates found on or before ${indiaDate(cutoffEpoch)}`)

const symbolsArg = option("symbols")
const symbols = (symbolsArg ? symbolsArg.split(",") : discoverSymbols())
  .map((symbol) => symbol.trim().toUpperCase().replace(/-EQ$/, ""))
  .filter(Boolean)

const selected = []
const missing = []
for (const symbol of [...new Set(symbols)]) {
  const result = await analyzeSymbol(symbol, dates, cutoffEpoch, requiredRecentCount, windowMinutes)
  if (!result.filesRead) missing.push(symbol)
  else if (result.qualifies) selected.push(symbol)
}

console.log(JSON.stringify(selected, null, 2))
if (missing.length) console.error(`Missing market-depth files: ${missing.join(", ")}`)
