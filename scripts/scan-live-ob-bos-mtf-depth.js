import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'

const ROOT = process.cwd()
const date = process.argv[2] || '2026-11-20'
const cutoff = process.argv[3] || '09:36'
const startMinute = '09:15'
const excluded = new Set()
const IST = 330 * 60_000
const stamp = (seconds) => new Date(Number(seconds) * 1000 + IST).toISOString().slice(0, 16).replace('T', ' ')
const clock = (ms) => new Date(ms + IST).toISOString().slice(11, 16)
const pct = (a, b) => b ? 100 * (a / b - 1) : null
const round = (x, p = 2) => Number.isFinite(x) ? Number(x.toFixed(p)) : null

const universe = JSON.parse(fs.readFileSync(path.join(ROOT, 'db', 'stocks_sector_wise'), 'utf8'))
const symbols = [...new Set(Object.entries(universe).filter(([k]) => k !== '_meta').flatMap(([, values]) => values).map((x) => String(typeof x === 'string' ? x : (x.symbol || x.name || x.ticker || '')).replace(/^NSE:/i, '').replace(/-EQ$/i, '')).filter(Boolean))].filter((x) => x !== 'NIFTY50')

async function readCandles(symbol) {
  const file = path.join(ROOT, 'db', 'candles', `${symbol}.jsonl`)
  if (!fs.existsSync(file)) return []
  const rows = [], input = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity })
  for await (const line of input) {
    try {
      if (!line.trim()) continue
      const x = JSON.parse(line), local = stamp(x.time)
      if (local >= `${date} ${startMinute}` && local < `${date} ${cutoff}`) rows.push({ time: Number(x.time), minute: local.slice(11), open: +x.open, high: +x.high, low: +x.low, close: +x.close, volume: +x.volume })
    } catch {}
  }
  return rows.sort((a, b) => a.time - b.time)
}

async function readDepth(symbol) {
  const file = path.join(ROOT, 'db', 'cash-depth', date, symbol, `${symbol}.jsonl`)
  if (!fs.existsSync(file)) return []
  const fields = {}, out = [], input = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity })
  for await (const line of input) {
    try {
      const event = JSON.parse(line), at = Date.parse(event.receivedAt)
      if (!Number.isFinite(at)) continue
      const m = clock(at)
      if (m < startMinute || m >= cutoff) continue
      if (event.kind === 'checkpoint') for (const key of Object.keys(fields)) delete fields[key]
      for (const [key, value] of Object.entries(event.data || {})) fields[key] = value
      const bp = +fields.bid_price1, ap = +fields.ask_price1
      const bids = Array.from({ length: 5 }, (_, i) => +fields[`bid_size${i + 1}`]), asks = Array.from({ length: 5 }, (_, i) => +fields[`ask_size${i + 1}`])
      if (![bp, ap, ...bids, ...asks].every(Number.isFinite) || ap <= bp) continue
      out.push({ at, minute: m, bp, ap, mid: (bp + ap) / 2, bid1: bids[0], bidTotal: bids.reduce((a, b) => a + b, 0), askTotal: asks.reduce((a, b) => a + b, 0), spread: 10_000 * (ap - bp) / ((bp + ap) / 2) })
    } catch {}
  }
  return out
}

function ema(values, period) { const k = 2 / (period + 1); let e = values[0]; for (let i = 1; i < values.length; i++) e = values[i] * k + e * (1 - k); return e }
function aggregate(rows, minutes, throughIndex) {
  const out = []
  for (let end = minutes - 1; end <= throughIndex; end += minutes) {
    const group = rows.slice(end - minutes + 1, end + 1)
    if (group.length !== minutes) continue
    out.push({ open: group[0].open, high: Math.max(...group.map((x) => x.high)), low: Math.min(...group.map((x) => x.low)), close: group.at(-1).close, volume: group.reduce((s, x) => s + x.volume, 0) })
  }
  return out
}
function depthScore(items) {
  if (items.length < 2) return null
  const first = items[0], last = items.at(-1), mins = [...Map.groupBy(items, (x) => x.minute).values()].map((g) => ({ mid: g.reduce((s, x) => s + x.mid, 0) / g.length, bid: g.reduce((s, x) => s + x.bidTotal, 0) / g.length, ask: g.reduce((s, x) => s + x.askTotal, 0) / g.length }))
  const midUp = mins.every((x, i) => !i || x.mid >= mins[i - 1].mid), bidSupport = Math.min(...mins.map((x) => x.bid)) >= mins[0].bid * .7, askWall = Math.max(...mins.map((x) => x.ask)) <= mins[0].ask * 1.5
  const ofi = items.slice(1).reduce((s, x, i) => s + (x.bp >= items[i].bp ? x.bid1 : 0) - (x.bp <= items[i].bp ? items[i].bid1 : 0) - (x.ap <= items[i].ap ? x.askTotal : 0) + (x.ap >= items[i].ap ? items[i].askTotal : 0), 0)
  const spread = items.map((x) => x.spread).sort((a, b) => a - b), checks = [last.mid > first.mid, last.bp > first.bp, bidSupport, ofi > 0, askWall, last.ap >= first.ap, midUp, last.mid >= Math.max(...items.map((x) => x.mid)) * .9995, spread[Math.floor(spread.length * .9)] <= first.spread * 1.5, last.bid1 >= first.bid1 * .7]
  return checks.filter(Boolean).length
}

function candidate(rows, depth) {
  if (rows.length < 3) return null
  for (let i = 1; i < rows.length - 1; i++) {
    const ob = rows[i]
    if (ob.minute === '09:15' || ob.close >= ob.open) continue
    for (let j = i + 2; j < rows.length; j++) {
      const c = rows[j], between = rows.slice(i + 1, j), level = Math.max(...between.map((x) => x.high)), range = c.high - c.low || 1
      if (!(c.close > c.open && c.close > level && (c.close - c.open) / range >= .35)) continue
      const upto = rows.slice(0, j + 1), closes = upto.map((x) => x.close), vwapDen = upto.reduce((s, x) => s + x.volume, 0), vwap = vwapDen ? upto.reduce((s, x) => s + ((x.high + x.low + x.close) / 3) * x.volume, 0) / vwapDen : NaN
      const bars3 = aggregate(rows, 3, j), bars5 = aggregate(rows, 5, j), tf3 = bars3.length >= 2 && bars3.at(-1).close > ema(bars3.map((x) => x.close), Math.min(3, bars3.length)) && bars3.at(-1).close >= bars3.at(-2).close, tf5 = bars5.length >= 2 && bars5.at(-1).close > ema(bars5.map((x) => x.close), Math.min(3, bars5.length)) && bars5.at(-1).close >= bars5.at(-2).close
      const greenPct = 100 * upto.filter((x) => x.close > x.open).length / upto.length, e9 = ema(closes, 9), e20 = ema(closes, 20), candleChecks = [c.close > vwap, greenPct >= 70, e9 > e20, tf3, tf5, c.close >= c.high - range * .35, pct(c.close, level) >= .1, c.close > (ob.high + ob.low) / 2]
      const ds = depthScore(depth.filter((x) => x.at < (c.time + 60) * 1000)), score = candleChecks.filter(Boolean).length + (ds == null ? 0 : ds), pass = candleChecks.filter(Boolean).length >= 6 && (ds == null || ds >= 5)
      if (pass) return { Symbol: '', 'OB origin': ob.minute, 'BOS candle': c.minute, 'Confirmed at': clock((c.time + 60) * 1000), 'BOS level': round(level), 'Signal close': round(c.close), 'Green %': round(greenPct, 0), '3m': tf3 ? 'PASS' : 'FAIL', '5m': tf5 ? 'PASS' : 'FAIL', 'Depth / 10': ds ?? '-', 'Score / 18': score, 'VWAP': round(vwap), 'Return at signal %': round(pct(c.close, rows[0].open)) }
    }
  }
  return null
}

const results = []
for (let n = 0; n < symbols.length; n++) {
  const symbol = symbols[n]
  process.stdout.write(`\rScanning ${n + 1}/${symbols.length} ${symbol}`.padEnd(48))
  const rows = await readCandles(symbol), depth = await readDepth(symbol), result = candidate(rows, depth)
  if (result && !excluded.has(symbol)) results.push({ ...result, Symbol: symbol })
}
process.stdout.write('\n')
results.sort((a, b) => a['BOS candle'].localeCompare(b['BOS candle']) || b['Score / 18'] - a['Score / 18'] || a.Symbol.localeCompare(b.Symbol))
let index = 1, output
do { output = path.join(ROOT, 'reports', `${date}-live-ob-bos-mtf-depth-signals${index === 1 ? '' : `-${index}`}.json`); index++ } while (fs.existsSync(output))
fs.writeFileSync(output, `${JSON.stringify({ date, cutoff, universe: symbols.length, rules: ['1m OB→BOS', '3m/5m trend proxy via 1m EMA alignment', 'VWAP', '>=70% green candles', 'breakout close near high', 'OB midpoint hold', 'depth score >=5/10 when available', 'next completed candle entry'], count: results.length, signals: results }, null, 2)}\n`, { flag: 'wx' })
console.table(results)
console.log(`Signals: ${results.length}; report: ${output}`)
