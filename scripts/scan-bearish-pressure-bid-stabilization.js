import fs from 'node:fs'
import path from 'node:path'

// Finds a causal two-leg sequence:
// 1) high-participation bearish pressure while displayed bid depth is dominant;
// 2) immediate bid-led stabilization which remains below the pressure start.
const ROOT = process.cwd(), IST = 330 * 60_000, DATE = process.argv[2] || '2026-11-20', CUTOFF = process.argv[3] || '11:30'
const OPEN = 9 * 60 + 15, WINDOW = 5, cutoffNumber = minuteNumber(CUTOFF)
if (!/^\d{4}-\d{2}-\d{2}$/.test(DATE) || cutoffNumber < OPEN + WINDOW * 2) throw new Error('Usage: node scripts/scan-bearish-pressure-bid-stabilization.js YYYY-MM-DD HH:MM')
const universe = JSON.parse(fs.readFileSync(path.join(ROOT, 'db', 'stocks_sector_wise'), 'utf8'))
const symbols = [...new Set(Object.entries(universe).filter(([key]) => key !== '_meta').flatMap(([, values]) => values))].sort()
const local = time => new Date(Number(time) * 1000 + IST).toISOString().slice(0, 16).replace('T', ' ')
function minuteNumber(value) { const [hour, minute] = value.split(':').map(Number); return hour * 60 + minute }
const minuteLabel = value => `${String(Math.floor(value / 60)).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}`
const sum = values => values.reduce((total, value) => total + value, 0)
const average = values => sum(values) / values.length
const round = (value, places = 3) => +value.toFixed(places)

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
      const bids = Array.from({ length: 5 }, (_, index) => +fields[`bid_size${index + 1}`])
      const asks = Array.from({ length: 5 }, (_, index) => +fields[`ask_size${index + 1}`])
      if (![bp, ap, ...bids, ...asks].every(Number.isFinite) || ap <= bp) continue
      const ofi = previous && at - previous.at <= 90_000
        ? (bp >= previous.bp ? bids[0] : 0) - (bp <= previous.bp ? previous.bid1 : 0) - (ap <= previous.ap ? asks[0] : 0) + (ap >= previous.ap ? previous.ask1 : 0)
        : 0
      rows.push({ minute, mid: (bp + ap) / 2, bp, ap, bid: sum(bids), ask: sum(asks), ofi })
      previous = { at, bp, ap, bid1: bids[0], ask1: asks[0] }
    } catch {}
  }
  return rows
}

function sliceMinute(rows, startNumber, length) {
  const start = minuteLabel(startNumber), end = minuteLabel(startNumber + length)
  return rows.filter(row => row.minute >= start && row.minute < end)
}

function analyze(symbol) {
  const candleRows = candles(symbol), depthRows = depth(symbol)
  const priorDays = [...new Set(candleRows.map(row => row.day))].filter(day => day < DATE).sort().slice(-5)
  if (priorDays.length < 5) return []
  const matches = []
  for (let start = OPEN; start + WINDOW * 2 <= cutoffNumber; start++) {
    const pressureBook = sliceMinute(depthRows, start, WINDOW), recoveryBook = sliceMinute(depthRows, start + WINDOW, WINDOW)
    const pressureBars = candleRows.filter(row => row.day === DATE && row.minute >= minuteLabel(start) && row.minute < minuteLabel(start + WINDOW))
    const recoveryBars = candleRows.filter(row => row.day === DATE && row.minute >= minuteLabel(start + WINDOW) && row.minute < minuteLabel(start + WINDOW * 2))
    if (pressureBook.length < 2 || recoveryBook.length < 2 || pressureBars.length < WINDOW || recoveryBars.length < WINDOW) continue
    const pFirst = pressureBook[0], pLast = pressureBook.at(-1), rFirst = recoveryBook[0], rLast = recoveryBook.at(-1)
    const midpointPct = 100 * (pLast.mid / pFirst.mid - 1), bidPct = 100 * (pLast.bp / pFirst.bp - 1), askPct = 100 * (pLast.ap / pFirst.ap - 1)
    const pressureOfi = sum(pressureBook.map(row => row.ofi)), pressureBidShare = 100 * average(pressureBook.map(row => row.bid / (row.bid + row.ask)))
    const pressureReturn = 100 * (pressureBars.at(-1).close / pressureBars[0].open - 1)
    const currentVolume = sum(pressureBars.map(row => row.volume))
    const priorVolumes = priorDays.map(day => sum(candleRows.filter(row => row.day === day && row.minute >= minuteLabel(start) && row.minute < minuteLabel(start + WINDOW)).map(row => row.volume)))
    const volumeRatio = currentVolume / average(priorVolumes)
    const pressurePass = midpointPct <= -.15 && bidPct < 0 && askPct < 0 && pressureOfi <= -25_000 && pressureReturn <= -.15 && volumeRatio >= 1.5 && pressureBidShare > 50
    if (!pressurePass) continue
    const recoveryMidpointPct = 100 * (rLast.mid / rFirst.mid - 1), recoveryOfi = sum(recoveryBook.map(row => row.ofi))
    const recoveryBidShare = 100 * average(recoveryBook.map(row => row.bid / (row.bid + row.ask)))
    const recoveryReturn = 100 * (recoveryBars.at(-1).close / recoveryBars[0].open - 1)
    const stillBelowPressureStart = recoveryBars.at(-1).close < pressureBars[0].open
    const stabilizationPass = recoveryMidpointPct >= 0 && recoveryOfi > 0 && recoveryBidShare > 50 && recoveryReturn >= 0 && stillBelowPressureStart
    if (!stabilizationPass) continue
    matches.push({ Stock: symbol, Pressure: `${minuteLabel(start)}–${minuteLabel(start + WINDOW - 1)}`, Stabilization: `${minuteLabel(start + WINDOW)}–${minuteLabel(start + WINDOW * 2 - 1)}`, 'Known at': minuteLabel(start + WINDOW * 2), 'Pressure bid share %': round(pressureBidShare, 1), 'Pressure midpoint %': round(midpointPct), 'Pressure OFI': Math.round(pressureOfi), 'Pressure return %': round(pressureReturn), 'Pressure volume ratio': round(volumeRatio, 2), 'Recovery bid share %': round(recoveryBidShare, 1), 'Recovery midpoint %': round(recoveryMidpointPct), 'Recovery OFI': Math.round(recoveryOfi), 'Recovery return %': round(recoveryReturn), 'Recovery close below pressure start': true })
  }
  return matches
}

const matches = []
for (let index = 0; index < symbols.length; index++) {
  process.stdout.write(`\rScanning ${index + 1}/${symbols.length} ${symbols[index]}`.padEnd(52))
  matches.push(...analyze(symbols[index]))
}
process.stdout.write('\n')
matches.sort((left, right) => right['Pressure volume ratio'] - left['Pressure volume ratio'] || left['Pressure midpoint %'] - right['Pressure midpoint %'] || left.Stock.localeCompare(right.Stock))
console.table(matches)
let suffix = 1, report
do { report = path.join(ROOT, 'reports', `${DATE}-${CUTOFF.replace(':', '')}-bearish-pressure-bid-stabilization${suffix === 1 ? '' : `-${suffix}`}.json`); suffix++ } while (fs.existsSync(report))
fs.writeFileSync(report, `${JSON.stringify({ date: DATE, cutoff: CUTOFF, chronology: 'The five-minute pressure leg is fully complete before the five-minute stabilization leg begins. The signal is known only after the stabilization leg completes.', rules: { pressure: ['midpoint <= -0.15%', 'best bid and best ask fall', 'quote OFI <= -25000', 'five-minute return <= -0.15%', 'volume ratio >= 1.5 versus prior five sessions at same clock', 'average top-five bid share > 50%'], stabilization: ['immediate following five minutes', 'midpoint >= 0%', 'quote OFI > 0', 'average top-five bid share > 50%', 'five-minute return >= 0%', 'recovery close remains below pressure-window opening price'] }, matchCount: matches.length, matches }, null, 2)}\n`, { flag: 'wx' })
console.log(`Matches: ${matches.length}; report: ${report}`)
console.log(`NSE symbols: ${[...new Set(matches.map(row => `NSE:${row.Stock}-EQ`))].join(', ')}`)
