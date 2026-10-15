import fs from "node:fs"
import path from "node:path"
import readline from "node:readline"

const ROOT = process.cwd()
const MINUTE = 60_000
const IST_OFFSET = 330 * MINUTE

// This is a causal replay rule. A minute is evaluated only after it closes and
// every action is timestamped at the next minute, when the result is knowable.
const STRICT_RULE = Object.freeze({
  preWindows: [60, 50, 40],
  maximumBaselineRangePct: 0.65,
  maximumBaselineReturnPct: 0.25,
  maximumMeanAbsoluteEmaGapPct: 0.04,
  maximumPeakAbsoluteEmaGapPct: 0.10,

  minimumPassiveFullImbalance: 0.05,
  maximumPassiveDelta: 0.10,
  maximumPassiveReturnPct: 0.20,
  minimumAccumulationDelta: 0.03,
  minimumAccumulationReturnPct: 0,
  maximumAccumulationReturnPct: 0.30,

  preparationMinutes: 2,
  minimumPreparationFullImbalance: 0.20,
  minimumPreparationBidDominance: 0.60,
  maximumPreparationVolumeMultiple: 0.75,

  minimumIgnitionReturnPct: 0.02,
  minimumIgnitionMidReturnPct: 0.02,
  minimumIgnitionVolumeMultiple: 1.50,
  minimumIgnitionDelta: 0.35,
  minimumIgnitionOfi: 0.03,
  minimumEmaGapIncreasePct: 0.001,

  absorptionDeadlineMinutes: 5,
  minimumAbsorptionAskImbalance: 0.25,
  minimumAbsorptionDelta: 0.20,
  minimumAbsorptionOfi: 0.04,
  maximumAbsorptionDrawdownPct: 0.10,

  breakoutDeadlineMinutes: 8,
  minimumBreakoutVolumeMultiple: 2,
  minimumBreakoutDelta: 0.50,
  minimumBreakoutOfi: 0.05,
  minimumBreakoutCloseLocation: 0.65,

  minimumFollowThroughVolumeMultiple: 1.50,
  minimumFollowThroughDelta: 0.25,
  minimumFollowThroughOfi: 0.02,

  exhaustionDelta: -0.20,
  exhaustionOfi: -0.05,
  exhaustionReturnPct: -0.02,
  maximumHoldMinutes: 15,
  maximumDepthGapSeconds: 15,
  minimumMinuteSpanSeconds: 45,
  maximumExecutionLatencySeconds: 15,
})

// This profile relaxes only the historical context. The actionable stages
// (ignition, absorption and breakout) deliberately retain the strict values.
const LOOSE_PRE_OVERRIDES = Object.freeze({
  maximumBaselineRangePct: 1.00,
  maximumBaselineReturnPct: 0.50,
  maximumMeanAbsoluteEmaGapPct: 0.08,
  maximumPeakAbsoluteEmaGapPct: 0.18,
  minimumPassiveFullImbalance: 0,
  maximumPassiveDelta: 0.25,
  maximumPassiveReturnPct: 0.40,
  minimumAccumulationDelta: 0,
  minimumAccumulationReturnPct: -0.05,
  maximumAccumulationReturnPct: 0.50,
  minimumPreparationFullImbalance: 0.10,
  minimumPreparationBidDominance: 0.50,
  maximumPreparationVolumeMultiple: 1.00,
})

let RULE = STRICT_RULE

function options(argv) {
  const result = { date: null, symbol: null, all: false, json: null, loosePre: false }
  for (let index = 0; index < argv.length; index++) {
    const value = argv[index]
    if (value === "--date") result.date = argv[++index]
    else if (value.startsWith("--date=")) result.date = value.slice(7)
    else if (value === "--symbol") result.symbol = argv[++index]
    else if (value.startsWith("--symbol=")) result.symbol = value.slice(9)
    else if (value === "--all") result.all = true
    else if (value === "--loose-pre") result.loosePre = true
    else if (value === "--json") result.json = argv[++index]
    else if (value.startsWith("--json=")) result.json = value.slice(7)
    else if (value === "--help" || value === "-h") result.help = true
    else throw new Error(`Unknown option: ${value}`)
  }
  return result
}

function usage() {
  return [
    "Usage:",
    "  node scripts/replay-ema-depth-expansion-strategy.js --date 2026-10-13 --symbol CGPOWER",
    "  node scripts/replay-ema-depth-expansion-strategy.js --date 2026-10-13 --all",
    "  node scripts/replay-ema-depth-expansion-strategy.js --date 2026-10-13 --all --loose-pre",
    "  node scripts/replay-ema-depth-expansion-strategy.js --date 2026-10-13 --all --json csv/result.json",
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

function completeBook(fields) {
  let bidSize = 0, askSize = 0, bidTop2 = 0, askTop2 = 0
  let bidOrders = 0, askOrders = 0
  for (let level = 1; level <= 5; level++) {
    const bidPrice = Number(fields[`bid_price${level}`])
    const askPrice = Number(fields[`ask_price${level}`])
    const currentBid = Number(fields[`bid_size${level}`])
    const currentAsk = Number(fields[`ask_size${level}`])
    if (![bidPrice, askPrice, currentBid, currentAsk].every(Number.isFinite) ||
        bidPrice <= 0 || askPrice <= bidPrice || currentBid < 0 || currentAsk < 0) return null
    bidSize += currentBid
    askSize += currentAsk
    bidOrders += Number(fields[`bid_order${level}`]) || 0
    askOrders += Number(fields[`ask_order${level}`]) || 0
    if (level <= 2) { bidTop2 += currentBid; askTop2 += currentAsk }
  }
  const bid = Number(fields.bid_price1), ask = Number(fields.ask_price1)
  return {
    bid, ask, bid1: Number(fields.bid_size1), ask1: Number(fields.ask_size1),
    bidSize, askSize, mid: (bid + ask) / 2,
    full: (bidSize - askSize) / (bidSize + askSize || 1),
    top2: (bidTop2 - askTop2) / (bidTop2 + askTop2 || 1),
    orders: (bidOrders - askOrders) / (bidOrders + askOrders || 1),
    spreadBps: 10_000 * (ask - bid) / ((ask + bid) / 2),
  }
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
      return Object.values(row).every(Number.isFinite) ? [row] : []
    } catch { return [] }
  }).sort((left, right) => left.at - right.at)

  let ema15 = null, ema30 = null
  for (const row of rows) {
    ema15 = ema15 == null ? row.close : row.close * 2 / 16 + ema15 * 14 / 16
    ema30 = ema30 == null ? row.close : row.close * 2 / 31 + ema30 * 29 / 31
    row.ema15 = ema15
    row.ema30 = ema30
    row.emaGap = ema15 - ema30
    row.emaGapPct = 100 * row.emaGap / ema30
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
    const price = Number(record.marketContext?.price)
    const cumulativeVolume = Number(record.marketContext?.cumulativeVolume)
    if (!book || !(price > 0) || !Number.isFinite(cumulativeVolume)) continue
    let ofi = 0, traded = 0, signed = 0
    if (previous) {
      let rawOfi = book.bid > previous.bid ? book.bid1
        : book.bid === previous.bid ? book.bid1 - previous.bid1 : -previous.bid1
      rawOfi -= book.ask < previous.ask ? book.ask1
        : book.ask === previous.ask ? book.ask1 - previous.ask1 : -previous.ask1
      const scale = (book.bid1 + book.ask1 + previous.bid1 + previous.ask1) / 2
      ofi = rawOfi / (scale || 1)
      traded = Math.max(0, cumulativeVolume - previous.cumulativeVolume)
      if (price > previous.price) lastTradeDirection = 1
      else if (price < previous.price) lastTradeDirection = -1
      signed = traded * lastTradeDirection
    }
    samples.push({ at, price, cumulativeVolume, ofi, traded, signed, ...book })
    previous = { at, price, cumulativeVolume, ...book }
  }
  return samples
}

function aggregateDepth(rows) {
  if (!rows.length) return null
  const tradedVolume = sum(rows.map((row) => row.traded))
  const gaps = rows.slice(1).map((row, index) => (row.at - rows[index].at) / 1000)
  return {
    updates: rows.length,
    spanSec: (rows.at(-1).at - rows[0].at) / 1000,
    maxGapSec: gaps.length ? Math.max(...gaps) : Infinity,
    full: mean(rows.map((row) => row.full)),
    top2: mean(rows.map((row) => row.top2)),
    orders: mean(rows.map((row) => row.orders)),
    bidDominance: rows.filter((row) => row.full > 0).length / rows.length,
    ofi: mean(rows.map((row) => row.ofi)),
    tradedVolume,
    delta: tradedVolume ? sum(rows.map((row) => row.signed)) / tradedVolume : 0,
    priceReturnPct: pct(rows.at(-1).price, rows[0].price),
    midReturnPct: pct(rows.at(-1).mid, rows[0].mid),
    spreadBps: mean(rows.map((row) => row.spreadBps)),
  }
}

function minuteSeries(candles, samples) {
  const byAt = new Map(candles.map((row) => [row.at, row]))
  const result = []
  for (const candle of candles) {
    const depthRows = samples.filter((row) => row.at >= candle.at && row.at < candle.at + MINUTE)
    const depth = aggregateDepth(depthRows)
    if (!depth || depth.spanSec < RULE.minimumMinuteSpanSeconds ||
        depth.maxGapSec > RULE.maximumDepthGapSeconds) continue
    result.push({ ...byAt.get(candle.at), ...depth,
      candleReturnPct: pct(candle.close, candle.open),
      closeLocation: (candle.close - candle.low) / (candle.high - candle.low || 1) })
  }
  return result
}

function continuous(rows) {
  return rows.every((row, index) => index === 0 || row.at === rows[index - 1].at + MINUTE)
}

function summarize(rows) {
  const traded = sum(rows.map((row) => row.tradedVolume))
  return {
    candles: rows.length,
    returnPct: pct(rows.at(-1).close, rows[0].open),
    rangePct: pct(Math.max(...rows.map((row) => row.high)), Math.min(...rows.map((row) => row.low))),
    meanAbsoluteEmaGapPct: mean(rows.map((row) => Math.abs(row.emaGapPct))),
    peakAbsoluteEmaGapPct: Math.max(...rows.map((row) => Math.abs(row.emaGapPct))),
    averageVolume: mean(rows.map((row) => row.volume)),
    full: mean(rows.map((row) => row.full)),
    top2: mean(rows.map((row) => row.top2)),
    bidDominance: mean(rows.map((row) => row.bidDominance)),
    ofi: mean(rows.map((row) => row.ofi)),
    delta: traded ? sum(rows.map((row) => row.delta * row.tradedVolume)) / traded : 0,
  }
}

function baselineAt(rows, currentIndex) {
  for (const size of RULE.preWindows) {
    const prior = rows.slice(currentIndex - size, currentIndex)
    if (prior.length !== size || !continuous(prior)) continue
    const baseline = summarize(prior)
    const split = Math.floor(size / 2)
    const passive = summarize(prior.slice(0, split))
    const accumulation = summarize(prior.slice(split))
    const preparationRows = prior.slice(-RULE.preparationMinutes)
    const preparation = summarize(preparationRows)
    const preparationVolumeMultiple = preparation.averageVolume / baseline.averageVolume

    const compressionPass = baseline.rangePct <= RULE.maximumBaselineRangePct &&
      Math.abs(baseline.returnPct) <= RULE.maximumBaselineReturnPct &&
      baseline.meanAbsoluteEmaGapPct <= RULE.maximumMeanAbsoluteEmaGapPct &&
      baseline.peakAbsoluteEmaGapPct <= RULE.maximumPeakAbsoluteEmaGapPct
    const passivePass = passive.full >= RULE.minimumPassiveFullImbalance &&
      passive.delta <= RULE.maximumPassiveDelta &&
      Math.abs(passive.returnPct) <= RULE.maximumPassiveReturnPct
    const accumulationPass = accumulation.delta >= RULE.minimumAccumulationDelta &&
      accumulation.returnPct >= RULE.minimumAccumulationReturnPct &&
      accumulation.returnPct <= RULE.maximumAccumulationReturnPct
    const preparationPass = preparation.full >= RULE.minimumPreparationFullImbalance &&
      preparation.bidDominance >= RULE.minimumPreparationBidDominance &&
      preparationVolumeMultiple <= RULE.maximumPreparationVolumeMultiple

    if (compressionPass && passivePass && accumulationPass && preparationPass) {
      return { size, baseline, passive, accumulation, preparation, preparationVolumeMultiple,
        high: Math.max(...prior.map((row) => row.high)), low: Math.min(...prior.map((row) => row.low)) }
    }
  }
  return null
}

function ignitionAt(rows, index, baseline) {
  const current = rows[index], previous = rows[index - 1]
  if (!current || !previous || current.at !== previous.at + MINUTE) return false
  const gapIncrease = current.emaGapPct - previous.emaGapPct
  return current.emaGapPct > 0 && gapIncrease >= RULE.minimumEmaGapIncreasePct &&
    current.candleReturnPct >= RULE.minimumIgnitionReturnPct &&
    current.midReturnPct >= RULE.minimumIgnitionMidReturnPct &&
    current.volume / baseline.baseline.averageVolume >= RULE.minimumIgnitionVolumeMultiple &&
    current.delta >= RULE.minimumIgnitionDelta && current.ofi >= RULE.minimumIgnitionOfi
}

function event(symbol, row, phase, knownAt, details = {}) {
  return { symbol, candle: dateTime(row.at), knownAt: dateTime(knownAt), phase, ...details }
}

function firstExecutable(samples, at) {
  return samples.find((row) => row.at >= at &&
    row.at - at <= RULE.maximumExecutionLatencySeconds * 1000)
}

function replay(symbol, rows, samples) {
  const events = [], trades = []
  let state = null
  for (let index = Math.max(...RULE.preWindows); index < rows.length; index++) {
    const row = rows[index]
    if (state && row.at !== state.lastAt + MINUTE) state = null

    if (!state) {
      const baseline = baselineAt(rows, index)
      if (!baseline || !ignitionAt(rows, index, baseline)) continue
      const knownAt = row.at + MINUTE
      const fill = firstExecutable(samples, knownAt)
      state = { phase: "IGNITED", ignitionIndex: index, ignitionAt: row.at,
        lastAt: row.at, baseline, watchQuote: fill || null, absorption: false, breakout: false }
      events.push(event(symbol, row, "BULLISH_IGNITION", knownAt, {
        preWindow: baseline.size,
        baselineRangePct: round(baseline.baseline.rangePct),
        baselineReturnPct: round(baseline.baseline.returnPct),
        baselineMeanAbsoluteEmaGapPct: round(baseline.baseline.meanAbsoluteEmaGapPct),
        passiveFullImbalancePct: round(100 * baseline.passive.full),
        passiveDeltaPct: round(100 * baseline.passive.delta),
        passiveReturnPct: round(baseline.passive.returnPct),
        accumulationDeltaPct: round(100 * baseline.accumulation.delta),
        accumulationReturnPct: round(baseline.accumulation.returnPct),
        preparationFullImbalancePct: round(100 * baseline.preparation.full),
        preparationBidDominancePct: round(100 * baseline.preparation.bidDominance),
        preparationVolumeMultiple: round(baseline.preparationVolumeMultiple),
        emaGapPct: round(row.emaGapPct),
        emaGapIncreasePct: round(row.emaGapPct - rows[index - 1].emaGapPct),
        volumeMultiple: round(row.volume / baseline.baseline.averageVolume),
        deltaPct: round(100 * row.delta), ofi: round(row.ofi),
        nextAskReference: round(fill?.ask, 2),
      }))
      continue
    }

    state.lastAt = row.at
    const elapsed = index - state.ignitionIndex
    const knownAt = row.at + MINUTE
    const volumeMultiple = row.volume / state.baseline.baseline.averageVolume
    const drawdownPct = pct(row.low, rows[state.ignitionIndex].close)

    if (!state.absorption && elapsed <= RULE.absorptionDeadlineMinutes &&
        row.full <= -RULE.minimumAbsorptionAskImbalance &&
        row.delta >= RULE.minimumAbsorptionDelta && row.ofi >= RULE.minimumAbsorptionOfi &&
        drawdownPct >= -RULE.maximumAbsorptionDrawdownPct) {
      state.absorption = true
      events.push(event(symbol, row, "ASKS_ABSORBED", knownAt, {
        fullImbalancePct: round(100 * row.full), deltaPct: round(100 * row.delta),
        ofi: round(row.ofi), drawdownPct: round(drawdownPct),
      }))
    }

    if (!state.breakout && state.absorption && elapsed <= RULE.breakoutDeadlineMinutes &&
        row.close > state.baseline.high && row.close > row.open &&
        row.closeLocation >= RULE.minimumBreakoutCloseLocation &&
        volumeMultiple >= RULE.minimumBreakoutVolumeMultiple &&
        row.delta >= RULE.minimumBreakoutDelta && row.ofi >= RULE.minimumBreakoutOfi &&
        row.emaGapPct > rows[index - 1].emaGapPct) {
      const fill = firstExecutable(samples, knownAt)
      state.breakout = true
      state.breakoutIndex = index
      state.confirmedEntry = fill || null
      events.push(event(symbol, row, "HIGH_CONFIDENCE_BREAKOUT", knownAt, {
        breakoutPct: round(pct(row.close, state.baseline.high)),
        volumeMultiple: round(volumeMultiple), deltaPct: round(100 * row.delta),
        ofi: round(row.ofi), confirmedEntryAsk: round(fill?.ask, 2),
      }))
    } else if (state.breakout && index > state.breakoutIndex &&
        volumeMultiple >= RULE.minimumFollowThroughVolumeMultiple &&
        row.delta >= RULE.minimumFollowThroughDelta && row.ofi >= RULE.minimumFollowThroughOfi &&
        row.emaGapPct > rows[index - 1].emaGapPct && row.close >= rows[index - 1].close) {
      events.push(event(symbol, row, "BULLISH_FOLLOW_THROUGH", knownAt, {
        volumeMultiple: round(volumeMultiple), deltaPct: round(100 * row.delta),
        ofi: round(row.ofi), emaGapPct: round(row.emaGapPct),
      }))
    }

    if (state.breakout) {
      const exhaustionVotes = Number(row.delta <= RULE.exhaustionDelta) +
        Number(row.ofi <= RULE.exhaustionOfi) +
        Number(row.candleReturnPct <= RULE.exhaustionReturnPct) +
        Number(row.close < rows[index - 1].close)
      if (exhaustionVotes >= 3 || elapsed >= RULE.maximumHoldMinutes) {
        const exit = firstExecutable(samples, knownAt)
        events.push(event(symbol, row, elapsed >= RULE.maximumHoldMinutes ? "TIME_EXIT" : "MOMENTUM_EXHAUSTION", knownAt, {
          votes: exhaustionVotes, deltaPct: round(100 * row.delta), ofi: round(row.ofi),
          candleReturnPct: round(row.candleReturnPct), exitBid: round(exit?.bid, 2),
        }))
        const entry = state.confirmedEntry
        if (entry && exit) trades.push({ symbol, entryType: "CONFIRMED", entryAt: dateTime(entry.at),
          entryAsk: round(entry.ask, 2), exitAt: dateTime(exit.at), exitBid: round(exit.bid, 2),
          returnPct: round(pct(exit.bid, entry.ask)) })
        state = null
      }
    } else if (elapsed > RULE.breakoutDeadlineMinutes) {
      events.push(event(symbol, row, "SETUP_EXPIRED", knownAt))
      state = null
    }
  }
  return { events, trades }
}

async function scanSymbol(symbol, date) {
  const candles = loadCandles(symbol, date)
  const samples = await loadDepth(symbol, date)
  return { symbol, candleCount: candles.length, depthSamples: samples.length,
    ...replay(symbol, minuteSeries(candles, samples), samples) }
}

const cli = options(process.argv.slice(2))
if (cli.help) { console.log(usage()); process.exit(0) }
if (!cli.date || (!cli.symbol && !cli.all)) throw new Error(usage())
if (cli.loosePre) RULE = Object.freeze({ ...STRICT_RULE, ...LOOSE_PRE_OVERRIDES })
const dateRoot = path.join(ROOT, "db", "cash-depth", cli.date)
if (!fs.existsSync(dateRoot)) throw new Error(`Depth date not found: ${cli.date}`)
const symbols = cli.all
  ? fs.readdirSync(dateRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort()
  : [cli.symbol.toUpperCase().replace(/-EQ$/, "")]

const results = []
for (const symbol of symbols) results.push(await scanSymbol(symbol, cli.date))
const events = results.flatMap((row) => row.events).sort((a, b) => a.knownAt.localeCompare(b.knownAt) || a.symbol.localeCompare(b.symbol))
const trades = results.flatMap((row) => row.trades).sort((a, b) => a.entryAt.localeCompare(b.entryAt) || a.symbol.localeCompare(b.symbol))
const output = { date: cli.date, profile: cli.loosePre ? "loose-pre" : "strict",
  rule: RULE, symbolsScanned: symbols.length, events, trades }

if (cli.json) {
  const target = path.resolve(ROOT, cli.json)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, `${JSON.stringify(output, null, 2)}\n`)
  console.log(`JSON: ${target}`)
}
console.log(`Chronological EMA/depth expansion replay | ${cli.date} | ${symbols.length} stock(s) | ${output.profile}`)
console.table(events)
console.log("Executable spread-aware trades (ask entry, bid exit):")
console.table(trades)

