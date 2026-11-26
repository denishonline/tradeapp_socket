import apiV3 from "fyers-api-v3"
import { CONSTANT } from "../constant.js"
import { getFromStorage } from "../utils.js"

const DATE = "2026-11-16"
const IST_OFFSET_MS = 330 * 60_000
const anchors = new Map([
  ["HEROMOTOCO", "10:00"],
  ["POLICYBZR", "09:30"],
  ["SIEMENS", "09:55"],
])

const clock = epoch => new Date(epoch * 1000 + IST_OFFSET_MS).toISOString().slice(11, 16)
const nextMinute = value => {
  const [hour, minute] = value.split(":").map(Number)
  const total = hour * 60 + minute + 1
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`
}
const pct = (later, earlier) => 100 * (later / earlier - 1)
const round = value => Number(value.toFixed(4))

const token = String(getFromStorage("token") || "").trim()
if (!token) throw new Error("FYERS token unavailable. Run AutoLogin first.")
const client = new apiV3.fyersModel({ enableLogging: false })
client.setAppId(CONSTANT.appId)
client.setAccessToken(token)

const results = []
for (const [symbol, anchor] of anchors) {
  const response = await client.getHistory({ symbol: `NSE:${symbol}-EQ`, resolution: "1", date_format: "1", range_from: DATE, range_to: DATE, cont_flag: "1" })
  if (response?.s !== "ok" || !Array.isArray(response.candles)) throw new Error(`${symbol}: ${response?.message || "FYERS history unavailable"}`)
  const rows = response.candles.map(row => ({ time: clock(row[0]), open: +row[1], high: +row[2], low: +row[3], close: +row[4], volume: +row[5] }))
  const anchorIndex = rows.findIndex(row => row.time === anchor)
  const search = rows.slice(anchorIndex, anchorIndex + 16)
  let match = null
  for (let index = 1; index < search.length; index++) {
    const first = search[index - 1], second = search[index]
    const secondCloseLocation = (second.close - second.low) / (second.high - second.low || 1)
    if (first.close < first.open && second.close < second.open && second.close < first.low && secondCloseLocation <= 0.2) {
      match = { first, second, secondCloseLocation }
      break
    }
  }
  if (!match) { results.push({ symbol, anchor, signal: null }); continue }
  const signalAt = nextMinute(match.second.time)
  const entryAt = nextMinute(signalAt)
  const entryCandle = rows.find(row => row.time === signalAt)
  const entryIndex = rows.indexOf(entryCandle)
  const forward = rows.slice(entryIndex + 1, entryIndex + 16)
  const entryPrice = entryCandle?.close
  const exitPrice = forward.at(-1)?.close
  results.push({
    symbol, anchor, side: "SELL",
    confirmationCandles: `${match.first.time}-${match.second.time}`,
    signalAt, entryAt, entryPrice,
    secondCloseLocationPct: round(100 * match.secondCloseLocation),
    secondVsFirstVolumePct: round(pct(match.second.volume, match.first.volume)),
    return15Pct: Number.isFinite(exitPrice) ? round(100 * (entryPrice - exitPrice) / entryPrice) : null,
    mae15Pct: forward.length ? round(Math.min(0, 100 * (entryPrice - Math.max(...forward.map(row => row.high))) / entryPrice)) : null,
  })
}

const trades = results.filter(row => row.signalAt && Number.isFinite(row.return15Pct))
const returns = trades.map(row => row.return15Pct)
const summary = {
  tradeCount: trades.length,
  winRatePct: round(100 * trades.filter(row => row.return15Pct > 0).length / (trades.length || 1)),
  averageReturnPct: round(returns.reduce((sum, value) => sum + value, 0) / (returns.length || 1)),
  totalReturnPct: round(returns.reduce((sum, value) => sum + value, 0)),
  maximumAdverseExcursionPct: trades.length ? Math.min(...trades.map(row => row.mae15Pct)) : null,
  worstDay: { date: DATE, totalReturnPct: round(returns.reduce((sum, value) => sum + value, 0)) },
}

console.log(JSON.stringify({
  date: DATE, timeframe: "one minute", timezone: "Asia/Kolkata",
  anchors: "User-observed FYERS 5-minute SELL internal-order-block box times",
  rule: "First two consecutive red candles within 15 minutes after the box time; second close below first low and in bottom 20% of its range.",
  entry: "Close of the next completed one-minute candle after signal; entryAt is when that close is known.",
  outcome: "SELL return over the following 15 completed one-minute candles.",
  summary, results,
}, null, 2))
