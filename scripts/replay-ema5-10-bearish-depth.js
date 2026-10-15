import fs from "node:fs"
import path from "node:path"
import readline from "node:readline"

const ROOT = process.cwd()
const MINUTE = 60_000
const IST_OFFSET = 330 * MINUTE
const RULE = Object.freeze({
  minimumBearishDistancePct: 0.40,
  maximumEma5HeadingDeg: -40,
  maximumEma10HeadingDeg: -20,
  maximumFullImbalance: -0.40,
  maximumTop2Imbalance: -0.40,
  maximumBidDominantFraction: 0.25,
  minimumBearishConfirmations: 3,
  maximumOfi: 0,
  maximumDelta: -0.10,
  maximumDepthPriceReturnPct: 0,
  minimumDepthUpdates: 10,
  minimumDepthSpanSeconds: 45,
  maximumDepthGapSeconds: 15,
  maximumExecutionLatencySeconds: 15,
})

function commandLine(argv) {
  const result = { date: null, symbol: null, output: null }
  for (let index = 0; index < argv.length; index++) {
    const value = argv[index]
    if (value === "--date") result.date = argv[++index]
    else if (value.startsWith("--date=")) result.date = value.slice(7)
    else if (value === "--symbol") result.symbol = argv[++index]
    else if (value.startsWith("--symbol=")) result.symbol = value.slice(9)
    else if (value === "--output") result.output = argv[++index]
    else if (value.startsWith("--output=")) result.output = value.slice(9)
    else if (value === "--help" || value === "-h") result.help = true
    else throw new Error(`Unknown option: ${value}`)
  }
  return result
}

function usage() {
  return [
    "Usage:",
    "  node scripts/replay-ema5-10-bearish-depth.js --date 2026-10-14",
    "  node scripts/replay-ema5-10-bearish-depth.js --date 2026-10-14 --symbol CANBK",
  ].join("\n")
}

const mean = (values) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : NaN
const sum = (values) => values.reduce((total, value) => total + value, 0)
const pct = (value, base) => base > 0 ? (value / base - 1) * 100 : NaN
const round = (value, digits = 4) => Number.isFinite(value) ? Number(value.toFixed(digits)) : null
const indiaDate = (at) => new Date(at + IST_OFFSET).toISOString().slice(0, 10)
const indiaTime = (at) => new Date(at + IST_OFFSET).toISOString().slice(11, 19)
const dateTime = (at) => `${indiaDate(at)} ${indiaTime(at)}`

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

function lowerBound(rows, at) {
  let low = 0, high = rows.length
  while (low < high) {
    const middle = (low + high) >>> 1
    if (rows[middle].at < at) low = middle + 1
    else high = middle
  }
  return low
}

function completeBook(fields) {
  let bidSize = 0, askSize = 0, bidTop2 = 0, askTop2 = 0
  for (let level = 1; level <= 5; level++) {
    const bidPrice = Number(fields[`bid_price${level}`])
    const askPrice = Number(fields[`ask_price${level}`])
    const currentBid = Number(fields[`bid_size${level}`])
    const currentAsk = Number(fields[`ask_size${level}`])
    if (![bidPrice, askPrice, currentBid, currentAsk].every(Number.isFinite) ||
        bidPrice <= 0 || askPrice <= bidPrice || currentBid < 0 || currentAsk < 0) return null
    bidSize += currentBid; askSize += currentAsk
    if (level <= 2) { bidTop2 += currentBid; askTop2 += currentAsk }
  }
  const bid = Number(fields.bid_price1), ask = Number(fields.ask_price1)
  return { bid, ask, bid1: Number(fields.bid_size1), ask1: Number(fields.ask_size1),
    mid: (bid + ask) / 2,
    full: (bidSize - askSize) / (bidSize + askSize || 1),
    top2: (bidTop2 - askTop2) / (bidTop2 + askTop2 || 1) }
}

function loadCandles(symbol, date) {
  const filename = path.join(ROOT, "db", "candles", `${symbol}.jsonl`)
  if (!fs.existsSync(filename)) return []
  const rows = fs.readFileSync(filename, "utf8").split(/\r?\n/).flatMap((line) => {
    if (!line.trim()) return []
    try {
      const value = JSON.parse(line)
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
    row.distancePct = 100 * (ema10 - ema5) / ema10
    row.ema5HeadingDeg = previousEma5 > 0
      ? Math.atan(pct(ema5, previousEma5)) * 180 / Math.PI : NaN
    row.ema10HeadingDeg = previousEma10 > 0
      ? Math.atan(pct(ema10, previousEma10)) * 180 / Math.PI : NaN
    row.bullishCross = previousEma5 <= previousEma10 && ema5 > ema10
  }
  return rows.filter((row) => indiaDate(row.at) === date)
}

async function loadDepth(symbol, date) {
  const filename = path.join(ROOT, "db", "cash-depth", date, symbol, `${symbol}.jsonl`)
  if (!fs.existsSync(filename)) return []
  const samples = [], fields = {}
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
      traded = cumulativeVolume >= previous.cumulativeVolume
        ? cumulativeVolume - previous.cumulativeVolume : 0
      if (price > previous.price) lastTradeDirection = 1
      else if (price < previous.price) lastTradeDirection = -1
      signed = traded * lastTradeDirection
    }
    samples.push({ at, price, cumulativeVolume, ofi, traded, signed, ...book })
    previous = { at, price, cumulativeVolume, ...book }
  }
  return samples
}

function depthMinute(samples, from, to) {
  const rows = samples.slice(lowerBound(samples, from), lowerBound(samples, to))
  if (!rows.length) return null
  const gaps = rows.slice(1).map((row, index) => (row.at - rows[index].at) / 1000)
  const traded = sum(rows.map((row) => row.traded))
  return {
    updates: rows.length,
    spanSeconds: (rows.at(-1).at - rows[0].at) / 1000,
    maximumGapSeconds: gaps.length ? Math.max(...gaps) : Infinity,
    full: mean(rows.map((row) => row.full)),
    top2: mean(rows.map((row) => row.top2)),
    bidDominantFraction: rows.filter((row) => row.full > 0).length / rows.length,
    ofi: mean(rows.map((row) => row.ofi)),
    delta: traded ? sum(rows.map((row) => row.signed)) / traded : 0,
    priceReturnPct: pct(rows.at(-1).price, rows[0].price),
  }
}

function firstExecutable(samples, at) {
  const row = samples[lowerBound(samples, at)]
  return row && row.at - at <= RULE.maximumExecutionLatencySeconds * 1000 ? row : null
}

function lastExecutable(samples, at) {
  const index = lowerBound(samples, at) - 1
  return index >= 0 ? samples[index] : null
}

function validDepth(depth) {
  return Boolean(depth && depth.updates >= RULE.minimumDepthUpdates &&
    depth.spanSeconds >= RULE.minimumDepthSpanSeconds &&
    depth.maximumGapSeconds <= RULE.maximumDepthGapSeconds)
}

function bearishGeometry(candle) {
  return candle.distancePct > RULE.minimumBearishDistancePct &&
    candle.ema5HeadingDeg < RULE.maximumEma5HeadingDeg &&
    candle.ema10HeadingDeg < RULE.maximumEma10HeadingDeg
}

function heavySellSupply(depth) {
  return depth.full <= RULE.maximumFullImbalance && depth.top2 <= RULE.maximumTop2Imbalance &&
    depth.bidDominantFraction <= RULE.maximumBidDominantFraction
}

function stronglyBearish(candle, depth) {
  const bearishConfirmations = Number(candle.close < candle.open) +
    Number(depth.priceReturnPct < RULE.maximumDepthPriceReturnPct) +
    Number(depth.ofi < RULE.maximumOfi) + Number(depth.delta < RULE.maximumDelta)
  return candle.close < candle.open && depth.priceReturnPct < RULE.maximumDepthPriceReturnPct &&
    bearishConfirmations >= RULE.minimumBearishConfirmations
}

function replay(symbol, date, candles, samples, audit) {
  const signals = []
  let position = null
  const sessionEnd = Date.parse(`${date}T15:15:00+05:30`)
  for (const candle of candles) {
    const actionAt = candle.at + MINUTE
    if (position && candle.at > position.signalCandleAt && candle.bullishCross) {
      const exit = firstExecutable(samples, actionAt)
      if (exit) {
        position.exitAt = exit.at; position.exitAsk = exit.ask
        position.exitReason = "EMA5_CROSSED_EMA10_UP"
        position.returnPct = 100 * (position.entryBid / exit.ask - 1)
        signals.push(position); position = null
      }
    }
    if (position) continue
    audit.completedCandles++
    if (!bearishGeometry(candle)) continue
    audit.emaGeometryPassed++
    const depth = depthMinute(samples, candle.at, actionAt)
    if (!validDepth(depth)) { audit.depthQualityRejected++; continue }
    audit.depthQualityPassed++
    if (!heavySellSupply(depth)) { audit.heavySupplyRejected++; continue }
    audit.heavySupplyPassed++
    if (!stronglyBearish(candle, depth)) { audit.bearishBehaviourRejected++; continue }
    audit.bearishBehaviourPassed++
    const entry = firstExecutable(samples, actionAt)
    // The user's entry gate: the live traded price at the executable quote must
    // be above the just-completed candle's EMA5.
    if (!entry) { audit.executionQuoteRejected++; continue }
    if (!(entry.price > candle.ema5)) { audit.ltpAboveEma5Rejected++; continue }
    audit.entries++
    position = {
      date, symbol, side: "SELL", signalCandleAt: candle.at, signalAt: actionAt,
      entryAt: entry.at, entryBid: entry.bid, entryLtp: entry.price,
      ema5: candle.ema5, ema10: candle.ema10, distancePct: candle.distancePct,
      ema5HeadingDeg: candle.ema5HeadingDeg, ema10HeadingDeg: candle.ema10HeadingDeg,
      fullImbalancePct: 100 * depth.full, top2ImbalancePct: 100 * depth.top2,
      bidDominantUpdatesPct: 100 * depth.bidDominantFraction,
      depthPriceReturnPct: depth.priceReturnPct, ofi: depth.ofi, deltaPct: 100 * depth.delta,
      depthUpdates: depth.updates, exitAt: null, exitAsk: null, exitReason: null, returnPct: null,
    }
  }
  if (position) {
    const mark = lastExecutable(samples, sessionEnd)
    if (mark) {
      position.exitAt = mark.at; position.exitAsk = mark.ask
      position.exitReason = mark.at >= sessionEnd - MINUTE
        ? "EOD_MARK_OPEN_NO_CROSS" : "LAST_AVAILABLE_MARK_OPEN_NO_CROSS"
      position.returnPct = 100 * (position.entryBid / mark.ask - 1)
    }
    signals.push(position)
  }
  return signals
}

function outputRow(row) {
  return { date: row.date, symbol: row.symbol, side: row.side,
    signalCandle: dateTime(row.signalCandleAt), signalAvailable: dateTime(row.signalAt),
    entryAt: dateTime(row.entryAt), entryBid: round(row.entryBid, 2), entryLtp: round(row.entryLtp, 2),
    ema5: round(row.ema5), ema10: round(row.ema10), distancePct: round(row.distancePct),
    ema5HeadingDeg: round(row.ema5HeadingDeg, 2), ema10HeadingDeg: round(row.ema10HeadingDeg, 2),
    fullImbalancePct: round(row.fullImbalancePct, 2), top2ImbalancePct: round(row.top2ImbalancePct, 2),
    bidDominantUpdatesPct: round(row.bidDominantUpdatesPct, 2),
    depthPriceReturnPct: round(row.depthPriceReturnPct), ofi: round(row.ofi), deltaPct: round(row.deltaPct, 2),
    depthUpdates: row.depthUpdates, exitAt: row.exitAt ? dateTime(row.exitAt) : "",
    exitAsk: round(row.exitAsk, 2), exitReason: row.exitReason || "OPEN", returnPct: round(row.returnPct) }
}

function csvValue(value) {
  const text = value == null ? "" : String(value)
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
}

const cli = commandLine(process.argv.slice(2))
if (cli.help) { console.log(usage()); process.exit(0) }
if (!cli.date || !/^\d{4}-\d{2}-\d{2}$/.test(cli.date)) throw new Error(usage())
const dateRoot = path.join(ROOT, "db", "cash-depth", cli.date)
if (!fs.existsSync(dateRoot)) throw new Error(`Missing depth archive: ${dateRoot}`)
const symbols = cli.symbol ? [cli.symbol.toUpperCase().replace(/-EQ$/, "")]
  : fs.readdirSync(dateRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory())
    .map((entry) => entry.name).sort()
const signals = []
const audit = { completedCandles: 0, emaGeometryPassed: 0, depthQualityPassed: 0,
  depthQualityRejected: 0, heavySupplyPassed: 0, heavySupplyRejected: 0,
  bearishBehaviourPassed: 0, bearishBehaviourRejected: 0,
  executionQuoteRejected: 0, ltpAboveEma5Rejected: 0, entries: 0 }
for (const symbol of symbols) {
  const candles = loadCandles(symbol, cli.date)
  const samples = await loadDepth(symbol, cli.date)
  signals.push(...replay(symbol, cli.date, candles, samples, audit))
}
const rows = signals.map(outputRow).sort((left, right) =>
  left.signalAvailable.localeCompare(right.signalAvailable) || left.symbol.localeCompare(right.symbol))
const totalReturnPct = sum(rows.map((row) => Number(row.returnPct) || 0))
const closed = rows.filter((row) => row.exitReason === "EMA5_CROSSED_EMA10_UP")
const markedOpen = rows.filter((row) => row.exitReason === "EOD_MARK_OPEN_NO_CROSS")
const partialSessionMarks = rows.filter((row) => row.exitReason === "LAST_AVAILABLE_MARK_OPEN_NO_CROSS")
const report = { date: cli.date, universe: symbols.length, rule: RULE,
  headingDefinition: "atan(one-candle percentage change in EMA) in degrees",
  chronology: "signal at completed candle close; SELL at next bid; cover at next ask after bullish EMA5/EMA10 cross",
  audit,
  signals: rows.length, closedByCross: closed.length, markedOpenAtEod: markedOpen.length,
  markedOpenAtLastAvailableQuote: partialSessionMarks.length,
  totalReturnPct: round(totalReturnPct), rows }
const output = path.resolve(ROOT, cli.output || path.join("csv", `${cli.date}-ema5-10-bearish-depth-replay.json`))
const csvOutput = output.replace(/\.json$/i, ".csv")
fs.mkdirSync(path.dirname(output), { recursive: true })
fs.writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`)
const columns = Object.keys(rows[0] || { date: null, symbol: null, side: null, signalAvailable: null, returnPct: null })
fs.writeFileSync(csvOutput, `${[columns.join(","), ...rows.map((row) =>
  columns.map((key) => csvValue(row[key])).join(","))].join("\n")}\n`)
console.log(`EMA5/EMA10 bearish depth replay | ${cli.date} | ${symbols.length} stock(s)`)
console.log(`Signals ${rows.length}; EMA-cross exits ${closed.length}; EOD open marks ${markedOpen.length}; partial-session marks ${partialSessionMarks.length}; summed return ${round(totalReturnPct)}%`)
console.table(audit)
console.table(rows)
console.log(`JSON: ${output}`)
console.log(`CSV: ${csvOutput}`)

