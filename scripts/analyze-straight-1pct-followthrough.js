#!/usr/bin/env node
import fs from "node:fs"
import path from "node:path"

const ROOT = process.cwd()
const day = process.argv[2] || "2026-10-22"
const targetPct = Number(process.argv[3] || -1)
const IST_OFFSET_MS = 330 * 60_000
const dateOf = (seconds) => new Date(seconds * 1000 + IST_OFFSET_MS).toISOString().slice(0, 10)
const timeOf = (seconds) => new Date(seconds * 1000 + IST_OFFSET_MS).toISOString().slice(11, 16)
const pct = (value, base) => 100 * (value / base - 1)
const round = (value, digits = 3) => Number.isFinite(value) ? Number(value.toFixed(digits)) : null

function csvRows(file) {
  const lines = fs.readFileSync(file, "utf8").trim().split(/\r?\n/)
  const headers = lines.shift().split(",")
  return lines.map((line) => Object.fromEntries(line.split(",").map((value, index) => [headers[index], value])))
}

const ruleReports = fs.readdirSync(path.join(ROOT, "reports"))
  .filter((file) => file.startsWith(`opening-weakness-rules-${day}`) && file.endsWith(".csv"))
  .map((file) => ({ file, mtime: fs.statSync(path.join(ROOT, "reports", file)).mtimeMs }))
  .sort((left, right) => right.mtime - left.mtime)
if (!ruleReports.length) throw new Error(`No opening-rule report found for ${day}`)
const candidates = csvRows(path.join(ROOT, "reports", ruleReports[0].file)).filter((row) => row.date === day && row.side === "SELL")

function candlesFor(stock) {
  const file = path.join(ROOT, "db", "candles", `${stock}.jsonl`)
  if (!fs.existsSync(file)) return []
  return fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean).flatMap((line) => {
    try {
      const row = JSON.parse(line)
      return dateOf(row.time) === day && timeOf(row.time) >= "09:15" && timeOf(row.time) < "15:30" ? [row] : []
    } catch { return [] }
  }).sort((left, right) => left.time - right.time)
}

const evaluated = candidates.flatMap((candidate) => {
  const rows = candlesFor(candidate.stock)
  const signalIndex = rows.findIndex((row) => timeOf(row.time + 60) === candidate.metrics_at_ist)
  if (signalIndex < 0) return []
  const signal = rows[signalIndex]
  const signalPrice = Number(signal.close)
  const future = rows.slice(signalIndex + 1)
  const targetIndex = future.findIndex((row) => Number(row.low) <= signalPrice * (1 + targetPct / 100))
  const path = targetIndex >= 0 ? future.slice(0, targetIndex + 1) : future
  const maximumAdversePct = path.length ? Math.max(...path.map((row) => pct(Number(row.high), signalPrice))) : null
  const minimumReturnPct = path.length ? Math.min(...path.map((row) => pct(Number(row.close), signalPrice))) : null
  const downCloses = path.filter((row) => Number(row.close) <= Number(row.open)).length
  const upCloses = path.filter((row) => Number(row.close) > Number(row.open)).length
  const target = targetIndex >= 0 ? future[targetIndex] : null
  return [{
    ...candidate,
    signalPrice: round(signalPrice, 2),
    targetHit: Boolean(target),
    targetAt: target ? timeOf(target.time + 60) : "",
    targetReturnPct: target ? round(pct(Number(target.close), signalPrice)) : null,
    maximumAdversePct: round(maximumAdversePct),
    minimumCloseReturnPct: round(minimumReturnPct),
    pathCandles: path.length,
    downCandlePct: path.length ? round(100 * downCloses / path.length, 1) : null,
    upCandlePct: path.length ? round(100 * upCloses / path.length, 1) : null,
    straightCandidate: Boolean(target) && maximumAdversePct <= 0.30 && path.length > 0 && downCloses / path.length >= 0.60,
  }]
})

const report = { day, target: `${targetPct}%`, sourceReport: ruleReports[0].file, method: "Signal price is the close of the completed candle that first fulfilled the opening rules. Target is the first later candle whose low reaches the target. Straight candidate additionally requires maximum adverse high <= +0.30% before target and at least 60% non-green candles before target.", candidates: evaluated }
const base = path.join(ROOT, "reports", `${day}-straight-1pct-followthrough.json`)
let output = base, attempt = 2
while (fs.existsSync(output)) output = base.replace(/\.json$/, `-${attempt++}.json`)
fs.writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`)
console.table(evaluated.map((row) => ({ stock: row.stock, signal: row.metrics_at_ist, signalPrice: row.signalPrice, target: row.targetHit ? row.targetAt : "NO", targetReturn: row.targetReturnPct, adverse: row.maximumAdversePct, downCandles: row.downCandlePct, straight: row.straightCandidate })))
console.log(`Saved ${output}`)
