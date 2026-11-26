import fs from 'node:fs'
import path from 'node:path'

const root = process.cwd()
const minuteMs = 60_000

function parseArgs(argv) {
  const args = {}
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index]
    if (!token.startsWith('--')) continue
    const [name, inline] = token.slice(2).split('=', 2)
    args[name] = inline ?? argv[++index]
  }
  return args
}

function istToday() {
  return new Date(Date.now() + 330 * minuteMs).toISOString().slice(0, 10)
}

const args = parseArgs(process.argv.slice(2))
if (args.help) {
  console.log(`Usage:
  node scripts/scan-moderate-ask-momentum-returns.js --date YYYY-MM-DD --cutoff HH:MM [--symbols "NSE:AAA-EQ,NSE:BBB-EQ"]

Options:
  --date              NSE session date; defaults to today's IST date
  --cutoff            Last completed one-minute candle to include; required
  --cutoff-datetime   Alternative YYYY-MM-DDTHH:MM form
  --symbols           Optional comma-separated symbols; defaults to all cash-depth stocks

Signal rules:
  First chronological 3-10 minute window with mean ask share >=55% and price rise >=0.25%.
  Keep only when return from 09:15 open >=0.45%, signal EMA10-EMA20 gap <=21 bps,
  and distance from next completed candle close to period-start candle low >=0.50%.
  Exit at SL, first EMA10 cross below EMA20, or cutoff close.`)
  process.exit(0)
}

let date = args.date ?? istToday(), cutoff = args.cutoff
if (args['cutoff-datetime']) {
  const match = String(args['cutoff-datetime']).match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})$/)
  if (!match) throw new Error('--cutoff-datetime must use YYYY-MM-DDTHH:MM')
  date = match[1]; cutoff = match[2]
}
if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(cutoff ?? '')) throw new Error('Provide --date YYYY-MM-DD and --cutoff HH:MM, or --cutoff-datetime YYYY-MM-DDTHH:MM')
if (cutoff < '09:17' || cutoff > '15:29') throw new Error('--cutoff must be between 09:17 and 15:29 IST')

const sessionStartAt = Date.parse(`${date}T09:15:00+05:30`)
const cutoffAt = Date.parse(`${date}T${cutoff}:00+05:30`)
const depthEndAt = cutoffAt + minuteMs
const depthRoot = path.join(root, 'db', 'cash-depth', date)
if (!fs.existsSync(depthRoot)) throw new Error(`Depth directory is missing: ${depthRoot}`)

const normalizeSymbol = value => String(value).replace(/\s+/g, '').replace(/^NSE:/i, '').replace(/-EQ$/i, '').toUpperCase()
const requestedSymbols = args.symbols
  ? [...new Set(String(args.symbols).split(',').map(normalizeSymbol).filter(Boolean))]
  : fs.readdirSync(depthRoot, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => normalizeSymbol(entry.name)).sort()
const clock = at => new Date(at + 330 * minuteMs).toISOString().slice(11, 16)
const round = (value, digits = 3) => Number(value.toFixed(digits))
const pct = (to, from) => 100 * (to / from - 1)

function loadCandles(symbol) {
  const file = path.join(root, 'db', 'candles', `${symbol}.jsonl`)
  if (!fs.existsSync(file)) throw new Error(`Missing candle file: ${file}`)
  const rows = fs.readFileSync(file, 'utf8').split(/\r?\n/).flatMap(line => {
    try {
      const row = JSON.parse(line), at = Number(row.time) * 1000
      return at >= sessionStartAt && at <= cutoffAt
        ? [{ at, minute: clock(at), open: +row.open, high: +row.high, low: +row.low, close: +row.close, volume: +row.volume }]
        : []
    } catch { return [] }
  }).sort((a, b) => a.at - b.at)
  let ema10, ema20
  return rows.map((row, index) => {
    ema10 = index ? ema10 + 2 / 11 * (row.close - ema10) : row.close
    ema20 = index ? ema20 + 2 / 21 * (row.close - ema20) : row.close
    return { ...row, ema10, ema20 }
  })
}

function loadDepthMinutes(symbol) {
  const file = path.join(depthRoot, symbol, `${symbol}.jsonl`)
  if (!fs.existsSync(file)) throw new Error(`Missing depth file: ${file}`)
  const state = {}, grouped = new Map()
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue
    let event; try { event = JSON.parse(line) } catch { continue }
    const at = Date.parse(event.receivedAt)
    if (!Number.isFinite(at)) continue
    if (at >= depthEndAt) break
    if (event.kind === 'checkpoint' || event.book) for (const key of Object.keys(state)) delete state[key]
    Object.assign(state, event.data ?? {})
    if (at < sessionStartAt) continue
    let bid = 0, ask = 0, valid = true
    for (let level = 1; level <= 5; level++) {
      const bidPrice = +state[`bid_price${level}`], askPrice = +state[`ask_price${level}`]
      const bidSize = +state[`bid_size${level}`], askSize = +state[`ask_size${level}`]
      if (![bidPrice, askPrice, bidSize, askSize].every(Number.isFinite) || bidPrice <= 0 || askPrice <= bidPrice) { valid = false; break }
      bid += bidSize; ask += askSize
    }
    if (!valid) continue
    const minute = clock(at), bidShare = 100 * bid / (bid + ask || 1)
    if (!grouped.has(minute)) grouped.set(minute, [])
    grouped.get(minute).push(bidShare)
  }
  return [...grouped].map(([minute, values]) => ({ minute, snapshots: values.length, bidShare: values.reduce((sum, value) => sum + value, 0) / values.length }))
}

function firstBaseSignal(minutes, byMinute) {
  let earliest
  for (let from = 0; from < minutes.length; from++) {
    for (let to = from + 2; to < Math.min(minutes.length, from + 10); to++) {
      const window = minutes.slice(from, to + 1), candles = window.map(row => byMinute.get(row.minute))
      if (candles.some(row => !row)) continue
      const snapshots = window.reduce((sum, row) => sum + row.snapshots, 0)
      const askShare = 100 - window.reduce((sum, row) => sum + row.bidShare * row.snapshots, 0) / snapshots
      const risePct = pct(candles.at(-1).close, candles[0].open)
      if (askShare < 55 || risePct < 0.25) continue
      const candidate = { startMinute: window[0].minute, signalMinute: window.at(-1).minute, askShare, risePct, startLow: candles[0].low }
      if (!earliest || candidate.signalMinute < earliest.signalMinute || candidate.signalMinute === earliest.signalMinute && candidate.startMinute > earliest.startMinute) earliest = candidate
    }
  }
  return earliest
}

function scan(symbol) {
  const rows = loadCandles(symbol)
  if (rows.length < 4) return { skip: 'insufficient candles' }
  const byMinute = new Map(rows.map(row => [row.minute, row]))
  const signal = firstBaseSignal(loadDepthMinutes(symbol), byMinute)
  if (!signal) return { skip: 'no base signal' }
  const signalIndex = rows.findIndex(row => row.minute === signal.signalMinute)
  const entryIndex = signalIndex + 1
  if (signalIndex < 0 || entryIndex >= rows.length) return { skip: 'next completed entry candle is after cutoff' }
  const signalCandle = rows[signalIndex], entryCandle = rows[entryIndex]
  const fromOpenPct = pct(signalCandle.close, rows[0].open)
  const emaGapBps = 10_000 * (signalCandle.ema10 - signalCandle.ema20) / signalCandle.close
  const slDistancePct = 100 * (entryCandle.close - signal.startLow) / entryCandle.close
  if (fromOpenPct < 0.45) return { skip: 'return from open below 0.45%' }
  if (emaGapBps > 21) return { skip: 'EMA gap above 21 bps' }
  if (slDistancePct < 0.5) return { skip: 'SL distance below 0.50%' }

  const entry = entryCandle.close, stop = signal.startLow
  let exit = rows.at(-1).close, exitMinute = rows.at(-1).minute, exitReason = 'CUTOFF', maePct = 0
  for (let index = entryIndex + 1; index < rows.length; index++) {
    const row = rows[index], previous = rows[index - 1]
    maePct = Math.min(maePct, pct(row.low, entry))
    const stopHit = row.low <= stop
    const bearishCross = previous.ema10 >= previous.ema20 && row.ema10 < row.ema20
    if (!stopHit && !bearishCross) continue
    exit = stopHit ? stop : row.close
    exitMinute = row.minute
    exitReason = stopHit && bearishCross ? 'SL_AND_EMA_CROSS' : stopHit ? 'SL' : 'EMA10_BELOW_EMA20'
    break
  }
  return {
    table: {
      Stock: symbol,
      Period: `${signal.startMinute}-${signal.signalMinute}`,
      'Ask share': `${signal.askShare.toFixed(1)}%`,
      'From open': `${fromOpenPct >= 0 ? '+' : ''}${fromOpenPct.toFixed(2)}%`,
      'EMA gap': `${emaGapBps.toFixed(1)} bps`,
      'SL distance': `${slDistancePct.toFixed(2)}%`,
      'Final return': `${pct(exit, entry) >= 0 ? '+' : ''}${pct(exit, entry).toFixed(2)}%`
    },
    detail: { stock: symbol, period: `${signal.startMinute}-${signal.signalMinute}`, signalMinute: signal.signalMinute, entryMinute: entryCandle.minute, entry: round(entry), stop: round(stop), exitMinute, exit: round(exit), exitReason, returnPct: round(pct(exit, entry)), maePct: round(maePct), askSharePct: round(signal.askShare), fromOpenPct: round(fromOpenPct), emaGapBps: round(emaGapBps), slDistancePct: round(slDistancePct) }
  }
}

const matches = [], skipped = []
for (let index = 0; index < requestedSymbols.length; index++) {
  const symbol = requestedSymbols[index]
  process.stdout.write(`\r\x1b[2KScanning [${index + 1}/${requestedSymbols.length}] ${symbol}...`)
  try {
    const result = scan(symbol)
    if (result.table) matches.push(result)
    else skipped.push({ stock: symbol, reason: result.skip })
  } catch (error) { skipped.push({ stock: symbol, reason: error.message }) }
}
process.stdout.write('\r\x1b[2K')
matches.sort((left, right) => left.detail.signalMinute.localeCompare(right.detail.signalMinute) || left.detail.stock.localeCompare(right.detail.stock))

console.log(`Moderate ask-momentum signals | ${date} | through ${cutoff} IST`)
if (matches.length) console.table(matches.map(row => row.table))
else console.log('No stocks passed all filters.')

const trades = matches.map(row => row.detail), returns = trades.map(row => row.returnPct)
const summary = {
  stocksScanned: requestedSymbols.length,
  signals: trades.length,
  tradeCount: trades.length,
  winRatePct: trades.length ? round(100 * trades.filter(row => row.returnPct > 0).length / trades.length, 2) : 0,
  averageReturnPct: trades.length ? round(returns.reduce((sum, value) => sum + value, 0) / trades.length) : 0,
  totalReturnPct: round(returns.reduce((sum, value) => sum + value, 0)),
  maximumAdverseExcursionPct: trades.length ? round(Math.min(...trades.map(row => row.maePct))) : 0,
  worstDay: { date, totalReturnPct: round(returns.reduce((sum, value) => sum + value, 0)) },
  skipped: skipped.length
}
const report = {
  date, cutoff, timezone: 'Asia/Kolkata',
  methodology: 'Only completed 1-minute candles and depth snapshots through cutoff are used. The first base signal per stock is tested. Entry is the next completed candle close. Exit is period-start candle-low SL, first completed EMA10-below-EMA20 cross, or cutoff close. Stop is assumed first if SL and cross share a candle. Returns are gross.',
  rules: { meanAskShareMinPct: 55, periodRiseMinPct: 0.25, periodMinutes: '3-10', fromOpenMinPct: 0.45, ema10MinusEma20MaxBps: 21, slDistanceMinPct: 0.5 },
  summary, trades, skipped
}
let suffix = 1, outputFile
do { outputFile = path.join(root, 'reports', `${date}-through-${cutoff.replace(':', '')}-moderate-ask-momentum-returns${suffix === 1 ? '' : `-${suffix}`}.json`); suffix++ } while (fs.existsSync(outputFile))
fs.writeFileSync(outputFile, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' })
console.log(`Saved report: ${outputFile}`)
console.log(`Signals: ${summary.signals} | Win rate: ${summary.winRatePct}% | Average: ${summary.averageReturnPct}% | Total: ${summary.totalReturnPct}% | MAE: ${summary.maximumAdverseExcursionPct}%`)
