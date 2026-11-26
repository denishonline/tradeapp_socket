import fs from "node:fs"
import path from "node:path"
import { candidates, buyCandidates, barsBySymbol, outcome, symbols } from "./research-selective-breakdown-candidates.js"

const root = process.cwd(), date = process.argv[2] ?? "2026-10-21"
const diagnostic = process.argv.includes("--diagnostic")
const summaryOnly = process.argv.includes("--summary")
const jsonOnly = process.argv.includes("--json")
const selectedSide = (process.argv.find(arg => arg.startsWith("--side="))?.slice(7) ?? "BOTH").toUpperCase()
if (!["BUY", "SELL", "BOTH"].includes(selectedSide)) throw new Error("--side must be BUY, SELL, or BOTH")
if (process.argv.slice(3).some(arg => !["--diagnostic", "--summary", "--json"].includes(arg) && !arg.startsWith("--side="))) {
  throw new Error("Unknown option; use --side=BUY|SELL|BOTH, --summary, --diagnostic, or --json")
}
const mean = values => values.reduce((sum, value) => sum + value, 0) / values.length
const round = (value, places = 3) => Number(value.toFixed(places))
const minute = value => Number(value.slice(0, 2)) * 60 + Number(value.slice(3, 5))
const stamp = iso => new Date(Date.parse(iso) + 330 * 60_000).toISOString().slice(0, 16).replace("T", " ")

// Index state is built forward one completed one-minute candle at a time.
const niftyByMinute = new Map()
const niftyFile = path.join(root, "db", "candles", "NIFTY50.jsonl")
let niftyEma9 = null, niftyEma20 = null
for (const line of fs.readFileSync(niftyFile, "utf8").split(/\r?\n/)) {
  if (!line) continue
  let candle
  try { candle = JSON.parse(line) } catch { continue }
  const time = Number(candle.time), close = Number(candle.close)
  if (!Number.isFinite(time) || !Number.isFinite(close) || close <= 0) continue
  const ist = new Date(time * 1000 + 330 * 60_000).toISOString().slice(0, 16)
  if (ist.slice(0, 10) !== date) continue
  const m = minute(ist.slice(11))
  if (niftyByMinute.has(m)) continue
  niftyEma9 = niftyEma9 === null ? close : close * (2 / 10) + niftyEma9 * (8 / 10)
  niftyEma20 = niftyEma20 === null ? close : close * (2 / 21) + niftyEma20 * (19 / 21)
  niftyByMinute.set(m, { close, ema9: niftyEma9, ema20: niftyEma20 })
}
function niftyAtSignal(signalMinute) {
  const current = niftyByMinute.get(signalMinute)
  const fiveAgo = niftyByMinute.get(signalMinute - 5)
  const emaThreeAgo = niftyByMinute.get(signalMinute - 3)
  if (!current || !fiveAgo || !emaThreeAgo) return {
    available: false, close: current?.close ?? null, fiveMinuteMovePct: null,
    closeVsEma9Pct: null, ema9VsEma20Pct: null, ema9ThreeMinuteSlopePct: null
  }
  const fiveMinuteMovePct = round(100 * (current.close / fiveAgo.close - 1))
  const closeVsEma9Pct = round(100 * (current.close / current.ema9 - 1))
  const ema9VsEma20Pct = round(100 * (current.ema9 / current.ema20 - 1))
  const ema9ThreeMinuteSlopePct = round(100 * (current.ema9 / emaThreeAgo.ema9 - 1))
  return { available: true, close: current.close, fiveMinuteMovePct,
    closeVsEma9Pct, ema9VsEma20Pct, ema9ThreeMinuteSlopePct }
}

// At minute m, breadth uses each symbol's latest completed candle no later than m.
const breadth = new Map()
for (let m = 555; m <= 690; m++) {
  let down = 0, covered = 0
  for (const rows of barsBySymbol.values()) {
    if (!rows.length || rows[0].minute > m) continue
    const latest = rows.findLast(row => row.minute <= m)
    if (!latest) continue
    covered++
    if (latest.close < rows[0].open) down++
  }
  let up = 0
  for (const rows of barsBySymbol.values()) {
    if (!rows.length || rows[0].minute > m) continue
    const latest = rows.findLast(row => row.minute <= m)
    if (latest?.close > rows[0].open) up++
  }
  breadth.set(m, { down, up, covered, downPct: round(100 * down / covered), upPct: round(100 * up / covered) })
}

function depthAtSignal(symbol, signalMinute) {
  const file = path.join(root, "db", "cash-depth", date, symbol, `${symbol}.jsonl`)
  if (!fs.existsSync(file)) return { minutes: 0, snapshots: 0, sellSharePct: null, midpointMovePct: null }
  const state = {}, groups = new Map()
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    if (!line) continue
    let event
    try { event = JSON.parse(line) } catch { continue }
    const time = stamp(event.receivedAt)
    if (time.slice(0, 10) !== date) continue
    const m = minute(time.slice(11))
    if (m > signalMinute) break
    if (event.kind === "checkpoint") for (const key of Object.keys(state)) delete state[key]
    Object.assign(state, event.data ?? {})
    if (m < signalMinute - 4) continue
    let bid = 0, ask = 0, valid = true
    for (let level = 1; level <= 5; level++) {
      const bp = +state[`bid_price${level}`], ap = +state[`ask_price${level}`]
      const bs = +state[`bid_size${level}`], as = +state[`ask_size${level}`]
      if (![bp, ap, bs, as].every(Number.isFinite) || bp <= 0 || ap <= bp) { valid = false; break }
      bid += bs; ask += as
    }
    if (!valid || bid + ask <= 0) continue
    const values = groups.get(m) ?? []
    values.push({ sellShare: 100 * ask / (bid + ask), bidShare: 100 * bid / (bid + ask),
      midpoint: (+state.bid_price1 + +state.ask_price1) / 2 })
    groups.set(m, values)
  }
  const minutes = Array.from({ length: 5 }, (_, k) => groups.get(signalMinute - 4 + k)).filter(Boolean)
  const perMinute = minutes.map(group => ({ sellShare: mean(group.map(x => x.sellShare)),
    bidShare: mean(group.map(x => x.bidShare)), midpoint: mean(group.map(x => x.midpoint)) }))
  return { minutes: minutes.length, snapshots: minutes.reduce((sum, x) => sum + x.length, 0),
    sellSharePct: minutes.length === 5 ? round(mean(perMinute.map(x => x.sellShare))) : null,
    bidSharePct: minutes.length === 5 ? round(mean(perMinute.map(x => x.bidShare))) : null,
    midpointMovePct: minutes.length >= 2 ? round(100 * (perMinute.at(-1).midpoint / perMinute[0].midpoint - 1)) : null }
}

// Only fields available at the signal minute are read by this selection logic.
function candlePass(row) {
  if (row.signalMinute > 690 || row.signalVolumeMultiple < 1 || row.signalBodyPct < .05) return false
  return row.side === "SELL"
    ? row.belowVwapPct >= .2 && row.signalVs5AgoPct <= -.2 && row.signalVsOpenPct <= -1
    : row.aboveVwapPct >= .2 && row.signalVs5AgoPct >= .2 && row.signalVsOpenPct >= 1
}

const signalCandidates = [], signals = [], used = new Set()
const sideCounts = { BUY: 0, SELL: 0 }
const chronological = [...candidates, ...buyCandidates]
  .filter(row => selectedSide === "BOTH" || row.side === selectedSide)
  .sort((a, b) => a.signalTime.localeCompare(b.signalTime) || a.symbol.localeCompare(b.symbol))
for (const row of chronological) {
  if (!candlePass(row) || used.has(row.symbol)) continue
  const book = depthAtSignal(row.symbol, row.signalMinute)
  const market = breadth.get(row.signalMinute)
  const nifty = niftyAtSignal(row.signalMinute)
  const current = { ...row, depth: book, marketBreadth: market, nifty }
  signalCandidates.push(current)
  const directionalDepth = row.side === "SELL" ? book.sellSharePct : book.bidSharePct
  const directionalBreadth = row.side === "SELL" ? market.downPct : market.upPct
  if (book.minutes !== 5 || directionalDepth < 48 || directionalBreadth < 65 || sideCounts[row.side] >= 15) continue
  used.add(row.symbol)
  sideCounts[row.side]++
  signals.push(current)
}
function evaluate(row) {
  const rows = barsBySymbol.get(row.symbol)
  const entryIndex = rows.findIndex(bar => bar.time === row.entryTime)
  if (entryIndex < 0) throw new Error(`Missing entry candle: ${row.symbol} ${row.entryTime}`)
  const result = outcome(rows, entryIndex, row.side)
  return { exitTime: result.exitTime, exitReason: result.reason,
    returnPct: round(result.returnPct), favorableMovePct: round(result.mfe), adverseMovePct: round(result.mae) }
}
for (const row of signals) Object.assign(row, evaluate(row))
const sum = values => values.reduce((total, value) => total + value, 0)
const summary = { signalCount: signals.length,
  buySignalCount: sideCounts.BUY, sellSignalCount: sideCounts.SELL,
  targetHits: signals.filter(x => x.exitReason === "target").length,
  stopped: signals.filter(x => x.exitReason === "stop").length,
  sessionEnd: signals.filter(x => x.exitReason === "sessionEnd").length,
  winRatePct: signals.length ? round(100 * signals.filter(x => x.returnPct > 0).length / signals.length) : null,
  averageReturnPct: signals.length ? round(mean(signals.map(x => x.returnPct))) : null,
  totalReturnPct: round(sum(signals.map(x => x.returnPct))),
  maximumAdverseExcursionPct: signals.length ? round(Math.max(...signals.map(x => x.adverseMovePct))) : null,
  worstDay: signals.length ? { date, totalReturnPct: round(sum(signals.map(x => x.returnPct))) } : null }
if (summaryOnly) {
  console.log(JSON.stringify({ date, selectedSide, candlePassCount: signalCandidates.length, ...summary,
    signals: signals.map(x => `${x.signalTime.slice(11)} ${x.side} ${x.symbol} ${x.exitReason}`) }))
} else if (diagnostic) {
  console.log(JSON.stringify({ date, selectedSide, candlePassCount: signalCandidates.length,
    candidates: signalCandidates.map(x => ({ symbol: x.symbol, side: x.side, time: x.signalTime.slice(11),
      directionalDepthPct: x.side === "SELL" ? x.depth.sellSharePct : x.depth.bidSharePct,
      depthMinutes: x.depth.minutes,
      directionalBreadthPct: x.side === "SELL" ? x.marketBreadth.downPct : x.marketBreadth.upPct,
      nifty: x.nifty,
      selected: signals.includes(x), outcome: evaluate(x).exitReason })) }, null, 2))
} else {
  const report = { date, selectedSide, universeCount: symbols.length, sessionTimezone: "Asia/Kolkata",
    rules: { oneMinuteCandles: true, previousCandles: 10,
      ema9RangeMaxPct: .75, ema45RangeMaxPct: .3, vwapRangeMaxPct: .15,
      directionalIndicatorsMin: 2,
      sellAlignment: "close < EMA9 < EMA45 < VWAP; bearish close < open and previous close; previous candle not fully aligned",
      buyAlignment: "close > EMA9 > EMA45 > VWAP; bullish close > open and previous close; previous candle not fully aligned",
      cutoffTime: "11:30", signalBodyMinPct: .05, volumeVsPreviousFiveMin: 1,
      directionalVwapDistanceMinPct: .2, directionalFiveMinuteMoveMinPct: .2, directionalSessionMoveMinPct: 1,
      displayedFiveLevelDirectionalShareMinPct: 48, depthMinutesRequired: 5,
      directionalMarketBreadthMinPct: 65,
      nifty50Momentum: "signal-time NIFTY50 close vs intraday EMA9/EMA20, EMA9 three-minute slope, and five-minute close move",
      uniqueStockSignalsAcrossSides: true, maximumSignalsPerSide: 15,
      entry: "next completed one-minute candle close", targetPct: 1.55, stopPct: .75,
      exit: "first target, stop, or session-end; stop first if both levels touched in the same candle" },
    summary, signals }
  if (jsonOnly) {
    console.log(JSON.stringify(report))
  } else {
    const output = path.join(root, "reports", `${date}-selective-two-sided-live-replay-1p55-${selectedSide.toLowerCase()}-nifty50-context.json`)
    if (fs.existsSync(output)) throw new Error(`Report exists: ${output}`)
    fs.writeFileSync(output, JSON.stringify(report, null, 2) + "\n")
    console.log(JSON.stringify({ output, ...summary, signals: signals.map(x => ({ symbol: x.symbol, side: x.side,
      signalTime: x.signalTime, entryTime: x.entryTime, exitTime: x.exitTime,
      exitReason: x.exitReason, returnPct: x.returnPct,
      directionalDepthPct: x.side === "SELL" ? x.depth.sellSharePct : x.depth.bidSharePct,
      directionalBreadthPct: x.side === "SELL" ? x.marketBreadth.downPct : x.marketBreadth.upPct,
      niftyFiveMinuteMovePct: x.nifty.fiveMinuteMovePct })) }, null, 2))
  }
}
