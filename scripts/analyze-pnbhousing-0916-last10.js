#!/usr/bin/env node
import fs from "node:fs"
import path from "node:path"
import readline from "node:readline"

const ROOT = process.cwd(), SYMBOL = "PNBHOUSING", TARGET = "2026-10-29", IST = 330 * 60_000
const round = (x, n = 3) => Number.isFinite(x) ? +x.toFixed(n) : null
const dateAt = seconds => new Date(seconds * 1000 + IST).toISOString().slice(0, 10)
const minuteAt = seconds => { const d = new Date(seconds * 1000 + IST); return d.getUTCHours() * 60 + d.getUTCMinutes() }
const timeAtMs = ms => new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).format(new Date(ms))
const pct = (a, b) => b > 0 ? 100 * (a / b - 1) : NaN
const mean = xs => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN
const median = xs => { const a = xs.filter(Number.isFinite).sort((x, y) => x - y); return a.length ? a[Math.floor(a.length / 2)] : NaN }
const unique = (stem, ext) => { let n = 1, file; do { file = path.join(ROOT, "reports", `${stem}${n === 1 ? "" : `-${n}`}.${ext}`); n++ } while (fs.existsSync(file)); return file }

function allCandles(symbol) {
  const file = path.join(ROOT, "db", "candles", `${symbol}.jsonl`), byDate = new Map()
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    if (!line) continue
    try {
      const x = JSON.parse(line), time = +x.time, m = minuteAt(time)
      if (m < 555 || m >= 930) continue
      const d = dateAt(time), row = { time, open: +x.open, high: +x.high, low: +x.low, close: +x.close, volume: +x.volume }
      if (!Object.values(row).every(Number.isFinite)) continue
      if (!byDate.has(d)) byDate.set(d, [])
      byDate.get(d).push(row)
    } catch {}
  }
  for (const rows of byDate.values()) rows.sort((a, b) => a.time - b.time)
  return byDate
}

function candleMetrics(rows, niftyRows) {
  const first = rows.find(x => minuteAt(x.time) === 555), second = rows.find(x => minuteAt(x.time) === 556)
  const niftyFirst = niftyRows?.find(x => minuteAt(x.time) === 555), niftySecond = niftyRows?.find(x => minuteAt(x.time) === 556)
  if (!second) return null
  const sameMinuteNiftyReturn = niftySecond ? pct(niftySecond.close, niftySecond.open) : NaN
  return {
    has0915: Boolean(first), open0916: second.open, high0916: second.high, low0916: second.low, close0916: second.close,
    return0916Pct: pct(second.close, second.open), lowExcursion0916Pct: pct(second.low, second.open), relativeToNifty0916Pct: pct(second.close, second.open) - sameMinuteNiftyReturn,
    volume0916: second.volume, range0916Pct: 100 * (second.high - second.low) / second.open,
    bearishBodyToRange: Math.max(0, second.open - second.close) / (second.high - second.low || 1),
    openingThrough0916ReturnPct: first ? pct(second.close, first.open) : null,
    openingThrough0916Volume: first ? first.volume + second.volume : null,
  }
}

async function depthMetrics(date, startClock, endClock) {
  const file = path.join(ROOT, "db", "cash-depth", date, SYMBOL, `${SYMBOL}.jsonl`)
  if (!fs.existsSync(file)) return { available: false, reason: "missing file" }
  const start = Date.parse(`${date}T${startClock}:00+05:30`), end = Date.parse(`${date}T${endClock}:00+05:30`), state = {}, rows = []
  let earliest = null, previous = null
  const input = fs.createReadStream(file, { encoding: "utf8" }), lines = readline.createInterface({ input, crlfDelay: Infinity })
  try {
    for await (const line of lines) {
      let event; try { event = JSON.parse(line) } catch { continue }
      const at = Date.parse(event.receivedAt)
      if (!Number.isFinite(at)) continue
      if (earliest == null) earliest = at
      if (at >= end) break
      if (event.kind === "checkpoint" || event.book) { for (const key of Object.keys(state)) delete state[key]; Object.assign(state, event.data) }
      else if (event.kind === "update") Object.assign(state, event.data)
      else continue
      if (at < start) continue
      let bid = 0, ask = 0, topBid = 0, topAsk = 0, bidOrders = 0, askOrders = 0, valid = true
      for (let level = 1; level <= 5; level++) {
        const bp = +state[`bid_price${level}`], ap = +state[`ask_price${level}`], bs = +state[`bid_size${level}`], as = +state[`ask_size${level}`]
        if (![bp, ap, bs, as].every(Number.isFinite) || bp <= 0 || ap <= bp || bs < 0 || as < 0) { valid = false; break }
        bid += bs; ask += as; if (level <= 2) { topBid += bs; topAsk += as }
        bidOrders += +state[`bid_order${level}`] || 0; askOrders += +state[`ask_order${level}`] || 0
      }
      if (!valid) continue
      const bp = +state.bid_price1, ap = +state.ask_price1, bs = +state.bid_size1, as = +state.ask_size1, mid = (bp + ap) / 2
      let ofi = 0
      if (previous) {
        const bidFlow = bp > previous.bp ? bs : bp === previous.bp ? bs - previous.bs : -previous.bs
        const askFlow = ap < previous.ap ? as : ap === previous.ap ? as - previous.as : -previous.as
        ofi = (bidFlow - askFlow) / ((bs + as + previous.bs + previous.as) / 2 || 1)
      }
      rows.push({ at, mid, full: (bid - ask) / (bid + ask || 1), top2: (topBid - topAsk) / (topBid + topAsk || 1), orders: (bidOrders - askOrders) / (bidOrders + askOrders || 1), spreadBps: 10000 * (ap - bp) / mid, ofi, cumulativeVolume: Number(event.marketContext?.cumulativeVolume) })
      previous = { bp, ap, bs, as }
    }
  } finally { lines.close(); input.destroy() }
  if (!rows.length) return { available: false, earliestTime: earliest ? timeAtMs(earliest) : null, reason: "no snapshots in window" }
  return {
    available: true, earliestTime: earliest ? timeAtMs(earliest) : null, snapshots: rows.length,
    midpointReturnPct: pct(rows.at(-1).mid, rows[0].mid), meanImbalancePct: 100 * mean(rows.map(x => x.full)), meanTop2ImbalancePct: 100 * mean(rows.map(x => x.top2)),
    askDominantSnapshotPct: 100 * rows.filter(x => x.full < 0).length / rows.length, meanOrderImbalancePct: 100 * mean(rows.map(x => x.orders)),
    cumulativeOfi: rows.reduce((sum, x) => sum + x.ofi, 0), meanSpreadBps: mean(rows.map(x => x.spreadBps)), maxSpreadBps: Math.max(...rows.map(x => x.spreadBps)),
    marketVolumeDelta: Number.isFinite(rows[0].cumulativeVolume) && Number.isFinite(rows.at(-1).cumulativeVolume) ? rows.at(-1).cumulativeVolume - rows[0].cumulativeVolume : null,
  }
}

const stock = allCandles(SYMBOL), nifty = allCandles("NIFTY50")
const priorDates = [...stock.keys()].filter(d => d < TARGET).sort().slice(-10), dates = [...priorDates, TARGET]
const rows = []
for (const date of dates) {
  const candle = candleMetrics(stock.get(date) || [], nifty.get(date) || [])
  if (!candle) continue
  rows.push({ date, ...Object.fromEntries(Object.entries(candle).map(([k, v]) => [k, typeof v === "number" ? round(v) : v])), depthBefore0916: await depthMetrics(date, "09:15", "09:16"), depthMinute0916: await depthMetrics(date, "09:16", "09:17") })
}
const target = rows.find(x => x.date === TARGET), priors = rows.filter(x => x.date !== TARGET)
const rankAsc = (field, value) => 1 + rows.filter(x => x[field] < value).length
const rankDesc = (field, value) => 1 + rows.filter(x => x[field] > value).length
const depthRank = (window, field, direction = "asc") => {
  const comparable = rows.filter(x => x[window]?.available && Number.isFinite(x[window][field]))
  const value = target[window]?.[field]
  if (!Number.isFinite(value)) return { rank: null, comparableSessions: comparable.length, value: null }
  return { rank: 1 + comparable.filter(x => direction === "asc" ? x[window][field] < value : x[window][field] > value).length, comparableSessions: comparable.length, value: round(value) }
}
const ranks = {
  candle: {
    return0916: { rank: rankAsc("return0916Pct", target.return0916Pct), of: rows.length },
    lowExcursion0916: { rank: rankAsc("lowExcursion0916Pct", target.lowExcursion0916Pct), of: rows.length },
    relativeToNifty0916: { rank: rankAsc("relativeToNifty0916Pct", target.relativeToNifty0916Pct), of: rows.length },
    volume0916: { rank: rankDesc("volume0916", target.volume0916), of: rows.length },
    range0916: { rank: rankDesc("range0916Pct", target.range0916Pct), of: rows.length },
  },
  depthMinute0916: {
    midpointDrop: depthRank("depthMinute0916", "midpointReturnPct", "asc"),
    imbalance: depthRank("depthMinute0916", "meanImbalancePct", "asc"),
    askDominance: depthRank("depthMinute0916", "askDominantSnapshotPct", "desc"),
    ofi: depthRank("depthMinute0916", "cumulativeOfi", "asc"),
  }
}
const volumeRatios = { volume0916VsPriorMedian: round(target.volume0916 / median(priors.map(x => x.volume0916)), 2) }
const result = { symbol: SYMBOL, targetDate: TARGET, comparisonDates: priorDates, interpretation: "The candle labelled 09:16 is compared with the same labelled one-minute candle in each prior session. It becomes fully known at 09:17 IST. Target-day 09:15 candle data is absent, so no two-minute cumulative rank is claimed.", target, volumeRatios, ranks, sessions: rows }
const stem = `${TARGET}-${SYMBOL.toLowerCase()}-0916-vs-prior10`, json = unique(stem, "json"), md = unique(stem, "md")
fs.writeFileSync(json, `${JSON.stringify(result, null, 2)}\n`, { flag: "wx" })
const candleTable = ["| Date | 09:16 return | Low excursion | Relative to NIFTY | Volume | Range | Bear body/range |", "|---|---:|---:|---:|---:|---:|---:|", ...rows.map(x => `| ${x.date} | ${x.return0916Pct}% | ${x.lowExcursion0916Pct}% | ${x.relativeToNifty0916Pct}% | ${x.volume0916} | ${x.range0916Pct}% | ${x.bearishBodyToRange} |`)].join("\n")
const depthTable = ["| Date | Earliest depth | 09:16 snapshots | Mid move | Mean imbalance | Ask-dominant | OFI |", "|---|---:|---:|---:|---:|---:|---:|", ...rows.map(x => { const d = x.depthMinute0916; return `| ${x.date} | ${d.earliestTime ?? "n/a"} | ${d.snapshots ?? 0} | ${round(d.midpointReturnPct)}% | ${round(d.meanImbalancePct)}% | ${round(d.askDominantSnapshotPct)}% | ${round(d.cumulativeOfi)} |` })].join("\n")
const report = [`# PNBHOUSING 09:16 candle on 29 October vs previous 10 sessions`, "", "## Result", "", `- Exact 09:16 candle drop rank: ${ranks.candle.return0916.rank}/${ranks.candle.return0916.of}.`, `- 09:16 low-excursion rank: ${ranks.candle.lowExcursion0916.rank}/${ranks.candle.lowExcursion0916.of}.`, `- NIFTY-relative 09:16 momentum rank: ${ranks.candle.relativeToNifty0916.rank}/${ranks.candle.relativeToNifty0916.of}.`, `- 09:16 volume rank: ${ranks.candle.volume0916.rank}/${ranks.candle.volume0916.of}; ${volumeRatios.volume0916VsPriorMedian}x prior-10 median.`, `- Depth-feed cumulative-volume increase during 09:16: ${target.depthMinute0916.marketVolumeDelta}; candle volume: ${target.volume0916}.`, `- 09:16 range rank: ${ranks.candle.range0916.rank}/${ranks.candle.range0916.of}.`, `- Depth midpoint-drop rank during 09:16: ${ranks.depthMinute0916.midpointDrop.rank}/${ranks.depthMinute0916.midpointDrop.comparableSessions}.`, `- Mean depth-imbalance weakness rank: ${ranks.depthMinute0916.imbalance.rank}/${ranks.depthMinute0916.imbalance.comparableSessions}.`, "", "The target-day candle file has no 09:15 candle, so this report compares the exact 09:16 candle only. Depth ranks exclude sessions without snapshots during 09:16:00-09:16:59 IST.", "", "## Candle comparison", "", candleTable, "", "## Depth comparison during 09:16", "", depthTable, "", `JSON: ${json}`].join("\n")
fs.writeFileSync(md, `${report}\n`, { flag: "wx" })
console.log(JSON.stringify({ json, md, comparisonDates: priorDates, target, volumeRatios, ranks }, null, 2))
