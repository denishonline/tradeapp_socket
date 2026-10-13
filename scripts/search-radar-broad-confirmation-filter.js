import fs from "node:fs"
import path from "node:path"

const ROOT = process.cwd()
const MINUTE = 60_000
const SIGNAL_ROOT = path.join(ROOT, "db", "strategy-signals")
const DEPTH_ROOT = path.join(ROOT, "db", "cash-depth")
const CANDLE_ROOT = path.join(ROOT, "db", "candles")
const indiaTimeMs = (date, time) => Date.parse(`${date}T${time}+05:30`)
const indiaDate = (at) => new Date(at + 330 * MINUTE).toISOString().slice(0, 10)
const sideReturn = (entry, price, side) => (side === "SELL" ? -1 : 1) * (price / entry - 1) * 100

function csvRows(filename) {
  const lines = fs.readFileSync(filename, "utf8").trim().split(/\r?\n/)
  const columns = lines.shift().split(",")
  return lines.map((line) => Object.fromEntries(line.split(",").map((value, index) => [columns[index], value])))
}
function jsonLines(filename) {
  if (!fs.existsSync(filename)) return []
  return fs.readFileSync(filename, "utf8").split(/\r?\n/).flatMap((line) => {
    if (!line.trim()) return []
    try { return [JSON.parse(line)] } catch { return [] }
  })
}
const depthRecordCache = new Map()
function depthRecords(date, symbol) {
  const key = `${date}:${symbol}`
  if (!depthRecordCache.has(key)) {
    const filename = path.join(DEPTH_ROOT, date, symbol, `${symbol}.jsonl`)
    depthRecordCache.set(key, jsonLines(filename).flatMap((record) => {
      const at = Date.parse(record.receivedAt), price = Number(record.marketContext?.price)
      return Number.isFinite(at) && Number.isFinite(price) && price > 0 ? [{ at, price }] : []
    }).sort((a, b) => a.at - b.at))
  }
  return depthRecordCache.get(key)
}
const signalPathCache = new Map()
const candleRecordCache = new Map()
function candleRecords(symbol) {
  if (!candleRecordCache.has(symbol)) {
    const filename = path.join(CANDLE_ROOT, `${symbol}.jsonl`)
    candleRecordCache.set(symbol, jsonLines(filename).flatMap((record) => {
      const at = (Number(record.time) + 60) * 1000
      const price = Number(record.close)
      return Number.isFinite(at) && Number.isFinite(price) && price > 0 ? [{ at, price }] : []
    }).sort((a, b) => a.at - b.at))
  }
  return candleRecordCache.get(symbol)
}
function pathAfter(row, minutes) {
  const key = `${row.date}:${row.symbol}:${row.at}:${row.entry}:${row.side}`
  if (!signalPathCache.has(key)) {
    const deadline = row.at + 60 * MINUTE
    const depth = depthRecords(row.date, row.symbol).flatMap(({ at, price }) =>
      at > row.at && at <= deadline ? [{ at, value: sideReturn(row.entry, price, row.side) }] : [])
    const candles = candleRecords(row.symbol).flatMap(({ at, price }) =>
      at > row.at && at <= deadline && indiaDate(at) === row.date
        ? [{ at, value: sideReturn(row.entry, price, row.side) }] : [])
    signalPathCache.set(key, [...depth, ...candles].sort((a, b) => a.at - b.at))
  }
  const deadline = row.at + minutes * MINUTE
  return signalPathCache.get(key).filter((sample) => sample.at <= deadline)
}
function decision(row, rule) {
  const samples = pathAfter(row, rule.waitMinutes)
  for (const sample of samples) {
    if (sample.value <= -rule.invalidationPct) return { pass: false, reason: "invalidated", at: sample.at }
    if (sample.value >= rule.confirmationPct) return { pass: true, reason: "confirmed", at: sample.at }
  }
  return { pass: false, reason: "timeout", at: null }
}

const winners = []
for (const row of csvRows(path.join(ROOT, "csv", "2026-10-05-to-07-all-strategy-radar-results.csv"))) {
  if (row.outcome !== "Target reached") continue
  winners.push({ source: "radar-history", date: row.date, strategy: row.strategy, symbol: row.symbol,
    side: "BUY", entry: null, at: indiaTimeMs(row.date, row.signal_ist) })
}
for (const row of csvRows(path.join(ROOT, "csv", "2026-10-06-to-08-optimized-multiframe-depth-buy-zero-stop-audit.csv"))) {
  winners.push({ source: "multi-buy", date: row.date, strategy: "Multi-Frame Depth Recovery", symbol: row.symbol,
    side: "BUY", entry: Number(row.entry), at: indiaTimeMs(row.date, row.time_ist) })
}
for (const row of csvRows(path.join(ROOT, "csv", "2026-10-06-to-08-multiframe-depth-2pct-zero-stop-audit.csv"))) {
  winners.push({ source: "multi-sell", date: row.date, strategy: "Multi-Frame Depth Continuation", symbol: row.symbol,
    side: "SELL", entry: Number(row.entry), at: indiaTimeMs(row.date, row.time_ist) })
}
for (const row of csvRows(path.join(ROOT, "csv", "2026-10-06-to-09-enhanced-failed-bid-absorption.csv"))) {
  if (row.result !== "TARGET") continue
  winners.push({ source: "failed-bid", date: row.date, strategy: "Failed Bid Absorption", symbol: row.symbol,
    side: "SELL", entry: Number(row.entryPrice), at: indiaTimeMs(row.date, `${row.confirmationTime}:00`) })
}

// The early radar CSV does not retain entry prices; recover the closest market-context price.
for (const row of winners.filter((item) => !Number.isFinite(item.entry))) {
  const samples = depthRecords(row.date, row.symbol)
    .filter(({ at }) => Math.abs(at - row.at) <= MINUTE)
    .sort((a, b) => Math.abs(a.at - row.at) - Math.abs(b.at - row.at))
  row.entry = samples[0]?.price
}

// Include the October 12 winner produced by the current live implementation.
const currentSignals = []
for (const directory of fs.readdirSync(SIGNAL_ROOT, { withFileTypes: true }).filter((entry) => entry.isDirectory())) {
  for (const date of ["2026-10-09", "2026-10-12", "2026-10-13"]) {
    const filename = path.join(SIGNAL_ROOT, directory.name, `${date}.json`)
    if (!fs.existsSync(filename)) continue
    for (const signal of JSON.parse(fs.readFileSync(filename, "utf8"))) {
      const row = { source: "live", date, strategy: signal.strategy, symbol: signal.symbol,
        side: signal.direction, entry: Number(signal.price), at: Date.parse(signal.time), status: signal.status }
      currentSignals.push(row)
      if (signal.status === "Target reached") winners.push({ ...row, source: "current-winner" })
    }
  }
}
const stops = currentSignals.filter((row) => row.status === "Stopped")
const validWinners = winners.filter((row) => Number.isFinite(row.entry) && row.entry > 0)
const strategies = [...new Set(stops.map((row) => row.strategy))]
const candidates = []
for (const confirmationPct of [0.02, 0.05, 0.08, 0.10, 0.12, 0.15, 0.20]) {
  for (const invalidationPct of [0.15, 0.20, 0.25, 0.30, 0.40, 0.50]) {
    for (const waitMinutes of [3, 5, 8, 10, 15, 20, 30, 45, 60]) {
      const rule = { confirmationPct, invalidationPct, waitMinutes }
      const winnerDecisions = validWinners.map((row) => ({ row, ...decision(row, rule) }))
      const stopDecisions = stops.map((row) => ({ row, ...decision(row, rule) }))
      candidates.push({ ...rule,
        winnersTotal: winnerDecisions.length, winnersKept: winnerDecisions.filter((row) => row.pass).length,
        stopsTotal: stopDecisions.length, stopsRejected: stopDecisions.filter((row) => !row.pass).length,
        winnerMisses: winnerDecisions.filter((item) => !item.pass).map((item) => `${item.row.strategy}:${item.row.symbol}`),
        stoppedRejected: stopDecisions.filter((item) => !item.pass).map((item) => `${item.row.strategy}:${item.row.symbol}`) })
    }
  }
}
const preserving = candidates.filter((row) => row.winnersKept === row.winnersTotal)
  .sort((a, b) => b.stopsRejected - a.stopsRejected || a.waitMinutes - b.waitMinutes ||
    b.confirmationPct - a.confirmationPct || a.invalidationPct - b.invalidationPct)

const perStrategy = {}
for (const strategy of strategies) {
  const strategyWinners = validWinners.filter((row) => row.strategy === strategy)
  const strategyStops = stops.filter((row) => row.strategy === strategy)
  const rows = []
  for (const confirmationPct of [0.02, 0.05, 0.08, 0.10, 0.12, 0.15, 0.20]) {
    for (const invalidationPct of [0.15, 0.20, 0.25, 0.30, 0.40, 0.50]) {
      for (const waitMinutes of [3, 5, 8, 10, 15, 20, 30, 45, 60]) {
        const rule = { confirmationPct, invalidationPct, waitMinutes }
        const winnerDecisions = strategyWinners.map((row) => decision(row, rule))
        const stopDecisions = strategyStops.map((row) => ({ symbol: row.symbol, ...decision(row, rule) }))
        if (winnerDecisions.every((row) => row.pass)) rows.push({ ...rule,
          winnersKept: winnerDecisions.length, stopsRejected: stopDecisions.filter((row) => !row.pass).length,
          rejectedSymbols: stopDecisions.filter((row) => !row.pass).map((row) => row.symbol) })
      }
    }
  }
  perStrategy[strategy] = rows.sort((a, b) => b.stopsRejected - a.stopsRejected ||
    a.waitMinutes - b.waitMinutes || b.confirmationPct - a.confirmationPct)[0] || null
}

const selectedConfirmationRules = {
  "Multi-Frame Depth Recovery": { confirmationPct: 0.08, invalidationPct: 0.20, waitMinutes: 20 },
  "Multi-Frame Depth Continuation": { confirmationPct: 0.20, invalidationPct: 0.40, waitMinutes: 10 },
  "Persistent Bid Absorption Breakout": { confirmationPct: 0.05, invalidationPct: 0.15, waitMinutes: 5 },
}
const currentSelectedRuleDecisions = currentSignals.flatMap((row) => {
  const rule = selectedConfirmationRules[row.strategy]
  if (!rule) return []
  return [{ date: row.date, strategy: row.strategy, symbol: row.symbol, savedStatus: row.status,
    ...decision(row, rule) }]
})

console.log(JSON.stringify({ historicalWinners: validWinners.length,
  winnersByStrategy: Object.fromEntries([...new Set(validWinners.map((row) => row.strategy))].map((strategy) =>
    [strategy, validWinners.filter((row) => row.strategy === strategy).length])),
  currentStops: stops.length, bestUniversalWinnerPreservingRule: preserving[0] || null,
  topUniversalRules: preserving.slice(0, 10), perStrategy, currentSelectedRuleDecisions }, null, 2))
