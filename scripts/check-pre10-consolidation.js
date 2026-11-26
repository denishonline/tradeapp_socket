import fs from "node:fs"
import path from "node:path"

const root = process.cwd(), date = process.argv[2] ?? "2026-10-21"
const requests = [["ICICIPRULI", "11:30"], ["HINDPETRO", "11:30"], ["SRF", "11:10"], ["IDEA", "09:50"], ["KEI", "10:10"], ["IIFL", "09:45"]]
const stamp = epoch => new Date(epoch * 1000 + 330 * 60_000).toISOString().slice(0, 16).replace("T", " ")
const minute = text => Number(text.slice(0, 2)) * 60 + Number(text.slice(3))
const round = (value, places = 3) => Number(value.toFixed(places))
const pct = (a, b) => 100 * (a / b - 1)
function rows(symbol) {
  const file = path.join(root, "db", "candles", `${symbol}.jsonl`), out = []
  if (!fs.existsSync(file)) return out
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    if (!line.trim()) continue
    let raw; try { raw = JSON.parse(line) } catch { continue }
    const time = stamp(+raw.time), m = minute(time.slice(11))
    if (time.slice(0, 10) !== date || m < 555 || m > 929 || ![raw.open, raw.high, raw.low, raw.close, raw.volume].every(Number.isFinite, Number)) continue
    out.push({ time, minute: m, open: +raw.open, high: +raw.high, low: +raw.low, close: +raw.close, volume: +raw.volume })
  }
  out.sort((a, b) => a.time.localeCompare(b.time))
  let e9, e45, pv = 0, volume = 0
  return out.map(row => { e9 = e9 == null ? row.close : .2 * row.close + .8 * e9; e45 = e45 == null ? row.close : (2 / 46) * row.close + (44 / 46) * e45; volume += row.volume; pv += ((row.high + row.low + row.close) / 3) * row.volume; return { ...row, ema9: e9, ema45: e45, vwap: pv / volume } })
}
const rangePct = (values, base) => pct(Math.max(...values), Math.min(...values))
const results = requests.map(([symbol, clock]) => {
  const all = rows(symbol), target = minute(clock), index = all.findIndex(row => row.minute === target), pre = all.slice(Math.max(0, index - 10), index), current = all[index]
  if (!current || pre.length < 10) return { symbol, time: clock, error: "Insufficient candles" }
  const priceBase = pre[0].close, e9Base = pre[0].ema9, e45Base = pre[0].ema45, vwapBase = pre[0].vwap
  return { symbol, time: clock, preWindow: `${pre[0].time.slice(11)}–${pre.at(-1).time.slice(11)}`, pre10RangePct: { price: round(rangePct(pre.map(row => row.close), priceBase), 3), ema9: round(rangePct(pre.map(row => row.ema9), e9Base), 3), ema45: round(rangePct(pre.map(row => row.ema45), e45Base), 3), vwap: round(rangePct(pre.map(row => row.vwap), vwapBase), 3) }, pre10NetMovePct: { price: round(pct(pre.at(-1).close, pre[0].close), 3), ema9: round(pct(pre.at(-1).ema9, pre[0].ema9), 3), ema45: round(pct(pre.at(-1).ema45, pre[0].ema45), 3), vwap: round(pct(pre.at(-1).vwap, pre[0].vwap), 3) }, breakCandleMovePct: round(pct(current.close, pre.at(-1).close), 3), consolidationEvidence: "Pre-window ranges are measured before the target candle; lower ranges followed by a larger break move indicate compression then expansion." }
})
const report = { date, results }
const output = path.join(root, "reports", `${date}-requested-stocks-pre10-consolidation.json`)
fs.writeFileSync(output, JSON.stringify(report, null, 2) + "\n")
console.log(JSON.stringify(report, null, 2))
