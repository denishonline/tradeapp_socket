import fs from "node:fs"
import path from "node:path"
import readline from "node:readline"

const ROOT = process.cwd()
const MINUTE = 60_000
const IST_OFFSET = 330 * MINUTE
const RULE = Object.freeze({
  emaLookbackMinutes: 10,
  depthLookbackMinutes: 5,
  minimumEma5DownTurnDeg: 15,
  minimumEma10DownTurnDeg: 10,
  minimumDepthUpdates: 10,
  minimumDepthSpanSeconds: 45,
  maximumDepthGapSeconds: 15,
})

function options(argv) {
  const result = { date: null, symbol: null }
  for (let index = 0; index < argv.length; index++) {
    const value = argv[index]
    if (value === "--date") result.date = argv[++index]
    else if (value.startsWith("--date=")) result.date = value.slice(7)
    else if (value === "--symbol") result.symbol = argv[++index]
    else if (value.startsWith("--symbol=")) result.symbol = value.slice(9)
    else throw new Error(`Unknown option: ${value}`)
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(result.date || "")) {
    throw new Error("Usage: node scripts/replay-ema-turn-depth-breakdown.js --date YYYY-MM-DD [--symbol SYMBOL]")
  }
  if (result.symbol) result.symbol = result.symbol.toUpperCase().replace(/-EQ$/, "")
  return result
}

const mean = (values) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : NaN
const sum = (values) => values.reduce((total, value) => total + value, 0)
const pct = (value, base) => base > 0 ? (value / base - 1) * 100 : NaN
const round = (value, digits = 4) => Number.isFinite(value) ? Number(value.toFixed(digits)) : null
const indiaDate = (at) => new Date(at + IST_OFFSET).toISOString().slice(0, 10)
const indiaTime = (at) => new Date(at + IST_OFFSET).toISOString().slice(11, 19)

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

function loadCandles(symbol, date) {
  const filename = path.join(ROOT, "db", "candles", `${symbol}.jsonl`)
  if (!fs.existsSync(filename)) return []
  const rows = fs.readFileSync(filename, "utf8").split(/\r?\n/).flatMap((line) => {
    if (!line.trim()) return []
    try {
      const value = JSON.parse(line)
      if (value.partial) return []
      const row = { at: Number(value.time) * 1000, open: Number(value.open), high: Number(value.high),
        low: Number(value.low), close: Number(value.close), volume: Number(value.volume) }
      return Object.values(row).every(Number.isFinite) && row.close > 0 ? [row] : []
    } catch { return [] }
  }).sort((left, right) => left.at - right.at)

  let ema5 = null, ema10 = null
  for (const row of rows) {
    const previousEma5 = ema5, previousEma10 = ema10
    ema5 = ema5 == null ? row.close : row.close * 2 / 6 + ema5 * 4 / 6
    ema10 = ema10 == null ? row.close : row.close * 2 / 11 + ema10 * 9 / 11
    row.ema5 = ema5; row.ema10 = ema10
    row.ema5HeadingDeg = previousEma5 > 0
      ? Math.atan(pct(ema5, previousEma5)) * 180 / Math.PI : NaN
    row.ema10HeadingDeg = previousEma10 > 0
      ? Math.atan(pct(ema10, previousEma10)) * 180 / Math.PI : NaN
    row.bearishCross = previousEma5 >= previousEma10 && ema5 < ema10
  }
  return rows.filter((row) => indiaDate(row.at) === date)
}

function completeBook(fields) {
  let bidSize = 0, askSize = 0
  for (let level = 1; level <= 5; level++) {
    const bidPrice = Number(fields[`bid_price${level}`]), askPrice = Number(fields[`ask_price${level}`])
    const currentBid = Number(fields[`bid_size${level}`]), currentAsk = Number(fields[`ask_size${level}`])
    if (![bidPrice, askPrice, currentBid, currentAsk].every(Number.isFinite) ||
        bidPrice <= 0 || askPrice <= bidPrice || currentBid < 0 || currentAsk < 0) return null
    bidSize += currentBid; askSize += currentAsk
  }
  return { bid: Number(fields.bid_price1), ask: Number(fields.ask_price1),
    bid1: Number(fields.bid_size1), ask1: Number(fields.ask_size1),
    bidShare: bidSize / (bidSize + askSize || 1) }
}

async function loadDepthMinutes(symbol, date) {
  const filename = path.join(ROOT, "db", "cash-depth", date, symbol, `${symbol}.jsonl`)
  if (!fs.existsSync(filename)) return new Map()
  const fields = {}, buckets = new Map()
  let previous = null, lastTradeDirection = 0
  for await (const record of records(filename)) {
    const at = Date.parse(record.receivedAt)
    if (!Number.isFinite(at) || indiaDate(at) !== date) continue
    if (previous && at - previous.at > 90_000) {
      previous = null; lastTradeDirection = 0
      for (const key of Object.keys(fields)) delete fields[key]
    }
    if (record.kind === "checkpoint" || record.book) {
      for (const key of Object.keys(fields)) delete fields[key]
      Object.assign(fields, record.data)
    } else if (record.kind === "update") Object.assign(fields, record.data)
    else continue
    const book = completeBook(fields)
    const price = Number(record.marketContext?.price)
    const cumulativeVolume = Number(record.marketContext?.cumulativeVolume)
    if (!book || !(price > 0) || !Number.isFinite(cumulativeVolume)) continue
    let ofi = 0, traded = 0, signed = 0
    if (previous) {
      let rawOfi = book.bid > previous.bid ? book.bid1
        : book.bid === previous.bid ? book.bid1 - previous.bid1 : -previous.bid1
      rawOfi -= book.ask < previous.ask ? book.ask1
        : book.ask === previous.ask ? book.ask1 - previous.ask1 : -previous.ask1
      ofi = rawOfi / ((book.bid1 + book.ask1 + previous.bid1 + previous.ask1) / 2 || 1)
      traded = cumulativeVolume >= previous.cumulativeVolume ? cumulativeVolume - previous.cumulativeVolume : 0
      if (price > previous.price) lastTradeDirection = 1
      else if (price < previous.price) lastTradeDirection = -1
      signed = traded * lastTradeDirection
    }
    const minute = Math.floor(at / MINUTE) * MINUTE
    const bucket = buckets.get(minute) || { minute, rows: [] }
    bucket.rows.push({ at, bidShare: book.bidShare, ofi, traded, signed })
    buckets.set(minute, bucket)
    previous = { at, price, cumulativeVolume, ...book }
  }

  for (const bucket of buckets.values()) {
    const rows = bucket.rows
    const gaps = rows.slice(1).map((row, index) => (row.at - rows[index].at) / 1000)
    const quarter = Math.max(1, Math.ceil(rows.length / 4))
    const traded = sum(rows.map((row) => row.traded))
    bucket.updates = rows.length
    bucket.spanSeconds = (rows.at(-1).at - rows[0].at) / 1000
    bucket.maximumGapSeconds = gaps.length ? Math.max(...gaps) : Infinity
    bucket.firstQuarterBidShare = mean(rows.slice(0, quarter).map((row) => row.bidShare))
    bucket.lastQuarterBidShare = mean(rows.slice(-quarter).map((row) => row.bidShare))
    bucket.ofi = mean(rows.map((row) => row.ofi))
    bucket.delta = traded ? sum(rows.map((row) => row.signed)) / traded : 0
    delete bucket.rows
  }
  return buckets
}

function validTransition(depth) {
  return depth && depth.updates >= RULE.minimumDepthUpdates &&
    depth.spanSeconds >= RULE.minimumDepthSpanSeconds &&
    depth.maximumGapSeconds <= RULE.maximumDepthGapSeconds &&
    depth.firstQuarterBidShare > 0.5 && depth.lastQuarterBidShare < 0.5 &&
    depth.ofi < 0 && depth.delta < 0
}

function scan(symbol, candles, depthMinutes, audit) {
  const signals = []
  for (let index = 0; index < candles.length; index++) {
    const candle = candles[index]
    audit.candles++
    if (!candle.bearishCross) continue
    audit.bearishCrosses++
    const emaFrom = candle.at - RULE.emaLookbackMinutes * MINUTE
    const emaWindow = candles.filter((row) => row.at >= emaFrom && row.at <= candle.at)
    const ema5Peak = emaWindow.reduce((best, row) => row.ema5HeadingDeg > best.ema5HeadingDeg ? row : best, emaWindow[0])
    const ema10Peak = emaWindow.reduce((best, row) => row.ema10HeadingDeg > best.ema10HeadingDeg ? row : best, emaWindow[0])
    const ema5DownTurnDeg = ema5Peak.ema5HeadingDeg - candle.ema5HeadingDeg
    const ema10DownTurnDeg = ema10Peak.ema10HeadingDeg - candle.ema10HeadingDeg
    if (ema5DownTurnDeg > RULE.minimumEma5DownTurnDeg) audit.ema5TurnPassed++
    if (ema10DownTurnDeg > RULE.minimumEma10DownTurnDeg) audit.ema10TurnPassed++
    const depthFrom = candle.at - (RULE.depthLookbackMinutes - 1) * MINUTE
    const depthCandidates = [...depthMinutes.values()]
      .filter((depth) => depth.minute >= depthFrom && depth.minute <= candle.at && validTransition(depth))
      .sort((left, right) => right.minute - left.minute)
    if (depthCandidates.length) audit.depthTransitionNearCross++
    if (!(ema5DownTurnDeg > RULE.minimumEma5DownTurnDeg &&
          ema10DownTurnDeg > RULE.minimumEma10DownTurnDeg)) continue
    audit.turnQualified++
    if (!depthCandidates.length) continue
    audit.depthQualified++
    const depth = depthCandidates[0]
    signals.push({
      date: indiaDate(candle.at), symbol: `${symbol}-EQ`, crossoverCandle: indiaTime(candle.at).slice(0, 5),
      signalAt: indiaTime(candle.at + MINUTE).slice(0, 5), close: candle.close,
      ema5: round(candle.ema5), ema10: round(candle.ema10),
      ema5HeadingDeg: round(candle.ema5HeadingDeg, 2), ema10HeadingDeg: round(candle.ema10HeadingDeg, 2),
      ema5DownTurnDeg: round(ema5DownTurnDeg, 2), ema10DownTurnDeg: round(ema10DownTurnDeg, 2),
      ema5PeakTime: indiaTime(ema5Peak.at).slice(0, 5), ema10PeakTime: indiaTime(ema10Peak.at).slice(0, 5),
      depthTransitionMinute: indiaTime(depth.minute).slice(0, 5),
      firstQuarterBidPct: round(100 * depth.firstQuarterBidShare, 2),
      lastQuarterBidPct: round(100 * depth.lastQuarterBidShare, 2),
      ofi: round(depth.ofi, 4), deltaPct: round(100 * depth.delta, 2), depthUpdates: depth.updates,
    })
  }
  return signals
}

const cli = options(process.argv.slice(2))
const depthRoot = path.join(ROOT, "db", "cash-depth", cli.date)
const symbols = cli.symbol ? [cli.symbol] : fs.readdirSync(depthRoot, { withFileTypes: true })
  .filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort()
const audit = { candles: 0, bearishCrosses: 0, ema5TurnPassed: 0, ema10TurnPassed: 0,
  turnQualified: 0, depthTransitionNearCross: 0, depthQualified: 0 }
const signals = []
for (const symbol of symbols) {
  const candles = loadCandles(symbol, cli.date)
  if (!candles.length) continue
  const depth = await loadDepthMinutes(symbol, cli.date)
  signals.push(...scan(symbol, candles, depth, audit))
}
signals.sort((left, right) => left.signalAt.localeCompare(right.signalAt) || left.symbol.localeCompare(right.symbol))
const report = { date: cli.date, universe: symbols.length, rule: RULE,
  angleDefinition: "downward rotation = maximum prior EMA heading in rolling 10 clock minutes minus crossover-candle heading",
  chronology: "signal after bearish crossover candle closes; depth transition must occur in that candle or the preceding four completed minutes",
  audit, signals }
const output = path.join(ROOT, "csv", `${cli.date}-ema-turn-depth-breakdown.json`)
fs.writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`)
console.log(`EMA turn + depth breakdown | ${cli.date} | ${symbols.length} stock(s) | ${signals.length} signal(s)`)
console.table(audit)
console.table(signals)
console.log(`JSON: ${output}`)
