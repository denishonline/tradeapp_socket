import fs from "node:fs"
import path from "node:path"

const root = process.cwd(), date = process.argv[2] ?? "2026-10-21"
const input = path.join(root, "reports", `${date}-0920-to-1000-live-ema-gap-reversal-radar-min-gap-0_75.json`)
const round = (value, places = 3) => Number(value.toFixed(places))
const stamp = epoch => new Date(epoch * 1000 + 330 * 60_000).toISOString().slice(0, 16).replace("T", " ")
const minute = text => Number(text.slice(0, 2)) * 60 + Number(text.slice(3))
const mean = values => values.reduce((sum, value) => sum + value, 0) / values.length
const clock = value => `${String(Math.floor(value / 60)).padStart(2, "0")}:${String(value % 60).padStart(2, "0")}`

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
    const time = stamp(received / 1000), currentMinute = minute(time.slice(11))
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
    values.push(100 * bid / (bid + ask || 1))
    groups.set(currentMinute, values)
  }
  return new Map([...groups].map(([key, values]) => [key, mean(values)]))
}

const source = JSON.parse(fs.readFileSync(input, "utf8"))
const matches = source.reversals.map(signal => {
  const signalMinute = minute(signal.signalTime.slice(11)), depth = depthByMinute(signal.symbol)
  const minutes = Array.from({ length: 5 }, (_, index) => signalMinute - 4 + index)
  const values = minutes.map(value => depth.get(value)).filter(Number.isFinite)
  const directionalValues = values.map(value => signal.reverseDirection === "BUY" ? value : 100 - value)
  return { ...signal, depthWindowStart: `${date} ${clock(signalMinute - 4)}`, depthWindowEnd: signal.signalTime, depthMinutesAvailable: values.length, fiveMinuteDirectionalSharePct: values.length === 5 ? round(mean(directionalValues), 3) : null }
}).filter(signal => signal.depthMinutesAvailable === 5 && signal.fiveMinuteDirectionalSharePct >= 50)

const report = { date, source, rule: "Five-minute window ending at signal candle; each minute uses the mean five-level depth bid share. BUY uses bid share and SELL uses ask share; require all five minute buckets and average directional share >=50%.", matchCount: matches.length, matches }
const output = path.join(root, "reports", `${date}-ema-gap-reversal-min-gap-0_75-five-minute-depth.json`)
fs.writeFileSync(output, JSON.stringify(report, null, 2) + "\n")
console.log(JSON.stringify(report, null, 2))
