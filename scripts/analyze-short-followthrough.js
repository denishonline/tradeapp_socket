import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const date = process.argv[2] || "2026-10-05"
const rows = JSON.parse(fs.readFileSync(path.join(os.tmpdir(), `tradeapp-short-signal-features-${date}.json`), "utf8"))
const candlesBySymbol = new Map()
function candlesFor(symbol) {
  if (candlesBySymbol.has(symbol)) return candlesBySymbol.get(symbol)
  const filename = path.join(process.cwd(), "db", "candles", `${symbol}.jsonl`)
  const byTime = new Map()
  for (const line of fs.readFileSync(filename, "utf8").split(/\r?\n/)) {
    if (!line) continue
    let candle
    try { candle = JSON.parse(line) } catch { continue }
    if (new Date(Number(candle.time) * 1000 + 330 * 60_000).toISOString().slice(0, 10) !== date) continue
    byTime.set(Number(candle.time), candle)
  }
  candlesBySymbol.set(symbol, byTime)
  return byTime
}
const selected = rows.filter((s) => s.analysis.depth3Ofi <= -0.10 &&
  s.analysis.sma20Gap <= -0.20 && s.analysis.candleRangePct <= 0.15 &&
  s.analysis.volumeX5 <= 2.6 && s.breakoutPct >= 0.07 && s.analysis.depth5Orders <= 0.02)
console.table(selected.map((signal) => {
  const candleTime = Date.parse(signal.time) / 1000 - 60
  const byTime = candlesFor(signal.symbol)
  const ahead = {}
  for (const minute of [1, 2, 3, 5, 10]) {
    const candle = byTime.get(candleTime + minute * 60)
    ahead[`close${minute}`] = candle ? Number(((candle.close / signal.price - 1) * 100).toFixed(3)) : null
  }
  return { symbol: signal.symbol, at: new Date(signal.time).toLocaleTimeString("en-IN", {
    timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }), status: signal.status,
    rsi: Number(signal.analysis.rsi14.toFixed(1)),
    return20: Number(signal.analysis.return20.toFixed(3)),
    return30: Number(signal.analysis.return30.toFixed(3)),
    vwapGap: Number(signal.analysis.vwapGap.toFixed(3)),
    range20: Number(signal.analysis.range20Pct.toFixed(3)),
    ofi5: Number(signal.analysis.depth5Ofi.toFixed(3)),
    depth5Full: Number(signal.analysis.depth5Full.toFixed(3)),
    depth10Full: Number(signal.analysis.depth10Full.toFixed(3)),
    askFraction5: Number(signal.analysis.depth5AskFraction.toFixed(3)),
    ...ahead }
}))
