import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DATES = ['2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09']
const IST_MS = 330 * 60_000
const MINUTE = 60_000
const round = (n, d = 3) => Number.isFinite(n) ? Number(n.toFixed(d)) : null
const minuteOf = (n) => Math.floor(n / MINUTE) * MINUTE
const dateIst = (n) => new Date(n + IST_MS).toISOString().slice(0, 10)
const timeIst = (n) => new Date(n + IST_MS).toISOString().slice(11, 16)
const sum = (a) => a.reduce((x, y) => x + y, 0)

function candlesFor(symbol, date) {
  const file = path.join(ROOT, 'db', 'candles', `${symbol}.jsonl`)
  if (!fs.existsSync(file)) return []
  const rows = []
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!line) continue
    let row
    try { row = JSON.parse(line) } catch { continue }
    const at = Number(row.time) * 1000
    if (dateIst(at) !== date) continue
    const candle = { at: minuteOf(at), open: Number(row.open), high: Number(row.high), low: Number(row.low), close: Number(row.close), volume: Number(row.volume) }
    if (Object.values(candle).every(Number.isFinite)) rows.push(candle)
  }
  rows.sort((a, b) => a.at - b.at)
  for (let i = 0; i < rows.length; i += 1) {
    const prior = rows.slice(Math.max(0, i - 30), i)
    rows[i].prior30AvgVolume = prior.length >= 20 ? sum(prior.map((x) => x.volume)) / prior.length : NaN
    const prior5 = rows.slice(Math.max(0, i - 5), i)
    rows[i].prior5Return = prior5.length === 5 ? 100 * (prior5.at(-1).close / prior5[0].open - 1) : NaN
  }
  return rows
}

function metric(row) {
  const d = row.data || {}
  const bids = sum([1, 2, 3, 4, 5].map((n) => Number(d[`bid_size${n}`])))
  const asks = sum([1, 2, 3, 4, 5].map((n) => Number(d[`ask_size${n}`])))
  const value = { at: Date.parse(row.receivedAt), price: Number(row.marketContext?.price), volume: Number(row.marketContext?.cumulativeVolume), bids, asks, bestBid: Number(d.bid_price1), bestAsk: Number(d.ask_price1) }
  if (!Object.values(value).every(Number.isFinite) || value.price <= 0 || bids <= 0 || asks <= 0 || value.bestAsk <= value.bestBid) return null
  value.minute = minuteOf(value.at)
  value.bidShare = 100 * bids / (bids + asks)
  return value
}

async function broadScan(file, candles) {
  const candleMap = new Map(candles.map((x) => [x.at, x]))
  const buckets = new Map()
  const events = []
  let previous = null
  const lines = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity })
  for await (const line of lines) {
    if (!line) continue
    let row
    try { row = JSON.parse(line) } catch { continue }
    const current = metric(row)
    if (!current) continue
    const bucket = buckets.get(current.minute) || { count: 0, bidTotal: 0, firstPrice: current.price, lastPrice: current.price }
    bucket.count += 1
    bucket.bidTotal += current.bidShare
    bucket.lastPrice = current.price
    buckets.set(current.minute, bucket)
    if (previous && current.at > previous.at && current.at - previous.at <= 15_000 && current.volume >= previous.volume) {
      const candle = candleMap.get(current.minute)
      if (candle && candle.prior30AvgVolume > 0) {
        const event = {
          at: current.at, minute: current.minute, price: current.price,
          priceDrop: 100 * (current.price / previous.price - 1),
          bidCollapse: 100 * (1 - current.bids / previous.bids), bidShare: current.bidShare,
          volumeDelta: current.volume - previous.volume,
          candleReturn: 100 * (candle.close / candle.open - 1),
          volumeRatio: candle.volume / candle.prior30AvgVolume,
          tickShare: candle.volume > 0 ? 100 * (current.volume - previous.volume) / candle.volume : 0,
          prior5Return: candle.prior5Return,
        }
        if (event.priceDrop <= -0.04 && event.bidCollapse >= 40 && event.bidShare <= 40 &&
            event.candleReturn <= -0.03 && event.volumeRatio >= 1.25 && event.tickShare >= 10) events.push(event)
      }
    }
    previous = current
  }
  return { events, buckets }
}

function confirmation(event, buckets, candleMap, cfg) {
  const matches = []
  for (let offset = 1; offset <= cfg.window; offset += 1) {
    const at = event.minute + offset * MINUTE
    const bucket = buckets.get(at)
    const candle = candleMap.get(at)
    if (!bucket || !candle || bucket.count < 5) continue
    const bidShare = bucket.bidTotal / bucket.count
    const decline = 100 * (candle.close / event.price - 1)
    if (bidShare >= cfg.confirmBid && decline <= cfg.confirmDecline) matches.push({ at, bidShare, decline })
    if (matches.length >= cfg.confirmCount) {
      const latestThree = [at - 2 * MINUTE, at - MINUTE, at].map((minute) => candleMap.get(minute))
      if (latestThree.every(Boolean)) {
        const return3 = 100 * (latestThree.at(-1).close / latestThree[0].open - 1)
        const red3 = latestThree.filter((item) => item.close < item.open).length
        if (return3 <= cfg.return3 && red3 >= cfg.red3) return { ...matches.at(-1), return3, red3 }
      }
    }
  }
  return null
}

function outcome(candles, entryMinute) {
  const map = new Map(candles.map((x) => [x.at, x]))
  const entry = map.get(entryMinute)
  if (!entry) return null
  const price = entry.open
  const future = candles.filter((x) => x.at >= entryMinute)
  if (!future.length) return null
  let result = 'UNRESOLVED'
  let exitTime = null
  for (const candle of future) {
    const stop = candle.high >= price * 1.004
    const target = candle.low <= price * 0.99
    if (stop || target) {
      result = stop ? 'STOP' : 'TARGET'
      exitTime = candle.at
      break
    }
  }
  const ret = (later) => Number.isFinite(later) ? 100 * (price - later) / price : NaN
  const at = (minutes) => map.get(entryMinute + minutes * MINUTE)?.close
  const closeReturn = ret(future.at(-1).close)
  return {
    entryMinute, entryPrice: price, result, exitTime,
    return5: ret(at(5)), return15: ret(at(15)), return30: ret(at(30)), return60: ret(at(60)),
    mfe: ret(Math.min(...future.map((x) => x.low))),
    mae: 100 * (Math.max(...future.map((x) => x.high)) - price) / price,
    closeReturn,
  }
}

const grid = (values) => values
const configs = []
for (const priceDrop of grid([-0.04, -0.05, -0.06, -0.08]))
for (const bidCollapse of grid([40, 50, 60]))
for (const bidShare of grid([20, 25, 30, 35]))
for (const candleReturn of grid([-0.03, -0.06, -0.09]))
for (const volumeRatio of grid([1.25, 1.5, 2]))
for (const tickShare of grid([10, 20, 30]))
for (const confirmBid of grid([55, 60, 65]))
for (const confirmDecline of grid([-0.15, -0.20, -0.25]))
for (const confirmCount of grid([2, 3]))
for (const window of grid([7, 10])) configs.push({ priceDrop, bidCollapse, bidShare, candleReturn, volumeRatio, tickShare, confirmBid, confirmDecline, confirmCount, window, return3: -0.10, red3: 2 })

function passes(event, cfg) {
  return event.priceDrop <= cfg.priceDrop && event.bidCollapse >= cfg.bidCollapse && event.bidShare <= cfg.bidShare &&
    event.candleReturn <= cfg.candleReturn && event.volumeRatio >= cfg.volumeRatio && event.tickShare >= cfg.tickShare
}

function csv(value) {
  if (value === null || value === undefined || Number.isNaN(value)) return ''
  const text = String(value)
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
}

async function main() {
  const groups = []
  for (const date of DATES) {
    const root = path.join(ROOT, 'db', 'cash-depth', date)
    const symbols = fs.readdirSync(root).filter((s) => fs.existsSync(path.join(root, s, `${s}.jsonl`)))
    let broadEvents = 0
    for (const symbol of symbols) {
      const candles = candlesFor(symbol, date)
      if (candles.length < 40) continue
      const scan = await broadScan(path.join(root, symbol, `${symbol}.jsonl`), candles)
      broadEvents += scan.events.length
      if (scan.events.length) groups.push({ date, symbol, candles, candleMap: new Map(candles.map((x) => [x.at, x])), ...scan })
    }
    console.log(`${date}: ${broadEvents} broad sweep events`)
  }

  const outcomeCache = new Map()
  const ranked = []
  for (const cfg of configs) {
    const signals = []
    for (const group of groups) {
      let last = -Infinity
      for (const event of group.events) {
        if (event.minute - last < 30 * MINUTE || !passes(event, cfg)) continue
        const confirmed = confirmation(event, group.buckets, group.candleMap, cfg)
        if (!confirmed) continue
        const entryMinute = confirmed.at + MINUTE
        const key = `${group.date}|${group.symbol}|${entryMinute}`
        let trade = outcomeCache.get(key)
        if (!trade) {
          trade = outcome(group.candles, entryMinute)
          outcomeCache.set(key, trade)
        }
        if (!trade) continue
        signals.push({ group, event, confirmed, trade })
        last = event.minute
      }
    }
    if (signals.length < 5) continue
    const targets = signals.filter((x) => x.trade.result === 'TARGET').length
    const stops = signals.filter((x) => x.trade.result === 'STOP').length
    const unresolvedPositive = signals.filter((x) => x.trade.result === 'UNRESOLVED' && x.trade.closeReturn > 0).length
    const unresolvedNegative = signals.filter((x) => x.trade.result === 'UNRESOLVED' && x.trade.closeReturn <= 0).length
    const dates = new Set(signals.map((x) => x.group.date)).size
    const net = signals.reduce((total, x) => total + (x.trade.result === 'TARGET' ? 1 : x.trade.result === 'STOP' ? -0.4 : x.trade.closeReturn), 0)
    ranked.push({ cfg, signals, count: signals.length, targets, stops, unresolvedPositive, unresolvedNegative, dates, net })
  }
  ranked.sort((a, b) =>
    b.targets - a.targets || a.stops - b.stops || a.unresolvedNegative - b.unresolvedNegative ||
    b.unresolvedPositive - a.unresolvedPositive || b.dates - a.dates || b.net - a.net || b.count - a.count)
  const eligible = ranked.filter((x) => x.dates >= 2 && x.stops === 0 && x.unresolvedNegative === 0)
  const frontier = [0, 1, 2].map((maximumStops) => {
    const choice = ranked.find((x) => x.dates >= 2 && x.stops <= maximumStops && x.unresolvedNegative <= maximumStops)
    return choice ? {
      maximumStops, count: choice.count, targets: choice.targets, stops: choice.stops,
      unresolvedPositive: choice.unresolvedPositive, unresolvedNegative: choice.unresolvedNegative,
      dates: choice.dates, net: round(choice.net), cfg: choice.cfg,
    } : null
  })
  console.log('FRONTIER', JSON.stringify(frontier, null, 2))
  const balanced = ranked.find((x) => x.dates >= 2 && x.stops <= 1 && x.unresolvedNegative <= 1)
  const best = balanced || eligible[0] || ranked[0]
  if (!best) throw new Error('No configuration produced at least five signals')
  console.log('BEST', JSON.stringify({ ...best, signals: undefined }, null, 2))
  const rows = best.signals.map(({ group, event, confirmed, trade }) => ({
    date: group.date, symbol: group.symbol, sweepTime: timeIst(event.at), confirmationTime: timeIst(trade.entryMinute),
    entryPrice: round(trade.entryPrice, 2), result: trade.result,
    exitTime: trade.exitTime ? timeIst(trade.exitTime) : '', priceDropPct: round(event.priceDrop),
    bidCollapsePct: round(event.bidCollapse, 1), postSweepBidSharePct: round(event.bidShare, 1),
    candleVolumeRatio: round(event.volumeRatio, 2), sweepShareOfMinutePct: round(event.tickShare, 1),
    confirmationBidSharePct: round(confirmed.bidShare, 1), confirmationDeclinePct: round(confirmed.decline),
    confirmationReturn3Pct: round(confirmed.return3), confirmationRedCandles3: confirmed.red3,
    return5mPct: round(trade.return5), return15mPct: round(trade.return15), return30mPct: round(trade.return30),
    return60mPct: round(trade.return60), maxLaterReturnPct: round(trade.mfe), maxAdversePct: round(trade.mae),
    closeReturnPct: round(trade.closeReturn),
  })).sort((a, b) => a.date.localeCompare(b.date) || a.confirmationTime.localeCompare(b.confirmationTime))
  const columns = Object.keys(rows[0])
  const output = path.join(ROOT, 'csv', '2026-10-06-to-09-balanced-failed-bid-absorption.csv')
  fs.writeFileSync(output, [columns.join(','), ...rows.map((r) => columns.map((c) => csv(r[c])).join(','))].join('\n') + '\n')
  console.log(`Wrote ${rows.length} signals to ${path.relative(ROOT, output)}`)
  console.log(JSON.stringify(rows, null, 2))
}

main().catch((error) => { console.error(error); process.exitCode = 1 })
