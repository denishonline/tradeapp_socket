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
const side = String(process.argv[6] || "bullish").toLowerCase() === "bearish" ? "bearish" : "bullish"
const bearish = side === "bearish"
const direction = bearish ? -1 : 1
const symbols = [...new Set(JSON.parse(fs.readFileSync(path.join(ROOT, "db", "stocks"), "utf8")))]
const worker = path.join(ROOT, "scripts", "score-minute-depth-candle-strength.js")

const numeric = (value) => {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : NaN
}
const mean = (values) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : NaN
const round = (value, digits = 2) => Number.isFinite(value) ? Number(value.toFixed(digits)) : ""

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

function csvValue(value) {
  const text = value === null || value === undefined ? "" : String(value)
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
}

function candleOutcome(symbol, confirmationTime) {
  const filename = path.join(ROOT, "db", "candles", `${symbol}.jsonl`)
  if (!fs.existsSync(filename)) return {}
  const candles = fs.readFileSync(filename, "utf8").split(/\r?\n/).flatMap((line) => {
    if (!line.trim()) return []
    try {
      const row = JSON.parse(line)
      if (row.partial) return []
      const at = new Date(Number(row.time) * 1000 + 330 * 60_000)
      if (at.toISOString().slice(0, 10) !== date) return []
      return [{
        time: at.toISOString().slice(11, 16),
        high: numeric(row.high), low: numeric(row.low), close: numeric(row.close),
      }]
    } catch { return [] }
  })
  const index = candles.findIndex((row) => row.time === confirmationTime)
  if (index < 0) return {}
  const entry = candles[index].close
  const future = candles.slice(index + 1)
  const windowOutcome = (count) => {
    const rows = future.slice(0, count)
    if (!rows.length || !(entry > 0)) return { best: NaN, worst: NaN }
    const highest = Math.max(...rows.map((row) => row.high))
    const lowest = Math.min(...rows.map((row) => row.low))
    return bearish
      ? { best: 100 * (1 - lowest / entry), worst: 100 * (1 - highest / entry) }
      : { best: 100 * (highest / entry - 1), worst: 100 * (lowest / entry - 1) }
  }
  const five = windowOutcome(5)
  const fifteen = windowOutcome(15)
  const session = windowOutcome(future.length)
  return {
    entryClose: round(entry),
    bestMove5mPct: round(five.best), worstMove5mPct: round(five.worst),
    bestMove15mPct: round(fifteen.best), worstMove15mPct: round(fifteen.worst),
    sessionBestPct: round(session.best), sessionWorstPct: round(session.worst),
  }
}

async function analyzeSymbol(symbol) {
  const workerArguments = [worker, symbol, date, startTime, throughTime, "--compact"]
  if (bearish) workerArguments.push("--bearish")
  const { stdout } = await run(process.execPath,
    workerArguments,
    { cwd: ROOT, maxBuffer: 2 * 1024 * 1024 })
  const summary = JSON.parse(stdout)
  const rows = readCsv(summary.output).filter((row) => Number.isFinite(numeric(row.diagnosticScore)))
  const signals = []

  for (let ignitionIndex = 10; ignitionIndex < rows.length - 2; ignitionIndex++) {
    const ignition = rows[ignitionIndex]
    if (numeric(ignition.updates) < 10 || numeric(ignition.maxGapSec) > 15 ||
        numeric(ignition.directionalReturnPct) < 0.10 || numeric(ignition.volumeRatio) < 3 ||
        numeric(ignition.directionalDeltaPct) < 55 || numeric(ignition.directionalOfi) < 0.10 ||
        numeric(ignition.directionalCloseLocationPct) < 70 || numeric(ignition.closingSideSharePct) < 50) continue

    const prior = rows.slice(ignitionIndex - 10, ignitionIndex)
    const priorOpen = numeric(prior[0].candleOpen)
    const priorClose = numeric(prior.at(-1).candleClose)
    const priorPricePct = priorOpen > 0 ? 100 * (priorClose / priorOpen - 1) : NaN
    const directionalPriorPricePct = direction * priorPricePct
    const priorAverageSide = mean(prior.map((row) => numeric(row.averageSideSharePct)).filter(Number.isFinite))
    const priorBidDominant = mean(prior.map((row) => numeric(row.sideDominantTicksPct)).filter(Number.isFinite))
    if (directionalPriorPricePct > -0.10 || priorAverageSide < 60 || priorBidDominant < 70) continue

    for (let confirmationIndex = ignitionIndex + 2;
      confirmationIndex <= Math.min(ignitionIndex + 5, rows.length - 1);
      confirmationIndex++) {
      const confirmation = rows[confirmationIndex]
      if (numeric(confirmation.updates) < 10 || numeric(confirmation.maxGapSec) > 15 ||
          numeric(confirmation.directionalReturnPct) < 0.07 || numeric(confirmation.volumeRatio) < 2 ||
          numeric(confirmation.directionalDeltaPct) < 50 || numeric(confirmation.averageSideSharePct) < 70 ||
          numeric(confirmation.closingSideSharePct) < 70 || numeric(confirmation.sideDominantTicksPct) < 90 ||
          numeric(confirmation.directionalOfi) < -0.01 ||
          direction * (numeric(confirmation.candleClose) - numeric(ignition.candleClose)) <= 0) continue

      const retest = rows.slice(ignitionIndex + 1, confirmationIndex)
      const retestCloses = retest.map((row) => numeric(row.candleClose))
      const adverseRetestClose = bearish ? Math.max(...retestCloses) : Math.min(...retestCloses)
      const finalRetestRows = retest.slice(-2)
      const finalRetestSide = mean(finalRetestRows.map((row) => numeric(row.averageSideSharePct)).filter(Number.isFinite))
      const retestHeld = bearish
        ? adverseRetestClose <= numeric(ignition.candleOpen) * 1.0005
        : adverseRetestClose >= numeric(ignition.candleOpen) * 0.9995
      if (!retestHeld || finalRetestSide < 55) continue

      signals.push({
        symbol,
        side: bearish ? "SELL" : "BUY",
        ignitionTime: ignition.time,
        confirmationTime: confirmation.time,
        prior10PricePct: round(priorPricePct),
        prior10AvgSideSharePct: round(priorAverageSide),
        prior10SideDominantPct: round(priorBidDominant),
        ignitionDirectionalReturnPct: round(numeric(ignition.directionalReturnPct)),
        ignitionVolumeRatio: round(numeric(ignition.volumeRatio)),
        ignitionDirectionalDeltaPct: round(numeric(ignition.directionalDeltaPct)),
        ignitionDirectionalOfi: round(numeric(ignition.directionalOfi), 4),
        retestMinutes: retest.length,
        retestAdverseVsIgnitionOpenPct: round(direction * 100 * (adverseRetestClose / numeric(ignition.candleOpen) - 1)),
        finalTwoRetestAvgSideSharePct: round(finalRetestSide),
        confirmationDirectionalReturnPct: round(numeric(confirmation.directionalReturnPct)),
        confirmationVolumeRatio: round(numeric(confirmation.volumeRatio)),
        confirmationDirectionalDeltaPct: round(numeric(confirmation.directionalDeltaPct)),
        confirmationDirectionalOfi: round(numeric(confirmation.directionalOfi), 4),
        confirmationAvgSideSharePct: round(numeric(confirmation.averageSideSharePct)),
        confirmationClosingSideSharePct: round(numeric(confirmation.closingSideSharePct)),
        confirmationSideDominantPct: round(numeric(confirmation.sideDominantTicksPct)),
        ...candleOutcome(symbol, confirmation.time),
      })
      break
    }
  }
  return signals
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
      results[index] = [{ symbol: symbols[index], error: error.stderr || error.message }]
    }
  }
}

await Promise.all(Array.from({ length: Math.min(concurrency, symbols.length) }, consume))
const failures = results.flat().filter((row) => row?.error)
const signals = results.flat().filter((row) => row && !row.error)
  .sort((left, right) => left.confirmationTime.localeCompare(right.confirmationTime) ||
    left.symbol.localeCompare(right.symbol))
signals.forEach((row, index) => { row.signalNumber = index + 1 })

const columns = signals.length
  ? ["signalNumber", ...Object.keys(signals[0]).filter((key) => key !== "signalNumber")]
  : ["signalNumber", "symbol", "ignitionTime", "confirmationTime"]
const output = path.join(ROOT, "csv",
  `${date}-${startTime.replace(":", "")}-to-${throughTime.replace(":", "")}-${side}-depth-confirmation-backtest.csv`)
const csv = [columns.join(","), ...signals.map((row) =>
  columns.map((column) => csvValue(row[column])).join(","))]
fs.writeFileSync(output, `${csv.join("\n")}\n`)

console.log(JSON.stringify({
  date,
  side,
  range: `${startTime}-${throughTime}`,
  scanned: symbols.length,
  signalCount: signals.length,
  failures,
  output,
  signals,
}, null, 2))
