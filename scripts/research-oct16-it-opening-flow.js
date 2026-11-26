import fs from 'node:fs'
import path from 'node:path'

const root = process.cwd()
const date = '2026-10-16'
const symbols = ['WIPRO', 'TECHM', 'KPITTECH', 'TCS', 'INFY']
const contextSymbols = ['NIFTYIT', 'NIFTY50']
const start = Date.parse(`${date}T09:15:00+05:30`)
const cutoff = Date.parse(`${date}T09:25:00+05:30`)
const minuteMs = 60_000
const pct = (a, b) => b ? 100 * (a / b - 1) : null
const mean = (a) => a.length ? a.reduce((x, y) => x + y, 0) / a.length : null
const round = (n, d = 2) => Number.isFinite(n) ? Number(n.toFixed(d)) : null
const time = (ms) => new Date(ms + 330 * minuteMs).toISOString().slice(11, 19)
const lines = (file) => fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean)

function candles(symbol) {
  const file = path.join(root, 'db', 'candles', `${symbol}.jsonl`)
  return lines(file).map(JSON.parse).filter((row) => {
    const at = row.time * 1000
    return at >= start && at < cutoff && !row.partial
  }).sort((a, b) => a.time - b.time)
}

function book(data) {
  const bids = [], asks = []
  for (let level = 1; level <= 5; level++) {
    bids.push({ price: Number(data[`bid_price${level}`]), size: Number(data[`bid_size${level}`]) })
    asks.push({ price: Number(data[`ask_price${level}`]), size: Number(data[`ask_size${level}`]) })
  }
  if (bids.some((x) => !Number.isFinite(x.price) || !Number.isFinite(x.size)) ||
      asks.some((x) => !Number.isFinite(x.price) || !Number.isFinite(x.size)) ||
      bids[0].price >= asks[0].price) return null
  const bidTotal = bids.reduce((sum, x) => sum + x.size, 0)
  const askTotal = asks.reduce((sum, x) => sum + x.size, 0)
  const bid2 = bids[0].size + bids[1].size
  const ask2 = asks[0].size + asks[1].size
  return { bid: bids[0].price, ask: asks[0].price, bid1: bids[0].size,
    ask1: asks[0].size, bidShare: 100 * bidTotal / (bidTotal + askTotal),
    bid2Share: 100 * bid2 / (bid2 + ask2),
    spreadBps: 10000 * (asks[0].price - bids[0].price) / ((asks[0].price + bids[0].price) / 2) }
}

function analyze(symbol) {
  const bars = candles(symbol)
  const bucket = new Map(bars.map((c) => [c.time * 1000, { candle: c, samples: [], ofi: [], proxyVolume: 0, proxySigned: 0 }]))
  const depthFile = path.join(root, 'db', 'cash-depth', date, symbol, `${symbol}.jsonl`)
  let previous = null, lastTrade = null, tick = 0
  let firstDepth = null, lastDepth = null, firstTrade = null, lastTradeAt = null
  let validDepth = 0, distinctTrades = 0
  for (const line of lines(depthFile)) {
    const match = line.match(/"receivedAt":"([^"]+)"/)
    if (!match) continue
    const at = Date.parse(match[1])
    if (at >= cutoff) break
    if (at < start) continue
    const row = JSON.parse(line)
    const current = book(row.data)
    if (!current) continue
    const minute = Math.floor(at / minuteMs) * minuteMs
    const b = bucket.get(minute)
    if (!b) continue
    firstDepth ??= at
    lastDepth = at
    validDepth++
    b.samples.push({ at, ...current })
    if (previous && at - previous.at <= 90_000) {
      const p = previous.book
      const ofi = (current.bid >= p.bid ? current.bid1 : 0) -
        (current.bid <= p.bid ? p.bid1 : 0) -
        (current.ask <= p.ask ? current.ask1 : 0) +
        (current.ask >= p.ask ? p.ask1 : 0)
      b.ofi.push(ofi / ((current.bid1 + current.ask1 + p.bid1 + p.ask1) / 2 || 1))
    }
    previous = { at, book: current }
    const mc = row.marketContext
    const price = Number(mc?.price), volume = Number(mc?.cumulativeVolume)
    const tradeAt = Date.parse(mc?.priceAt)
    if (!Number.isFinite(tradeAt) || tradeAt >= cutoff || tradeAt < start ||
        !Number.isFinite(price) || !Number.isFinite(volume) ||
        (lastTrade && tradeAt <= lastTrade.at)) continue
    const tradeBucket = bucket.get(Math.floor(tradeAt / minuteMs) * minuteMs)
    if (!tradeBucket) continue
    firstTrade ??= tradeAt
    lastTradeAt = tradeAt
    distinctTrades++
    if (lastTrade) {
      if (price > lastTrade.price) tick = 1
      else if (price < lastTrade.price) tick = -1
      const delta = Math.max(0, volume - lastTrade.volume)
      tradeBucket.proxyVolume += delta
      tradeBucket.proxySigned += delta * tick
    }
    lastTrade = { at: tradeAt, price, volume }
  }
  const minutes = [...bucket].map(([at, b]) => {
    const c = b.candle, s = b.samples
    const spread = mean(s.map((x) => x.spreadBps))
    return { minute: time(at).slice(0, 5), open: c.open, high: c.high, low: c.low,
      close: c.close, volume: c.volume, returnPct: round(pct(c.close, c.open), 3),
      closeLocationPct: round(c.high > c.low ? 100 * (c.close - c.low) / (c.high - c.low) : 50),
      depthSamples: s.length, bidSharePct: round(mean(s.map((x) => x.bidShare))),
      bid2SharePct: round(mean(s.map((x) => x.bid2Share))),
      bidDominantPct: s.length ? round(100 * s.filter((x) => x.bidShare > 50).length / s.length) : null,
      normalizedOfi: round(mean(b.ofi), 3), spreadBps: round(spread),
      midMovePct: s.length > 1 ? round(pct((s.at(-1).bid + s.at(-1).ask) / 2,
        (s[0].bid + s[0].ask) / 2), 3) : null,
      proxyVolume: b.proxyVolume, proxySignedVolume: b.proxySigned,
      proxyDeltaPct: b.proxyVolume ? round(100 * b.proxySigned / b.proxyVolume) : null }
  })
  const totalVolume = minutes.reduce((sum, x) => sum + x.volume, 0)
  const proxyVolume = minutes.reduce((sum, x) => sum + x.proxyVolume, 0)
  const proxySigned = minutes.reduce((sum, x) => sum + x.proxySignedVolume, 0)
  return { symbol, firstDepth: firstDepth ? time(firstDepth) : null,
    lastDepth: lastDepth ? time(lastDepth) : null, firstTrade: firstTrade ? time(firstTrade) : null,
    lastTrade: lastTradeAt ? time(lastTradeAt) : null, validDepth, distinctTrades,
    openingReturnPct: round(pct(bars.at(-1)?.close, bars[0]?.open), 3),
    totalVolume, proxyVolume, proxyCoveragePct: round(100 * proxyVolume / totalVolume),
    proxyDeltaPct: proxyVolume ? round(100 * proxySigned / proxyVolume) : null,
    meanBidSharePct: round(mean(minutes.filter((x) => x.depthSamples).map((x) => x.bidSharePct))),
    minutes }
}

const output = { date, window: '09:15–09:25 IST; candles 09:15–09:24; depth received before 09:25',
  caveat: 'Five-level displayed quotes only. Tick-rule signed volume and quote OFI are estimates, not exchange trade-side prints or price-level footprints.',
  indices: contextSymbols.map((symbol) => {
    const c = candles(symbol)
    return { symbol, openingReturnPct: round(pct(c.at(-1)?.close, c[0]?.open), 3),
      minutes: c.map((x) => ({ minute: time(x.time * 1000).slice(0, 5), returnPct: round(pct(x.close, x.open), 3) })) }
  }), stocks: symbols.map(analyze) }
const file = path.join(root, 'reports', '2026-10-16-0915-0925-it-candle-depth-flow.json')
if (fs.existsSync(file)) throw new Error(`Refusing to overwrite ${file}`)
fs.writeFileSync(file, JSON.stringify(output, null, 2) + '\n')
console.log(`Saved ${file}`)
for (const s of output.stocks) console.log(`${s.symbol}: ${s.openingReturnPct}% return, ${s.meanBidSharePct}% mean bid share, ${s.proxyDeltaPct}% tick proxy delta, ${s.validDepth} depth updates, ${s.proxyCoveragePct}% volume proxy coverage`)
