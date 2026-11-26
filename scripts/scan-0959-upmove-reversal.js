import fs from "node:fs"
import path from "node:path"

const root = process.cwd(), date = process.argv[2] ?? "2026-10-21", targetMinute = 9 * 60 + 59
const round = (value, places = 3) => Number(value.toFixed(places))
const stamp = epoch => new Date(epoch * 1000 + 330 * 60_000).toISOString().slice(0, 16).replace("T", " ")
const minute = text => Number(text.slice(0, 2)) * 60 + Number(text.slice(3))
const mean = values => values.reduce((sum, value) => sum + value, 0) / values.length
const pct = (a, b) => 100 * (a / b - 1)
const symbols = [...new Set(JSON.parse(fs.readFileSync(path.join(root, "db", "stocks"), "utf8")).map(value => String(value).trim().toUpperCase().replace(/-EQ$/, "")))]

function candles(symbol) {
  const file = path.join(root, "db", "candles", `${symbol}.jsonl`), rows = new Map()
  if (!fs.existsSync(file)) return rows
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

function depth(symbol) {
  const file = path.join(root, "db", "cash-depth", date, symbol, `${symbol}.jsonl`), state = {}, groups = new Map()
  if (!fs.existsSync(file)) return groups
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
      const bp = +state[`bid_price${level}`], ap = +state[`ask_price${level}`], bs = +state[`bid_size${level}`], as = +state[`ask_size${level}`]
      if (![bp, ap, bs, as].every(Number.isFinite) || bp <= 0 || ap <= bp) { valid = false; break }
      bid += bs; ask += as
    }
    if (!valid) continue
    const values = groups.get(m) ?? []
    values.push({ askShare: 100 * ask / (bid + ask || 1), midpoint: (+state.bid_price1 + +state.ask_price1) / 2 })
    groups.set(m, values)
  }
  return new Map([...groups].map(([m, values]) => [m, { askShare: mean(values.map(value => value.askShare)), midpoint: mean(values.map(value => value.midpoint)), snapshots: values.length }]))
}

function scan(symbol) {
  const rows = candles(symbol), before = rows.get(targetMinute - 2), up = rows.get(targetMinute - 1), down = rows.get(targetMinute)
  if (!before || !up || !down || !(up.close > up.open && up.close > before.close && down.close < down.open && down.close < up.close)) return null
  const baseline = [targetMinute - 6, targetMinute - 5, targetMinute - 4, targetMinute - 3, targetMinute - 2].map(m => rows.get(m)).filter(Boolean)
  if (baseline.length < 5) return null
  const d = depth(symbol), priorDepth = d.get(targetMinute - 1), currentDepth = d.get(targetMinute)
  if (!priorDepth || !currentDepth) return null
  const volumeMultiple = down.volume / Math.max(mean(baseline.map(row => row.volume)), 1), askIncrease = currentDepth.askShare - priorDepth.askShare
  if (!(volumeMultiple > 1 && askIncrease > 0)) return null
  return { symbol, upCandle: up.time, reversalCandle: down.time, upMovePct: round(pct(up.close, before.close), 3), reversalMovePct: round(pct(down.close, up.close), 3), volume: down.volume, volumeMultiple: round(volumeMultiple, 3), sellShare0958Pct: round(priorDepth.askShare, 3), sellShare0959Pct: round(currentDepth.askShare, 3), sellShareIncreasePctPoints: round(askIncrease, 3), midpointChangePct: round(pct(currentDepth.midpoint, priorDepth.midpoint), 3), depthSnapshots0959: currentDepth.snapshots }
}

const matches = symbols.map(scan).filter(Boolean).sort((a, b) => b.sellShareIncreasePctPoints - a.sellShareIncreasePctPoints || b.volumeMultiple - a.volumeMultiple)
const report = { date, time: "09:59", universeCount: symbols.length, rule: "09:58 green candle closing above 09:57 close, followed by a bearish 09:59 candle closing below 09:58; 09:59 volume above prior five-minute average and sell-side depth share increased.", matchCount: matches.length, matches }
const output = path.join(root, "reports", `${date}-0959-upmove-reversal.json`)
fs.writeFileSync(output, JSON.stringify(report, null, 2) + "\n")
console.log(JSON.stringify(report, null, 2))
