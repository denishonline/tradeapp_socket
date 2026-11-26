import fs from "node:fs"
import path from "node:path"

const root = process.cwd()
const date = process.argv[2] ?? "2026-10-21"
const round = (n, places = 3) => Number(n.toFixed(places))
const pct = (a, b) => 100 * (a / b - 1)
const rangePct = values => pct(Math.max(...values), Math.min(...values))
const minute = text => Number(text.slice(0, 2)) * 60 + Number(text.slice(3, 5))
const stamp = epoch => new Date(epoch * 1000 + 330 * 60_000).toISOString().slice(0, 16).replace("T", " ")
const symbols = [...new Set(JSON.parse(fs.readFileSync(path.join(root, "db", "stocks"), "utf8"))
  .map(value => String(value).trim().toUpperCase().replace(/-EQ$/, "")))]

function candles(symbol) {
  const file = path.join(root, "db", "candles", `${symbol}.jsonl`)
  if (!fs.existsSync(file)) return []
  const rows = []
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    if (!line) continue
    let raw
    try { raw = JSON.parse(line) } catch { continue }
    const time = stamp(Number(raw.time)), m = minute(time.slice(11))
    if (time.slice(0, 10) !== date || m < 555 || m > 929 ||
      ![raw.open, raw.high, raw.low, raw.close, raw.volume].every(x => Number.isFinite(Number(x)))) continue
    rows.push({ time, minute: m, open: +raw.open, high: +raw.high, low: +raw.low, close: +raw.close, volume: +raw.volume })
  }
  rows.sort((a, b) => a.minute - b.minute)
  let ema9, ema45, priceVolume = 0, totalVolume = 0
  return rows.map(row => {
    ema9 = ema9 == null ? row.close : .2 * row.close + .8 * ema9
    ema45 = ema45 == null ? row.close : 2 / 46 * row.close + 44 / 46 * ema45
    priceVolume += (row.high + row.low + row.close) / 3 * row.volume
    totalVolume += row.volume
    return { ...row, ema9, ema45, vwap: priceVolume / totalVolume }
  })
}

function exitForShort(rows, entryIndex) {
  const entry = rows[entryIndex]
  const target = entry.close * .9875
  const stop = entry.close * 1.006
  let best = 0, worst = 0
  for (let j = entryIndex + 1; j < rows.length; j++) {
    const bar = rows[j]
    best = Math.max(best, -pct(bar.low, entry.close))
    worst = Math.max(worst, pct(bar.high, entry.close))
    // When both levels are inside one candle, assume the stop came first.
    if (bar.high >= stop) return { exitIndex: j, exitTime: bar.time, exitPrice: stop, exitReason: "stop", favorableMovePct: best, adverseMovePct: worst }
    if (bar.low <= target) return { exitIndex: j, exitTime: bar.time, exitPrice: target, exitReason: "target", favorableMovePct: best, adverseMovePct: worst }
  }
  const last = rows.at(-1)
  return { exitIndex: rows.length - 1, exitTime: last.time, exitPrice: last.close, exitReason: "sessionEnd", favorableMovePct: best, adverseMovePct: worst }
}

const trades = [], unavailable = []
for (const symbol of symbols) {
  const rows = candles(symbol)
  if (rows.length < 30) { unavailable.push(symbol); continue }
  for (let i = 10; i < rows.length - 2; i++) {
    const row = rows[i], previous = rows[i - 1], pre = rows.slice(i - 10, i)
    // A ten-minute window must contain ten consecutive one-minute candles.
    if (pre[0].minute !== row.minute - 10 || pre.some((bar, k) => bar.minute !== row.minute - 10 + k)) continue
    const next = rows[i + 1]
    if (next.minute !== row.minute + 1) continue
    const compressed = rangePct(pre.map(x => x.ema9)) <= .75 &&
      rangePct(pre.map(x => x.ema45)) <= .30 &&
      rangePct(pre.map(x => x.vwap)) <= .15
    const downward = ["ema9", "ema45", "vwap"].filter(key => pre.at(-1)[key] < pre[0][key]).length
    const stack = row.close < row.ema9 && row.ema9 < row.ema45 && row.ema45 < row.vwap
    const priorStack = previous.close < previous.ema9 && previous.ema9 < previous.ema45 && previous.ema45 < previous.vwap
    if (!(compressed && downward >= 2 && stack && !priorStack && row.close < row.open && row.close < previous.close)) continue
    const outcome = exitForShort(rows, i + 1)
    trades.push({ symbol, signalTime: row.time, entryTime: next.time, entryPrice: round(next.close),
      exitTime: outcome.exitTime, exitPrice: round(outcome.exitPrice), exitReason: outcome.exitReason,
      returnPct: round(-pct(outcome.exitPrice, next.close)),
      favorableMovePct: round(outcome.favorableMovePct), adverseMovePct: round(outcome.adverseMovePct),
      pre10Ema9RangePct: round(rangePct(pre.map(x => x.ema9))),
      pre10Ema45RangePct: round(rangePct(pre.map(x => x.ema45))),
      pre10VwapRangePct: round(rangePct(pre.map(x => x.vwap))) })
    i = outcome.exitIndex // Re-enter only after this trade has finished.
  }
}
trades.sort((a, b) => a.signalTime.localeCompare(b.signalTime) || a.symbol.localeCompare(b.symbol))
const sum = values => values.reduce((total, n) => total + n, 0)
const summary = { tradeCount: trades.length, targetHits: trades.filter(x => x.exitReason === "target").length,
  winRatePct: trades.length ? round(100 * trades.filter(x => x.returnPct > 0).length / trades.length) : null,
  averageReturnPct: trades.length ? round(sum(trades.map(x => x.returnPct)) / trades.length) : null,
  totalReturnPct: round(sum(trades.map(x => x.returnPct))),
  maximumAdverseExcursionPct: trades.length ? round(Math.max(...trades.map(x => x.adverseMovePct))) : null,
  worstDay: trades.length ? { date, totalReturnPct: round(sum(trades.map(x => x.returnPct))) } : null }
const report = { date, universeCount: symbols.length, unavailable,
  rules: { previousCandles: 10, maxEma9RangePct: .75, maxEma45RangePct: .30,
    maxVwapRangePct: .15, minimumDownwardIndicators: 2,
    confirmation: "close < EMA9 < EMA45 < VWAP; close < open and previous close; previous candle not fully stacked",
    entry: "next completed one-minute candle close", targetPct: 1.25, stopPct: .6,
    exit: "first target, stop, or session-end close; stop first when target and stop share a candle",
    depth: "diagnostic only; no depth gate", recurrence: "another signal may enter only after the prior trade for that stock exits" }, summary, trades }
const output = path.join(root, "reports", `${date}-loose-compression-breakdown-1p25-target-nonoverlap.json`)
if (fs.existsSync(output)) throw new Error(`Report exists: ${output}`)
fs.writeFileSync(output, JSON.stringify(report, null, 2) + "\n")
console.log(JSON.stringify({ output, ...summary, unavailableCount: unavailable.length,
  firstTargetTrades: trades.filter(x => x.exitReason === "target").slice(0, 20),
  referenceTrades: trades.filter(x => ["ICICIPRULI", "HINDPETRO", "SRF", "IDEA", "KEI", "IIFL"].includes(x.symbol)) }, null, 2))
