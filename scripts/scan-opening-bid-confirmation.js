import fs from "node:fs"
import path from "node:path"
import readline from "node:readline"

const ROOT = process.cwd()
const DEPTH_ROOT = path.join(ROOT, "db", "cash-depth")
const CANDLE_ROOT = path.join(ROOT, "db", "candles")
const SESSION_OPEN_MINUTE = 9 * 60 + 15
const SESSION_CLOSE_MINUTE = 15 * 60 + 30
const MINUTE = 60_000

const mean = (values) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null
const pct = (value, base) => Number.isFinite(value) && Number.isFinite(base) && base !== 0
  ? (value / base - 1) * 100 : null
const round = (value, places = 3) => Number.isFinite(value) ? Number(value.toFixed(places)) : null

function parseArguments(commandLine) {
  const options = { date: null, cutoff: "09:30", sessions: 6, json: false }
  const positional = []
  for (let index = 0; index < commandLine.length; index++) {
    const value = commandLine[index]
    if (value === "--date") options.date = commandLine[++index]
    else if (value.startsWith("--date=")) options.date = value.slice("--date=".length)
    else if (value === "--cutoff") options.cutoff = commandLine[++index]
    else if (value.startsWith("--cutoff=")) options.cutoff = value.slice("--cutoff=".length)
    else if (value === "--sessions") options.sessions = Number(commandLine[++index])
    else if (value.startsWith("--sessions=")) options.sessions = Number(value.slice("--sessions=".length))
    else if (value === "--json") options.json = true
    else if (value === "--help" || value === "-h") options.help = true
    else positional.push(value)
  }
  if (positional[0]) options.cutoff = positional[0]
  if (positional[1]) options.date = positional[1]
  if (!Number.isInteger(options.sessions) || options.sessions < 2) {
    throw new Error("--sessions must be an integer of at least 2: one prior session plus the target session")
  }
  return options
}

function usage() {
  return [
    "Opening bid confirmation scanner",
    "",
    "Usage:",
    "  node scripts/scan-opening-bid-confirmation.js --cutoff 09:30 --date 2026-10-14",
    "  node scripts/scan-opening-bid-confirmation.js 09:30 2026-10-14",
    "  npm run scan:depth:opening-record -- --cutoff 09:30",
    "",
    "Options:",
    "  --cutoff HH:MM    Exclusive IST cutoff; default 09:30",
    "  --date YYYY-MM-DD Session date; default latest stored depth date",
    "  --sessions N      Maximum sessions including target; default 6 (uses fewer when needed)",
    "  --json            Print machine-readable JSON",
  ].join("\n")
}

function availableDates() {
  if (!fs.existsSync(DEPTH_ROOT)) return []
  return fs.readdirSync(DEPTH_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(entry.name))
    .map((entry) => entry.name).sort()
}

function parseCutoff(date, value) {
  const match = /^(\d{2}):(\d{2})$/.exec(String(value || ""))
  if (!match) throw new Error("--cutoff must use HH:MM IST, for example 09:30")
  const hour = Number(match[1]), minute = Number(match[2]), minuteOfDay = hour * 60 + minute
  if (minuteOfDay < SESSION_OPEN_MINUTE + 10 || minuteOfDay > SESSION_CLOSE_MINUTE) {
    throw new Error("Cutoff must be between 09:25 and 15:30 IST")
  }
  return { text: `${match[1]}:${match[2]}`, at: Date.parse(`${date}T${match[1]}:${match[2]}:00+05:30`), minuteOfDay }
}

function parseBook(data) {
  const bids = [], asks = []
  for (let level = 1; level <= 5; level++) {
    const bidPrice = Number(data?.[`bid_price${level}`])
    const bidSize = Number(data?.[`bid_size${level}`])
    const askPrice = Number(data?.[`ask_price${level}`])
    const askSize = Number(data?.[`ask_size${level}`])
    if (![bidPrice, bidSize, askPrice, askSize].every(Number.isFinite) ||
        bidPrice <= 0 || askPrice <= bidPrice || bidSize < 0 || askSize < 0) return null
    bids.push(bidSize)
    asks.push(askSize)
  }
  const bidSize = bids.reduce((sum, value) => sum + value, 0)
  const askSize = asks.reduce((sum, value) => sum + value, 0)
  const topTwoBid = bids[0] + bids[1]
  const topTwoAsk = asks[0] + asks[1]
  if (!(bidSize + askSize > 0)) return null
  return {
    bidShare: 100 * bidSize / (bidSize + askSize),
    topTwoBidShare: 100 * topTwoBid / (topTwoBid + topTwoAsk || 1),
  }
}

function summarizeOpening(rows, minutes) {
  return {
    updates: rows.length,
    depthMinutes: minutes.size,
    averageBidShare: mean(rows.map((row) => row.bidShare)),
    bidDominantPct: rows.length ? 100 * rows.filter((row) => row.bidShare > 50).length / rows.length : null,
    averageTopTwoBidShare: mean(rows.map((row) => row.topTwoBidShare)),
  }
}

async function readDepthProfile(date, symbol, cutoffText) {
  const filename = path.join(DEPTH_ROOT, date, symbol, `${symbol}.jsonl`)
  if (!fs.existsSync(filename)) return null
  const sessionStart = Date.parse(`${date}T09:15:00+05:30`)
  const sessionEnd = Date.parse(`${date}T15:30:00+05:30`)
  const cutoff = Date.parse(`${date}T${cutoffText}:00+05:30`)
  const input = fs.createReadStream(filename)
  const lines = readline.createInterface({ input, crlfDelay: Infinity })
  const openingRows = [], openingMinutes = new Set(), minuteBid = new Map()

  for await (const line of lines) {
    if (!line.trim()) continue
    let record
    try { record = JSON.parse(line) } catch { continue }
    const at = Date.parse(record.receivedAt)
    if (!Number.isFinite(at) || at < sessionStart) continue
    if (at >= sessionEnd) {
      lines.close()
      input.destroy()
      break
    }
    const book = parseBook(record.data)
    if (!book) continue
    const minute = Math.floor(at / MINUTE)
    const bucket = minuteBid.get(minute) || { sum: 0, count: 0 }
    bucket.sum += book.bidShare
    bucket.count++
    minuteBid.set(minute, bucket)
    if (at < cutoff) {
      openingRows.push(book)
      openingMinutes.add(minute)
    }
  }

  return {
    opening: summarizeOpening(openingRows, openingMinutes),
    fullDayAverageBidShare: mean([...minuteBid.values()].map((row) => row.sum / row.count)),
  }
}

function readDailyCandles(symbol, dates) {
  const filename = path.join(CANDLE_ROOT, `${symbol}.jsonl`)
  if (!fs.existsSync(filename)) return null
  const wanted = new Map(dates.map((date) => [date, new Map()]))
  const windows = new Map(dates.map((date) => [date, {
    start: Date.parse(`${date}T09:15:00+05:30`),
    end: Date.parse(`${date}T15:30:00+05:30`),
  }]))
  for (const line of fs.readFileSync(filename, "utf8").split(/\r?\n/)) {
    if (!line.trim()) continue
    let row
    try { row = JSON.parse(line) } catch { continue }
    const at = Number(row.time) * 1000
    for (const date of dates) {
      const window = windows.get(date)
      if (at >= window.start && at < window.end) wanted.get(date).set(at, { ...row, at })
    }
  }
  return dates.map((date) => {
    const rows = [...wanted.get(date).values()].sort((left, right) => left.at - right.at)
    if (!rows.length) return null
    const high = Math.max(...rows.map((row) => Number(row.high)))
    const low = Math.min(...rows.map((row) => Number(row.low)))
    const close = Number(rows.at(-1).close)
    return {
      date,
      bars: rows.length,
      close,
      high,
      low,
      volume: rows.reduce((sum, row) => sum + Number(row.volume || 0), 0),
      closeLocationPct: high > low ? 100 * (close - low) / (high - low) : 50,
    }
  })
}

function historicalSetup(candles, priorDepth) {
  const latest = candles.at(-1)
  const historicalReturnPct = candles.length > 1 ? pct(latest.close, candles[0].close) : 0
  const earlierVolumes = candles.slice(0, -1).map((row) => row.volume)
  const priorDayVolumeRatio = earlierVolumes.length ? latest.volume / mean(earlierVolumes) : null
  const priorThreeDayBidShare = mean(priorDepth.slice(-3).map((row) => row.fullDayAverageBidShare))
  return {
    priorSessionsUsed: candles.length,
    historicalReturnPct,
    priorDayCloseLocationPct: latest.closeLocationPct,
    priorDayVolumeRatio,
    priorThreeDayBidShare,
    passes: historicalReturnPct <= 1.50 &&
      latest.closeLocationPct >= 88 &&
      (priorDayVolumeRatio === null || priorDayVolumeRatio <= 0.90) &&
      priorThreeDayBidShare <= 52,
  }
}

async function main() {
  const options = parseArguments(process.argv.slice(2))
  if (options.help) {
    console.log(usage())
    return
  }
  const allDates = availableDates()
  const targetDate = options.date || allDates.at(-1)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(targetDate || "") || !allDates.includes(targetDate)) {
    throw new Error(`No stored cash-depth session found for '${targetDate || "unknown"}'`)
  }
  const cutoff = parseCutoff(targetDate, options.cutoff)
  const comparisonDates = allDates.filter((date) => date <= targetDate).slice(-options.sessions)
  if (comparisonDates.length < 2) {
    throw new Error(`At least one prior stored session is required before ${targetDate}`)
  }
  const priorDates = comparisonDates.slice(0, -1)

  const targetDirectory = path.join(DEPTH_ROOT, targetDate)
  const symbols = fs.readdirSync(targetDirectory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort()
  const windowMinutes = cutoff.minuteOfDay - SESSION_OPEN_MINUTE
  const requiredDepthMinutes = Math.max(10, Math.floor(windowMinutes * 0.80))
  const bySymbol = new Map(symbols.map((symbol) => [symbol, {}]))

  for (const date of comparisonDates) {
    if (!options.json) console.error(`Scanning ${date} through ${cutoff.text} IST (${symbols.length} stocks)...`)
    let cursor = 0
    await Promise.all(Array.from({ length: 12 }, async () => {
      while (cursor < symbols.length) {
        const symbol = symbols[cursor++]
        bySymbol.get(symbol)[date] = await readDepthProfile(date, symbol, cutoff.text)
      }
    }))
  }

  const eligible = []
  const rejected = { dataQuality: 0, openingRecord: 0, historicalSetup: 0 }
  for (const symbol of symbols) {
    const daily = bySymbol.get(symbol)
    const incomplete = comparisonDates.some((date) => !daily[date] ||
      daily[date].opening.depthMinutes < requiredDepthMinutes || daily[date].opening.updates < 100)
    if (incomplete) {
      rejected.dataQuality++
      continue
    }
    const today = daily[targetDate].opening
    const prior = priorDates.map((date) => daily[date])
    const previousMaxBidShare = Math.max(...prior.map((row) => row.opening.averageBidShare))
    const previousMaxBidDominantPct = Math.max(...prior.map((row) => row.opening.bidDominantPct))
    if (!(today.averageBidShare > previousMaxBidShare && today.bidDominantPct > previousMaxBidDominantPct)) {
      rejected.openingRecord++
      continue
    }

    const candleDays = readDailyCandles(symbol, priorDates)
    if (!candleDays || candleDays.some((row) => !row || row.bars < 300)) {
      rejected.dataQuality++
      continue
    }
    const setup = historicalSetup(candleDays, prior)
    if (!setup.passes) {
      rejected.historicalSetup++
      continue
    }
    eligible.push({
      symbol: `NSE:${symbol}-EQ`,
      averageBidShare: round(today.averageBidShare),
      bidDominantPct: round(today.bidDominantPct),
      previousMaxBidShare: round(previousMaxBidShare),
      previousMaxBidDominantPct: round(previousMaxBidDominantPct),
      priorSessionsUsed: setup.priorSessionsUsed,
      historicalReturnPct: round(setup.historicalReturnPct),
      priorDayCloseLocationPct: round(setup.priorDayCloseLocationPct),
      priorDayVolumeRatio: round(setup.priorDayVolumeRatio),
      priorThreeDayBidShare: round(setup.priorThreeDayBidShare),
      updates: today.updates,
      depthMinutes: today.depthMinutes,
    })
  }
  eligible.sort((left, right) =>
    right.bidDominantPct - left.bidDominantPct || right.averageBidShare - left.averageBidShare)

  const report = {
    date: targetDate,
    cutoffIst: cutoff.text,
    comparisonDates,
    scannedStocks: symbols.length,
    requiredDepthMinutes,
    eligibleCount: eligible.length,
    rejected,
    eligible,
  }
  if (options.json) {
    console.log(JSON.stringify(report, null, 2))
    return
  }
  console.log(`\n${targetDate} through ${cutoff.text} IST`)
  console.log(`Compared sessions: ${comparisonDates.join(", ")}`)
  console.log(`Scanned: ${symbols.length}; eligible: ${eligible.length}`)
  if (eligible.length) {
    console.table(eligible.map((row) => ({
      stock: row.symbol,
      avgBid: `${row.averageBidShare}%`,
      dominant: `${row.bidDominantPct}%`,
      historyDays: row.priorSessionsUsed,
      historyReturn: `${row.historicalReturnPct}%`,
      priorClose: `${row.priorDayCloseLocationPct}%`,
      volumeRatio: row.priorDayVolumeRatio,
      historicalBid: `${row.priorThreeDayBidShare}%`,
    })))
  }
  console.log(`eligible: ${eligible.map((row) => row.symbol).join(",")}`)
}

main().catch((error) => {
  console.error(error.message)
  process.exitCode = 1
})
