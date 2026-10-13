import fs from "node:fs"
import fsp from "node:fs/promises"
import path from "node:path"
import readline from "node:readline"

const runtimeArgs = typeof process === "undefined" ? [] : process.argv.slice(2)
const root = typeof nodeRepl === "undefined" ? process.cwd() : nodeRepl.cwd
const days = runtimeArgs.length
  ? runtimeArgs
  : ["2026-10-05", "2026-10-06", "2026-10-07", "2026-10-08", "2026-10-09"]
const depthRoot = path.join(root, "db", "cash-depth")
const candleRoot = path.join(root, "db", "candles")
const IST = 330 * 60_000
const pct = (value, base) => base > 0 ? (value / base - 1) * 100 : NaN
const mean = (values) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : NaN
const slope = (values) => {
  const n = values.length
  if (n < 2) return 0
  const sx = n * (n - 1) / 2
  const sy = values.reduce((sum, value) => sum + value, 0)
  const sxx = (n - 1) * n * (2 * n - 1) / 6
  const sxy = values.reduce((sum, value, index) => sum + index * value, 0)
  const denominator = n * sxx - sx * sx
  return denominator ? (n * sxy - sx * sy) / denominator : 0
}
const indiaDate = (at) => new Date(at + IST).toISOString().slice(0, 10)
const indiaTime = (at) => new Date(at + IST).toISOString().slice(11, 16)
const round = (value, digits = 3) => Number.isFinite(value) ? Number(value.toFixed(digits)) : null

async function* records(filename) {
  const input = fs.createReadStream(filename, { encoding: "utf8" })
  const lines = readline.createInterface({ input, crlfDelay: Infinity })
  try {
    for await (const line of lines) {
      if (!line.trim()) continue
      try { yield JSON.parse(line) } catch { /* Ignore an incomplete final row. */ }
    }
  } finally {
    lines.close()
    input.destroy()
  }
}

function bookMetrics(data) {
  let bidSize = 0, askSize = 0, bid2 = 0, ask2 = 0
  let bestBid = NaN, bestAsk = NaN
  for (let level = 1; level <= 5; level++) {
    const bid = Number(data[`bid_price${level}`])
    const ask = Number(data[`ask_price${level}`])
    const bidQty = Number(data[`bid_size${level}`])
    const askQty = Number(data[`ask_size${level}`])
    if (![bid, ask, bidQty, askQty].every(Number.isFinite) ||
        bid <= 0 || ask <= bid || bidQty < 0 || askQty < 0) return null
    if (level === 1) { bestBid = bid; bestAsk = ask }
    bidSize += bidQty
    askSize += askQty
    if (level <= 2) { bid2 += bidQty; ask2 += askQty }
  }
  return {
    mid: (bestBid + bestAsk) / 2,
    full: (bidSize - askSize) / (bidSize + askSize || 1),
    top2: (bid2 - ask2) / (bid2 + ask2 || 1),
  }
}

async function loadCandles() {
  const result = new Map()
  const files = (await fsp.readdir(candleRoot)).filter((name) => name.endsWith(".jsonl"))
  for (const name of files) {
    const symbol = name.slice(0, -6)
    const rows = []
    for await (const row of records(path.join(candleRoot, name))) {
      const at = Number(row.time) * 1000
      if (!days.includes(indiaDate(at))) continue
      rows.push({ at, open: Number(row.open), high: Number(row.high), low: Number(row.low),
        close: Number(row.close), volume: Number(row.volume) })
    }
    rows.sort((left, right) => left.at - right.at)
    result.set(symbol, rows)
  }
  return result
}

async function scanStock(day, symbol, candleMap) {
  const filename = path.join(depthRoot, day, symbol, `${symbol}.jsonl`)
  const fields = {}
  const minutes = new Map()
  let lastAt = 0
  for await (const record of records(filename)) {
    const at = Date.parse(record.receivedAt)
    if (!Number.isFinite(at) || indiaDate(at) !== day) continue
    if (lastAt && at - lastAt > 90_000) for (const key of Object.keys(fields)) delete fields[key]
    lastAt = at
    if (record.kind === "checkpoint" || record.book) {
      for (const key of Object.keys(fields)) delete fields[key]
      Object.assign(fields, record.data)
    } else if (record.kind === "update") Object.assign(fields, record.data)
    else continue
    const book = bookMetrics(fields)
    if (!book) continue
    const minute = Math.floor(at / 60_000) * 60_000
    const bucket = minutes.get(minute) ?? {
      at: minute, updates: 0, full: 0, top2: 0,
      firstMid: book.mid, lastMid: book.mid,
    }
    bucket.updates++
    bucket.full += book.full
    bucket.top2 += book.top2
    bucket.lastMid = book.mid
    minutes.set(minute, bucket)
  }
  const depth = [...minutes.values()].map((row) => ({ ...row,
    full: row.full / row.updates, top2: row.top2 / row.updates,
  })).sort((left, right) => left.at - right.at)
  const candles = (candleMap.get(symbol) ?? []).filter((row) => indiaDate(row.at) === day)
  const candleIndex = new Map(candles.map((row, index) => [row.at, index]))
  const candidates = []
  for (let index = 7; index < depth.length; index++) {
    const window = depth.slice(index - 7, index + 1)
    if (window.some((row, offset) => offset && row.at !== window[offset - 1].at + 60_000) ||
        window.some((row) => row.updates < 3)) continue
    const prior = window.slice(0, 5)
    const recent = window.slice(5)
    const priorFull = mean(prior.map((row) => row.full))
    const recentFull = mean(recent.map((row) => row.full))
    const deltaFull = recentFull - priorFull
    const deltaTop2 = mean(recent.map((row) => row.top2)) - mean(prior.map((row) => row.top2))
    const side = deltaFull >= 0 ? "BUY" : "SELL"
    const sign = side === "BUY" ? 1 : -1
    if (!(sign * priorFull < 0 && sign * recentFull > 0 && sign * deltaFull >= 0.20 &&
        sign * deltaTop2 >= 0.10 && sign * slope(recent.map((row) => row.full)) > 0 &&
        sign * pct(recent.at(-1).lastMid, recent[0].firstMid) > 0)) continue
    const candleAt = depth[index].at
    const atIndex = candleIndex.get(candleAt)
    if (atIndex == null || atIndex < 2 || atIndex + 1 >= candles.length) continue
    const last3 = candles.slice(atIndex - 2, atIndex + 1)
    const return3 = pct(last3.at(-1).close, last3[0].open)
    const sameCandles = last3.filter((row) => side === "BUY"
      ? row.close > row.open : row.close < row.open).length
    if (!(sign * return3 >= 0.10 && sameCandles >= 2)) continue
    const entryCandle = candles[atIndex + 1]
    const entry = entryCandle.open
    const target = side === "BUY" ? entry * 1.02 : entry * 0.98
    const stop = side === "BUY" ? entry * 0.996 : entry * 1.004
    let status = "Unresolved", resolvedAt = null, maxFavourable = 0, maxAdverse = 0
    for (const candle of candles.slice(atIndex + 1)) {
      if (side === "BUY") {
        maxFavourable = Math.max(maxFavourable, pct(candle.high, entry))
        maxAdverse = Math.min(maxAdverse, pct(candle.low, entry))
        if (candle.low <= stop) { status = "Stop"; resolvedAt = candle.at; break }
        if (candle.high >= target) { status = "Target"; resolvedAt = candle.at; break }
      } else {
        maxFavourable = Math.max(maxFavourable, -pct(candle.low, entry))
        maxAdverse = Math.min(maxAdverse, -pct(candle.high, entry))
        if (candle.high >= stop) { status = "Stop"; resolvedAt = candle.at; break }
        if (candle.low <= target) { status = "Target"; resolvedAt = candle.at; break }
      }
    }
    candidates.push({ date: day, symbol, side, signalAt: depth[index].at + 60_000,
      entry, target, stop, status, resolvedAt, priorFull, recentFull,
      deltaFull: sign * deltaFull, deltaTop2: sign * deltaTop2,
      recentSlope: sign * slope(recent.map((row) => row.full)),
      depthMidMove: sign * pct(recent.at(-1).lastMid, recent[0].firstMid),
      return3: sign * return3, sameCandles, maxFavourable, maxAdverse })
  }
  return candidates
}

const candleMap = await loadCandles()
const all = []
for (const day of days) {
  const symbols = (await fsp.readdir(path.join(depthRoot, day), { withFileTypes: true }))
    .filter((entry) => entry.isDirectory()).map((entry) => entry.name)
  let cursor = 0
  const found = []
  await Promise.all(Array.from({ length: 6 }, async () => {
    while (cursor < symbols.length) {
      const symbol = symbols[cursor++]
      try { found.push(...await scanStock(day, symbol, candleMap)) } catch { /* Audit continues. */ }
    }
  }))
  found.sort((left, right) => left.signalAt - right.signalAt || left.symbol.localeCompare(right.symbol))
  const lastSignal = new Map()
  for (const row of found) {
    const key = `${row.date}|${row.symbol}|${row.side}`
    if ((lastSignal.get(key) ?? 0) > row.signalAt - 15 * 60_000) continue
    lastSignal.set(key, row.signalAt)
    all.push(row)
  }
  console.log(JSON.stringify({ day, signals: all.filter((row) => row.date === day).length }))
}

const csvColumns = ["date", "symbol", "side", "signal_time", "entry", "target", "stop", "status",
  "resolved_time", "prior_full", "recent_full", "full_shift", "top2_shift", "recent_slope",
  "depth_mid_move_pct", "candle_return_3_pct", "same_side_candles", "max_favourable_pct", "max_adverse_pct"]
const csvRows = [csvColumns.join(",")]
for (const row of all) csvRows.push([
  row.date, row.symbol, row.side, indiaTime(row.signalAt), row.entry, round(row.target), round(row.stop), row.status,
  row.resolvedAt ? indiaTime(row.resolvedAt) : "", round(row.priorFull), round(row.recentFull), round(row.deltaFull),
  round(row.deltaTop2), round(row.recentSlope), round(row.depthMidMove), round(row.return3), row.sameCandles,
  round(row.maxFavourable), round(row.maxAdverse),
].join(","))
const output = path.join(root, "csv", "2026-10-05-to-09-depth-right-angle-audit.csv")
await fsp.writeFile(output, `${csvRows.join("\n")}\n`)
const outcome = (rows) => Object.fromEntries(["Target", "Stop", "Unresolved"].map((status) =>
  [status, rows.filter((row) => row.status === status).length]))
const strongestTargets = all.filter((row) => row.status === "Target")
  .sort((left, right) => (right.deltaFull + right.deltaTop2 + right.return3) -
    (left.deltaFull + left.deltaTop2 + left.return3)).slice(0, 20)
  .map((row) => ({ date: row.date, symbol: row.symbol, side: row.side,
    signal: indiaTime(row.signalAt), entry: row.entry, targetAt: indiaTime(row.resolvedAt),
    fullShift: round(row.deltaFull), top2Shift: round(row.deltaTop2), candle3Pct: round(row.return3),
    adversePct: round(row.maxAdverse) }))
console.log(JSON.stringify({ output, total: all.length, outcomes: outcome(all),
  byDay: Object.fromEntries(days.map((day) => [day, outcome(all.filter((row) => row.date === day))])),
  strongestTargets }, null, 2))
