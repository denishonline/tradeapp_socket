import fs from "node:fs"
import path from "node:path"

const root = process.cwd()
const date = process.argv[2] || new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10)
const ledgerFile = path.join(root, "reports", `${date}-0920-to-1000-live-ema-gap-reversal-radar.json`)
const ledger = JSON.parse(fs.readFileSync(ledgerFile, "utf8"))
const symbolArgument = process.argv.find((value) => value.startsWith("--symbols="))?.slice("--symbols=".length)
const requestedSymbols = symbolArgument ? symbolArgument.split(",").map((value) => value.trim().toUpperCase().replace(/-EQ$/, "")).filter(Boolean) : []
const orderedReversals = [...(ledger.reversals || [])].sort((left, right) => String(left.signalTime).localeCompare(String(right.signalTime)))
const signals = requestedSymbols.length
  ? requestedSymbols.flatMap((symbol) => orderedReversals.find((row) => row.symbol === symbol) || [])
  : orderedReversals.filter((row) => Number(row.score) > 5)
const minuteMs = 60_000
const completedThrough = Math.floor(Date.now() / minuteMs) * minuteMs - minuteMs
const round = (value, digits = 4) => Number.isFinite(value) ? Number(value.toFixed(digits)) : null
const signalEpoch = (text) => Date.parse(`${text.replace(" ", "T")}:00+05:30`)
const indiaStamp = (seconds) => new Date(Number(seconds) * 1000 + 330 * minuteMs).toISOString().slice(0, 16).replace("T", " ")
const indiaDate = (seconds) => indiaStamp(seconds).slice(0, 10)

function ema(rows, period) {
  const alpha = 2 / (period + 1)
  let value = null
  return rows.map((row) => {
    value = value == null ? row.close : row.close * alpha + value * (1 - alpha)
    return value
  })
}

function analyze(signal) {
  const rows = fs.readFileSync(path.join(root, "db", "candles", `${signal.symbol}.jsonl`), "utf8")
    .split(/\r?\n/).flatMap((line) => {
      if (!line.trim()) return []
      try {
        const row = JSON.parse(line)
        if (indiaDate(row.time) !== date || Number(row.time) * 1000 > completedThrough) return []
        return [{ ...row, open: +row.open, high: +row.high, low: +row.low, close: +row.close }]
      } catch { return [] }
    }).sort((a, b) => Number(a.time) - Number(b.time))
  const entryIndex = rows.findIndex((row) => Number(row.time) * 1000 > signalEpoch(signal.signalTime))
  if (entryIndex < 0) return { ...signal, state: "WAITING", returnPct: null, maePct: null }
  const direction = signal.reverseDirection === "BUY" ? 1 : -1
  const entry = rows[entryIndex].close
  const stop = entry * (1 - direction * 0.005)
  const target = entry * (1 + direction * 0.02)
  const fast = ema(rows, 7), slow = ema(rows, 15)
  let exit = null, exitIndex = rows.length - 1
  for (let index = entryIndex + 1; index < rows.length; index++) {
    const row = rows[index]
    const stopHit = direction > 0 ? row.low <= stop : row.high >= stop
    const targetHit = direction > 0 ? row.high >= target : row.low <= target
    if (stopHit) { exit = { price: stop, reason: "SL", time: row.time }; exitIndex = index; break }
    if (targetHit) { exit = { price: target, reason: "TARGET", time: row.time }; exitIndex = index; break }
    const crossed = direction > 0
      ? fast[index - 1] >= slow[index - 1] && fast[index] < slow[index]
      : fast[index - 1] <= slow[index - 1] && fast[index] > slow[index]
    if (crossed) { exit = { price: row.close, reason: "EMA7/15", time: row.time }; exitIndex = index; break }
  }
  const mark = exit?.price ?? rows.at(-1)?.close ?? entry
  const held = rows.slice(entryIndex + 1, exitIndex + 1)
  const maePct = held.length ? Math.max(...held.map((row) => direction > 0
    ? 100 * Math.max(0, entry - row.low) / entry
    : 100 * Math.max(0, row.high - entry) / entry)) : 0
  return { symbol: signal.symbol, signalTime: signal.signalTime, entryTime: indiaStamp(rows[entryIndex].time),
    direction: signal.reverseDirection, score: signal.score, state: exit ? "CLOSED" : "ACTIVE",
    entry: round(entry), exitOrMark: round(mark), exitTime: exit ? indiaStamp(exit.time) : null,
    exitReason: exit?.reason || null, returnPct: round(direction * 100 * (mark - entry) / entry),
    maePct: round(maePct), stop: round(stop), target: round(target) }
}

const trades = signals.map(analyze)
const measured = trades.filter((row) => Number.isFinite(row.returnPct))
const closed = measured.filter((row) => row.state === "CLOSED")
const total = measured.reduce((sum, row) => sum + row.returnPct, 0)
const summary = { trades: measured.length, closed: closed.length, active: measured.length - closed.length,
  wins: measured.filter((row) => row.returnPct > 0).length,
  winRatePct: round(100 * measured.filter((row) => row.returnPct > 0).length / (measured.length || 1)),
  averageReturnPct: round(total / (measured.length || 1)), totalReturnPct: round(total),
  maximumAdverseExcursionPct: round(Math.max(0, ...measured.map((row) => row.maePct))),
  worstDay: measured.length ? { date, returnPct: round(total) } : null }
const cohort = requestedSymbols.length ? `Selected first signals: ${requestedSymbols.join(", ")}` : "Score >5 signals"
const output = { date, asOf: new Date().toISOString(), method: `${cohort}; next completed 1m candle entry; SL 0.5%; target 2%; completed opposite EMA7/EMA15 cross; active positions marked to latest completed candle; gross returns`, summary, trades }
let suffix = "", sequence = 1, outputFile
do {
  outputFile = path.join(root, "reports", `${date}-ema-gap-${requestedSymbols.length ? "selected" : "score-above5"}-ema7-ema15-live-analysis${suffix}.json`)
  suffix = `-${++sequence}`
} while (fs.existsSync(outputFile))
fs.writeFileSync(outputFile, JSON.stringify(output, null, 2) + "\n", { flag: "wx" })
console.log(JSON.stringify({ outputFile, summary, trades }, null, 2))
