import fs from 'node:fs'
import path from 'node:path'

const root = process.cwd(), minuteMs = 60_000
function argsOf(argv) { const out = {}; for (let i = 0; i < argv.length; i++) { if (argv[i].startsWith('--')) { const [key, inline] = argv[i].slice(2).split('=', 2); out[key] = inline ?? argv[++i] } } return out }
function todayIst() { return new Date(Date.now() + 330 * minuteMs).toISOString().slice(0, 10) }
const args = argsOf(process.argv.slice(2)), date = args.date ?? todayIst(), cutoff = args.cutoff ?? '09:25'
if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || cutoff !== '09:25') throw new Error('Usage: node scripts/scan-opening-ten-candle-eligible.js --date YYYY-MM-DD [--cutoff 09:25]')
const startAt = Date.parse(`${date}T09:15:00+05:30`), cutoffAt = Date.parse(`${date}T09:25:00+05:30`), sessionEndAt = Date.parse(`${date}T15:30:00+05:30`)
const clock = at => new Date(at + 330 * minuteMs).toISOString().slice(11, 16)
const pct = (to, from) => 100 * (to / from - 1)
const round = (value, digits = 2) => Number(value.toFixed(digits))
const depthRoot = path.join(root, 'db', 'cash-depth', date)
if (!fs.existsSync(depthRoot)) throw new Error(`Missing depth directory: ${depthRoot}`)
const normalize = value => String(value).replace(/\s+/g, '').replace(/^NSE:/i, '').replace(/-EQ$/i, '').toUpperCase()
const symbols = args.symbols
  ? [...new Set(String(args.symbols).split(',').map(normalize).filter(Boolean))]
  : fs.readdirSync(depthRoot, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => normalize(entry.name)).sort()

function loadCandles(symbol) {
  const file = path.join(root, 'db', 'candles', `${symbol}.jsonl`)
  if (!fs.existsSync(file)) throw new Error('candle file missing')
  const rows = fs.readFileSync(file, 'utf8').split(/\r?\n/).flatMap(line => {
    try { const row = JSON.parse(line), at = +row.time * 1000; return at >= startAt && at < sessionEndAt ? [{ at, open: +row.open, high: +row.high, low: +row.low, close: +row.close }] : [] } catch { return [] }
  }).sort((a, b) => a.at - b.at)
  if (rows.filter(row => row.at < cutoffAt).length !== 10) throw new Error('expected 10 opening candles')
  let ema10, ema20
  return rows.map((row, index) => { ema10 = index ? ema10 + 2 / 11 * (row.close - ema10) : row.close; ema20 = index ? ema20 + 2 / 21 * (row.close - ema20) : row.close; return { ...row, ema10, ema20 } })
}

function loadDepth(symbol) {
  const file = path.join(depthRoot, symbol, `${symbol}.jsonl`)
  if (!fs.existsSync(file)) throw new Error('depth file missing')
  const state = {}, snapshots = []
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue
    let event; try { event = JSON.parse(line) } catch { continue }
    const at = Date.parse(event.receivedAt)
    if (!Number.isFinite(at)) continue
    if (at >= cutoffAt) break
    if (event.kind === 'checkpoint' || event.book) for (const key of Object.keys(state)) delete state[key]
    Object.assign(state, event.data ?? {})
    if (at < startAt) continue
    let bid = 0, ask = 0, valid = true
    for (let level = 1; level <= 5; level++) {
      const bp = +state[`bid_price${level}`], ap = +state[`ask_price${level}`], bs = +state[`bid_size${level}`], as = +state[`ask_size${level}`]
      if (![bp, ap, bs, as].every(Number.isFinite) || bp <= 0 || ap <= bp) { valid = false; break }
      bid += bs; ask += as
    }
    if (valid) snapshots.push({ bidShare: 100 * bid / (bid + ask || 1), mid: (+state.bid_price1 + +state.ask_price1) / 2 })
  }
  if (!snapshots.length) throw new Error('no valid depth snapshots')
  return snapshots
}

function scan(symbol) {
  const candles = loadCandles(symbol), opening = candles.filter(row => row.at < cutoffAt), depth = loadDepth(symbol)
  const entryIndex = candles.findIndex(row => row.at >= cutoffAt)
  if (entryIndex < 0) throw new Error('09:25 entry candle missing')
  const candleReturn = pct(opening.at(-1).close, opening[0].open)
  const high = Math.max(...opening.map(row => row.high)), low = Math.min(...opening.map(row => row.low))
  const closeLocation = 100 * (opening.at(-1).close - low) / (high - low || 1)
  const midpointReturn = pct(depth.at(-1).mid, depth[0].mid)
  const meanBidShare = depth.reduce((sum, row) => sum + row.bidShare, 0) / depth.length
  const signalCandle = opening.at(-1), entryCandle = candles[entryIndex]
  const emaGapBps = 10_000 * (signalCandle.ema10 - signalCandle.ema20) / signalCandle.close
  const eligible = candleReturn >= 0.5 && closeLocation >= 75 && signalCandle.ema10 > signalCandle.ema20 && midpointReturn >= 0.5 && meanBidShare >= 40 && meanBidShare <= 55 && Math.abs(candleReturn - midpointReturn) <= 0.5
  if (!eligible) return null
  const entry = entryCandle.open, stop = entry * 0.994
  let exit = candles.at(-1).close, exitTime = clock(candles.at(-1).at), exitReason = 'EOD'
  for (let index = entryIndex; index < candles.length; index++) {
    const row = candles[index], previous = candles[index - 1]
    const stopHit = row.low <= stop
    const bearishCross = previous && previous.ema10 >= previous.ema20 && row.ema10 < row.ema20
    if (!stopHit && !bearishCross) continue
    exit = stopHit ? stop : row.close
    exitTime = clock(row.at)
    exitReason = stopHit && bearishCross ? 'SL_AND_EMA_CROSS' : stopHit ? 'SL' : 'EMA10_BELOW_EMA20'
    break
  }
  const returnPct = pct(exit, entry)
  return { table: { Stock: symbol, 'Entry time': '09:25', Return: `${returnPct >= 0 ? '+' : ''}${returnPct.toFixed(2)}%` }, detail: { stock: symbol, entryTime: '09:25', entry: round(entry), stop: round(stop), exitTime, exit, exitReason, returnPct: round(returnPct), openingReturnPct: round(candleReturn), depthMidpointReturnPct: round(midpointReturn), meanBidSharePct: round(meanBidShare), closeLocationPct: round(closeLocation), emaGapBps: round(emaGapBps) } }
}

const matches = [], skipped = []
for (let index = 0; index < symbols.length; index++) {
  const symbol = symbols[index]
  process.stdout.write(`\r\x1b[2KScanning [${index + 1}/${symbols.length}] ${symbol}...`)
  try { const result = scan(symbol); if (result) matches.push(result) } catch (error) { skipped.push({ stock: symbol, reason: error.message }) }
}
process.stdout.write('\r\x1b[2K')
matches.sort((a, b) => b.detail.returnPct - a.detail.returnPct || a.detail.stock.localeCompare(b.detail.stock))
console.log(`Opening ten-candle eligible stocks | ${date} | 09:15–09:25 IST`)
if (matches.length) console.table(matches.map(row => row.table)); else console.log('No eligible stocks found.')
const report = { date, window: '09:15–09:25 IST; candles 09:15–09:24', entryTime: '09:25 candle open', exit: 'First EMA10 cross below EMA20, or SL, or EOD', stopLossPct: -0.6, rules: { candleReturnMinPct: 0.5, closeLocationMinPct: 75, ema10AboveEma20: true, depthMidpointReturnMinPct: 0.5, meanBidShareRangePct: [40, 55], maxPriceDepthReturnDifferencePct: 0.5 }, symbolsScanned: symbols.length, eligible: matches.map(row => row.detail), skipped }
let suffix = 1, outputFile
do { outputFile = path.join(root, 'reports', `${date}-0915-to-0925-opening-ten-candle-eligible${suffix === 1 ? '' : `-${suffix}`}.json`); suffix++ } while (fs.existsSync(outputFile))
fs.writeFileSync(outputFile, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' })
console.log(`Eligible: ${matches.length}/${symbols.length}`)
console.log(`Saved report: ${outputFile}`)
