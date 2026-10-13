import fs from "node:fs"
import path from "node:path"
import { execFile } from "node:child_process"
import { promisify } from "node:util"

const run = promisify(execFile)
const ROOT = process.cwd()
const date = process.argv[2] || "2026-10-12"
const startTime = process.argv[3] || "09:17"
const throughTime = process.argv[4] || "11:59"
const concurrency = Math.max(1, Number(process.argv[5]) || 8)
const symbols = [...new Set(JSON.parse(fs.readFileSync(path.join(ROOT, "db", "stocks"), "utf8")))]
const worker = path.join(ROOT, "scripts", "score-minute-depth-candle-strength.js")

const number = (value) => {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : NaN
}
const mean = (values) => values.length
  ? values.reduce((sum, value) => sum + value, 0) / values.length
  : NaN
const round = (value, digits = 2) => Number.isFinite(value) ? Number(value.toFixed(digits)) : ""
const clamp = (value, low = 0, high = 1) => Math.max(low, Math.min(high, value))

function parseCsvLine(line) {
  const values = []
  let value = ""
  let quoted = false
  for (let index = 0; index < line.length; index++) {
    const char = line[index]
    if (char === '"') {
      if (quoted && line[index + 1] === '"') {
        value += '"'
        index++
      } else quoted = !quoted
    } else if (char === "," && !quoted) {
      values.push(value)
      value = ""
    } else value += char
  }
  values.push(value)
  return values
}

function readCsv(filename) {
  const lines = fs.readFileSync(filename, "utf8").trim().split(/\r?\n/)
  const columns = parseCsvLine(lines[0])
  return lines.slice(1).map((line) => {
    const values = parseCsvLine(line)
    return Object.fromEntries(columns.map((column, index) => [column, values[index] ?? ""]))
  })
}

function summarize(rows) {
  const firstOpen = number(rows[0]?.candleOpen)
  const lastClose = number(rows.at(-1)?.candleClose)
  const validRows = rows.filter((row) => number(row.updates) >= 10 && number(row.maxGapSec) <= 15)
  const values = (field) => rows.map((row) => number(row[field])).filter(Number.isFinite)
  return {
    minutes: rows.length,
    pricePct: firstOpen > 0 && lastClose > 0 ? (lastClose / firstOpen - 1) * 100 : NaN,
    averageBid: mean(values("averageBidSharePct")),
    closingBid: mean(values("closingBidSharePct")),
    bidDominant: mean(values("sideDominantTicksPct")),
    delta: mean(values("estimatedDeltaPct")),
    ofi: mean(values("normalizedOfi")),
    bidMajorityShare: rows.length
      ? rows.filter((row) => number(row.averageBidSharePct) > 50).length / rows.length
      : 0,
    strongBidShare: rows.length
      ? rows.filter((row) => number(row.averageBidSharePct) >= 60 && number(row.sideDominantTicksPct) >= 70).length / rows.length
      : 0,
    validShare: rows.length ? validRows.length / rows.length : 0,
  }
}

function csvValue(value) {
  const text = value === null || value === undefined ? "" : String(value)
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
}

async function analyzeSymbol(symbol) {
  const { stdout } = await run(process.execPath,
    [worker, symbol, date, startTime, throughTime, "--compact"],
    { cwd: ROOT, maxBuffer: 2 * 1024 * 1024 })
  const summary = JSON.parse(stdout)
  const rows = readCsv(summary.output).filter((row) => Number.isFinite(number(row.diagnosticScore)))
  const matches = []

  for (let index = 40; index < rows.length; index++) {
    const confirmation = rows[index]
    const recovery = summarize(rows.slice(index - 40, index - 20))
    const accumulation = summarize(rows.slice(index - 20, index - 10))
    const divergence = summarize(rows.slice(index - 10, index))

    const recoveryPassed = recovery.validShare >= 0.80 &&
      recovery.pricePct >= -0.35 && recovery.pricePct <= 0.25 &&
      recovery.averageBid >= 55 && recovery.closingBid >= 55 &&
      recovery.bidMajorityShare >= 0.65 && recovery.strongBidShare >= 0.25
    const accumulationPassed = accumulation.validShare >= 0.80 &&
      Math.abs(accumulation.pricePct) <= 0.25 && accumulation.averageBid >= 65 &&
      accumulation.closingBid >= 60 && accumulation.bidMajorityShare >= 0.80 &&
      accumulation.strongBidShare >= 0.60 && accumulation.ofi >= -0.03
    const divergencePassed = divergence.validShare >= 0.80 &&
      divergence.pricePct <= -0.15 && divergence.pricePct >= -1.20 &&
      divergence.averageBid >= 60 && divergence.closingBid >= 60 &&
      divergence.bidMajorityShare >= 0.70 && divergence.strongBidShare >= 0.50 &&
      divergence.delta < 0
    const confirmationPassed = number(confirmation.updates) >= 10 &&
      number(confirmation.maxGapSec) <= 15 &&
      number(confirmation.candleReturnPct) >= 0.08 &&
      number(confirmation.estimatedDeltaPct) >= 30 &&
      number(confirmation.normalizedOfi) >= 0.05 &&
      number(confirmation.averageBidSharePct) >= 55 &&
      number(confirmation.sideDominantTicksPct) >= 60 &&
      number(confirmation.volumeRatio) >= 1

    if (!(recoveryPassed && accumulationPassed && divergencePassed && confirmationPassed)) continue

    const score = 100 * (
      0.15 * clamp((recovery.averageBid - 55) / 20) +
      0.20 * clamp((accumulation.averageBid - 65) / 20) +
      0.10 * clamp(accumulation.strongBidShare / 0.90) +
      0.20 * clamp((divergence.averageBid - 60) / 20) +
      0.10 * clamp(-divergence.pricePct / 0.60) +
      0.10 * clamp(number(confirmation.candleReturnPct) / 0.30) +
      0.075 * clamp(number(confirmation.estimatedDeltaPct) / 70) +
      0.075 * clamp(number(confirmation.normalizedOfi) / 0.25)
    )

    matches.push({
      symbol,
      confirmationTime: confirmation.time,
      score: round(score),
      recoveryPeriod: `${rows[index - 40].time}-${rows[index - 21].time}`,
      recoveryPricePct: round(recovery.pricePct),
      recoveryAvgBidPct: round(recovery.averageBid),
      recoveryBidMajorityPct: round(100 * recovery.bidMajorityShare),
      accumulationPeriod: `${rows[index - 20].time}-${rows[index - 11].time}`,
      accumulationPricePct: round(accumulation.pricePct),
      accumulationAvgBidPct: round(accumulation.averageBid),
      accumulationStrongBidPct: round(100 * accumulation.strongBidShare),
      divergencePeriod: `${rows[index - 10].time}-${rows[index - 1].time}`,
      divergencePricePct: round(divergence.pricePct),
      divergenceAvgBidPct: round(divergence.averageBid),
      divergenceClosingBidPct: round(divergence.closingBid),
      divergenceBidMajorityPct: round(100 * divergence.bidMajorityShare),
      divergenceAvgDeltaPct: round(divergence.delta),
      confirmationReturnPct: round(number(confirmation.candleReturnPct)),
      confirmationDeltaPct: round(number(confirmation.estimatedDeltaPct)),
      confirmationOfi: round(number(confirmation.normalizedOfi), 4),
      confirmationBidSharePct: round(number(confirmation.averageBidSharePct)),
      confirmationVolumeRatio: round(number(confirmation.volumeRatio)),
    })
  }

  return matches.sort((left, right) => right.score - left.score)[0] || null
}

const results = new Array(symbols.length)
let cursor = 0
async function consume() {
  while (true) {
    const index = cursor++
    if (index >= symbols.length) return
    try {
      results[index] = await analyzeSymbol(symbols[index])
    } catch (error) {
      results[index] = { symbol: symbols[index], error: error.stderr || error.message }
    }
  }
}

await Promise.all(Array.from({ length: Math.min(concurrency, symbols.length) }, consume))
const matches = results.filter((row) => row && !row.error).sort((left, right) => right.score - left.score)
matches.forEach((row, index) => { row.rank = index + 1 })
const columns = matches.length ? ["rank", ...Object.keys(matches[0]).filter((key) => key !== "rank")] : []
const output = path.join(ROOT, "csv", `${date}-${startTime.replace(":", "")}-to-${throughTime.replace(":", "")}-four-stage-bullish-divergence.csv`)
const csv = columns.length
  ? [columns.join(","), ...matches.map((row) => columns.map((column) => csvValue(row[column])).join(","))]
  : ["rank,symbol,confirmationTime,score"]
fs.writeFileSync(output, `${csv.join("\n")}\n`)

console.log(JSON.stringify({
  date,
  range: `${startTime}-${throughTime}`,
  scanned: symbols.length,
  matches: matches.length,
  failed: results.filter((row) => row?.error).map((row) => ({ symbol: row.symbol, error: row.error })),
  output,
  signals: matches,
}, null, 2))
