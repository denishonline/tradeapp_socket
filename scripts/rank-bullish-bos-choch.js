#!/usr/bin/env node
import fs from "node:fs"
import path from "node:path"

const ROOT = process.cwd()
const IST_OFFSET_MS = 330 * 60_000
const targetDate = process.argv[2] || "2026-10-28"
const endMinute = Number(process.argv[3] || 559)
const left = 2
const right = 2
const startMinute = 555

const dateOf = (seconds) => new Date(seconds * 1000 + IST_OFFSET_MS).toISOString().slice(0, 10)
const minuteOf = (seconds) => {
  const date = new Date(seconds * 1000 + IST_OFFSET_MS)
  return date.getUTCHours() * 60 + date.getUTCMinutes()
}
const timeOf = (seconds) => {
  const minute = minuteOf(seconds)
  return `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`
}

function readCandles(symbol) {
  const file = path.join(ROOT, "db", "candles", `${symbol}.jsonl`)
  if (!fs.existsSync(file)) return []
  return fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean).flatMap((line) => {
    try {
      const row = JSON.parse(line)
      const candle = {
        ...row,
        time: Number(row.time),
        open: Number(row.open),
        high: Number(row.high),
        low: Number(row.low),
        close: Number(row.close),
      }
      return [candle].every((item) => [item.time, item.open, item.high, item.low, item.close].every(Number.isFinite)) ? [candle] : []
    } catch {
      return []
    }
  }).sort((a, b) => a.time - b.time)
}

function evaluate(symbol) {
  const all = readCandles(symbol)
  if (!all.length) return null
  const dates = [...new Set(all.map((row) => dateOf(row.time)))].sort()
  const targetIndex = dates.indexOf(targetDate)
  if (targetIndex < 1) return null
  const previousDate = dates[targetIndex - 1]
  const previousRows = all.filter((row) => dateOf(row.time) === previousDate)
  const targetRows = all.filter((row) => dateOf(row.time) === targetDate && minuteOf(row.time) <= endMinute)
  const rows = [...previousRows, ...targetRows]
  const eventStartIndex = Math.max(0, previousRows.length - 55)
  if (rows.length < 8) return null

  const pivotsHigh = new Map()
  const pivotsLow = new Map()
  for (let index = left; index < rows.length - right; index += 1) {
    const high = rows[index].high
    const low = rows[index].low
    const isHigh = rows.slice(index - left, index + right + 1).every((row, offset) => offset === left || high > row.high)
    const isLow = rows.slice(index - left, index + right + 1).every((row, offset) => offset === left || low < row.low)
    if (isHigh) pivotsHigh.set(index, high)
    if (isLow) pivotsLow.set(index, low)
  }

  let bias = "neutral"
  let latestHigh = null
  let latestLow = null
  let brokenHigh = null
  let brokenLow = null
  const events = []
  for (let index = 0; index < rows.length; index += 1) {
    // A pivot at index-right is confirmed only once the current candle is reached.
    const confirmedIndex = index - right
    if (pivotsHigh.has(confirmedIndex)) latestHigh = { index: confirmedIndex, price: pivotsHigh.get(confirmedIndex) }
    if (pivotsLow.has(confirmedIndex)) latestLow = { index: confirmedIndex, price: pivotsLow.get(confirmedIndex) }
    const row = rows[index]
    const inLookbackWindow = index >= eventStartIndex && (dateOf(row.time) === previousDate || dateOf(row.time) === targetDate)
    if (!inLookbackWindow) continue

    if (latestHigh && latestHigh.index !== brokenHigh && row.close > latestHigh.price && (index === 0 || rows[index - 1].close <= latestHigh.price)) {
      const type = bias === "bearish" ? "CHOCH" : "BOS"
      events.push({ time: timeOf(row.time), type, level: latestHigh.price, close: row.close })
      brokenHigh = latestHigh.index
      bias = "bullish"
    }
    if (latestLow && latestLow.index !== brokenLow && row.close < latestLow.price && (index === 0 || rows[index - 1].close >= latestLow.price)) {
      brokenLow = latestLow.index
      bias = "bearish"
    }
  }

  const bos = events.filter((event) => event.type === "BOS").length
  const choch = events.filter((event) => event.type === "CHOCH").length
  if (!events.length) return null
  return { STOCK: symbol, BOS: bos, CHOCH: choch, TOTAL: bos + choch, EVENTS: events.map((event) => `${event.time} ${event.type}`).join(", ") }
}

const stocksFile = path.join(ROOT, "db", "stocks")
const symbols = fs.existsSync(stocksFile) && fs.readFileSync(stocksFile, "utf8").trim()
  ? JSON.parse(fs.readFileSync(stocksFile, "utf8")).map((symbol) => String(symbol).trim().toUpperCase()).filter(Boolean)
  : []
const rows = symbols.map(evaluate).filter(Boolean).sort((a, b) => b.TOTAL - a.TOTAL || b.CHOCH - a.CHOCH || b.BOS - a.BOS || a.STOCK.localeCompare(b.STOCK))
const output = path.join(ROOT, "reports", `${targetDate}-0920-bullish-bos-choch-ranking.json`)
fs.writeFileSync(output, `${JSON.stringify({ targetDate, eventWindow: "previous session final 55 candles + target session first 5 candles", context: "Additional candles before the 60-candle window are used only to confirm pivots and establish bias.", method: "2-left/2-right confirmed pivots; close crossing a confirmed swing high is an upward structure break; after bearish bias it is CHOCH, otherwise BOS. Downward breaks only update bias.", rows: rows.slice(0, 10) }, null, 2)}\n`)
console.table(rows.slice(0, 10))
console.log(`Stocks with bullish BOS/CHOCH: ${rows.length}; saved ${output}`)
