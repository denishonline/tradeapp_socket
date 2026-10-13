import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DATES = ['2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09']
const IST_OFFSET_MS = 330 * 60 * 1000
const MINUTE_MS = 60 * 1000

const round = (value, digits = 3) => Number.isFinite(value) ? Number(value.toFixed(digits)) : null
const minuteOf = (value) => Math.floor(value / MINUTE_MS) * MINUTE_MS
const istDate = (ms) => new Date(ms + IST_OFFSET_MS).toISOString().slice(0, 10)
const istTime = (ms) => new Date(ms + IST_OFFSET_MS).toISOString().slice(11, 16)
const sum = (values) => values.reduce((total, value) => total + value, 0)

function loadCandles(symbol, date) {
  const file = path.join(ROOT, 'db', 'candles', `${symbol}.jsonl`)
  if (!fs.existsSync(file)) return []
  const candles = []
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!line) continue
    let row
    try { row = JSON.parse(line) } catch { continue }
    const at = Number(row.time) * 1000
    if (istDate(at) !== date) continue
    const candle = {
      at: minuteOf(at), open: Number(row.open), high: Number(row.high),
      low: Number(row.low), close: Number(row.close), volume: Number(row.volume),
    }
    if (Object.values(candle).every(Number.isFinite)) candles.push(candle)
  }
  candles.sort((a, b) => a.at - b.at)
  for (let index = 0; index < candles.length; index += 1) {
    const prior = candles.slice(Math.max(0, index - 30), index).map((item) => item.volume)
    candles[index].prior30AvgVolume = prior.length >= 20 ? sum(prior) / prior.length : NaN
  }
  return candles
}

function bookMetric(row) {
  const data = row.data || {}
  const bids = sum([1, 2, 3, 4, 5].map((level) => Number(data[`bid_size${level}`])))
  const asks = sum([1, 2, 3, 4, 5].map((level) => Number(data[`ask_size${level}`])))
  const price = Number(row.marketContext?.price)
  const volume = Number(row.marketContext?.cumulativeVolume)
  const at = Date.parse(row.receivedAt)
  const bestBid = Number(data.bid_price1)
  const bestAsk = Number(data.ask_price1)
  if (![bids, asks, price, volume, at, bestBid, bestAsk].every(Number.isFinite) ||
      bids <= 0 || asks <= 0 || price <= 0 || bestBid <= 0 || bestAsk <= bestBid) return null
  return { at, minute: minuteOf(at), bids, asks, bidShare: 100 * bids / (bids + asks), price, volume, bestBid, bestAsk }
}

async function scanDepth(file, candles) {
  const candleByMinute = new Map(candles.map((item) => [item.at, item]))
  const minuteBuckets = new Map()
  const sweeps = []
  let previous = null
  const input = fs.createReadStream(file)
  const lines = readline.createInterface({ input, crlfDelay: Infinity })
  for await (const line of lines) {
    if (!line) continue
    let row
    try { row = JSON.parse(line) } catch { continue }
    const current = bookMetric(row)
    if (!current) continue
    let bucket = minuteBuckets.get(current.minute)
    if (!bucket) {
      bucket = { count: 0, bidShareTotal: 0, firstPrice: current.price, lastPrice: current.price }
      minuteBuckets.set(current.minute, bucket)
    }
    bucket.count += 1
    bucket.bidShareTotal += current.bidShare
    bucket.lastPrice = current.price

    if (previous && current.at - previous.at > 0 && current.at - previous.at <= 15_000 &&
        current.volume >= previous.volume) {
      const candle = candleByMinute.get(current.minute)
      const priceDropPct = 100 * (current.price / previous.price - 1)
      const bidCollapsePct = 100 * (1 - current.bids / previous.bids)
      const volumeDelta = current.volume - previous.volume
      const candleReturnPct = candle ? 100 * (candle.close / candle.open - 1) : NaN
      const volumeRatio = candle && candle.prior30AvgVolume > 0 ? candle.volume / candle.prior30AvgVolume : NaN
      const tickShare = candle?.volume > 0 ? 100 * volumeDelta / candle.volume : NaN
      if (priceDropPct <= -0.10 && bidCollapsePct >= 70 && current.bidShare <= 20 &&
          candleReturnPct <= -0.12 && volumeRatio >= 2.5 && tickShare >= 35) {
        sweeps.push({
          at: current.at, minute: current.minute, price: current.price,
          priceDropPct, bidCollapsePct, bidShare: current.bidShare,
          volumeDelta, tickShare, candleReturnPct, volumeRatio,
        })
      }
    }
    previous = current
  }
  return { sweeps, minuteBuckets }
}

function evaluate(symbol, date, candles, scan) {
  const candleByMinute = new Map(candles.map((item) => [item.at, item]))
  const results = []
  let lastAccepted = -Infinity
  for (const sweep of scan.sweeps.sort((a, b) => a.at - b.at)) {
    if (sweep.minute - lastAccepted < 30 * MINUTE_MS) continue
    const qualifying = []
    for (let offset = 1; offset <= 7; offset += 1) {
      const minute = sweep.minute + offset * MINUTE_MS
      const depth = scan.minuteBuckets.get(minute)
      const candle = candleByMinute.get(minute)
      if (!depth || !candle || depth.count < 5) continue
      const averageBidShare = depth.bidShareTotal / depth.count
      const declineFromSweepPct = 100 * (candle.close / sweep.price - 1)
      if (averageBidShare >= 65 && declineFromSweepPct <= -0.25) {
        qualifying.push({ minute, averageBidShare, declineFromSweepPct })
      }
    }
    if (qualifying.length < 2) continue
    const confirmationEvidence = qualifying[1]
    const entryMinute = confirmationEvidence.minute + MINUTE_MS
    const entry = candleByMinute.get(entryMinute)
    if (!entry) continue
    const entryPrice = entry.open
    const future = candles.filter((item) => item.at >= entryMinute)
    const atOffset = (minutes) => candleByMinute.get(entryMinute + minutes * MINUTE_MS)
    const shortReturn = (price) => Number.isFinite(price) ? 100 * (entryPrice - price) / entryPrice : NaN
    const lows = future.map((item) => item.low)
    const highs = future.map((item) => item.high)
    const sessionClose = future.at(-1)?.close
    results.push({
      date, symbol, sweepTime: istTime(sweep.at), confirmationTime: istTime(entryMinute),
      entryPrice: round(entryPrice, 2), sweepPriceDropPct: round(sweep.priceDropPct),
      bidCollapsePct: round(sweep.bidCollapsePct, 1), postSweepBidSharePct: round(sweep.bidShare, 1),
      sweepVolume: sweep.volumeDelta, sweepShareOfMinutePct: round(sweep.tickShare, 1),
      candleVolumeRatio: round(sweep.volumeRatio, 2),
      failedBidSharePct: round(confirmationEvidence.averageBidShare, 1),
      declineAtConfirmationPct: round(confirmationEvidence.declineFromSweepPct),
      return5mPct: round(shortReturn(atOffset(5)?.close)),
      return15mPct: round(shortReturn(atOffset(15)?.close)),
      return30mPct: round(shortReturn(atOffset(30)?.close)),
      return60mPct: round(shortReturn(atOffset(60)?.close)),
      maxLaterShortReturnPct: round(shortReturn(Math.min(...lows))),
      maxLaterAdversePct: round(100 * (Math.max(...highs) / entryPrice - 1)),
      closeShortReturnPct: round(shortReturn(sessionClose)),
    })
    lastAccepted = sweep.minute
  }
  return results
}

function csvValue(value) {
  if (value === null || value === undefined || Number.isNaN(value)) return ''
  const text = String(value)
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
}

async function main() {
  const all = []
  for (const date of DATES) {
    const root = path.join(ROOT, 'db', 'cash-depth', date)
    const symbols = fs.readdirSync(root).filter((symbol) =>
      fs.existsSync(path.join(root, symbol, `${symbol}.jsonl`)))
    let dateSignals = 0
    for (const symbol of symbols) {
      const candles = loadCandles(symbol, date)
      if (candles.length < 40) continue
      const file = path.join(root, symbol, `${symbol}.jsonl`)
      const scan = await scanDepth(file, candles)
      const results = evaluate(symbol, date, candles, scan)
      all.push(...results)
      dateSignals += results.length
    }
    console.log(`${date}: scanned ${symbols.length} stocks, ${dateSignals} confirmed patterns`)
  }
  all.sort((a, b) => a.date.localeCompare(b.date) || a.confirmationTime.localeCompare(b.confirmationTime) || a.symbol.localeCompare(b.symbol))
  const columns = Object.keys(all[0] || { date: '', symbol: '' })
  const csv = [columns.join(','), ...all.map((row) => columns.map((column) => csvValue(row[column])).join(','))].join('\n') + '\n'
  const output = path.join(ROOT, 'csv', '2026-10-06-to-09-failed-bid-absorption-patterns.csv')
  fs.writeFileSync(output, csv)
  console.log(`Wrote ${all.length} patterns to ${path.relative(ROOT, output)}`)
  console.log(JSON.stringify(all, null, 2))
}

main().catch((error) => { console.error(error); process.exitCode = 1 })
