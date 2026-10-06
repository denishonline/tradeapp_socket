import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const date = process.argv[2] || "2026-10-05"
const rows = JSON.parse(fs.readFileSync(path.join(os.tmpdir(), `tradeapp-short-signal-breadth-${date}.json`), "utf8"))
const gates = [
  ["prior market below SMA20 ≤ 80%", "marketSma", (s) => s.analysis.marketPrevious?.belowSma20 <= 0.8],
  ["prior market new 5m lows ≤ 55%", "marketLows", (s) => s.analysis.marketPrevious?.below5Low <= 0.55],
  ["prior market 5m down ≤ 90%", "marketDown", (s) => s.analysis.marketPrevious?.down5 <= 0.9],
  ["before 12:00 IST", "time", (s) => { const d = new Date(s.time); return d.getUTCHours() * 60 + d.getUTCMinutes() < 390 }],
  ["5m OFI ≤ -0.06", "ofi5", (s) => s.analysis.depth5Ofi <= -0.06],
  ["5m OFI ≤ -0.07", "ofi5", (s) => s.analysis.depth5Ofi <= -0.07],
  ["5m OFI ≥ -0.12", "ofi5min", (s) => s.analysis.depth5Ofi >= -0.12],
  ["5m OFI ≥ -0.15", "ofi5min", (s) => s.analysis.depth5Ofi >= -0.15],
  ["3m OFI ≤ -0.09", "ofi3", (s) => s.analysis.depth3Ofi <= -0.09],
  ["3m OFI ≤ -0.10", "ofi3", (s) => s.analysis.depth3Ofi <= -0.10],
  ["20m SMA gap ≤ -0.15%", "sma20", (s) => s.analysis.sma20Gap <= -0.15],
  ["20m SMA gap ≤ -0.20%", "sma20", (s) => s.analysis.sma20Gap <= -0.20],
  ["VWAP gap ≤ -0.10%", "vwap", (s) => s.analysis.vwapGap <= -0.10],
  ["VWAP gap ≤ -0.15%", "vwap", (s) => s.analysis.vwapGap <= -0.15],
  ["candle range ≤ 0.15%", "range", (s) => s.analysis.candleRangePct <= 0.15],
  ["20m range ≤ 0.70%", "range20", (s) => s.analysis.range20Pct <= 0.70],
  ["20m range ≤ 0.75%", "range20", (s) => s.analysis.range20Pct <= 0.75],
  ["RSI14 ≥ 20", "rsi", (s) => s.analysis.rsi14 >= 20],
  ["volume ≤ 2.6× prior 5", "volume", (s) => s.analysis.volumeX5 <= 2.6],
  ["volume ≤ 3× prior 5", "volume", (s) => s.analysis.volumeX5 <= 3],
  ["breakdown ≥ 0.07%", "breakdown", (s) => s.breakoutPct >= 0.07],
  ["4 red bars / 10", "red", (s) => s.analysis.redBars10 >= 4],
  ["10m return ≤ -0.10%", "ret10", (s) => s.analysis.return10 <= -0.10],
  ["20m return ≤ -0.10%", "ret20", (s) => s.analysis.return20 <= -0.10],
  ["10m OFI ≤ -0.02", "ofi10", (s) => s.analysis.depth10Ofi <= -0.02],
  ["3m order imbalance ≤ 0.01", "orders3", (s) => s.analysis.depth3Orders <= 0.01],
  ["5m order imbalance ≤ 0.02", "orders5", (s) => s.analysis.depth5Orders <= 0.02],
]
const winners = rows.filter((s) => s.status === "Target reached")
const valid = gates.filter((gate) => winners.every(gate[2]))
const combos = []
function review(chosen) {
  const kept = rows.filter((s) => chosen.every((gate) => gate[2](s)))
  const target = kept.filter((s) => s.status === "Target reached").length
  if (target !== winners.length) return
  combos.push({ gates: chosen.map((gate) => gate[0]).join(" + "),
    total: kept.length, target, stopped: kept.filter((s) => s.status === "Stopped").length,
    active: kept.filter((s) => s.status === "Active").length,
    timeSpan: [...new Set(kept.map((s) => new Date(s.time).getUTCHours()))].length })
}
function choose(start, chosen, max) {
  if (chosen.length) review(chosen)
  if (chosen.length === max) return
  for (let index = start; index < valid.length; index++) {
    if (chosen.some((gate) => gate[1] === valid[index][1])) continue
    choose(index + 1, [...chosen, valid[index]], max)
  }
}
choose(0, [], 6)
combos.sort((a, b) => a.stopped - b.stopped || a.active - b.active || a.gates.split(" + ").length - b.gates.split(" + ").length)
console.log(`Base ${rows.length}: target ${winners.length}, stopped ${rows.filter((s) => s.status === "Stopped").length}, active ${rows.filter((s) => s.status === "Active").length}`)
console.table(combos.slice(0, 30))
const selected = valid.filter((gate) => combos[0]?.gates.includes(gate[0]))
console.log("Top rule survivors:")
console.table(rows.filter((row) => selected.every((gate) => gate[2](row))).map((row) => ({
  symbol: row.symbol, at: new Date(row.time).toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }),
  status: row.status, pattern: row.pattern, entry: row.price,
  sma20Gap: Number(row.analysis.sma20Gap.toFixed(3)), candleRangePct: Number(row.analysis.candleRangePct.toFixed(3)),
  volumeX5: Number(row.analysis.volumeX5.toFixed(3)), breakdown: Number(row.breakoutPct.toFixed(3)),
  ofi3: Number(row.analysis.depth3Ofi.toFixed(3)), orders5: Number(row.analysis.depth5Orders.toFixed(3)),
})))
