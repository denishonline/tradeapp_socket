import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { loadStocks, toFyersSymbol } from '../ui/market-data.js'
import { depthUpdateFields } from '../ui/market-depth.js'

const root = new URL('../', import.meta.url)
const file = path => fileURLToPath(new URL(path, root))
const minuteMs = 60_000
const maxBookAge = 30_000
const depthMinutes = 15
const minimumReturn15Pct = -0.20
const buyLookback = 120
const usage = 'Usage: node scripts/scan-two-setup-candle-depth.js "2026-11-19 12:30" [--json]'

function parseCutoff(input) {
  const match = /^(\d{4}-\d{2}-\d{2})[ T](\d{1,2}):(\d{2})$/.exec(input ?? '')
  if (!match) throw new Error(usage)
  const [, date, h, m] = match
  const time = `${h.padStart(2, '0')}:${m}`
  const cutoff = Date.parse(`${date}T${time}:00+05:30`)
  if (!Number.isFinite(cutoff) || new Date(cutoff + 330 * minuteMs).toISOString().slice(0, 16) !== `${date}T${time}`) {
    throw new Error('Enter a valid date and time in IST.')
  }
  const open = Date.parse(`${date}T09:15:00+05:30`)
  const elapsed = (cutoff - open) / minuteMs
  if (elapsed < 0 || time > '15:30') throw new Error('Cutoff must be between 09:15 and 15:30 IST.')
  return { date, time, cutoff, open, elapsed }
}

async function readIfPresent(path) {
  try {
    return await readFile(file(path), 'utf8')
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
    return null
  }
}

function depthGate(raw, cutoff) {
  const start = cutoff - depthMinutes * minuteMs
  const minutes = Array.from({ length: depthMinutes }, () => ({
    samples: 0, bid: 0, ask: 0, imbalance: 0, topTwoImbalance: 0,
  }))
  let fields = {}
  let book
  let nextSample = start

  function sampleBefore(time) {
    while (nextSample < time && nextSample < cutoff) {
      if (book && nextSample - book.at <= maxBookAge) {
        const bucket = minutes[Math.floor((nextSample - start) / minuteMs)]
        bucket.samples++
        bucket.bid += book.bid
        bucket.ask += book.ask
        bucket.imbalance += book.imbalance
        bucket.topTwoImbalance += book.topTwoImbalance
      }
      nextSample += 1000
    }
  }

  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    const record = JSON.parse(line)
    const at = Date.parse(record.receivedAt)
    if (at >= cutoff) break
    sampleBefore(at)
    if (record.kind === 'checkpoint') fields = {}
    const update = depthUpdateFields(record.data)
    if (!update) continue
    for (const [key, value] of update) fields[key] = value
    const { bid_price1: bid, ask_price1: ask } = fields
    const bidSizes = [], askSizes = []
    for (let level = 1; level <= 5; level++) {
      bidSizes.push(fields[`bid_size${level}`])
      askSizes.push(fields[`ask_size${level}`])
    }
    if (![bid, ask, ...bidSizes, ...askSizes].every(Number.isFinite) || bid <= 0 || ask <= bid) continue
    const bids = bidSizes.reduce((sum, size) => sum + size, 0)
    const asks = askSizes.reduce((sum, size) => sum + size, 0)
    if (bids > 0 && asks > 0) {
      const bidTwo = bidSizes[0] + bidSizes[1]
      const askTwo = askSizes[0] + askSizes[1]
      book = { at, bid, ask, imbalance: (bids - asks) / (bids + asks),
        topTwoImbalance: 100 * (bidTwo - askTwo) / (bidTwo + askTwo) }
    }
  }
  sampleBefore(cutoff)
  if (minutes.some(bucket => !bucket.samples)) return null

  const averages = minutes.map(bucket => ({
    bid: bucket.bid / bucket.samples, ask: bucket.ask / bucket.samples,
  }))
  const mids = averages.map(({ bid, ask }) => (bid + ask) / 2)
  const downBoth = averages.slice(1).filter((quote, index) =>
    quote.bid < averages[index].bid && quote.ask < averages[index].ask).length
  const upBoth = averages.slice(1).filter((quote, index) =>
    quote.bid > averages[index].bid && quote.ask > averages[index].ask).length
  const midpointDrop = 100 * (1 - mids.at(-1) / Math.max(...mids))
  const midpointRise = 100 * (mids.at(-1) / Math.min(...mids) - 1)
  const askHeavyMinutes = minutes.filter(bucket => bucket.imbalance < 0).length
  const bidHeavyMinutes = minutes.filter(bucket => bucket.imbalance > 0).length
  const sum = (buckets, key) => buckets.reduce((total, bucket) => total + bucket[key], 0)
  const early = minutes.slice(0, 5), late = minutes.slice(-5)
  const mean = (buckets, key) => sum(buckets, key) / sum(buckets, 'samples')
  const quotesRepricedHigher = ['bid', 'ask'].every(key => mean(late, key) > mean(early, key))
  return {
    SELL: { quoteMinutes: downBoth, midpointMove: midpointDrop, heavyMinutes: askHeavyMinutes,
      passes: downBoth >= 6 && midpointDrop >= 0.02 && askHeavyMinutes >= 2 },
    BUY: { quoteMinutes: upBoth, midpointMove: midpointRise, heavyMinutes: bidHeavyMinutes,
      passes: upBoth >= 6 && midpointRise >= 0.02 && bidHeavyMinutes >= 2,
      quotesRepricedHigher, topTwoImbalance: mean(minutes, 'topTwoImbalance') },
  }
}

const highest = bars => Math.max(...bars.map(bar => bar.high))
const lowest = bars => Math.min(...bars.map(bar => bar.low))
const percentChange = (value, base) => 100 * (value / base - 1)

function completedCandles(raw, open, cutoff) {
  const byTime = new Map()
  const prior = new Map()
  const needsWarmup = cutoff - open < buyLookback * minuteMs
  let priorOpen = -Infinity
  for (const match of raw.matchAll(/^\{"time":(\d+),.*$/gm)) {
    const time = Number(match[1]) * 1000
    if (time >= open && time < cutoff) byTime.set(time, JSON.parse(match[0]))
    if (!needsWarmup || time >= open) continue
    const sessionOpen = open + Math.floor((time - open) / 86_400_000) * 86_400_000
    if (time >= sessionOpen + 375 * minuteMs || sessionOpen < priorOpen) continue
    if (sessionOpen > priorOpen) {
      prior.clear()
      priorOpen = sessionOpen
    }
    prior.set(time, match[0])
  }
  if (!byTime.has(open) || !byTime.has(cutoff - minuteMs)) return null
  const bars = []
  for (let time = open; time < cutoff; time += minuteMs) {
    const previousClose = bars.at(-1)?.close
    bars.push({ ...(byTime.get(time) ?? { open: previousClose, high: previousClose, low: previousClose, close: previousClose, volume: 0 }), time })
  }
  if (!prior.size) return bars
  // Start on a common boundary for 3-, 5-, and 10-minute bars.
  const needed = Math.ceil((buyLookback - bars.length) / 30) * 30
  const start = priorOpen + Math.floor((375 - needed) / 30) * 30 * minuteMs
  const lastStored = Math.max(...prior.keys())
  const warmup = []
  for (let time = start; time <= lastStored; time += minuteMs) {
    const row = prior.get(time)
    if (row) warmup.push({ ...JSON.parse(row), time })
    else if (warmup.length) {
      const close = warmup.at(-1).close
      warmup.push({ time, open: close, high: close, low: close, close, volume: 0 })
    }
  }
  return [...warmup, ...bars]
}

function aggregate(bars, frameSize) {
  const frames = []
  for (let i = 0; i + frameSize <= bars.length;) {
    const istMinute = (bars[i].time / minuteMs + 330) % 1440
    if ((istMinute - 555) % frameSize !== 0) {
      i++
      continue
    }
    const group = bars.slice(i, i + frameSize)
    const gap = group.findIndex((bar, index) => index > 0 && bar.time - group[index - 1].time !== minuteMs)
    if (gap >= 0) {
      i += gap
      continue
    }
    frames.push({ open: group[0].open, close: group.at(-1).close, high: highest(group), low: lowest(group) })
    i += frameSize
  }
  return frames
}

function averageTrueRange(frames) {
  const recent = frames.slice(-10)
  return recent.reduce((sum, bar, index) => {
    const previousClose = recent[index - 1]?.close
    return sum + Math.max(bar.high - bar.low, index ? Math.abs(bar.high - previousClose) : 0,
      index ? Math.abs(bar.low - previousClose) : 0)
  }, 0) / recent.length
}

function upperWickAtr(bars, frameSize) {
  const frames = aggregate(bars, frameSize)
  const atr = averageTrueRange(frames)
  const last = frames.at(-1)
  const wick = last.high - Math.max(last.open, last.close)
  return atr > 0 ? wick / atr : 0
}

function sellSetups(bars) {
  const close = bars.at(-1).close
  const range = percentChange(highest(bars), lowest(bars))
  const setups = []
  if (bars.length >= 75) {
    const nearby = lowest(bars.slice(-30, -15))
    const older = highest(bars.slice(-75, -60))
    if (percentChange(close, nearby) <= 0.11 && range >= 2 &&
        percentChange(close, older) <= -0.28 && upperWickAtr(bars, 3) >= 0.12) {
      setups.push('Weak near support')
    }
  }
  if (bars.length >= 45 && range >= 2.8 && upperWickAtr(bars, 10) >= 0.13) {
    const level = highest(bars.slice(-45, -30))
    const recent = bars.slice(-30)
    if (close < level && recent.some((bar, i) => i > 0 && recent[i - 1].close < level &&
        bar.high >= level && bar.close < level)) {
      setups.push('Failed resistance test')
    }
  }
  return setups
}

const volume = bars => bars.reduce((sum, bar) => sum + bar.volume, 0)
const downVolumeShare = bars => volume(bars.filter(bar => bar.close < bar.open)) / volume(bars)

function buySetups(bars, depth) {
  const setups = []
  const volumeRatio15 = volume(bars.slice(-15)) / volume(bars.slice(-30, -15))
  const return10Pct = percentChange(bars.at(-1).close, bars.at(-10).open)
  const downVolume5 = downVolumeShare(bars.slice(-5))
  if (depth.passes && depth.midpointMove >= 0.35 && return10Pct >= 0.20) {
    setups.push('Quote recovery with price momentum')
  }
  if (depth.quotesRepricedHigher && depth.topTwoImbalance >= 5 &&
      volumeRatio15 <= 0.8 && downVolume5 >= 0.4) {
    setups.push('Rising quotes on quieter volume')
  }
  if (depth.passes && depth.quoteMinutes >= 7 && return10Pct >= 0.30 && volumeRatio15 <= 0.8) {
    setups.push('Momentum on lighter volume')
  }
  if (depth.quoteMinutes >= 5 && depth.midpointMove >= 0.09 && depth.topTwoImbalance >= 5 &&
      volumeRatio15 <= 0.65 && downVolume5 >= 0.7) {
    setups.push('Recovery on lighter volume')
  }
  return setups
}

function passesBuyCandleFilter(bars) {
  if (!(downVolumeShare(bars.slice(-buyLookback)) >= 0.44)) return false
  const fiveMinute = aggregate(bars, 5)
  const ema = [fiveMinute[0].close]
  for (const bar of fiveMinute.slice(1)) {
    const prior = ema.at(-1)
    ema.push(prior + (2 / 6) * (bar.close - prior))
  }
  if (percentChange(ema.at(-1), ema.at(-4)) > 0.058) return false
  const threeMinute = aggregate(bars, 3)
  const latest = threeMinute.at(-1)
  const atr = averageTrueRange(threeMinute)
  if (!(atr > 0 && (latest.close - latest.open) / atr >= -0.12)) return false

  // Match the replay's simple 10-change RSI on completed one-minute closes.
  const recent = bars.slice(-11)
  let gains = 0, losses = 0
  for (let i = 1; i < recent.length; i++) {
    const change = recent[i].close - recent[i - 1].close
    gains += Math.max(0, change)
    losses += Math.max(0, -change)
  }
  const rsi = gains + losses ? 100 * gains / (gains + losses) : 50
  const last = recent.at(-1)
  const closeLocation = last.high > last.low ? (last.close - last.low) / (last.high - last.low) : 0.5
  return rsi <= 80 && closeLocation <= 0.83
}

function signalRow(stock, side, time, bars, return15Pct, setups, depth) {
  return {
    Stock: stock, Signal: side, 'Time IST': time,
    Close: bars.at(-1).close, '15-min return %': return15Pct.toFixed(3), Setup: setups.join(' + '),
    'Both quotes with signal': depth.quoteMinutes,
    'Midpoint move %': (side === 'BUY' ? depth.midpointMove : -depth.midpointMove).toFixed(3),
    'Depth-heavy minutes': depth.heavyMinutes,
  }
}

async function scan() {
  if (process.argv.includes('--help')) {
    console.log(usage)
    return
  }
  const args = process.argv.slice(2)
  const json = args.includes('--json')
  const { date, time, cutoff, open, elapsed } = parseCutoff(args.filter(arg => arg !== '--json').join(' '))
  const log = message => { if (!json) console.log(message) }
  log(`BUY and SELL scan · ${date} ${time} IST`)
  const signals = []
  let evaluatedDepth = 0
  let buyReady = false
  const depthReady = elapsed >= depthMinutes
  if (!depthReady) {
    log('Scan needs 15 minutes of current-session depth and starts at 09:30 IST.')
  } else {
    const stocks = await loadStocks(file('db/stocks'))
    let missingDepth = 0, missingCandles = 0, sellQualifiers = 0, rejectedSellReturn = 0
    let buySetupMatches = 0, rejectedBuyCandles = 0
    try {
      for (const [index, stock] of stocks.entries()) {
        if (!json) process.stderr.write(`\rScanning... ${index + 1}/${stocks.length} ${stock.padEnd(16)}`)
        const rawDepth = await readIfPresent(`db/cash-depth/${date}/${stock}/${stock}.jsonl`)
        const depth = rawDepth && depthGate(rawDepth, cutoff)
        if (!depth) {
          missingDepth++
          continue
        }
        evaluatedDepth++
        if (depth.SELL.passes) sellQualifiers++
        const rawCandles = await readIfPresent(`db/candles/${stock}.jsonl`)
        const bars = rawCandles && completedCandles(rawCandles, open, cutoff)
        if (!bars) {
          missingCandles++
          continue
        }
        const return15Pct = percentChange(bars.at(-1).close, bars.at(-15).open)
        if (bars.length >= buyLookback) {
          buyReady = true
          const setups = buySetups(bars, depth.BUY)
          if (setups.length) {
            buySetupMatches++
            if (passesBuyCandleFilter(bars)) {
              signals.push(signalRow(stock, 'BUY', time, bars, return15Pct, setups, depth.BUY))
            } else {
              rejectedBuyCandles++
            }
          }
        }
        if (depth.SELL.passes) {
          const setups = sellSetups(bars)
          if (setups.length && return15Pct >= minimumReturn15Pct) {
            signals.push(signalRow(stock, 'SELL', time, bars, return15Pct, setups, depth.SELL))
          } else if (setups.length) {
            rejectedSellReturn++
          }
        }
      }
    } finally {
      if (!json) process.stderr.write('\n')
    }
    if (buyReady) {
      log(`BUY candle checks removed ${rejectedBuyCandles} of ${buySetupMatches} setup matches`)
    }
    log(`Scanned ${stocks.length} stocks · ${sellQualifiers} SELL depth qualifiers`)
    log(`15-minute return filter removed ${rejectedSellReturn} SELL setup matches`)
    if (missingDepth || missingCandles) {
      log(`Skipped ${missingDepth} with missing/incomplete depth and ${missingCandles} with missing cutoff/open candles.`)
    }
  }
  if (json) {
    const rows = side => signals.filter(row => row.Signal === side).map(row => ({
      stock: row.Stock, signalTime: time, setup: row.Setup,
    }))
    console.log(JSON.stringify({ date, time, evaluatedDepth, buyReady, depthReady, buy: rows('BUY'), sell: rows('SELL') }))
    return
  }
  if (signals.length) console.table(signals)
  for (const side of ['BUY', 'SELL']) {
    const symbols = signals.filter(row => row.Signal === side).map(row => toFyersSymbol(row.Stock))
    console.log(`${side} signals (${symbols.length})`)
    console.log(symbols.join(', '))
  }
}

scan().catch(error => {
  console.error(error.message)
  process.exitCode = 1
})
