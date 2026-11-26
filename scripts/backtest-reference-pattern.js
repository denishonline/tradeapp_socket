import fs from "node:fs"
import path from "node:path"

const root = process.cwd()
const date = process.argv[2] ?? "2026-10-21"
const source = path.join(root, "reports", `${date}-synchronized-compression-breakdown.json`)
const requested = [
  ["IDEA", "09:50"],
  ["IIFL", "09:45"],
  ["KEI", "10:10"],
  ["SRF", "11:10"],
  ["HINDPETRO", "11:30"],
  ["ICICIPRULI", "11:30"]
]
const minute = value => Number(value.slice(0, 2)) * 60 + Number(value.slice(3, 5))
const rows = JSON.parse(fs.readFileSync(source, "utf8")).matches

// This is deliberately a reference-window validation, not the previous generic
// all-day scan. Each observed setup is matched only inside +/-5 minutes of its
// stated time, and the closest confirmation is selected.
const matches = requested.map(([symbol, target]) => {
  const targetMinute = minute(target)
  const candidates = rows.filter(row => {
    if (row.symbol !== symbol) return false
    const signalMinute = minute(row.signalTime.slice(11, 16))
    return Math.abs(signalMinute - targetMinute) <= 5
  }).sort((a, b) => {
    const da = Math.abs(minute(a.signalTime.slice(11, 16)) - targetMinute)
    const db = Math.abs(minute(b.signalTime.slice(11, 16)) - targetMinute)
    return da - db || a.signalTime.localeCompare(b.signalTime)
  })
  return { requestedTime: `${date} ${target}`, ...(candidates[0] ?? { symbol, signalTime: null, entryTime: null }) }
})

const report = {
  date,
  universeCount: 215,
  referenceCount: requested.length,
  window: "Each reference setup: target time +/- 5 minutes",
  rule: "Prior 10 one-minute candles show synchronized EMA9/EMA45/VWAP compression with downward drift; confirmation is a bearish candle closing below its open and prior close while Price < EMA9 < EMA45 < VWAP. Depth is diagnostic only, because the reference examples include both ask pressure and bid absorption.",
  matches
}
const output = path.join(root, "reports", `${date}-reference-pattern-validation.json`)
fs.writeFileSync(output, JSON.stringify(report, null, 2) + "\n")
console.log(JSON.stringify(report, null, 2))
