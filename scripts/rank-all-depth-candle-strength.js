import fs from "node:fs"
import path from "node:path"
import { execFile } from "node:child_process"
import { promisify } from "node:util"

const run = promisify(execFile)
const ROOT = process.cwd()
const date = process.argv[2] || new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10)
const startTime = process.argv[3] || "09:17"
const throughTime = process.argv[4] || "09:30"
const concurrency = Math.max(1, Number(process.argv[5]) || 8)
const side = String(process.argv[6] || "bullish").toLowerCase() === "bearish" ? "bearish" : "bullish"
const symbols = [...new Set(JSON.parse(fs.readFileSync(path.join(ROOT, "db", "stocks"), "utf8")))]
const worker = path.join(ROOT, "scripts", "score-minute-depth-candle-strength.js")

function csvValue(value) {
  const text = value === null || value === undefined ? "" : String(value)
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
}

const results = new Array(symbols.length)
let cursor = 0
async function consume() {
  while (true) {
    const index = cursor++
    if (index >= symbols.length) return
    const symbol = symbols[index]
    try {
      const workerArguments = [worker, symbol, date, startTime, throughTime, "--compact", "--no-csv"]
      if (side === "bearish") workerArguments.push("--bearish")
      const { stdout } = await run(process.execPath,
        workerArguments,
        { cwd: ROOT, maxBuffer: 2 * 1024 * 1024 })
      const summary = JSON.parse(stdout)
      const strongest = summary.topCandidates?.[0] || {}
      results[index] = {
        symbol,
        averageScore: summary.averageAvailableDiagnosticScore,
        averageGatedScore: summary.averageFinalScore,
        minutes: summary.availableMinutes,
        qualifiedMinutes: summary.qualified,
        cleanContinuationMinutes: summary.cleanContinuationMinutes,
        strongestCleanContinuationTime: summary.strongestCleanContinuation?.time || "",
        strongestCleanContinuationScore: summary.strongestCleanContinuation?.finalScore ?? "",
        absorptionReversalMatched: summary.absorptionReversal?.patternMatched || false,
        absorptionReversalScore: summary.absorptionReversal?.recoveryScore ?? "",
        pressureTime: summary.absorptionReversal?.pressureTime || "",
        pressureScore: summary.absorptionReversal?.pressureScore ?? "",
        pressureReturnPct: summary.absorptionReversal?.pressureReturnPct ?? "",
        pressureDeltaPct: summary.absorptionReversal?.pressureDeltaPct ?? "",
        pressureFailures: summary.absorptionReversal?.pressureFailures || "",
        recoveryPct: summary.absorptionReversal?.recoveryPct ?? "",
        recoveryGreenMinutes: summary.absorptionReversal?.greenMinutes ?? "",
        recoveryPositiveDeltaMinutes: summary.absorptionReversal?.positiveDeltaMinutes ?? "",
        recoveryPositiveOfiMinutes: summary.absorptionReversal?.positiveOfiMinutes ?? "",
        latestThreeReturnPct: summary.absorptionReversal?.latestThreeReturnPct ?? "",
        passBullishScore: summary.metricPassCounts?.bullishScore ?? "",
        passCandleReturn: summary.metricPassCounts?.candleReturn ?? "",
        passPriceProgress: summary.metricPassCounts?.priceProgress ?? "",
        passRelativeVolume: summary.metricPassCounts?.relativeVolume ?? "",
        passEstimatedDelta: summary.metricPassCounts?.estimatedDelta ?? "",
        passAverageBidShare: summary.metricPassCounts?.averageBidShare ?? "",
        passNormalizedOfi: summary.metricPassCounts?.normalizedOfi ?? "",
        passBidDominantUpdates: summary.metricPassCounts?.bidDominantUpdates ?? "",
        passAllEight: summary.metricPassCounts?.allEight ?? "",
        allMetricPassAverageScore: summary.allMetricPassAverageScore ?? "",
        allMetricPassTimes: summary.allMetricPassTimes || "",
        strongestMinute: strongest.time || "",
        strongestMinuteScore: strongest.diagnosticScore ?? "",
        strongestQualified: strongest.qualified ?? "",
        strongestReturnPct: strongest.candleReturnPct ?? "",
        strongestEstimatedDeltaPct: strongest.estimatedDeltaPct ?? "",
        strongestAverageBidSharePct: strongest.averageBidSharePct ?? "",
        strongestDirectionalDeltaPct: strongest.directionalDeltaPct ?? "",
        strongestSideSharePct: strongest.averageSideSharePct ?? "",
        strongestVolumeRatio: strongest.volumeRatio ?? "",
        strongestGateFailures: strongest.gateFailures || "",
      }
    } catch (error) {
      results[index] = { symbol, error: error.stderr || error.message }
    }
  }
}

await Promise.all(Array.from({ length: Math.min(concurrency, symbols.length) }, consume))
const valid = results.filter((row) => Number.isFinite(row?.averageScore))
  .sort((left, right) => right.averageScore - left.averageScore)
valid.forEach((row, index) => { row.rank = index + 1 })
const failed = results.filter((row) => !Number.isFinite(row?.averageScore))
const columns = ["rank", "symbol", "averageScore", "averageGatedScore", "minutes", "qualifiedMinutes",
  "cleanContinuationMinutes", "strongestCleanContinuationTime", "strongestCleanContinuationScore",
  "absorptionReversalMatched", "absorptionReversalScore", "pressureTime", "pressureScore",
  "pressureReturnPct", "pressureDeltaPct", "pressureFailures", "recoveryPct",
  "recoveryGreenMinutes", "recoveryPositiveDeltaMinutes", "recoveryPositiveOfiMinutes",
  "latestThreeReturnPct",
  "passBullishScore", "passCandleReturn", "passPriceProgress", "passRelativeVolume",
  "passEstimatedDelta", "passAverageBidShare", "passNormalizedOfi", "passBidDominantUpdates",
  "passAllEight", "allMetricPassAverageScore", "allMetricPassTimes",
  "strongestMinute", "strongestMinuteScore", "strongestQualified", "strongestReturnPct",
  "strongestEstimatedDeltaPct", "strongestAverageBidSharePct", "strongestDirectionalDeltaPct",
  "strongestSideSharePct", "strongestVolumeRatio",
  "strongestGateFailures"]
const slug = (value) => value.replace(":", "")
const output = path.join(ROOT, "csv",
  `${date}-${slug(startTime)}-to-${slug(throughTime)}-all-stock-${side}-depth-candle-strength.csv`)
const csv = [columns.join(","), ...valid.map((row) =>
  columns.map((column) => csvValue(row[column])).join(","))]
fs.writeFileSync(output, `${csv.join("\n")}\n`)
const universeAverage = valid.length
  ? valid.reduce((sum, row) => sum + row.averageScore, 0) / valid.length
  : null
console.log(JSON.stringify({ date, side, range: `${startTime}-${throughTime}`, requested: symbols.length,
  scored: valid.length, failed: failed.map((row) => ({ symbol: row.symbol, error: row.error })),
  universeAverage: universeAverage === null ? null : Number(universeAverage.toFixed(2)),
  output, top5: valid.slice(0, 5) }, null, 2))
