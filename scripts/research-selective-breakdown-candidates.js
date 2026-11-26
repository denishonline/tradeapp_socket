import fs from "node:fs"
import path from "node:path"
import { pathToFileURL } from "node:url"

const root = process.cwd(), date = process.argv[2] ?? "2026-10-21"
const directRun = import.meta.url === pathToFileURL(process.argv[1]).href
const round = (n, places = 3) => Number(n.toFixed(places))
const pct = (a, b) => 100 * (a / b - 1)
const rangePct = values => pct(Math.max(...values), Math.min(...values))
const minute = text => Number(text.slice(0, 2)) * 60 + Number(text.slice(3, 5))
const stamp = epoch => new Date(epoch * 1000 + 330 * 60_000).toISOString().slice(0, 16).replace("T", " ")
const symbols = [...new Set(JSON.parse(fs.readFileSync(path.join(root, "db", "stocks"), "utf8"))
  .map(value => String(value).trim().toUpperCase().replace(/-EQ$/, "")))]

function candles(symbol) {
  const file = path.join(root, "db", "candles", `${symbol}.jsonl`)
  if (!fs.existsSync(file)) return []
  const rows = []
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    if (!line) continue
    let raw
    try { raw = JSON.parse(line) } catch { continue }
    const time = stamp(Number(raw.time)), m = minute(time.slice(11))
    if (time.slice(0, 10) !== date || m < 555 || m > 929 ||
      ![raw.open, raw.high, raw.low, raw.close, raw.volume].every(x => Number.isFinite(Number(x)))) continue
    rows.push({ time, minute: m, open: +raw.open, high: +raw.high, low: +raw.low, close: +raw.close, volume: +raw.volume })
  }
  rows.sort((a, b) => a.minute - b.minute)
  let ema9, ema45, pv = 0, vol = 0
  return rows.map(row => {
    ema9 = ema9 == null ? row.close : .2 * row.close + .8 * ema9
    ema45 = ema45 == null ? row.close : 2 / 46 * row.close + 44 / 46 * ema45
    pv += (row.high + row.low + row.close) / 3 * row.volume
    vol += row.volume
    return { ...row, ema9, ema45, vwap: pv / vol }
  })
}

export function outcome(rows, entryIndex, side = "SELL") {
  if (side !== "SELL" && side !== "BUY") throw new Error(`Unsupported side: ${side}`)
  const entry = rows[entryIndex]
  const stop = entry.close * (side === "SELL" ? 1.0075 : .9925)
  const target = entry.close * (side === "SELL" ? .9845 : 1.0155)
  let mfe = 0, mae = 0
  for (let j = entryIndex + 1; j < rows.length; j++) {
    const row = rows[j]
    mfe = Math.max(mfe, side === "SELL" ? -pct(row.low, entry.close) : pct(row.high, entry.close))
    mae = Math.max(mae, side === "SELL" ? pct(row.high, entry.close) : -pct(row.low, entry.close))
    const stopped = side === "SELL" ? row.high >= stop : row.low <= stop
    const targeted = side === "SELL" ? row.low <= target : row.high >= target
    if (stopped) return { reason: "stop", exitTime: row.time, returnPct: -.75, mfe, mae }
    if (targeted) return { reason: "target", exitTime: row.time, returnPct: 1.55, mfe, mae }
  }
  return { reason: "sessionEnd", exitTime: rows.at(-1).time,
    returnPct: (side === "SELL" ? -1 : 1) * pct(rows.at(-1).close, entry.close), mfe, mae }
}

export const candidates = []
export const buyCandidates = []
export const barsBySymbol = new Map()
for (const symbol of symbols) {
  const rows = candles(symbol)
  barsBySymbol.set(symbol, rows)
  for (let i = 10; i < rows.length - 2; i++) {
    const row = rows[i], prev = rows[i - 1], pre = rows.slice(i - 10, i), entry = rows[i + 1]
    if (pre[0].minute !== row.minute - 10 || pre.some((x, k) => x.minute !== row.minute - 10 + k) || entry.minute !== row.minute + 1) continue
    const sellStack = x => x.close < x.ema9 && x.ema9 < x.ema45 && x.ema45 < x.vwap
    const buyStack = x => x.close > x.ema9 && x.ema9 > x.ema45 && x.ema45 > x.vwap
    const compressed = rangePct(pre.map(x => x.ema9)) <= .75 && rangePct(pre.map(x => x.ema45)) <= .3 && rangePct(pre.map(x => x.vwap)) <= .15
    const downward = ["ema9", "ema45", "vwap"].filter(key => pre.at(-1)[key] < pre[0][key]).length
    const upward = ["ema9", "ema45", "vwap"].filter(key => pre.at(-1)[key] > pre[0][key]).length
    const sell = compressed && downward >= 2 && sellStack(row) && !sellStack(prev) && row.close < row.open && row.close < prev.close
    const buy = compressed && upward >= 2 && buyStack(row) && !buyStack(prev) && row.close > row.open && row.close > prev.close
    if (!sell && !buy) continue
    const prior5 = pre.slice(-5), avgVolume = prior5.reduce((sum, x) => sum + x.volume, 0) / 5
    const base = { symbol, signalTime: row.time, entryTime: entry.time,
      signalMinute: row.minute, signalClose: round(row.close), entryPrice: round(entry.close),
      signalVolumeMultiple: round(row.volume / Math.max(avgVolume, 1)),
      prior5ReturnPct: round(pct(prev.close, prior5[0].close)),
      signalVs5AgoPct: round(pct(row.close, prior5[0].close)),
      signalVsOpenPct: round(pct(row.close, rows[0].open)),
      pre10PriceRangePct: round(rangePct(pre.map(x => x.close))),
      pre10Ema9RangePct: round(rangePct(pre.map(x => x.ema9))),
      pre10Ema45RangePct: round(rangePct(pre.map(x => x.ema45))),
      pre10VwapRangePct: round(rangePct(pre.map(x => x.vwap))) }
    for (const side of ["SELL", "BUY"]) {
      if (side === "SELL" ? !sell : !buy) continue
      const result = directRun ? outcome(rows, i + 1, side) : null
      const direction = side === "SELL" ? -1 : 1
      const candidate = { ...base, side,
        signalBodyPct: round(direction * pct(row.close, row.open)),
        belowVwapPct: side === "SELL" ? round(-pct(row.close, row.vwap)) : undefined,
        aboveVwapPct: side === "BUY" ? round(pct(row.close, row.vwap)) : undefined,
        belowEma9Pct: side === "SELL" ? round(-pct(row.close, row.ema9)) : undefined,
        aboveEma9Pct: side === "BUY" ? round(pct(row.close, row.ema9)) : undefined,
        downwardCount: side === "SELL" ? downward : undefined,
        upwardCount: side === "BUY" ? upward : undefined,
        ...(result ? { exitTime: result.exitTime, exitReason: result.reason,
          returnPct: round(result.returnPct), favorableMovePct: round(result.mfe), adverseMovePct: round(result.mae) } : {}) }
      if (side === "SELL") candidates.push(candidate)
      else buyCandidates.push(candidate)
    }
  }
}
candidates.sort((a, b) => a.signalTime.localeCompare(b.signalTime) || a.symbol.localeCompare(b.symbol))
buyCandidates.sort((a, b) => a.signalTime.localeCompare(b.signalTime) || a.symbol.localeCompare(b.symbol))
export { candles, symbols }
if (directRun) {
  const output = path.join(root, "reports", `${date}-selective-two-sided-candidate-research.json`)
  if (fs.existsSync(output)) throw new Error(`Report exists: ${output}`)
  fs.writeFileSync(output, JSON.stringify({ date, universeCount: symbols.length,
    note: "Exploratory candidate file. Forward outcomes are for analysis only; selection must use signal-time fields.",
    sellCandidateCount: candidates.length, buyCandidateCount: buyCandidates.length,
    candidates: [...candidates, ...buyCandidates].sort((a, b) => a.signalTime.localeCompare(b.signalTime) || a.symbol.localeCompare(b.symbol)) }, null, 2) + "\n")
  console.log(JSON.stringify({ output, sellCandidateCount: candidates.length,
    buyCandidateCount: buyCandidates.length }))
}
