import fs from "node:fs"
import path from "node:path"

const ROOT = process.cwd(), REPORTS = path.join(ROOT, "reports")
const CANDLES = path.join(ROOT, "db", "candles"), DEPTH = path.join(ROOT, "db", "cash-depth")
const INPUT = path.join(REPORTS, "2026-10-05-to-2026-10-16-ema10-20-entry-context-2.csv")
const OUTPUT = path.join(REPORTS, "2026-10-05-to-2026-10-16-advanced-ema-entry-context.csv")
const MINUTE = 60_000, IST = 330 * MINUTE
const dateOf = (at) => new Date(at + IST).toISOString().slice(0, 10)
const pct = (value, base) => base > 0 ? 100 * (value / base - 1) : NaN
const mean = (values) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : NaN
const round = (value, digits = 6) => Number.isFinite(value) ? Number(value.toFixed(digits)) : ""

function parseCsv(filename) {
  const [header, ...lines] = fs.readFileSync(filename, "utf8").trim().split(/\r?\n/), fields = header.split(",")
  return lines.map((line) => Object.fromEntries(line.split(",").map((value, index) => [fields[index], value])))
}
function csvValue(value) { const text = String(value ?? ""); return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text }
function jsonl(filename) {
  if (!fs.existsSync(filename)) return []
  return fs.readFileSync(filename, "utf8").split(/\r?\n/).flatMap((line) => { try { return line ? [JSON.parse(line)] : [] } catch { return [] } })
}
function epoch(date, time) { return Date.parse(`${date}T${time}:00+05:30`) }
function ema(values, period) {
  if (!values.length) return NaN
  const alpha = 2 / (period + 1); let value = values[0]
  for (const current of values.slice(1)) value = alpha * current + (1 - alpha) * value
  return value
}
function rsi(values, period) {
  const rows = values.slice(-(period + 1)); if (rows.length < period + 1) return NaN
  let gains = 0, losses = 0
  for (let index = 1; index < rows.length; index++) { const change = rows[index] - rows[index - 1]; if (change > 0) gains += change; else losses -= change }
  return losses ? 100 - 100 / (1 + gains / losses) : gains ? 100 : 50
}
function mfi(rows, period) {
  const data = rows.slice(-(period + 1)); if (data.length < period + 1) return NaN
  let positive = 0, negative = 0
  for (let index = 1; index < data.length; index++) {
    const prior = (data[index - 1].high + data[index - 1].low + data[index - 1].close) / 3
    const current = (data[index].high + data[index].low + data[index].close) / 3
    const flow = current * data[index].volume
    if (current > prior) positive += flow; else if (current < prior) negative += flow
  }
  return negative ? 100 - 100 / (1 + positive / negative) : positive ? 100 : 50
}
function macd(values) {
  if (values.length < 35) return { line: NaN, signal: NaN, histogram: NaN }
  const lines = []
  for (let index = 25; index < values.length; index++) lines.push(ema(values.slice(0, index + 1), 12) - ema(values.slice(0, index + 1), 26))
  const line = lines.at(-1), signal = ema(lines, 9)
  return { line, signal, histogram: line - signal }
}
function regression(values) {
  const n = values.length; if (n < 3) return { slopePct: NaN, r2: NaN, angle: NaN }
  const xMean = (n - 1) / 2, y = values.map((value) => Math.log(value)), yMean = mean(y)
  let numerator = 0, denominator = 0, total = 0
  for (let index = 0; index < n; index++) { numerator += (index - xMean) * (y[index] - yMean); denominator += (index - xMean) ** 2; total += (y[index] - yMean) ** 2 }
  const slope = numerator / denominator, explained = slope * slope * denominator
  return { slopePct: 100 * slope, r2: total ? explained / total : 0, angle: Math.atan(100 * slope) * 180 / Math.PI }
}
function sessionStart(at) { const date = dateOf(at); return Date.parse(`${date}T09:15:00+05:30`) }
function completedBars(rows, signalAt, frameMinutes) {
  const frame = frameMinutes * MINUTE, start = sessionStart(signalAt), bars = []
  for (const row of rows) {
    if (row.at >= signalAt) break
    const slot = Math.floor((row.at - start) / frame), openAt = start + slot * frame, closeAt = openAt + frame
    if (closeAt > signalAt) continue
    let bar = bars.at(-1)
    if (!bar || bar.openAt !== openAt) { bar = { openAt, closeAt, open: row.open, high: row.high, low: row.low, close: row.close, volume: row.volume }; bars.push(bar) }
    else { bar.high = Math.max(bar.high, row.high); bar.low = Math.min(bar.low, row.low); bar.close = row.close; bar.volume += row.volume }
  }
  return bars
}
function vwap(rows) {
  const volume = rows.reduce((sum, row) => sum + row.volume, 0)
  return volume ? rows.reduce((sum, row) => sum + ((row.high + row.low + row.close) / 3) * row.volume, 0) / volume : NaN
}
function candleFeatures(rows, signalAt, side, prefix) {
  const index = rows.findIndex((row) => row.at === signalAt - MINUTE); if (index < 0) return {}
  const history = rows.slice(0, index + 1), current = history.at(-1), direction = side === "BUY" ? 1 : -1
  const closes = history.map((row) => row.close), prior20 = history.slice(Math.max(0, -21), -1)
  const result = {
    [`${prefix}rsi7`]: direction * (rsi(closes, 7) - 50), [`${prefix}rsi14`]: direction * (rsi(closes, 14) - 50),
    [`${prefix}mfi7`]: direction * (mfi(history, 7) - 50), [`${prefix}mfi14`]: direction * (mfi(history, 14) - 50),
    [`${prefix}vwapGap`]: direction * pct(current.close, vwap(history)), [`${prefix}atr14Pct`]: pct(mean(history.slice(-14).map((row, i, selected) => {
      const prior = i ? selected[i - 1].close : row.open; return Math.max(row.high - row.low, Math.abs(row.high - prior), Math.abs(row.low - prior))
    })) + current.close, current.close),
    [`${prefix}resistanceBreak20`]: prior20.length ? direction * (direction > 0
      ? pct(current.close, Math.max(...prior20.map((row) => row.high)))
      : pct(Math.min(...prior20.map((row) => row.low)), current.close)) : NaN,
  }
  const indicatorMacd = macd(closes)
  result[`${prefix}macdLineBps`] = direction * 10_000 * indicatorMacd.line / current.close
  result[`${prefix}macdHistogramBps`] = direction * 10_000 * indicatorMacd.histogram / current.close
  for (const period of [5, 10, 20]) {
    const trend = regression(closes.slice(-period))
    result[`${prefix}trend${period}Slope`] = direction * trend.slopePct
    result[`${prefix}trend${period}R2`] = trend.r2
    result[`${prefix}trend${period}Angle`] = direction * trend.angle
  }
  for (const frame of [3, 5, 10, 15]) {
    const bars = completedBars(rows, signalAt, frame), recent = bars.slice(-3), barCloses = bars.map((row) => row.close)
    result[`${prefix}tf${frame}Return`] = recent.length >= 2 ? direction * pct(recent.at(-1).close, recent[0].open) : NaN
    result[`${prefix}tf${frame}Rsi`] = direction * (rsi(barCloses, 5) - 50)
    result[`${prefix}tf${frame}Trend`] = direction * regression(barCloses.slice(-4)).slopePct
  }
  return result
}
function loadCandles(symbol) {
  const byDate = new Map()
  for (const row of jsonl(path.join(CANDLES, `${symbol}.jsonl`))) {
    const at = Number(row.time) * 1000, date = dateOf(at), candle = { at, open: Number(row.open), high: Number(row.high), low: Number(row.low), close: Number(row.close), volume: Number(row.volume) }
    if (!Object.values(candle).every(Number.isFinite)) continue
    if (!byDate.has(date)) byDate.set(date, [])
    byDate.get(date).push(candle)
  }
  for (const rows of byDate.values()) rows.sort((left, right) => left.at - right.at)
  return byDate
}
function validBook(fields) {
  let bid = 0, ask = 0, topBid = 0, topAsk = 0, bidOrders = 0, askOrders = 0
  for (let level = 1; level <= 5; level++) {
    const bp = Number(fields[`bid_price${level}`]), ap = Number(fields[`ask_price${level}`]), bs = Number(fields[`bid_size${level}`]), as = Number(fields[`ask_size${level}`])
    const bo = Number(fields[`bid_order${level}`]), ao = Number(fields[`ask_order${level}`])
    if (![bp, ap, bs, as].every(Number.isFinite) || bp <= 0 || ap <= bp || bs < 0 || as < 0) return null
    bid += bs; ask += as; bidOrders += Number.isFinite(bo) ? bo : 0; askOrders += Number.isFinite(ao) ? ao : 0
    if (level <= 2) { topBid += bs; topAsk += as }
  }
  const bid1 = Number(fields.bid_price1), ask1 = Number(fields.ask_price1)
  return { bid1, ask1, bid, ask, bidSize1: Number(fields.bid_size1), askSize1: Number(fields.ask_size1),
    full: (bid - ask) / (bid + ask || 1), top2: (topBid - topAsk) / (topBid + topAsk || 1),
    orderImbalance: (bidOrders - askOrders) / (bidOrders + askOrders || 1), mid: (bid1 + ask1) / 2 }
}
function loadDepth(symbol, date) {
  const fields = {}, samples = []; let previous = null
  for (const record of jsonl(path.join(DEPTH, date, symbol, `${symbol}.jsonl`))) {
    const at = Date.parse(record.receivedAt); if (!Number.isFinite(at)) continue
    if (record.kind === "checkpoint" || record.book) { for (const key of Object.keys(fields)) delete fields[key]; Object.assign(fields, record.data) }
    else if (record.kind === "update") Object.assign(fields, record.data); else continue
    const book = validBook(fields); if (!book) continue
    const price = Number(record.marketContext?.price), volume = Number(record.marketContext?.cumulativeVolume)
    let signedDelta = 0, traded = 0, ofi = 0
    if (previous) {
      traded = Number.isFinite(volume) && volume >= previous.volume ? volume - previous.volume : 0
      const tradeSign = price > previous.price ? 1 : price < previous.price ? -1 : 0
      signedDelta = traded * tradeSign
      const bidFlow = book.bid1 > previous.bid1 ? book.bidSize1 : book.bid1 === previous.bid1 ? book.bidSize1 - previous.bidSize1 : -previous.bidSize1
      const askFlow = book.ask1 < previous.ask1 ? book.askSize1 : book.ask1 === previous.ask1 ? book.askSize1 - previous.askSize1 : -previous.askSize1
      ofi = (bidFlow - askFlow) / ((book.bidSize1 + book.askSize1 + previous.bidSize1 + previous.askSize1) / 2 || 1)
    }
    samples.push({ at, traded, signedDelta, ofi, ...book })
    previous = { ...book, price, volume }
  }
  return samples
}
function depthFeatures(samples, signalAt, side) {
  const rows = samples.filter((row) => row.at >= signalAt - 3 * MINUTE && row.at <= signalAt)
  if (rows.length < 3) return { depthAvailable: 0 }
  const direction = side === "BUY" ? 1 : -1, first = rows[0], last = rows.at(-1), traded = rows.reduce((sum, row) => sum + row.traded, 0)
  const transitions = rows.slice(1)
  return { depthAvailable: 1, depthSamples3m: rows.length, depthLastAgeSec: (signalAt - last.at) / 1000,
    depthDeltaRatio: traded ? direction * rows.reduce((sum, row) => sum + row.signedDelta, 0) / traded : 0,
    depthOfi3m: direction * mean(rows.map((row) => row.ofi)), depthFull3m: direction * mean(rows.map((row) => row.full)),
    depthTop2_3m: direction * mean(rows.map((row) => row.top2)), depthOrderImbalance: direction * mean(rows.map((row) => row.orderImbalance)),
    depthImbalanceChange: direction * (last.full - first.full), depthTop2Change: direction * (last.top2 - first.top2),
    depthMidReturn3m: direction * pct(last.mid, first.mid), depthBidImprovementPct: transitions.length ? 100 * transitions.filter((row, index) => direction * (row.bid1 - rows[index].bid1) > 0).length / transitions.length : 0,
    depthAskImprovementPct: transitions.length ? 100 * transitions.filter((row, index) => direction * (row.ask1 - rows[index].ask1) > 0).length / transitions.length : 0,
  }
}

const rows = parseCsv(INPUT), stockCache = new Map(), nifty = loadCandles("NIFTY50")
const grouped = Map.groupBy(rows, (row) => `${row.date}|${row.symbol}`)
for (const [key, group] of grouped) {
  const [date, symbol] = key.split("|")
  if (!stockCache.has(symbol)) stockCache.set(symbol, loadCandles(symbol))
  const stock = stockCache.get(symbol).get(date) || [], depth = loadDepth(symbol, date), niftyRows = nifty.get(date) || []
  for (const row of group) {
    // The entry time is the next candle's open; the crossover candle closes at
    // precisely that timestamp, which is the latest causal feature time.
    const signalAt = epoch(row.date, row.entryTime)
    Object.assign(row, candleFeatures(stock, signalAt, row.side, "stock"), candleFeatures(niftyRows, signalAt, row.side, "nifty"), depthFeatures(depth, signalAt, row.side))
  }
}
const fields = [...new Set(rows.flatMap((row) => Object.keys(row)))]
fs.writeFileSync(OUTPUT, `${[fields.join(","), ...rows.map((row) => fields.map((field) => csvValue(round(row[field]) !== "" ? round(row[field]) : row[field])).join(","))].join("\n")}\n`)
console.log(JSON.stringify({ output: OUTPUT, rows: rows.length, depthAvailable: rows.filter((row) => Number(row.depthAvailable) === 1).length,
  features: fields.filter((field) => /^(stock|nifty|depth)/.test(field)).length }, null, 2))
