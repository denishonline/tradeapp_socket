import fs from "node:fs"
import path from "node:path"

const root = process.cwd(), date = process.argv[2] ?? "2026-10-21"
const requests = [
  ["ICICIPRULI", "11:30"], ["HINDPETRO", "11:30"], ["SRF", "11:10"],
  ["IDEA", "09:50"], ["KEI", "10:10"], ["IIFL", "09:45"],
]
const round = (value, places = 3) => Number(value.toFixed(places))
const stamp = epoch => new Date(epoch * 1000 + 330 * 60_000).toISOString().slice(0, 16).replace("T", " ")
const minute = text => Number(text.slice(0, 2)) * 60 + Number(text.slice(3))
const mean = values => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null
const pct = (a, b) => 100 * (a / b - 1)
const angle = (current, previous, bars) => Math.atan(((current / previous - 1) / bars) * 100) * 180 / Math.PI

function candles(symbol) {
  const file = path.join(root, "db", "candles", `${symbol}.jsonl`), rows = []
  if (!fs.existsSync(file)) return rows
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    if (!line.trim()) continue
    let raw
    try { raw = JSON.parse(line) } catch { continue }
    const time = stamp(Number(raw.time)), m = minute(time.slice(11))
    if (time.slice(0, 10) !== date || m < 555 || m > 929) continue
    if (![raw.open, raw.high, raw.low, raw.close, raw.volume].every(value => Number.isFinite(Number(value)))) continue
    rows.push({ time, minute: m, open: +raw.open, high: +raw.high, low: +raw.low, close: +raw.close, volume: +raw.volume })
  }
  rows.sort((a, b) => a.time.localeCompare(b.time))
  let ema9 = null, ema45 = null, pv = 0, volume = 0
  return rows.map(row => {
    ema9 = ema9 == null ? row.close : .2 * row.close + .8 * ema9
    ema45 = ema45 == null ? row.close : (2 / 46) * row.close + (44 / 46) * ema45
    volume += row.volume; pv += ((row.high + row.low + row.close) / 3) * row.volume
    return { ...row, ema9, ema45, vwap: pv / volume }
  })
}

function depthByMinute(symbol) {
  const file = path.join(root, "db", "cash-depth", date, symbol, `${symbol}.jsonl`), state = {}, groups = new Map()
  if (!fs.existsSync(file)) return new Map()
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    if (!line.trim()) continue
    let event
    try { event = JSON.parse(line) } catch { continue }
    const received = Date.parse(event.receivedAt)
    if (!Number.isFinite(received)) continue
    const time = stamp(received / 1000), m = minute(time.slice(11))
    if (time.slice(0, 10) !== date || m < 555 || m > 929) continue
    if (event.kind === "checkpoint") for (const key of Object.keys(state)) delete state[key]
    Object.assign(state, event.data ?? {})
    let bid = 0, ask = 0, valid = true
    for (let level = 1; level <= 5; level++) {
      const bp = +state[`bid_price${level}`], ap = +state[`ask_price${level}`], bs = +state[`bid_size${level}`], as = +state[`ask_size${level}`]
      if (![bp, ap, bs, as].every(Number.isFinite) || bp <= 0 || ap <= bp) { valid = false; break }
      bid += bs; ask += as
    }
    if (!valid) continue
    const values = groups.get(m) ?? []
    values.push({ bidShare: 100 * bid / (bid + ask || 1), midpoint: (+state.bid_price1 + +state.ask_price1) / 2 })
    groups.set(m, values)
  }
  return new Map([...groups].map(([m, values]) => [m, { bidShare: mean(values.map(value => value.bidShare)), midpoint: mean(values.map(value => value.midpoint)), snapshots: values.length }]))
}

function analyze(symbol, clock) {
  const targetMinute = minute(clock), rows = candles(symbol), index = rows.findIndex(row => row.minute === targetMinute), depth = depthByMinute(symbol)
  if (index < 5) return { symbol, time: clock, error: "Insufficient candle history" }
  const row = rows[index], prev = rows[index - 1], five = rows[index - 5], earlier = rows[index - 10] ?? rows[0]
  const previousGap45 = rows[index - 5].ema9 - rows[index - 5].ema45, currentGap45 = row.ema9 - row.ema45
  const previousGapVwap = rows[index - 5].ema9 - rows[index - 5].vwap, currentGapVwap = row.ema9 - row.vwap
  const depthNow = depth.get(targetMinute), depthWindow = Array.from({ length: 5 }, (_, offset) => depth.get(targetMinute - 4 + offset)).filter(Boolean)
  const ema9Angle = angle(row.ema9, five.ema9, 5), ema45Angle = angle(row.ema45, five.ema45, 5), vwapAngle = angle(row.vwap, five.vwap, 5)
  return {
    symbol, time: clock, candle: { open: round(row.open), high: round(row.high), low: round(row.low), close: round(row.close), volume: row.volume, oneMinuteChangePct: round(pct(row.close, prev.close), 3), fiveMinuteChangePct: round(pct(row.close, five.close), 3), tenMinuteChangePct: round(pct(row.close, earlier.close), 3), candleDirection: row.close > row.open ? "UP" : row.close < row.open ? "DOWN" : "FLAT" },
    indicators: { price: round(row.close), ema9: round(row.ema9), ema45: round(row.ema45), vwap: round(row.vwap), priceVsEma9Pct: round(pct(row.close, row.ema9), 3), priceVsEma45Pct: round(pct(row.close, row.ema45), 3), priceVsVwapPct: round(pct(row.close, row.vwap), 3), order: row.close < row.ema9 && row.ema9 < row.ema45 && row.ema45 < row.vwap ? "BEARISH_STACK" : row.close > row.ema9 && row.ema9 > row.ema45 && row.ema45 > row.vwap ? "BULLISH_STACK" : "MIXED" },
    momentum: { direction: pct(row.close, five.close) >= 0 ? "UP" : "DOWN", ema9AngleDeg: round(ema9Angle), ema45AngleDeg: round(ema45Angle), vwapAngleDeg: round(vwapAngle), ema9MinusEma45AngleDeg: round(ema9Angle - ema45Angle), ema9MinusVwapAngleDeg: round(ema9Angle - vwapAngle), trendAngleDivergence: ema9Angle - ema45Angle > 0 ? "EMA9 rising faster / falling slower" : "EMA9 falling faster / rising slower" },
    reversal: { ema9CrossedEma45InLast5Min: previousGap45 * currentGap45 < 0, ema9CrossedVwapInLast5Min: previousGapVwap * currentGapVwap < 0, fiveMinuteStateChange: previousGap45 >= 0 ? (currentGap45 < 0 ? "BUY_TO_SELL" : "NO_EMA45_CROSS") : (currentGap45 > 0 ? "SELL_TO_BUY" : "NO_EMA45_CROSS") },
    depth: depthNow ? { snapshotsAtTarget: depthNow.snapshots, bidSharePct: round(depthNow.bidShare), sellSharePct: round(100 - depthNow.bidShare), fiveMinuteMeanBidSharePct: round(mean(depthWindow.map(value => value.bidShare))), fiveMinuteMeanSellSharePct: round(mean(depthWindow.map(value => 100 - value.bidShare))), midpointAtTarget: round(depthNow.midpoint), fiveMinuteMidpointMovePct: depthWindow.length >= 2 ? round(pct(depthWindow.at(-1).midpoint, depthWindow[0].midpoint), 3) : null, fiveMinuteDepthMinutes: depthWindow.length } : { error: "No depth at target minute" }
  }
}

const results = requests.map(([symbol, time]) => analyze(symbol, time))
const report = { date, window: "Exact requested candle and five-minute lookback", definitions: { momentum: "close return over five minutes", trendAngle: "normalized five-minute slope converted to degrees", reversal: "EMA9 relationship to EMA45/VWAP changed sign within the prior five minutes", depth: "mean five-level bid/ask share; midpoint movement over the five-minute window" }, results }
const output = path.join(root, "reports", `${date}-requested-stocks-time-analysis.json`)
fs.writeFileSync(output, JSON.stringify(report, null, 2) + "\n")
console.log(JSON.stringify(report, null, 2))
