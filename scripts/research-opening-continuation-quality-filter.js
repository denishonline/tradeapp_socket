#!/usr/bin/env node
import fs from "node:fs"
import path from "node:path"

const ROOT = process.cwd()
const IST = 330 * 60_000
const REPORT = process.argv[2] ?? path.join(ROOT, "reports", "2026-11-03-opening-ema20-bos-backtest-10.json")
const TARGETS = new Set(["MARICO", "MOTILALOFS", "360ONE", "ANGELONE", "SOLARINDS", "CAMS", "CDSL", "BRITANNIA", "TATACONSUM"])
const round = (value, digits = 4) => Number.isFinite(value) ? +value.toFixed(digits) : null
const mean = values => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : NaN
const median = values => { const sorted = values.filter(Number.isFinite).sort((a, b) => a - b); return sorted.length ? sorted[Math.floor(sorted.length / 2)] : NaN }
const pct = (end, start) => start ? 100 * (end / start - 1) : NaN
const stamp = epoch => new Date(epoch * 1000 + IST).toISOString().slice(0, 16).replace("T", " ")
const dateOf = epoch => stamp(epoch).slice(0, 10)
const minuteOf = epoch => { const time = stamp(epoch).slice(11); return +time.slice(0, 2) * 60 + +time.slice(3) }
const emaSeries = (rows, period) => { let value = null; const alpha = 2 / (period + 1); return rows.map(row => value = value == null ? row.close : alpha * row.close + (1 - alpha) * value) }
const rsi = (rows, period = 14) => {
  if (rows.length <= period) return NaN
  const changes = rows.slice(-period - 1).slice(1).map((row, index) => row.close - rows.slice(-period - 1)[index].close)
  const gains = mean(changes.map(value => Math.max(0, value))), losses = mean(changes.map(value => Math.max(0, -value)))
  return losses === 0 ? 100 : 100 - 100 / (1 + gains / losses)
}
const rangeEfficiency = rows => {
  if (rows.length < 2) return NaN
  const path = rows.slice(1).reduce((sum, row, index) => sum + Math.abs(row.close - rows[index].close), 0)
  return path ? Math.abs(rows.at(-1).close - rows[0].open) / path : 0
}
const aggregate = (rows, size) => {
  const result = []
  for (let start = 0; start + size <= rows.length; start += size) {
    const block = rows.slice(start, start + size)
    result.push({ open: block[0].open, high: Math.max(...block.map(row => row.high)), low: Math.min(...block.map(row => row.low)), close: block.at(-1).close, volume: block.reduce((sum, row) => sum + row.volume, 0) })
  }
  return result
}
const cache = new Map()
function load(symbol) {
  if (cache.has(symbol)) return cache.get(symbol)
  const rows = fs.readFileSync(path.join(ROOT, "db", "candles", `${symbol}.jsonl`), "utf8").trim().split(/\r?\n/).filter(Boolean).map(JSON.parse).sort((a, b) => a.time - b.time).map(row => ({ ...row, date: dateOf(row.time), minute: minuteOf(row.time) }))
  cache.set(symbol, rows)
  return rows
}
function features(signal) {
  const all = load(signal.symbol), signalEpoch = Date.parse(`${signal.signalTime.replace(" ", "T")}:00+05:30`) / 1000
  const index = all.findIndex(row => row.time === signalEpoch)
  if (index < 0) throw new Error(`Missing candle ${signal.symbol} ${signal.signalTime}`)
  const history = all.slice(0, index + 1), today = history.filter(row => row.date === signal.date && row.minute >= 555)
  const priorDates = [...new Set(all.slice(0, index + 1).map(row => row.date).filter(date => date < signal.date))].sort().slice(-10)
  const priorSessions = priorDates.map(date => all.filter(row => row.date === date && row.minute >= 555 && row.minute <= today.at(-1).minute))
  const previousSession = all.filter(row => row.date === priorDates.at(-1))
  const current = today.at(-1), previous = today.at(-2), first = today[0], last3 = today.slice(-3), last5 = today.slice(-5)
  const ema5 = emaSeries(history, 5), ema10 = emaSeries(history, 10), ema20 = emaSeries(history, 20), ema40 = emaSeries(history, 40)
  const sessionVwap = today.reduce((sum, row) => sum + ((row.high + row.low + row.close) / 3) * row.volume, 0) / today.reduce((sum, row) => sum + row.volume, 0)
  const priorCumVolumes = priorSessions.map(rows => rows.reduce((sum, row) => sum + row.volume, 0))
  const sameMinuteVolumes = priorSessions.map(rows => rows.at(-1)?.volume).filter(Number.isFinite)
  const trueRanges = history.slice(-15).map((row, i, subset) => i ? Math.max(row.high - row.low, Math.abs(row.high - subset[i - 1].close), Math.abs(row.low - subset[i - 1].close)) : row.high - row.low)
  const result = {
    angle20: signal.angleDeg,
    minimumGap: signal.minimumGapPct,
    historyAverage: signal.historyAveragePct,
    volumeAcceleration920: signal.volumeAcceleration,
    relativeStrength920: signal.relativeStrengthPct,
    signalMinute: current.minute,
    overnightGap: previousSession.length ? pct(first.open, previousSession.at(-1).close) : NaN,
    sessionReturn: pct(current.close, first.open),
    return1: previous ? pct(current.close, previous.close) : NaN,
    return3: last3.length > 1 ? pct(current.close, last3[0].open) : NaN,
    return5: last5.length > 1 ? pct(current.close, last5[0].open) : NaN,
    rangePct: pct(current.high, current.low),
    bodyPct: pct(current.close, current.open),
    closeLocation: current.high === current.low ? .5 : (current.close - current.low) / (current.high - current.low),
    sessionCloseLocation: Math.max(...today.map(row => row.high)) === Math.min(...today.map(row => row.low)) ? .5 : (current.close - Math.min(...today.map(row => row.low))) / (Math.max(...today.map(row => row.high)) - Math.min(...today.map(row => row.low))),
    greenShare: today.filter(row => row.close > row.open).length / today.length,
    higherCloseShare: today.slice(1).filter((row, i) => row.close > today[i].close).length / Math.max(1, today.length - 1),
    efficiency: rangeEfficiency(today),
    efficiency5: rangeEfficiency(last5),
    vwapGap: pct(current.close, sessionVwap),
    ema5Gap: pct(current.close, ema5.at(-1)),
    ema10Gap: pct(current.close, ema10.at(-1)),
    ema20Gap: pct(current.close, ema20.at(-1)),
    ema10Over20: pct(ema10.at(-1), ema20.at(-1)),
    ema20Over40: pct(ema20.at(-1), ema40.at(-1)),
    ema20Slope3: ema20.length > 3 ? pct(ema20.at(-1), ema20.at(-4)) / 3 : NaN,
    rsi14: rsi(history),
    atr14Pct: pct(current.close + mean(trueRanges), current.close),
    signalVolumeVsPrior10SameMinute: current.volume / median(sameMinuteVolumes),
    cumulativeVolumeVsPrior10: today.reduce((sum, row) => sum + row.volume, 0) / median(priorCumVolumes),
    volumeLast3Share: last3.reduce((sum, row) => sum + row.volume, 0) / today.reduce((sum, row) => sum + row.volume, 0),
    volumeUpDownRatio: mean(today.filter(row => row.close >= row.open).map(row => row.volume)) / mean(today.filter(row => row.close < row.open).map(row => row.volume)),
    breakoutPct: pct(current.close, Math.max(...today.slice(0, -1).slice(-5).map(row => row.high))),
  }
  for (const size of [3, 5]) {
    const bars = aggregate(today, size), bar = bars.at(-1)
    result[`tf${size}Return`] = bar ? pct(bar.close, bar.open) : NaN
    result[`tf${size}CloseLocation`] = bar && bar.high !== bar.low ? (bar.close - bar.low) / (bar.high - bar.low) : NaN
    result[`tf${size}Efficiency`] = bars.length ? rangeEfficiency(bars) : NaN
  }
  return Object.fromEntries(Object.entries(result).map(([key, value]) => [key, round(value)]))
}

const input = JSON.parse(fs.readFileSync(REPORT, "utf8"))
const rows = input.signals.map(signal => ({ symbol: signal.symbol, signalTime: signal.signalTime, target: TARGETS.has(signal.symbol), returnPct: signal.returnPct, ...features(signal) }))
const featureNames = Object.keys(rows[0]).filter(key => !["symbol", "signalTime", "target", "returnPct"].includes(key))
const targetRows = rows.filter(row => row.target)
const conditions = []
for (const feature of featureNames) {
  const values = targetRows.map(row => row[feature]).filter(Number.isFinite)
  if (values.length !== targetRows.length) continue
  for (const [operator, threshold] of [[">=", Math.min(...values)], ["<=", Math.max(...values)]]) {
    conditions.push({ feature, operator, threshold, pass: row => Number.isFinite(row[feature]) && (operator === ">=" ? row[feature] >= threshold : row[feature] <= threshold) })
  }
}
let selected = [...rows], available = [...conditions], fittedRules = []
while (selected.some(row => !row.target)) {
  let best = null
  for (const condition of available) {
    const next = selected.filter(condition.pass)
    if (next.filter(row => row.target).length !== targetRows.length) continue
    const falsePositives = next.filter(row => !row.target).length
    if (!best || falsePositives < best.falsePositives) best = { condition, next, falsePositives }
  }
  if (!best || best.next.length === selected.length) break
  fittedRules.push({ feature: best.condition.feature, operator: best.condition.operator, threshold: round(best.condition.threshold), remaining: best.next.length, falsePositives: best.falsePositives })
  selected = best.next
  available = available.filter(condition => condition !== best.condition)
}
const output = {
  sourceReport: path.relative(ROOT, REPORT),
  date: input.from,
  warning: "Thresholds were chosen on 2026-11-03 to retain the nine user-selected stocks. All features are causal at signal time, but the selection process is in-sample and must be validated on other dates before live use.",
  requestedTargets: [...TARGETS],
  fittedRules,
  selected: selected.map(row => ({ symbol: row.symbol, signalTime: row.signalTime, target: row.target })),
  features: rows,
}
let number = 1, outputFile
do { outputFile = path.join(ROOT, "reports", `2026-11-03-opening-continuation-quality-fit${number === 1 ? "" : `-${number}`}.json`); number++ } while (fs.existsSync(outputFile))
fs.writeFileSync(outputFile, `${JSON.stringify(output, null, 2)}\n`, { flag: "wx" })
console.log(`Report: ${outputFile}`)
console.table(fittedRules)
console.table(rows.map(row => ({ Stock: row.symbol, Target: row.target, Selected: selected.includes(row), Signal: row.signalTime.slice(11, 16), Return: row.returnPct, Efficiency: row.efficiency, "3m efficiency": row.tf3Efficiency, "Up/down volume": row.volumeUpDownRatio, "VWAP gap": row.vwapGap })))
console.log(`Retained ${selected.filter(row => row.target).length}/${targetRows.length} targets and ${selected.filter(row => !row.target).length} controls.`)
