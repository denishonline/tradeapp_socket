import fs from "node:fs"
import path from "node:path"

const date = process.argv[2] || "2026-10-06"
const root = process.cwd()
const depthRoot = path.join(root, "db", "cash-depth", date)
const candleRoot = path.join(root, "db", "candles")
const windows = [30, 45, 60, 120]
const indiaDate = (seconds) => new Date(seconds * 1000 + 330 * 60_000).toISOString().slice(0, 10)
const time = (ms) => new Intl.DateTimeFormat("en-IN", {
  timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
}).format(new Date(ms))
const round = (value, places = 2) => Number.isFinite(value) ? Number(value.toFixed(places)) : null
const average = (rows, field) => rows.length ? rows.reduce((sum, row) => sum + row[field], 0) / rows.length : null
const median = (values) => {
  if (!values.length) return null
  const sorted = values.slice().sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]
}

function readCandles(symbol) {
  const file = path.join(candleRoot, `${symbol}.jsonl`)
  if (!fs.existsSync(file)) return []
  const rows = new Map()
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    if (!line) continue
    const row = JSON.parse(line)
    const time = Number(row.time)
    if (indiaDate(time) !== date) continue
    rows.set(time, { time, open: Number(row.open), high: Number(row.high), low: Number(row.low),
      close: Number(row.close), volume: Number(row.volume) })
  }
  return [...rows.values()].sort((a, b) => a.time - b.time)
}

function depthMetrics(symbol, direction, cutoff, windowMinutes) {
  const file = path.join(depthRoot, symbol, `${symbol}.jsonl`)
  if (!fs.existsSync(file)) return { ticks: 0 }
  const start = cutoff - windowMinutes * 60_000
  const ticks = []
  let previous = null
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    if (!line) continue
    const record = JSON.parse(line)
    const at = Date.parse(record.receivedAt)
    if (!Number.isFinite(at) || at >= cutoff) break
    const book = record.data || {}
    const bids = Array.from({ length: 5 }, (_, index) => Number(book[`bid_size${index + 1}`]))
    const asks = Array.from({ length: 5 }, (_, index) => Number(book[`ask_size${index + 1}`]))
    const bid = Number(book.bid_price1)
    const ask = Number(book.ask_price1)
    if (![...bids, ...asks, bid, ask].every(Number.isFinite) || bid <= 0 || ask <= bid) continue
    const bid1 = bids[0], ask1 = asks[0]
    const bidSum = bids.reduce((sum, value) => sum + value, 0)
    const askSum = asks.reduce((sum, value) => sum + value, 0)
    const bid2 = bids[0] + bids[1], ask2 = asks[0] + asks[1]
    const validPrevious = previous && at - previous.at <= 90_000 ? previous : null
    const ofi = validPrevious
      ? (bid >= validPrevious.bid ? bid1 : 0) - (bid <= validPrevious.bid ? validPrevious.bid1 : 0) -
        (ask <= validPrevious.ask ? ask1 : 0) + (ask >= validPrevious.ask ? validPrevious.ask1 : 0)
      : 0
    const ofiDepth = validPrevious ? (bid1 + ask1 + validPrevious.bid1 + validPrevious.ask1) / 2 : 0
    const row = { at, bid, ask, full: (bidSum - askSum) / (bidSum + askSum || 1),
      top2: (bid2 - ask2) / (bid2 + ask2 || 1), ofi, ofiDepth }
    if (at >= start) ticks.push(row)
    previous = { at, bid, ask, bid1, ask1 }
  }
  const minutes = new Map()
  for (const tick of ticks) {
    const minute = Math.floor(tick.at / 60_000)
    const bucket = minutes.get(minute) || { full: [], top2: [], bid: [], ask: [] }
    bucket.full.push(tick.full); bucket.top2.push(tick.top2); bucket.bid.push(tick.bid); bucket.ask.push(tick.ask)
    minutes.set(minute, bucket)
  }
  const minuteRows = [...minutes.entries()].sort((a, b) => a[0] - b[0]).map(([minute, bucket]) => ({
    minute, full: average(bucket.full.map((value) => ({ value })), "value"),
    top2: average(bucket.top2.map((value) => ({ value })), "value"),
    firstBid: bucket.bid[0], lastBid: bucket.bid.at(-1), firstAsk: bucket.ask[0], lastAsk: bucket.ask.at(-1),
  }))
  const totalOfi = ticks.reduce((sum, row) => sum + row.ofi, 0)
  const totalOfiDepth = ticks.reduce((sum, row) => sum + row.ofiDepth, 0)
  const sign = direction === "BUY" ? 1 : -1
  const first = minuteRows[0], last = minuteRows.at(-1)
  return {
    ticks: ticks.length, coveredMinutes: minuteRows.length,
    dirFull: round(sign * average(minuteRows, "full")),
    dirTop2: round(sign * average(minuteRows, "top2")),
    dirFlow: round(sign * totalOfi / (totalOfiDepth || 1)),
    supportiveFullMinutesPct: round(minuteRows.filter((row) => sign * row.full > 0).length / (minuteRows.length || 1) * 100, 0),
    supportiveTop2MinutesPct: round(minuteRows.filter((row) => sign * row.top2 > 0).length / (minuteRows.length || 1) * 100, 0),
    dirQuoteMovePct: round(sign * ((direction === "BUY" ? last?.lastBid / first?.firstBid :
      last?.lastAsk / first?.firstAsk) - 1) * 100, 3),
  }
}

function candleMetrics(rows, cutoff, windowMinutes, direction) {
  const endSeconds = Math.floor(cutoff / 1000)
  const startSeconds = endSeconds - windowMinutes * 60
  const bars = rows.filter((row) => row.time >= startSeconds && row.time < endSeconds)
  if (!bars.length) return { bars: 0 }
  const sign = direction === "BUY" ? 1 : -1
  let travel = 0
  for (let index = 1; index < bars.length; index++) travel += Math.abs(bars[index].close - bars[index - 1].close)
  const directionReturn = sign * (bars.at(-1).close / bars[0].open - 1) * 100
  const vols = bars.map((row) => row.volume)
  return {
    bars: bars.length, dirReturnPct: round(directionReturn),
    efficiency: round(Math.abs(bars.at(-1).close - bars[0].open) / (travel || 1), 3),
    volumeVsDayMedian: round(average(vols.map((value) => ({ value })), "value") /
      (median(rows.map((row) => row.volume)) || 1), 2),
    directionalGreenPct: round(bars.filter((row) => sign * (row.close - row.open) > 0).length / bars.length * 100, 0),
  }
}

const symbols = fs.readdirSync(depthRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory())
  .map((entry) => entry.name).sort()
const sessions = []
for (const symbol of symbols) {
  const rows = readCandles(symbol)
  if (rows.length < 2) continue
  const sessionOpen = rows[0].open
  const highest = rows.reduce((best, row) => row.high > best.high ? { high: row.high, time: row.time } : best,
    { high: -Infinity, time: rows[0].time })
  const lowest = rows.reduce((best, row) => row.low < best.low ? { low: row.low, time: row.time } : best,
    { low: Infinity, time: rows[0].time })
  const buyCross = rows.find((row) => row.close >= sessionOpen * 1.03)
  const sellCross = rows.find((row) => row.close <= sessionOpen * 0.97)
  const closeReturn = (rows.at(-1).close / sessionOpen - 1) * 100
  const highMove = (highest.high / sessionOpen - 1) * 100
  const lowMove = (lowest.low / sessionOpen - 1) * 100
  sessions.push({ symbol, rows, sessionOpen, closeReturn, highMove, lowMove, highest, lowest, buyCross, sellCross })
}

const buyMovers = sessions.filter((item) => item.highMove >= 3).sort((a, b) => b.highMove - a.highMove)
const sellMovers = sessions.filter((item) => item.lowMove <= -3).sort((a, b) => a.lowMove - b.lowMove)
console.log(`${date}: ${symbols.length} cash-depth symbols; ${buyMovers.length} had +3% intraday high and ${sellMovers.length} had -3% intraday low from session open.`)
console.log("Top BUY-side movers (intraday high from open); confirmed time is first 1m close +3% from open:")
console.table(buyMovers.slice(0, 15).map((item) => ({ symbol: item.symbol, open: item.sessionOpen,
  high: item.highest.high, highMovePct: round(item.highMove), highAt: time(item.highest.time * 1000),
  closeMovePct: round(item.closeReturn), confirmedAt: item.buyCross ? time((item.buyCross.time + 60) * 1000) : null })))
console.log("Top SELL-side movers (intraday low from open); confirmed time is first 1m close -3% from open:")
console.table(sellMovers.slice(0, 15).map((item) => ({ symbol: item.symbol, open: item.sessionOpen,
  low: item.lowest.low, lowMovePct: round(item.lowMove), lowAt: time(item.lowest.time * 1000),
  closeMovePct: round(item.closeReturn), confirmedAt: item.sellCross ? time((item.sellCross.time + 60) * 1000) : null })))

function eventOutcome(item, direction) {
  const cross = direction === "BUY" ? item.buyCross : item.sellCross
  if (!cross) return { symbol: item.symbol, side: direction, confirmedAt: null, outcome: "No close confirmation" }
  const entry = cross.close
  const stop = entry * (direction === "BUY" ? 0.995 : 1.005)
  const target = entry * (direction === "BUY" ? 1.03 : 0.97)
  const future = item.rows.filter((row) => row.time > cross.time)
  let resolution = null
  for (const row of future) {
    const stopHit = direction === "BUY" ? row.low <= stop : row.high >= stop
    const targetHit = direction === "BUY" ? row.high >= target : row.low <= target
    if (stopHit || targetHit) {
      resolution = { at: time(row.time * 1000), outcome: stopHit ? "Stopped" : "Target +3%" }
      break
    }
  }
  const maxFollowThrough = direction === "BUY"
    ? Math.max(0, ...future.map((row) => (row.high / entry - 1) * 100))
    : Math.max(0, ...future.map((row) => (entry / row.low - 1) * 100))
  return { symbol: item.symbol, side: direction, confirmedAt: time((cross.time + 60) * 1000),
    entry: round(entry, 2), outcome: resolution?.outcome || "Unresolved", resolvedAt: resolution?.at || null,
    maxFollowThroughPct: round(maxFollowThrough) }
}

console.log("First +3% breakout/breakdown close entries: next target +3%, stop -0.5% (same-bar ambiguity counted as stop):")
console.table([
  ...buyMovers.map((item) => eventOutcome(item, "BUY")),
  ...sellMovers.map((item) => eventOutcome(item, "SELL")),
])

function analyzeSide(items, side) {
  const direction = side === "BUY" ? "BUY" : "SELL"
  const sign = direction === "BUY" ? 1 : -1
  const output = []
  for (const item of items) {
    const cross = direction === "BUY" ? item.buyCross : item.sellCross
    const extremeTime = direction === "BUY" ? item.highest.time : item.lowest.time
    const cutoff = cross ? (cross.time + 1) * 1000 : (extremeTime + 1) * 1000
    for (const horizon of windows) {
      const candle = candleMetrics(item.rows, cutoff, horizon, direction)
      const depth = depthMetrics(item.symbol, direction, cutoff, horizon)
      output.push({ symbol: item.symbol, side: direction,
        time: cross ? time(cutoff) : `${time(cutoff)}*`, closeConfirmed3Pct: Boolean(cross), horizonMin: horizon,
        candleBars: candle.bars, candleDirReturnPct: candle.dirReturnPct, candleEfficiency: candle.efficiency,
        volumeVsDayMedian: candle.volumeVsDayMedian, directionalGreenPct: candle.directionalGreenPct,
        depthTicks: depth.ticks, depthMinutes: depth.coveredMinutes, bookFullDir: depth.dirFull,
        top2Dir: depth.dirTop2, quoteFlowDir: depth.dirFlow, supportiveFullMinPct: depth.supportiveFullMinutesPct,
        supportiveTop2MinPct: depth.supportiveTop2MinutesPct, quoteMoveDirPct: depth.dirQuoteMovePct,
        excursionFromOpenPct: round(sign * (direction === "BUY" ? item.highMove : item.lowMove)) })
    }
  }
  console.log(`\n${direction} pre-event depth/candle windows (top movers; * = intraday extreme only, no +3% close confirmation):`)
  console.table(output)
}

analyzeSide(buyMovers.slice(0, 10), "BUY")
analyzeSide(sellMovers.slice(0, 10), "SELL")
