import fs from 'node:fs'
import path from 'node:path'
import { depthUpdateFields } from '../ui/market-depth.js'

const symbol = (process.argv[2] ?? 'PGEL').replace(/^NSE:/, '').replace(/-EQ$/, '').toUpperCase()
const date = process.argv[3] ?? '2026-10-26'
const from = process.argv[4] ?? '09:15', to = process.argv[5] ?? '10:00'
const root = process.cwd(), start = Date.parse(`${date}T${from}:00+05:30`), end = Date.parse(`${date}T${to}:00+05:30`)
const round = (value, digits = 4) => Number.isFinite(value) ? Number(value.toFixed(digits)) : null
const pct = (value, base) => base ? 100 * (value / base - 1) : null
const time = timestamp => new Date(timestamp + 330 * 60_000).toISOString().slice(11, 16)
const readRows = file => fs.readFileSync(file, 'utf8').split(/\r?\n/).flatMap(line => {
  if (!line.trim()) return []
  try { return [JSON.parse(line)] } catch { return [] }
})

const candleFile = path.join(root, 'db', 'candles', `${symbol}.jsonl`)
const candles = new Map(readRows(candleFile).flatMap(row => {
  const timestamp = Number(row.time) * 1000
  return timestamp >= start && timestamp < end ? [[timestamp, row]] : []
}))
const depthFile = path.join(root, 'db', 'cash-depth', date, symbol, `${symbol}.jsonl`)
if (!fs.existsSync(depthFile)) throw new Error(`Missing depth file: ${depthFile}`)

const fields = {}, buckets = new Map()
let previous = null
for (const record of readRows(depthFile)) {
  const at = Date.parse(record.receivedAt)
  if (!Number.isFinite(at) || at < start || at >= end) continue
  if (record.kind === 'checkpoint') for (const key of Object.keys(fields)) delete fields[key]
  const update = depthUpdateFields(record.data)
  if (!update) continue
  for (const [key, value] of update) fields[key] = value
  const bids = Array.from({ length: 5 }, (_, index) => Number(fields[`bid_size${index + 1}`]))
  const asks = Array.from({ length: 5 }, (_, index) => Number(fields[`ask_size${index + 1}`]))
  const bidOrders = Array.from({ length: 5 }, (_, index) => Number(fields[`bid_order${index + 1}`]))
  const askOrders = Array.from({ length: 5 }, (_, index) => Number(fields[`ask_order${index + 1}`]))
  const bid = Number(fields.bid_price1), ask = Number(fields.ask_price1)
  if (![...bids, ...asks, ...bidOrders, ...askOrders, bid, ask].every(Number.isFinite) || bid <= 0 || ask <= bid) continue
  const bidSum = bids.reduce((sum, value) => sum + value, 0), askSum = asks.reduce((sum, value) => sum + value, 0)
  const bid2 = bids[0] + bids[1], ask2 = asks[0] + asks[1]
  const bidOrderSum = bidOrders.reduce((sum, value) => sum + value, 0), askOrderSum = askOrders.reduce((sum, value) => sum + value, 0)
  const validPrevious = previous && at - previous.at <= 90_000 ? previous : null
  const ofi = validPrevious ? (bid >= validPrevious.bid ? bids[0] : 0) - (bid <= validPrevious.bid ? validPrevious.bid1 : 0) - (ask <= validPrevious.ask ? asks[0] : 0) + (ask >= validPrevious.ask ? validPrevious.ask1 : 0) : 0
  const ofiDepth = validPrevious ? (bids[0] + asks[0] + validPrevious.bid1 + validPrevious.ask1) / 2 : 0
  const minute = Math.floor(at / 60_000) * 60_000
  const bucket = buckets.get(minute) ?? { minute, updates: 0, full: 0, top2: 0, orders: 0, ofi: 0, ofiDepth: 0, firstMid: (bid + ask) / 2, lastMid: (bid + ask) / 2, minMid: Infinity, maxMid: -Infinity }
  bucket.updates++
  bucket.full += (bidSum - askSum) / (bidSum + askSum || 1)
  bucket.top2 += (bid2 - ask2) / (bid2 + ask2 || 1)
  bucket.orders += (bidOrderSum - askOrderSum) / (bidOrderSum + askOrderSum || 1)
  bucket.ofi += ofi; bucket.ofiDepth += ofiDepth
  bucket.lastMid = (bid + ask) / 2; bucket.minMid = Math.min(bucket.minMid, bucket.lastMid); bucket.maxMid = Math.max(bucket.maxMid, bucket.lastMid)
  buckets.set(minute, bucket)
  previous = { at, bid, ask, bid1: bids[0], ask1: asks[0] }
}

const rows = [...buckets.values()].sort((a, b) => a.minute - b.minute).map(bucket => {
  const candle = candles.get(bucket.minute)
  return { time: time(bucket.minute), updates: bucket.updates,
    fullImbalancePct: round(100 * bucket.full / bucket.updates), top2ImbalancePct: round(100 * bucket.top2 / bucket.updates), orderImbalancePct: round(100 * bucket.orders / bucket.updates),
    normalizedOfiPct: round(100 * bucket.ofi / (bucket.ofiDepth || 1)), midpointMovePct: round(pct(bucket.lastMid, bucket.firstMid)), midpoint: round(bucket.lastMid),
    open: candle?.open ?? null, high: candle?.high ?? null, low: candle?.low ?? null, close: candle?.close ?? null, candleReturnPct: candle ? round(pct(candle.close, candle.open)) : null, volume: candle?.volume ?? null }
})
const avg = (items, key) => items.length ? round(items.reduce((sum, row) => sum + (row[key] ?? 0), 0) / items.length) : null
const windows = [['09:15','09:24'],['09:25','09:29'],['09:30','09:34'],['09:35','09:39'],['09:40','09:44'],['09:45','09:49'],['09:50','09:54'],['09:55','09:59']].map(([windowFrom, windowTo]) => {
  const items = rows.filter(row => row.time >= windowFrom && row.time <= windowTo)
  return { window: `${windowFrom}-${windowTo}`, minutes: items.length, fullImbalancePct: avg(items, 'fullImbalancePct'), top2ImbalancePct: avg(items, 'top2ImbalancePct'), orderImbalancePct: avg(items, 'orderImbalancePct'), normalizedOfiPct: avg(items, 'normalizedOfiPct'), midpointMovePct: items.length ? round(pct(items.at(-1).midpoint, items[0].midpoint)) : null, priceMovePct: items.length && items[0].open && items.at(-1).close ? round(pct(items.at(-1).close, items[0].open)) : null, volume: items.reduce((sum, row) => sum + (row.volume ?? 0), 0) }
})
let reportFile = path.join(root, 'reports', `${date}-${symbol}-0915-1000-depth-flow.json`), suffix = 2
while (fs.existsSync(reportFile)) reportFile = path.join(root, 'reports', `${date}-${symbol}-0915-1000-depth-flow-${suffix++}.json`)
let csvFile = reportFile.replace(/\.json$/, '.csv')
const report = { symbol, date, from, to, note: 'Displayed five-level depth and quote-derived OFI; not exchange-confirmed executed order flow. Positive values favor bids/buying.', windows, minutes: rows }
fs.writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' })
const columns = Object.keys(rows[0] ?? { time: '' })
fs.writeFileSync(csvFile, `${columns.join(',')}\n${rows.map(row => columns.map(key => row[key] ?? '').join(',')).join('\n')}\n`, { flag: 'wx' })
console.log(JSON.stringify({ reportFile, csvFile, windows, minutes: rows }, null, 2))
