#!/usr/bin/env node
import fs from "node:fs"
import path from "node:path"
import readline from "node:readline"

const ROOT = process.cwd()
const IST_MS = 330 * 60_000
const OPEN_MINUTE = 9 * 60 + 15

const arg = name => {
  const i = process.argv.indexOf(name)
  return i < 0 ? null : process.argv[i + 1]
}
const has = name => process.argv.includes(name)
const usage = 'Usage: node scripts/scan-strongest-opening-vs-prior-sessions.js --datetime "YYYY-MM-DD HH:mm" [--lookback 10] [--side BOTH|BUY|SELL] [--top N] [--min-move 0.25] [--with-depth] [--require-volume-record] [--require-depth-record]'
const fail = message => { throw new Error(`${message}\n\n${usage}`) }
const round = (value, digits = 4) => Number.isFinite(value) ? +value.toFixed(digits) : null
const pct = (end, start) => start > 0 ? 100 * (end / start - 1) : NaN
const toMinute = hhmm => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5))
const minuteText = minute => `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`
const localStamp = epochSeconds => new Date(epochSeconds * 1000 + IST_MS).toISOString().slice(0, 16).replace("T", " ")
const csvCell = value => {
  if (value == null) return ""
  const text = typeof value === "object" ? JSON.stringify(value) : String(value)
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
}
const uniquePath = (dir, stem, extension) => {
  let suffix = 1, file
  do {
    file = path.join(ROOT, dir, `${stem}${suffix === 1 ? "" : `-${suffix}`}.${extension}`)
    suffix++
  } while (fs.existsSync(file))
  return file
}

const datetimeIndex = process.argv.indexOf("--datetime")
if (has("--help")) {
  console.log(`${usage}\n\nThe cutoff is exclusive: 09:30 uses completed candles labelled 09:15 through 09:29. With no --top, every qualifying stock is returned.`)
  process.exit(0)
}
let rawDatetime = datetimeIndex < 0 ? null : process.argv[datetimeIndex + 1]
// Accept both --datetime "2026-10-28 09:30" and --datetime 2026-10-28 09:30.
if (/^\d{4}-\d{2}-\d{2}$/.test(rawDatetime ?? "") && /^\d{2}:\d{2}$/.test(process.argv[datetimeIndex + 2] ?? "")) {
  rawDatetime += ` ${process.argv[datetimeIndex + 2]}`
}
if (!rawDatetime || !/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}$/.test(rawDatetime)) fail("--datetime must be quoted and formatted as YYYY-MM-DD HH:mm")
const [targetDate, cutoffText] = rawDatetime.replace("T", " ").split(" ")
const cutoffMinute = toMinute(cutoffText)
const lookback = Number(arg("--lookback") ?? 10)
const topArg = arg("--top")
const top = topArg == null ? null : Number(topArg)
const minMovePct = Number(arg("--min-move") ?? 0.25)
const side = String(arg("--side") ?? "BOTH").toUpperCase()
const withDepth = has("--with-depth") || has("--require-depth-record")
const requireVolumeRecord = has("--require-volume-record")
const requireDepthRecord = has("--require-depth-record")
if (cutoffMinute <= OPEN_MINUTE || cutoffMinute > 15 * 60 + 30) fail("Cutoff must be later than 09:15 and no later than 15:30 IST")
if (!Number.isInteger(lookback) || lookback < 1) fail("--lookback must be a positive integer")
if (top != null && (!Number.isInteger(top) || top < 1)) fail("--top must be a positive integer")
if (!Number.isFinite(minMovePct) || minMovePct < 0) fail("--min-move must be zero or greater")
if (!new Set(["BOTH", "BUY", "SELL"]).has(side)) fail("--side must be BOTH, BUY, or SELL")

function stockSymbols() {
  const stockFile = path.join(ROOT, "db", "stocks")
  if (fs.existsSync(stockFile)) {
    try {
      return [...new Set(JSON.parse(fs.readFileSync(stockFile, "utf8")).map(x => String(x).trim().toUpperCase().replace(/-EQ$/, "")))].sort()
    } catch {}
  }
  return fs.readdirSync(path.join(ROOT, "db", "candles"))
    .filter(x => x.endsWith(".jsonl") && x !== "NIFTY50.jsonl")
    .map(x => x.slice(0, -6)).sort()
}

function readWindows(symbol) {
  const file = path.join(ROOT, "db", "candles", `${symbol}.jsonl`)
  if (!fs.existsSync(file)) return new Map()
  const byStamp = new Map()
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    if (!line.trim()) continue
    let raw
    try { raw = JSON.parse(line) } catch { continue }
    const time = +raw.time
    const open = +raw.open, high = +raw.high, low = +raw.low, close = +raw.close, volume = +raw.volume
    if (![time, open, high, low, close, volume].every(Number.isFinite) || open <= 0 || high <= 0 || low <= 0 || close <= 0 || volume < 0) continue
    const stamp = localStamp(time), date = stamp.slice(0, 10), minute = toMinute(stamp.slice(11))
    if (date > targetDate || minute < OPEN_MINUTE || minute >= cutoffMinute) continue
    // Last occurrence wins when a provider duplicated/replaced the same candle.
    byStamp.set(stamp, { date, minute, open, high, low, close, volume })
  }
  const byDate = new Map()
  for (const row of byStamp.values()) {
    if (!byDate.has(row.date)) byDate.set(row.date, [])
    byDate.get(row.date).push(row)
  }
  const windows = new Map()
  for (const [date, rows] of byDate) {
    rows.sort((a, b) => a.minute - b.minute)
    const first = rows[0], last = rows.at(-1)
    if (!first || first.minute > OPEN_MINUTE + 1) continue
    const open = first.open, close = last.close
    windows.set(date, {
      open, close,
      high: Math.max(...rows.map(x => x.high)),
      low: Math.min(...rows.map(x => x.low)),
      volume: rows.reduce((sum, x) => sum + x.volume, 0),
      movePct: pct(close, open),
      highExcursionPct: pct(Math.max(...rows.map(x => x.high)), open),
      lowExcursionPct: pct(Math.min(...rows.map(x => x.low)), open),
      candleCount: rows.length,
      firstCandle: minuteText(first.minute),
      lastCandle: minuteText(last.minute),
    })
  }
  return windows
}

function evaluate(symbol, niftyWindows) {
  const windows = readWindows(symbol)
  const target = windows.get(targetDate)
  if (!target) return null
  const priorDates = [...windows.keys()].filter(date => date < targetDate).sort().slice(-lookback)
  if (priorDates.length !== lookback) return null
  const prior = priorDates.map(date => windows.get(date))
  const direction = target.movePct >= 0 ? "BUY" : "SELL"
  if (side !== "BOTH" && direction !== side) return null
  const signedPriorExtreme = direction === "BUY"
    ? Math.max(...prior.map(x => x.movePct))
    : Math.min(...prior.map(x => x.movePct))
  const priorMaxAbsMove = Math.max(...prior.map(x => Math.abs(x.movePct)))
  const priorMaxVolume = Math.max(...prior.map(x => x.volume))
  const priorMeanVolume = prior.reduce((sum, x) => sum + x.volume, 0) / prior.length
  const directionalMoveRecord = direction === "BUY" ? target.movePct > signedPriorExtreme : target.movePct < signedPriorExtreme
  const absoluteMoveRecord = Math.abs(target.movePct) > priorMaxAbsMove
  const volumeRecord = target.volume > priorMaxVolume
  const nifty = niftyWindows.get(targetDate)
  const relativeToNiftyPct = nifty ? target.movePct - nifty.movePct : NaN
  const moveVsPriorDirectionalExtreme = Math.abs(signedPriorExtreme) > 0 ? Math.abs(target.movePct) / Math.abs(signedPriorExtreme) : Infinity
  const volumeVsPriorMax = priorMaxVolume > 0 ? target.volume / priorMaxVolume : Infinity
  const volumeVsPriorMean = priorMeanVolume > 0 ? target.volume / priorMeanVolume : Infinity
  const strengthScore = Math.sqrt(Math.max(0, moveVsPriorDirectionalExtreme) * Math.max(0, volumeVsPriorMax))
  return {
    symbol, direction, priorDates, target,
    relativeToNiftyPct: round(relativeToNiftyPct),
    directionalMoveRecord, absoluteMoveRecord, volumeRecord,
    priorDirectionalExtremePct: round(signedPriorExtreme),
    priorMaxAbsMovePct: round(priorMaxAbsMove),
    priorMaxVolume, priorMeanVolume: round(priorMeanVolume, 0),
    moveVsPriorDirectionalExtreme: round(moveVsPriorDirectionalExtreme, 3),
    volumeVsPriorMax: round(volumeVsPriorMax, 3),
    volumeVsPriorMean: round(volumeVsPriorMean, 3),
    strengthScore: round(strengthScore, 3),
  }
}

async function depthWindow(symbol, date) {
  const file = path.join(ROOT, "db", "cash-depth", date, symbol, `${symbol}.jsonl`)
  if (!fs.existsSync(file)) return { available: false, reason: "missing file" }
  const startMs = Date.parse(`${date}T09:15:00+05:30`)
  const endMs = Date.parse(`${date}T${cutoffText}:00+05:30`)
  const state = {}, samples = []
  let previous = null
  const input = fs.createReadStream(file, { encoding: "utf8" })
  const lines = readline.createInterface({ input, crlfDelay: Infinity })
  try {
    for await (const line of lines) {
      let event
      try { event = JSON.parse(line) } catch { continue }
      const at = Date.parse(event.receivedAt)
      if (!Number.isFinite(at)) continue
      if (at >= endMs) break
      if (event.kind === "checkpoint" || event.book) {
        for (const key of Object.keys(state)) delete state[key]
        Object.assign(state, event.data)
      } else if (event.kind === "update") Object.assign(state, event.data)
      else continue
      if (at < startMs) continue
      const bp = +state.bid_price1, ap = +state.ask_price1, bs = +state.bid_size1, as = +state.ask_size1
      if (![bp, ap, bs, as].every(Number.isFinite) || bp <= 0 || ap <= bp || bs < 0 || as < 0) continue
      let bidSize = 0, askSize = 0
      for (let level = 1; level <= 5; level++) {
        bidSize += Number(state[`bid_size${level}`]) || 0
        askSize += Number(state[`ask_size${level}`]) || 0
      }
      let ofi = 0
      if (previous) {
        const bidFlow = bp > previous.bp ? bs : bp === previous.bp ? bs - previous.bs : -previous.bs
        const askFlow = ap < previous.ap ? as : ap === previous.ap ? as - previous.as : -previous.as
        ofi = (bidFlow - askFlow) / ((bs + as + previous.bs + previous.as) / 2 || 1)
      }
      samples.push({ at, mid: (bp + ap) / 2, imbalance: (bidSize - askSize) / (bidSize + askSize || 1), ofi })
      previous = { bp, ap, bs, as }
    }
  } finally {
    lines.close()
    input.destroy()
  }
  if (samples.length < 2) return { available: false, reason: "fewer than two snapshots" }
  return {
    available: true,
    snapshots: samples.length,
    firstSnapshot: new Date(samples[0].at + IST_MS).toISOString().slice(11, 19),
    lastSnapshot: new Date(samples.at(-1).at + IST_MS).toISOString().slice(11, 19),
    midpointMovePct: round(pct(samples.at(-1).mid, samples[0].mid)),
    meanImbalancePct: round(100 * samples.reduce((sum, x) => sum + x.imbalance, 0) / samples.length),
    cumulativeOfi: round(samples.reduce((sum, x) => sum + x.ofi, 0)),
  }
}

async function attachDepth(row) {
  const sessions = []
  for (const date of [...row.priorDates, targetDate]) sessions.push({ date, ...(await depthWindow(row.symbol, date)) })
  const target = sessions.at(-1)
  const prior = sessions.slice(0, -1).filter(x => x.available)
  if (!target.available || !prior.length) return { ...row, depth: { target, comparablePriorSessions: prior.length, sessions, flowRecord: false } }
  const field = "cumulativeOfi"
  const flowRecord = row.direction === "BUY"
    ? target[field] > Math.max(...prior.map(x => x[field]))
    : target[field] < Math.min(...prior.map(x => x[field]))
  const midpointRecord = row.direction === "BUY"
    ? target.midpointMovePct > Math.max(...prior.map(x => x.midpointMovePct))
    : target.midpointMovePct < Math.min(...prior.map(x => x.midpointMovePct))
  return { ...row, depth: { target, comparablePriorSessions: prior.length, flowRecord, midpointRecord, sessions } }
}

console.log(`Scanning opening windows through ${targetDate} ${cutoffText} IST (${minuteText(OPEN_MINUTE)}-${minuteText(cutoffMinute - 1)} completed candles)...`)
const symbols = stockSymbols()
const niftyWindows = readWindows("NIFTY50")
let all = symbols.map(symbol => evaluate(symbol, niftyWindows)).filter(Boolean)
const comparableStocks = all.length
all = all.filter(row => row.directionalMoveRecord && Math.abs(row.target.movePct) >= minMovePct)
if (requireVolumeRecord) all = all.filter(row => row.volumeRecord)
all.sort((a, b) => b.strengthScore - a.strengthScore || Math.abs(b.target.movePct) - Math.abs(a.target.movePct) || a.symbol.localeCompare(b.symbol))

if (withDepth) {
  const enriched = []
  for (let i = 0; i < all.length; i++) {
    console.log(`Depth ${i + 1}/${all.length}: ${all[i].symbol}`)
    enriched.push(await attachDepth(all[i]))
  }
  all = requireDepthRecord ? enriched.filter(row => row.depth.flowRecord || row.depth.midpointRecord) : enriched
}

const hits = top == null ? all : all.slice(0, top)
const stem = `${targetDate}-${cutoffText.replace(":", "")}-strongest-opening-vs-prior${lookback}`
const jsonFile = uniquePath("reports", stem, "json")
const csvFile = uniquePath("csv", stem, "csv")
const method = `Uses completed one-minute candles from 09:15 through ${minuteText(cutoffMinute - 1)} IST. Each stock is compared with its own ${lookback} prior available sessions at the same cutoff. A BUY must exceed every prior signed return; a SELL must be below every prior signed return; it must also meet --min-move. The stricter absolute-move record, volume record, and depth records are separate evidence fields unless their require flags are supplied.`
const output = {
  generatedAt: new Date().toISOString(), datetime: `${targetDate} ${cutoffText}`, timezone: "Asia/Kolkata",
  candleWindow: `09:15-${minuteText(cutoffMinute - 1)}`, lookback, side, top, minMovePct,
  requireVolumeRecord, withDepth, requireDepthRecord, symbolUniverse: symbols.length, comparableStocks,
  method, hitCountBeforeTop: all.length, hits,
}
fs.mkdirSync(path.dirname(jsonFile), { recursive: true })
fs.mkdirSync(path.dirname(csvFile), { recursive: true })
fs.writeFileSync(jsonFile, `${JSON.stringify(output, null, 2)}\n`, { flag: "wx" })
const headers = ["rank", "symbol", "direction", "movePct", "relativeToNiftyPct", "volume", "directionalMoveRecord", "absoluteMoveRecord", "volumeRecord", "moveVsPriorDirectionalExtreme", "volumeVsPriorMax", "volumeVsPriorMean", "strengthScore", "firstCandle", "lastCandle", "priorDates", "depthComparablePrior", "depthMidpointMovePct", "depthCumulativeOfi", "depthMidpointRecord", "depthFlowRecord"]
const csvRows = hits.map((row, index) => [index + 1, row.symbol, row.direction, round(row.target.movePct), row.relativeToNiftyPct, row.target.volume, row.directionalMoveRecord, row.absoluteMoveRecord, row.volumeRecord, row.moveVsPriorDirectionalExtreme, row.volumeVsPriorMax, row.volumeVsPriorMean, row.strengthScore, row.target.firstCandle, row.target.lastCandle, row.priorDates.join("|"), row.depth?.comparablePriorSessions, row.depth?.target?.midpointMovePct, row.depth?.target?.cumulativeOfi, row.depth?.midpointRecord, row.depth?.flowRecord])
fs.writeFileSync(csvFile, `${headers.join(",")}\n${csvRows.map(row => row.map(csvCell).join(",")).join("\n")}\n`, { flag: "wx" })

console.log(`Comparable stocks: ${comparableStocks}; qualifying before --top: ${all.length}; returned: ${hits.length}`)
for (const [index, row] of hits.entries()) {
  const depth = row.depth ? ` depthOFI=${row.depth.target.cumulativeOfi ?? "n/a"} depthRecord=${row.depth.flowRecord || row.depth.midpointRecord}` : ""
  console.log(`${index + 1}. ${row.symbol} ${row.direction} move=${round(row.target.movePct)}% volume=${row.target.volume} directionalMoveX=${row.moveVsPriorDirectionalExtreme} absoluteRecord=${row.absoluteMoveRecord} volumeX=${row.volumeVsPriorMax} volumeRecord=${row.volumeRecord}${depth}`)
}
console.log(`Saved ${jsonFile}`)
console.log(`Saved ${csvFile}`)
