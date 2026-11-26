import fs from 'node:fs'
import path from 'node:path'

const root = process.cwd(), minuteMs = 60_000
const parseArgs = argv => { const out = {}; for (let i = 0; i < argv.length; i++) if (argv[i].startsWith('--')) { const [key, value] = argv[i].slice(2).split('=', 2); out[key] = value ?? argv[++i] } return out }
const args = parseArgs(process.argv.slice(2)), date = args.date ?? new Date(Date.now() + 330 * minuteMs).toISOString().slice(0, 10), cutoff = args.cutoff ?? '15:29'
if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(cutoff)) throw new Error('Usage: node scripts/scan-bid-absorption-reversal.js --date YYYY-MM-DD --cutoff HH:MM --symbols "NSE:AAA-EQ,..."')
const startAt = Date.parse(`${date}T09:15:00+05:30`), endAt = Date.parse(`${date}T${cutoff}:00+05:30`) + minuteMs
const clock = at => new Date(at + 330 * minuteMs).toISOString().slice(11, 16)
const pct = (to, from) => 100 * (to / from - 1)
const round = (value, digits = 2) => Number(value.toFixed(digits))
const normalize = value => String(value).replace(/\s+/g, '').replace(/^NSE:/i, '').replace(/-EQ$/i, '').toUpperCase()
const depthRoot = path.join(root, 'db', 'cash-depth', date)
if (!fs.existsSync(depthRoot)) throw new Error(`Missing depth directory: ${depthRoot}`)
const symbols = args.symbols ? [...new Set(String(args.symbols).split(',').map(normalize).filter(Boolean))] : fs.readdirSync(depthRoot, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => normalize(entry.name)).sort()
const minuteNumber = minute => { const [hour, min] = minute.split(':').map(Number); return hour * 60 + min }
const minuteName = number => `${String(Math.floor(number / 60)).padStart(2, '0')}:${String(number % 60).padStart(2, '0')}`
const expectedMinutes = []; for (let n = minuteNumber('09:15'); n <= minuteNumber(cutoff); n++) expectedMinutes.push(minuteName(n))

function loadCandles(symbol) {
  const file = path.join(root, 'db', 'candles', `${symbol}.jsonl`)
  if (!fs.existsSync(file)) throw new Error('candle file missing')
  const rows = fs.readFileSync(file, 'utf8').split(/\r?\n/).flatMap(line => { try { const row = JSON.parse(line), at = +row.time * 1000; return at >= startAt && at < endAt ? [{ at, minute: clock(at), open: +row.open, high: +row.high, low: +row.low, close: +row.close }] : [] } catch { return [] } }).sort((a, b) => a.at - b.at)
  let ema10, ema20
  return rows.map((row, index) => { ema10 = index ? ema10 + 2 / 11 * (row.close - ema10) : row.close; ema20 = index ? ema20 + 2 / 21 * (row.close - ema20) : row.close; return { ...row, ema10, ema20 } })
}

function loadDepth(symbol) {
  const file = path.join(depthRoot, symbol, `${symbol}.jsonl`)
  if (!fs.existsSync(file)) throw new Error('depth file missing')
  const state = {}, byMinute = new Map()
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue
    let event; try { event = JSON.parse(line) } catch { continue }
    const at = Date.parse(event.receivedAt); if (!Number.isFinite(at)) continue
    if (at >= endAt) break
    if (event.kind === 'checkpoint' || event.book) for (const key of Object.keys(state)) delete state[key]
    Object.assign(state, event.data ?? {})
    if (at < startAt) continue
    let bid = 0, ask = 0, valid = true
    for (let level = 1; level <= 5; level++) {
      const bp = +state[`bid_price${level}`], ap = +state[`ask_price${level}`], bs = +state[`bid_size${level}`], as = +state[`ask_size${level}`]
      if (![bp, ap, bs, as].every(Number.isFinite) || bp <= 0 || ap <= bp) { valid = false; break }
      bid += bs; ask += as
    }
    if (!valid) continue
    const minute = clock(at), row = { bidShare: 100 * bid / (bid + ask || 1), mid: (+state.bid_price1 + +state.ask_price1) / 2 }
    if (!byMinute.has(minute)) byMinute.set(minute, [])
    byMinute.get(minute).push(row)
  }
  return [...byMinute].map(([minute, rows]) => ({ minute, snapshots: rows.length, bidShare: rows.reduce((sum, row) => sum + row.bidShare, 0) / rows.length, bidDominantSnapshotPct: 100 * rows.filter(row => row.bidShare > 50).length / rows.length, firstMid: rows[0].mid, lastMid: rows.at(-1).mid }))
}

function qualifiesAbsorption(window) {
  const snapshots = window.reduce((sum, row) => sum + row.snapshots, 0)
  const meanBidShare = window.reduce((sum, row) => sum + row.bidShare * row.snapshots, 0) / snapshots
  const bidDominantSnapshots = window.reduce((sum, row) => sum + row.bidDominantSnapshotPct * row.snapshots, 0) / snapshots
  const bidDominantMinutes = 100 * window.filter(row => row.bidShare >= 50).length / window.length
  const priceMove = pct(window.at(-1).candle.close, window[0].candle.open)
  const midpointMove = pct(window.at(-1).lastMid, window[0].firstMid)
  return meanBidShare >= 55 && bidDominantSnapshots >= 65 && bidDominantMinutes >= 70 && priceMove <= -0.10 && midpointMove <= -0.10 ? { meanBidShare, bidDominantSnapshots, bidDominantMinutes, priceMove, midpointMove } : null
}

function qualifiesReversal(window, absorptionEndClose) {
  const snapshots = window.reduce((sum, row) => sum + row.snapshots, 0)
  const meanBidShare = window.reduce((sum, row) => sum + row.bidShare * row.snapshots, 0) / snapshots
  const bidDominantSnapshots = window.reduce((sum, row) => sum + row.bidDominantSnapshotPct * row.snapshots, 0) / snapshots
  const bidDominantMinutes = 100 * window.filter(row => row.bidShare >= 50).length / window.length
  const priceMove = pct(window.at(-1).candle.close, window[0].candle.open)
  const midpointMove = pct(window.at(-1).lastMid, window[0].firstMid)
  const closes = [absorptionEndClose, ...window.map(row => row.candle.close)]
  const upSteps = closes.slice(1).filter((close, index) => close > closes[index]).length
  return meanBidShare >= 55 && bidDominantSnapshots >= 65 && bidDominantMinutes >= 60 && priceMove >= 0.30 && midpointMove >= 0.25 && window.at(-1).candle.close > absorptionEndClose && upSteps >= 2 ? { meanBidShare, bidDominantSnapshots, bidDominantMinutes, priceMove, midpointMove } : null
}

function scan(symbol) {
  const candles = loadCandles(symbol), candleByMinute = new Map(candles.map(row => [row.minute, row])), depth = loadDepth(symbol), depthByMinute = new Map(depth.map(row => [row.minute, row])), available = expectedMinutes.filter(minute => candleByMinute.has(minute) && depthByMinute.has(minute))
  const windows = []
  for (let end = 0; end < available.length; end++) for (const length of [10, 15, 20]) {
    const start = end - length + 1; if (start < 0) continue
    const names = available.slice(start, end + 1), expectedSpan = minuteNumber(names.at(-1)) - minuteNumber(names[0]) + 1
    if (names.length / expectedSpan < 0.8) continue
    const rows = names.map(minute => ({ ...depthByMinute.get(minute), minute, candle: candleByMinute.get(minute) }))
    const metrics = qualifiesAbsorption(rows); if (metrics) windows.push({ rows, metrics })
  }
  windows.sort((a, b) => minuteNumber(a.rows.at(-1).minute) - minuteNumber(b.rows.at(-1).minute) || a.rows.length - b.rows.length)
  for (const absorption of windows) {
    const absorptionEnd = minuteNumber(absorption.rows.at(-1).minute), absorptionEndClose = absorption.rows.at(-1).candle.close
    for (let length = 2; length <= 5; length++) {
      const names = expectedMinutes.filter(minute => minuteNumber(minute) > absorptionEnd && minuteNumber(minute) <= absorptionEnd + length)
      if (names.length !== length || names.some(minute => !candleByMinute.has(minute) || !depthByMinute.has(minute))) continue
      const rows = names.map(minute => ({ ...depthByMinute.get(minute), minute, candle: candleByMinute.get(minute) })), reversal = qualifiesReversal(rows, absorptionEndClose)
      if (reversal) return { Stock: symbol, 'Signal time': rows.at(-1).minute, 'Absorption window': `${absorption.rows[0].minute}-${absorption.rows.at(-1).minute}`, 'Reversal window': `${rows[0].minute}-${rows.at(-1).minute}`, 'Bid share': `${reversal.meanBidShare.toFixed(1)}%`, 'Price move': `+${reversal.priceMove.toFixed(2)}%`, 'Midpoint move': `+${reversal.midpointMove.toFixed(2)}%`, 'Status': 'BUY reversal' }
    }
  }
  return null
}

const matches = [], skipped = []
for (let index = 0; index < symbols.length; index++) { const symbol = symbols[index]; process.stdout.write(`\r\x1b[2KScanning [${index + 1}/${symbols.length}] ${symbol}...`); try { const signal = scan(symbol); if (signal) matches.push(signal) } catch (error) { skipped.push({ stock: symbol, reason: error.message }) } }
process.stdout.write('\r\x1b[2K')
matches.sort((a, b) => a['Signal time'].localeCompare(b['Signal time']) || a.Stock.localeCompare(b.Stock))
console.log(`Bid-absorption reversal scan | ${date} | through ${cutoff} IST`)
if (matches.length) console.table(matches); else console.log('No BUY reversal signals found.')
let suffix = 1, outputFile
do { outputFile = path.join(root, 'reports', `${date}-through-${cutoff.replace(':', '')}-bid-absorption-reversal${suffix === 1 ? '' : `-${suffix}`}.json`); suffix++ } while (fs.existsSync(outputFile))
fs.writeFileSync(outputFile, JSON.stringify({ date, cutoff, rules: { absorptionWindows: [10, 15, 20], reversalCandles: '2-5', absorption: 'mean bid >=55%, bid-dominant snapshots >=65%, bid-dominant minutes >=70%, price and midpoint <=-0.10%', reversal: 'mean bid >=55%, bid-dominant snapshots >=65%, bid-dominant minutes >=60%, price >=+0.30%, midpoint >=+0.25%, close above absorption end, at least two rising closes' }, signals: matches, skipped }, null, 2) + '\n', { flag: 'wx' })
console.log(`Signals: ${matches.length}/${symbols.length}`)
console.log(`Saved report: ${outputFile}`)
