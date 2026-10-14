import fs from "node:fs"
import path from "node:path"
import readline from "node:readline"

const ROOT = process.cwd()
const MINUTE = 60_000
const IST_OFFSET = 330 * MINUTE
const TARGET_PCT = 1
const DATES = ["2026-10-08", "2026-10-09", "2026-10-12", "2026-10-13", "2026-10-14"]
const SYMBOLS = ["ITC", "NESTLEIND", "PIDILITIND", "PERSISTENT", "DELHIVERY",
  "NUVAMA", "BPCL", "KPITTECH", "MARUTI", "SBICARD"]

const dateSet = new Set(DATES)
const candleRoot = path.join(ROOT, "db", "candles")
const depthRoot = path.join(ROOT, "db", "cash-depth")
const outputCsv = path.join(ROOT, "csv", "2026-10-08-to-14-ema15-30-depth-cross-audit.csv")
const outputJson = path.join(ROOT, "csv", "2026-10-08-to-14-ema15-30-depth-cross-audit.json")
const outputTargetsCsv = path.join(ROOT, "csv", "2026-10-08-to-14-ema15-30-same-day-1pct-signals.csv")

const pct = (value, base) => base > 0 ? (value / base - 1) * 100 : NaN
const mean = (values) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : NaN
const round = (value, digits = 4) => Number.isFinite(value) ? Number(value.toFixed(digits)) : null
const indiaDate = (at) => new Date(at + IST_OFFSET).toISOString().slice(0, 10)
const indiaTime = (at) => new Date(at + IST_OFFSET).toISOString().slice(11, 19)
const lowerBound = (rows, at) => {
  let low = 0, high = rows.length
  while (low < high) {
    const middle = (low + high) >>> 1
    if (rows[middle].at < at) low = middle + 1
    else high = middle
  }
  return low
}

function csvValue(value) {
  const text = value == null ? "" : String(value)
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
}

async function* records(filename) {
  const input = fs.createReadStream(filename, { encoding: "utf8" })
  const lines = readline.createInterface({ input, crlfDelay: Infinity })
  try {
    for await (const line of lines) {
      if (!line.trim()) continue
      try { yield JSON.parse(line) } catch { /* Ignore an incomplete final record. */ }
    }
  } finally {
    lines.close()
    input.destroy()
  }
}

function loadCandles(symbol) {
  const rows = fs.readFileSync(path.join(candleRoot, `${symbol}.jsonl`), "utf8")
    .split(/\r?\n/).flatMap((line) => {
      if (!line.trim()) return []
      try {
        const value = JSON.parse(line), at = Number(value.time) * 1000
        if (!dateSet.has(indiaDate(at))) return []
        const row = { at, open: Number(value.open), high: Number(value.high),
          low: Number(value.low), close: Number(value.close), volume: Number(value.volume) }
        return Object.values(row).every(Number.isFinite) ? [row] : []
      } catch { return [] }
    }).sort((left, right) => left.at - right.at)

  let ema15 = null, ema30 = null, previousSign = 0
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index]
    ema15 = ema15 == null ? row.close : 2 / 16 * row.close + 14 / 16 * ema15
    ema30 = ema30 == null ? row.close : 2 / 31 * row.close + 29 / 31 * ema30
    row.ema15 = ema15
    row.ema30 = ema30
    row.emaDiff = ema15 - ema30
    row.emaSign = row.emaDiff > 0 ? 1 : row.emaDiff < 0 ? -1 : 0
    row.cross = index >= 29 && previousSign && row.emaSign && row.emaSign !== previousSign
    if (index >= 29 && row.emaSign) previousSign = row.emaSign
  }
  return rows
}

function completeBook(fields) {
  let bidSize = 0, askSize = 0, bid2 = 0, ask2 = 0
  for (let level = 1; level <= 5; level++) {
    const bidPrice = Number(fields[`bid_price${level}`])
    const askPrice = Number(fields[`ask_price${level}`])
    const currentBid = Number(fields[`bid_size${level}`])
    const currentAsk = Number(fields[`ask_size${level}`])
    if (![bidPrice, askPrice, currentBid, currentAsk].every(Number.isFinite) ||
        bidPrice <= 0 || askPrice <= bidPrice || currentBid < 0 || currentAsk < 0) return null
    bidSize += currentBid
    askSize += currentAsk
    if (level <= 2) { bid2 += currentBid; ask2 += currentAsk }
  }
  const bid = Number(fields.bid_price1), ask = Number(fields.ask_price1)
  const bid1 = Number(fields.bid_size1), ask1 = Number(fields.ask_size1)
  return { bid, ask, bid1, ask1, mid: (bid + ask) / 2,
    full: (bidSize - askSize) / (bidSize + askSize || 1),
    top2: (bid2 - ask2) / (bid2 + ask2 || 1),
    spreadBps: 10_000 * (ask - bid) / ((ask + bid) / 2) }
}

async function loadDepth(symbol) {
  const samples = []
  let previous = null, lastTradeDirection = 0
  for (const date of DATES) {
    const filename = path.join(depthRoot, date, symbol, `${symbol}.jsonl`)
    if (!fs.existsSync(filename)) continue
    const fields = {}
    for await (const record of records(filename)) {
      const at = Date.parse(record.receivedAt)
      if (!Number.isFinite(at) || indiaDate(at) !== date) continue
      if (previous && at - previous.at > 90_000) {
        previous = null
        lastTradeDirection = 0
        for (const key of Object.keys(fields)) delete fields[key]
      }
      if (record.kind === "checkpoint" || record.book) {
        for (const key of Object.keys(fields)) delete fields[key]
        Object.assign(fields, record.data)
      } else if (record.kind === "update") Object.assign(fields, record.data)
      else continue
      const book = completeBook(fields)
      const marketPrice = Number(record.marketContext?.price)
      const volume = Number(record.marketContext?.cumulativeVolume)
      if (!book || !(marketPrice > 0) || !Number.isFinite(volume)) continue

      let ofi = 0, traded = 0, signed = 0
      if (previous) {
        let rawOfi = book.bid > previous.bid ? book.bid1
          : book.bid === previous.bid ? book.bid1 - previous.bid1 : -previous.bid1
        rawOfi -= book.ask < previous.ask ? book.ask1
          : book.ask === previous.ask ? book.ask1 - previous.ask1 : -previous.ask1
        ofi = rawOfi / ((book.bid1 + book.ask1 + previous.bid1 + previous.ask1) / 2 || 1)
        traded = Math.max(0, volume - previous.volume)
        if (marketPrice > previous.price) lastTradeDirection = 1
        else if (marketPrice < previous.price) lastTradeDirection = -1
        signed = traded * lastTradeDirection
      }
      samples.push({ at, price: marketPrice, volume, ofi, traded, signed, ...book })
      previous = { at, price: marketPrice, volume, ...book }
    }
    previous = null
    lastTradeDirection = 0
  }
  return samples.sort((left, right) => left.at - right.at)
}

function windowMetrics(samples, from, to, direction) {
  const start = lowerBound(samples, from), end = lowerBound(samples, to)
  const rows = samples.slice(start, end)
  if (!rows.length) return null
  const gaps = rows.slice(1).map((row, index) => (row.at - rows[index].at) / 1000)
  const traded = rows.reduce((sum, row) => sum + row.traded, 0)
  const signed = rows.reduce((sum, row) => sum + row.signed, 0)
  return {
    updates: rows.length,
    spanSec: (rows.at(-1).at - rows[0].at) / 1000,
    maxGapSec: gaps.length ? Math.max(...gaps) : null,
    dirFull: direction * mean(rows.map((row) => row.full)),
    dirTop2: direction * mean(rows.map((row) => row.top2)),
    dirCloseFull: direction * rows.at(-1).full,
    dirCloseTop2: direction * rows.at(-1).top2,
    dirOfi: direction * mean(rows.map((row) => row.ofi)),
    dirDeltaPct: traded > 0 ? direction * 100 * signed / traded : 0,
    dirMidReturnPct: direction * pct(rows.at(-1).mid, rows[0].mid),
    alignedFullPct: 100 * rows.filter((row) => direction * row.full > 0).length / rows.length,
    alignedTop2Pct: 100 * rows.filter((row) => direction * row.top2 > 0).length / rows.length,
    spreadBps: mean(rows.map((row) => row.spreadBps)),
  }
}

function candleMetrics(candles, index, direction) {
  const row = candles[index]
  const prior10 = candles.slice(Math.max(0, index - 10), index)
  const prior3 = candles.slice(Math.max(0, index - 3), index)
  const range = row.high - row.low
  const priorVolume = mean(prior10.map((value) => value.volume))
  const priorDiff = candles[index - 1]?.emaDiff
  const threeStart = prior3[0]?.open
  return {
    candleReturnPct: direction * pct(row.close, row.open),
    closeLocationPct: range > 0 ? 100 * (direction > 0
      ? (row.close - row.low) / range : (row.high - row.close) / range) : 50,
    rangePct: 100 * range / row.open,
    volumeRatio10: priorVolume > 0 ? row.volume / priorVolume : null,
    pre3ReturnPct: threeStart > 0 ? direction * pct(row.close, threeStart) : null,
    emaGapPct: direction * pct(row.ema15, row.ema30),
    emaGapExpansionPct: Number.isFinite(priorDiff) ? direction * 100 * (row.emaDiff - priorDiff) / row.close : null,
  }
}

function pathOutcome(samples, signalAt, nextSignalAt, direction) {
  const entryIndex = lowerBound(samples, signalAt)
  const entry = samples[entryIndex]
  if (!entry || entry.at - signalAt > 15_000 || indiaDate(entry.at) !== indiaDate(signalAt)) return null
  const entryPrice = direction > 0 ? entry.ask : entry.bid
  const endIndex = lowerBound(samples, nextSignalAt)
  const pathRows = samples.slice(entryIndex, endIndex)
  if (!pathRows.length) return null
  const executableReturn = (row) => direction > 0
    ? pct(row.bid, entryPrice) : pct(entryPrice, row.ask)
  let maximum = -Infinity, minimum = Infinity, preTargetMinimum = Infinity, target = null
  for (const row of pathRows) {
    const value = executableReturn(row)
    maximum = Math.max(maximum, value)
    minimum = Math.min(minimum, value)
    if (!target) {
      preTargetMinimum = Math.min(preTargetMinimum, value)
      if (value >= TARGET_PCT) target = row
    }
  }
  const exit = samples[endIndex] && samples[endIndex].at - nextSignalAt <= 15_000
    ? samples[endIndex] : pathRows.at(-1)
  return { entryAt: entry.at, entryPrice, entryLatencySec: (entry.at - signalAt) / 1000,
    mfePct: maximum, maePct: minimum, preTargetMaePct: preTargetMinimum,
    targetAt: target?.at ?? null,
    exitAt: exit.at, exitPrice: direction > 0 ? exit.bid : exit.ask,
    exitReturnPct: executableReturn(exit), pathUpdates: pathRows.length }
}

async function analyzeSymbol(symbol) {
  const candles = loadCandles(symbol)
  const depths = await loadDepth(symbol)
  const crosses = candles.map((row, index) => ({ row, index })).filter(({ row }) => row.cross)
  const output = []
  for (let crossIndex = 0; crossIndex < crosses.length - 1; crossIndex++) {
    const current = crosses[crossIndex], next = crosses[crossIndex + 1]
    const direction = current.row.emaSign
    const signalAt = current.row.at + MINUTE
    const nextSignalAt = next.row.at + MINUTE
    const outcome = pathOutcome(depths, signalAt, nextSignalAt, direction)
    const minute1 = windowMetrics(depths, signalAt - MINUTE, signalAt, direction)
    const minute3 = windowMetrics(depths, signalAt - 3 * MINUTE, signalAt, direction)
    const candle = candleMetrics(candles, current.index, direction)
    const depthQuality = Boolean(minute1 && minute1.updates >= 10 && minute1.spanSec >= 45 &&
      minute1.maxGapSec <= 15 && outcome)
    output.push({
      date: indiaDate(signalAt), signalTime: indiaTime(signalAt), symbol,
      side: direction > 0 ? "BUY" : "SELL", nextCrossDate: indiaDate(nextSignalAt),
      nextCrossTime: indiaTime(nextSignalAt), holdMinutes: (nextSignalAt - signalAt) / MINUTE,
      depthQuality, targetHit: Boolean(outcome?.targetAt),
      targetTime: outcome?.targetAt ? `${indiaDate(outcome.targetAt)} ${indiaTime(outcome.targetAt)}` : null,
      targetMinutes: outcome?.targetAt ? round((outcome.targetAt - signalAt) / MINUTE, 2) : null,
      entryAt: outcome?.entryAt ? indiaTime(outcome.entryAt) : null,
      entryPrice: round(outcome?.entryPrice), entryLatencySec: round(outcome?.entryLatencySec, 2),
      mfePct: round(outcome?.mfePct), maePct: round(outcome?.maePct),
      preTargetMaePct: round(outcome?.preTargetMaePct),
      exitReturnPct: round(outcome?.exitReturnPct), pathUpdates: outcome?.pathUpdates ?? 0,
      ...Object.fromEntries(Object.entries(candle).map(([key, value]) => [key, round(value)])),
      ...Object.fromEntries(Object.entries(minute1 || {}).map(([key, value]) => [`depth1_${key}`, round(value)])),
      ...Object.fromEntries(Object.entries(minute3 || {}).map(([key, value]) => [`depth3_${key}`, round(value)])),
    })
  }
  return { rows: output, candles: candles.length, depthSamples: depths.length, crosses: crosses.length }
}

const results = []
const coverage = []
for (const symbol of SYMBOLS) {
  const result = await analyzeSymbol(symbol)
  results.push(...result.rows)
  coverage.push({ symbol, candles: result.candles, depthSamples: result.depthSamples,
    crosses: result.crosses, evaluated: result.rows.length })
  process.stderr.write(`${symbol}: ${result.crosses} crosses, ${result.depthSamples} depth samples\n`)
}
results.sort((left, right) => left.date.localeCompare(right.date) ||
  left.signalTime.localeCompare(right.signalTime) || left.symbol.localeCompare(right.symbol))

const columns = [...new Set(results.flatMap((row) => Object.keys(row)))]
fs.mkdirSync(path.dirname(outputCsv), { recursive: true })
fs.writeFileSync(outputCsv, `${[columns.join(","), ...results.map((row) =>
  columns.map((column) => csvValue(row[column])).join(","))].join("\n")}\n`)

const quality = results.filter((row) => row.depthQuality)
const targets = quality.filter((row) => row.targetHit)
const sameDayTargets = targets.filter((row) => row.targetTime?.slice(0, 10) === row.date)
fs.writeFileSync(outputTargetsCsv, `${[columns.join(","), ...sameDayTargets.map((row) =>
  columns.map((column) => csvValue(row[column])).join(","))].join("\n")}\n`)
const summary = {
  dates: DATES, symbols: SYMBOLS, targetPct: TARGET_PCT,
  methodology: "EMA seeded from first close in the five-date window; first 30 candles are warm-up. Signal is actionable after the crossover candle closes. Entry and outcome use executable depth quotes until the next crossover.",
  coverage, crossIntervals: results.length, depthQualified: quality.length,
  targetHits: targets.length, targetRatePct: round(100 * targets.length / quality.length, 2),
  sameDayTargetHits: sameDayTargets.length,
  bySymbol: Object.fromEntries(SYMBOLS.map((symbol) => {
    const rows = quality.filter((row) => row.symbol === symbol)
    const wins = rows.filter((row) => row.targetHit)
    return [symbol, { evaluated: rows.length, targets: wins.length,
      targetRatePct: round(100 * wins.length / rows.length, 2),
      medianMfePct: round(rows.map((row) => row.mfePct).sort((a, b) => a - b)[Math.floor(rows.length / 2)]) }]
  })),
  outputCsv, outputTargetsCsv,
}
fs.writeFileSync(outputJson, `${JSON.stringify({ summary, rows: results }, null, 2)}\n`)
console.log(JSON.stringify(summary, null, 2))
