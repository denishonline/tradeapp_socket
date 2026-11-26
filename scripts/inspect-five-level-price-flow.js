import fs from 'node:fs'
import path from 'node:path'

const [date, symbol, from, to] = process.argv.slice(2)
if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '') || !symbol || !/^\d\d:\d\d$/.test(from || '') || !/^\d\d:\d\d$/.test(to || '')) {
  throw new Error('Usage: node scripts/inspect-five-level-price-flow.js YYYY-MM-DD SYMBOL HH:MM HH:MM')
}
const start = Date.parse(`${date}T${from}:00+05:30`)
const end = Date.parse(`${date}T${to}:00+05:30`)
if (!(end > start)) throw new Error('End must be later than start')
const minute = 60_000
const ist = (at) => new Date(at + 330 * minute).toISOString().slice(11, 19)
const n = (value, digits = 2) => Number(value.toFixed(digits))
const depthFile = path.join(process.cwd(), 'db', 'cash-depth', date, symbol, `${symbol}.jsonl`)
const books = [], trades = []
let lastTradeAt = -Infinity
for (const line of fs.readFileSync(depthFile, 'utf8').split(/\r?\n/)) {
  const match = line.match(/"receivedAt":"([^"]+)"/)
  if (!match) continue
  const receivedAt = Date.parse(match[1])
  if (receivedAt >= end) break
  if (receivedAt < start - 10_000) continue
  const row = JSON.parse(line)
  const bid = [], ask = []
  for (let i = 1; i <= 5; i++) {
    bid.push({ price: +row.data[`bid_price${i}`], size: +row.data[`bid_size${i}`] })
    ask.push({ price: +row.data[`ask_price${i}`], size: +row.data[`ask_size${i}`] })
  }
  if (bid[0].price > 0 && ask[0].price > bid[0].price &&
      [...bid, ...ask].every((x) => Number.isFinite(x.price) && Number.isFinite(x.size))) {
    books.push({ receivedAt, bid, ask })
  }
  const m = row.marketContext, at = Date.parse(m?.priceAt)
  if (Number.isFinite(at) && at > lastTradeAt && at < end && Number.isFinite(+m.price) && Number.isFinite(+m.cumulativeVolume)) {
    trades.push({ at, price: +m.price, cumulativeVolume: +m.cumulativeVolume })
    lastTradeAt = at
  }
}
const summary = new Map()
for (let at = start; at < end; at += minute) {
  summary.set(at, { minute: ist(at).slice(0, 5), books: [], tradeObservations: 0,
    priorBookMatched: 0, atOrAboveAsk1: 0, atOrAboveAsk5: 0, atOrBelowBid1: 0,
    atOrBelowBid5: 0, insideSpread: 0, noRecentPriorBook: 0, maxPriorBookAgeMs: 0,
    bestBidUp: 0, bestBidDown: 0, bestAskUp: 0, bestAskDown: 0,
    sameAskPriceSizeDown: 0, sameAskPriceSizeUp: 0, sameBidPriceSizeDown: 0,
    sameBidPriceSizeUp: 0 })
}
let prior = null
for (const book of books) {
  const b = summary.get(Math.floor(book.receivedAt / minute) * minute)
  if (!b) { prior = book; continue }
  b.books.push(book)
  if (prior) {
    if (book.bid[0].price > prior.bid[0].price) b.bestBidUp++
    if (book.bid[0].price < prior.bid[0].price) b.bestBidDown++
    if (book.ask[0].price > prior.ask[0].price) b.bestAskUp++
    if (book.ask[0].price < prior.ask[0].price) b.bestAskDown++
    for (const side of ['bid', 'ask']) {
      const previousByPrice = new Map(prior[side].map((x) => [x.price, x.size]))
      for (const level of book[side]) {
        if (!previousByPrice.has(level.price)) continue
        const change = level.size - previousByPrice.get(level.price)
        if (change < 0) b[side === 'ask' ? 'sameAskPriceSizeDown' : 'sameBidPriceSizeDown']++
        if (change > 0) b[side === 'ask' ? 'sameAskPriceSizeUp' : 'sameBidPriceSizeUp']++
      }
    }
  }
  prior = book
}
// Align each observed last-traded price to the most recently received book no later than its timestamp.
// Do not assign the cumulative-volume increase to that price: it may contain multiple executions.
let index = -1
const largestObservedIncrements = []
let priorTrade = null
for (const trade of trades) {
  while (index + 1 < books.length && books[index + 1].receivedAt <= trade.at) index++
  const b = summary.get(Math.floor(trade.at / minute) * minute)
  if (!b) { priorTrade = trade; continue }
  b.tradeObservations++
  const book = books[index]
  if (priorTrade && trade.cumulativeVolume > priorTrade.cumulativeVolume) {
    largestObservedIncrements.push({ time: ist(trade.at), volumeIncrease: trade.cumulativeVolume - priorTrade.cumulativeVolume,
      priorLastPrice: priorTrade.price, sampledLastPrice: trade.price,
      priorBestBid: book?.bid[0].price ?? null, priorBestAsk: book?.ask[0].price ?? null,
      priorBid5: book?.bid[4].price ?? null, priorAsk5: book?.ask[4].price ?? null })
  }
  priorTrade = trade
  if (!book || trade.at - book.receivedAt > 3000) { b.noRecentPriorBook++; continue }
  b.priorBookMatched++
  b.maxPriorBookAgeMs = Math.max(b.maxPriorBookAgeMs, trade.at - book.receivedAt)
  if (trade.price >= book.ask[0].price) b.atOrAboveAsk1++
  if (trade.price >= book.ask[4].price) b.atOrAboveAsk5++
  if (trade.price <= book.bid[0].price) b.atOrBelowBid1++
  if (trade.price <= book.bid[4].price) b.atOrBelowBid5++
  if (trade.price > book.bid[0].price && trade.price < book.ask[0].price) b.insideSpread++
}
const rows = [...summary.values()].map(({ books: minuteBooks, ...b }) => ({
  ...b, bookUpdates: minuteBooks.length,
  firstBookAt: minuteBooks[0] ? ist(minuteBooks[0].receivedAt) : null,
  lastBookAt: minuteBooks.at(-1) ? ist(minuteBooks.at(-1).receivedAt) : null,
  firstBestBid: minuteBooks[0]?.bid[0].price ?? null,
  lastBestBid: minuteBooks.at(-1)?.bid[0].price ?? null,
  firstBestAsk: minuteBooks[0]?.ask[0].price ?? null,
  lastBestAsk: minuteBooks.at(-1)?.ask[0].price ?? null,
  firstBid5: minuteBooks[0]?.bid[4].price ?? null,
  lastBid5: minuteBooks.at(-1)?.bid[4].price ?? null,
  firstAsk5: minuteBooks[0]?.ask[4].price ?? null,
  lastAsk5: minuteBooks.at(-1)?.ask[4].price ?? null,
}))
console.log(JSON.stringify({ date, symbol, from, to, note: 'The feed contains five displayed quote levels and sampled last-traded prices, not executions by price level. Quote-size reductions may be trades or cancellations. Each trade observation is a last price, not the entire cumulative-volume increment.',
  largestObservedIncrements: largestObservedIncrements.sort((a, b) => b.volumeIncrease - a.volumeIncrease).slice(0, 5), rows }, null, 2))
