import fs from 'node:fs'
import path from 'node:path'

const root = process.cwd()
const date = process.argv[2]
const minute = process.argv[3]
const top = Number(process.argv[4] ?? 5)
if (!/^\d{4}-\d{2}-\d{2}$/.test(date ?? '') || !/^\d{2}:\d{2}$/.test(minute ?? '') || !Number.isInteger(top) || top < 1) {
  throw new Error('Usage: node scripts/rank-minute-buy-percent.js YYYY-MM-DD HH:MM [top]')
}
const symbols = [...new Set(JSON.parse(fs.readFileSync(path.join(root, 'db', 'stocks'), 'utf8')).map(x => String(x).trim().toUpperCase().replace(/-EQ$/, '')))]
const targetInstant = new Date(`${date}T${minute}:00+05:30`)
const targetPrefix = targetInstant.toISOString().slice(0, 16)
const priorPrefix = new Date(targetInstant.getTime() - 60_000).toISOString().slice(0, 16)
const round = (value, digits = 2) => Number(value.toFixed(digits))
const unique = (folder, stem, extension) => {
  let n = 1, file
  do { file = path.join(folder, `${stem}${n === 1 ? '' : `-${n}`}.${extension}`); n++ } while (fs.existsSync(file))
  return file
}
const csv = value => {
  const text = value == null ? '' : String(value)
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
}

function calculate(symbol) {
  const file = path.join(root, 'db', 'cash-depth', date, symbol, `${symbol}.jsonl`)
  if (!fs.existsSync(file)) return null
  let previousPrice = null, previousVolume = null, direction = 0
  let buyVolume = 0, sellVolume = 0, unclassifiedVolume = 0, snapshots = 0
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue
    // The preceding minute provides the initial price/volume/direction state;
    // parsing only these two minutes keeps the all-stock scan fast.
    const isTarget = line.includes(`"receivedAt":"${targetPrefix}:`)
    if (!isTarget && !line.includes(`"receivedAt":"${priorPrefix}:`)) continue
    let event
    try { event = JSON.parse(line) } catch { continue }
    const price = Number(event.marketContext?.price), volume = Number(event.marketContext?.cumulativeVolume)
    if (!event.receivedAt || !Number.isFinite(price) || !Number.isFinite(volume)) continue
    if (previousVolume != null && isTarget) {
      const delta = volume - previousVolume
      if (delta > 0) {
        if (price > previousPrice) direction = 1
        else if (price < previousPrice) direction = -1
        if (direction === 1) buyVolume += delta
        else if (direction === -1) sellVolume += delta
        else unclassifiedVolume += delta
      }
    } else if (previousPrice != null && price > previousPrice) direction = 1
    else if (previousPrice != null && price < previousPrice) direction = -1
    if (isTarget) snapshots++
    previousPrice = price
    previousVolume = volume
  }
  const classifiedVolume = buyVolume + sellVolume
  if (!snapshots || !classifiedVolume) return null
  return { symbol, buyPct: round(100 * buyVolume / classifiedVolume), buyVolume, sellVolume, unclassifiedVolume, classifiedVolume, snapshots }
}

const rows = symbols.map(calculate).filter(Boolean).sort((a, b) => b.buyPct - a.buyPct || b.classifiedVolume - a.classifiedVolume || a.symbol.localeCompare(b.symbol))
const report = {
  date, minute, top,
  method: 'Estimated buy-initiated percentage for one completed minute using depth-feed marketContext price and cumulative volume. An uptick is BUY, a downtick is SELL, and unchanged prices inherit the prior direction. This is a tick-rule estimate, not exchange-confirmed execution side.',
  stocksScanned: symbols.length, stocksWithClassifiedVolume: rows.length,
  topStocks: rows.slice(0, top), rows,
}
const stem = `${date}-${minute.replace(':', '')}-top-${top}-buy-percent`
const json = unique(path.join(root, 'reports'), stem, 'json')
fs.writeFileSync(json, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' })
const outputCsv = unique(path.join(root, 'csv'), stem, 'csv')
const columns = ['rank', 'symbol', 'buyPct', 'buyVolume', 'sellVolume', 'classifiedVolume', 'unclassifiedVolume', 'snapshots']
fs.writeFileSync(outputCsv, columns.join(',') + '\n' + rows.map((row, index) => columns.map(column => csv(column === 'rank' ? index + 1 : row[column])).join(',')).join('\n') + '\n', { flag: 'wx' })
console.log(JSON.stringify({ date, minute, stocksScanned: symbols.length, stocksWithClassifiedVolume: rows.length, topStocks: report.topStocks, json, csv: outputCsv }, null, 2))
