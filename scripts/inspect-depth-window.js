import fs from 'node:fs'
import path from 'node:path'

const [date, symbol, from, to] = process.argv.slice(2)
if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '') || !symbol || !/^\d\d:\d\d$/.test(from || '') || !/^\d\d:\d\d$/.test(to || '')) {
  throw new Error('Usage: node scripts/inspect-depth-window.js YYYY-MM-DD SYMBOL HH:MM HH:MM')
}
const root = process.cwd()
const start = Date.parse(`${date}T${from}:00+05:30`)
const end = Date.parse(`${date}T${to}:00+05:30`)
if (!(end > start)) throw new Error('End must be after start')
const minute = 60_000
const label = (at) => new Date(at + 330 * minute).toISOString().slice(11, 16)
const avg = (items) => items.length ? items.reduce((a, b) => a + b, 0) / items.length : null
const round = (value, digits = 3) => Number.isFinite(value) ? Number(value.toFixed(digits)) : null
const pct = (value, base) => base > 0 ? 100 * (value / base - 1) : null
const bars = new Map()
for (const line of fs.readFileSync(path.join(root, 'db', 'candles', `${symbol}.jsonl`), 'utf8').split(/\r?\n/)) {
  if (!line) continue
  const candle = JSON.parse(line), at = candle.time * 1000
  if (at >= start && at < end && !candle.partial) bars.set(at, candle)
}
const buckets = new Map([...bars].map(([at, candle]) => [at, { candle, books: [], ofi: [], tickVolume: 0, tickSigned: 0 }]))
function getBook(d) {
  const bids = [], asks = []
  for (let i = 1; i <= 5; i++) {
    bids.push({ price: +d[`bid_price${i}`], size: +d[`bid_size${i}`] })
    asks.push({ price: +d[`ask_price${i}`], size: +d[`ask_size${i}`] })
  }
  if (bids.some((x) => !(x.price > 0 && x.size >= 0)) || asks.some((x) => !(x.price > 0 && x.size >= 0)) || bids[0].price >= asks[0].price) return null
  const bidSize = bids.reduce((sum, x) => sum + x.size, 0)
  const askSize = asks.reduce((sum, x) => sum + x.size, 0)
  return { bid: bids[0].price, ask: asks[0].price, bid1: bids[0].size, ask1: asks[0].size,
    bidShare: 100 * bidSize / (bidSize + askSize),
    topBidShare: 100 * bids[0].size / (bids[0].size + asks[0].size),
    spreadBps: 10_000 * (asks[0].price - bids[0].price) / ((bids[0].price + asks[0].price) / 2) }
}
let previousBook = null, previousTrade = null, tick = 0, lastReceived = null, lastTradeAt = null
const largestIncrements = []
let samples = 0
const file = path.join(root, 'db', 'cash-depth', date, symbol, `${symbol}.jsonl`)
for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
  const match = line.match(/"receivedAt":"([^"]+)"/)
  if (!match) continue
  const at = Date.parse(match[1])
  if (at >= end) break
  if (at < start - minute) continue
  const row = JSON.parse(line)
  const book = getBook(row.data)
  if (!book) continue
  const b = buckets.get(Math.floor(at / minute) * minute)
  if (b) {
    b.books.push({ at, ...book })
    samples++
    lastReceived = at
    if (previousBook && at - previousBook.at <= 90_000) {
      const p = previousBook.book
      const ofi = (book.bid >= p.bid ? book.bid1 : 0) - (book.bid <= p.bid ? p.bid1 : 0) -
        (book.ask <= p.ask ? book.ask1 : 0) + (book.ask >= p.ask ? p.ask1 : 0)
      b.ofi.push(ofi / ((book.bid1 + book.ask1 + p.bid1 + p.ask1) / 2 || 1))
    }
  }
  previousBook = { at, book }
  const trade = row.marketContext, tradeAt = Date.parse(trade?.priceAt)
  const price = +trade?.price, volume = +trade?.cumulativeVolume
  if (!Number.isFinite(tradeAt) || tradeAt >= end || !(price > 0) || !Number.isFinite(volume) ||
      (previousTrade && tradeAt <= previousTrade.at)) continue
  const tradeBucket = buckets.get(Math.floor(tradeAt / minute) * minute)
  if (tradeBucket && previousTrade) {
    if (price > previousTrade.price) tick = 1
    else if (price < previousTrade.price) tick = -1
    const increment = Math.max(0, volume - previousTrade.volume)
    tradeBucket.tickVolume += increment
    tradeBucket.tickSigned += increment * tick
    if (increment > 0) largestIncrements.push({ time: new Date(tradeAt + 330 * minute).toISOString().slice(11, 19), volume: increment,
      fromPrice: previousTrade.price, toPrice: price, tickDirection: tick })
    lastTradeAt = tradeAt
  }
  previousTrade = { at: tradeAt, price, volume }
}
const rows = [...buckets].map(([at, b]) => {
  const c = b.candle, books = b.books
  return { minute: label(at), close: c.close, candleReturnPct: round(pct(c.close, c.open)), volume: c.volume,
    depthUpdates: books.length, meanBidSharePct: round(avg(books.map((x) => x.bidShare))),
    bidDominantUpdatesPct: books.length ? round(100 * books.filter((x) => x.bidShare > 50).length / books.length) : null,
    meanTopBidSharePct: round(avg(books.map((x) => x.topBidShare))),
    meanSpreadBps: round(avg(books.map((x) => x.spreadBps))),
    normalizedOfi: round(avg(b.ofi)),
    midReturnPct: books.length > 1 ? round(pct((books.at(-1).bid + books.at(-1).ask) / 2, (books[0].bid + books[0].ask) / 2)) : null,
    tickProxyVolume: b.tickVolume, tickProxyDeltaPct: b.tickVolume ? round(100 * b.tickSigned / b.tickVolume) : null }
})
console.log(JSON.stringify({ date, symbol, from, to, samples, lastReceived: lastReceived && label(lastReceived),
  lastTradeAt: lastTradeAt && label(lastTradeAt),
  largestIncrements: largestIncrements.sort((a, b) => b.volume - a.volume).slice(0, 8),
  tickRuleCaveat: 'Tick-rule signed volume is estimated from sampled prices and cumulative volume; displayed five-level sizes are not executed trades or true footprints.',
  overall: { candleReturnPct: round(pct(rows.at(-1)?.close, rows[0]?.close)),
    meanBidSharePct: round(avg(rows.filter((x) => x.depthUpdates).map((x) => x.meanBidSharePct))),
    tickProxyVolume: rows.reduce((sum, x) => sum + x.tickProxyVolume, 0),
    tickProxyDeltaPct: round(100 * [...buckets.values()].reduce((sum, x) => sum + x.tickSigned, 0) /
      ([...buckets.values()].reduce((sum, x) => sum + x.tickVolume, 0) || 1)) }, rows }, null, 2))
