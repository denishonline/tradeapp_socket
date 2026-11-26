import fs from "node:fs"
import path from "node:path"

const root = process.cwd(), date = process.argv[2] ?? "2026-10-21", symbol = (process.argv[3] ?? "ABB").toUpperCase().replace(/-EQ$/, "")
const dates = ["2026-10-13", "2026-10-14", "2026-10-15", "2026-10-16", "2026-10-19", date]
const startMinute = 9 * 60 + 15, endMinute = 9 * 60 + 30
const round = (value, places = 3) => Number(value.toFixed(places))
const stamp = epoch => new Date(epoch * 1000 + 330 * 60_000).toISOString().slice(0, 16).replace("T", " ")
const minute = text => Number(text.slice(0, 2)) * 60 + Number(text.slice(3))
const mean = values => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null
const pct = (a, b) => 100 * (a / b - 1)

function candles(day) {
  const file = path.join(root, "db", "candles", `${symbol}.jsonl`)
  const rows = []
  if (!fs.existsSync(file)) return rows
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    if (!line.trim()) continue
    let raw
    try { raw = JSON.parse(line) } catch { continue }
    const time = stamp(Number(raw.time)), m = minute(time.slice(11))
    if (time.slice(0, 10) !== day || m < startMinute || m > endMinute) continue
    if (![raw.open, raw.high, raw.low, raw.close, raw.volume].every(value => Number.isFinite(Number(value)))) continue
    rows.push({ time, minute: m, open: +raw.open, high: +raw.high, low: +raw.low, close: +raw.close, volume: +raw.volume })
  }
  return rows.sort((a, b) => a.time.localeCompare(b.time))
}

function depthByMinute(day) {
  const file = path.join(root, "db", "cash-depth", day, symbol, `${symbol}.jsonl`)
  if (!fs.existsSync(file)) return new Map()
  const state = {}, groups = new Map()
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    if (!line.trim()) continue
    let event
    try { event = JSON.parse(line) } catch { continue }
    const received = Date.parse(event.receivedAt)
    if (!Number.isFinite(received)) continue
    const time = stamp(received / 1000), m = minute(time.slice(11))
    if (time.slice(0, 10) !== day || m < startMinute || m > endMinute) continue
    if (event.kind === "checkpoint") for (const key of Object.keys(state)) delete state[key]
    Object.assign(state, event.data ?? {})
    let bid = 0, ask = 0, valid = true
    for (let level = 1; level <= 5; level++) {
      const bp = +state[`bid_price${level}`], ap = +state[`ask_price${level}`]
      const bs = +state[`bid_size${level}`], as = +state[`ask_size${level}`]
      if (![bp, ap, bs, as].every(Number.isFinite) || bp <= 0 || ap <= bp) { valid = false; break }
      bid += bs; ask += as
    }
    if (!valid) continue
    const values = groups.get(m) ?? []
    values.push({ bidShare: 100 * bid / (bid + ask || 1), midpoint: (+state.bid_price1 + +state.ask_price1) / 2 })
    groups.set(m, values)
  }
  return new Map([...groups].map(([m, values]) => [m, {
    snapshots: values.length,
    bidShare: mean(values.map(value => value.bidShare)),
    midpoint: mean(values.map(value => value.midpoint)),
  }]))
}

function summarize(day) {
  const rows = candles(day), depth = depthByMinute(day)
  if (!rows.length) return { date: day, candleCount: 0, depthMinutes: depth.size }
  let ema9 = rows[0].close, ema45 = rows[0].close, pv = 0, volume = 0
  for (const row of rows) {
    if (row !== rows[0]) { ema9 = .2 * row.close + .8 * ema9; ema45 = (2 / 46) * row.close + (44 / 46) * ema45 }
    volume += row.volume; pv += ((row.high + row.low + row.close) / 3) * row.volume
  }
  const first = rows[0], last = rows.at(-1), values = [...depth.values()]
  const bidShares = values.map(value => value.bidShare), mids = values.map(value => value.midpoint)
  const up = rows.filter(row => row.close > row.open).length, down = rows.filter(row => row.close < row.open).length
  return {
    date: day, candleCount: rows.length, firstCandle: first.time.slice(11), lastCandle: last.time.slice(11), open: round(first.open), close: round(last.close), high: round(Math.max(...rows.map(row => row.high))), low: round(Math.min(...rows.map(row => row.low))), returnPct: round(pct(last.close, first.open), 3), volume, vwap: round(pv / volume), ema9: round(ema9), ema45: round(ema45), upCandles: up, downCandles: down, flatCandles: rows.length - up - down, depthMinutes: depth.size, depthSnapshots: values.reduce((sum, value) => sum + value.snapshots, 0), meanBidShare: round(mean(bidShares), 3), bidDominantMinutesPct: round(100 * bidShares.filter(value => value >= 50).length / (bidShares.length || 1), 3), midpointStart: round(mids[0]), midpointEnd: round(mids.at(-1)), midpointMovePct: round(pct(mids.at(-1), mids[0]), 3), priceVsEma9Pct: round(pct(last.close, ema9), 3), priceVsEma45Pct: round(pct(last.close, ema45), 3), priceVsVwapPct: round(pct(last.close, pv / volume), 3), candleRows: rows, depthRows: [...depth.entries()].map(([m, value]) => ({ time: `${day} ${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`, ...value }))
  }
}

const summaries = dates.map(summarize), prior = summaries.slice(0, -1), today = summaries.at(-1)
const numericKeys = ["returnPct", "volume", "vwap", "ema9", "ema45", "meanBidShare", "bidDominantMinutesPct", "midpointMovePct", "priceVsEma9Pct", "priceVsEma45Pct", "priceVsVwapPct"]
const priorMean = Object.fromEntries(numericKeys.map(key => [key, mean(prior.filter(row => Number.isFinite(row[key])).map(row => row[key]))]))
const report = { symbol, date, window: "09:15–09:30 IST inclusive", sessions: summaries.map(row => ({ ...row, candleRows: undefined, depthRows: undefined })), priorFiveMean: Object.fromEntries(Object.entries(priorMean).map(([key, value]) => [key, round(value, 3)])), todayVsPriorMean: Object.fromEntries(numericKeys.map(key => [key, Number.isFinite(today[key]) && Number.isFinite(priorMean[key]) ? round(today[key] - priorMean[key], 3) : null])) }
const output = path.join(root, "reports", `${date}-${symbol.toLowerCase()}-five-session-0930-analysis.json`)
fs.writeFileSync(output, JSON.stringify(report, null, 2) + "\n")
console.log(JSON.stringify(report, null, 2))
