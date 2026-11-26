import fs from "node:fs"
import path from "node:path"
import apiV3 from "fyers-api-v3"
import { CONSTANT } from "../constant.js"
import { getFromStorage } from "../utils.js"

const ROOT = process.cwd()
const IST_OFFSET_MS = 330 * 60_000
const DISPLAY_COUNT = 10
const INTERNAL_PIVOT_BARS = 5
const REQUIRED_DEPTH_MINUTES = 2
const MIN_ASK_DOMINANT_SNAPSHOT_SHARE = 2 / 3
const MAX_FIRST_DEPTH_CONFIRMATION_DELAY_MINUTES = 15
const REFRESH_FYERS = process.argv.includes("--refresh-fyers")
const TABLE_OUTPUT = process.argv.includes("--table")
const SUMMARY_OUTPUT = process.argv.includes("--summary")
const CANDLE_CONFIRMATION = process.argv.includes("--candle-confirmation")
const CANDLE_ANCHOR = String(option("--candle-anchor", "confirmation")).toLowerCase()
if (!["origin", "confirmation"].includes(CANDLE_ANCHOR)) throw new Error("--candle-anchor must be origin or confirmation")
const ORDER_BLOCK_FILTER = String(option("--ob-filter", "atr")).toLowerCase()
if (!["atr", "range"].includes(ORDER_BLOCK_FILTER)) throw new Error("--ob-filter must be atr or range")
const CUTOFF = String(option("--cutoff", "15:30"))
if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(CUTOFF)) throw new Error("--cutoff must use HH:MM in IST")

function option(name, fallback = null) {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] ?? fallback : fallback
}

const date = option("--date", new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date()))
const requestedSymbols = String(option("--symbols", ""))
  .split(",")
  .map((symbol) => symbol.trim().replace(/^NSE:/i, "").replace(/-EQ$/i, ""))
  .filter(Boolean)

if (!requestedSymbols.length) {
  throw new Error("Usage: node scripts/scan-causal-smc-depth-signals.js --date YYYY-MM-DD --cutoff HH:MM --symbols SYMBOL[,SYMBOL...] [--refresh-fyers] [--ob-filter atr|range]")
}

function clockFromEpoch(seconds) {
  return new Date(Number(seconds) * 1000 + IST_OFFSET_MS).toISOString().slice(11, 16)
}

function dateFromEpoch(seconds) {
  return new Date(Number(seconds) * 1000 + IST_OFFSET_MS).toISOString().slice(0, 10)
}

function receivedClock(value) {
  return new Date(new Date(value).getTime() + IST_OFFSET_MS).toISOString().slice(11, 19)
}

function readJsonLines(file) {
  if (!fs.existsSync(file)) return []
  return fs.readFileSync(file, "utf8").split(/\r?\n/).flatMap((line) => {
    try { return line.trim() ? [JSON.parse(line)] : [] } catch { return [] }
  })
}

function fiveMinuteBars(symbol, refreshedCandles = []) {
  const byTimestamp = new Map()
  const sourceCandles = [...readJsonLines(path.join(ROOT, "db", "candles", `${symbol}.jsonl`)), ...refreshedCandles]
  for (const candle of sourceCandles) {
    const candleDate = dateFromEpoch(candle.time)
    const minute = clockFromEpoch(candle.time)
    if (minute < "09:15" || minute > "15:29" || candleDate > date || (candleDate === date && minute >= CUTOFF)) continue
    byTimestamp.set(Number(candle.time), {
      time: Number(candle.time), date: candleDate, minute,
      open: Number(candle.open), high: Number(candle.high), low: Number(candle.low), close: Number(candle.close), volume: Number(candle.volume),
    })
  }
  const buckets = new Map()
  for (const candle of [...byTimestamp.values()].sort((a, b) => a.time - b.time)) {
    const [hour, minute] = candle.minute.split(":").map(Number)
    const minuteOfDay = hour * 60 + minute
    const bucketStart = 9 * 60 + 15 + Math.floor((minuteOfDay - (9 * 60 + 15)) / 5) * 5
    const bucketMinute = `${String(Math.floor(bucketStart / 60)).padStart(2, "0")}:${String(bucketStart % 60).padStart(2, "0")}`
    const key = `${candle.date} ${bucketMinute}`
    const bucket = buckets.get(key)
    if (!bucket) buckets.set(key, { stamp: key, date: candle.date, minute: bucketMinute, open: candle.open, high: candle.high, low: candle.low, close: candle.close, volume: candle.volume, count: 1 })
    else {
      bucket.high = Math.max(bucket.high, candle.high)
      bucket.low = Math.min(bucket.low, candle.low)
      bucket.close = candle.close
      bucket.volume += candle.volume
      bucket.count++
    }
  }
  return [...buckets.values()].filter((bar) => bar.count === 5).sort((a, b) => a.stamp.localeCompare(b.stamp))
}

function oneMinuteCandles(symbol, refreshedCandles = []) {
  const byTimestamp = new Map()
  for (const candle of [...readJsonLines(path.join(ROOT, "db", "candles", `${symbol}.jsonl`)), ...refreshedCandles]) {
    const candleDate = dateFromEpoch(candle.time)
    const minute = clockFromEpoch(candle.time)
    if (candleDate !== date || minute < "09:15" || minute >= CUTOFF) continue
    byTimestamp.set(Number(candle.time), {
      time: Number(candle.time), minute,
      open: Number(candle.open), high: Number(candle.high), low: Number(candle.low), close: Number(candle.close), volume: Number(candle.volume),
    })
  }
  return [...byTimestamp.values()].sort((a, b) => a.time - b.time)
}

function fyersClient() {
  const token = String(getFromStorage("token") || "").trim()
  if (!token) throw new Error("FYERS token unavailable. Run AutoLogin first.")
  const client = new apiV3.fyersModel({ enableLogging: false })
  client.setAppId(CONSTANT.appId)
  client.setAccessToken(token)
  return client
}

async function fetchFyersCandles(client, symbol) {
  if (!client) return []
  const response = await client.getHistory({
    symbol: `NSE:${symbol}-EQ`, resolution: "1", date_format: "1",
    range_from: date, range_to: date, cont_flag: "1",
  })
  if (response?.s !== "ok" || !Array.isArray(response.candles)) {
    throw new Error(response?.message || response?.msg || "FYERS returned no candles")
  }
  return response.candles.map((row) => ({
    time: Number(row[0]), open: Number(row[1]), high: Number(row[2]), low: Number(row[3]), close: Number(row[4]), volume: Number(row[5]), source: "fyers-history-live",
  }))
}

// Port of the open-source LuxAlgo SMC internal-structure/order-block algorithm:
// internal leg 5, swing leg 50, ATR(200) volatility parsing, close crossover,
// and no confluence filter. DISPLAY_COUNT changes only how many blocks remain
// visible; it does not change detection.
function bearishInternalOrderBlocks(bars) {
  const trs = bars.map((bar, index) => index === 0
    ? bar.high - bar.low
    : Math.max(bar.high - bar.low, Math.abs(bar.high - bars[index - 1].close), Math.abs(bar.low - bars[index - 1].close)))
  const atr = Array(bars.length).fill(NaN)
  if (bars.length >= 200) {
    atr[199] = trs.slice(0, 200).reduce((sum, value) => sum + value, 0) / 200
    for (let index = 200; index < bars.length; index++) atr[index] = (atr[index - 1] * 199 + trs[index]) / 200
  }
  let cumulativeTrueRange = 0
  const cumulativeMeanRange = trs.map((value, index) => {
    cumulativeTrueRange += value
    return index > 0 ? cumulativeTrueRange / index : NaN
  })
  const volatility = ORDER_BLOCK_FILTER === "range" ? cumulativeMeanRange : atr
  const parsedHighs = bars.map((bar, index) => Number.isFinite(volatility[index]) && bar.high - bar.low >= 2 * volatility[index] ? bar.low : bar.high)
  const parsedLows = bars.map((bar, index) => Number.isFinite(volatility[index]) && bar.high - bar.low >= 2 * volatility[index] ? bar.high : bar.low)
  const pivot = () => ({ currentLevel: NaN, lastLevel: NaN, crossed: false, index: -1 })
  const swingHigh = pivot(), swingLow = pivot(), internalHigh = pivot(), internalLow = pivot()
  let swingLeg = 0, internalLeg = 0, internalTrend = 0
  const events = []

  function updateStructure(index, size, internal) {
    if (index < size) return
    const candidateIndex = index - size
    const candidate = bars[candidateIndex]
    const recent = bars.slice(candidateIndex + 1, index + 1)
    const newLegHigh = candidate.high > Math.max(...recent.map((bar) => bar.high))
    const newLegLow = candidate.low < Math.min(...recent.map((bar) => bar.low))
    const oldLeg = internal ? internalLeg : swingLeg
    let nextLeg = oldLeg
    if (newLegHigh) nextLeg = 0
    else if (newLegLow) nextLeg = 1
    if (internal) internalLeg = nextLeg
    else swingLeg = nextLeg
    if (nextLeg === oldLeg) return
    const target = nextLeg - oldLeg === 1
      ? (internal ? internalLow : swingLow)
      : (internal ? internalHigh : swingHigh)
    target.lastLevel = target.currentLevel
    target.currentLevel = nextLeg - oldLeg === 1 ? candidate.low : candidate.high
    target.crossed = false
    target.index = candidateIndex
  }

  for (let index = 0; index < bars.length; index++) {
    const previousInternalHigh = internalHigh.currentLevel
    const previousInternalLow = internalLow.currentLevel
    updateStructure(index, 50, false)
    updateStructure(index, INTERNAL_PIVOT_BARS, true)
    if (index === 0) continue
    const previousClose = bars[index - 1].close

    if (Number.isFinite(internalHigh.currentLevel)
      && bars[index].close > internalHigh.currentLevel
      && previousClose <= previousInternalHigh
      && !internalHigh.crossed
      && internalHigh.currentLevel !== swingHigh.currentLevel) {
      internalHigh.crossed = true
      internalTrend = 1
    }

    if (!Number.isFinite(internalLow.currentLevel)
      || !(bars[index].close < internalLow.currentLevel)
      || !(previousClose >= previousInternalLow)
      || internalLow.crossed
      || internalLow.currentLevel === swingLow.currentLevel) continue

    const tag = internalTrend === 1 ? "CHoCH" : "BOS"
    internalLow.crossed = true
    internalTrend = -1
    let origin = internalLow.index
    for (let scan = internalLow.index + 1; scan < index; scan++) {
      if (parsedHighs[scan] > parsedHighs[origin]) origin = scan
    }
    events.push({
      side: "SELL",
      structure: tag,
      originIndex: origin,
      confirmationIndex: index,
      originCandle: bars[origin].stamp,
      confirmationCandle: bars[index].stamp,
      confirmedAt: bars[index].minute === "15:25" ? `${bars[index].date} 15:30` : `${bars[index].date} ${String(Number(bars[index].minute.slice(0, 2)) + (bars[index].minute.slice(3) === "55" ? 1 : 0)).padStart(2, "0")}:${String((Number(bars[index].minute.slice(3)) + 5) % 60).padStart(2, "0")}`,
      zoneLow: parsedLows[origin],
      zoneHigh: parsedHighs[origin],
    })
  }
  return events.filter((event) => bars[event.confirmationIndex].date === date).slice(0, DISPLAY_COUNT)
}

function depthMinutes(symbol, fromClock) {
  const file = path.join(ROOT, "db", "cash-depth", date, symbol, `${symbol}.jsonl`)
  const snapshots = readJsonLines(file).flatMap((snapshot) => {
    const clock = receivedClock(snapshot.receivedAt)
    if (clock.slice(0, 5) < fromClock || clock.slice(0, 5) >= CUTOFF || !snapshot.data) return []
    const bid = [1, 2, 3, 4, 5].reduce((total, level) => total + Number(snapshot.data[`bid_size${level}`] || 0), 0)
    const ask = [1, 2, 3, 4, 5].reduce((total, level) => total + Number(snapshot.data[`ask_size${level}`] || 0), 0)
    const price = Number(snapshot.marketContext?.price)
    return Number.isFinite(price) && bid + ask > 0 ? [{ clock, minute: clock.slice(0, 5), bid, ask, price }] : []
  })
  const byMinute = new Map()
  for (const snapshot of snapshots) {
    const list = byMinute.get(snapshot.minute) ?? []
    list.push(snapshot)
    byMinute.set(snapshot.minute, list)
  }
  return [...byMinute.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([minute, values]) => {
    const askDominant = values.filter((value) => value.ask > value.bid).length / values.length
    return {
      minute,
      snapshots: values.length,
      askDominantSnapshotShare: askDominant,
      priceStart: values[0].price,
      priceEnd: values.at(-1).price,
      qualifies: askDominant >= MIN_ASK_DOMINANT_SNAPSHOT_SHARE && values.at(-1).price < values[0].price,
    }
  })
}

function nextMinute(clock) {
  const [hours, minutes] = clock.split(":").map(Number)
  const total = hours * 60 + minutes + 1
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`
}

function areConsecutiveMinutes(first, second) {
  return nextMinute(first) === second
}

function minuteDistance(first, second) {
  const [firstHour, firstMinute] = first.split(":").map(Number)
  const [secondHour, secondMinute] = second.split(":").map(Number)
  return secondHour * 60 + secondMinute - (firstHour * 60 + firstMinute)
}

function candleConfirmations(symbol, blocks, candles) {
  const output = []
  for (const block of blocks.filter(item => item.originCandle.startsWith(date))) {
    const anchor = CANDLE_ANCHOR === "origin" ? block.originCandle.slice(11) : block.confirmedAt.slice(11)
    const anchorIndex = candles.findIndex(candle => candle.minute === anchor)
    if (anchorIndex < 0) continue
    const search = candles.slice(anchorIndex, anchorIndex + 16)
    let match = null
    for (let index = 1; index < search.length; index++) {
      const first = search[index - 1], second = search[index]
      if (!areConsecutiveMinutes(first.minute, second.minute)) continue
      const closeLocation = (second.close - second.low) / (second.high - second.low || 1)
      if (first.close < first.open && second.close < second.open && second.close < first.low && closeLocation <= 0.2) {
        match = { first, second, closeLocation }
        break
      }
    }
    if (!match) continue
    const signalAt = nextMinute(match.second.minute)
    const entryAt = nextMinute(signalAt)
    const entryCandle = candles.find(candle => candle.minute === signalAt)
    const entryIndex = candles.indexOf(entryCandle)
    const forward = entryIndex >= 0 ? candles.slice(entryIndex + 1, entryIndex + 16) : []
    const entryPrice = entryCandle?.close
    const exitPrice = forward.at(-1)?.close
    output.push({
      symbol, side: "SELL", blockOrigin: block.originCandle.slice(11), blockConfirmedAt: block.confirmedAt.slice(11), candleAnchor: CANDLE_ANCHOR,
      confirmationCandles: `${match.first.minute}-${match.second.minute}`,
      signalAt, entryAt, entryPrice,
      secondCloseLocationPct: 100 * match.closeLocation,
      secondVsFirstVolumePct: 100 * (match.second.volume / match.first.volume - 1),
      return15Pct: Number.isFinite(entryPrice) && Number.isFinite(exitPrice) ? 100 * (entryPrice - exitPrice) / entryPrice : null,
      mae15Pct: Number.isFinite(entryPrice) && forward.length ? Math.min(0, 100 * (entryPrice - Math.max(...forward.map(candle => candle.high))) / entryPrice) : null,
      retrospectiveAnchor: CANDLE_ANCHOR === "origin" && anchor < block.confirmedAt.slice(11),
    })
  }
  return [...new Map(output.map(item => [`${item.symbol}-${item.signalAt}`, item])).values()]
}

async function signalsForSymbol(symbol, client) {
  let refreshedCandles = []
  let refreshError = null
  try { refreshedCandles = await fetchFyersCandles(client, symbol) }
  catch (error) { refreshError = error.message }
  const bars = fiveMinuteBars(symbol, refreshedCandles)
  if (!bars.length) return { symbol, error: "No completed one-minute candles" }
  const bearishBlocks = bearishInternalOrderBlocks(bars)
  const candleSignals = candleConfirmations(symbol, bearishBlocks, oneMinuteCandles(symbol, refreshedCandles))
  const signals = []
  for (const block of bearishBlocks) {
    const confirmationClock = block.confirmedAt.slice(11)
    const minutes = depthMinutes(symbol, confirmationClock)
    const qualifyingPair = minutes.find((minute, index) => index > 0
      && areConsecutiveMinutes(minutes[index - 1].minute, minute.minute)
      && minuteDistance(confirmationClock, minutes[index - 1].minute) <= MAX_FIRST_DEPTH_CONFIRMATION_DELAY_MINUTES
      && minutes[index - 1].qualifies
      && minute.qualifies)
    if (!qualifyingPair) continue
    const prior = minutes[minutes.indexOf(qualifyingPair) - 1]
    signals.push({
      ...block,
      depthConfirmation: [prior, qualifyingPair],
      signalAt: nextMinute(qualifyingPair.minute),
      nextCompletedOneMinuteEntryAt: nextMinute(nextMinute(qualifyingPair.minute)),
    })
  }
  return { symbol, fyersRefresh: client ? (refreshError ? `failed: ${refreshError}` : `ok: ${refreshedCandles.length} candles`) : "disabled", bearishInternalOrderBlocks: bearishBlocks, candleSignals, signals }
}

const client = REFRESH_FYERS ? fyersClient() : null
const results = []
for (const symbol of requestedSymbols) results.push(await signalsForSymbol(symbol, client))
const allCandleSignals = results.flatMap(item => item.candleSignals || [])
const completedCandleSignals = allCandleSignals.filter(item => Number.isFinite(item.return15Pct))
const firstCandleSignalBySymbol = new Map()
for (const item of allCandleSignals) if (!firstCandleSignalBySymbol.has(item.symbol)) firstCandleSignalBySymbol.set(item.symbol, item)
const firstCandleSignals = [...firstCandleSignalBySymbol.values()]
const firstCompletedCandleSignals = firstCandleSignals.filter(item => Number.isFinite(item.return15Pct))
const candleStats = rows => ({
  tradeCount: rows.length,
  winRatePct: rows.length ? 100 * rows.filter(item => item.return15Pct > 0).length / rows.length : null,
  averageReturnPct: rows.length ? rows.reduce((sum, item) => sum + item.return15Pct, 0) / rows.length : null,
  totalReturnPct: rows.reduce((sum, item) => sum + item.return15Pct, 0),
  maximumAdverseExcursionPct: rows.length ? Math.min(...rows.map(item => item.mae15Pct)) : null,
  worstDay: rows.length ? { date, totalReturnPct: rows.reduce((sum, item) => sum + item.return15Pct, 0) } : null,
})

const result = {
  date,
  cutoff: `${CUTOFF} IST (exclusive; only completed data before this time is used)`,
  timeframe: "5 minutes",
  timezone: "Asia/Kolkata",
  algorithm: {
    name: "Causal internal order block with depth confirmation",
    internalPivotBars: INTERNAL_PIVOT_BARS,
    displayCount: DISPLAY_COUNT,
    orderBlockFilter: ORDER_BLOCK_FILTER === "range" ? "Cumulative Mean Range" : "ATR(200)",
    maxFirstDepthConfirmationDelayMinutes: MAX_FIRST_DEPTH_CONFIRMATION_DELAY_MINUTES,
    depthRule: `${REQUIRED_DEPTH_MINUTES} consecutive completed one-minute windows; each needs ask dominance in at least ${(MIN_ASK_DOMINANT_SNAPSHOT_SHARE * 100).toFixed(0)}% of five-level snapshots and lower end price.`,
    entryRule: "Enter only on the next completed one-minute candle after the depth signal.",
  },
  candleSource: REFRESH_FYERS ? "Local history merged in memory with current FYERS History API candles" : "Local candle files only",
  candleConfirmationSummary: {
    allSignals: candleStats(completedCandleSignals),
    firstSignalPerStock: candleStats(firstCompletedCandleSignals),
    stocksWithSignal: firstCandleSignals.length,
    stocksWithoutSignal: results.filter(item => !item.candleSignals?.length).map(item => item.symbol),
  },
  results,
}

if (SUMMARY_OUTPUT) {
  console.log(JSON.stringify({
    date, cutoff: CUTOFF,
    summary: result.candleConfirmationSummary,
    firstSignals: firstCandleSignals.map(item => ({ stock: item.symbol, side: item.side, signalTime: item.signalAt, entryTime: item.entryAt, return15Pct: item.return15Pct, mae15Pct: item.mae15Pct, blockOrigin: item.blockOrigin, blockConfirmedAt: item.blockConfirmedAt })),
  }, null, 2))
} else if (TABLE_OUTPUT) {
  const rows = result.results.flatMap((item) => (CANDLE_CONFIRMATION ? item.candleSignals : item.signals).map((signal) => ({
    Stock: item.symbol,
    Side: signal.side,
    "Signal Time": signal.signalAt,
  })))
  if (rows.length) console.table(rows)
  else console.log("No qualified signals.")
} else {
  console.log(JSON.stringify(result, null, 2))
}
