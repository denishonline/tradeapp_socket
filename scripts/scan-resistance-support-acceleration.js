#!/usr/bin/env node
import fs from "node:fs"
import path from "node:path"

const ROOT = process.cwd()
const IST_OFFSET_MS = 330 * 60_000
function cliValue(flag, fallback) {
  const index = process.argv.indexOf(flag)
  return index >= 0 ? process.argv[index + 1] : fallback
}

function minuteValue(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback
  if (/^\d+$/.test(String(value))) return Number(value)
  const match = String(value).match(/^(\d{1,2}):(\d{2})$/)
  if (!match) return fallback
  return Number(match[1]) * 60 + Number(match[2])
}

const positionalDate = process.argv.find((value, index) => index > 0 && /^\d{4}-\d{2}-\d{2}$/.test(value))
const targetDate = cliValue("--day", positionalDate || "2026-10-28")
const endMinute = minuteValue(cliValue("--cutoff", process.argv[3] || "10:30"), 630)
const looseMode = process.argv.includes("--loose")
const finalMode = process.argv.includes("--final")
const minMove = Number(cliValue("--min-move", "2"))
const requireMove = process.argv.includes("--require-move")
const minHistoryCount = finalMode ? Number(cliValue("--history-count", "5")) : 0
const tolerance = looseMode ? 0.005 : 0.002
const accelerationThreshold = looseMode ? 0.3 : 0.5
const dateOf = (seconds) => new Date(seconds * 1000 + IST_OFFSET_MS).toISOString().slice(0, 10)
const minuteOf = (seconds) => { const d = new Date(seconds * 1000 + IST_OFFSET_MS); return d.getUTCHours() * 60 + d.getUTCMinutes() }
const timeOf = (seconds) => { const d = new Date(seconds * 1000 + IST_OFFSET_MS); return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}` }
const round = (value, digits = 3) => Number.isFinite(value) ? Number(value.toFixed(digits)) : null

function readCandles(symbol) {
  const file = path.join(ROOT, "db", "candles", `${symbol}.jsonl`)
  if (!fs.existsSync(file)) return []
  return fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean).flatMap((line) => {
    try {
      const row = JSON.parse(line)
      const candle = { time: Number(row.time), open: Number(row.open), high: Number(row.high), low: Number(row.low), close: Number(row.close), volume: Number(row.volume) }
      return [candle].every((item) => [item.time, item.open, item.high, item.low, item.close, item.volume].every(Number.isFinite)) ? [candle] : []
    } catch { return [] }
  }).sort((a, b) => a.time - b.time)
}

function historyScore(all, byDate) {
  const dates = [...new Set(all.map((row) => dateOf(row.time)))].filter((date) => date <= targetDate).sort().slice(-31)
  const metrics = []
  for (let index = 1; index < dates.length; index += 1) {
    const day = byDate.get(dates[index]) || []
    const previous = byDate.get(dates[index - 1]) || []
    const opening = day.filter((row) => minuteOf(row.time) >= 555 && minuteOf(row.time) <= 565)
    const first5 = day.filter((row) => minuteOf(row.time) >= 555 && minuteOf(row.time) <= 559)
    const at925 = day.find((row) => minuteOf(row.time) === 565)
    if (!opening.length || !first5.length || !at925 || !previous.length) continue
    const previousHigh = Math.max(...previous.map((row) => row.high))
    metrics.push({
      move: (at925.close / opening[0].open - 1) * 100,
      range: (Math.max(...opening.map((row) => row.high)) / Math.min(...opening.map((row) => row.low)) - 1) * 100,
      volume5: first5.reduce((sum, row) => sum + row.volume, 0),
      volume925: at925.volume,
      green: opening.filter((row) => row.close > row.open).length / opening.length * 100,
      reclaim: (at925.close / previousHigh - 1) * 100,
    })
  }
  const target = metrics.at(-1)
  const prior = metrics.slice(0, -1)
  if (!target || prior.length < 5) return null
  const fields = ["move", "range", "volume5", "volume925", "green", "reclaim"]
  const percentile = Object.fromEntries(fields.map((field) => {
    const values = prior.map((row) => row[field])
    return [field, 100 * values.filter((value) => value <= target[field]).length / values.length]
  }))
  return { highCount: fields.filter((field) => percentile[field] >= 80).length, percentile }
}

function evaluate(symbol) {
  const all = readCandles(symbol)
  const byDate = new Map()
  for (const row of all) {
    const date = dateOf(row.time)
    if (!byDate.has(date)) byDate.set(date, [])
    byDate.get(date).push(row)
  }
  const history = historyScore(all, byDate)
  if (history && history.highCount < minHistoryCount) return null
  const dates = [...new Set(all.map((row) => dateOf(row.time)))].sort()
  const targetIndex = dates.indexOf(targetDate)
  if (targetIndex < 1) return null
  const previousDate = dates[targetIndex - 1]
  const previous = byDate.get(previousDate) || []
  const current = (byDate.get(targetDate) || []).filter((row) => minuteOf(row.time) <= endMinute)
  if (previous.length < 10 || current.length < 5) return null
  const resistance = Math.max(...previous.map((row) => row.high))
  const breakoutIndex = current.findIndex((row, index) => row.close > resistance && (index === 0 || current[index - 1].close <= resistance))
  if (breakoutIndex < 0) return null

  let retestIndex = -1
  let accelerationIndex = -1
  for (let candidate = breakoutIndex + 1; candidate < current.length; candidate += 1) {
    const retest = current[candidate]
    if (!(retest.low <= resistance * (1 + tolerance) && retest.close >= resistance * (1 - tolerance))) continue
    const candidateAcceleration = current.findIndex((row, index) => {
      if (index <= candidate || index < 3) return false
      const priorHigh = Math.max(...current.slice(index - 3, index).map((item) => item.high))
      const threeMinuteMove = retest.close !== 0 ? (row.close / retest.close - 1) * 100 : 0
      return row.close > priorHigh && threeMinuteMove >= accelerationThreshold && current[index - 1].close >= current[index - 2].close
    })
    if (candidateAcceleration < 0) continue
    const held = current.slice(candidate).every((row) => row.close >= resistance * (1 - tolerance))
    if (!held) continue
    retestIndex = candidate
    accelerationIndex = candidateAcceleration
    break
  }
  if (retestIndex < 0 || accelerationIndex < 0) return null

  const acceleration = current[accelerationIndex]
  const last = current.at(-1)
  const returnFromSupport = (last.close / current[retestIndex].close - 1) * 100
  const targetHitIndex = current.findIndex((row, index) => index > retestIndex && row.close >= current[retestIndex].close * (1 + minMove / 100))
  if (requireMove && targetHitIndex < 0) return null
  return {
    STOCK: symbol,
    RESISTANCE: round(resistance),
    BREAKOUT: timeOf(current[breakoutIndex].time),
    SUPPORT_RETEST: timeOf(current[retestIndex].time),
    SUPPORT_CLOSE: round(current[retestIndex].close),
    ACCELERATION: timeOf(acceleration.time),
    ACCEL_CLOSE: round(acceleration.close),
    "RETURN FROM SUPPORT %": round(returnFromSupport),
    "RETURN FROM ACCEL %": round((last.close / acceleration.close - 1) * 100),
    [`TARGET ${minMove}% HIT AT`]: targetHitIndex >= 0 ? timeOf(current[targetHitIndex].time) : "",
    [`TARGET ${minMove}% HIT`]: targetHitIndex >= 0,
    "30D HIGH COUNT": history?.highCount ?? null,
    "30D MOVE PCTL": round(history?.percentile.move, 1),
    "30D RANGE PCTL": round(history?.percentile.range, 1),
    "30D VOL PCTL": round(history?.percentile.volume5, 1),
    "30D RECLAIM PCTL": round(history?.percentile.reclaim, 1),
  }
}

const stocksFile = path.join(ROOT, "db", "stocks")
const symbols = fs.existsSync(stocksFile) && fs.readFileSync(stocksFile, "utf8").trim()
  ? JSON.parse(fs.readFileSync(stocksFile, "utf8")).map((symbol) => String(symbol).trim().toUpperCase()).filter(Boolean)
  : []
const rows = symbols.map(evaluate).filter(Boolean).sort((a, b) => b["RETURN FROM SUPPORT %"] - a["RETURN FROM SUPPORT %"])
const cutoffLabel = `${String(Math.floor(endMinute / 60)).padStart(2, "0")}:${String(endMinute % 60).padStart(2, "0")}`
const modeSuffix = `${looseMode ? "-loose" : ""}${finalMode ? `-final-h${minHistoryCount}` : ""}`
const output = path.join(ROOT, "reports", `${targetDate}-${cutoffLabel.replace(":", "")}-resistance-support-acceleration${modeSuffix}.json`)
fs.writeFileSync(output, `${JSON.stringify({ targetDate, through: `${cutoffLabel} IST`, mode: finalMode ? "final" : (looseMode ? "loose" : "strict"), minMove, requireMove, minHistoryCount, method: `Signal is emitted chronologically at the acceleration candle. Previous session high is used as resistance; require a close above it, a later low retest within ${tolerance * 100}% that closes back within the support band, then a close above the prior three-candle high with at least ${accelerationThreshold}% move from retest close and a higher preceding close. The ${minMove}% move is recorded as a later outcome${requireMove ? " and required" : " but is not required for signal emission"}. Historical confirmation requires ${minHistoryCount} of 6 opening metrics at or above the stock's 80th percentile over its prior 30 available sessions.`, rows }, null, 2)}\n`)
console.table(rows)
console.log(`Stocks: ${rows.map((row) => `NSE:${row.STOCK}-EQ`).join(",") || "None"}`)
console.log(`Matched ${rows.length} stocks; saved ${output}`)
