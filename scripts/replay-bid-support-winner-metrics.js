import fs from "node:fs"
import path from "node:path"
import { createBidSupportBreakout } from "../ui/bid-support-breakout.js"

const ROOT = process.cwd()
const MINUTE = 60_000
const winners = [
  ["2026-10-05", "BANKINDIA"], ["2026-10-05", "MPHASIS"],
  ["2026-10-06", "BHEL"], ["2026-10-06", "PGEL"],
  ["2026-10-06", "PIDILITIND"], ["2026-10-06", "NAUKRI"],
  ["2026-10-07", "HAVELLS"],
]
const indiaDate = (at) => new Date(at + 330 * MINUTE).toISOString().slice(0, 10)
const readLines = (filename) => fs.existsSync(filename)
  ? fs.readFileSync(filename, "utf8").split(/\r?\n/).flatMap((line) => {
      if (!line.trim()) return []
      try { return [JSON.parse(line)] } catch { return [] }
    }) : []

for (const [date, symbol] of winners) {
  let clock = Date.parse(`${date}T03:40:00.000Z`)
  let snapshot = []
  const radar = createBidSupportBreakout({ now: () => clock, onUpdate: (rows) => { snapshot = rows } })
  const candleEvents = readLines(path.join(ROOT, "db", "candles", `${symbol}.jsonl`))
    .filter((row) => row.source === "websocket" && indiaDate(Number(row.time) * 1000) === date)
    .map((row) => ({ at: (Number(row.time) + 60) * 1000 + 2_100, type: "candle", row }))
  const depthEvents = readLines(path.join(ROOT, "db", "cash-depth", date, symbol, `${symbol}.jsonl`))
    .map((row) => ({ at: Date.parse(row.receivedAt), type: "depth", row }))
    .filter((event) => Number.isFinite(event.at))
  const events = [...candleEvents, ...depthEvents].sort((a, b) => a.at - b.at ||
    (a.type === "candle" ? -1 : 1))
  for (const event of events) {
    clock = event.at
    if (event.type === "candle") radar.observeCandle(symbol, event.row)
    else radar.observeDepth(event.row.data, event.at, event.row.marketContext)
  }
  console.log(JSON.stringify({ date, symbol, signals: snapshot.map((row) => ({
    time: row.time, price: row.price, status: row.status, metrics: row.metrics,
  })) }))
}
