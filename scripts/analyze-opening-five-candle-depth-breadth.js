import fs from 'node:fs'
import path from 'node:path'

const root = process.cwd(), date = process.argv[2], candlesOnly = process.argv.includes('--candles-only')
if (!/^\d{4}-\d{2}-\d{2}$/.test(date ?? '')) throw new Error('Usage: node scripts/analyze-opening-five-candle-depth-breadth.js YYYY-MM-DD')
const ist = 330 * 60_000, start = Date.parse(`${date}T09:15:00+05:30`), end = Date.parse(`${date}T09:20:00+05:30`)
const clock = at => new Date(at + ist).toISOString().slice(11, 16)
const rootDepth = path.join(root, 'db', 'cash-depth', date)
if (!fs.existsSync(rootDepth)) throw new Error(`Missing depth directory: ${rootDepth}`)
const symbols = fs.readdirSync(rootDepth, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name)
const rows = [], candleRows = [], skipped = []
for (const symbol of symbols) {
  try {
    const candleFile = path.join(root, 'db', 'candles', `${symbol}.jsonl`), depthFile = path.join(rootDepth, symbol, `${symbol}.jsonl`)
    if (!fs.existsSync(candleFile) || !fs.existsSync(depthFile)) { skipped.push(symbol); continue }
    const candles = fs.readFileSync(candleFile, 'utf8').split(/\r?\n/).flatMap(line => {
      try { const row = JSON.parse(line), at = +row.time * 1000; return at >= start && at < end ? [{ at, open: +row.open, high: +row.high, low: +row.low, close: +row.close }] : [] } catch { return [] }
    }).sort((a, b) => a.at - b.at)
    if (candles.length !== 5) { skipped.push(symbol); continue }
    let ema10, ema20
    for (let index = 0; index < 5; index++) { ema10 = index ? ema10 + 2 / 11 * (candles[index].close - ema10) : candles[index].close; ema20 = index ? ema20 + 2 / 21 * (candles[index].close - ema20) : candles[index].close }
    const high = Math.max(...candles.map(row => row.high)), low = Math.min(...candles.map(row => row.low)), close = candles.at(-1).close
    const candleRow = { priceReturn: 100 * (close / candles[0].open - 1), green: candles.filter(row => row.close > row.open).length, closeLocation: 100 * (close - low) / (high - low || 1) }
    let candleEma10, candleEma20
    for (let index = 0; index < 5; index++) { candleEma10 = index ? candleEma10 + 2 / 11 * (candles[index].close - candleEma10) : candles[index].close; candleEma20 = index ? candleEma20 + 2 / 21 * (candles[index].close - candleEma20) : candles[index].close }
    candleRow.emaUp = candleEma10 > candleEma20
    candleRows.push(candleRow)
    if (candlesOnly) continue
    const state = {}, depth = [], minutes = new Set()
    for (const line of fs.readFileSync(depthFile, 'utf8').split(/\r?\n/)) {
      if (!line.trim()) continue
      let event; try { event = JSON.parse(line) } catch { continue }
      const at = Date.parse(event.receivedAt); if (!Number.isFinite(at)) continue
      if (at >= end) break
      if (event.kind === 'checkpoint' || event.book) for (const key of Object.keys(state)) delete state[key]
      Object.assign(state, event.data ?? {})
      if (at < start) continue
      let bid = 0, ask = 0, valid = true
      for (let level = 1; level <= 5; level++) { const bp = +state[`bid_price${level}`], ap = +state[`ask_price${level}`], bs = +state[`bid_size${level}`], as = +state[`ask_size${level}`]; if (![bp, ap, bs, as].every(Number.isFinite) || bp <= 0 || ap <= bp) { valid = false; break }; bid += bs; ask += as }
      if (!valid) continue
      depth.push({ bidShare: 100 * bid / (bid + ask || 1), midpoint: (+state.bid_price1 + +state.ask_price1) / 2 })
      minutes.add(clock(at))
    }
    if (minutes.size < 3 || !depth.length) { skipped.push(symbol); continue }
    rows.push({ ...candleRow, midpointReturn: 100 * (depth.at(-1).midpoint / depth[0].midpoint - 1), depthMinutes: minutes.size, bidShare: depth.reduce((sum, row) => sum + row.bidShare, 0) / depth.length })
  } catch { skipped.push(symbol) }
}
const count = fn => rows.filter(fn).length, percent = fn => Number((100 * count(fn) / rows.length).toFixed(1)), stat = (name, fn) => ({ behaviour: name, stocks: count(fn), percent: percent(fn) })
const sorted = (source, key) => [...source].map(row => row[key]).sort((a, b) => a - b)
const median = (source, key) => { const values = sorted(source, key); return values.length ? Number(values[Math.floor(values.length / 2)].toFixed(3)) : null }
const candleCount = fn => candleRows.filter(fn).length
const candlePercent = fn => candleRows.length ? Number((100 * candleCount(fn) / candleRows.length).toFixed(1)) : null
const candleStat = (behaviour, fn) => ({ behaviour, stocks: candleCount(fn), percent: candlePercent(fn) })
const output = { date, stocksAvailable: symbols.length, candleAnalyzed: candleRows.length, analyzed: rows.length, skipped: skipped.length, averageObservedDepthMinutes: rows.length ? Number((rows.reduce((sum, row) => sum + row.depthMinutes, 0) / rows.length).toFixed(2)) : 0, candleSummary: [
  candleStat('Positive five-candle price return', row => row.priceReturn > 0),
  candleStat('Negative five-candle price return', row => row.priceReturn < 0),
  candleStat('EMA10 above EMA20', row => row.emaUp),
  candleStat('At least three green candles', row => row.green >= 3),
  candleStat('Close in upper 75% of range', row => row.closeLocation >= 75),
  candleStat('Strong bullish candle alignment', row => row.priceReturn >= 0.5 && row.emaUp && row.green >= 3 && row.closeLocation >= 75),
  candleStat('Strong bearish candle alignment', row => row.priceReturn <= -0.5 && !row.emaUp && row.green <= 2 && row.closeLocation <= 25)
], candleDistribution: { meanPriceReturnPct: candleRows.length ? Number((candleRows.reduce((sum, row) => sum + row.priceReturn, 0) / candleRows.length).toFixed(3)) : null, medianPriceReturnPct: median(candleRows, 'priceReturn') }, summary: [
  stat('Positive five-candle price return', row => row.priceReturn > 0),
  stat('Negative five-candle price return', row => row.priceReturn < 0),
  stat('Positive depth midpoint return', row => row.midpointReturn > 0),
  stat('Negative depth midpoint return', row => row.midpointReturn < 0),
  stat('Price and midpoint both rising', row => row.priceReturn > 0 && row.midpointReturn > 0),
  stat('Price and midpoint both falling', row => row.priceReturn < 0 && row.midpointReturn < 0),
  stat('EMA10 above EMA20', row => row.emaUp),
  stat('At least three green candles', row => row.green >= 3),
  stat('Close in upper 75% of range', row => row.closeLocation >= 75),
  stat('Balanced depth: bid share 45%-55%', row => row.bidShare >= 45 && row.bidShare <= 55),
  stat('Ask-heavy depth: bid share below 45%', row => row.bidShare < 45),
  stat('Bid-heavy depth: bid share above 55%', row => row.bidShare > 55),
  stat('Strong bullish alignment', row => row.priceReturn >= 0.5 && row.midpointReturn >= 0.5 && row.emaUp && row.green >= 3 && row.closeLocation >= 75),
  stat('Strong bearish alignment', row => row.priceReturn <= -0.5 && row.midpointReturn <= -0.5 && !row.emaUp && row.green <= 2 && row.closeLocation <= 25)
], distribution: { meanPriceReturnPct: rows.length ? Number((rows.reduce((sum, row) => sum + row.priceReturn, 0) / rows.length).toFixed(3)) : null, medianPriceReturnPct: median(rows, 'priceReturn'), meanDepthMidpointReturnPct: rows.length ? Number((rows.reduce((sum, row) => sum + row.midpointReturn, 0) / rows.length).toFixed(3)) : null, medianDepthMidpointReturnPct: median(rows, 'midpointReturn') } }
const file = path.join(root, 'reports', `${date}-0915-to-0920-candle-depth-breadth.json`)
fs.writeFileSync(file, JSON.stringify(output, null, 2) + '\n')
console.log(JSON.stringify({ file, ...output }, null, 2))
