#!/usr/bin/env node
import fs from "node:fs"
import path from "node:path"

const ROOT = process.cwd(), MINUTE = 60_000, IST = 330 * MINUTE
const dateFlagIndex = process.argv.indexOf("--date")
const positionalDate = process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : null
const DATE = dateFlagIndex >= 0 ? process.argv[dateFlagIndex + 1] : positionalDate || "2026-10-29"
const parsedDate = new Date(`${DATE}T00:00:00Z`)
if (!/^\d{4}-\d{2}-\d{2}$/.test(DATE ?? "") || Number.isNaN(parsedDate.getTime()) || parsedDate.toISOString().slice(0, 10) !== DATE) {
  throw new Error("Use --date YYYY-MM-DD or pass YYYY-MM-DD as the positional argument.")
}
const CHECKPOINTS = [570, 585, 600] // 09:30, 09:45, 10:00 IST; use candles strictly before checkpoint.
const TOP_N = 5
const round = (x, n = 3) => Number.isFinite(x) ? Number(x.toFixed(n)) : null
const dateAt = t => new Date(t + IST).toISOString().slice(0, 10)
const minuteAt = t => { const d = new Date(t + IST); return d.getUTCHours() * 60 + d.getUTCMinutes() }
const clock = m => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`
const pct = (a, b) => b > 0 ? 100 * (a / b - 1) : NaN
const median = xs => { const values = xs.filter(Number.isFinite).sort((a, b) => a - b); return values.length ? values[Math.floor(values.length / 2)] : NaN }
const csv = value => /[",\n]/.test(String(value ?? "")) ? `"${String(value ?? "").replaceAll('"', '""')}"` : String(value ?? "")
const unique = (stem, ext) => { let n = 1, file; do { file = path.join(ROOT, "reports", `${stem}${n === 1 ? "" : `-${n}`}.${ext}`); n++ } while (fs.existsSync(file)); return file }

function load(symbol) {
  const file = path.join(ROOT, "db", "candles", `${symbol}.jsonl`), days = new Map()
  if (!fs.existsSync(file)) return days
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    if (!line) continue
    try {
      const x = JSON.parse(line), t = +x.time * 1000, d = dateAt(t), m = minuteAt(t)
      if (d > DATE || m < 555 || m >= 930) continue
      const r = { t, o: +x.open, h: +x.high, l: +x.low, c: +x.close, v: +x.volume }
      if (!Object.values(r).every(Number.isFinite) || r.l <= 0) continue
      if (!days.has(d)) days.set(d, [])
      days.get(d).push(r)
    } catch {}
  }
  for (const rows of days.values()) rows.sort((a, b) => a.t - b.t)
  return days
}

function aggregate(rows, n) {
  if (!rows.length) return []
  const start = Date.parse(`${DATE}T09:15:00+05:30`), bars = []
  for (const r of rows) {
    const t = start + Math.floor((r.t - start) / (n * MINUTE)) * n * MINUTE
    let b = bars.at(-1)
    if (!b || b.t !== t) { b = { t, o: r.o, h: r.h, l: r.l, c: r.c, v: r.v, count: 1 }; bars.push(b) }
    else { b.h = Math.max(b.h, r.h); b.l = Math.min(b.l, r.l); b.c = r.c; b.v += r.v; b.count++ }
  }
  return bars.filter(b => b.count === n)
}

function historicalLevels(days, sign) {
  const dates = [...days.keys()].filter(d => d < DATE).sort(), output = []
  for (const n of [1, 3, 5, 7]) {
    const rows = dates.slice(-n).flatMap(d => days.get(d) || [])
    if (!rows.length) continue
    output.push({ name: n === 1 ? (sign > 0 ? "PDH" : "PDL") : `${n}D${sign > 0 ? "H" : "L"}`, price: sign > 0 ? Math.max(...rows.map(r => r.h)) : Math.min(...rows.map(r => r.l)), weight: n === 7 ? 3 : n === 5 ? 2.7 : n === 3 ? 2.4 : 2.1 })
  }
  return output
}

function mtf(rows, checkpoint, sign) {
  let aligned = 0, structure = 0
  for (const n of [1, 3, 5, 10, 15]) {
    const bars = n === 1 ? rows : aggregate(rows, n), last = bars.at(-1), previous = bars.at(-2)
    if (!last) continue
    const base = previous?.c ?? rows[0].o
    const move = sign * (last.c - base) > 0
    const pa = previous ? (sign > 0 ? last.h >= previous.h && last.l >= previous.l : last.h <= previous.h && last.l <= previous.l) : sign * (last.c - rows[0].o) > 0
    if (move) aligned++
    if (pa) structure++
  }
  return { aligned, structure }
}

function levelState(rows, days, sign) {
  const levels = historicalLevels(days, sign)
  for (const n of [5, 10, 15]) if (rows.length >= n) levels.push({ name: `OR${n}${sign > 0 ? "H" : "L"}`, price: sign > 0 ? Math.max(...rows.slice(0, n).map(r => r.h)) : Math.min(...rows.slice(0, n).map(r => r.l)), weight: n === 15 ? 2 : n === 10 ? 1.7 : 1.4, active: n })
  const matches = []
  for (const level of levels) {
    if (level.active && rows.length <= level.active) continue
    const crossed = rows.findIndex((r, i) => i > 0 && (!level.active || i >= level.active) && (sign > 0 ? rows[i - 1].c <= level.price && r.c > level.price : rows[i - 1].c >= level.price && r.c < level.price))
    if (crossed < 0) continue
    const after = rows.slice(crossed + 1), tolerance = level.price * 0.002
    const retested = after.some(r => sign > 0 ? r.l <= level.price + tolerance && r.c >= level.price : r.h >= level.price - tolerance && r.c <= level.price)
    const held = rows.slice(-2).every(r => sign > 0 ? r.c > level.price : r.c < level.price)
    if (held) matches.push({ ...level, crossed, retested, quality: level.weight + (retested ? 1 : 0) })
  }
  return matches.sort((a, b) => b.quality - a.quality)[0] || null
}

function features(symbol, days, checkpoint, sign) {
  const day = days.get(DATE) || [], rows = day.filter(r => minuteAt(r.t) < checkpoint)
  const entryIndex = day.findIndex(r => minuteAt(r.t) === checkpoint)
  if (rows.length < 15 || entryIndex < 0) return null
  const level = levelState(rows, days, sign)
  if (!level) return null
  const last = rows.at(-1), sessionOpen = rows[0].o, directionMove = sign * pct(last.c, sessionOpen)
  if (!(directionMove > 0)) return null
  const volume = rows.reduce((sum, r) => sum + r.v, 0), priorDates = [...days.keys()].filter(d => d < DATE).sort().slice(-5)
  const priorVolumes = priorDates.map(d => (days.get(d) || []).slice(0, rows.length).reduce((sum, r) => sum + r.v, 0))
  const relativeVolume = volume / (median(priorVolumes) || volume)
  const totalVolume = rows.reduce((sum, r) => sum + r.v, 0), vwap = rows.reduce((sum, r) => sum + r.v * (r.h + r.l + r.c) / 3, 0) / totalVolume
  const state = mtf(rows, checkpoint, sign), closeLocation = last.h > last.l ? (sign > 0 ? (last.c - last.l) / (last.h - last.l) : (last.h - last.c) / (last.h - last.l)) : 0.5
  const recent = rows.slice(-10), travel = recent.slice(1).reduce((sum, r, i) => sum + Math.abs(r.c - recent[i].c), 0), efficiency = Math.abs(last.c - recent[0].o) / (travel || Math.abs(last.c - recent[0].o) || 1)
  const vwapAligned = sign * (last.c - vwap) > 0
  if (!vwapAligned || state.aligned < 3) return null
  const path20 = day.slice(entryIndex, entryIndex + 20), entry = day[entryIndex].o
  const return20 = path20.length === 20 ? sign * pct(path20.at(-1).c, entry) : NaN
  const favorable = path20.length === 20 ? (sign > 0 ? Math.max(...path20.map(r => r.h)) : Math.min(...path20.map(r => r.l))) : NaN
  const adverse = path20.length === 20 ? (sign > 0 ? Math.min(...path20.map(r => r.l)) : Math.max(...path20.map(r => r.h))) : NaN
  return { symbol, side: sign > 0 ? "BUY" : "SELL", checkpoint: clock(checkpoint), entryTime: clock(checkpoint), entryPrice: entry, level: level.name, levelPrice: level.price, retested: level.retested, levelQuality: level.quality, movePct: directionMove, relativeVolume, vwapGapPct: sign * pct(last.c, vwap), mtfAligned: state.aligned, structureFrames: state.structure, closeLocation, efficiency, return20Pct: return20, mfe20Pct: sign > 0 ? pct(favorable, entry) : pct(entry, favorable), mae20Pct: sign > 0 ? Math.min(0, pct(adverse, entry)) : Math.min(0, pct(entry, adverse)) }
}

function percentile(values, x) { return values.length ? values.filter(v => v <= x).length / values.length : 0 }
const symbols = JSON.parse(fs.readFileSync(path.join(ROOT, "db", "stocks"), "utf8")), cache = new Map(symbols.map(symbol => [symbol, load(symbol)]))
const selected = [], emitted = new Set(), checkpointAudits = []
for (const checkpoint of CHECKPOINTS) {
  const candidates = symbols.flatMap(symbol => [features(symbol, cache.get(symbol), checkpoint, 1), features(symbol, cache.get(symbol), checkpoint, -1)]).filter(Boolean)
  for (const side of ["BUY", "SELL"]) {
    const pool = candidates.filter(x => x.side === side), moves = pool.map(x => x.movePct), volumes = pool.map(x => x.relativeVolume), efficiencies = pool.map(x => x.efficiency)
    for (const x of pool) {
      x.strengthPercentile = percentile(moves, x.movePct)
      x.volumePercentile = percentile(volumes, x.relativeVolume)
      x.efficiencyPercentile = percentile(efficiencies, x.efficiency)
      x.score = 10 * (0.25 * x.levelQuality / 4 + 0.2 * x.mtfAligned / 5 + 0.1 * x.structureFrames / 5 + 0.2 * x.strengthPercentile + 0.15 * x.volumePercentile + 0.1 * x.efficiencyPercentile)
    }
    const ranked = pool.sort((a, b) => b.score - a.score || b.movePct - a.movePct)
    const fresh = ranked.filter(x => !emitted.has(`${x.symbol}|${x.side}`)).slice(0, TOP_N)
    for (const x of fresh) { emitted.add(`${x.symbol}|${x.side}`); selected.push(x) }
    checkpointAudits.push({ checkpoint: clock(checkpoint), side, eligible: ranked.length, top10: ranked.slice(0, 10).map(x => ({ symbol: x.symbol, score: round(x.score), level: x.level, movePct: round(x.movePct), relativeVolume: round(x.relativeVolume), mtfAligned: x.mtfAligned })) })
  }
}
for (const row of selected) for (const key of Object.keys(row)) if (typeof row[key] === "number") row[key] = round(row[key])
const completed = selected.filter(x => Number.isFinite(x.return20Pct)), returns = completed.map(x => x.return20Pct), maes = completed.map(x => x.mae20Pct)
const summary = { date: DATE, checkpoints: CHECKPOINTS.map(clock), method: "At each fixed checkpoint, use only completed earlier candles. Require a held break/retest of a frozen 1/3/5/7-session or completed 5/10/15-minute opening-range level, directional VWAP and >=3 aligned completed timeframes. Rank eligible candidates by level quality, MTF structure, gap-excluded session strength, relative cumulative volume versus prior five sessions and 10-minute price efficiency; emit top five fresh symbols per side.", signals: selected.length, completed20MinuteOutcomes: completed.length, winRate20Pct: round(100 * returns.filter(x => x > 0).length / (returns.length || 1), 2), averageReturn20Pct: round(returns.reduce((a, b) => a + b, 0) / (returns.length || 1)), totalReturn20Pct: round(returns.reduce((a, b) => a + b, 0)), maximumAdverseExcursion20Pct: maes.length ? round(Math.min(...maes)) : null, worstDay: completed.length ? { date: DATE, totalReturn20Pct: round(returns.reduce((a, b) => a + b, 0)) } : null }
const stem = `${DATE}-ranked-support-resistance-price-action-signals`, json = unique(stem, "json"), csvFile = unique(stem, "csv"), md = unique(stem, "md")
fs.writeFileSync(json, `${JSON.stringify({ summary, signals: selected, checkpointAudits }, null, 2)}\n`, { flag: "wx" })
const fields = ["checkpoint", "symbol", "side", "score", "level", "levelPrice", "retested", "entryTime", "entryPrice", "movePct", "relativeVolume", "vwapGapPct", "mtfAligned", "structureFrames", "efficiency", "return20Pct", "mfe20Pct", "mae20Pct"]
fs.writeFileSync(csvFile, `${[fields.join(","), ...selected.map(row => fields.map(f => csv(row[f])).join(","))].join("\n")}\n`, { flag: "wx" })
const table = ["| Time | Symbol | Side | Score | Active level | Entry | Move ex-gap | Rel. volume | MTF | 20m return | MFE | MAE |", "|---:|---|---|---:|---|---:|---:|---:|---:|---:|---:|---:|", ...selected.map(x => `| ${x.checkpoint} | ${x.symbol} | ${x.side} | ${x.score} | ${x.level} @ ${x.levelPrice}${x.retested ? " retest" : ""} | ${x.entryPrice} | ${x.movePct}% | ${x.relativeVolume}x | ${x.mtfAligned}/5 | ${x.return20Pct ?? "n/a"}% | ${x.mfe20Pct ?? "n/a"}% | ${x.mae20Pct ?? "n/a"}% |`)].join("\n")
fs.writeFileSync(md, `${[`# ${DATE} ranked support/resistance and price-action signals`, "", summary.method, "", `- Signals: ${summary.signals}`, `- Completed 20-minute outcomes: ${summary.completed20MinuteOutcomes}`, `- Win rate: ${summary.winRate20Pct}%`, `- Average / total 20-minute return: ${summary.averageReturn20Pct}% / ${summary.totalReturn20Pct}%`, `- Worst 20-minute MAE: ${summary.maximumAdverseExcursion20Pct}%`, "", table, "", `JSON: ${json}`, `CSV: ${csvFile}`, "", "Research warning: ranking weights are heuristic and have not been proven out of sample."].join("\n")}\n`, { flag: "wx" })
console.log(JSON.stringify({ summary, json, csv: csvFile, md, signals: selected }, null, 2))
