import fs from 'node:fs'
import path from 'node:path'

// Compares cumulative buy pressure from the opening (09:15) to a cutoff.
// The cutoff candle is excluded: at 09:30, data ends at 09:29:59.
const root = process.cwd()
const date = process.argv[2]
const cutoff = process.argv[3]
const top = Number(process.argv[4] ?? 10)
const calendar = ['2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09', '2026-10-12', '2026-10-13', '2026-10-14', '2026-10-15', '2026-10-16', '2026-10-19']
if (!calendar.includes(date) || !/^\d{2}:\d{2}$/.test(cutoff ?? '') || !Number.isInteger(top) || top < 1) throw new Error('Usage: node scripts/compare-five-prior-opening-buy-percent.js YYYY-MM-DD HH:MM [top]')
const index = calendar.indexOf(date)
if (index < 5) throw new Error(`${date} needs five prior sessions in the configured research calendar.`)
const priorDates = calendar.slice(index - 5, index)
const symbols = [...new Set(JSON.parse(fs.readFileSync(path.join(root, 'db', 'stocks'), 'utf8')).map(x => String(x).trim().toUpperCase().replace(/-EQ$/, '')))]
const openTime = '09:15'
const utc = (day, time) => new Date(`${day}T${time}:00+05:30`).toISOString()
const unique = (folder, stem, extension) => { let n = 1, file; do { file = path.join(folder, `${stem}${n === 1 ? '' : `-${n}`}.${extension}`); n++ } while (fs.existsSync(file)); return file }
const round = (value, digits = 2) => Number(value.toFixed(digits))
const csv = value => { const text = value == null ? '' : String(value); return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text }

function calculate(day, symbol) {
  const file = path.join(root, 'db', 'cash-depth', day, symbol, `${symbol}.jsonl`)
  if (!fs.existsSync(file)) return null
  const start = utc(day, openTime), end = utc(day, cutoff)
  const baselineStart = utc(day, '09:14')
  let previousPrice = null, previousVolume = null, direction = 0, buyVolume = 0, sellVolume = 0, unclassifiedVolume = 0, snapshots = 0
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    // Reading the timestamp first avoids parsing the full JSON outside the opening window.
    const match = /"receivedAt":"([^"]+)"/.exec(line)
    if (!match) continue
    const receivedAt = match[1]
    const isTarget = receivedAt >= start && receivedAt < end
    // The preceding minute supplies the price/volume/direction baseline.
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
  return snapshots && classifiedVolume ? { buyVolume, sellVolume, unclassifiedVolume, classifiedVolume, snapshots, buyPct: round(100 * buyVolume / classifiedVolume) } : null
}

const allRows = symbols.map(symbol => {
  const prior = Object.fromEntries(priorDates.map(day => [day, calculate(day, symbol)]))
  const today = calculate(date, symbol)
  const values = Object.values(prior), hasFullPriorCoverage = values.every(Boolean)
  const priorBuyVolume = hasFullPriorCoverage ? values.reduce((sum, row) => sum + row.buyVolume, 0) : null
  const priorSellVolume = hasFullPriorCoverage ? values.reduce((sum, row) => sum + row.sellVolume, 0) : null
  const priorClassifiedVolume = hasFullPriorCoverage ? priorBuyVolume + priorSellVolume : null
  return { symbol, prior, today, hasFullPriorCoverage, priorBuyVolume, priorSellVolume, priorClassifiedVolume, priorBuyPct: priorClassifiedVolume ? round(100 * priorBuyVolume / priorClassifiedVolume) : null }
})
const historical = allRows.filter(row => row.hasFullPriorCoverage).sort((a, b) => b.priorBuyPct - a.priorBuyPct || b.priorClassifiedVolume - a.priorClassifiedVolume || a.symbol.localeCompare(b.symbol))
const today = allRows.filter(row => row.today).sort((a, b) => b.today.buyPct - a.today.buyPct || b.today.classifiedVolume - a.today.classifiedVolume || a.symbol.localeCompare(b.symbol))
const historicalTop = historical.slice(0, top).map((row, i) => ({ rank: i + 1, symbol: row.symbol, buyPct: row.priorBuyPct, classifiedVolume: row.priorClassifiedVolume }))
const todayTop = today.slice(0, top).map((row, i) => ({ rank: i + 1, symbol: row.symbol, buyPct: row.today.buyPct, classifiedVolume: row.today.classifiedVolume }))
const historicalRanks = new Map(historicalTop.map(row => [row.symbol, row.rank])), todayRanks = new Map(todayTop.map(row => [row.symbol, row.rank]))
const matches = historicalTop.filter(row => todayRanks.has(row.symbol)).map(row => ({ symbol: row.symbol, historicalRank: row.rank, historicalBuyPct: row.buyPct, todayRank: todayRanks.get(row.symbol), todayBuyPct: today.find(item => item.symbol === row.symbol).today.buyPct }))
const report = { date, cutoff, window: `${openTime}:00–${cutoff}:00 IST (cutoff candle excluded)`, priorDates,
  method: 'For each day, sums tick-rule estimated buy and sell volume across the completed one-minute opening candles from 09:15 until the cutoff. Horizontal ranking uses each stock’s five-prior-session volume-weighted buy percentage; vertical ranking uses today’s cumulative opening buy percentage. Final matches are in both top lists. This is an estimate from price/cumulative-volume changes, not exchange-confirmed aggressor side.',
  stocksScanned: symbols.length, stocksWithFullPriorCoverage: historical.length, stocksWithTodayCoverage: today.length, historicalTop, todayTop, matches }
const stem = `${date}-${openTime.replace(':', '')}-to-${cutoff.replace(':', '')}-five-prior-vs-today-opening-buy-percent-top-${top}`
const json = unique(path.join(root, 'reports'), stem, 'json'); fs.writeFileSync(json, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' })
const outputCsv = unique(path.join(root, 'csv'), stem, 'csv')
const outputRows = allRows.map(row => ({ symbol: row.symbol, historicalRank: historicalRanks.get(row.symbol) ?? null, historicalBuyPct: row.priorBuyPct, historicalClassifiedVolume: row.priorClassifiedVolume, todayRank: todayRanks.get(row.symbol) ?? null, todayBuyPct: row.today?.buyPct ?? null, todayClassifiedVolume: row.today?.classifiedVolume ?? null, finalMatch: historicalRanks.has(row.symbol) && todayRanks.has(row.symbol) }))
const columns = ['symbol', 'historicalRank', 'historicalBuyPct', 'historicalClassifiedVolume', 'todayRank', 'todayBuyPct', 'todayClassifiedVolume', 'finalMatch']
fs.writeFileSync(outputCsv, columns.join(',') + '\n' + outputRows.map(row => columns.map(column => csv(row[column])).join(',')).join('\n') + '\n', { flag: 'wx' })
console.log(JSON.stringify({ date, cutoff, window: report.window, priorDates, stocksWithFullPriorCoverage: historical.length, stocksWithTodayCoverage: today.length, historicalTop, todayTop, matches, json, csv: outputCsv }, null, 2))
