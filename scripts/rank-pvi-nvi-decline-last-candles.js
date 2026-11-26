#!/usr/bin/env node
import fs from "node:fs"
import path from "node:path"

const ROOT = process.cwd()
const IST_OFFSET_MS = 330 * 60_000
const MARKET_OPEN = 9 * 60 + 15
const MARKET_CLOSE = 15 * 60 + 30

const arg = name => {
  const index = process.argv.indexOf(name)
  return index < 0 ? null : process.argv[index + 1]
}
const usage = 'Usage: node scripts/rank-pvi-nvi-decline-last-candles.js --datetime "YYYY-MM-DD HH:mm" [--candles 3] [--top 10]'
const fail = message => { throw new Error(`${message}\n\n${usage}`) }
const round = (value, digits = 4) => Number.isFinite(value) ? +value.toFixed(digits) : null
const minuteOfText = text => Number(text.slice(0, 2)) * 60 + Number(text.slice(3, 5))
const istStamp = epochSeconds => new Date(epochSeconds * 1000 + IST_OFFSET_MS).toISOString().slice(0, 16).replace("T", " ")
const csvCell = value => {
  if (value == null) return ""
  const text = typeof value === "object" ? JSON.stringify(value) : String(value)
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
}
const uniquePath = (directory, stem, extension) => {
  let suffix = 1, file
  do {
    file = path.join(ROOT, directory, `${stem}${suffix === 1 ? "" : `-${suffix}`}.${extension}`)
    suffix++
  } while (fs.existsSync(file))
  return file
}

if (process.argv.includes("--help")) {
  console.log(`${usage}\n\nThe candle named in --datetime is included and must exist. PVI/NVI start at 1000 on the first of the selected genuine-volume candles.`)
  process.exit(0)
}

const datetimeIndex = process.argv.indexOf("--datetime")
let datetime = datetimeIndex < 0 ? null : process.argv[datetimeIndex + 1]
// Support quoted and unquoted forms.
if (/^\d{4}-\d{2}-\d{2}$/.test(datetime ?? "") && /^\d{2}:\d{2}$/.test(process.argv[datetimeIndex + 2] ?? "")) {
  datetime += ` ${process.argv[datetimeIndex + 2]}`
}
if (!datetime || !/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}$/.test(datetime)) fail("--datetime must use YYYY-MM-DD HH:mm")
datetime = datetime.replace("T", " ")
const targetDate = datetime.slice(0, 10)
const targetClock = datetime.slice(11)
const targetMinute = minuteOfText(targetClock)
const candleCount = Number(arg("--candles") ?? 3)
const top = Number(arg("--top") ?? 10)
if (targetMinute < MARKET_OPEN || targetMinute >= MARKET_CLOSE) fail("Target time must be from 09:15 through 15:29 IST")
if (!Number.isInteger(candleCount) || candleCount < 2) fail("--candles must be an integer of at least 2")
if (!Number.isInteger(top) || top < 1) fail("--top must be a positive integer")

function symbols() {
  const file = path.join(ROOT, "db", "stocks")
  if (fs.existsSync(file)) {
    try {
      return [...new Set(JSON.parse(fs.readFileSync(file, "utf8")).map(value => String(value).trim().toUpperCase().replace(/-EQ$/, "")))].sort()
    } catch {}
  }
  return fs.readdirSync(path.join(ROOT, "db", "candles"))
    .filter(fileName => fileName.endsWith(".jsonl") && fileName !== "NIFTY50.jsonl")
    .map(fileName => fileName.slice(0, -6)).sort()
}

function evaluate(symbol) {
  const file = path.join(ROOT, "db", "candles", `${symbol}.jsonl`)
  if (!fs.existsSync(file)) return null
  const deduplicated = new Map()
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    if (!line.trim()) continue
    let raw
    try { raw = JSON.parse(line) } catch { continue }
    const time = +raw.time, close = +raw.close, volume = +raw.volume
    if (![time, close, volume].every(Number.isFinite) || close <= 0 || volume <= 0) continue
    const stamp = istStamp(time), date = stamp.slice(0, 10), minute = minuteOfText(stamp.slice(11))
    if (minute < MARKET_OPEN || minute >= MARKET_CLOSE || stamp > datetime) continue
    // Ignore later duplicate/provider copies of the same minute except for the last occurrence.
    deduplicated.set(stamp, { stamp, date, minute, close, volume })
  }
  const rows = [...deduplicated.values()].sort((left, right) => left.stamp.localeCompare(right.stamp))
  if (rows.at(-1)?.stamp !== datetime) return null
  const selected = rows.slice(-candleCount)
  if (selected.length !== candleCount) return null

  let pvi = 1000, nvi = 1000
  const steps = []
  for (let index = 1; index < selected.length; index++) {
    const previous = selected[index - 1], current = selected[index]
    const priceChangePct = 100 * (current.close / previous.close - 1)
    let updated = "NONE"
    if (current.volume > previous.volume) {
      pvi *= current.close / previous.close
      updated = "PVI"
    } else if (current.volume < previous.volume) {
      nvi *= current.close / previous.close
      updated = "NVI"
    }
    steps.push({
      from: previous.stamp, to: current.stamp,
      previousClose: previous.close, close: current.close,
      previousVolume: previous.volume, volume: current.volume,
      priceChangePct: round(priceChangePct), updated,
      pvi: round(pvi), nvi: round(nvi),
    })
  }
  const pviChangePct = 100 * (pvi / 1000 - 1)
  const nviChangePct = 100 * (nvi / 1000 - 1)
  const pviDropPct = Math.max(0, -pviChangePct)
  const nviDropPct = Math.max(0, -nviChangePct)
  return {
    symbol,
    start: selected[0].stamp,
    end: selected.at(-1).stamp,
    pvi: round(pvi), nvi: round(nvi),
    pviChangePct: round(pviChangePct), nviChangePct: round(nviChangePct),
    pviDropPct: round(pviDropPct), nviDropPct: round(nviDropPct),
    bothDown: pviDropPct > 0 && nviDropPct > 0,
    averageDropPct: pviDropPct > 0 && nviDropPct > 0 ? round((pviDropPct + nviDropPct) / 2) : null,
    candles: selected,
    steps,
  }
}

const universe = symbols()
const rows = universe.map(evaluate).filter(Boolean)
const rank = (field, predicate = row => row[field] > 0) => rows.filter(predicate)
  .sort((left, right) => right[field] - left[field] || left.symbol.localeCompare(right.symbol))
  .slice(0, top)
  .map((row, index) => ({ rank: index + 1, ...row }))
const topBothDown = rank("averageDropPct", row => row.bothDown)

const method = `Select the latest ${candleCount} genuine-volume regular-session candles ending exactly at ${datetime} IST. Zero-volume padding is excluded. Seed PVI and NVI at 1000 on the first selected candle. PVI updates only when volume increases from the preceding candle; NVI updates only when volume decreases.`
const output = {
  generatedAt: new Date().toISOString(), datetime, timezone: "Asia/Kolkata",
  requestedCandles: candleCount, top, universeSize: universe.length, comparableStocks: rows.length,
  method, ranking: "Both PVI and NVI declined, ordered by average decline", topBothDown,
}

const stem = `${targetDate}-${targetClock.replace(":", "")}-pvi-nvi-decline-last${candleCount}`
const jsonFile = uniquePath("reports", stem, "json")
const csvFile = uniquePath("csv", stem, "csv")
fs.mkdirSync(path.dirname(jsonFile), { recursive: true })
fs.mkdirSync(path.dirname(csvFile), { recursive: true })
fs.writeFileSync(jsonFile, `${JSON.stringify(output, null, 2)}\n`, { flag: "wx" })

const headers = ["rank", "symbol", "start", "end", "pvi", "nvi", "pviDownPct", "nviDownPct", "averageDownPct", "candles"]
const csvRows = topBothDown.map(row => [row.rank, row.symbol, row.start, row.end, row.pvi, row.nvi, row.pviDropPct, row.nviDropPct, row.averageDropPct, row.candles])
fs.writeFileSync(csvFile, `${headers.join(",")}\n${csvRows.map(row => row.map(csvCell).join(",")).join("\n")}\n`, { flag: "wx" })

const compact = rows => rows.map(row => ({ Rank: row.rank, Stock: row.symbol, "PVI down %": row.pviDropPct, "NVI down %": row.nviDropPct, "Average down %": row.averageDropPct }))
console.log(`Date/time: ${datetime} IST | universe=${universe.length} comparable=${rows.length}`)
console.log("\nBoth PVI and NVI declined")
console.table(compact(topBothDown))
console.log(`JSON: ${jsonFile}`)
console.log(`CSV: ${csvFile}`)
