import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const date = process.argv[2] || "2026-10-05"
const input = path.join(os.tmpdir(), `tradeapp-short-signal-features-${date}.json`)
const output = path.join(os.tmpdir(), `tradeapp-short-signal-breadth-${date}.json`)
const signals = JSON.parse(fs.readFileSync(input, "utf8"))
const archive = path.join(process.cwd(), "db", "cash-depth", date)
const breadth = new Map()
const indiaDate = (at) => new Date(at + 330 * 60_000).toISOString().slice(0, 10)
for (const entry of fs.readdirSync(archive, { withFileTypes: true }).filter((row) => row.isDirectory())) {
  const filename = path.join(process.cwd(), "db", "candles", `${entry.name}.jsonl`)
  if (!fs.existsSync(filename)) continue
  const byTime = new Map()
  for (const line of fs.readFileSync(filename, "utf8").split(/\r?\n/)) {
    if (!line) continue
    let row
    try { row = JSON.parse(line) } catch { continue }
    const at = Number(row.time)
    if (indiaDate(at * 1000) === date) byTime.set(at, row)
  }
  const candles = [...byTime.values()].sort((a, b) => a.time - b.time)
  for (let index = 20; index < candles.length; index++) {
    const current = candles[index]
    const previous5 = candles.slice(index - 5, index)
    const previous20 = candles.slice(index - 20, index)
    if (current.time !== previous20[0].time + 20 * 60 ||
        previous20.some((row, offset) => offset > 0 && row.time !== previous20[offset - 1].time + 60)) continue
    const sma20 = previous20.reduce((sum, row) => sum + row.close, 0) / 20
    const return5 = (current.close / previous5[0].close - 1) * 100
    const return20 = (current.close / previous20[0].close - 1) * 100
    const below5Low = current.close < Math.min(...previous5.map((row) => row.low))
    const row = breadth.get(current.time) || { count: 0, belowSma20: 0, down5: 0, down20: 0, below5Low: 0, sumReturn5: 0 }
    row.count++
    row.belowSma20 += current.close < sma20 ? 1 : 0
    row.down5 += return5 < 0 ? 1 : 0
    row.down20 += return20 < 0 ? 1 : 0
    row.below5Low += below5Low ? 1 : 0
    row.sumReturn5 += return5
    breadth.set(current.time, row)
  }
}
for (const signal of signals) {
  const candleTime = Date.parse(signal.time) / 1000 - 60
  const row = breadth.get(candleTime)
  const prior = breadth.get(candleTime - 60)
  const summarize = (sample) => sample ? {
    stocks: sample.count,
    belowSma20: sample.belowSma20 / sample.count,
    down5: sample.down5 / sample.count,
    down20: sample.down20 / sample.count,
    below5Low: sample.below5Low / sample.count,
    meanReturn5: sample.sumReturn5 / sample.count,
  } : null
  signal.analysis.market = summarize(row)
  signal.analysis.marketPrevious = summarize(prior)
}
fs.writeFileSync(output, JSON.stringify(signals))
const selected = signals.filter((s) => s.analysis.depth3Ofi <= -0.10 &&
  s.analysis.sma20Gap <= -0.20 && s.analysis.candleRangePct <= 0.15 &&
  s.analysis.volumeX5 <= 2.6 && s.breakoutPct >= 0.07 && s.analysis.depth5Orders <= 0.02)
console.log(`Saved ${output}`)
console.table(selected.map((s) => ({ symbol: s.symbol, at: new Date(s.time).toLocaleTimeString("en-IN", {
  timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
}), status: s.status, previousSma: Number(s.analysis.marketPrevious?.belowSma20?.toFixed(3)),
  ...Object.fromEntries(Object.entries(s.analysis.market || {}).map(([key, value]) => [key,
  typeof value === "number" ? Number(value.toFixed(3)) : value])) })))
