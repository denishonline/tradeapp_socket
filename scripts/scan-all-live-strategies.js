#!/usr/bin/env node
import fs from "node:fs"
import path from "node:path"
import {
  LIVE_STRATEGIES,
  evaluateEma,
  evaluateOct05Loose,
  evaluatePviNvi,
  evaluateSep25OpeningBreakout,
  evaluateSep29TightStop,
  evaluateSr,
  normalizeStored,
  prepareEmaEvaluation,
  preparePviNviEvaluation,
  prepareSrEvaluation,
} from "../ui/live-strategy-scanner.js"

const ROOT = process.cwd()
const CANDLE_DIRECTORY = path.join(ROOT, "db", "candles")
const REPORT_DIRECTORY = path.join(ROOT, "reports")
const MARKET_OPEN = 555
const SESSION_LAST_COMPLETED_MINUTE = 929
const round = (value, digits = 4) => Number.isFinite(value) ? +value.toFixed(digits) : null
const clock = minute => `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`
const minuteOf = value => {
  const match = /^(\d{2}):(\d{2})$/.exec(value ?? "")
  return match ? Number(match[1]) * 60 + Number(match[2]) : NaN
}
const directionalReturn = (side, exit, entry) => (side === "BUY" ? 1 : -1) * 100 * (exit / entry - 1)

const arg = name => {
  const index = process.argv.indexOf(name)
  return index < 0 ? null : process.argv[index + 1]
}
const has = name => process.argv.includes(name)
const usage = [
  "Usage:",
  "  node scripts/scan-all-live-strategies.js --date YYYY-MM-DD",
  "  node scripts/scan-all-live-strategies.js --from YYYY-MM-DD --to YYYY-MM-DD",
  "  node scripts/scan-all-live-strategies.js --date YYYY-MM-DD --strategy STRATEGY_ID",
  "  node scripts/scan-all-live-strategies.js --date YYYY-MM-DD --strategies ID1,ID2 --time HH:MM",
  "  node scripts/scan-all-live-strategies.js --from YYYY-MM-DD --to YYYY-MM-DD --strategy STRATEGY_ID",
  "",
  "Chronologically scans all stored stocks using the six active live strategies:",
  "  PVI/NVI Three-OR, EMA20/40 Advanced, S/R MTF High Precision,",
  "  Oct-05 High-Volume Retest, Sep-29 Tight Stop Continuation,",
  "  and Sep-25 Opening Breakout.",
  "",
  `Strategy IDs: ${LIVE_STRATEGIES.map(strategy => strategy.id).join(", ")}`,
].join("\n")

function fail(message) {
  console.error(`${message}\n\n${usage}`)
  process.exit(1)
}

function validDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value ?? "")) return false
  const parsed = new Date(`${value}T00:00:00Z`)
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value
}

const oneDate = arg("--date")
const fromArg = arg("--from")
const toArg = arg("--to")
const strategyId = arg("--strategy")
const strategyIdsValue = arg("--strategies")
const cutoffTime = arg("--time")
const profile = has("--profile")
if (has("--help") || has("-h")) { console.log(usage); process.exit(0) }
if (oneDate && (fromArg || toArg)) fail("Use either --date or --from/--to, not both.")
if (!oneDate && (!fromArg || !toArg)) fail("Provide --date or both --from and --to.")
const from = oneDate ?? fromArg
const to = oneDate ?? toArg
if (!validDate(from) || !validDate(to)) fail("Dates must be valid calendar dates in YYYY-MM-DD format.")
if (from > to) fail("--from must be on or before --to.")
if (strategyId && strategyIdsValue) fail("Use either --strategy or --strategies, not both.")
if (has("--strategy") && !strategyId) fail("--strategy requires a strategy ID.")
if (has("--strategies") && !strategyIdsValue) fail("--strategies requires comma-separated strategy IDs.")
if (cutoffTime && !/^\d{2}:\d{2}$/.test(cutoffTime)) fail("--time must use HH:MM.")
const requestedStrategyIds = strategyIdsValue
  ? [...new Set(strategyIdsValue.split(",").map(value => value.trim()).filter(Boolean))]
  : strategyId ? [strategyId] : null
const strategies = requestedStrategyIds ? LIVE_STRATEGIES.filter(strategy => requestedStrategyIds.includes(strategy.id)) : LIVE_STRATEGIES
const unknownStrategyIds = requestedStrategyIds?.filter(id => !LIVE_STRATEGIES.some(strategy => strategy.id === id)) ?? []
if (unknownStrategyIds.length) fail(`Unknown strategy ID(s): ${unknownStrategyIds.join(", ")}`)
const cutoffAvailabilityMinute = cutoffTime ? minuteOf(cutoffTime) : SESSION_LAST_COMPLETED_MINUTE + 1
if (!Number.isFinite(cutoffAvailabilityMinute) || cutoffAvailabilityMinute <= MARKET_OPEN || cutoffAvailabilityMinute > SESSION_LAST_COMPLETED_MINUTE + 1) fail("--time must be from 09:16 through 15:30.")
const lastCompletedMinute = cutoffAvailabilityMinute - 1
const selectedStrategyIds = new Set(strategies.map(strategy => strategy.id))

function loadRows(symbol) {
  const file = path.join(CANDLE_DIRECTORY, `${symbol}.jsonl`)
  if (!fs.existsSync(file)) return []
  const rows = []
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    if (!line) continue
    try {
      const row = normalizeStored(JSON.parse(line))
      if (row && row.date <= to) rows.push(row)
    } catch {}
  }
  return rows.sort((left, right) => left.time - right.time)
}

function sessionDates(rows, throughDate) {
  return [...new Set(rows.filter(row => row.date <= throughDate).map(row => row.date))].sort()
}

function cacheThroughDate(rawCache, symbols, date) {
  const output = new Map()
  for (const symbol of [...symbols, "NIFTY50"]) {
    const rows = rawCache.get(symbol) ?? []
    const included = new Set(sessionDates(rows, date).slice(-30))
    output.set(symbol, rows.filter(row => included.has(row.date)))
  }
  return output
}

function uniqueReport(stem) {
  fs.mkdirSync(REPORT_DIRECTORY, { recursive: true })
  let suffix = 1
  while (true) {
    const name = `${stem}${suffix === 1 ? "" : `-${suffix}`}.json`
    const file = path.join(REPORT_DIRECTORY, name)
    if (!fs.existsSync(file)) return file
    suffix++
  }
}

function rankedOutcome(item, day) {
  const entryIndex = day.findIndex(row => row.minute === minuteOf(item.signalTime))
  const path = entryIndex < 0 ? [] : day.slice(entryIndex, entryIndex + 20)
  if (path.length !== 20) return { outcomeStatus: "INSUFFICIENT_20_CANDLES", returnPct: null }
  const entry = path[0].o, exit = path.at(-1).c
  const favorable = item.side === "BUY" ? Math.max(...path.map(row => row.h)) : Math.min(...path.map(row => row.l))
  const adverse = item.side === "BUY" ? Math.min(...path.map(row => row.l)) : Math.max(...path.map(row => row.h))
  return {
    outcomeStatus: "EVALUATED", entryTime: item.signalTime, entryPrice: round(entry), exitTime: clock(path.at(-1).minute), exitPrice: round(exit), exitReason: "20_CANDLE_CLOSE",
    returnPct: round(directionalReturn(item.side, exit, entry), 3),
    mfePct: round(item.side === "BUY" ? 100 * (favorable / entry - 1) : 100 * (entry / favorable - 1), 3),
    maePct: round(item.side === "BUY" ? Math.min(0, 100 * (adverse / entry - 1)) : Math.min(0, 100 * (entry / adverse - 1)), 3),
  }
}

function pviNviOutcome(item, day) {
  const signalMinute = minuteOf(item.signalTime), entry = day.find(row => row.minute === signalMinute)
  if (!entry || entry.v <= 0) return { outcomeStatus: "MISSING_ENTRY_CANDLE", returnPct: null }
  const subsequent = day.filter(row => row.minute > signalMinute)
  if (!subsequent.length) return { outcomeStatus: "NO_FUTURE_CANDLE", returnPct: null }
  const targetPrice = entry.c * (item.side === "SELL" ? .98 : 1.02)
  const stopPrice = entry.c * (item.side === "SELL" ? 1.008 : .992)
  let cross = null, stop = null, target = null, previous = entry
  for (const row of subsequent) {
    const hitTarget = item.side === "SELL" ? row.l <= targetPrice : row.h >= targetPrice
    const hitStop = item.side === "SELL" ? row.h >= stopPrice : row.l <= stopPrice
    // OHLC cannot establish intrabar order. The live scanner takes the stop
    // first when both prices occur in one candle, so the replay does too.
    if (hitStop) { stop = { row, sameBarAsTarget: hitTarget }; break }
    if (hitTarget) { target = row; break }
    const crossed = item.side === "SELL"
      ? previous.ema[20] <= previous.ema[40] && row.ema[20] > row.ema[40]
      : previous.ema[20] >= previous.ema[40] && row.ema[20] < row.ema[40]
    if (crossed) { cross = row; break }
    previous = row
  }
  const crossFill = cross && day.find(row => row.minute === cross.minute + 1)
  const exitRow = stop?.row || target || crossFill || day.at(-1), exitPrice = stop ? stopPrice : target ? targetPrice : exitRow.c
  const held = subsequent.filter(row => row.minute <= exitRow.minute)
  const favorable = item.side === "BUY" ? Math.max(entry.c, ...held.map(row => row.h)) : Math.min(entry.c, ...held.map(row => row.l))
  const adverse = item.side === "BUY" ? Math.min(entry.c, ...held.map(row => row.l)) : Math.max(entry.c, ...held.map(row => row.h))
  return {
    outcomeStatus: "EVALUATED", entryTime: clock(signalMinute + 1), entryPrice: round(entry.c),
    exitTime: stop || target ? `${clock(exitRow.minute)}-${clock(exitRow.minute + 1)}` : clock(exitRow.minute + 1), exitPrice: round(exitPrice),
    exitReason: stop ? stop.sameBarAsTarget ? "STOP_SAME_BAR_AS_TARGET" : "STOP" : target ? "2% TARGET" : cross ? "OPPOSITE_EMA_CROSS" : "SESSION_CLOSE",
    returnPct: round(directionalReturn(item.side, exitPrice, entry.c)),
    mfePct: round(item.side === "BUY" ? 100 * (favorable / entry.c - 1) : 100 * (entry.c / favorable - 1)),
    maePct: round(item.side === "BUY" ? Math.min(0, 100 * (adverse / entry.c - 1)) : Math.min(0, 100 * (entry.c / adverse - 1))),
  }
}

function emaOutcome(item, day) {
  const signalIndex = day.findIndex(row => row.minute === minuteOf(item.signalTime)), entryIndex = signalIndex + 1, entry = day[entryIndex]
  if (signalIndex < 0 || !entry) return { outcomeStatus: "WAITING_FOR_NEXT_CANDLE", returnPct: null }
  let exitIndex = day.length - 1, exitReason = "EOD"
  for (let index = entryIndex; index < day.length; index++) {
    const prior = day[index - 1], row = day[index]
    const opposite = item.side === "BUY"
      ? prior.ema[20] >= prior.ema[40] && row.ema[20] < row.ema[40]
      : prior.ema[20] <= prior.ema[40] && row.ema[20] > row.ema[40]
    if (opposite) { exitIndex = index; exitReason = "OPPOSITE_CROSS_CLOSE"; break }
  }
  const exit = day[exitIndex], held = day.slice(entryIndex, exitIndex + 1)
  const favorable = item.side === "BUY" ? Math.max(...held.map(row => row.h)) : Math.min(...held.map(row => row.l))
  const adverse = item.side === "BUY" ? Math.min(...held.map(row => row.l)) : Math.max(...held.map(row => row.h))
  return {
    outcomeStatus: "EVALUATED", entryTime: clock(entry.minute), entryPrice: round(entry.o), exitTime: clock(exit.minute), exitPrice: round(exit.c), exitReason,
    returnPct: round(directionalReturn(item.side, exit.c, entry.o)),
    mfePct: round(item.side === "BUY" ? 100 * (favorable / entry.o - 1) : 100 * (entry.o / favorable - 1)),
    maePct: round(item.side === "BUY" ? Math.min(0, 100 * (adverse / entry.o - 1)) : Math.min(0, 100 * (entry.o / adverse - 1))),
  }
}

function srMtfOutcome(item, day) {
  const entryMinute = minuteOf(item.signalTime), entryRow = day.find(row => row.minute === entryMinute)
  if (!entryRow) return { outcomeStatus: "MISSING_ENTRY_CANDLE", returnPct: null }
  const entry = entryRow.o, target = entry * (item.side === "BUY" ? 1.011 : .989), stop = entry * (item.side === "BUY" ? .992 : 1.008)
  const path = day.filter(row => row.minute >= entryMinute && row.minute <= 929)
  let favorable = entry, adverse = entry, exitPrice = path.at(-1)?.c, exitRow = path.at(-1), exitReason = "CUTOFF"
  for (const row of path) {
    favorable = item.side === "BUY" ? Math.max(favorable, row.h) : Math.min(favorable, row.l)
    adverse = item.side === "BUY" ? Math.min(adverse, row.l) : Math.max(adverse, row.h)
    const hitTarget = item.side === "BUY" ? row.h >= target : row.l <= target
    const hitStop = item.side === "BUY" ? row.l <= stop : row.h >= stop
    if (hitStop) { exitPrice = stop; exitRow = row; exitReason = hitTarget ? "STOP_SAME_BAR_AS_TARGET" : "STOP"; break }
    if (hitTarget) { exitPrice = target; exitRow = row; exitReason = "TARGET"; break }
  }
  if (!exitRow || !Number.isFinite(exitPrice)) return { outcomeStatus: "NO_EXIT_CANDLE", returnPct: null }
  return {
    outcomeStatus: "EVALUATED", entryTime: item.signalTime, entryPrice: round(entry), exitTime: clock(exitRow.minute), exitPrice: round(exitPrice), exitReason,
    returnPct: round(directionalReturn(item.side, exitPrice, entry)),
    mfePct: round(item.side === "BUY" ? 100 * (favorable / entry - 1) : 100 * (entry / favorable - 1)),
    maePct: round(item.side === "BUY" ? Math.min(0, 100 * (adverse / entry - 1)) : Math.min(0, 100 * (entry / adverse - 1))),
  }
}

function attachOutcome(item, cache, preparedEma) {
  const rawDay = (cache.get(item.symbol) ?? []).filter(row => row.date === item.date)
  const emaDay = preparedEma.dayBySymbol.get(item.symbol) ?? []
  const result = item.strategyId === "pvi-nvi" ? pviNviOutcome(item, emaDay)
    : item.strategyId === "ema20-40" ? emaOutcome(item, emaDay)
      : srMtfOutcome(item, rawDay)
  Object.assign(item, result)
}

const symbolsValue = JSON.parse(fs.readFileSync(path.join(ROOT, "db", "stocks"), "utf8"))
if (!Array.isArray(symbolsValue)) fail("db/stocks must contain a JSON array of symbols.")
const symbols = [...new Set(symbolsValue.map(String).filter(Boolean))]
const rawCache = new Map()
for (const [index, symbol] of [...symbols, "NIFTY50"].entries()) {
  rawCache.set(symbol, loadRows(symbol))
  if ((index + 1) % 50 === 0 || index === symbols.length) process.stdout.write(`\rLoading candles ${index + 1}/${symbols.length + 1}`)
}
process.stdout.write("\n")

const dates = sessionDates(rawCache.get("NIFTY50") ?? [], to).filter(date => date >= from && date <= to)
if (!dates.length) fail(`No NIFTY50 candle sessions are stored between ${from} and ${to}.`)

const signals = []
const emitted = new Set()
for (const [dateIndex, date] of dates.entries()) {
  const dateSignalStart = signals.length
  const profileTimes = { started: Date.now() }
  const cache = cacheThroughDate(rawCache, symbols, date)
  profileTimes.cache = Date.now()
  const needsEmaPreparation = selectedStrategyIds.has("ema20-40") || selectedStrategyIds.has("pvi-nvi")
  const preparedEma = needsEmaPreparation ? prepareEmaEvaluation(cache, symbols, date) : { dayBySymbol: new Map() }
  profileTimes.ema = Date.now()
  const preparedPviNvi = selectedStrategyIds.has("pvi-nvi") ? preparePviNviEvaluation(cache, symbols, date) : null
  profileTimes.pvi = Date.now()
  const needsSrPreparation = ["sr-mtf", "oct05-loose", "sep29-tight-stop", "sep25-opening-breakout"].some(id => selectedStrategyIds.has(id))
  const preparedSr = needsSrPreparation ? prepareSrEvaluation(cache, symbols, date) : null
  profileTimes.sr = Date.now()
  const evaluatorMs = { pvi: 0, ema: 0, sr: 0, oct05: 0, sep29: 0, sep25: 0 }

  for (let minute = MARKET_OPEN; minute <= lastCompletedMinute; minute++) {
    const found = []
    let evaluatorStarted
    if (selectedStrategyIds.has("pvi-nvi") && minute >= 556 && minute <= 579) { evaluatorStarted = Date.now(); found.push(...evaluatePviNvi(cache, symbols, date, minute, preparedPviNvi)); evaluatorMs.pvi += Date.now() - evaluatorStarted }
    if (selectedStrategyIds.has("ema20-40") && minute <= 900) { evaluatorStarted = Date.now(); found.push(...evaluateEma(cache, symbols, date, minute, preparedEma)); evaluatorMs.ema += Date.now() - evaluatorStarted }
    if (selectedStrategyIds.has("sr-mtf") && minute <= 614) { evaluatorStarted = Date.now(); found.push(...evaluateSr(cache, symbols, date, minute, preparedSr)); evaluatorMs.sr += Date.now() - evaluatorStarted }
    if (selectedStrategyIds.has("oct05-loose") && minute >= 569 && minute <= 599) { evaluatorStarted = Date.now(); found.push(...evaluateOct05Loose(cache, symbols, date, minute, preparedSr)); evaluatorMs.oct05 += Date.now() - evaluatorStarted }
    if (selectedStrategyIds.has("sep29-tight-stop") && minute <= 629) { evaluatorStarted = Date.now(); found.push(...evaluateSep29TightStop(cache, symbols, date, minute, preparedSr)); evaluatorMs.sep29 += Date.now() - evaluatorStarted }
    if (selectedStrategyIds.has("sep25-opening-breakout") && minute <= 580) { evaluatorStarted = Date.now(); found.push(...evaluateSep25OpeningBreakout(cache, symbols, date, minute, preparedSr)); evaluatorMs.sep25 += Date.now() - evaluatorStarted }

    for (const item of found) {
      // Match live behaviour: after one strategy emits for a stock, no other
      // live strategy may emit another signal for that stock that session.
      const key = `${item.date}|${item.symbol}`
      if (emitted.has(key)) continue
      emitted.add(key)
      signals.push(item)
    }
  }
  for (const item of signals.slice(dateSignalStart)) attachOutcome(item, cache, preparedEma)
  profileTimes.replay = Date.now()
  if (profile) console.error(`\n${date} timing ms: cache=${profileTimes.cache - profileTimes.started}, emaPrepare=${profileTimes.ema - profileTimes.cache}, pviPrepare=${profileTimes.pvi - profileTimes.ema}, srPrepare=${profileTimes.sr - profileTimes.pvi}, replay=${profileTimes.replay - profileTimes.sr} (pvi=${evaluatorMs.pvi}, ema=${evaluatorMs.ema}, sr=${evaluatorMs.sr}, oct05=${evaluatorMs.oct05}, sep29=${evaluatorMs.sep29}, sep25=${evaluatorMs.sep25})`)
  process.stdout.write(`\r[${dateIndex + 1}/${dates.length}] ${date} · replaying completed 1m candles through six live strategies · ${signals.filter(item => item.date === date).length} signal(s)`)
}
process.stdout.write("\n")

signals.sort((left, right) => left.date.localeCompare(right.date) || left.signalTime.localeCompare(right.signalTime) || left.strategyName.localeCompare(right.strategyName) || left.symbol.localeCompare(right.symbol))
const byStrategy = Object.fromEntries(strategies.map(strategy => [strategy.name, signals.filter(item => item.strategyId === strategy.id).length]))
const evaluated = signals.filter(item => Number.isFinite(item.returnPct))
const byStrategyPerformance = Object.fromEntries(strategies.map(strategy => {
  const trades = signals.filter(item => item.strategyId === strategy.id && Number.isFinite(item.returnPct))
  const winners = trades.filter(item => item.returnPct > 0).length
  const losers = trades.filter(item => item.returnPct < 0).length
  const flats = trades.length - winners - losers
  const totalReturn = trades.reduce((sum, item) => sum + item.returnPct, 0)
  const totalReturnPct = round(totalReturn)
  return [strategy.name, {
    evaluatedTrades: trades.length,
    winners,
    losers,
    flats,
    winRatePct: trades.length ? round(100 * winners / trades.length, 2) : null,
    averageReturnPct: trades.length ? round(totalReturn / trades.length) : null,
    totalReturnPct,
  }]
}))
const returns = evaluated.map(item => item.returnPct)
const dayReturns = new Map()
for (const item of evaluated) dayReturns.set(item.date, (dayReturns.get(item.date) ?? 0) + item.returnPct)
const worstDay = [...dayReturns].sort((left, right) => left[1] - right[1])[0] ?? null
const summary = {
  from,
  to,
  sessions: dates.length,
  stocks: symbols.length,
  signals: signals.length,
  chronological: true,
  evaluatedTrades: evaluated.length,
  winRatePct: returns.length ? round(100 * returns.filter(value => value > 0).length / returns.length, 2) : null,
  averageReturnPct: returns.length ? round(returns.reduce((sum, value) => sum + value, 0) / returns.length) : null,
  totalReturnPct: round(returns.reduce((sum, value) => sum + value, 0)),
  maximumAdverseExcursionPct: evaluated.length ? round(Math.min(...evaluated.map(item => item.maePct).filter(Number.isFinite))) : null,
  worstDay: worstDay ? { date: worstDay[0], totalReturnPct: round(worstDay[1]) } : null,
  candleInterval: "1 minute",
  timezone: "Asia/Kolkata",
  strategyId: strategyId ?? null,
  strategyIds: requestedStrategyIds,
  cutoffTime: cutoffTime ?? "15:30",
  byStrategy,
  byStrategyPerformance,
  strategies,
}
const reportLabel = requestedStrategyIds?.join("+") ?? "all-live-strategies"
const reportFile = uniqueReport(`${from}${from === to ? "" : `-to-${to}`}-${reportLabel}-chronological-signals`)
fs.writeFileSync(reportFile, `${JSON.stringify({ summary, signals }, null, 2)}\n`, { flag: "wx" })

console.log("\nSummary")
console.table(strategies.map(strategy => {
  const performance = byStrategyPerformance[strategy.name]
  return {
    Strategy: strategy.name,
    Signals: byStrategy[strategy.name],
    Trades: performance.evaluatedTrades,
    Winners: performance.winners,
    Losers: performance.losers,
    Flats: performance.flats,
    "Win rate %": performance.winRatePct ?? "-",
    "Total return %": performance.totalReturnPct ?? "-",
  }
}))
console.table([{
  Trades: summary.evaluatedTrades,
  "Win rate %": summary.winRatePct,
  "Average return %": summary.averageReturnPct,
  "Total return %": summary.totalReturnPct,
  "Max adverse %": summary.maximumAdverseExcursionPct,
  "Worst day": summary.worstDay ? `${summary.worstDay.date} (${summary.worstDay.totalReturnPct}%)` : "-",
}])
console.log("\nSignals")
console.table(signals.map(item => ({
  Date: item.date,
  Strategy: item.strategyName,
  Stock: item.symbol,
  Side: item.side,
  Time: item.signalTime,
  Entry: item.entryPrice == null ? "-" : `${item.entryTime} @ ${item.entryPrice}`,
  Exit: item.exitPrice == null ? "-" : `${item.exitTime} @ ${item.exitPrice}`,
  Reason: item.exitReason ?? "-",
  "Return %": item.returnPct ?? "-",
  "MAE %": item.maePct ?? "-",
})))
