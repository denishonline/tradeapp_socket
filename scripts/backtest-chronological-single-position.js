#!/usr/bin/env node
import fs from "node:fs"
import path from "node:path"
import { spawnSync } from "node:child_process"

const ROOT = process.cwd()
const args = process.argv.slice(2)
const value = (flag, fallback = null) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : fallback }
const has = flag => args.includes(flag)
const date = value("--date")
const cutoff = value("--cutoff", "15:30")
const side = String(value("--side", "BUY")).toUpperCase()
const costBps = Number(value("--cost-bps", "10"))
const targetPct = Number(value("--target-pct", "5"))
const minDriverScore = Number(value("--min-driver-score", side === "BUY" ? "6" : "0"))
const startTime = value("--start", "09:15")
const endTime = value("--end", cutoff)
const suppliedSource = value("--source")
const noDriverFilter = has("--no-driver-filter")

function usage(message) {
  if (message) console.error(message)
  console.error("Usage: node scripts/backtest-chronological-single-position.js --date YYYY-MM-DD [options]")
  console.error("Options:")
  console.error("  --cutoff HH:MM             Last actionable time (default 15:30)")
  console.error("  --side BUY|SELL|BOTH       Direction to execute (default BUY)")
  console.error("  --cost-bps N               Total assumed cost per trade in bps (default 10)")
  console.error("  --target-pct N             Compounded return target for reporting (default 5)")
  console.error("  --min-driver-score N       Minimum signal-time driver score")
  console.error("  --start HH:MM              Earliest entry time (default 09:15)")
  console.error("  --end HH:MM                Latest entry time (default cutoff)")
  console.error("  --source FILE              Reuse an existing fixed-29 replay JSON; skip scanning")
  console.error("  --no-driver-filter         Disable the base BUY driver filter during scanning")
  process.exit(1)
}

if (!/^\d{4}-\d{2}-\d{2}$/.test(date ?? "")) usage("A valid --date is required.")
if (!/^\d{2}:\d{2}$/.test(cutoff) || !/^\d{2}:\d{2}$/.test(startTime) || !/^\d{2}:\d{2}$/.test(endTime)) usage("Times must use HH:MM.")
if (!["BUY", "SELL", "BOTH"].includes(side)) usage("--side must be BUY, SELL, or BOTH.")
if (![costBps, targetPct, minDriverScore].every(Number.isFinite) || costBps < 0) usage("Numeric options are invalid.")

const minute = text => { const [h, m] = text.split(":").map(Number); return h * 60 + m }
const round = (x, n = 3) => Number.isFinite(x) ? +x.toFixed(n) : null
const unique = (stem, ext) => { let n = 1, file; do { file = path.join(ROOT, "reports", `${stem}${n === 1 ? "" : `-${n}`}.${ext}`); n++ } while (fs.existsSync(file)); return file }
const csvValue = x => /[",\n]/.test(String(x ?? "")) ? `"${String(x ?? "").replaceAll('"', '""')}"` : String(x ?? "")

function runBaseScan() {
  const script = path.join(ROOT, "scripts", "backtest-fixed-29-filters-cutoff.js")
  const scanArgs = [script, date, cutoff]
  if (noDriverFilter) scanArgs.push("--no-driver-filter")
  const result = spawnSync(process.execPath, scanArgs, { cwd: ROOT, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 })
  if (result.status !== 0) {
    process.stderr.write(result.stdout || "")
    process.stderr.write(result.stderr || "")
    throw new Error(`Base scan failed with exit code ${result.status}`)
  }
  const match = result.stdout.match(/JSON:\s+([^\r\n]+\.json)/)
  if (!match) throw new Error("Base scan completed but its JSON output path was not found.")
  return path.resolve(match[1].trim())
}

const sourceFile = suppliedSource ? path.resolve(ROOT, suppliedSource) : runBaseScan()
if (!fs.existsSync(sourceFile)) throw new Error(`Source replay does not exist: ${sourceFile}`)
const source = JSON.parse(fs.readFileSync(sourceFile, "utf8"))
if (!Array.isArray(source.signals)) throw new Error("Source replay has no signals array.")
if (!String(source.cutoff || "").startsWith(date)) throw new Error(`Source replay date does not match ${date}.`)

const candidates = source.signals
  .filter(row => (side === "BOTH" || row.side === side) && row.driverScore >= minDriverScore)
  .filter(row => row.entryTime >= startTime && row.entryTime <= endTime)
  .sort((a, b) => a.entryTime.localeCompare(b.entryTime) || b.driverScore - a.driverScore || a.symbol.localeCompare(b.symbol))

// One capital slot: a signal is actionable only if flat when its entry opens.
// Signals received while occupied are discarded and never queued.
const trades = []
let flatAtMinute = -Infinity
for (const row of candidates) {
  if (minute(row.entryTime) < flatAtMinute) continue
  trades.push(row)
  flatAtMinute = minute(row.exitTime)
}

const returns = trades.map(row => Number(row.returnPct))
const grossFactor = trades.reduce((factor, row) => factor * (1 + Number(row.returnPct) / 100), 1)
const netFactor = trades.reduce((factor, row) => factor * (1 + Number(row.returnPct) / 100 - costBps / 10_000), 1)
const grossCompounded = 100 * (grossFactor - 1)
const netCompounded = 100 * (netFactor - 1)
const total = returns.reduce((sum, x) => sum + x, 0)
const summary = {
  date,
  cutoff,
  side,
  startTime,
  endTime,
  minDriverScore,
  costBpsPerTrade: costBps,
  candidateSignals: candidates.length,
  executedTrades: trades.length,
  skippedWhilePositionOpen: candidates.length - trades.length,
  winRatePct: round(100 * trades.filter(row => row.returnPct > 0).length / (trades.length || 1)),
  averageReturnPct: round(total / (trades.length || 1)),
  summedReturnPct: round(total),
  compoundedGrossReturnPct: round(grossCompounded),
  compoundedNetReturnPct: round(netCompounded),
  targetPct,
  grossTargetMet: grossCompounded >= targetPct,
  netTargetMet: netCompounded >= targetPct,
  maximumAdverseExcursionPct: trades.length ? round(Math.min(...trades.map(row => row.maximumAdverseExcursionPct))) : null,
  worstDay: { date, compoundedNetReturnPct: round(netCompounded) },
}
const warning = [source.warning, source.driverWarning].filter(Boolean).join(" ")
const methodology = `${source.methodology} Portfolio layer: ${side} signals only${side === "BOTH" ? "" : ` (${side})`}; minimum driver score ${minDriverScore}; one open position; discard signals while occupied; entries limited to ${startTime}-${endTime}; ${costBps} bps total cost charged per executed trade.`
const stem = `${date}-${cutoff.replace(":", "")}-single-position-${side.toLowerCase()}`
const jsonFile = unique(stem, "json"), csvFile = unique(stem, "csv"), mdFile = unique(stem, "md")
fs.writeFileSync(jsonFile, `${JSON.stringify({ warning, sourceFile, methodology, summary, trades }, null, 2)}\n`, { flag: "wx" })
const fields = ["date", "symbol", "side", "crossoverTime", "signalCandleTime", "actionableTime", "driverScore", "driverRuleCount", "entryTime", "entryPrice", "exitTime", "exitPrice", "exitReason", "holdMinutes", "returnPct", "maximumFavorableExcursionPct", "maximumAdverseExcursionPct"]
fs.writeFileSync(csvFile, `${[fields.join(","), ...trades.map(row => fields.map(field => csvValue(row[field])).join(","))].join("\n")}\n`, { flag: "wx" })
const table = ["| Symbol | Side | Signal | Entry | Exit | Driver | Return | MFE | MAE |", "|---|---|---:|---:|---:|---:|---:|---:|---:|", ...trades.map(row => `| ${row.symbol} | ${row.side} | ${row.signalCandleTime} | ${row.entryTime} @ ${row.entryPrice} | ${row.exitTime} @ ${row.exitPrice} | ${row.driverScore}/${row.driverRuleCount} | ${row.returnPct}% | ${row.maximumFavorableExcursionPct}% | ${row.maximumAdverseExcursionPct}% |`)].join("\n")
const report = [`# ${date} chronological single-position backtest`, "", `Warning: ${warning || "The fixed thresholds are research parameters and require out-of-sample validation."}`, "", "## Configuration", "", `- Side: ${side}`, `- Cutoff: ${cutoff} IST`, `- Entry window: ${startTime}-${endTime} IST`, `- Minimum driver score: ${minDriverScore}`, `- Cost: ${costBps} bps per trade`, `- Target: ${targetPct}% compounded`, "", "## Result", "", `- Candidates / executed / skipped while occupied: ${summary.candidateSignals} / ${summary.executedTrades} / ${summary.skippedWhilePositionOpen}`, `- Win rate: ${summary.winRatePct}%`, `- Average / summed return: ${summary.averageReturnPct}% / ${summary.summedReturnPct}%`, `- Compounded gross / net return: ${summary.compoundedGrossReturnPct}% / ${summary.compoundedNetReturnPct}%`, `- Gross / net target met: ${summary.grossTargetMet} / ${summary.netTargetMet}`, `- Worst MAE: ${summary.maximumAdverseExcursionPct}%`, "", "## Trades", "", table, "", `Source replay: ${sourceFile}`, `JSON: ${jsonFile}`, `CSV: ${csvFile}`].join("\n")
fs.writeFileSync(mdFile, `${report}\n`, { flag: "wx" })
console.log(JSON.stringify({ warning, sourceFile, summary, json: jsonFile, csv: csvFile, report: mdFile, trades: trades.map(row => ({ symbol: row.symbol, side: row.side, entryTime: row.entryTime, exitTime: row.exitTime, returnPct: row.returnPct })) }, null, 2))
