// Causal exploratory replay: node scripts/research-ranked-depth-strategies.js
// Every decision is made after a completed one-minute candle; the next completed
// candle close is the assumed entry. No future outcome is used for selection.
import fs from "node:fs"
import path from "node:path"
import { randomUUID } from "node:crypto"

const root = process.cwd(), IST = 330 * 60_000
const priorSessionsRequired = Number(process.argv.find(x => x.startsWith("--prior="))?.slice(8) ?? 5)
if (process.argv.slice(2).some(x => !/^--prior=(2|3|5)$/.test(x)) || ![2, 3, 5].includes(priorSessionsRequired)) {
  throw new Error("Usage: node scripts/research-ranked-depth-strategies.js [--prior=2|3|5]")
}
const dates = ["2026-10-05", "2026-10-06", "2026-10-07", "2026-10-08", "2026-10-09",
  "2026-10-12", "2026-10-13", "2026-10-14", "2026-10-15", "2026-10-16", "2026-10-19", "2026-10-21"]
const scanDates = dates.slice(1), symbols = [...new Set(JSON.parse(fs.readFileSync(path.join(root, "db/stocks"), "utf8"))
  .map(x => String(x).replace(/-EQ$/, "")))].sort()
const clock = epoch => new Date(epoch * 1000 + IST).toISOString().slice(0, 16).replace("T", " ")
const nextMinute = stamp => new Date(Date.parse(`${stamp.replace(" ", "T")}:00+05:30`) + 60_000 + IST)
  .toISOString().slice(0, 16).replace("T", " ")
const min = stamp => Number(stamp.slice(11, 13)) * 60 + Number(stamp.slice(14, 16))
const pct = (a, b) => 100 * (a / b - 1)
const round = n => Number.isFinite(n) ? Number(n.toFixed(3)) : null
const avg = a => a.reduce((s, x) => s + x, 0) / a.length

// Five distinct, frozen candidate families. These are exploratory hypotheses,
// not an optimized selection. Fixed risk schedules are not chosen by outcomes.
const families = [
  { id: "opening_range", stop: .6, target: 1.2, maxPerDay: 2 },
  { id: "ema9_20_cross", stop: .55, target: 1.1, maxPerDay: 2 },
  { id: "vwap_reclaim", stop: .5, target: 1, maxPerDay: 2 },
  { id: "pullback_resume", stop: .6, target: 1.2, maxPerDay: 2 },
  { id: "supertrend_flip", stop: .65, target: 1.3, maxPerDay: 2 }
]
const sessions = new Map(), coverage = {}
for (const symbol of symbols) {
  const file = path.join(root, "db/candles", `${symbol}.jsonl`)
  if (!fs.existsSync(file)) continue
  const map = new Map(dates.map(date => [date, new Map()]))
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    if (!line) continue
    let raw
    try { raw = JSON.parse(line) } catch { continue }
    const stamp = clock(Number(raw.time)), day = stamp.slice(0, 10)
    if (!map.has(day) || raw.partial) continue
    const [open, high, low, close, volume] = [raw.open, raw.high, raw.low, raw.close, raw.volume].map(Number)
    if (![open, high, low, close, volume].every(Number.isFinite) || open <= 0 || volume < 0 ||
      high < Math.max(open, close) || low > Math.min(open, close)) continue
    const m = min(stamp)
    if (m < 555 || m > 929) continue
    map.get(day).set(m, { stamp, m, open, high, low, close, volume })
  }
  sessions.set(symbol, new Map([...map].map(([date, byMinute]) => [date, [...byMinute.values()].sort((a, b) => a.m - b.m)])))
}

function enrich(rows) {
  let e9 = null, e20 = null, e45 = null, pv = 0, vol = 0, atr = null, st = null, stDir = 0
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i], prev = rows[i - 1], tr = Math.max(r.high - r.low,
      prev ? Math.abs(r.high - prev.close) : 0, prev ? Math.abs(r.low - prev.close) : 0)
    atr = atr == null ? tr : (atr * 9 + tr) / 10
    e9 = e9 == null ? r.close : .2 * r.close + .8 * e9
    e20 = e20 == null ? r.close : (2 / 21) * r.close + (19 / 21) * e20
    e45 = e45 == null ? r.close : (2 / 46) * r.close + (44 / 46) * e45
    pv += ((r.high + r.low + r.close) / 3) * r.volume; vol += r.volume
    const midpoint = (r.high + r.low) / 2, upper = midpoint + 3 * atr, lower = midpoint - 3 * atr
    if (st == null) { stDir = r.close >= midpoint ? 1 : -1; st = stDir > 0 ? lower : upper }
    else if (stDir > 0) {
      const next = Math.max(st, lower)
      if (r.close < next) { stDir = -1; st = upper } else st = next
    } else {
      const next = Math.min(st, upper)
      if (r.close > next) { stDir = 1; st = lower } else st = next
    }
    Object.assign(r, { ema9: e9, ema20: e20, ema45: e45, vwap: vol ? pv / vol : null,
      atr, st, stDir })
  }
}

// The same-clock reference uses *only* complete prior sessions, never today.
function priorReference(symbol, day, m, lookback) {
  const index = dates.indexOf(day), history = []
  for (let k = index - 1; k >= 0 && history.length < lookback; k--) {
    const rows = sessions.get(symbol)?.get(dates[k]) ?? []
    const window = rows.filter(r => r.m >= m - 4 && r.m <= m)
    if (window.length !== 5 || window.some((r, j) => r.m !== m - 4 + j) || rows.length < 300) continue
    const low = Math.min(...rows.map(r => r.low)), high = Math.max(...rows.map(r => r.high))
    history.push({ volume5: window.reduce((s, r) => s + r.volume, 0), rangePct: pct(high, low) })
  }
  if (history.length < lookback) return null
  return { rvolBase: avg(history.map(x => x.volume5)), rangePct: avg(history.map(x => x.rangePct)), sessions: history.length }
}

const candidates = [], familyCounts = Object.fromEntries(families.map(f => [f.id, 0]))
for (const day of scanDates) for (const symbol of symbols) {
  const rows = sessions.get(symbol)?.get(day) ?? []
  if (rows.length < 21) continue
  enrich(rows)
  const byMinute = new Map(rows.map((row, i) => [row.m, i]))
  const open15 = rows.filter(r => r.m >= 555 && r.m <= 569)
  if (open15.length !== 15) continue
  const orbHigh = Math.max(...open15.map(r => r.high)), orbLow = Math.min(...open15.map(r => r.low))
  for (let i = 20; i < rows.length; i++) {
    const r = rows[i], p = rows[i - 1]
    if (r.m < 575 || r.m > 810 || p.m !== r.m - 1) continue
    const five = Array.from({ length: 5 }, (_, j) => rows[byMinute.get(r.m - 4 + j)])
    const fifteen = Array.from({ length: 15 }, (_, j) => rows[byMinute.get(r.m - 14 + j)])
    if (five.some(x => !x) || fifteen.some(x => !x) || !r.vwap || !p.vwap) continue
    const prev5vol = rows.slice(i - 5, i).reduce((s, x) => s + x.volume, 0) / 5
    if (prev5vol <= 0 || r.volume / prev5vol < 1.1) continue
    const reference = priorReference(symbol, day, r.m, priorSessionsRequired)
    if (!reference || reference.rvolBase <= 0) continue
    const rvol5 = five.reduce((s, x) => s + x.volume, 0) / reference.rvolBase
    if (rvol5 < 1.2) continue
    const recentHigh = Math.max(...fifteen.slice(0, -1).map(x => x.high))
    const recentLow = Math.min(...fifteen.slice(0, -1).map(x => x.low))
    const last5 = pct(r.close, five[0].open), last15 = pct(r.close, fifteen[0].open)
    const emaSlope5 = pct(r.ema9, rows[byMinute.get(r.m - 5)]?.ema9 ?? r.ema9)
    for (const side of ["BUY", "SELL"]) {
      const dir = side === "BUY" ? 1 : -1
      const directional = dir * pct(r.close, r.open)
      const stack = dir > 0 ? r.close > r.ema9 && r.ema9 > r.ema20 && r.close > r.vwap
        : r.close < r.ema9 && r.ema9 < r.ema20 && r.close < r.vwap
      const move = dir * last5, move15 = dir * last15
      if (!stack || directional < .08 || dir * emaSlope5 < .015 || move < .16) continue
      const dayMove = dir * pct(r.close, rows[0].open)
      if (dayMove < .35 || dayMove > Math.max(3.5, reference.rangePct * 2)) continue
      const breakout = dir > 0 ? r.close > orbHigh && p.close <= orbHigh : r.close < orbLow && p.close >= orbLow
      const cross = dir > 0 ? r.ema9 > r.ema20 && p.ema9 <= p.ema20 : r.ema9 < r.ema20 && p.ema9 >= p.ema20
      const reclaim = dir > 0 ? r.close > r.vwap && p.close <= p.vwap : r.close < r.vwap && p.close >= p.vwap
      const priorThree = rows.slice(i - 3, i)
      const pullback = move15 >= .3 && priorThree.some(x => dir * pct(x.close, x.open) < -.03) &&
        (dir > 0 ? r.close > Math.max(...priorThree.map(x => x.high)) : r.close < Math.min(...priorThree.map(x => x.low)))
      const flip = r.stDir === dir && p.stDir !== dir && (dir > 0 ? r.close > recentHigh : r.close < recentLow)
      for (const [family, matched] of [["opening_range", breakout], ["ema9_20_cross", cross],
        ["vwap_reclaim", reclaim], ["pullback_resume", pullback], ["supertrend_flip", flip]]) {
        if (!matched) continue
        const rank = rvol5 * (1 + move) * (1 + Math.min(dayMove, 3) / 3) *
          (1 + Math.min(r.volume / prev5vol, 4) / 4)
        candidates.push({ date: day, symbol, side, family, signalTime: r.stamp, signalMinute: r.m,
          entryTime: nextMinute(r.stamp), rank: round(rank), rvol5: round(rvol5),
          priorSessions: reference.sessions, dayMovePct: round(dayMove), move5Pct: round(move),
          move15Pct: round(move15), signalVolumeMultiple: round(r.volume / prev5vol),
          atrPct: round(100 * r.atr / r.close), nextIndex: i + 1 })
        familyCounts[family]++
      }
    }
  }
}

// Depth is read only for ranked candidates at each completed minute. The five
// minute window is cut at the signal-minute boundary, even if the file has more.
const depthCache = new Map()
function depthAt(row) {
  const key = `${row.date}/${row.symbol}/${row.signalMinute}`
  if (depthCache.has(key)) return depthCache.get(key)
  const file = path.join(root, "db/cash-depth", row.date, row.symbol, `${row.symbol}.jsonl`)
  if (!fs.existsSync(file)) return null
  const state = {}, buckets = new Map()
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    if (!line) continue
    let event
    try { event = JSON.parse(line) } catch { continue }
    const at = new Date(Date.parse(event.receivedAt) + IST).toISOString().slice(0, 16).replace("T", " ")
    if (at.slice(0, 10) !== row.date) continue
    const m = min(at)
    if (m > row.signalMinute) break
    if (event.kind === "checkpoint") for (const k of Object.keys(state)) delete state[k]
    Object.assign(state, event.data ?? {})
    if (m < row.signalMinute - 4) continue
    let bid = 0, ask = 0, valid = true
    for (let l = 1; l <= 5; l++) {
      const bp = Number(state[`bid_price${l}`]), ap = Number(state[`ask_price${l}`])
      const bs = Number(state[`bid_size${l}`]), as = Number(state[`ask_size${l}`])
      if (![bp, ap, bs, as].every(Number.isFinite) || bp <= 0 || ap <= bp || bs < 0 || as < 0) {
        valid = false; break
      }
      bid += bs; ask += as
    }
    if (!valid || bid + ask === 0) continue
    const group = buckets.get(m) ?? []
    group.push({ share: row.side === "BUY" ? 100 * bid / (bid + ask) : 100 * ask / (bid + ask),
      midpoint: (Number(state.bid_price1) + Number(state.ask_price1)) / 2 })
    buckets.set(m, group)
  }
  const groups = Array.from({ length: 5 }, (_, j) => buckets.get(row.signalMinute - 4 + j))
  if (groups.some(g => !g || g.length < 2)) { depthCache.set(key, null); return null }
  const share = avg(groups.map(g => avg(g.map(x => x.share))))
  const midpoint = pct(avg(groups.at(-1).map(x => x.midpoint)), avg(groups[0].map(x => x.midpoint)))
  const result = { directionalSharePct: round(share), directionalMidpointPct: round((row.side === "BUY" ? 1 : -1) * midpoint),
    snapshots: groups.reduce((s, g) => s + g.length, 0) }
  depthCache.set(key, result)
  return result
}

function evaluate(row) {
  const bars = sessions.get(row.symbol).get(row.date), family = families.find(f => f.id === row.family)
  const entry = bars[row.nextIndex], dir = row.side === "BUY" ? 1 : -1
  const stop = entry.close * (1 - dir * family.stop / 100)
  const target = entry.close * (1 + dir * family.target / 100)
  let mae = 0, mfe = 0
  for (const bar of bars.slice(row.nextIndex + 1)) {
    mae = Math.max(mae, dir > 0 ? 100 * (1 - bar.low / entry.close) : pct(bar.high, entry.close))
    mfe = Math.max(mfe, dir > 0 ? pct(bar.high, entry.close) : 100 * (1 - bar.low / entry.close))
    const hitStop = dir > 0 ? bar.low <= stop : bar.high >= stop
    const hitTarget = dir > 0 ? bar.high >= target : bar.low <= target
    if (hitStop || hitTarget) return { entryPrice: round(entry.close), exitTime: bar.stamp, exitReason: hitStop ? "stop" : "target",
      returnPct: hitStop ? -family.stop : family.target, adverseMovePct: round(mae), favorableMovePct: round(mfe) }
  }
  return { entryPrice: round(entry.close), exitTime: bars.at(-1).stamp, exitReason: "sessionEnd",
    returnPct: round(dir * pct(bars.at(-1).close, entry.close)), adverseMovePct: round(mae), favorableMovePct: round(mfe) }
}

const byMinute = Map.groupBy(candidates, row => row.signalTime)
const signals = [], countByDayFamily = new Map(), usedStockDay = new Set()
let unfilledCandidates = 0
for (const [time, entries] of [...byMinute].sort((a, b) => a[0].localeCompare(b[0]))) {
  const sorted = [...entries].sort((a, b) => b.rank - a.rank || a.symbol.localeCompare(b.symbol))
  const tried = new Map()
  for (const row of sorted) {
    const groupKey = `${row.date}/${row.family}`, stockKey = `${row.date}/${row.symbol}`
    const family = families.find(f => f.id === row.family)
    if ((countByDayFamily.get(groupKey) ?? 0) >= family.maxPerDay || usedStockDay.has(stockKey)) continue
    // Rank is cross-sectional only among events known at this same minute.
    if ((tried.get(row.family) ?? 0) >= 3) continue
    tried.set(row.family, (tried.get(row.family) ?? 0) + 1)
    const d = depthAt(row)
    if (!d || d.directionalSharePct < 52 || d.directionalMidpointPct < 0) continue
    const next = sessions.get(row.symbol).get(row.date)[row.nextIndex]
    if (!next || next.m !== row.signalMinute + 1) { unfilledCandidates++; continue }
    countByDayFamily.set(groupKey, (countByDayFamily.get(groupKey) ?? 0) + 1)
    usedStockDay.add(stockKey)
    signals.push({ ...row, depth: d, ...evaluate(row) })
  }
}

const summarize = rows => {
  const total = rows.reduce((s, r) => s + r.returnPct, 0)
  const byDay = Map.groupBy(rows, r => r.date)
  const worst = [...byDay].map(([date, day]) => ({ date, totalReturnPct: round(day.reduce((s, r) => s + r.returnPct, 0)) }))
    .sort((a, b) => a.totalReturnPct - b.totalReturnPct)[0] ?? null
  return { tradeCount: rows.length, stops: rows.filter(x => x.exitReason === "stop").length,
    targetHits: rows.filter(x => x.exitReason === "target").length,
    winRatePct: rows.length ? round(100 * rows.filter(x => x.returnPct > 0).length / rows.length) : null,
    averageReturnPct: rows.length ? round(total / rows.length) : null, totalReturnPct: round(total),
    maximumAdverseExcursionPct: rows.length ? round(Math.max(...rows.map(x => x.adverseMovePct))) : null,
    worstDay: worst }
}
const result = { title: "Ranked prior-session candle and five-level depth strategy research",
  dates: scanDates, universeCount: symbols.length, priorSessionsRequired,
  source: "db/candles/<SYMBOL>.jsonl and db/cash-depth/<date>/<SYMBOL>/<SYMBOL>.jsonl",
  caveat: "Exploratory, in-sample. No genuine trade footprint or aggressor-side executions in five-level resting depth. Oct 21 candles may be incomplete. Gross, before fees/spread/slippage; target/stop fills assumed; summed returns are not portfolio returns.",
  execution: "Signal after minute closes; depth through that minute only; same-minute cross-sectional rank; next completed minute close entry; conservative stop-first on ambiguous future bars; session-end close otherwise. One stock/day across families.",
  families, familyCandidateCounts: familyCounts, unfilledCandidates, summary: summarize(signals),
  byFamily: Object.fromEntries(families.map(f => [f.id, summarize(signals.filter(x => x.family === f.id))])),
  early: summarize(signals.filter(x => x.date <= "2026-10-16")),
  later: summarize(signals.filter(x => x.date >= "2026-10-19")), signals }
const id = `${new Date().toISOString().replace(/[-:.]/g, "").slice(0, 15)}-${randomUUID().slice(0, 8)}`
const file = path.join(root, "reports", `ranked-depth-strategies-prior${priorSessionsRequired}-2026-10-06-to-2026-10-21-${id}.json`)
fs.writeFileSync(file, JSON.stringify(result, null, 2) + "\n", { flag: "wx" })
console.log(JSON.stringify({ file, candidateCounts: familyCounts, summary: result.summary,
  byFamily: result.byFamily, early: result.early, later: result.later }, null, 2))
