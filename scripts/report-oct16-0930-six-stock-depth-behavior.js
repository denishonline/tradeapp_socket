import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = process.cwd()
const date = '2026-10-16'
const symbols = ['TECHM', 'WIPRO', 'KPITTECH', 'TCS', 'DALBHARAT', 'INFY']
const round = (n, digits = 3) => Number.isFinite(n) ? Number(n.toFixed(digits)) : null
const mean = values => values.length ? values.reduce((sum, n) => sum + n, 0) / values.length : null
const time = ms => new Date(ms + 330 * 60_000).toISOString().slice(11, 19)

function snapshot(state, at) {
  const bids = [1, 2, 3, 4, 5].map(i => ({ price: Number(state[`bid_price${i}`]), size: Number(state[`bid_size${i}`]) }))
  const asks = [1, 2, 3, 4, 5].map(i => ({ price: Number(state[`ask_price${i}`]), size: Number(state[`ask_size${i}`]) }))
  if ([...bids, ...asks].some(level => !Number.isFinite(level.price) || !Number.isFinite(level.size) || level.price <= 0 || level.size < 0) ||
      bids[0].price >= asks[0].price) return null
  const bidSize = bids.reduce((sum, level) => sum + level.size, 0)
  const askSize = asks.reduce((sum, level) => sum + level.size, 0)
  const mid = (bids[0].price + asks[0].price) / 2
  return { at, bid1: bids[0].price, ask1: asks[0].price, bid5: bids[4].price, ask5: asks[4].price,
    bidSize, askSize, bidSharePct: 100 * bidSize / (bidSize + askSize),
    spreadBps: 10000 * (asks[0].price - bids[0].price) / mid, mid }
}

export function analyzeDepthSession(symbol, date, cutoff = '09:30') {
  const start = Date.parse(`${date}T09:15:00+05:30`)
  const end = Date.parse(`${date}T${cutoff}:00+05:30`)
  const file = path.join(root, 'db/cash-depth', date, symbol, `${symbol}.jsonl`)
  if (!fs.existsSync(file)) return { symbol, available: false }
  const state = {}
  const minuteLast = new Map()
  let first = null, last = null, events = 0, valid = 0
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue
    let event
    try { event = JSON.parse(line) } catch { continue }
    const at = Date.parse(event.receivedAt)
    if (!Number.isFinite(at)) continue
    if (at >= end) break
    if (event.data) Object.assign(state, event.data)
    if (at < start) continue
    events++
    const book = snapshot(state, at)
    if (!book) continue
    valid++
    first ??= book
    last = book
    minuteLast.set(Math.floor((at - start) / 60_000), book)
  }
  const minutes = [...minuteLast].sort((a, b) => a[0] - b[0]).map(([index, book]) => ({
    minute: time(start + index * 60_000).slice(0, 5), lastBookAt: time(book.at),
    bid1: book.bid1, ask1: book.ask1, bid5: book.bid5, ask5: book.ask5,
    bidSize: book.bidSize, askSize: book.askSize,
    bidSharePct: round(book.bidSharePct, 2), spreadBps: round(book.spreadBps, 2), mid: book.mid,
  }))
  if (!first) return { symbol, available: false, depthEvents: events, validBooks: 0 }
  const early = minutes.filter(row => row.minute < '09:23')
  const late = minutes.filter(row => row.minute >= '09:23')
  const summary = { symbol, available: true, depthEvents: events, validBooks: valid,
    observedMinutes: minutes.length, firstBookAt: time(first.at), lastBookAt: time(last.at),
    firstBidSharePct: round(first.bidSharePct, 2), lastBidSharePct: round(last.bidSharePct, 2),
    meanMinuteEndBidSharePct: round(mean(minutes.map(row => row.bidSharePct)), 2),
    bidDominantMinutes: minutes.filter(row => row.bidSharePct > 50).length,
    earlyMeanBidSharePct: round(mean(early.map(row => row.bidSharePct)), 2),
    lateMeanBidSharePct: round(mean(late.map(row => row.bidSharePct)), 2),
    meanMinuteEndSpreadBps: round(mean(minutes.map(row => row.spreadBps)), 2),
    firstBid1: first.bid1, lastBid1: last.bid1, firstAsk1: first.ask1, lastAsk1: last.ask1,
    bestBidMovePct: round(100 * (last.bid1 / first.bid1 - 1)),
    bestAskMovePct: round(100 * (last.ask1 / first.ask1 - 1)),
    quoteMidMovePct: round(100 * (last.mid / first.mid - 1)),
    bidLadderMovePct: round(100 * (last.bid5 / first.bid5 - 1)),
    askLadderMovePct: round(100 * (last.ask5 / first.ask5 - 1)) }
  return { ...summary, minutes }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
const output = { date, windowIST: '09:15:00–09:29:59',
  method: 'Read cash-depth events by receivedAt. Apply data updates to five displayed bid and ask levels. For each minute with data, take the last valid book; averages and bid-dominant counts weight observed minutes equally. Bid share = sum(bid sizes 1..5)/(sum bid sizes + sum ask sizes). Early = before 09:23; late = 09:23 onward. Spread = 10000*(ask1-bid1)/quote midpoint. Quote moves compare first and last observed books in the window.',
  caveat: 'Displayed sizes are changing quotes, not executed buy/sell volume. Depth starts after 09:15 for these symbols, so the first minute can be unobserved. No future depth is used.',
  source: 'db/cash-depth/2026-10-16/<SYMBOL>/<SYMBOL>.jsonl', stocks: symbols.map(symbol => analyzeDepthSession(symbol, date)) }
let n = 1, file
do { file = path.join(root, 'reports', `2026-10-16-0930-six-stock-depth-behavior${n === 1 ? '' : `-${n}`}.json`); n++ } while (fs.existsSync(file))
fs.writeFileSync(file, JSON.stringify(output, null, 2) + '\n', { flag: 'wx' })
console.log(JSON.stringify({ file, summaries: output.stocks.map(({ minutes, ...rest }) => rest) }, null, 2))
}
