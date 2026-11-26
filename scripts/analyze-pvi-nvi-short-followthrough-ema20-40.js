#!/usr/bin/env node
import fs from "node:fs"
import path from "node:path"

const ROOT = process.cwd()
const IST_MS = 330 * 60_000
const SIGNAL_MINUTE = 9 * 60 + 16
const CLEAN_MAE_LIMIT_PCT = Number(process.argv[2] ?? 0.5)
const TARGET_PCT = Number(process.argv[3] ?? 2)
if (!Number.isFinite(CLEAN_MAE_LIMIT_PCT) || CLEAN_MAE_LIMIT_PCT < 0 || !Number.isFinite(TARGET_PCT) || TARGET_PCT <= 0) {
  throw new Error("Usage: node scripts/analyze-pvi-nvi-short-followthrough-ema20-40.js [clean-mae-limit-pct=0.5] [target-pct=2]")
}

const SIGNALS = {
  "2026-10-26": ["AUBANK", "SHRIRAMFIN", "BANKINDIA", "INFY", "CHOLAFIN", "ABCAPITAL", "MOTILALOFS", "BANDHANBNK", "PNB", "ADANIPOWER"],
  "2026-10-27": ["DALBHARAT", "RECLTD", "WIPRO", "KPITTECH", "CYIENT", "TATAELXSI", "SHREECEM", "ICICIGI", "BPCL", "INDUSINDBK"],
  "2026-10-28": ["PAGEIND", "WAAREEENER", "MAZDOCK", "SAIL", "PATANJALI", "DIVISLAB", "KALYANKJIL", "IRCTC", "CDSL", "ALKEM"],
  "2026-10-29": ["TITAGARH", "TRENT", "TIINDIA", "BOSCHLTD", "KPITTECH", "NATIONALUM", "MCX", "BAJAJHLDNG", "BHARATFORG", "PERSISTENT"],
  "2026-10-30": ["GODREJCP", "BLUESTARCO", "CAMS", "SUZLON", "COALINDIA", "WAAREEENER", "DALBHARAT", "RECLTD", "INOXWIND", "GMRAIRPORT"],
}

const round = (value, digits = 4) => Number.isFinite(value) ? +value.toFixed(digits) : null
const stamp = seconds => new Date(seconds * 1000 + IST_MS).toISOString().slice(0, 16).replace("T", " ")
const minuteOf = text => Number(text.slice(11, 13)) * 60 + Number(text.slice(14, 16))
const unique = (directory, stem, extension) => {
  let suffix = 1, file
  do {
    file = path.join(ROOT, directory, `${stem}${suffix === 1 ? "" : `-${suffix}`}.${extension}`)
    suffix++
  } while (fs.existsSync(file))
  return file
}
const csvCell = value => {
  if (value == null) return ""
  const text = String(value)
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
}

function candles(symbol) {
  const file = path.join(ROOT, "db", "candles", `${symbol}.jsonl`)
  if (!fs.existsSync(file)) return []
  const seen = new Map()
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    if (!line.trim()) continue
    let raw
    try { raw = JSON.parse(line) } catch { continue }
    const row = { time: +raw.time, open: +raw.open, high: +raw.high, low: +raw.low, close: +raw.close, volume: +raw.volume }
    if (!Object.values(row).every(Number.isFinite) || row.open <= 0 || row.high <= 0 || row.low <= 0 || row.close <= 0) continue
    row.stamp = stamp(row.time)
    row.date = row.stamp.slice(0, 10)
    row.minute = minuteOf(row.stamp)
    if (row.minute < 9 * 60 + 15 || row.minute >= 15 * 60 + 30) continue
    seen.set(row.stamp, row)
  }
  return [...seen.values()].sort((left, right) => left.time - right.time)
}

function withEma(rows) {
  const alpha20 = 2 / 21, alpha40 = 2 / 41
  let ema20 = rows[0]?.close, ema40 = rows[0]?.close
  return rows.map((row, index) => {
    if (index) {
      ema20 += alpha20 * (row.close - ema20)
      ema40 += alpha40 * (row.close - ema40)
    }
    return { ...row, ema20, ema40 }
  })
}

function analyze(date, symbol) {
  const all = withEma(candles(symbol))
  const signalIndex = all.findIndex(row => row.date === date && row.minute === SIGNAL_MINUTE)
  if (signalIndex < 0) return { date, symbol, error: "missing 09:16 candle" }
  const entryIndex = all.findIndex((row, index) => index > signalIndex && row.date === date)
  if (entryIndex < 0) return { date, symbol, error: "missing next candle for entry" }
  const entry = all[entryIndex]
  let crossIndex = -1
  for (let index = entryIndex; index < all.length && all[index].date === date; index++) {
    const previous = all[index - 1], current = all[index]
    if (previous.ema20 <= previous.ema40 && current.ema20 > current.ema40) {
      crossIndex = index
      break
    }
  }
  const dayLastIndex = all.findLastIndex(row => row.date === date)
  const measurementEndIndex = crossIndex >= 0 ? crossIndex : dayLastIndex
  const path = all.slice(entryIndex, measurementEndIndex + 1)
  if (!path.length) return { date, symbol, error: "no post-entry path" }
  const lowest = path.reduce((best, row) => row.low < best.low ? row : best, path[0])
  const highest = path.reduce((best, row) => row.high > best.high ? row : best, path[0])
  const targetPrice = entry.open * (1 - TARGET_PCT / 100)
  const targetOffset = path.findIndex(row => row.low <= targetPrice)
  const targetHit = targetOffset >= 0
  const preTarget = targetHit ? path.slice(0, targetOffset + 1) : path
  const preTargetHighest = preTarget.reduce((best, row) => row.high > best.high ? row : best, preTarget[0])
  const favorableExcursionPct = 100 * (entry.open - lowest.low) / entry.open
  const adverseExcursionPct = 100 * (highest.high - entry.open) / entry.open
  const adverseBeforeTargetPct = 100 * (preTargetHighest.high - entry.open) / entry.open
  const cross = crossIndex >= 0 ? all[crossIndex] : null
  const nextAfterCross = crossIndex >= 0 && all[crossIndex + 1]?.date === date ? all[crossIndex + 1] : null
  const exitPrice = nextAfterCross?.open ?? all[dayLastIndex].close
  const exitTime = nextAfterCross?.stamp ?? all[dayLastIndex].stamp
  const returnPct = 100 * (entry.open - exitPrice) / entry.open
  return {
    date, symbol, signalTime: all[signalIndex].stamp, entryTime: entry.stamp, entryPrice: entry.open,
    ema20AtSignal: round(all[signalIndex].ema20), ema40AtSignal: round(all[signalIndex].ema40),
    crossoverTime: cross?.stamp ?? null, exitTime, exitPrice,
    exitReason: cross ? "EMA20 crossed above EMA40" : "No bullish cross; EOD",
    favorableExcursionPct: round(favorableExcursionPct), lowestPrice: lowest.low, lowestTime: lowest.stamp,
    adverseExcursionPct: round(adverseExcursionPct), adverseBeforeTargetPct: round(adverseBeforeTargetPct),
    targetHit, targetTime: targetHit ? path[targetOffset].stamp : null,
    straightDown: targetHit && adverseBeforeTargetPct <= CLEAN_MAE_LIMIT_PCT,
    returnPct: round(returnPct),
  }
}

const rows = Object.entries(SIGNALS).flatMap(([date, symbols]) => symbols.map(symbol => analyze(date, symbol)))
const valid = rows.filter(row => !row.error)
const hits = valid.filter(row => row.targetHit).sort((left, right) => right.favorableExcursionPct - left.favorableExcursionPct || left.entryTime.localeCompare(right.entryTime))
const cleanHits = hits.filter(row => row.straightDown)
const sum = values => values.reduce((total, value) => total + value, 0)
const perDay = Object.keys(SIGNALS).map(date => {
  const day = valid.filter(row => row.date === date)
  return {
    date, trades: day.length, targetHits: day.filter(row => row.targetHit).length,
    cleanHits: day.filter(row => row.straightDown).length,
    averageReturnPct: round(sum(day.map(row => row.returnPct)) / day.length),
    totalReturnPct: round(sum(day.map(row => row.returnPct))),
  }
})
const summary = {
  candidateCount: rows.length, validTradeCount: valid.length,
  targetHitCount: hits.length, targetHitRatePct: round(100 * hits.length / valid.length),
  cleanStraightDownCount: cleanHits.length, cleanStraightDownRatePct: round(100 * cleanHits.length / valid.length),
  profitableExitCount: valid.filter(row => row.returnPct > 0).length,
  winRatePct: round(100 * valid.filter(row => row.returnPct > 0).length / valid.length),
  averageReturnPct: round(sum(valid.map(row => row.returnPct)) / valid.length),
  totalReturnPct: round(sum(valid.map(row => row.returnPct))),
  maximumAdverseExcursionPct: round(Math.max(...valid.map(row => row.adverseExcursionPct))),
  worstDay: [...perDay].sort((left, right) => left.totalReturnPct - right.totalReturnPct)[0],
}

const result = {
  generatedAt: new Date().toISOString(), signal: "Both PVI and NVI declined at completed 09:16 candle",
  execution: "SELL at 09:17 open. Measure through first completed EMA20-above-EMA40 crossover; exit at the next candle open, otherwise EOD close.",
  straightDownDefinition: `Reached at least ${TARGET_PCT}% below entry before the bullish EMA20/EMA40 crossover, with no more than ${CLEAN_MAE_LIMIT_PCT}% high-side adverse excursion through the target candle. One-minute OHLC cannot determine intrabar high/low order.`,
  emaMethod: "Continuous one-minute close EMA, recursively seeded at the first available candle; no future candle used for signal or entry.",
  summary, perDay, hits, cleanHits, allTrades: rows,
}

const stem = "2026-10-26-to-2026-10-30-pvi-nvi-both-down-ema20-40-followthrough"
const jsonFile = unique("reports", stem, "json")
const csvFile = unique("csv", stem, "csv")
const mdFile = unique("reports", stem, "md")
fs.mkdirSync(path.dirname(csvFile), { recursive: true })
const headers = ["date", "symbol", "entryTime", "entryPrice", "targetHit", "targetTime", "straightDown", "favorableExcursionPct", "adverseBeforeTargetPct", "adverseExcursionPct", "crossoverTime", "exitTime", "exitPrice", "exitReason", "returnPct"]
fs.writeFileSync(csvFile, `${headers.join(",")}\n${valid.map(row => headers.map(key => csvCell(row[key])).join(",")).join("\n")}\n`, { flag: "wx" })
fs.writeFileSync(jsonFile, `${JSON.stringify(result, null, 2)}\n`, { flag: "wx" })
const table = [
  "| Date | Stock | Entry | Max down | Max bounce before 2% | 2% time | EMA20>40 cross | Straight |",
  "|---|---|---:|---:|---:|---|---|---|",
  ...hits.map(row => `| ${row.date} | ${row.symbol} | ${row.entryPrice} | ${row.favorableExcursionPct}% | ${row.adverseBeforeTargetPct}% | ${row.targetTime?.slice(11)} | ${row.crossoverTime?.slice(11) ?? "none"} | ${row.straightDown ? "YES" : "NO"} |`),
].join("\n")
const report = [
  "# Both-PVI/NVI-down follow-through to EMA20/EMA40 bullish cross", "",
  "## Conclusion", "",
  `- Candidates: ${summary.validTradeCount}; exceeded ${TARGET_PCT}% down: ${summary.targetHitCount} (${summary.targetHitRatePct}%).`,
  `- Straight-down hits with pre-target MAE <= ${CLEAN_MAE_LIMIT_PCT}%: ${summary.cleanStraightDownCount} (${summary.cleanStraightDownRatePct}%).`,
  `- EMA-cross/EOD exit: win rate ${summary.winRatePct}%, average ${summary.averageReturnPct}%, total ${summary.totalReturnPct}%.`,
  `- Maximum adverse excursion: ${summary.maximumAdverseExcursionPct}%; worst day: ${summary.worstDay.date} (${summary.worstDay.totalReturnPct}%).`,
  "", "## Stocks exceeding 2% down before exit", "", table, "",
  `Method: ${result.execution}`, "", `Straight definition: ${result.straightDownDefinition}`, "",
  `JSON: ${jsonFile}`, "", `CSV: ${csvFile}`,
].join("\n")
fs.writeFileSync(mdFile, `${report}\n`, { flag: "wx" })

console.log(JSON.stringify({ jsonFile, csvFile, mdFile, summary, perDay, hits: hits.map(row => ({ date: row.date, symbol: row.symbol, maxDownPct: row.favorableExcursionPct, adverseBeforeTargetPct: row.adverseBeforeTargetPct, targetTime: row.targetTime, crossoverTime: row.crossoverTime, straightDown: row.straightDown })) }, null, 2))
