import fs from 'node:fs'
import path from 'node:path'

// Extends the all-universe pressure/stabilization scan into one causal 20-minute
// sequence: 5m sell pressure, 5m bid stabilization, 10m bullish reversal.
const ROOT = process.cwd(), IST = 330 * 60_000, DATE = process.argv[2] || '2026-11-20', CUTOFF = process.argv[3] || '11:30'
const cutoffNumber = minuteNumber(CUTOFF)
const minuteLabel = value => `${String(Math.floor(value / 60)).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}`
function minuteNumber(value) { const [hour, minute] = value.split(':').map(Number); return hour * 60 + minute }
const local = time => new Date(Number(time) * 1000 + IST).toISOString().slice(0, 16).replace('T', ' ')
const sum = values => values.reduce((total, value) => total + value, 0)
const average = values => sum(values) / values.length
const round = (value, places = 3) => +value.toFixed(places)
const reportStem = `${DATE}-${CUTOFF.replace(':', '')}-bearish-pressure-bid-stabilization`
const source = fs.readdirSync(path.join(ROOT, 'reports')).filter(name => name.startsWith(reportStem) && name.endsWith('.json')).sort().at(-1)
if (!source) throw new Error(`Run scan-bearish-pressure-bid-stabilization.js ${DATE} ${CUTOFF} first.`)
const firstTwoLegs = JSON.parse(fs.readFileSync(path.join(ROOT, 'reports', source), 'utf8')).matches || []

function candles(symbol) {
  const file = path.join(ROOT, 'db', 'candles', `${symbol}.jsonl`)
  if (!fs.existsSync(file)) return []
  return fs.readFileSync(file, 'utf8').split(/\r?\n/).flatMap(line => {
    try { const row = JSON.parse(line), stamp = local(row.time); return [{ day: stamp.slice(0, 10), minute: stamp.slice(11), open: +row.open, close: +row.close, volume: +row.volume || 0 }] } catch { return [] }
  })
}

function depth(symbol) {
  const file = path.join(ROOT, 'db', 'cash-depth', DATE, symbol, `${symbol}.jsonl`)
  if (!fs.existsSync(file)) return []
  const fields = {}, rows = []; let previous = null
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    try {
      if (!line.trim()) continue
      const event = JSON.parse(line), at = Date.parse(event.receivedAt), minute = new Date(at + IST).toISOString().slice(11, 16)
      if (minute < '09:15' || minute >= CUTOFF) continue
      if (event.kind === 'checkpoint') for (const key of Object.keys(fields)) delete fields[key]
      Object.assign(fields, event.data || {})
      const bp = +fields.bid_price1, ap = +fields.ask_price1
      const bids = Array.from({ length: 5 }, (_, index) => +fields[`bid_size${index + 1}`]), asks = Array.from({ length: 5 }, (_, index) => +fields[`ask_size${index + 1}`])
      if (![bp, ap, ...bids, ...asks].every(Number.isFinite) || ap <= bp) continue
      const ofi = previous && at - previous.at <= 90_000 ? (bp >= previous.bp ? bids[0] : 0) - (bp <= previous.bp ? previous.bid1 : 0) - (ap <= previous.ap ? asks[0] : 0) + (ap >= previous.ap ? previous.ask1 : 0) : 0
      rows.push({ minute, mid: (bp + ap) / 2, bp, ap, ofi })
      previous = { at, bp, ap, bid1: bids[0], ask1: asks[0] }
    } catch {}
  }
  return rows
}

const cache = new Map(), matches = []
for (let index = 0; index < firstTwoLegs.length; index++) {
  const candidate = firstTwoLegs[index], symbol = candidate.Stock
  process.stdout.write(`\rChecking ${index + 1}/${firstTwoLegs.length} ${symbol}`.padEnd(50))
  if (!cache.has(symbol)) cache.set(symbol, { candles: candles(symbol), depth: depth(symbol) })
  const data = cache.get(symbol), pressureStart = minuteNumber(String(candidate.Pressure).slice(0, 5)), reversalStart = pressureStart + 10, reversalEnd = pressureStart + 20
  if (reversalEnd > cutoffNumber) continue
  const start = minuteLabel(reversalStart), end = minuteLabel(reversalEnd)
  const bars = data.candles.filter(row => row.day === DATE && row.minute >= start && row.minute < end)
  const book = data.depth.filter(row => row.minute >= start && row.minute < end)
  const priorDays = [...new Set(data.candles.map(row => row.day))].filter(day => day < DATE).sort().slice(-5)
  if (bars.length < 10 || book.length < 2 || priorDays.length < 5) continue
  const first = book[0], last = book.at(-1), midpointPct = 100 * (last.mid / first.mid - 1), bidPct = 100 * (last.bp / first.bp - 1), askPct = 100 * (last.ap / first.ap - 1), ofi = sum(book.map(row => row.ofi))
  const returnPct = 100 * (bars.at(-1).close / bars[0].open - 1), greens = bars.filter(row => row.close > row.open).length
  const volume = sum(bars.map(row => row.volume)), priorVolumes = priorDays.map(day => sum(data.candles.filter(row => row.day === day && row.minute >= start && row.minute < end).map(row => row.volume))), volumeRatio = volume / average(priorVolumes)
  const pressureStartBar = data.candles.find(row => row.day === DATE && row.minute === minuteLabel(pressureStart))
  const reversalPass = midpointPct >= .30 && bidPct > 0 && askPct > 0 && ofi > 0 && returnPct >= .30 && greens >= 6 && volumeRatio >= 1.5 && bars.at(-1).close > pressureStartBar?.open
  if (reversalPass) matches.push({ Stock: symbol, Pressure: candidate.Pressure, Stabilization: candidate.Stabilization, Reversal: `${start}–${minuteLabel(reversalEnd - 1)}`, 'Known at': end, 'Pressure volume ratio': candidate['Pressure volume ratio'], 'Reversal midpoint %': round(midpointPct), 'Reversal best bid %': round(bidPct), 'Reversal best ask %': round(askPct), 'Reversal OFI': Math.round(ofi), 'Reversal return %': round(returnPct), 'Reversal green candles /10': greens, 'Reversal volume ratio': round(volumeRatio, 2) })
}
process.stdout.write('\n')
matches.sort((left, right) => right['Reversal volume ratio'] - left['Reversal volume ratio'] || right['Reversal return %'] - left['Reversal return %'] || left.Stock.localeCompare(right.Stock))
console.table(matches)
let suffix = 1, report
do { report = path.join(ROOT, 'reports', `${DATE}-${CUTOFF.replace(':', '')}-sell-pressure-stabilization-reversal${suffix === 1 ? '' : `-${suffix}`}.json`); suffix++ } while (fs.existsSync(report))
fs.writeFileSync(report, `${JSON.stringify({ date: DATE, cutoff: CUTOFF, sourceReport: source, chronology: 'First five minutes: pressure. Second five: stabilization below pressure start. Third ten: bullish reversal. Signal is known only at the end of the third leg.', rules: { inheritedPressureAndStabilization: 'See source report.', reversal: ['following 10 minutes', 'midpoint >= +0.30%', 'best bid and best ask rise', 'quote OFI > 0', 'return >= +0.30%', 'at least 6 of 10 candles green', 'volume ratio >= 1.5 versus prior five sessions at same clock', 'final close > pressure-window opening price'] }, matchCount: matches.length, matches }, null, 2)}\n`, { flag: 'wx' })
console.log(`Matches: ${matches.length}; report: ${report}`)
console.log(`NSE symbols: ${[...new Set(matches.map(row => `NSE:${row.Stock}-EQ`))].join(', ')}`)
