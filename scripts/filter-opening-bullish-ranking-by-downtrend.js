import fs from "node:fs"
import path from "node:path"

const ROOT = process.cwd()
const date = process.argv[2] || "2026-10-09"
const throughTime = process.argv[3] || "10:00"
const rankingFile = process.argv[4] || path.join(ROOT, "csv", `${date}-0917-to-${throughTime.replace(":", "")}-all-stock-bullish-depth-candle-strength.csv`)
const MINUTE = 60_000
const start = Date.parse(`${date}T09:15:00+05:30`)
const end = Date.parse(`${date}T${throughTime}:59+05:30`)

const round = (value, digits = 2) => Number(value.toFixed(digits))
const pct = (value, base) => base > 0 ? (value / base - 1) * 100 : NaN

function ema(values, period) {
  const multiplier = 2 / (period + 1)
  let value = values[0]
  for (const next of values.slice(1)) value = next * multiplier + value * (1 - multiplier)
  return value
}

function slopePctPerMinute(values) {
  if (values.length < 2) return NaN
  const xMean = (values.length - 1) / 2
  const yMean = values.reduce((sum, value) => sum + value, 0) / values.length
  let numerator = 0
  let denominator = 0
  for (let index = 0; index < values.length; index++) {
    numerator += (index - xMean) * (values[index] - yMean)
    denominator += (index - xMean) ** 2
  }
  return yMean > 0 && denominator > 0 ? 100 * (numerator / denominator) / yMean : NaN
}

function csvValue(value) {
  const text = value === null || value === undefined ? "" : String(value)
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
}

const rankingLines = fs.readFileSync(rankingFile, "utf8").trim().split(/\r?\n/).slice(1)
const ranked = rankingLines.map((line) => {
  const [rank, symbol, averageScore, averageGatedScore, minutes, qualifiedMinutes] = line.split(",")
  return { originalRank: Number(rank), symbol, averageScore: Number(averageScore), averageGatedScore: Number(averageGatedScore), minutes: Number(minutes), qualifiedMinutes: Number(qualifiedMinutes) }
})

const eligible = []
for (const row of ranked) {
  const candleFile = path.join(ROOT, "db", "candles", `${row.symbol}.jsonl`)
  if (!fs.existsSync(candleFile)) continue
  const candles = fs.readFileSync(candleFile, "utf8").split(/\r?\n/).flatMap((line) => {
    if (!line.trim()) return []
    try {
      const item = JSON.parse(line)
      const at = Number(item.time) * 1000
      if (item.partial || at < start || at > end) return []
      const values = [item.open, item.high, item.low, item.close, item.volume].map(Number)
      return values.every(Number.isFinite) ? [{ at, open: values[0], high: values[1], low: values[2], close: values[3], volume: values[4] }] : []
    } catch { return [] }
  }).sort((left, right) => left.at - right.at)
  if (candles.length < 10) continue
  const closes = candles.map((candle) => candle.close)
  const openReturnPct = pct(candles.at(-1).close, candles[0].open)
  const emaGapPct = pct(ema(closes, 5), ema(closes, 10))
  const slope15PctPerMinute = slopePctPerMinute(closes.slice(-15))
  const belowOpen = openReturnPct < 0
  const emaDown = emaGapPct < 0
  const slopeDown = slope15PctPerMinute < 0
  if (belowOpen && (emaDown || slopeDown)) {
    eligible.push({ ...row, openReturnPct, emaGapPct, slope15PctPerMinute, candles: candles.length, emaDown, slopeDown })
  }
}

eligible.sort((left, right) => right.averageScore - left.averageScore)
eligible.forEach((row, index) => { row.downtrendRank = index + 1 })
const columns = ["downtrendRank", "originalRank", "symbol", "averageScore", "averageGatedScore", "minutes", "qualifiedMinutes", "openReturnPct", "ema5VsEma10Pct", "last15SlopePctPerMinute", "emaDown", "slopeDown", "candles"]
const outputFile = path.join(ROOT, "csv", `${date}-0917-to-${throughTime.replace(":", "")}-bullish-depth-candle-downtrend-ranking.csv`)
const csv = [columns.join(","), ...eligible.map((row) => [
  row.downtrendRank, row.originalRank, row.symbol, row.averageScore, row.averageGatedScore,
  row.minutes, row.qualifiedMinutes, round(row.openReturnPct), round(row.emaGapPct, 3),
  round(row.slope15PctPerMinute, 4), row.emaDown, row.slopeDown, row.candles,
].map(csvValue).join(","))].join("\n") + "\n"
fs.writeFileSync(outputFile, csv)
console.log(JSON.stringify({ date, throughTime, criterion: "returnFromOpen < 0 AND (EMA5 < EMA10 OR last15 close slope < 0)", eligible: eligible.length, top10: eligible.slice(0, 10), outputFile }, null, 2))
