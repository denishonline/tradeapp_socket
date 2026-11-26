import fs from 'node:fs'
import path from 'node:path'

// Ranks estimated aggressive volume, using the same tick-rule classification
// as the opening buy-percentage reports. A cutoff excludes its in-progress candle.
const root = process.cwd()
const date = process.argv[2]
const cutoff = process.argv[3] ?? '10:00'
const top = Number(process.argv[4] ?? 10)
if (!/^\d{4}-\d{2}-\d{2}$/.test(date ?? '') || !/^\d{2}:\d{2}$/.test(cutoff) || !Number.isInteger(top) || top < 1) throw new Error('Usage: node scripts/rank-opening-buy-sell-executed-volume.js YYYY-MM-DD [HH:MM] [top]')
const symbols = [...new Set(JSON.parse(fs.readFileSync(path.join(root, 'db', 'stocks'), 'utf8')).map(x => String(x).trim().toUpperCase().replace(/-EQ$/, '')))]
const utc = time => new Date(`${date}T${time}:00+05:30`).toISOString()
const start = utc('09:15'), baselineStart = utc('09:14'), end = utc(cutoff)
const unique = (folder, stem, extension) => { let n = 1, file; do { file = path.join(folder, `${stem}${n === 1 ? '' : `-${n}`}.${extension}`); n++ } while (fs.existsSync(file)); return file }
const csv = value => { const text = value == null ? '' : String(value); return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text }

function calculate(symbol) {
  const file = path.join(root, 'db', 'cash-depth', date, symbol, `${symbol}.jsonl`)
  if (!fs.existsSync(file)) return null
  let previousPrice = null, previousVolume = null, direction = 0, buyVolume = 0, sellVolume = 0, unclassifiedVolume = 0, snapshots = 0
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = /"receivedAt":"([^"]+)"/.exec(line)
    if (!match) continue
    const receivedAt = match[1]
    const isTarget = receivedAt >= start && receivedAt < end
    if (!isTarget && receivedAt < baselineStart) continue
    if (receivedAt >= end) break
    let event
    try { event = JSON.parse(line) } catch { continue }
    const price = Number(event.marketContext?.price), volume = Number(event.marketContext?.cumulativeVolume)
    if (!Number.isFinite(price) || !Number.isFinite(volume)) continue
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
  return snapshots && classifiedVolume ? { symbol, buyVolume, sellVolume, unclassifiedVolume, classifiedVolume, snapshots } : null
}

const rows = symbols.map(calculate).filter(Boolean)
const buyTop = [...rows].sort((a, b) => b.buyVolume - a.buyVolume || a.symbol.localeCompare(b.symbol)).slice(0, top)
const sellTop = [...rows].sort((a, b) => b.sellVolume - a.sellVolume || a.symbol.localeCompare(b.symbol)).slice(0, top)
const report = { date, cutoff, window: `09:15:00–${cutoff}:00 IST (cutoff candle excluded)`,
  method: 'Estimated buy/sell-initiated volume from depth-feed marketContext price and cumulative volume. An uptick is BUY, a downtick is SELL, unchanged prices inherit prior direction. This is not exchange-confirmed executed-order side.',
  stocksScanned: symbols.length, stocksWithClassifiedVolume: rows.length, buyTop, sellTop, rows }
const stem = `${date}-0915-to-${cutoff.replace(':', '')}-top-${top}-buy-sell-executed-volume`
const json = unique(path.join(root, 'reports'), stem, 'json'); fs.writeFileSync(json, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' })
const outputCsv = unique(path.join(root, 'csv'), stem, 'csv')
const columns = ['symbol', 'buyVolume', 'sellVolume', 'classifiedVolume', 'unclassifiedVolume', 'snapshots']
fs.writeFileSync(outputCsv, columns.join(',') + '\n' + rows.sort((a, b) => b.classifiedVolume - a.classifiedVolume).map(row => columns.map(column => csv(row[column])).join(',')).join('\n') + '\n', { flag: 'wx' })
console.log(JSON.stringify({ date, cutoff, window: report.window, stocksScanned: symbols.length, stocksWithClassifiedVolume: rows.length, buyTop, sellTop, json, csv: outputCsv }, null, 2))
