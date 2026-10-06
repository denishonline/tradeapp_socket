import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const date = process.argv[2] || "2026-10-05"
const filename = path.join(os.tmpdir(), `tradeapp-short-signal-features-${date}.json`)
const rows = JSON.parse(fs.readFileSync(filename, "utf8"))
const winners = rows.filter((row) => row.status === "Target reached")
const others = rows.filter((row) => row.status !== "Target reached")
const featureNames = ["breakoutPct", "volumeMultiple", "depthImbalance", "top2Imbalance",
  "return5", "return10", "return20", "return30", "return50",
  "sma10Gap", "sma20Gap", "sma50Gap", "rsi14", "redBars10", "redBars20",
  "volumeX5", "volumeX10", "volumeX20", "atr14Pct", "range20Pct", "vwapGap", "candleRangePct",
  "depth3Full", "depth3Top2", "depth3Orders", "depth3BestQueue", "depth3SpreadPct", "depth3Ofi", "depth3AskFraction",
  "depth5Full", "depth5Top2", "depth5Orders", "depth5BestQueue", "depth5SpreadPct", "depth5Ofi", "depth5AskFraction",
  "depth10Full", "depth10Top2", "depth10Orders", "depth10BestQueue", "depth10SpreadPct", "depth10Ofi", "depth10AskFraction"]
const value = (row, name) => name in row ? row[name] : row.analysis?.[name]
const number = (n) => Number.isFinite(n) ? Number(n.toFixed(3)) : "—"
console.log(`Live Radar short signals: ${rows.length}; target ${winners.length}; other ${others.length}`)
for (const winner of winners) {
  console.log(`${winner.symbol} ${new Date(winner.time).toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })} ${winner.pattern}`)
  console.log(Object.fromEntries(featureNames.map((name) => [name, number(value(winner, name))])))
}
const cuts = []
for (const name of featureNames) {
  const winValues = winners.map((row) => value(row, name))
  if (winValues.some((v) => !Number.isFinite(v))) continue
  for (const [direction, threshold] of [[">=", Math.min(...winValues)], ["<=", Math.max(...winValues)]]) {
    const passes = (row) => {
      const v = value(row, name)
      return Number.isFinite(v) && (direction === ">=" ? v >= threshold : v <= threshold)
    }
    cuts.push({ name, direction, threshold, otherKept: others.filter(passes).length })
  }
}
cuts.sort((a, b) => a.otherKept - b.otherKept)
console.log("Single bounds fitted to retain all five winners:")
console.table(cuts.slice(0, 30).map((cut) => ({ feature: cut.name, direction: cut.direction,
  threshold: number(cut.threshold), otherKept: cut.otherKept })))
