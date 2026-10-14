import fs from "node:fs"
import path from "node:path"

const ROOT = process.cwd(), MINUTE = 60_000
const source = path.join(ROOT, "csv", "2026-10-05-to-14-fast-depth-momentum-candidates.csv")
const [header, ...lines] = fs.readFileSync(source, "utf8").trim().split(/\r?\n/)
const fields = header.split(",")
const rows = lines.map((line) => Object.fromEntries(line.split(",").map((value, index) => [fields[index], value])))
const dates = [...new Set(rows.map((row) => row.date))]
const stocks = [...new Set(JSON.parse(fs.readFileSync(path.join(ROOT, "db", "stocks"), "utf8")))]
const pct = (value, base) => base > 0 ? (value / base - 1) * 100 : NaN
const mean = (values) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : NaN
const round = (value, digits = 4) => Number.isFinite(value) ? Number(value.toFixed(digits)) : ""
const time = (at) => new Date(at + 330 * MINUTE).toISOString().slice(11, 16)
const rank = (values, value) => values.length ? 100 * values.filter((item) => item <= value).length / values.length : NaN

for (const date of dates) {
  const start = Date.parse(`${date}T09:15:00+05:30`), end = Date.parse(`${date}T15:31:00+05:30`)
  const snapshots = new Map()
  for (const symbol of stocks) {
    const filename = path.join(ROOT, "db", "candles", `${symbol}.jsonl`)
    if (!fs.existsSync(filename)) continue
    const candles = fs.readFileSync(filename, "utf8").split(/\r?\n/).flatMap((line) => {
      if (!line.trim()) return []
      try {
        const value = JSON.parse(line), at = Number(value.time) * 1000
        if (value.partial || at < start || at >= end) return []
        return [{ at, open: Number(value.open), close: Number(value.close) }]
      } catch { return [] }
    }).sort((a, b) => a.at - b.at)
    if (!candles.length) continue
    for (let index = 0; index < candles.length; index++) {
      const candle = candles[index], bucket = snapshots.get(candle.at) ?? []
      bucket.push({ symbol, dayReturn: pct(candle.close, candles[0].open),
        return3: index >= 2 ? pct(candle.close, candles[index - 2].open) : NaN,
        return5: index >= 4 ? pct(candle.close, candles[index - 4].open) : NaN })
      snapshots.set(candle.at, bucket)
    }
  }
  const metrics = new Map()
  for (const [at, values] of snapshots) {
    const day = values.map((item) => item.dayReturn).filter(Number.isFinite)
    const ret3 = values.map((item) => item.return3).filter(Number.isFinite)
    const ret5 = values.map((item) => item.return5).filter(Number.isFinite)
    const previous = metrics.get(at - 5 * MINUTE)
    const positive = day.length ? 100 * day.filter((value) => value > 0).length / day.length : NaN
    const positive3 = ret3.length ? 100 * ret3.filter((value) => value > 0).length / ret3.length : NaN
    const positive5 = ret5.length ? 100 * ret5.filter((value) => value > 0).length / ret5.length : NaN
    metrics.set(at, { count: day.length, positive, positive3, positive5, average: mean(day), average3: mean(ret3), average5: mean(ret5),
      positiveChange5: previous ? positive - previous.positive : NaN,
      averageChange5: previous ? mean(day) - previous.average : NaN, values })
  }
  for (const row of rows.filter((item) => item.date === date)) {
    const at = Date.parse(`${date}T${row.signalTime}:00+05:30`), metric = metrics.get(at)
    if (!metric) continue
    const stock = metric.values.find((item) => item.symbol === row.symbol)
    row.breadthCount = metric.count
    row.breadthPositivePct = round(metric.positive)
    row.breadthReturn3PositivePct = round(metric.positive3)
    row.breadthReturn5PositivePct = round(metric.positive5)
    row.breadthAverageReturnPct = round(metric.average)
    row.breadthAverage3Pct = round(metric.average3)
    row.breadthAverage5Pct = round(metric.average5)
    row.breadthPositiveChange5 = round(metric.positiveChange5)
    row.breadthAverageChange5 = round(metric.averageChange5)
    row.dayReturnRankPct = stock ? round(rank(metric.values.map((item) => item.dayReturn), stock.dayReturn)) : ""
    row.return3RankPct = stock ? round(rank(metric.values.map((item) => item.return3).filter(Number.isFinite), stock.return3)) : ""
  }
  process.stderr.write(`${date}: ${snapshots.size} breadth minutes\n`)
}
const extra = ["breadthCount", "breadthPositivePct", "breadthReturn3PositivePct", "breadthReturn5PositivePct",
  "breadthAverageReturnPct", "breadthAverage3Pct", "breadthAverage5Pct", "breadthPositiveChange5", "breadthAverageChange5",
  "dayReturnRankPct", "return3RankPct"]
const columns = [...fields, ...extra]
const output = path.join(ROOT, "csv", "2026-10-05-to-14-fast-depth-momentum-candidates-breadth.csv")
fs.writeFileSync(output, [columns.join(","), ...rows.map((row) => columns.map((column) => row[column] ?? "").join(","))].join("\n") + "\n")
console.log(JSON.stringify({ output, rows: rows.length }, null, 2))
