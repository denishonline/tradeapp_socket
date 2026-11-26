#!/usr/bin/env node
import fs from "node:fs"
import path from "node:path"

const ROOT = process.cwd()
const DATE = process.argv[2] || "2026-10-29"
const MINUTE = 60_000
const IST = 330 * MINUTE
const CUTOFF_MINUTE = DATE === "2026-10-29" ? 10 * 60 + 52 : 15 * 60 + 29
const COHORTS = {
  "2026-10-06": {
    gainers: ["PGEL", "TIINDIA", "MOTILALOFS", "BHEL", "POLICYBZR", "AMBER", "BLUESTARCO", "LAURUSLABS", "TRENT", "DIVISLAB"],
    losers: ["COALINDIA", "PHOENIXLTD", "BANDHANBNK", "FEDERALBNK", "NATIONALUM", "MAXHEALTH", "TECHM", "AMBUJACEM", "KALYANKJIL", "KEI"],
  },
  "2026-10-15": {
    gainers: ["HDFCAMC", "HINDPETRO", "BAJAJHLDNG", "ICICIBANK", "BHARTIARTL", "TECHM", "HINDALCO", "NAM-INDIA", "MARUTI", "POLICYBZR"],
    losers: ["YESBANK", "NESTLEIND", "CANBK", "ICICIGI", "BHEL", "RBLBANK", "CGPOWER", "POWERINDIA", "VBL", "BANKINDIA"],
  },
  "2026-10-26": {
    gainers: ["COFORGE", "SWIGGY", "ADANIGREEN", "IDEA", "JSWSTEEL", "LAURUSLABS", "MPHASIS", "KEI", "GMRAIRPORT", "JUBLFOOD"],
    losers: ["SUPREMEIND", "TATACONSUM", "SAMMAANCAP", "UPL", "GODREJCP", "ASHOKLEY", "TATAPOWER", "SYNGENE", "TITAGARH", "AUBANK"],
  },
  "2026-10-27": {
    gainers: ["MANKIND", "SONACOMS", "APLAPOLLO", "PGEL", "UPL", "DIVISLAB", "MOTILALOFS", "HINDPETRO", "POWERINDIA", "FORCEMOT"],
    losers: ["MAZDOCK", "AMBUJACEM", "CYIENT", "PAYTM", "RECLTD", "BDL", "AUBANK", "WAAREEENER", "IREDA", "SBICARD"],
  },
  "2026-10-28": {
    gainers: ["TITAGARH", "VOLTAS", "PATANJALI", "BIOCON", "KPITTECH", "CHOLAFIN", "PGEL", "UPL", "SYNGENE", "BLUESTARCO"],
    losers: ["KAYNES", "PIDILITIND", "SAIL", "UNITDSPR", "RELIANCE", "PRESTIGE", "BAJAJHLDNG", "PETRONET", "APLAPOLLO", "SWIGGY"],
  },
  "2026-10-29": {
    gainers: ["SAMMAANCAP", "ADANIENSOL", "ADANIENT", "MANAPPURAM", "KOTAKBANK", "APLAPOLLO", "POWERGRID", "PIIND", "ADANIPORTS", "CDSL"],
    losers: ["PNBHOUSING", "DALBHARAT", "BAJAJHLDNG", "CHOLAFIN", "TITAGARH", "HEROMOTOCO", "PIDILITIND", "MFSL", "TRENT", "BAJAJ-AUTO"],
  },
}
const UNIVERSE_MODE = process.argv.includes("--universe")
if (!COHORTS[DATE] && !UNIVERSE_MODE) throw new Error(`Unsupported date: ${DATE}; use --universe to scan a date without a named mover cohort`)
const GAINERS = COHORTS[DATE]?.gainers || []
const LOSERS = COHORTS[DATE]?.losers || []
const TARGETS = [...GAINERS.map(symbol => ({ symbol, side: "BUY" })), ...LOSERS.map(symbol => ({ symbol, side: "SELL" }))]
const round = (x, n = 3) => Number.isFinite(x) ? Number(x.toFixed(n)) : null
const dateAt = t => new Date(t + IST).toISOString().slice(0, 10)
const timeAt = t => new Date(t + IST).toISOString().slice(11, 16)
const minuteAt = t => { const d = new Date(t + IST); return d.getUTCHours() * 60 + d.getUTCMinutes() }
const pct = (a, b) => b > 0 ? 100 * (a / b - 1) : NaN
const csvValue = value => /[",\n]/.test(String(value ?? "")) ? `"${String(value ?? "").replaceAll('"', '""')}"` : String(value ?? "")
const unique = (stem, ext) => { let n = 1, file; do { file = path.join(ROOT, "reports", `${stem}${n === 1 ? "" : `-${n}`}.${ext}`); n++ } while (fs.existsSync(file)); return file }

function load(symbol) {
  const file = path.join(ROOT, "db", "candles", `${symbol}.jsonl`)
  const days = new Map()
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    if (!line) continue
    try {
      const x = JSON.parse(line), t = Number(x.time) * 1000, minute = minuteAt(t)
      if (dateAt(t) > DATE || minute < 555 || minute >= 930) continue
      const bar = { t, o: +x.open, h: +x.high, l: +x.low, c: +x.close, v: +x.volume }
      if (!Object.values(bar).every(Number.isFinite) || bar.l <= 0) continue
      const date = dateAt(t)
      if (!days.has(date)) days.set(date, [])
      days.get(date).push(bar)
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
    let bar = bars.at(-1)
    if (!bar || bar.t !== t) { bar = { t, o: r.o, h: r.h, l: r.l, c: r.c, v: r.v, count: 1 }; bars.push(bar) }
    else { bar.h = Math.max(bar.h, r.h); bar.l = Math.min(bar.l, r.l); bar.c = r.c; bar.v += r.v; bar.count++ }
  }
  return bars.filter(bar => bar.count === n)
}

function priorLevels(days) {
  const dates = [...days.keys()].filter(date => date < DATE).sort()
  const output = []
  for (const n of [1, 3, 5, 7]) {
    const selected = dates.slice(-n), rows = selected.flatMap(date => days.get(date))
    if (!rows.length) continue
    output.push({ name: n === 1 ? "PDH" : `${n}DH`, kind: "HIGH", price: Math.max(...rows.map(r => r.h)), sessions: selected })
    output.push({ name: n === 1 ? "PDL" : `${n}DL`, kind: "LOW", price: Math.min(...rows.map(r => r.l)), sessions: selected })
  }
  return output
}

function directionalCloseLocation(bar, sign) {
  return bar.h > bar.l ? (sign > 0 ? (bar.c - bar.l) / (bar.h - bar.l) : (bar.h - bar.c) / (bar.h - bar.l)) : 0.5
}

function mtfState(frames, signalAt, sign, sessionOpen) {
  const detail = {}, active = []
  for (const n of [1, 3, 5, 10, 15]) {
    const complete = frames.get(n).filter(bar => bar.t + n * MINUTE <= signalAt)
    const last = complete.at(-1), prior = complete.at(-2)
    if (!last) { detail[n] = null; continue }
    const base = prior?.c ?? sessionOpen
    const directionMove = sign * (last.c - base) > 0
    const structure = prior ? (sign > 0 ? last.h >= prior.h && last.c > prior.c : last.l <= prior.l && last.c < prior.c) : sign * (last.c - sessionOpen) > 0
    const closeLocation = directionalCloseLocation(last, sign) >= 0.55
    const aligned = directionMove && (structure || closeLocation)
    detail[n] = { aligned, close: last.c, structure, closeLocation: round(directionalCloseLocation(last, sign), 2) }
    active.push(aligned)
  }
  return { detail, aligned: active.filter(Boolean).length, active: active.length }
}

function outcome(rows, entryIndex, sign) {
  const entry = rows[entryIndex]?.o
  if (!Number.isFinite(entry)) return null
  const path = rows.slice(entryIndex)
  const mark = path.at(-1)?.c
  const favorable = sign > 0 ? Math.max(...path.map(r => r.h)) : Math.min(...path.map(r => r.l))
  const adverse = sign > 0 ? Math.min(...path.map(r => r.l)) : Math.max(...path.map(r => r.h))
  const path20 = path.slice(0, 20)
  const mark20 = path20.length === 20 ? path20.at(-1).c : NaN
  const favorable20 = path20.length === 20 ? (sign > 0 ? Math.max(...path20.map(r => r.h)) : Math.min(...path20.map(r => r.l))) : NaN
  const adverse20 = path20.length === 20 ? (sign > 0 ? Math.min(...path20.map(r => r.l)) : Math.max(...path20.map(r => r.h))) : NaN
  return {
    entry,
    mark,
    returnPct: sign * pct(mark, entry),
    mfePct: sign > 0 ? pct(favorable, entry) : pct(entry, favorable),
    maePct: sign > 0 ? Math.min(0, pct(adverse, entry)) : Math.min(0, pct(entry, adverse)),
    return20Pct: sign * pct(mark20, entry),
    mfe20Pct: sign > 0 ? pct(favorable20, entry) : pct(entry, favorable20),
    mae20Pct: sign > 0 ? Math.min(0, pct(adverse20, entry)) : Math.min(0, pct(entry, adverse20)),
  }
}

function analyze(target) {
  const { symbol, side } = target, sign = side === "BUY" ? 1 : -1, days = load(symbol)
  const rows = (days.get(DATE) || []).filter(r => minuteAt(r.t) <= CUTOFF_MINUTE)
  if (rows.length < 20) return { symbol, side, error: "insufficient target-session candles" }
  const history = priorLevels(days), sessionOpen = rows[0].o
  const frames = new Map([1, 3, 5, 10, 15].map(n => [n, n === 1 ? rows : aggregate(rows, n)]))
  let cumulativeVolume = 0, cumulativePv = 0
  const vwapAt = []
  for (const r of rows) { cumulativeVolume += r.v; cumulativePv += r.v * (r.h + r.l + r.c) / 3; vwapAt.push(cumulativePv / cumulativeVolume) }
  const opening = new Map([5, 10, 15].map(n => [n, { high: Math.max(...rows.slice(0, n).map(r => r.h)), low: Math.min(...rows.slice(0, n).map(r => r.l)) }]))
  const levels = [
    ...history,
    ...[5, 10, 15].flatMap(n => [{ name: `OR${n}H`, kind: "HIGH", price: opening.get(n).high, activeIndex: n }, { name: `OR${n}L`, kind: "LOW", price: opening.get(n).low, activeIndex: n }]),
  ]
  const broken = new Map(), retests = new Map(), events = []
  for (let i = 1; i < rows.length - 1; i++) {
    const bar = rows[i], previous = rows[i - 1], signalAt = bar.t + MINUTE
    if (timeAt(signalAt) > "10:30") continue
    const mtf = mtfState(frames, signalAt, sign, sessionOpen)
    const vwapAligned = sign * (bar.c - vwapAt[i]) > 0
    const strongClose = directionalCloseLocation(bar, sign) >= 0.6
    for (const level of levels) {
      if (level.activeIndex != null && i < level.activeIndex) continue
      if ((sign > 0 && level.kind !== "HIGH") || (sign < 0 && level.kind !== "LOW")) continue
      const crossed = sign > 0 ? previous.c <= level.price && bar.c > level.price : previous.c >= level.price && bar.c < level.price
      if (crossed && !broken.has(level.name)) {
        broken.set(level.name, i)
        if (mtf.aligned >= 3 && vwapAligned && strongClose) events.push({ family: level.name.startsWith("OR") ? "OPENING_RANGE_BREAK" : "PRIOR_LEVEL_BREAK", level: level.name, levelPrice: level.price, signalIndex: i, mtf, vwapAligned, strongClose })
      }
      const breakIndex = broken.get(level.name)
      if (breakIndex != null && i > breakIndex) {
        const tolerance = level.price * 0.002
        const touched = sign > 0 ? bar.l <= level.price + tolerance && bar.c >= level.price : bar.h >= level.price - tolerance && bar.c <= level.price
        if (touched && !retests.has(level.name)) retests.set(level.name, { index: i, extreme: sign > 0 ? bar.h : bar.l })
        const retest = retests.get(level.name)
        if (retest && i > retest.index) {
          const confirmed = sign > 0 ? bar.c > retest.extreme : bar.c < retest.extreme
          if (confirmed && mtf.aligned >= 3 && vwapAligned && strongClose) {
            events.push({ family: "LEVEL_RETEST", level: level.name, levelPrice: level.price, signalIndex: i, mtf, vwapAligned, strongClose })
            retests.delete(level.name)
          }
        }
      }
    }
  }
  const deduped = [...new Map(events.sort((a, b) => a.signalIndex - b.signalIndex || a.family.localeCompare(b.family)).map(e => [`${e.signalIndex}|${e.family}`, e])).values()]
  const selected = deduped[0] || null
  const serializeEvent = event => {
    if (!event) return null
    const signal = rows[event.signalIndex], result = outcome(rows, event.signalIndex + 1, sign)
    const recent = rows.slice(Math.max(0, event.signalIndex - 9), event.signalIndex + 1)
    const averagePriorVolume = rows.slice(Math.max(0, event.signalIndex - 10), event.signalIndex).reduce((sum, r) => sum + r.v, 0) / Math.min(10, event.signalIndex)
    const travel = recent.slice(1).reduce((sum, r, index) => sum + Math.abs(r.c - recent[index].c), 0)
    return {
      family: event.family, level: event.level, levelPrice: round(event.levelPrice), signalTime: timeAt(signal.t + MINUTE), entryTime: timeAt(rows[event.signalIndex + 1].t), entryPrice: round(result.entry), mtfAligned: event.mtf.aligned,
      tf1: event.mtf.detail[1]?.aligned ?? null, tf3: event.mtf.detail[3]?.aligned ?? null, tf5: event.mtf.detail[5]?.aligned ?? null, tf10: event.mtf.detail[10]?.aligned ?? null, tf15: event.mtf.detail[15]?.aligned ?? null,
      returnToCutoffPct: round(result.returnPct), mfePct: round(result.mfePct), maePct: round(result.maePct),
      return20Pct: round(result.return20Pct), mfe20Pct: round(result.mfe20Pct), mae20Pct: round(result.mae20Pct),
      signalMoveFromOpenPct: round(sign * pct(signal.c, sessionOpen)), breakoutDistancePct: round(sign * pct(signal.c, event.levelPrice)),
      volumeRatio10: round(signal.v / (averagePriorVolume || 1), 2), efficiency10: round(Math.abs(signal.c - recent[0].o) / (travel || Math.abs(signal.c - recent[0].o) || 1), 3),
    }
  }
  return {
    symbol, side, sessionOpen, cutoffClose: rows.at(-1).c, sessionReturnPct: round(sign * pct(rows.at(-1).c, sessionOpen)), cutoff: timeAt(rows.at(-1).t),
    priorLevels: Object.fromEntries(history.map(x => [x.name, round(x.price)])),
    nearestSupport: round(Math.max(...history.filter(x => x.kind === "LOW" && x.price <= sessionOpen).map(x => x.price), -Infinity)),
    nearestResistance: round(Math.min(...history.filter(x => x.kind === "HIGH" && x.price >= sessionOpen).map(x => x.price), Infinity)),
    selected: serializeEvent(selected), events: deduped.map(serializeEvent),
  }
}

const analyses = TARGETS.map(analyze)
const trades = analyses.filter(x => x.selected).map(x => ({ symbol: x.symbol, side: x.side, ...x.selected }))
const returns = trades.map(x => x.returnToCutoffPct), maes = trades.map(x => x.maePct)
const summary = {
    methodology: `Causal ${DATE} replay through the final ${DATE === "2026-10-29" ? "10:52" : "15:29"}-labelled one-minute candle. Prior 1/3/5/7-session levels are frozen before the open. Signals require a completed-candle break or confirmed retest, price above/below session VWAP, directional close location >=60%, and at least 3 aligned completed timeframes among 1/3/5/10/15 minutes. Entry is next 1-minute open. First qualifying event per named mover is selected; no depth data used.`,
  targetCount: TARGETS.length,
  tradeCount: trades.length,
  longSignals: trades.filter(x => x.side === "BUY").length,
  shortSignals: trades.filter(x => x.side === "SELL").length,
  winRatePct: round(100 * trades.filter(x => x.returnToCutoffPct > 0).length / (trades.length || 1), 2),
  averageReturnPct: round(returns.reduce((a, b) => a + b, 0) / (returns.length || 1)),
  totalReturnPct: round(returns.reduce((a, b) => a + b, 0)),
  averageMaePct: round(maes.reduce((a, b) => a + b, 0) / (maes.length || 1)),
  maximumAdverseExcursionPct: maes.length ? round(Math.min(...maes)) : null,
  worstDay: trades.length ? { date: DATE, totalReturnPct: round(returns.reduce((a, b) => a + b, 0)) } : null,
}
const stem = `${DATE}-top-movers-support-resistance-price-action-mtf`
const json = unique(stem, "json"), csv = unique(`${stem}-signals`, "csv"), md = unique(stem, "md")
fs.writeFileSync(json, `${JSON.stringify({ summary, analyses }, null, 2)}\n`, { flag: "wx" })
const fields = ["symbol", "side", "family", "level", "levelPrice", "signalTime", "entryTime", "entryPrice", "mtfAligned", "tf1", "tf3", "tf5", "tf10", "tf15", "signalMoveFromOpenPct", "breakoutDistancePct", "volumeRatio10", "efficiency10", "return20Pct", "mfe20Pct", "mae20Pct", "returnToCutoffPct", "mfePct", "maePct"]
fs.writeFileSync(csv, `${[fields.join(","), ...trades.map(row => fields.map(field => csvValue(row[field])).join(","))].join("\n")}\n`, { flag: "wx" })
const cutoffLabel = DATE === "2026-10-29" ? "10:52" : "15:29"
const tradeTable = [`| Symbol | Side | Setup | Level | Signal | Entry | MTF | Return to ${cutoffLabel} | MFE | MAE |`, "|---|---|---|---:|---:|---:|---:|---:|---:|---:|", ...trades.map(x => `| ${x.symbol} | ${x.side} | ${x.family}:${x.level} | ${x.levelPrice} | ${x.signalTime} | ${x.entryTime} @ ${x.entryPrice} | ${x.mtfAligned}/5 | ${x.returnToCutoffPct}% | ${x.mfePct}% | ${x.maePct}% |`)].join("\n")
const missed = analyses.filter(x => !x.selected).map(x => `${x.symbol} (${x.side})`).join(", ") || "None"
const report = [`# ${DATE} mover support/resistance and MTF replay`, "", summary.methodology, "", `- Signals: ${summary.tradeCount}/${summary.targetCount} (${summary.longSignals} long, ${summary.shortSignals} short)`, `- Win rate to ${cutoffLabel} mark: ${summary.winRatePct}%`, `- Average / total return: ${summary.averageReturnPct}% / ${summary.totalReturnPct}%`, `- Average / worst MAE: ${summary.averageMaePct}% / ${summary.maximumAdverseExcursionPct}%`, `- No qualifying signal: ${missed}`, "", "## First qualifying signal per mover", "", tradeTable, "", "## Files", "", `- JSON diagnostics: ${json}`, `- Signal CSV: ${csv}`, "", "Caution: this is a retrospective, single-session analysis of stocks selected because they became the day's top movers. It is hypothesis generation, not out-of-sample validation."].join("\n")
fs.writeFileSync(md, `${report}\n`, { flag: "wx" })
console.log(JSON.stringify({ summary, missed, json, csv, md, trades }, null, 2))

if (process.argv.includes("--universe")) {
  const targetDirections = new Map(TARGETS.map(x => [x.symbol, x.side]))
  const symbols = JSON.parse(fs.readFileSync(path.join(ROOT, "db", "stocks"), "utf8"))
  const universeTrades = []
  for (const symbol of symbols) {
    const candidates = [analyze({ symbol, side: "BUY" }), analyze({ symbol, side: "SELL" })]
      .filter(x => x.selected)
      .sort((a, b) => a.selected.signalTime.localeCompare(b.selected.signalTime) || b.selected.mtfAligned - a.selected.mtfAligned)
    const first = candidates[0]
    if (!first) continue
    universeTrades.push({ symbol, side: first.side, targetSide: targetDirections.get(symbol) || "", correctTargetDirection: targetDirections.get(symbol) === first.side, ...first.selected })
  }
  const universeReturns = universeTrades.map(x => x.returnToCutoffPct)
  const universeMaes = universeTrades.map(x => x.maePct)
  const correctTargets = universeTrades.filter(x => x.correctTargetDirection)
  const universeSummary = {
    date: DATE,
    universeSymbols: symbols.length,
    oneFirstSignalPerSymbol: universeTrades.length,
    winRatePct: round(100 * universeTrades.filter(x => x.returnToCutoffPct > 0).length / (universeTrades.length || 1), 2),
    averageReturnPct: round(universeReturns.reduce((a, b) => a + b, 0) / (universeReturns.length || 1)),
    totalReturnPct: round(universeReturns.reduce((a, b) => a + b, 0)),
    maximumAdverseExcursionPct: universeMaes.length ? round(Math.min(...universeMaes)) : null,
    namedMoverCorrectDirection: correctTargets.length,
    namedMoverTotal: TARGETS.length,
    correctLongMovers: correctTargets.filter(x => x.side === "BUY").length,
    correctShortMovers: correctTargets.filter(x => x.side === "SELL").length,
    oppositeOrMissingNamedMovers: TARGETS.filter(target => !correctTargets.some(x => x.symbol === target.symbol && x.side === target.side)).map(x => `${x.symbol}:${x.side}`),
  }
  const universeJson = unique(`${stem}-universe-first-signal`, "json")
  const universeCsv = unique(`${stem}-universe-first-signal`, "csv")
  fs.writeFileSync(universeJson, `${JSON.stringify({ methodology: summary.methodology, summary: universeSummary, trades: universeTrades }, null, 2)}\n`, { flag: "wx" })
  const universeFields = ["symbol", "side", "targetSide", "correctTargetDirection", ...fields.slice(2)]
  fs.writeFileSync(universeCsv, `${[universeFields.join(","), ...universeTrades.map(row => universeFields.map(field => csvValue(row[field])).join(","))].join("\n")}\n`, { flag: "wx" })
  console.log(JSON.stringify({ universeSummary, universeJson, universeCsv }, null, 2))
}
