import fs from "node:fs"
import path from "node:path"

const date = process.argv[2] || "2026-10-06"
const symbolArgs = process.argv.slice(3).filter((arg) => !arg.startsWith("--"))
const symbols = symbolArgs.length ? symbolArgs :
  ["PGEL", "TIINDIA", "POLICYBZR", "BHEL", "BLUESTARCO"]
const detailStart = process.argv.find((arg) => arg.startsWith("--start="))?.slice(8)
const detailEnd = process.argv.find((arg) => arg.startsWith("--end="))?.slice(6)
const showCandidates = process.argv.includes("--candidates")
const showScreen = process.argv.includes("--screen")
const showTicks = process.argv.includes("--ticks")
const comparePeriods = process.argv.find((arg) => arg.startsWith("--compare="))?.slice(10).split(",")
const showDepthShifts = process.argv.includes("--depth-shifts")
const showDepthStreaks = process.argv.includes("--depth-streaks")
const dateTime = (clock) => Date.parse(`${date}T${clock}:00+05:30`)
const root = process.cwd()
const indiaDate = (timestamp) => new Date(timestamp + 330 * 60_000).toISOString().slice(0, 10)
const time = (timestamp) => new Date(timestamp + 330 * 60_000).toISOString().slice(11, 16)
const timeSecond = (timestamp) => new Date(timestamp + 330 * 60_000).toISOString().slice(11, 23)
const round = (value, digits = 3) => Number.isFinite(value) ? Number(value.toFixed(digits)) : null
const mean = (items, key) => items.length ? items.reduce((sum, item) => sum + item[key], 0) / items.length : null
const pct = (last, first) => first > 0 ? (last / first - 1) * 100 : null

function readCandles(symbol) {
  const byTime = new Map()
  const file = path.join(root, "db", "candles", `${symbol}.jsonl`)
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    if (!line) continue
    const row = JSON.parse(line)
    const timestamp = Number(row.time) * 1000
    if (indiaDate(timestamp) !== date) continue
    byTime.set(timestamp, { timestamp, open: Number(row.open), high: Number(row.high), low: Number(row.low),
      close: Number(row.close), volume: Number(row.volume), source: row.source })
  }
  return [...byTime.values()].sort((a, b) => a.timestamp - b.timestamp)
}

function readDepth(symbol) {
  const file = path.join(root, "db", "cash-depth", date, symbol, `${symbol}.jsonl`)
  const rows = []
  let previous = null
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    if (!line) continue
    const record = JSON.parse(line)
    const timestamp = Date.parse(record.receivedAt)
    if (indiaDate(timestamp) !== date) continue
    const book = record.data
    const bid = Array.from({ length: 5 }, (_, index) => Number(book[`bid_size${index + 1}`]))
    const ask = Array.from({ length: 5 }, (_, index) => Number(book[`ask_size${index + 1}`]))
    const bestBid = Number(book.bid_price1)
    const bestAsk = Number(book.ask_price1)
    if (![...bid, ...ask, bestBid, bestAsk].every(Number.isFinite) || bestBid <= 0 || bestAsk <= bestBid) continue
    const bidSum = bid.reduce((sum, size) => sum + size, 0)
    const askSum = ask.reduce((sum, size) => sum + size, 0)
    const bid2 = bid[0] + bid[1]
    const ask2 = ask[0] + ask[1]
    const old = previous && timestamp - previous.timestamp <= 90_000 ? previous : null
    const ofi = old ? (bestBid >= old.bestBid ? bid[0] : 0) - (bestBid <= old.bestBid ? old.bid1 : 0) -
      (bestAsk <= old.bestAsk ? ask[0] : 0) + (bestAsk >= old.bestAsk ? old.ask1 : 0) : 0
    const ofiDepth = old ? (bid[0] + ask[0] + old.bid1 + old.ask1) / 2 : 0
    const cumulativeVolume = Number(record.marketContext?.cumulativeVolume)
    rows.push({ timestamp, bestBid, bestAsk, bid1: bid[0], ask1: ask[0], bidSum, askSum,
      full: (bidSum - askSum) / (bidSum + askSum || 1), top2: (bid2 - ask2) / (bid2 + ask2 || 1),
      ofi, ofiDepth, spreadBps: (bestAsk / bestBid - 1) * 10_000,
      price: Number(record.marketContext?.price), priceAt: Date.parse(record.marketContext?.priceAt),
      cumulativeVolume, volumeJump: previous && Number.isFinite(cumulativeVolume) &&
        Number.isFinite(previous.cumulativeVolume) ? Math.max(0, cumulativeVolume - previous.cumulativeVolume) : 0 })
    previous = { timestamp, bestBid, bestAsk, bid1: bid[0], ask1: ask[0], cumulativeVolume }
  }
  return rows
}

function minuteDepth(rows) {
  const grouped = new Map()
  for (const row of rows) {
    const minute = Math.floor(row.timestamp / 60_000) * 60_000
    if (!grouped.has(minute)) grouped.set(minute, [])
    grouped.get(minute).push(row)
  }
  return new Map([...grouped].map(([timestamp, items]) => [timestamp, {
    timestamp, updates: items.length, full: mean(items, "full"), top2: mean(items, "top2"),
    ofi: items.reduce((sum, row) => sum + row.ofi, 0) /
      (items.reduce((sum, row) => sum + row.ofiDepth, 0) || 1),
    positiveBothPct: items.filter((row) => row.full > 0 && row.top2 > 0).length / items.length * 100,
    spreadBps: mean(items, "spreadBps"), firstBid: items[0].bestBid, lastBid: items.at(-1).bestBid,
    firstAsk: items[0].bestAsk, lastAsk: items.at(-1).bestAsk,
    firstVolume: items[0].cumulativeVolume, lastVolume: items.at(-1).cumulativeVolume,
    maxVolumeJump: Math.max(...items.map((row) => row.volumeJump)),
  }]))
}

function bestLegs(candles, horizonMinutes, count = 4) {
  const candidates = []
  for (const start of candles) {
    const future = candles.filter((row) => row.timestamp > start.timestamp &&
      row.timestamp <= start.timestamp + horizonMinutes * 60_000)
    if (!future.length) continue
    const peak = future.reduce((best, row) => row.high > best.high ? row : best)
    candidates.push({ start: start.timestamp, end: peak.timestamp, entry: start.close, high: peak.high,
      gainPct: pct(peak.high, start.close) })
  }
  candidates.sort((a, b) => b.gainPct - a.gainPct)
  const selected = []
  for (const candidate of candidates) {
    if (selected.some((row) => Math.abs(row.start - candidate.start) < 15 * 60_000)) continue
    selected.push(candidate)
    if (selected.length === count) break
  }
  return selected.map((row) => ({ from: time(row.start), to: time(row.end), entry: row.entry,
    high: row.high, gainPct: round(row.gainPct) }))
}

const candidateTimes = {
  PGEL: ["09:18", "09:29", "09:31", "11:15", "11:21"],
  TIINDIA: ["09:17", "09:34", "10:55", "11:08"],
  POLICYBZR: ["09:17", "09:24", "11:15", "11:19", "11:20"],
  BHEL: ["09:18", "09:24", "09:29"],
  BLUESTARCO: ["09:17", "09:22", "09:25"],
}

for (const symbol of symbols) {
  const candles = readCandles(symbol)
  const depth = readDepth(symbol)
  const minutes = minuteDepth(depth)
  const volumeMedian = candles.map((row) => row.volume).sort((a, b) => a - b)[Math.floor(candles.length / 2)]
  console.log(`\n${symbol} ${date} | ${candles.length} candles ${time(candles[0].timestamp)}–${time(candles.at(-1).timestamp)} | ${depth.length} depth ticks ${time(depth[0].timestamp)}–${time(depth.at(-1).timestamp)}`)
  if (comparePeriods) {
    console.table(comparePeriods.map((period) => {
      const [start, end] = period.split("-")
      const startAt = dateTime(start)
      const endAt = dateTime(end)
      const ticks = depth.filter((row) => row.timestamp >= startAt && row.timestamp < endAt)
      const bars = candles.filter((row) => row.timestamp >= startAt && row.timestamp < endAt)
      const minuteRows = [...minutes.values()].filter((row) => row.timestamp >= startAt && row.timestamp < endAt)
      const totalOfiDepth = ticks.reduce((sum, row) => sum + row.ofiDepth, 0)
      return {
        period, depthTicks: ticks.length,
        fullImbalance: round(mean(ticks, "full")), top2Imbalance: round(mean(ticks, "top2")),
        bothPositivePct: round(ticks.filter((row) => row.full > 0 && row.top2 > 0).length / ticks.length * 100, 1),
        positiveFullMinutes: `${minuteRows.filter((row) => row.full > 0).length}/${minuteRows.length}`,
        normalizedOfi: round(ticks.reduce((sum, row) => sum + row.ofi, 0) / (totalOfiDepth || 1)),
        firstBid: ticks[0]?.bestBid, lastBid: ticks.at(-1)?.bestBid,
        open: bars[0]?.open, close: bars.at(-1)?.close,
        returnPct: round(pct(bars.at(-1)?.close, bars[0]?.open)),
        low: bars.length ? Math.min(...bars.map((row) => row.low)) : null,
        high: bars.length ? Math.max(...bars.map((row) => row.high)) : null,
        candleVolume: bars.reduce((sum, row) => sum + row.volume, 0),
      }
    }))
    continue
  }
  if (showDepthShifts) {
    const startAt = dateTime(detailStart || "09:30")
    const endAt = dateTime(detailEnd || "12:40")
    const rows = []
    for (let endMinute = Math.floor(startAt / 60_000) + 7;
      endMinute < Math.floor(endAt / 60_000); endMinute++) {
      const recent = [endMinute - 2, endMinute - 1, endMinute]
        .map((minute) => minutes.get(minute * 60_000))
      const prior = Array.from({ length: 5 }, (_, index) => endMinute - 7 + index)
        .map((minute) => minutes.get(minute * 60_000))
      if ([...recent, ...prior].some((row) => !row)) continue
      const recentFull = mean(recent, "full")
      const recentTop2 = mean(recent, "top2")
      const recentOfi = mean(recent, "ofi")
      const recentBoth = mean(recent, "positiveBothPct")
      const priorFull = mean(prior, "full")
      const priorTop2 = mean(prior, "top2")
      const priorOfi = mean(prior, "ofi")
      const bidBps = (recent.at(-1).lastBid / recent[0].firstBid - 1) * 10_000
      const volumeIncrease = recent.at(-1).lastVolume - recent[0].firstVolume
      const shiftScore = Number(recentFull - priorFull >= 0.2) +
        Number(recentTop2 - priorTop2 >= 0.2) + Number(priorOfi < 0 && recentOfi > 0) +
        Number(bidBps > 0 && volumeIncrease > 0)
      const strengthScore = Number(recentFull >= 0.6) + Number(recentTop2 >= 0.4) +
        Number(recentOfi >= 0.1) + Number(recentBoth >= 70) + Number(bidBps > 0)
      if (shiftScore < 3 && strengthScore < 4) continue
      rows.push({ ending: time(endMinute * 60_000), shiftScore, strengthScore,
        full3: round(recentFull), top2_3: round(recentTop2), ofi3: round(recentOfi),
        bothPositivePct: round(recentBoth, 1), fullChange: round(recentFull - priorFull),
        top2Change: round(recentTop2 - priorTop2), priorOfi: round(priorOfi),
        bidMoveBps: round(bidBps, 1), volumeIncrease })
    }
    console.table(rows)
    continue
  }
  if (showDepthStreaks) {
    const startAt = dateTime(detailStart || "09:30")
    const endAt = dateTime(detailEnd || "12:46")
    const minuteRows = [...minutes.values()].filter((row) =>
      row.timestamp >= startAt && row.timestamp < endAt).sort((a, b) => a.timestamp - b.timestamp)
    const streaks = []
    for (const [name, qualifies] of [
      ["full positive", (row) => row.full > 0],
      ["full >= +0.15", (row) => row.full >= 0.15],
      ["full and top2 positive", (row) => row.full > 0 && row.top2 > 0],
    ]) {
      let current = []
      const finish = () => {
        if (current.length) streaks.push({ condition: name, minutes: current.length,
          from: time(current[0].timestamp), to: time(current.at(-1).timestamp),
          averageFull: round(mean(current, "full")), averageTop2: round(mean(current, "top2")),
          averageOfi: round(mean(current, "ofi")) })
        current = []
      }
      for (const row of minuteRows) {
        if (qualifies(row) && (!current.length || row.timestamp === current.at(-1).timestamp + 60_000)) current.push(row)
        else { finish(); if (qualifies(row)) current.push(row) }
      }
      finish()
    }
    console.table(streaks.sort((a, b) => b.minutes - a.minutes).slice(0, 12))
    continue
  }
  if (detailStart && detailEnd) {
    if (showTicks) {
      console.table(depth.filter((row) => row.timestamp >= dateTime(detailStart) &&
        row.timestamp < dateTime(detailEnd)).map((row) => ({
        at: timeSecond(row.timestamp), bid: row.bestBid, ask: row.bestAsk,
        bid1: row.bid1, ask1: row.ask1, bids5: row.bidSum, asks5: row.askSum,
        full: round(row.full), top2: round(row.top2),
        ofi: row.ofi, volume: row.cumulativeVolume, volumeJump: row.volumeJump,
        marketPrice: row.price,
      })))
      continue
    }
    const rows = []
    for (let timestamp = dateTime(detailStart); timestamp < dateTime(detailEnd); timestamp += 60_000) {
      const candle = candles.find((row) => row.timestamp === timestamp)
      const book = minutes.get(timestamp)
      rows.push({ minute: time(timestamp), open: candle?.open, close: candle?.close,
        high: candle?.high, low: candle?.low, volume: candle?.volume,
        updates: book?.updates, full: round(book?.full), top2: round(book?.top2),
        ofi: round(book?.ofi), positiveBothPct: round(book?.positiveBothPct, 0),
        spreadBps: round(book?.spreadBps, 1), firstBid: book?.firstBid, lastBid: book?.lastBid,
        maxVolumeJump: book?.maxVolumeJump })
    }
    console.table(rows)
    continue
  }
  if (showCandidates) {
    const rows = []
    for (const clock of candidateTimes[symbol] || []) {
      const timestamp = dateTime(clock)
      const candle = candles.find((row) => row.timestamp === timestamp)
      if (!candle) continue
      const book = minutes.get(timestamp)
      const future = candles.filter((row) => row.timestamp > timestamp)
      const target = candle.close * 1.015
      const stop = candle.close * 0.995
      const resolved = future.find((row) => row.low <= stop || row.high >= target)
      const observed = resolved ? future.filter((row) => row.timestamp <= resolved.timestamp) : future
      const peak = Math.max(...observed.map((row) => row.high))
      const trough = Math.min(...observed.map((row) => row.low))
      rows.push({ setup: clock, visibleAt: time(timestamp + 60_000), entry: candle.close,
        volume: candle.volume, full: round(book?.full), top2: round(book?.top2), ofi: round(book?.ofi),
        status: resolved ? resolved.low <= stop ? "Stopped" : "Target reached" : "Unresolved",
        resolvedAt: resolved ? time(resolved.timestamp) : null,
        highUntilResolutionPct: round(pct(peak, candle.close)),
        lowUntilResolutionPct: round(pct(trough, candle.close)),
      })
    }
    console.table(rows)
    continue
  }
  if (showScreen) {
    const matches = []
    for (const candle of candles) {
      if (candle.timestamp < dateTime("09:23") || candle.close <= candle.open) continue
      const book = minutes.get(candle.timestamp)
      if (!book || book.updates < 10 || book.full < 0.25 || book.top2 < 0.1 || book.ofi < -0.02) continue
      const future = candles.filter((row) => row.timestamp > candle.timestamp)
      const target = candle.close * 1.015
      const stop = candle.close * 0.995
      const resolved = future.find((row) => row.low <= stop || row.high >= target)
      matches.push({ at: time(candle.timestamp + 60_000), entry: candle.close,
        full: round(book.full), top2: round(book.top2), ofi: round(book.ofi),
        outcome: resolved ? resolved.low <= stop ? "Stopped" : "Target" : "Unresolved",
        outcomeAt: resolved ? time(resolved.timestamp) : null })
    }
    console.log(`Simple green candle + bid depth + nonnegative-ish OFI screen: ${matches.length} matches`)
    console.log(Object.fromEntries(["Target", "Stopped", "Unresolved"].map((status) =>
      [status, matches.filter((row) => row.outcome === status).length])))
    console.table(matches.slice(0, 15))
    continue
  }
  console.table([{ open: candles[0].open, last: candles.at(-1).close, returnPct: round(pct(candles.at(-1).close, candles[0].open)),
    low: Math.min(...candles.map((row) => row.low)), high: Math.max(...candles.map((row) => row.high)),
    medianCandleVolume: volumeMedian, meanDepthFull: round(mean([...minutes.values()], "full")),
    meanDepthTop2: round(mean([...minutes.values()], "top2")) }])
  console.log("Best forward 30-minute price legs (future high, descriptive only):")
  console.table(bestLegs(candles, 30))
  console.log("Best forward 60-minute price legs (future high, descriptive only):")
  console.table(bestLegs(candles, 60))
  console.log("Largest one-minute volume candles:")
  console.table(candles.slice().sort((a, b) => b.volume - a.volume).slice(0, 8).map((row) => ({
    minute: time(row.timestamp), open: row.open, close: row.close, high: row.high, low: row.low,
    volume: row.volume, multipleOfMedian: round(row.volume / (volumeMedian || 1), 1),
    depthFull: round(minutes.get(row.timestamp)?.full), depthTop2: round(minutes.get(row.timestamp)?.top2),
    depthOfi: round(minutes.get(row.timestamp)?.ofi),
  })))
}
