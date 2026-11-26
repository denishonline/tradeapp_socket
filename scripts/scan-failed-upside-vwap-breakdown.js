import fs from "node:fs"
import path from "node:path"

const root = process.cwd(), date = process.argv[2] ?? "2026-10-21"
const round = (value, places = 2) => Number(value.toFixed(places))
const stamp = epoch => new Date(epoch * 1000 + 330 * 60_000).toISOString().slice(0, 16).replace("T", " ")
const minute = text => Number(text.slice(0, 2)) * 60 + Number(text.slice(3))
const pct = (a, b) => 100 * (a / b - 1)
const mean = values => values.reduce((sum, value) => sum + value, 0) / values.length
const clock = totalMinutes => `${String(Math.floor(totalMinutes / 60)).padStart(2, "0")}:${String(totalMinutes % 60).padStart(2, "0")}`
const REVERSAL_LOOKAHEAD_MINUTES = 30
const stocks = [...new Set(JSON.parse(fs.readFileSync(path.join(root, "db", "stocks"), "utf8")).map(value => String(value).trim().toUpperCase().replace(/-EQ$/, "")))]

function candles(symbol) {
  const file = path.join(root, "db", "candles", `${symbol}.jsonl`)
  if (!fs.existsSync(file)) return []
  const rows = new Map()
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    if (!line.trim()) continue
    let raw
    try { raw = JSON.parse(line) } catch { continue }
    const time = stamp(Number(raw.time))
    if (time.slice(0, 10) !== date || time.slice(11) < "09:15" || time.slice(11) > "15:29") continue
    if (![raw.open, raw.high, raw.low, raw.close, raw.volume].every(value => Number.isFinite(Number(value)))) continue
    rows.set(time, { time, minute: minute(time.slice(11)), open: Number(raw.open), high: Number(raw.high), low: Number(raw.low), close: Number(raw.close), volume: Number(raw.volume) })
  }
  const output = [...rows.values()].sort((a, b) => a.time.localeCompare(b.time))
  let ema9 = null, ema45 = null, priceVolume = 0, volume = 0
  return output.map(row => {
    ema9 = ema9 == null ? row.close : .2 * row.close + .8 * ema9
    ema45 = ema45 == null ? row.close : (2 / 46) * row.close + (44 / 46) * ema45
    volume += row.volume
    priceVolume += ((row.high + row.low + row.close) / 3) * row.volume
    return { ...row, ema9, ema45, vwap: priceVolume / volume }
  })
}

function depthByMinute(symbol) {
  const file = path.join(root, "db", "cash-depth", date, symbol, `${symbol}.jsonl`)
  if (!fs.existsSync(file)) return new Map()
  const state = {}, groups = new Map()
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    if (!line.trim()) continue
    let event
    try { event = JSON.parse(line) } catch { continue }
    const time = stamp(Date.parse(event.receivedAt) / 1000), currentMinute = minute(time.slice(11))
    if (time.slice(0, 10) !== date || currentMinute < 555 || currentMinute > 929) continue
    if (event.kind === "checkpoint") for (const key of Object.keys(state)) delete state[key]
    Object.assign(state, event.data ?? {})
    let bid = 0, ask = 0, valid = true
    for (let level = 1; level <= 5; level++) {
      const bp = Number(state[`bid_price${level}`]), ap = Number(state[`ask_price${level}`])
      const bs = Number(state[`bid_size${level}`]), as = Number(state[`ask_size${level}`])
      if (![bp, ap, bs, as].every(Number.isFinite) || bp <= 0 || ap <= bp) { valid = false; break }
      bid += bs; ask += as
    }
    if (!valid) continue
    const values = groups.get(currentMinute) ?? []
    values.push({ bidShare: 100 * bid / (bid + ask || 1), mid: (Number(state.bid_price1) + Number(state.ask_price1)) / 2 })
    groups.set(currentMinute, values)
  }
  return new Map([...groups].map(([currentMinute, values]) => [currentMinute, {
    bidShare: mean(values.map(value => value.bidShare)),
    firstMid: values[0].mid,
    lastMid: values.at(-1).mid,
  }]))
}

function scan(symbol) {
  const rows = candles(symbol)
  if (rows.length < 8) return null
  const depth = depthByMinute(symbol)
  for (let pushIndex = 5; pushIndex < rows.length - 1; pushIndex++) {
    const push = rows[pushIndex]
    const prior = rows.slice(pushIndex - 5, pushIndex)
    const volumeMultiple = push.volume / Math.max(mean(prior.map(row => row.volume)), 1)
    const pushDepth = depth.get(push.minute), previousPushDepth = depth.get(prior.at(-1).minute)
    if (!(push.close > push.open && push.close > prior.at(-1).close && push.high >= Math.max(...prior.map(row => row.high)) && volumeMultiple >= 2 && push.close > push.ema9 && push.close > push.vwap && pushDepth && previousPushDepth && pushDepth.bidShare >= 50 && pct(pushDepth.lastMid, previousPushDepth.lastMid) > 0)) continue
    for (let signalIndex = pushIndex + 1; signalIndex < Math.min(rows.length, pushIndex + REVERSAL_LOOKAHEAD_MINUTES + 1); signalIndex++) {
      const signal = rows[signalIndex]
      const ema9ToEma45GapPct = pct(signal.ema45, signal.ema9)
      const ema45ToVwapGapPct = pct(signal.vwap, signal.ema45)
      if (!(signal.close < signal.ema9 && signal.ema9 < signal.ema45 && signal.ema45 < signal.vwap && ema9ToEma45GapPct >= 0.2 && ema45ToVwapGapPct >= 0.2 && signal.close < push.close)) continue
      const previousDepth = depth.get(rows[signalIndex - 1].minute), signalDepth = depth.get(signal.minute)
      if (!previousDepth || !signalDepth) continue
      const askShare = 100 - signalDepth.bidShare
      const midpointMove = pct(signalDepth.lastMid, previousDepth.lastMid)
      if (askShare < 55 || midpointMove >= 0 || pct(signal.close, push.close) > -.15) continue
      return {
        symbol,
        pushTime: push.time,
        pushHigh: round(push.high),
        pushClose: round(push.close),
        pushVolumeMultiple: round(volumeMultiple),
        signalTime: signal.time,
        entryTime: `${date} ${clock(signal.minute + 1)}`,
        signalClose: round(signal.close),
        ema9: round(signal.ema9),
        ema45: round(signal.ema45),
        vwap: round(signal.vwap),
        ema9ToEma45GapPct: round(ema9ToEma45GapPct, 3),
        ema45ToVwapGapPct: round(ema45ToVwapGapPct, 3),
        askSharePct: round(askShare),
        depthMidpointMovePct: round(midpointMove, 3),
        moveFromPushPct: round(pct(signal.close, push.close), 3),
      }
    }
  }
  return null
}

const matches = stocks.map(scan).filter(Boolean).sort((a, b) => a.signalTime.localeCompare(b.signalTime) || b.pushVolumeMultiple - a.pushVolumeMultiple)
const report = { date, universeCount: stocks.length, matchCount: matches.length, rule: `ABB-like pattern: bullish-context green local five-minute high with volume >=2x prior five, rising midpoint and at least 50% bid share; within ${REVERSAL_LOOKAHEAD_MINUTES} minutes, first candle closes at least 0.15% below push close and satisfies close < EMA9 < EMA45 < VWAP, with each EMA/VWAP gap >=0.2%, ask share >=55% and falling midpoint.`, matches }
const output = path.join(root, "reports", `${date}-failed-upside-vwap-breakdown-stacked-gaps-02-30min.json`)
fs.writeFileSync(output, JSON.stringify(report, null, 2) + "\n")
console.log(JSON.stringify(report, null, 2))
