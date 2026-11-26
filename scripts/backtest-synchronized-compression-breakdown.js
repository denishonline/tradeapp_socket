import fs from "node:fs"
import path from "node:path"

const root = process.cwd(), date = process.argv[2] ?? "2026-10-21", sessionStart = 555, sessionEnd = 929
const round = (value, places = 3) => Number(value.toFixed(places))
const stamp = epoch => new Date(epoch * 1000 + 330 * 60_000).toISOString().slice(0, 16).replace("T", " ")
const minute = text => Number(text.slice(0, 2)) * 60 + Number(text.slice(3))
const mean = values => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null
const pct = (a, b) => 100 * (a / b - 1)
const clock = value => `${String(Math.floor(value / 60)).padStart(2, "0")}:${String(value % 60).padStart(2, "0")}`
const symbols = [...new Set(JSON.parse(fs.readFileSync(path.join(root, "db", "stocks"), "utf8")).map(value => String(value).trim().toUpperCase().replace(/-EQ$/, "")))]

function candles(symbol) {
  const file = path.join(root, "db", "candles", `${symbol}.jsonl`), output = []
  if (!fs.existsSync(file)) return output
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    if (!line.trim()) continue
    let raw; try { raw = JSON.parse(line) } catch { continue }
    const time = stamp(+raw.time), m = minute(time.slice(11))
    if (time.slice(0, 10) !== date || m < sessionStart || m > sessionEnd || ![raw.open, raw.high, raw.low, raw.close, raw.volume].every(value => Number.isFinite(Number(value)))) continue
    output.push({ time, minute: m, open: +raw.open, high: +raw.high, low: +raw.low, close: +raw.close, volume: +raw.volume })
  }
  output.sort((a, b) => a.time.localeCompare(b.time))
  let e9, e45, pv = 0, volume = 0
  return output.map(row => { e9 = e9 == null ? row.close : .2 * row.close + .8 * e9; e45 = e45 == null ? row.close : (2 / 46) * row.close + (44 / 46) * e45; volume += row.volume; pv += ((row.high + row.low + row.close) / 3) * row.volume; return { ...row, ema9: e9, ema45: e45, vwap: pv / volume } })
}

function depth(symbol) {
  const file = path.join(root, "db", "cash-depth", date, symbol, `${symbol}.jsonl`), state = {}, groups = new Map()
  if (!fs.existsSync(file)) return groups
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    if (!line.trim()) continue
    let event; try { event = JSON.parse(line) } catch { continue }
    const received = Date.parse(event.receivedAt); if (!Number.isFinite(received)) continue
    const time = stamp(received / 1000), m = minute(time.slice(11)); if (time.slice(0, 10) !== date || m < sessionStart || m > sessionEnd) continue
    if (event.kind === "checkpoint") for (const key of Object.keys(state)) delete state[key]
    Object.assign(state, event.data ?? {})
    let bid = 0, ask = 0, valid = true
    for (let level = 1; level <= 5; level++) { const bp = +state[`bid_price${level}`], ap = +state[`ask_price${level}`], bs = +state[`bid_size${level}`], as = +state[`ask_size${level}`]; if (![bp, ap, bs, as].every(Number.isFinite) || bp <= 0 || ap <= bp) { valid = false; break }; bid += bs; ask += as }
    if (!valid) continue
    const values = groups.get(m) ?? []; values.push({ bidShare: 100 * bid / (bid + ask || 1), midpoint: (+state.bid_price1 + +state.ask_price1) / 2 }); groups.set(m, values)
  }
  return new Map([...groups].map(([m, values]) => [m, { bidShare: mean(values.map(value => value.bidShare)), midpoint: mean(values.map(value => value.midpoint)), snapshots: values.length }]))
}

function rangePct(values) { return pct(Math.max(...values), Math.min(...values)) }
function scan(symbol) {
  const rows = candles(symbol), d = depth(symbol), matches = []
  for (let i = 10; i < rows.length; i++) {
    const row = rows[i], previous = rows[i - 1], pre = rows.slice(i - 10, i)
    const compressed = rangePct(pre.map(x => x.ema9)) <= .6 && rangePct(pre.map(x => x.ema45)) <= .25 && rangePct(pre.map(x => x.vwap)) <= .1
    const slopingDown = pre.at(-1).ema9 < pre[0].ema9 && pre.at(-1).ema45 < pre[0].ema45 && pre.at(-1).vwap < pre[0].vwap
    const stack = row.close < row.ema9 && row.ema9 < row.ema45 && row.ema45 < row.vwap
    const previousStack = previous.close < previous.ema9 && previous.ema9 < previous.ema45 && previous.ema45 < previous.vwap
    const bearish = row.close < row.open && row.close < previous.close
    if (!(compressed && slopingDown && stack && !previousStack && bearish)) continue
    const depthWindow = Array.from({ length: 5 }, (_, offset) => d.get(row.minute - 4 + offset)).filter(Boolean)
    const volumeBase = mean(pre.slice(-5).map(x => x.volume)), depthAtSignal = d.get(row.minute)
    matches.push({ symbol, signalTime: row.time, entryTime: `${date} ${clock(row.minute + 1)}`, price: round(row.close), ema9: round(row.ema9), ema45: round(row.ema45), vwap: round(row.vwap), fiveMinuteMomentumPct: round(pct(row.close, pre.at(-5).close), 3), volumeMultiple: round(row.volume / Math.max(volumeBase, 1), 3), pre10PriceRangePct: round(rangePct(pre.map(x => x.close)), 3), pre10Ema9RangePct: round(rangePct(pre.map(x => x.ema9)), 3), pre10Ema45RangePct: round(rangePct(pre.map(x => x.ema45)), 3), pre10VwapRangePct: round(rangePct(pre.map(x => x.vwap)), 3), fiveMinuteSellSharePct: depthWindow.length === 5 ? round(mean(depthWindow.map(x => 100 - x.bidShare)), 3) : null, fiveMinuteMidpointMovePct: depthWindow.length >= 2 ? round(pct(depthWindow.at(-1).midpoint, depthWindow[0].midpoint), 3) : null, depthMinutes: depthWindow.length, depthSnapshots: depthAtSignal?.snapshots ?? 0 })
    return matches[0]
  }
  return null
}

const matches = symbols.map(scan).filter(Boolean).sort((a, b) => a.signalTime.localeCompare(b.signalTime))
const report = { date, universeCount: symbols.length, matchCount: matches.length, rule: "Event-driven bearish synchronized compression: previous 10 one-minute candles have EMA9 range <=0.6%, EMA45 range <=0.25%, VWAP range <=0.1% and all three slopes down; confirmation candle is the first candle closing below open and prior close with Price < EMA9 < EMA45 < VWAP, while the preceding candle is not already in that bearish stack. One signal per stock; depth is recorded for classification, not required.", matches }
const output = path.join(root, "reports", `${date}-synchronized-compression-breakdown-first-break.json`)
fs.writeFileSync(output, JSON.stringify(report, null, 2) + "\n")
console.log(JSON.stringify(report, null, 2))
