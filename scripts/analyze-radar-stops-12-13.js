import fs from "node:fs"
import path from "node:path"

const ROOT = process.cwd()
const MINUTE = 60_000
const DATES = ["2026-10-12", "2026-10-13"]
const SIGNAL_ROOT = path.join(ROOT, "db", "strategy-signals")
const DEPTH_ROOT = path.join(ROOT, "db", "cash-depth")
const CANDLE_ROOT = path.join(ROOT, "db", "candles")
const round = (value, digits = 3) => Number.isFinite(value) ? Number(value.toFixed(digits)) : null
const indiaDate = (at) => new Date(at + 330 * MINUTE).toISOString().slice(0, 10)
const indiaTime = (at) => new Date(at + 330 * MINUTE).toISOString().slice(11, 19)
const pct = (value, base) => base > 0 ? (value / base - 1) * 100 : 0
const mean = (values) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0

function readJson(filename) {
  return fs.existsSync(filename) ? JSON.parse(fs.readFileSync(filename, "utf8")) : []
}
function jsonLines(filename) {
  if (!fs.existsSync(filename)) return []
  return fs.readFileSync(filename, "utf8").split(/\r?\n/).flatMap((line) => {
    if (!line.trim()) return []
    try { return [JSON.parse(line)] } catch { return [] }
  })
}
function atr14At(symbol, signalAt) {
  const rows = jsonLines(path.join(CANDLE_ROOT, `${symbol}.jsonl`))
    .filter((row) => Number(row.time) * 1000 + MINUTE <= signalAt && indiaDate(Number(row.time) * 1000) === indiaDate(signalAt))
    .sort((a, b) => Number(a.time) - Number(b.time))
  if (rows.length < 15) return null
  const trailing = rows.slice(-15), ranges = []
  for (let index = 1; index < trailing.length; index++) {
    const current = trailing[index], previousClose = Number(trailing[index - 1].close)
    ranges.push(Math.max(Number(current.high) - Number(current.low),
      Math.abs(Number(current.high) - previousClose), Math.abs(Number(current.low) - previousClose)))
  }
  return 100 * mean(ranges) / Number(trailing.at(-1).close)
}
function pricePath(signal) {
  const date = indiaDate(Date.parse(signal.time))
  const filename = path.join(DEPTH_ROOT, date, signal.symbol, `${signal.symbol}.jsonl`)
  const entryAt = Date.parse(signal.time)
  const values = jsonLines(filename).flatMap((row) => {
    const at = Date.parse(row.receivedAt), price = Number(row.marketContext?.price)
    return Number.isFinite(at) && at > entryAt && Number.isFinite(price) && price > 0 ? [{ at, price }] : []
  }).sort((a, b) => a.at - b.at)
  const deduped = []
  for (const row of values) if (!deduped.length || row.at !== deduped.at(-1).at || row.price !== deduped.at(-1).price) deduped.push(row)
  return deduped
}
function sideReturn(signal, price) {
  const sign = signal.direction === "SELL" ? -1 : 1
  return sign * pct(price, Number(signal.price))
}
function firstAt(pathRows, predicate) {
  return pathRows.find((row) => predicate(row))?.at ?? null
}
function fixedOutcome(signal, pathRows, stopPct) {
  const targetPct = Math.abs(pct(Number(signal.target), Number(signal.price)))
  for (const row of pathRows) {
    const value = sideReturn(signal, row.price)
    if (value <= -stopPct) return { outcome: "STOP", exitPct: -stopPct, at: row.at }
    if (value >= targetPct) return { outcome: "TARGET", exitPct: targetPct, at: row.at }
  }
  return { outcome: "EOD", exitPct: pathRows.length ? sideReturn(signal, pathRows.at(-1).price) : 0,
    at: pathRows.at(-1)?.at ?? null }
}
function trailingOutcome(signal, pathRows, { initialStopPct, activationPct, trailPct }) {
  let peak = 0
  for (const row of pathRows) {
    const value = sideReturn(signal, row.price)
    peak = Math.max(peak, value)
    if (value <= -initialStopPct) return { outcome: "INITIAL_STOP", exitPct: value, peakPct: peak, at: row.at }
    if (peak >= activationPct && value <= peak - trailPct) {
      return { outcome: "TRAIL", exitPct: value, peakPct: peak, at: row.at }
    }
  }
  return { outcome: "EOD", exitPct: pathRows.length ? sideReturn(signal, pathRows.at(-1).price) : 0,
    peakPct: peak, at: pathRows.at(-1)?.at ?? null }
}
function csvValue(value) {
  const text = value === null || value === undefined ? "" : String(value)
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
}
function writeCsv(filename, records) {
  const columns = [...new Set(records.flatMap((row) => Object.keys(row)))]
  fs.writeFileSync(filename, `${columns.join(",")}\n${records.map((row) =>
    columns.map((column) => csvValue(row[column])).join(",")).join("\n")}\n`)
}

const signals = []
for (const directory of fs.readdirSync(SIGNAL_ROOT, { withFileTypes: true }).filter((entry) => entry.isDirectory())) {
  for (const date of DATES) {
    const filename = path.join(SIGNAL_ROOT, directory.name, `${date}.json`)
    for (const signal of readJson(filename)) signals.push({ ...signal, store: directory.name, date })
  }
}
signals.sort((a, b) => Date.parse(a.time) - Date.parse(b.time))

const rows = signals.map((signal) => {
  const pathRows = pricePath(signal)
  const returns = pathRows.map((row) => sideReturn(signal, row.price))
  const mfePct = returns.length ? Math.max(...returns) : 0
  const maePct = returns.length ? Math.min(...returns) : 0
  const targetPct = Math.abs(pct(Number(signal.target), Number(signal.price)))
  const currentStopPct = Math.abs(pct(Number(signal.stop), Number(signal.price)))
  const stopAt = firstAt(pathRows, (row) => sideReturn(signal, row.price) <= -currentStopPct)
  const targetAt = firstAt(pathRows, (row) => sideReturn(signal, row.price) >= targetPct)
  const atr14Pct = atr14At(signal.symbol, Date.parse(signal.time))
  const volatilityStopPct = Math.max(0.5, Math.min(1.2, 1.6 * (atr14Pct || 0.35)))
  const volatilityTrailPct = Math.max(0.35, Math.min(0.8, 0.9 * (atr14Pct || 0.35)))
  const fixed06 = fixedOutcome(signal, pathRows, 0.6)
  const fixed08 = fixedOutcome(signal, pathRows, 0.8)
  const volatilityFixed = fixedOutcome(signal, pathRows, volatilityStopPct)
  const trailing = trailingOutcome(signal, pathRows, {
    initialStopPct: volatilityStopPct, activationPct: Math.max(0.5, 1.2 * (atr14Pct || 0.35)),
    trailPct: volatilityTrailPct,
  })
  return {
    date: signal.date, strategy: signal.strategy, branch: signal.metrics?.filterBranch || "",
    symbol: signal.symbol, side: signal.direction, signalIst: indiaTime(Date.parse(signal.time)),
    entry: signal.price, savedStatus: signal.status, targetPct: round(targetPct), currentStopPct: round(currentStopPct),
    atr14Pct: round(atr14Pct), mfePct: round(mfePct), maePct: round(maePct),
    targetEventually: Boolean(targetAt), targetBeforeStop: Boolean(targetAt && (!stopAt || targetAt < stopAt)),
    stopAtIst: stopAt ? indiaTime(stopAt) : "", targetAtIst: targetAt ? indiaTime(targetAt) : "",
    fixed06Outcome: fixed06.outcome, fixed06ExitPct: round(fixed06.exitPct),
    fixed08Outcome: fixed08.outcome, fixed08ExitPct: round(fixed08.exitPct),
    volatilityStopPct: round(volatilityStopPct), volatilityFixedOutcome: volatilityFixed.outcome,
    volatilityFixedExitPct: round(volatilityFixed.exitPct), trailActivationPct: round(Math.max(0.5, 1.2 * (atr14Pct || 0.35))),
    trailDistancePct: round(volatilityTrailPct), trailOutcome: trailing.outcome,
    trailExitPct: round(trailing.exitPct), trailPeakPct: round(trailing.peakPct),
    eodReturnPct: round(returns.at(-1) ?? 0), metrics: JSON.stringify(signal.metrics || {}),
  }
})

const output = path.join(ROOT, "csv", "2026-10-12-to-13-strategy-radar-stop-path-audit.csv")
writeCsv(output, rows)
const totals = rows.reduce((result, row) => {
  result[row.savedStatus] = (result[row.savedStatus] || 0) + 1
  return result
}, {})
const byStrategy = Object.values(rows.reduce((result, row) => {
  const item = result[row.strategy] || { strategy: row.strategy, signals: 0, stopped: 0, targets: 0,
    active: 0, eventualTargets: 0, fixed06Targets: 0, fixed08Targets: 0,
    volatilityTargets: 0, trailPositive: 0, trailReturnSum: 0 }
  item.signals++
  if (row.savedStatus === "Stopped") item.stopped++
  else if (row.savedStatus === "Target reached") item.targets++
  else item.active++
  if (row.targetEventually) item.eventualTargets++
  if (row.fixed06Outcome === "TARGET") item.fixed06Targets++
  if (row.fixed08Outcome === "TARGET") item.fixed08Targets++
  if (row.volatilityFixedOutcome === "TARGET") item.volatilityTargets++
  if (row.trailExitPct > 0) item.trailPositive++
  item.trailReturnSum += row.trailExitPct
  result[row.strategy] = item
  return result
}, {})).map((row) => ({ ...row, trailReturnSum: round(row.trailReturnSum) }))
console.log(JSON.stringify({ output, signals: rows.length, totals, byStrategy, stopped: rows.filter((row) => row.savedStatus === "Stopped") }, null, 2))
