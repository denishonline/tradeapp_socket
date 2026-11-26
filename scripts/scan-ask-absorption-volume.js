import fs from 'node:fs'
import path from 'node:path'

const ROOT = process.cwd(), IST = 330 * 60_000
const cutoffArg = process.argv[2] || '2026-11-19T09:26:00+05:30'
const cutoffMs = Date.parse(cutoffArg)
if (!Number.isFinite(cutoffMs)) throw new Error('Usage: node scripts/scan-ask-absorption-volume.js YYYY-MM-DDTHH:MM:SS+05:30')
const local = time => new Date(Number(time) * 1000 + IST).toISOString().slice(0, 16).replace('T', ' ')
const cutoffLocal = new Date(cutoffMs + IST).toISOString().slice(0, 16).replace('T', ' '), DATE = cutoffLocal.slice(0, 10), cutoffMinute = cutoffLocal.slice(11, 16)
const minuteNumber = value => { const [hour, minute] = value.split(':').map(Number); return hour * 60 + minute }
const minuteLabel = value => `${String(Math.floor(value / 60)).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}`
const universe = JSON.parse(fs.readFileSync(path.join(ROOT, 'db', 'stocks_sector_wise'), 'utf8'))
const symbols = [...new Set(Object.entries(universe).filter(([key]) => key !== '_meta').flatMap(([, values]) => values))].sort()

function candles(symbol) {
  const file = path.join(ROOT, 'db', 'candles', `${symbol}.jsonl`)
  if (!fs.existsSync(file)) return []
  return fs.readFileSync(file, 'utf8').split(/\r?\n/).flatMap(line => {
    try { const x = JSON.parse(line), stamp = local(x.time); return [{ day: stamp.slice(0, 10), minute: stamp.slice(11), open: +x.open, high: +x.high, low: +x.low, close: +x.close, volume: +x.volume || 0 }] } catch { return [] }
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
      const bids = Array.from({ length: 5 }, (_, i) => +fields[`bid_size${i + 1}`]), asks = Array.from({ length: 5 }, (_, i) => +fields[`ask_size${i + 1}`])
      if (![bp, ap, ...bids, ...asks].every(Number.isFinite) || ap <= bp) continue
      const ofi = previous && at - previous.at <= 90_000 ? (bp >= previous.bp ? bids[0] : 0) - (bp <= previous.bp ? previous.bid1 : 0) - (ap <= previous.ap ? asks[0] : 0) + (ap >= previous.ap ? previous.ask1 : 0) : 0
      rows.push({ minute, mid: (bp + ap) / 2, bp, ap, bid: bids.reduce((a, b) => a + b, 0), ask: asks.reduce((a, b) => a + b, 0), ofi })
      previous = { at, bp, ap, bid1: bids[0], ask1: asks[0] }
    } catch {}
  }
  return rows
}

const buyEmitted = new Map(), sellEmitted = new Map()
const openingMinute = 9 * 60 + 15, cutoffNumber = minuteNumber(cutoffMinute)
for (let index = 0; index < symbols.length; index++) {
  const symbol = symbols[index]
  process.stdout.write(`\rScanning ${index + 1}/${symbols.length} ${symbol}`.padEnd(52))
  const candleRows = candles(symbol), depthRows = depth(symbol)
  const priorDays = [...new Set(candleRows.map(x => x.day))].filter(day => day < DATE).sort().slice(-5)
  if (priorDays.length < 5) continue
  for (let startNumber = openingMinute; startNumber + 5 <= cutoffNumber; startNumber++) {
    const start = minuteLabel(startNumber), end = minuteLabel(startNumber + 5)
    const rows = depthRows.filter(x => x.minute >= start && x.minute < end)
    if (rows.length < 2) continue
    const first = rows[0], last = rows.at(-1), askShare = 100 * (1 - rows.reduce((sum, x) => sum + x.bid / (x.bid + x.ask), 0) / rows.length)
    const midpointPct = 100 * (last.mid / first.mid - 1), bidPct = 100 * (last.bp / first.bp - 1), askPct = 100 * (last.ap / first.ap - 1), ofi = rows.reduce((sum, x) => sum + x.ofi, 0)
    const volumeToEnd = day => candleRows.filter(x => x.day === day && x.minute >= '09:15' && x.minute < end).reduce((sum, x) => sum + x.volume, 0)
    const currentVolume = volumeToEnd(DATE), priorVolumes = priorDays.map(volumeToEnd), priorAverage = priorVolumes.reduce((sum, x) => sum + x, 0) / priorVolumes.length, volumeRank = 1 + priorVolumes.filter(x => x > currentVolume).length, volumeRatio = currentVolume / priorAverage
    const windowCandles = candleRows.filter(x => x.day === DATE && x.minute >= '09:15' && x.minute < end)
    if (windowCandles.length < 5) continue
    const latest = windowCandles.at(-1), totalVolume = windowCandles.reduce((sum, x) => sum + x.volume, 0), vwap = totalVolume ? windowCandles.reduce((sum, x) => sum + ((x.high + x.low + x.close) / 3) * x.volume, 0) / totalVolume : NaN
    const openingHigh = Math.max(...windowCandles.slice(0, 5).map(x => x.high)), openingLow = Math.min(...windowCandles.slice(0, 5).map(x => x.low)), candleRange = latest.high - latest.low || 1
    const openingReturn = 100 * (latest.close / windowCandles[0].open - 1), closeVsVwap = 100 * (latest.close / vwap - 1), closeLocation = 100 * (latest.close - latest.low) / candleRange, closeVsOpeningHigh = 100 * (latest.close / openingHigh - 1), closeVsOpeningLow = 100 * (latest.close / openingLow - 1)
    const absorptionPass = askShare > 50 && midpointPct > 0 && bidPct > 0 && ofi > 0 && ofi < 25_000 && volumeRank === 1 && volumeRatio > 1.5
    const acceptancePass = openingReturn > .5 && closeVsVwap > 0 && closeLocation >= 65 && closeVsOpeningHigh >= -.35
    if (!buyEmitted.has(symbol) && absorptionPass && acceptancePass) {
      buyEmitted.set(symbol, { Stock: symbol, Window: `${start}–${minuteLabel(startNumber + 4)}`, 'Known at': end, 'Ask share %': +askShare.toFixed(1), 'Midpoint %': +midpointPct.toFixed(3), 'Best bid %': +bidPct.toFixed(3), OFI: Math.round(ofi), 'Volume rank /6': volumeRank, 'Volume ratio': +volumeRatio.toFixed(2), 'Opening return %': +openingReturn.toFixed(3), 'Above VWAP %': +closeVsVwap.toFixed(3), 'Close location %': +closeLocation.toFixed(0), 'Vs OR5 high %': +closeVsOpeningHigh.toFixed(3) })
    }
    const bidShare = 100 - askShare
    const distributionPass = bidShare > 50 && midpointPct < 0 && askPct < 0 && ofi < 0 && ofi > -25_000 && volumeRank === 1 && volumeRatio > 1.5
    const sellAcceptancePass = openingReturn < -.5 && closeVsVwap < 0 && closeLocation <= 35 && closeVsOpeningLow <= .35
    if (!sellEmitted.has(symbol) && distributionPass && sellAcceptancePass) {
      sellEmitted.set(symbol, { Stock: symbol, Window: `${start}–${minuteLabel(startNumber + 4)}`, 'Known at': end, 'Bid share %': +bidShare.toFixed(1), 'Midpoint %': +midpointPct.toFixed(3), 'Best ask %': +askPct.toFixed(3), OFI: Math.round(ofi), 'Volume rank /6': volumeRank, 'Volume ratio': +volumeRatio.toFixed(2), 'Opening return %': +openingReturn.toFixed(3), 'Below VWAP %': +closeVsVwap.toFixed(3), 'Close location %': +closeLocation.toFixed(0), 'Vs OR5 low %': +closeVsOpeningLow.toFixed(3) })
    }
    if (buyEmitted.has(symbol) && sellEmitted.has(symbol)) break
  }
}
process.stdout.write('\n')
const buySignals = [...buyEmitted.values()], sellSignals = [...sellEmitted.values()]
for (const signals of [buySignals, sellSignals]) signals.sort((a, b) => a['Known at'].localeCompare(b['Known at']) || b['Volume ratio'] - a['Volume ratio'] || a.Stock.localeCompare(b.Stock))
console.log('\nBUY signals')
console.table(buySignals)
console.log('\nSELL signals')
console.table(sellSignals)
let suffix = 1, report
do { report = path.join(ROOT, 'reports', `${DATE}-${cutoffMinute.replace(':', '')}-ask-absorption-volume-signals${suffix === 1 ? '' : `-${suffix}`}.json`); suffix++ } while (fs.existsSync(report))
fs.writeFileSync(report, `${JSON.stringify({ cutoff: cutoffArg, chronology: 'A signal is emitted only after its completed five-minute depth window. Volume and acceptance inputs are measured only through that window end; rank/average use five prior completed sessions at the same time.', rules: { buy: { askSharePct: '> 50', midpointPct: '> 0', bestBidPct: '> 0', ofi: '> 0 and < 25000', volumeRank: '1 versus previous five sessions', volumeRatio: '> 1.5', openingReturnPct: '> 0.5', closeAboveVwap: true, latestCandleCloseLocationPct: '>= 65', closeVsOpeningFiveMinuteHighPct: '>= -0.35' }, sell: { bidSharePct: '> 50', midpointPct: '< 0', bestAskPct: '< 0', ofi: '< 0 and > -25000', volumeRank: '1 versus previous five sessions', volumeRatio: '> 1.5', openingReturnPct: '< -0.5', closeBelowVwap: true, latestCandleCloseLocationPct: '<= 35', closeVsOpeningFiveMinuteLowPct: '<= 0.35' } }, buySignalCount: buySignals.length, sellSignalCount: sellSignals.length, buySignals, sellSignals }, null, 2)}\n`, { flag: 'wx' })
console.log(`BUY signals: ${buySignals.length}; SELL signals: ${sellSignals.length}; report: ${report}`)
console.log(`BUY NSE symbols: ${buySignals.map(signal => `NSE:${signal.Stock}-EQ`).join(', ')}`)
console.log(`SELL NSE symbols: ${sellSignals.map(signal => `NSE:${signal.Stock}-EQ`).join(', ')}`)
