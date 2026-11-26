import fs from 'node:fs'
import path from 'node:path'

const date = process.argv[2] || '2026-10-16'
const onlySymbol = process.argv[3] || null
if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('Usage: node scripts/scan-ema-five-level-recovery.js YYYY-MM-DD [SYMBOL]')
const root = process.cwd()
const candleDir = path.join(root, 'db', 'candles')
const depthDir = path.join(root, 'db', 'cash-depth', date)
const start = Date.parse(`${date}T09:15:00+05:30`)
const end = Date.parse(`${date}T15:30:00+05:30`)
const minute = 60_000
const fmt = (at) => new Date(at + 330 * minute).toISOString().slice(11, 19)
const rnd = (x, d = 3) => Number(x.toFixed(d))
const median = (xs) => {
  if (!xs.length) return null
  const a = [...xs].sort((x, y) => x - y), mid = Math.floor(a.length / 2)
  return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2
}
const symbols = onlySymbol ? [onlySymbol] : [...new Set(JSON.parse(fs.readFileSync(path.join(root, 'db', 'stocks'), 'utf8')))]
const checks = { symbols: 0, withCandles: 0, withDepth: 0, emaCandidates: 0, recentCrossCandidates: 0,
  ladderPass: 0, priceTouchPass: 0, jumpRecoveryPass: 0, allPassMinutes: 0 }
const signals = []

function candles(symbol) {
  const file = path.join(candleDir, `${symbol}.jsonl`)
  if (!fs.existsSync(file)) return []
  const result = []
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!line) continue
    const c = JSON.parse(line), at = Number(c.time) * 1000
    if (at >= start && at < end && !c.partial) result.push({ ...c, at })
  }
  result.sort((a, b) => a.at - b.at)
  let ema10 = null, ema20 = null, lastBullishCross = null
  for (let i = 0; i < result.length; i++) {
    const c = result[i]
    const prior10 = ema10, prior20 = ema20
    ema10 = ema10 == null ? c.close : ema10 + (c.close - ema10) * 2 / 11
    ema20 = ema20 == null ? c.close : ema20 + (c.close - ema20) * 2 / 21
    if (i >= 19 && prior10 <= prior20 && ema10 > ema20) {
      lastBullishCross = { index: i, at: c.at, close: c.close }
    }
    c.ema10 = ema10
    c.ema20 = ema20
    c.priceEma10Pct = 100 * (c.close / ema10 - 1)
    c.ema10Ema20Pct = 100 * (ema10 / ema20 - 1)
    c.barsSinceBullishCross = lastBullishCross ? i - lastBullishCross.index : null
    c.bullishCrossAt = lastBullishCross?.at ?? null
    c.bullishCrossClose = lastBullishCross?.close ?? null
    c.riseFromCrossPct = lastBullishCross ? 100 * (c.close / lastBullishCross.close - 1) : null
  }
  return result
}

function depth(symbol) {
  const file = path.join(depthDir, symbol, `${symbol}.jsonl`)
  if (!fs.existsSync(file)) return null
  const books = [], trades = []
  let lastTradeAt = -Infinity
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = line.match(/"receivedAt":"([^"]+)"/)
    if (!match) continue
    const receivedAt = Date.parse(match[1])
    if (receivedAt >= end) break
    if (receivedAt < start) continue
    const row = JSON.parse(line), bid = [], ask = []
    for (let i = 1; i <= 5; i++) {
      bid.push(+row.data[`bid_price${i}`])
      ask.push(+row.data[`ask_price${i}`])
    }
    if (bid[0] > 0 && ask[0] > bid[0] && [...bid, ...ask].every(Number.isFinite)) {
      books.push({ at: receivedAt, bid, ask })
    }
    const m = row.marketContext, at = Date.parse(m?.priceAt)
    if (Number.isFinite(at) && at > lastTradeAt && at >= start && at < end &&
        Number.isFinite(+m.price) && Number.isFinite(+m.cumulativeVolume)) {
      trades.push({ at, price: +m.price, volume: +m.cumulativeVolume })
      lastTradeAt = at
    }
  }
  // Never use a quote received after the sampled last-price timestamp.
  let b = -1
  for (let i = 0; i < trades.length; i++) {
    const t = trades[i]
    while (b + 1 < books.length && books[b + 1].at <= t.at) b++
    const prior = books[b]
    t.askTouch = !!prior && t.at - prior.at <= 3000 && t.price >= prior.ask[0]
    t.bidTouch = !!prior && t.at - prior.at <= 3000 && t.price <= prior.bid[0]
    if (i) {
      t.increment = Math.max(0, t.volume - trades[i - 1].volume)
      t.priorPrice = trades[i - 1].price
      t.priorAt = trades[i - 1].at
    } else t.increment = 0
  }
  return { books, trades }
}

function scan(symbol) {
  checks.symbols++
  const cs = candles(symbol)
  if (cs.length < 25) return
  checks.withCandles++
  const emaCandidates = cs.filter((c, i) => i >= 19 && c.priceEma10Pct >= 0.1 && c.ema10Ema20Pct >= 0.1)
  checks.emaCandidates += emaCandidates.length
  const candidates = emaCandidates.filter((c) => c.barsSinceBullishCross !== null &&
    c.barsSinceBullishCross <= 10 && c.riseFromCrossPct >= 0 && c.riseFromCrossPct < 0.9)
  checks.recentCrossCandidates += candidates.length
  if (!candidates.length) return
  const d = depth(symbol)
  if (!d) return
  checks.withDepth++
  let lastSignalAt = -Infinity
  for (const c of candidates) {
    const signalAt = c.at + minute, windowStart = signalAt - 5 * minute
    if (signalAt - lastSignalAt < 5 * minute) continue
    const windowCandles = cs.filter((x) => x.at >= windowStart && x.at < signalAt)
    if (windowCandles.length !== 5 || windowCandles.some((x, i) => x.at !== windowStart + i * minute)) continue
    const books = d.books.filter((x) => x.at >= windowStart && x.at < signalAt)
    if (books.length < 20 || books[0].at > windowStart + 15_000 || books.at(-1).at < signalAt - 15_000) continue
    const first = books[0], last = books.at(-1)
    const ladder = [0, 1, 2, 3, 4].every((i) => last.bid[i] > first.bid[i] && last.ask[i] > first.ask[i])
    if (!ladder) continue
    checks.ladderPass++
    const trades = d.trades.filter((x) => x.at >= windowStart && x.at < signalAt)
    const askTouches = trades.filter((x) => x.askTouch).length
    const bidTouches = trades.filter((x) => x.bidTouch).length
    const matched = trades.filter((x) => x.askTouch || x.bidTouch).length
    if (matched < 10 || askTouches <= bidTouches) continue
    checks.priceTouchPass++
    const windowVolume = windowCandles.reduce((sum, x) => sum + Number(x.volume), 0)
    let event = null
    for (let i = 0; i < trades.length; i++) {
      const t = trades[i]
      if (!t.priorPrice || !t.increment || t.priorAt < windowStart) continue
      const earlier = trades.slice(0, i).map((x) => x.increment).filter((x) => x > 0)
      const baseline = median(earlier)
      if (earlier.length < 10 || !baseline || t.increment < 5 * baseline ||
          t.increment < 0.1 * windowVolume || t.priorPrice - t.price < 0.0002 * t.priorPrice) continue
      const recovered = trades.slice(i + 1).find((x) => x.at <= t.at + 10_000 && x.price >= t.priorPrice)
      if (recovered) { event = { at: t.at, volumeIncrease: t.increment, priorPrice: t.priorPrice,
        lowPrice: t.price, recoveredAt: recovered.at, recoveredPrice: recovered.price,
        priorMedianIncrement: baseline }; break }
    }
    if (!event) continue
    checks.jumpRecoveryPass++
    checks.allPassMinutes++
    const entryAt = signalAt + minute
    const entryBar = cs.find((x) => x.at === entryAt)
    const forwardBars = cs.filter((x) => x.at >= entryAt && x.at < entryAt + 5 * minute)
    const forward5m = entryBar && forwardBars.length === 5 && forwardBars.every((x, i) => x.at === entryAt + i * minute)
      ? { entry: entryBar.open, exit: forwardBars.at(-1).close,
        returnPct: rnd(100 * (forwardBars.at(-1).close / entryBar.open - 1), 4),
        maxAdversePct: rnd(100 * (Math.min(...forwardBars.map((x) => x.low)) / entryBar.open - 1), 4) }
      : null
    signals.push({ symbol, candle: fmt(c.at), confirmedAt: fmt(signalAt), close: c.close,
      priceEma10Pct: rnd(c.priceEma10Pct, 4), ema10Ema20Pct: rnd(c.ema10Ema20Pct, 4),
      bullishCrossCandle: fmt(c.bullishCrossAt), bullishCrossClose: c.bullishCrossClose,
      candlesSinceCross: c.barsSinceBullishCross, riseFromCrossPct: rnd(c.riseFromCrossPct, 4),
      firstBid1: first.bid[0], lastBid1: last.bid[0], firstAsk1: first.ask[0], lastAsk1: last.ask[0],
      firstBid5: first.bid[4], lastBid5: last.bid[4], firstAsk5: first.ask[4], lastAsk5: last.ask[4],
      matchedPriceObservations: matched, askTouches, bidTouches, fiveMinuteCandleVolume: windowVolume,
      jumpAt: fmt(event.at), volumeIncrease: event.volumeIncrease,
      volumeIncreaseSharePct: rnd(100 * event.volumeIncrease / windowVolume),
      medianRatio: rnd(event.volumeIncrease / event.priorMedianIncrement),
      lowPrice: event.lowPrice, recoveredAt: fmt(event.recoveredAt), recoveredPrice: event.recoveredPrice,
      earliestEntryAt: fmt(entryAt), entryOpenAfterNextCompletedCandle: entryBar?.open ?? null, forward5m })
    lastSignalAt = signalAt
  }
}

console.log(`Scanning ${symbols.length} symbol(s) on ${date}...`)
for (let i = 0; i < symbols.length; i++) {
  scan(symbols[i])
  if ((i + 1) % 20 === 0 || i + 1 === symbols.length) console.log(`${i + 1}/${symbols.length} symbols; ${signals.length} signals`)
}
signals.sort((a, b) => a.confirmedAt.localeCompare(b.confirmedAt) || a.symbol.localeCompare(b.symbol))
const evaluated = signals.filter((x) => x.forward5m)
const winCount = evaluated.filter((x) => x.forward5m.returnPct > 0).length
const lossCount = evaluated.filter((x) => x.forward5m.returnPct < 0).length
const totalReturnPct = evaluated.reduce((sum, x) => sum + x.forward5m.returnPct, 0)
const report = { date, methodology: {
  ema: 'Session-seeded EMA10/EMA20 on completed one-minute closes. Require close/EMA10 - 1 >= 0.10% and EMA10/EMA20 - 1 >= 0.10%.',
  recentCross: 'Most recent bullish EMA10 crossover above EMA20 must occur on a candle with at least 20 session candles of warm-up, 0–10 one-minute candles before the signal candle inclusive. Current close must be >= crossover candle close and < 0.90% above that close.',
  window: 'Five completed candles immediately before confirmation; depth received before confirmation.',
  ladder: 'All five displayed bid prices and all five ask prices end above their first observed prices in the five-minute window; >=20 books, book near each window edge.',
  touches: 'At least ten sampled last prices match a prior book within 3s at/through bid1 or ask1; ask-side observations outnumber bid-side.',
  jumpRecovery: 'A cumulative-volume increment at least 5x median of at least ten earlier positive increments in the window and at least 10% of five-minute candle volume, with sampled price falling >=0.02% and recovering to pre-jump sampled price within 10s.',
  duplicates: 'At most one signal per symbol within five minutes.',
  outcome: 'Descriptive long-only audit: wait for the next complete one-minute candle, then enter at following candle open; exit at close of fifth completed holding candle. No spread, fees, slippage or position sizing. Overlapping signals are counted separately.',
  caveat: 'Sampled last prices and displayed quotes cannot establish actual executions by depth level; cumulative-volume increments may span multiple trades. Thresholds are research definitions, not validated trading rules.'
}, checks, outcome5m: { trades: evaluated.length, winners: winCount, losers: lossCount,
  flat: evaluated.length - winCount - lossCount, winRatePct: evaluated.length ? rnd(100 * winCount / evaluated.length) : null,
  averageReturnPct: evaluated.length ? rnd(totalReturnPct / evaluated.length, 4) : null,
  totalReturnPct: rnd(totalReturnPct, 4),
  worstMaxAdversePct: evaluated.length ? Math.min(...evaluated.map((x) => x.forward5m.maxAdversePct)) : null,
  worstDay: date, note: 'Only one research day; summed percentages are not portfolio return.' }, signals }
if (onlySymbol) console.log(JSON.stringify(report, null, 2))
else {
  const base = path.join(root, 'reports', `${date}-ema-five-level-recovery-recent-cross-under-0p9-signals`)
  let file = `${base}.json`, suffix = 2
  while (fs.existsSync(file)) file = `${base}-${suffix++}.json`
  fs.writeFileSync(file, JSON.stringify(report, null, 2) + '\n')
  console.log(`Saved ${file}`)
  console.log(JSON.stringify(checks))
  console.log(JSON.stringify(report.outcome5m))
  console.log(signals.map((x) => `${x.confirmedAt} ${x.symbol} close=${x.close} ask/bid=${x.askTouches}/${x.bidTouches} jump=${x.jumpAt} recovery=${x.recoveredAt}`).join('\n'))
}
