#!/usr/bin/env node

// Frozen exploratory strategy discovered from 2026-10-05 no-gap movers.
// It is intentionally separate from the existing S/R MTF strategy.

import fs from "node:fs"
import path from "node:path"
import { spawnSync } from "node:child_process"

const ROOT = process.cwd(), REPORTS = path.join(ROOT, "reports"), IST_MS = 330 * 60_000
const SOURCE_SCANNER = path.join(ROOT, "scripts", "research-oct29-mover-support-resistance-mtf.js")
const arg = name => { const index = process.argv.indexOf(name); return index < 0 ? null : process.argv[index + 1] }
const has = name => process.argv.includes(name)
const usage = [
  "Usage:",
  "  node scripts/scan-oct05-prior-level-break-continuation.js --date YYYY-MM-DD",
  "  node scripts/scan-oct05-prior-level-break-continuation.js --from YYYY-MM-DD --to YYYY-MM-DD",
  "  Add --fresh to rebuild causal all-stock S/R events from db/candles first.",
  "  --profile narrow|loose  narrow is the original 09:44–09:51 prior-level break; loose is the 09:30–10:00 high-volume BUY retest profile.",
  "  --stop PCT             Stop-loss percent; default 1.30 for narrow and 0.80 for loose.",
  "",
  "Frozen rule: prior-session level break, completed signal from 09:44–09:51,",
  "directional move from open >= 0.45%, and 10-bar volume ratio >= 1.21.",
  "Entry: next one-minute open. Exit: +1.10% target, -1.30% stop, or 15:29 cutoff.",
].join("\n")
const fail = message => { throw new Error(`${message}\n\n${usage}`) }
const round = (value, digits = 3) => Number.isFinite(value) ? +value.toFixed(digits) : null
const minuteOf = value => +value.slice(0, 2) * 60 + +value.slice(3)
const clock = minute => `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`
const parseDate = value => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value ?? "")) fail("Dates must use YYYY-MM-DD")
  const parsed = new Date(`${value}T00:00:00Z`)
  if (Number.isNaN(parsed) || parsed.toISOString().slice(0, 10) !== value) fail(`Invalid date: ${value}`)
  return value
}
const oneDate = arg("--date"), fromArg = arg("--from"), toArg = arg("--to")
if (oneDate && (fromArg || toArg)) fail("Use --date or --from/--to, not both")
if (!oneDate && (!fromArg || !toArg)) fail("Provide --date or both --from and --to")
const from = parseDate(oneDate ?? fromArg), to = parseDate(oneDate ?? toArg)
if (from > to) fail("--from must be on or before --to")
if (has("--help")) { console.log(usage); process.exit(0) }
const profile = (arg("--profile") ?? "narrow").toLowerCase()
if (!["narrow", "loose"].includes(profile)) fail("--profile must be narrow or loose")
const stopPct = Number(arg("--stop") ?? (profile === "loose" ? .8 : 1.3))
if (!(stopPct > 0)) fail("--stop must be positive")

function availableSessions() {
  const file = path.join(ROOT, "db", "candles", "NIFTY50.jsonl")
  if (!fs.existsSync(file)) fail("NIFTY50 candle data is required to identify available NSE sessions")
  const sessions = new Set()
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    try {
      if (!line) continue
      const stamp = new Date(+JSON.parse(line).time * 1000 + IST_MS).toISOString()
      const marketMinute = +stamp.slice(11, 13) * 60 + +stamp.slice(14, 16)
      if (marketMinute >= 555 && marketMinute < 930) sessions.add(stamp.slice(0, 10))
    } catch {}
  }
  return [...sessions].filter(date => date >= from && date <= to).sort()
}

function rebuildCausalEvents() {
  const sessions = availableSessions()
  if (!sessions.length) fail(`No available NSE sessions from ${from} through ${to}`)
  console.log(`Fresh rebuild: scanning ${sessions.length} stored NSE session(s) from db/candles...`)
  for (const [index, date] of sessions.entries()) {
    process.stdout.write(`[${index + 1}/${sessions.length}] ${date}\r`)
    const result = spawnSync(process.execPath, [SOURCE_SCANNER, date, "--universe"], {
      cwd: ROOT, encoding: "utf8", windowsHide: true, maxBuffer: 64 * 1024 * 1024,
    })
    if (result.status !== 0) throw new Error(`Fresh causal scan failed for ${date}: ${result.stderr || result.stdout}`)
  }
  process.stdout.write("\n")
}

if (has("--fresh")) rebuildCausalEvents()

function latestReports() {
  const latest = new Map()
  for (const name of fs.readdirSync(REPORTS)) {
    const match = /^(\d{4}-\d{2}-\d{2})-top-movers-support-resistance-price-action-mtf-universe-first-signal(?:-\d+)?\.json$/.exec(name)
    if (!match) continue
    const file = path.join(REPORTS, name), stat = fs.statSync(file), previous = latest.get(match[1])
    if (!previous || stat.mtimeMs > previous.mtimeMs) latest.set(match[1], { file, mtimeMs: stat.mtimeMs })
  }
  return latest
}

function sessionCandles(symbol, date) {
  const file = path.join(ROOT, "db", "candles", `${symbol}.jsonl`)
  if (!fs.existsSync(file)) return []
  return fs.readFileSync(file, "utf8").split(/\r?\n/).flatMap(line => {
    try {
      if (!line) return []
      const row = JSON.parse(line), stamp = new Date(+row.time * 1000 + IST_MS).toISOString()
      if (stamp.slice(0, 10) !== date) return []
      return [{ minute: +stamp.slice(11, 13) * 60 + +stamp.slice(14, 16), open: +row.open, high: +row.high, low: +row.low, close: +row.close }]
    } catch { return [] }
  }).filter(row => Number.isFinite(row.open) && Number.isFinite(row.high) && Number.isFinite(row.low) && Number.isFinite(row.close)).sort((left, right) => left.minute - right.minute)
}

function passes(row) {
  const signalMinute = minuteOf(row.signalTime)
  if (profile === "loose") {
    return row.family === "LEVEL_RETEST" && row.side === "BUY" && signalMinute >= 570 && signalMinute <= 600 &&
      row.breakoutDistancePct >= .328 && row.breakoutDistancePct <= .772 && row.volumeRatio10 >= 6.56 && row.volumeRatio10 <= 13.17
  }
  return row.family === "PRIOR_LEVEL_BREAK" && signalMinute >= 584 && signalMinute <= 591 &&
    row.signalMoveFromOpenPct >= .45 && row.volumeRatio10 >= 1.21
}

function execute(row) {
  const candles = sessionCandles(row.symbol, row.date), entryMinute = minuteOf(row.entryTime)
  const entry = candles.find(candle => candle.minute === entryMinute)?.open ?? row.entryPrice
  if (!Number.isFinite(entry)) return { ...row, error: "No entry candle" }
  const buy = row.side === "BUY", target = entry * 1.011, stop = entry * (buy ? 1 - stopPct / 100 : 1 + stopPct / 100)
  let exit = candles.filter(candle => candle.minute >= entryMinute && candle.minute <= 929).at(-1)
  let reason = "CUTOFF"
  for (const candle of candles.filter(candle => candle.minute >= entryMinute && candle.minute <= 929)) {
    const hitStop = buy ? candle.low <= stop : candle.high >= stop
    const hitTarget = buy ? candle.high >= target : candle.low <= target
    if (hitStop) { exit = { ...candle, close: stop }; reason = hitTarget ? "STOP_SAME_BAR_AS_TARGET" : "STOP"; break }
    if (hitTarget) { exit = { ...candle, close: target }; reason = "TARGET"; break }
  }
  const exitPrice = exit?.close, direction = buy ? 1 : -1
  return { ...row, entryPrice: round(entry), targetPrice: round(target), stopPrice: round(stop), exitTime: exit ? clock(exit.minute) : null, exitPrice: round(exitPrice), exitReason: reason, returnPct: round(direction * 100 * (exitPrice / entry - 1)) }
}

const reportByDate = latestReports(), missing = [], signals = []
for (let current = new Date(`${from}T00:00:00Z`); current <= new Date(`${to}T00:00:00Z`); current.setUTCDate(current.getUTCDate() + 1)) {
  const date = current.toISOString().slice(0, 10), item = reportByDate.get(date)
  if (!item) { if (current.getUTCDay() > 0 && current.getUTCDay() < 6) missing.push(date); continue }
  const trades = JSON.parse(fs.readFileSync(item.file, "utf8")).trades || []
  signals.push(...trades.filter(passes).map(row => execute({ ...row, date })))
}
signals.sort((left, right) => left.date.localeCompare(right.date) || left.signalTime.localeCompare(right.signalTime) || left.symbol.localeCompare(right.symbol))
const valid = signals.filter(row => Number.isFinite(row.returnPct)), winners = valid.filter(row => row.returnPct > 0), activeDays = new Map()
for (const row of valid) activeDays.set(row.date, (activeDays.get(row.date) || 0) + row.returnPct)
const total = valid.reduce((sum, row) => sum + row.returnPct, 0)
const summary = {
  from, to, signals: valid.length, winners: winners.length, losers: valid.length - winners.length,
  winRatePct: valid.length ? round(100 * winners.length / valid.length) : null,
  averageReturnPct: valid.length ? round(total / valid.length) : null, totalReturnPct: round(total),
  maximumAdverseExcursionPct: valid.length ? round(Math.min(...valid.map(row => row.maePct))) : null,
  worstDay: [...activeDays.entries()].sort((left, right) => left[1] - right[1]).at(0) ? { date: [...activeDays.entries()].sort((left, right) => left[1] - right[1])[0][0], totalReturnPct: round([...activeDays.entries()].sort((left, right) => left[1] - right[1])[0][1]) } : null,
  missingCausalEventReports: missing,
}
const rule = profile === "loose"
  ? ["LEVEL_RETEST", "BUY only", "09:30 <= completed signal <= 10:00", "breakout distance from level 0.328%–0.772%", "10-bar volume ratio 6.56–13.17"]
  : ["PRIOR_LEVEL_BREAK", "09:44 <= completed signal <= 09:51", "directional move from open >= 0.45%", "10-bar volume ratio >= 1.21"]
const result = { generatedAt: new Date().toISOString(), timezone: "Asia/Kolkata", strategy: profile === "loose" ? "Oct-05 High-Volume Retest Continuation" : "Oct-05 Prior-Level Break Continuation", profile, rule, execution: { entry: "next 1-minute open", targetPct: 1.1, stopPct, sameBarRule: "stop wins when target and stop occur in the same OHLC candle" }, summary, signals }
let suffix = 1, output
do { output = path.join(REPORTS, `${from}-to-${to}-oct05-${profile}-continuation${suffix === 1 ? "" : `-${suffix}`}.json`); suffix++ } while (fs.existsSync(output))
fs.writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`)
console.table(valid.map(row => ({ Date: row.date, Stock: row.symbol, Side: row.side, Signal: row.signalTime, Entry: `${row.entryTime} @ ${row.entryPrice}`, Exit: `${row.exitTime} @ ${row.exitPrice}`, Reason: row.exitReason, "Return %": row.returnPct })))
console.log(`Totals: ${summary.signals} signals | wins=${summary.winners} | losses=${summary.losers} | win rate=${summary.winRatePct ?? "n/a"}% | average=${summary.averageReturnPct ?? "n/a"}% | total=${summary.totalReturnPct}% | max MAE=${summary.maximumAdverseExcursionPct ?? "n/a"}%`)
if (missing.length) console.warn(`Missing causal-event reports for: ${missing.join(", ")}`)
