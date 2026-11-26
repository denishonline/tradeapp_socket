// Usage:
//   node scripts/backtest-selective-breakdown-range.js 2026-10-19
//   node scripts/backtest-selective-breakdown-range.js 2026-10-05 2026-10-19
//   node scripts/backtest-selective-breakdown-range.js 2026-10-19 --side=BUY
// Dates are inclusive; only sessions present in db/candles/NIFTY50.jsonl run.
import fs from "node:fs"
import path from "node:path"
import { execFileSync } from "node:child_process"
import { randomUUID } from "node:crypto"

const root = process.cwd()
const args = process.argv.slice(2)
const sideArgs = args.filter(arg => arg.startsWith("--side="))
const side = (sideArgs[0]?.slice(7) ?? "BOTH").toUpperCase()
const [from, to = from, extra] = args.filter(arg => !arg.startsWith("--side="))
const validDate = value => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value ?? "")) return false
  const parsed = new Date(`${value}T00:00:00.000Z`)
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value
}
if (extra || sideArgs.length > 1 || !["BUY", "SELL", "BOTH"].includes(side) ||
  !validDate(from) || !validDate(to) || from > to) {
  throw new Error("Usage: node scripts/backtest-selective-breakdown-range.js YYYY-MM-DD [YYYY-MM-DD] [--side=BUY|SELL|BOTH]; start must be <= end")
}

const niftyFile = path.join(root, "db", "candles", "NIFTY50.jsonl")
const available = new Set()
for (const line of fs.readFileSync(niftyFile, "utf8").split(/\r?\n/)) {
  if (!line) continue
  let candle
  try { candle = JSON.parse(line) } catch { continue }
  const epoch = Number(candle.time)
  if (!Number.isFinite(epoch)) continue
  available.add(new Date(epoch * 1000 + 330 * 60_000).toISOString().slice(0, 10))
}
const allSessions = [...available].sort()
if (!allSessions.length || from < allSessions[0] || to > allSessions.at(-1)) {
  throw new Error(`Requested dates exceed NIFTY50 candle coverage (${allSessions[0] ?? "none"} to ${allSessions.at(-1) ?? "none"})`)
}
const sessionDates = allSessions.filter(date => date >= from && date <= to)
if (!sessionDates.length) throw new Error(`No candle session exists between ${from} and ${to}`)
for (const date of sessionDates) {
  if (!fs.existsSync(path.join(root, "db", "cash-depth", date))) {
    throw new Error(`Cash-depth directory is missing for ${date}`)
  }
}

const dailyScript = path.join(root, "scripts", "backtest-selective-breakdown-live-replay.js")
const days = []
for (const date of sessionDates) {
  const output = execFileSync(process.execPath, [dailyScript, date, "--json", `--side=${side}`], {
    cwd: root, encoding: "utf8", maxBuffer: 16 * 1024 * 1024
  })
  const day = JSON.parse(output)
  days.push(day)
  console.log(`${date}: ${day.summary.buySignalCount} BUY, ${day.summary.sellSignalCount} SELL, ${day.summary.targetHits} targets`)
}

const signals = days.flatMap(day => day.signals).sort((a, b) =>
  a.signalTime.localeCompare(b.signalTime) || a.symbol.localeCompare(b.symbol))
const sum = values => values.reduce((total, value) => total + value, 0)
const round = value => Number(value.toFixed(3))
const totalReturnPct = round(sum(signals.map(signal => signal.returnPct)))
const tradedDays = days.filter(day => day.summary.signalCount > 0)
const worst = tradedDays.length
  ? [...tradedDays].sort((a, b) => a.summary.totalReturnPct - b.summary.totalReturnPct)[0]
  : null
const summary = {
  sessionCount: days.length,
  daysWithSignals: tradedDays.length,
  tradeCount: signals.length,
  buySignalCount: signals.filter(signal => signal.side === "BUY").length,
  sellSignalCount: signals.filter(signal => signal.side === "SELL").length,
  targetHits: signals.filter(signal => signal.exitReason === "target").length,
  buyTargetHits: signals.filter(signal => signal.side === "BUY" && signal.exitReason === "target").length,
  sellTargetHits: signals.filter(signal => signal.side === "SELL" && signal.exitReason === "target").length,
  stopped: signals.filter(signal => signal.exitReason === "stop").length,
  sessionEnd: signals.filter(signal => signal.exitReason === "sessionEnd").length,
  winRatePct: signals.length ? round(100 * signals.filter(signal => signal.returnPct > 0).length / signals.length) : null,
  averageReturnPct: signals.length ? round(totalReturnPct / signals.length) : null,
  totalReturnPct,
  maximumAdverseExcursionPct: signals.length ? round(Math.max(...signals.map(signal => signal.adverseMovePct))) : null,
  worstDay: worst ? { date: worst.date, totalReturnPct: worst.summary.totalReturnPct } : null
}
const report = {
  requestedRange: { from, to }, selectedSide: side, sessionDates, timezone: "Asia/Kolkata",
  candleSource: "db/candles/<SYMBOL>.jsonl; db/candles/NIFTY50.jsonl for index momentum and available sessions",
  depthSource: "db/cash-depth/<YYYY-MM-DD>/",
  returnNote: "Returns are summed across trades and are not a portfolio equity curve; overlapping stocks are allowed. Target/stop fills are assumed, before costs.",
  rules: days[0].rules,
  summary,
  daily: days.map(day => ({ date: day.date, ...day.summary })),
  signals
}

const csvColumns = ["symbol", "side", "signalTime", "entryTime", "entryPrice", "exitTime", "exitReason",
  "returnPct", "favorableMovePct", "adverseMovePct", "signalVolumeMultiple",
  "signalVs5AgoPct", "directionalVwapGapPct", "fiveLevelDirectionalDepthPct", "directionalMarketBreadthPct",
  "niftyFiveMinuteMovePct", "niftyCloseVsEma9Pct", "niftyEma9ThreeMinuteSlopePct"]
const quote = value => `"${String(value ?? "").replaceAll('"', '""')}"`
const csvRows = signals.map(signal => ({
  ...signal,
  directionalVwapGapPct: signal.side === "BUY" ? signal.aboveVwapPct : signal.belowVwapPct,
  fiveLevelDirectionalDepthPct: signal.side === "BUY" ? signal.depth?.bidSharePct : signal.depth?.sellSharePct,
  directionalMarketBreadthPct: signal.side === "BUY" ? signal.marketBreadth?.upPct : signal.marketBreadth?.downPct,
  niftyFiveMinuteMovePct: signal.nifty?.fiveMinuteMovePct,
  niftyCloseVsEma9Pct: signal.nifty?.closeVsEma9Pct,
  niftyEma9ThreeMinuteSlopePct: signal.nifty?.ema9ThreeMinuteSlopePct
}))
const csv = [csvColumns.map(quote).join(","),
  ...csvRows.map(row => csvColumns.map(column => quote(row[column])).join(","))].join("\n") + "\n"

const runId = `${new Date().toISOString().replace(/[-:.]/g, "").slice(0, 15)}-${randomUUID().slice(0, 8)}`
const base = `selective-two-sided-${side.toLowerCase()}-nifty50-context-${from}-to-${to}-${runId}`
const jsonPath = path.join(root, "reports", `${base}.json`)
const csvPath = path.join(root, "csv", `${base}-signals.csv`)
fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2) + "\n", { flag: "wx" })
fs.writeFileSync(csvPath, csv, { flag: "wx" })
console.log(JSON.stringify({ report: jsonPath, signalsCsv: csvPath, ...summary }, null, 2))
