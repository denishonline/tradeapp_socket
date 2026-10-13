import fs from "node:fs"
import path from "node:path"

const ROOT = process.cwd()
const date = process.argv[2] || "2026-10-09"
const startTime = process.argv[3] || "09:17"
const throughTime = process.argv[4] || "11:59"
const side = String(process.argv[5] || "bearish").toLowerCase() === "bullish" ? "bullish" : "bearish"
const limit = Math.max(1, Number(process.argv[6]) || 3)
const bearish = side === "bearish"
const direction = bearish ? -1 : 1

const numeric = (value) => {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : NaN
}
const mean = (values) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : NaN
const clamp = (value, low = 0, high = 1) => Math.max(low, Math.min(high, value))
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

function outcome(symbol, confirmationTime) {
  const filename = path.join(ROOT, "db", "candles", `${symbol}.jsonl`)
  const candles = fs.readFileSync(filename, "utf8").split(/\r?\n/).flatMap((line) => {
    if (!line.trim()) return []
    try {
      const row = JSON.parse(line)
      if (row.partial) return []
      const at = new Date(Number(row.time) * 1000 + 330 * 60_000)
      if (at.toISOString().slice(0, 10) !== date) return []
      return [{ time: at.toISOString().slice(11, 16), high: numeric(row.high), low: numeric(row.low), close: numeric(row.close) }]
    } catch { return [] }
  })
  const index = candles.findIndex((row) => row.time === confirmationTime)
  if (index < 0) return {}
  const entry = candles[index].close
  const future = candles.slice(index + 1)
  const measure = (count) => {
    const rows = future.slice(0, count)
    if (!rows.length) return { best: NaN, worst: NaN }
    const high = Math.max(...rows.map((row) => row.high))
    const low = Math.min(...rows.map((row) => row.low))
    return bearish
      ? { best: 100 * (1 - low / entry), worst: 100 * (1 - high / entry) }
      : { best: 100 * (high / entry - 1), worst: 100 * (low / entry - 1) }
  }
  const five = measure(5)
  const fifteen = measure(15)
  const session = measure(future.length)
  return {
    entryClose: round(entry), bestMove5mPct: round(five.best), worstMove5mPct: round(five.worst),
    bestMove15mPct: round(fifteen.best), worstMove15mPct: round(fifteen.worst),
    sessionBestPct: round(session.best), sessionWorstPct: round(session.worst),
  }
}

function scoreCondition(value, threshold, mode = "min") {
  if (!Number.isFinite(value)) return 0
  if (mode === "max") return value <= threshold ? 1 : clamp(1 - (value - threshold) / Math.max(Math.abs(threshold), 0.10))
  return threshold === 0 ? (value >= 0 ? 1 : 0) : clamp(value / threshold)
}

const prefix = `${date}-`
const suffix = `-${startTime.replace(":", "")}-to-${throughTime.replace(":", "")}-${side}-depth-candle-strength.csv`
const files = fs.readdirSync(path.join(ROOT, "csv"))
  .filter((name) => name.startsWith(prefix) && name.endsWith(suffix) && !name.includes("all-stock"))

const candidates = []
for (const name of files) {
  const symbol = name.slice(prefix.length, -suffix.length)
  const rows = readCsv(path.join(ROOT, "csv", name)).filter((row) => Number.isFinite(numeric(row.diagnosticScore)))
  let best = null
  for (let ignitionIndex = 10; ignitionIndex < rows.length - 2; ignitionIndex++) {
    const ignition = rows[ignitionIndex]
    if (numeric(ignition.directionalReturnPct) <= 0) continue
    const prior = rows.slice(ignitionIndex - 10, ignitionIndex)
    const priorOpen = numeric(prior[0].candleOpen)
    const priorClose = numeric(prior.at(-1).candleClose)
    const priorDirectionalPrice = direction * 100 * (priorClose / priorOpen - 1)
    const priorSide = mean(prior.map((row) => numeric(row.averageSideSharePct)).filter(Number.isFinite))
    const priorDominant = mean(prior.map((row) => numeric(row.sideDominantTicksPct)).filter(Number.isFinite))

    for (let confirmationIndex = ignitionIndex + 2;
      confirmationIndex <= Math.min(ignitionIndex + 5, rows.length - 1);
      confirmationIndex++) {
      const confirmation = rows[confirmationIndex]
      if (numeric(confirmation.directionalReturnPct) <= 0 ||
          direction * (numeric(confirmation.candleClose) - numeric(ignition.candleClose)) <= 0) continue
      const retest = rows.slice(ignitionIndex + 1, confirmationIndex)
      const closes = retest.map((row) => numeric(row.candleClose))
      const adverseClose = bearish ? Math.max(...closes) : Math.min(...closes)
      const adversePct = -direction * 100 * (adverseClose / numeric(ignition.candleOpen) - 1)
      const finalRetestSide = mean(retest.slice(-2)
        .map((row) => numeric(row.averageSideSharePct)).filter(Number.isFinite))

      const checks = [
        priorDirectionalPrice <= -0.10, priorSide >= 60, priorDominant >= 70,
        numeric(ignition.updates) >= 10 && numeric(ignition.maxGapSec) <= 15,
        numeric(ignition.directionalReturnPct) >= 0.10, numeric(ignition.volumeRatio) >= 3,
        numeric(ignition.directionalDeltaPct) >= 55, numeric(ignition.directionalOfi) >= 0.10,
        numeric(ignition.directionalCloseLocationPct) >= 70, numeric(ignition.closingSideSharePct) >= 50,
        adversePct <= 0.05, finalRetestSide >= 55,
        numeric(confirmation.updates) >= 10 && numeric(confirmation.maxGapSec) <= 15,
        numeric(confirmation.directionalReturnPct) >= 0.07, numeric(confirmation.volumeRatio) >= 2,
        numeric(confirmation.directionalDeltaPct) >= 50, numeric(confirmation.averageSideSharePct) >= 70,
        numeric(confirmation.closingSideSharePct) >= 70, numeric(confirmation.sideDominantTicksPct) >= 90,
        numeric(confirmation.directionalOfi) >= -0.01,
      ]

      const priorScore = mean([
        scoreCondition(-priorDirectionalPrice, 0.10), scoreCondition(priorSide, 60), scoreCondition(priorDominant, 70),
      ])
      const ignitionScore = mean([
        scoreCondition(numeric(ignition.directionalReturnPct), 0.10), scoreCondition(numeric(ignition.volumeRatio), 3),
        scoreCondition(numeric(ignition.directionalDeltaPct), 55), scoreCondition(numeric(ignition.directionalOfi), 0.10),
        scoreCondition(numeric(ignition.directionalCloseLocationPct), 70), scoreCondition(numeric(ignition.closingSideSharePct), 50),
      ])
      const retestScore = mean([
        scoreCondition(adversePct, 0.05, "max"), scoreCondition(finalRetestSide, 55),
      ])
      const confirmationOfiScore = numeric(confirmation.directionalOfi) >= -0.01
        ? 1 : clamp((numeric(confirmation.directionalOfi) + 0.25) / 0.24)
      const confirmationScore = mean([
        scoreCondition(numeric(confirmation.directionalReturnPct), 0.07), scoreCondition(numeric(confirmation.volumeRatio), 2),
        scoreCondition(numeric(confirmation.directionalDeltaPct), 50), scoreCondition(numeric(confirmation.averageSideSharePct), 70),
        scoreCondition(numeric(confirmation.closingSideSharePct), 70), scoreCondition(numeric(confirmation.sideDominantTicksPct), 90),
        confirmationOfiScore,
      ])
      const closenessScore = 100 * (0.20 * priorScore + 0.30 * ignitionScore + 0.15 * retestScore + 0.35 * confirmationScore)
      const failures = []
      const labels = [
        `prior directional price ${round(priorDirectionalPrice)} > -0.10%`, `prior side share ${round(priorSide)}% < 60%`,
        `prior dominant updates ${round(priorDominant)}% < 70%`, "ignition depth quality failed",
        `ignition return ${round(numeric(ignition.directionalReturnPct))}% < 0.10%`,
        `ignition volume ${round(numeric(ignition.volumeRatio))}x < 3x`,
        `ignition delta ${round(numeric(ignition.directionalDeltaPct))}% < 55%`,
        `ignition OFI ${round(numeric(ignition.directionalOfi), 4)} < 0.10`,
        `ignition close location ${round(numeric(ignition.directionalCloseLocationPct))}% < 70%`,
        `ignition closing side ${round(numeric(ignition.closingSideSharePct))}% < 50%`,
        `retest adverse move ${round(adversePct)}% > 0.05%`, `retest side share ${round(finalRetestSide)}% < 55%`,
        "confirmation depth quality failed",
        `confirmation return ${round(numeric(confirmation.directionalReturnPct))}% < 0.07%`,
        `confirmation volume ${round(numeric(confirmation.volumeRatio))}x < 2x`,
        `confirmation delta ${round(numeric(confirmation.directionalDeltaPct))}% < 50%`,
        `confirmation side share ${round(numeric(confirmation.averageSideSharePct))}% < 70%`,
        `confirmation closing side ${round(numeric(confirmation.closingSideSharePct))}% < 70%`,
        `confirmation dominant updates ${round(numeric(confirmation.sideDominantTicksPct))}% < 90%`,
        `confirmation OFI ${round(numeric(confirmation.directionalOfi), 4)} < -0.01`,
      ]
      checks.forEach((passed, index) => { if (!passed) failures.push(labels[index]) })

      const candidate = {
        symbol, side: bearish ? "SELL" : "BUY", ignitionTime: ignition.time,
        confirmationTime: confirmation.time, closenessScore: round(closenessScore),
        conditionsPassed: checks.filter(Boolean).length, conditionsTotal: checks.length,
        failedConditions: failures.join("; "),
        prior10DirectionalPricePct: round(priorDirectionalPrice), prior10AvgSidePct: round(priorSide),
        prior10DominantPct: round(priorDominant),
        ignitionReturnPct: round(numeric(ignition.directionalReturnPct)), ignitionVolumeRatio: round(numeric(ignition.volumeRatio)),
        ignitionDeltaPct: round(numeric(ignition.directionalDeltaPct)), ignitionOfi: round(numeric(ignition.directionalOfi), 4),
        ignitionClosingSidePct: round(numeric(ignition.closingSideSharePct)), retestMinutes: retest.length,
        retestAdversePct: round(adversePct), retestFinalSidePct: round(finalRetestSide),
        confirmationReturnPct: round(numeric(confirmation.directionalReturnPct)),
        confirmationVolumeRatio: round(numeric(confirmation.volumeRatio)),
        confirmationDeltaPct: round(numeric(confirmation.directionalDeltaPct)),
        confirmationOfi: round(numeric(confirmation.directionalOfi), 4),
        confirmationSidePct: round(numeric(confirmation.averageSideSharePct)),
        confirmationClosingSidePct: round(numeric(confirmation.closingSideSharePct)),
        confirmationDominantPct: round(numeric(confirmation.sideDominantTicksPct)),
      }
      if (!best || candidate.conditionsPassed > best.conditionsPassed ||
          (candidate.conditionsPassed === best.conditionsPassed && candidate.closenessScore > best.closenessScore)) best = candidate
    }
  }
  if (best) candidates.push(best)
}

candidates.sort((left, right) => right.conditionsPassed - left.conditionsPassed ||
  right.closenessScore - left.closenessScore)
const selected = candidates.slice(0, limit).map((row) => ({
  ...row,
  ...outcome(row.symbol, row.confirmationTime),
}))
selected.forEach((row, index) => { row.rank = index + 1 })
const columns = selected.length ? ["rank", ...Object.keys(selected[0]).filter((key) => key !== "rank")] : ["rank", "symbol"]
const output = path.join(ROOT, "csv",
  `${date}-${startTime.replace(":", "")}-to-${throughTime.replace(":", "")}-${side}-depth-confirmation-nearest-${limit}.csv`)
const csv = [columns.join(","), ...selected.map((row) => columns.map((column) => csvValue(row[column])).join(","))]
fs.writeFileSync(output, `${csv.join("\n")}\n`)
console.log(JSON.stringify({ date, side, range: `${startTime}-${throughTime}`, files: files.length, output, matches: selected }, null, 2))
