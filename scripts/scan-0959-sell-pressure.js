import fs from "node:fs"
import path from "node:path"

const root = process.cwd(), date = process.argv[2] ?? "2026-10-21", targetMinute = 9 * 60 + 59
const round = (value, places = 3) => Number(value.toFixed(places))
const stamp = epoch => new Date(epoch * 1000 + 330 * 60_000).toISOString().slice(0, 16).replace("T", " ")
const minute = time => Number(time.slice(0, 2)) * 60 + Number(time.slice(3))
const mean = values => values.reduce((sum, value) => sum + value, 0) / values.length
const pct = (a, b) => 100 * (a / b - 1)
const symbols = [...new Set(JSON.parse(fs.readFileSync(path.join(root, "db", "stocks"), "utf8")).map(value => String(value).trim().toUpperCase().replace(/-EQ$/, "")))]

function candleRows(symbol) {
  const file = path.join(root, "db", "candles", `${symbol}.jsonl`)
  if (!fs.existsSync(file)) return new Map()
  const rows = new Map()
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    if (!line.trim()) continue
    let raw
    try { raw = JSON.parse(line) } catch { continue }
    const time = stamp(Number(raw.time)), m = minute(time.slice(11))
    if (time.slice(0, 10) !== date || m < targetMinute - 6 || m > targetMinute) continue
    if (![raw.open, raw.high, raw.low, raw.close, raw.volume].every(value => Number.isFinite(Number(value)))) continue
    rows.set(m, { time, open: +raw.open, high: +raw.high, low: +raw.low, close: +raw.close, volume: +raw.volume })
  }
  return rows
}

function depthByMinute(symbol) {
  const file = path.join(root, "db", "cash-depth", date, symbol, `${symbol}.jsonl`)
  if (!fs.existsSync(file)) return new Map()
  const state = {}, groups = new Map()
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    if (!line.trim()) continue
    let event
    try { event = JSON.parse(line) } catch { continue }
    const received = Date.parse(event.receivedAt)
    if (!Number.isFinite(received)) continue
    const time = stamp(received / 1000), m = minute(time.slice(11))
    if (time.slice(0, 10) !== date || m < targetMinute - 1 || m > targetMinute) continue
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
    values.push({ askShare: 100 * ask / (bid + ask || 1), midpoint: (bp1(state) + ap1(state)) / 2 })
    groups.set(m, values)
  }
  return new Map([...groups].map(([m, values]) => [m, { askShare: mean(values.map(value => value.askShare)), midpoint: mean(values.map(value => value.midpoint)), snapshots: values.length }]))
}
const bp1 = state => +state.bid_price1
const ap1 = state => +state.ask_price1

function scan(symbol) {
  const candles = candleRows(symbol), prev = candles.get(targetMinute - 1), target = candles.get(targetMinute)
  if (!prev || !target) return null
  const baseline = [targetMinute - 6, targetMinute - 5, targetMinute - 4, targetMinute - 3, targetMinute - 2].map(m => candles.get(m)).filter(Boolean)
  if (baseline.length < 5) return null
  const depth = depthByMinute(symbol), beforeDepth = depth.get(targetMinute - 1), targetDepth = depth.get(targetMinute)
  if (!beforeDepth || !targetDepth) return null
  const volumeMultiple = target.volume / Math.max(mean(baseline.map(row => row.volume)), 1)
  const sellShareIncrease = targetDepth.askShare - beforeDepth.askShare
  if (!(target.close < target.open && target.close < prev.close && volumeMultiple > 1 && sellShareIncrease > 0)) return null
  return { symbol, candleTime: target.time, open: round(target.open), close: round(target.close), changePct: round(pct(target.close, prev.close), 3), volume: target.volume, volumeMultiple: round(volumeMultiple, 3), sellShare0958Pct: round(beforeDepth.askShare, 3), sellShare0959Pct: round(targetDepth.askShare, 3), sellShareIncreasePctPoints: round(sellShareIncrease, 3), midpointChangePct: round(pct(targetDepth.midpoint, beforeDepth.midpoint), 3), depthSnapshots0959: targetDepth.snapshots }
}

const matches = symbols.map(scan).filter(Boolean).sort((a, b) => b.sellShareIncreasePctPoints - a.sellShareIncreasePctPoints || b.volumeMultiple - a.volumeMultiple)
const report = { date, time: "09:59", universeCount: symbols.length, rule: "09:59 close < open and prior close; volume > prior five-minute average; five-level depth sell-side share (ask share) increased from 09:58 to 09:59.", matchCount: matches.length, matches }
const output = path.join(root, "reports", `${date}-0959-sell-pressure.json`)
fs.writeFileSync(output, JSON.stringify(report, null, 2) + "\n")
console.log(JSON.stringify(report, null, 2))
