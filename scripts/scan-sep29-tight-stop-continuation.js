#!/usr/bin/env node

// 2026-09-29 mover-derived, causal continuation setup.  Signal features are
// computed from the candle that has just closed; execution is the next minute's
// open.  The target is +1.10% and the hard stop is -0.80%.

import fs from "node:fs"
import path from "node:path"

const ROOT = process.cwd(), REPORTS = path.join(ROOT, "reports"), IST_MS = 330 * 60_000
const args = process.argv.slice(2), valueFor = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null }
const date = valueFor("--date"), from = valueFor("--from") || date, to = valueFor("--to") || date
if (!from || !to || !/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to) || from > to) {
  throw new Error("Usage: node scripts/scan-sep29-tight-stop-continuation.js --date YYYY-MM-DD | --from YYYY-MM-DD --to YYYY-MM-DD")
}

const TARGET_PCT = 1.1, STOP_PCT = .8
const round = (value, digits = 3) => Number.isFinite(value) ? +value.toFixed(digits) : null
const minuteOf = value => +value.slice(0, 2) * 60 + +value.slice(3)
const clock = value => `${String(Math.floor(value / 60)).padStart(2, "0")}:${String(value % 60).padStart(2, "0")}`

function latestReports() {
  const latest = new Map()
  for (const name of fs.readdirSync(REPORTS)) {
    const match = /^(\d{4}-\d{2}-\d{2})-top-movers-support-resistance-price-action-mtf-universe-first-signal(?:-\d+)?\.json$/.exec(name)
    if (!match) continue
    const file = path.join(REPORTS, name), modified = fs.statSync(file).mtimeMs, prior = latest.get(match[1])
    if (!prior || modified > prior.modified) latest.set(match[1], { file, modified })
  }
  return latest
}

const candleCache = new Map()
function sessionCandles(symbol, sessionDate) {
  if (!candleCache.has(symbol)) {
    const dates = new Map(), file = path.join(ROOT, "db", "candles", `${symbol}.jsonl`)
    if (fs.existsSync(file)) for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
      try {
        if (!line) continue
        const row = JSON.parse(line), stamp = new Date(+row.time * 1000 + IST_MS).toISOString(), dateKey = stamp.slice(0, 10)
        const candle = { minute: +stamp.slice(11, 13) * 60 + +stamp.slice(14, 16), open: +row.open, high: +row.high, low: +row.low, close: +row.close }
        if (Object.values(candle).every(Number.isFinite)) (dates.get(dateKey) || (dates.set(dateKey, []), dates.get(dateKey))).push(candle)
      } catch {}
    }
    for (const candles of dates.values()) candles.sort((left, right) => left.minute - right.minute)
    candleCache.set(symbol, dates)
  }
  return candleCache.get(symbol).get(sessionDate) || []
}

function passes(row) {
  return row.breakoutDistancePct >= .165 && row.breakoutDistancePct <= .247 &&
    row.efficiency10 >= 1.625 && row.efficiency10 <= 2.186 &&
    row.signalMoveFromOpenPct >= .879 && row.volumeRatio10 <= .81
}

function execute(row, sessionDate) {
  const candles = sessionCandles(row.symbol, sessionDate), entryMinute = minuteOf(row.entryTime)
  const entryCandle = candles.find(candle => candle.minute === entryMinute)
  if (!entryCandle) return null
  const entry = entryCandle.open, buy = row.side === "BUY"
  const target = entry * (buy ? 1.011 : .989), stop = entry * (buy ? .992 : 1.008)
  let worstAdversePct = 0, exit = candles.filter(candle => candle.minute >= entryMinute && candle.minute <= 929).at(-1), reason = "CUTOFF"
  for (const candle of candles) {
    if (candle.minute < entryMinute || candle.minute > 929) continue
    worstAdversePct = Math.min(worstAdversePct, buy ? 100 * (candle.low / entry - 1) : 100 * (1 - candle.high / entry))
    const stopped = buy ? candle.low <= stop : candle.high >= stop
    const targeted = buy ? candle.high >= target : candle.low <= target
    if (stopped) { exit = { ...candle, close: stop }; reason = targeted ? "STOP_SAME_BAR_AS_TARGET" : "STOP"; break }
    if (targeted) { exit = { ...candle, close: target }; reason = "TARGET"; break }
  }
  const exitPrice = exit.close, direction = buy ? 1 : -1
  return { date: sessionDate, symbol: row.symbol, side: row.side, signalTime: row.signalTime, entryTime: row.entryTime, entryPrice: round(entry), exitTime: clock(exit.minute), exitPrice: round(exitPrice), exitReason: reason, returnPct: round(direction * 100 * (exitPrice / entry - 1)), maePct: round(worstAdversePct) }
}

const reportByDate = latestReports(), signals = [], missing = []
for (let day = new Date(`${from}T00:00:00Z`); day <= new Date(`${to}T00:00:00Z`); day.setUTCDate(day.getUTCDate() + 1)) {
  const sessionDate = day.toISOString().slice(0, 10), item = reportByDate.get(sessionDate)
  if (!item) { if (day.getUTCDay() > 0 && day.getUTCDay() < 6) missing.push(sessionDate); continue }
  const trades = JSON.parse(fs.readFileSync(item.file, "utf8")).trades || []
  for (const row of trades.filter(passes)) {
    const result = execute(row, sessionDate)
    if (result) signals.push(result)
  }
}

signals.sort((left, right) => left.date.localeCompare(right.date) || left.signalTime.localeCompare(right.signalTime) || left.symbol.localeCompare(right.symbol))
const winners = signals.filter(row => row.returnPct > 0), totalReturn = signals.reduce((sum, row) => sum + row.returnPct, 0)
const dayReturns = new Map(); for (const row of signals) dayReturns.set(row.date, (dayReturns.get(row.date) || 0) + row.returnPct)
const summary = { trades: signals.length, winners: winners.length, losers: signals.length - winners.length, winRatePct: round(100 * winners.length / (signals.length || 1), 1), averageReturnPct: round(totalReturn / (signals.length || 1)), totalReturnPct: round(totalReturn), maxAdversePct: round(Math.min(0, ...signals.map(row => row.maePct))), worstDayPct: dayReturns.size ? round(Math.min(...dayReturns.values())) : 0 }
console.table(signals.map(row => ({ Date: row.date, Symbol: row.symbol, Side: row.side, Signal: row.signalTime, Entry: `${row.entryTime} @ ${row.entryPrice}`, Exit: `${row.exitTime} @ ${row.exitPrice}`, Reason: row.exitReason, "Return %": row.returnPct, "MAE %": row.maePct })))
console.table([{ Strategy: "Sep-29 Tight Stop Continuation", Target: `+${TARGET_PCT}%`, Stop: `-${STOP_PCT}%`, Trades: summary.trades, Winners: summary.winners, Losers: summary.losers, "Win rate %": summary.winRatePct, "Average return %": summary.averageReturnPct, "Total return %": summary.totalReturnPct, "Max adverse %": summary.maxAdversePct, "Worst day %": summary.worstDayPct }])
if (missing.length) console.log(`Missing causal event reports: ${missing.join(", ")}`)
