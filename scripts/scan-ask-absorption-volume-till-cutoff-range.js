import fs from 'node:fs'
import path from 'node:path'

// Cumulative opening-range scanner. Unlike scan-ask-absorption-volume.js,
// this evaluates one window: 09:15 through the supplied completed cutoff.
const ROOT = process.cwd(), IST = 330 * 60_000, TOP = 10
const cutoffArg = process.argv[2] || '2026-11-20T09:30:00+05:30'
const cutoffMs = Date.parse(cutoffArg)
if (!Number.isFinite(cutoffMs)) throw new Error('Usage: node scripts/scan-ask-absorption-volume-till-cutoff-range.js YYYY-MM-DDTHH:MM:SS+05:30')
const local = time => new Date(Number(time) * 1000 + IST).toISOString().slice(0, 16).replace('T', ' ')
const cutoffLocal = new Date(cutoffMs + IST).toISOString().slice(0, 16).replace('T', ' ')
const DATE = cutoffLocal.slice(0, 10), cutoffMinute = cutoffLocal.slice(11, 16)
const minuteNumber = value => { const [hour, minute] = value.split(':').map(Number); return hour * 60 + minute }
const minuteLabel = value => `${String(Math.floor(value / 60)).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}`
if (minuteNumber(cutoffMinute) < 9 * 60 + 20) throw new Error('Cutoff must be 09:20 IST or later so five completed opening candles exist.')

const universe = JSON.parse(fs.readFileSync(path.join(ROOT, 'db', 'stocks_sector_wise'), 'utf8'))
const symbols = [...new Set(Object.entries(universe).filter(([key]) => key !== '_meta').flatMap(([, values]) => values))].sort()

function candles(symbol) {
  const file = path.join(ROOT, 'db', 'candles', `${symbol}.jsonl`)
  if (!fs.existsSync(file)) return []
  return fs.readFileSync(file, 'utf8').split(/\r?\n/).flatMap(line => {
    try {
      const x = JSON.parse(line), stamp = local(x.time)
      return [{ day: stamp.slice(0, 10), minute: stamp.slice(11), open: +x.open, high: +x.high, low: +x.low, close: +x.close, volume: +x.volume || 0 }]
    } catch { return [] }
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
      if (minute < '09:15' || minute >= cutoffMinute) continue
      if (event.kind === 'checkpoint') for (const key of Object.keys(fields)) delete fields[key]
      Object.assign(fields, event.data || {})
      const bp = +fields.bid_price1, ap = +fields.ask_price1
      const bids = Array.from({ length: 5 }, (_, index) => +fields[`bid_size${index + 1}`])
      const asks = Array.from({ length: 5 }, (_, index) => +fields[`ask_size${index + 1}`])
      if (![bp, ap, ...bids, ...asks].every(Number.isFinite) || ap <= bp) continue
      const ofi = previous && at - previous.at <= 90_000
        ? (bp >= previous.bp ? bids[0] : 0) - (bp <= previous.bp ? previous.bid1 : 0) - (ap <= previous.ap ? asks[0] : 0) + (ap >= previous.ap ? previous.ask1 : 0)
        : 0
      rows.push({ mid: (bp + ap) / 2, bp, ap, bid: bids.reduce((sum, value) => sum + value, 0), ask: asks.reduce((sum, value) => sum + value, 0), ofi })
      previous = { at, bp, ap, bid1: bids[0], ask1: asks[0] }
    } catch {}
  }
  return rows
}

function score(direction, values) {
  const price = direction === 'BUY'
    ? values.midpointPct + values.quotePct + values.openingReturn + values.closeVsVwap
    : -values.midpointPct - values.quotePct - values.openingReturn - values.closeVsVwap
  return +(price + Math.max(0, values.volumeRatio - 1)).toFixed(3)
}

const buyCandidates = [], sellCandidates = []
for (let index = 0; index < symbols.length; index++) {
  const symbol = symbols[index]
  process.stdout.write(`\rScanning ${index + 1}/${symbols.length} ${symbol}`.padEnd(52))
  const candleRows = candles(symbol), depthRows = depth(symbol)
  const priorDays = [...new Set(candleRows.map(row => row.day))].filter(day => day < DATE).sort().slice(-5)
  const windowCandles = candleRows.filter(row => row.day === DATE && row.minute >= '09:15' && row.minute < cutoffMinute)
  if (priorDays.length < 5 || depthRows.length < 2 || windowCandles.length < 5) continue

  const volumeToCutoff = day => candleRows.filter(row => row.day === day && row.minute >= '09:15' && row.minute < cutoffMinute).reduce((sum, row) => sum + row.volume, 0)
  const currentVolume = volumeToCutoff(DATE), priorVolumes = priorDays.map(volumeToCutoff)
  const priorAverage = priorVolumes.reduce((sum, value) => sum + value, 0) / priorVolumes.length
  const volumeRank = 1 + priorVolumes.filter(value => value > currentVolume).length, volumeRatio = currentVolume / priorAverage
  const first = depthRows[0], last = depthRows.at(-1)
  const askShare = 100 * (1 - depthRows.reduce((sum, row) => sum + row.bid / (row.bid + row.ask), 0) / depthRows.length)
  const midpointPct = 100 * (last.mid / first.mid - 1), bidPct = 100 * (last.bp / first.bp - 1), askPct = 100 * (last.ap / first.ap - 1)
  const ofi = depthRows.reduce((sum, row) => sum + row.ofi, 0)
  const latest = windowCandles.at(-1), totalVolume = windowCandles.reduce((sum, row) => sum + row.volume, 0)
  const vwap = totalVolume ? windowCandles.reduce((sum, row) => sum + ((row.high + row.low + row.close) / 3) * row.volume, 0) / totalVolume : NaN
  const openingHigh = Math.max(...windowCandles.slice(0, 5).map(row => row.high)), openingLow = Math.min(...windowCandles.slice(0, 5).map(row => row.low))
  const candleRange = latest.high - latest.low || 1
  const openingReturn = 100 * (latest.close / windowCandles[0].open - 1), closeVsVwap = 100 * (latest.close / vwap - 1)
  const closeLocation = 100 * (latest.close - latest.low) / candleRange
  const closeVsOpeningHigh = 100 * (latest.close / openingHigh - 1), closeVsOpeningLow = 100 * (latest.close / openingLow - 1)
  const base = { Stock: symbol, Window: `09:15–${minuteLabel(minuteNumber(cutoffMinute) - 1)}`, 'Known at': cutoffMinute, 'Next completed entry at': minuteLabel(minuteNumber(cutoffMinute) + 1), 'Volume rank /6': volumeRank, 'Volume ratio': +volumeRatio.toFixed(2), 'Opening return %': +openingReturn.toFixed(3), 'VWAP distance %': +closeVsVwap.toFixed(3), 'Close location %': +closeLocation.toFixed(0), OFI: Math.round(ofi) }
  const buyPass = askShare > 50 && midpointPct > 0 && bidPct > 0 && ofi > 0 && ofi < 25_000 && volumeRank === 1 && volumeRatio > 1.5 && openingReturn > .5 && closeVsVwap > 0 && closeLocation >= 65 && closeVsOpeningHigh >= -.35
  if (buyPass) {
    const values = { midpointPct, quotePct: bidPct, openingReturn, closeVsVwap, volumeRatio }
    buyCandidates.push({ ...base, 'Ask share %': +askShare.toFixed(1), 'Midpoint %': +midpointPct.toFixed(3), 'Best bid %': +bidPct.toFixed(3), 'Vs OR5 high %': +closeVsOpeningHigh.toFixed(3), 'Rank score': score('BUY', values) })
  }
  const bidShare = 100 - askShare
  const sellPass = bidShare > 50 && midpointPct < 0 && askPct < 0 && ofi < 0 && ofi > -25_000 && volumeRank === 1 && volumeRatio > 1.5 && openingReturn < -.5 && closeVsVwap < 0 && closeLocation <= 35 && closeVsOpeningLow <= .35
  if (sellPass) {
    const values = { midpointPct, quotePct: askPct, openingReturn, closeVsVwap, volumeRatio }
    sellCandidates.push({ ...base, 'Bid share %': +bidShare.toFixed(1), 'Midpoint %': +midpointPct.toFixed(3), 'Best ask %': +askPct.toFixed(3), 'Vs OR5 low %': +closeVsOpeningLow.toFixed(3), 'Rank score': score('SELL', values) })
  }
}
process.stdout.write('\n')
const rank = rows => rows.sort((left, right) => right['Rank score'] - left['Rank score'] || right['Volume ratio'] - left['Volume ratio'] || left.Stock.localeCompare(right.Stock)).slice(0, TOP).map((row, index) => ({ Rank: index + 1, ...row }))
const buySignals = rank(buyCandidates), sellSignals = rank(sellCandidates)
console.log(`\nTOP ${TOP} BUY signals — cumulative window to ${cutoffMinute} IST`)
console.table(buySignals)
console.log(`\nTOP ${TOP} SELL signals — cumulative window to ${cutoffMinute} IST`)
console.table(sellSignals)
let suffix = 1, report
do { report = path.join(ROOT, 'reports', `${DATE}-${cutoffMinute.replace(':', '')}-ask-absorption-volume-till-cutoff-range${suffix === 1 ? '' : `-${suffix}`}.json`); suffix++ } while (fs.existsSync(report))
fs.writeFileSync(report, `${JSON.stringify({ cutoff: cutoffArg, chronology: 'One cumulative depth-and-candle window starts at 09:15 and ends at the supplied completed cutoff. No later data is read. Entry is the following completed candle.', ranking: 'Eligibility uses the same strict BUY/SELL rules as scan-ask-absorption-volume.js. Eligible names are ranked after eligibility by directional midpoint, best-quote, opening-return, VWAP-distance and volume-ratio strength.', rules: { depthWindow: `09:15 to before ${cutoffMinute}`, buy: ['ask share > 50', 'midpoint > 0', 'best bid > 0', '0 < OFI < 25000', 'volume rank = 1 and ratio > 1.5', 'opening return > 0.5', 'close above VWAP', 'close location >= 65', 'close vs OR5 high >= -0.35'], sell: ['bid share > 50', 'midpoint < 0', 'best ask < 0', '-25000 < OFI < 0', 'volume rank = 1 and ratio > 1.5', 'opening return < -0.5', 'close below VWAP', 'close location <= 35', 'close vs OR5 low <= 0.35'] }, eligibleBuyCount: buyCandidates.length, eligibleSellCount: sellCandidates.length, buySignals, sellSignals }, null, 2)}\n`, { flag: 'wx' })
console.log(`Eligible BUY: ${buyCandidates.length}; eligible SELL: ${sellCandidates.length}; report: ${report}`)
console.log(`TOP BUY NSE symbols: ${buySignals.map(signal => `NSE:${signal.Stock}-EQ`).join(', ')}`)
console.log(`TOP SELL NSE symbols: ${sellSignals.map(signal => `NSE:${signal.Stock}-EQ`).join(', ')}`)
