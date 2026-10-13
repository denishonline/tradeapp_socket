import fs from "node:fs"
import path from "node:path"
import { createPersistentBidBreakout } from "../ui/persistent-bid-breakout.js"

const ROOT = process.cwd(), MINUTE = 60_000, date = "2026-10-06", symbol = "NESTLEIND"
const indiaDate = (at) => new Date(at + 330 * MINUTE).toISOString().slice(0, 10)
const readLines = (filename) => fs.readFileSync(filename, "utf8").split(/\r?\n/).flatMap((line) => {
  if (!line.trim()) return []
  try { return [JSON.parse(line)] } catch { return [] }
})
let clock = Date.parse(`${date}T03:40:00.000Z`), snapshot = []
const radar = createPersistentBidBreakout({ now: () => clock, onUpdate: (rows) => { snapshot = rows } })
const candles = readLines(path.join(ROOT, "db", "candles", `${symbol}.jsonl`))
  .filter((row) => row.source === "websocket" && indiaDate(Number(row.time) * 1000) === date)
  .map((row) => ({ at: (Number(row.time) + 60) * 1000 + 100, type: "candle", row }))
const depths = readLines(path.join(ROOT, "db", "cash-depth", date, symbol, `${symbol}.jsonl`))
  .map((row) => ({ at: Date.parse(row.receivedAt), type: "depth", row }))
for (const event of [...candles, ...depths].filter((row) => Number.isFinite(row.at))
  .sort((a, b) => a.at - b.at || (a.type === "depth" ? -1 : 1))) {
  clock = event.at
  if (event.type === "candle") radar.observeCandle(symbol, event.row)
  else {
    radar.observeDepth(event.row.data, event.at, event.row.marketContext)
    const price = Number(event.row.marketContext?.price)
    if (Number.isFinite(price) && price > 0) {
      radar.observePrice({ symbol: event.row.data?.symbol, ltp: price }, event.at)
    }
  }
}
console.log(JSON.stringify(snapshot, null, 2))
