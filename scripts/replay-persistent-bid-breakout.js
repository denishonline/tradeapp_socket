import fs from "node:fs"
import path from "node:path"
import { createPersistentBidBreakout } from "../ui/persistent-bid-breakout.js"

const [date = "2026-10-06", inputSymbol = "NESTLEIND"] = process.argv.slice(2)
const startAt = Date.parse(`${date}T09:15:00+05:30`)
const endAt = Date.parse(`${date}T15:30:00+05:30`)
const indiaDate = (time) => new Date(time + 330 * 60_000).toISOString().slice(0, 10)
const displayTime = (time) => new Intl.DateTimeFormat("en-IN", {
  timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
}).format(new Date(time))

function readEvents(symbol) {
  const events = []
  const depthFile = path.join(process.cwd(), "db", "cash-depth", date, symbol, `${symbol}.jsonl`)
  const candleFile = path.join(process.cwd(), "db", "candles", `${symbol}.jsonl`)
  if (fs.existsSync(depthFile)) {
    for (const line of fs.readFileSync(depthFile, "utf8").split(/\r?\n/)) {
      if (!line) continue
      const record = JSON.parse(line)
      const at = Date.parse(record.receivedAt)
      if (at >= startAt && at < endAt) events.push({ kind: "depth", at, record })
    }
  }
  if (fs.existsSync(candleFile)) {
    for (const line of fs.readFileSync(candleFile, "utf8").split(/\r?\n/)) {
      if (!line) continue
      const row = JSON.parse(line)
      const time = Number(row.time) * 1000
      const at = time + 60_000
      if (indiaDate(time) === date && at >= startAt && at < endAt) {
        events.push({ kind: "candle", at, candle: row })
      }
    }
  }
  events.sort((a, b) => a.at - b.at || (a.kind === "depth" ? -1 : 1))
  return events
}

function replay(symbol) {
  const events = readEvents(symbol)
  const signals = []
  const radar = createPersistentBidBreakout({
    now: () => startAt,
    onUpdate: (rows) => {
      for (const signal of rows) if (!signals.some((item) => item.id === signal.id)) signals.push(signal)
    },
  })
  for (const event of events) {
    if (event.kind === "depth") {
      const record = event.record
      radar.observeDepth(record.data, new Date(event.at), record.marketContext)
    } else radar.observeCandle(symbol, event.candle)
  }
  return { events: events.length, signals }
}

const allStocks = inputSymbol.toUpperCase() === "ALL"
const symbols = allStocks
  ? fs.readdirSync(path.join(process.cwd(), "db", "cash-depth", date), { withFileTypes: true })
      .filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort()
  : [inputSymbol.toUpperCase().replace(/-EQ$/, "")]
const allSignals = []
let totalEvents = 0
for (const symbol of symbols) {
  const result = replay(symbol)
  totalEvents += result.events
  allSignals.push(...result.signals)
  if (!allStocks) console.log(`${symbol} ${date}: replayed ${result.events} chronological depth/candle events`)
}
if (allStocks) console.log(`${date}: replayed ${symbols.length} stocks and ${totalEvents} chronological depth/candle events`)
console.table(allSignals.map(({ id, strategy, symbol, time, price, stop, target, status, metrics }) => ({
  id, strategy, symbol, signalAt: displayTime(time), price,
  stop: Number(stop.toFixed(2)), target: Number(target.toFixed(2)), status,
  candlesUsed: metrics.candlesUsed,
  return120Pct: Number(metrics.return120Pct.toFixed(3)),
  trendEfficiency120: Number(metrics.trendEfficiency120.toFixed(3)),
  volumeBarsAboveMedian: metrics.momentumVolumeBarsAboveMedian,
  positiveDepthStreakMinutes: metrics.positiveDepthStreakMinutes,
  positiveDepthStreakFrom: displayTime(metrics.positiveDepthStreakFrom),
  partialBuyerAccelerationFrom: displayTime(metrics.partialBuyerAccelerationFrom),
  flowShiftAt: displayTime(metrics.flowShiftAt),
  full: Number(metrics.fullImbalance.toFixed(3)),
  top2: Number(metrics.top2Imbalance.toFixed(3)),
  quoteFlow: Number(metrics.normalizedOrderFlow.toFixed(3)),
  latestMinuteFlow: Number(metrics.latestMinuteOrderFlow.toFixed(3)),
})))
console.log(`Total signals: ${allSignals.length}`)
