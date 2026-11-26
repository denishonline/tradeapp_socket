import fs from 'node:fs'
import path from 'node:path'

// Intersects horizontal (five-prior-session) and vertical (today) buy-pressure ranks.
const root = process.cwd()
const date = process.argv[2]
const minute = process.argv[3]
const top = Number(process.argv[4] ?? 10)
const calendar = ['2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09', '2026-10-12', '2026-10-13', '2026-10-14', '2026-10-15', '2026-10-16', '2026-10-19']
if (!calendar.includes(date) || !/^\d{2}:\d{2}$/.test(minute ?? '') || !Number.isInteger(top) || top < 1) {
  throw new Error('Usage: node scripts/compare-five-prior-minute-buy-percent.js YYYY-MM-DD HH:MM [top]')
}
const sessionIndex = calendar.indexOf(date)
if (sessionIndex < 5) throw new Error(`${date} needs five prior sessions in the configured research calendar.`)
const priorDates = calendar.slice(sessionIndex - 5, sessionIndex)
const symbols = [...new Set(JSON.parse(fs.readFileSync(path.join(root, 'db', 'stocks'), 'utf8')).map(x => String(x).trim().toUpperCase().replace(/-EQ$/, '')))]
const targetInstant = new Date(`${date}T${minute}:00+05:30`)
const prefixesFor = day => {
  const current = new Date(`${day}T${minute}:00+05:30`)
  return { target: current.toISOString().slice(0, 16), prior: new Date(current.getTime() - 60_000).toISOString().slice(0, 16) }
}
const round = (value, digits = 2) => Number(value.toFixed(digits))
const unique = (folder, stem, extension) => {
  let n = 1, file
  do { file = path.join(folder, `${stem}${n === 1 ? '' : `-${n}`}.${extension}`); n++ } while (fs.existsSync(file))
  return file
}
const csv = value => { const text = value == null ? '' : String(value); return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text }

function calculate(day, symbol) {
  const file = path.join(root, 'db', 'cash-depth', day, symbol, `${symbol}.jsonl`)
  if (!fs.existsSync(file)) return null
  const prefixes = prefixesFor(day)
  let previousPrice = null, previousVolume = null, direction = 0
  let buyVolume = 0, sellVolume = 0, unclassifiedVolume = 0, snapshots = 0
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue
    const isTarget = line.includes(`"receivedAt":"${prefixes.target}:`)
    if (!isTarget && !line.includes(`"receivedAt":"${prefixes.prior}:`)) continue
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

const rows = symbols.map(symbol => {
  const prior = Object.fromEntries(priorDates.map(day => [day, calculate(day, symbol)]))
  const today = calculate(date, symbol)
  const priorValues = Object.values(prior)
  const hasFullPriorCoverage = priorValues.every(Boolean)
  const priorBuyVolume = hasFullPriorCoverage ? priorValues.reduce((sum, row) => sum + row.buyVolume, 0) : null
  const priorSellVolume = hasFullPriorCoverage ? priorValues.reduce((sum, row) => sum + row.sellVolume, 0) : null
  const priorClassifiedVolume = hasFullPriorCoverage ? priorBuyVolume + priorSellVolume : null
  return { symbol, prior, today, hasFullPriorCoverage, priorBuyVolume, priorSellVolume, priorClassifiedVolume,
    priorBuyPct: priorClassifiedVolume ? round(100 * priorBuyVolume / priorClassifiedVolume) : null }
})
const historical = rows.filter(row => row.hasFullPriorCoverage).sort((a, b) => b.priorBuyPct - a.priorBuyPct || b.priorClassifiedVolume - a.priorClassifiedVolume || a.symbol.localeCompare(b.symbol))
const today = rows.filter(row => row.today).sort((a, b) => b.today.buyPct - a.today.buyPct || b.today.classifiedVolume - a.today.classifiedVolume || a.symbol.localeCompare(b.symbol))
const historicalTop = historical.slice(0, top).map((row, index) => ({ rank: index + 1, symbol: row.symbol, priorBuyPct: row.priorBuyPct, priorClassifiedVolume: row.priorClassifiedVolume, prior: row.prior }))
const todayTop = today.slice(0, top).map((row, index) => ({ rank: index + 1, symbol: row.symbol, today: row.today }))
const historicalRanks = new Map(historicalTop.map(row => [row.symbol, row.rank]))
const todayRanks = new Map(todayTop.map(row => [row.symbol, row.rank]))
const matches = [...historicalRanks.keys()].filter(symbol => todayRanks.has(symbol)).map(symbol => ({ symbol, historicalRank: historicalRanks.get(symbol), todayRank: todayRanks.get(symbol), priorBuyPct: rows.find(row => row.symbol === symbol).priorBuyPct, todayBuyPct: rows.find(row => row.symbol === symbol).today.buyPct }))
const report = {
  date, minute, top, priorDates,
  method: 'Horizontal rank is each stock’s volume-weighted tick-rule estimated buy percentage over the five prior same-clock candles. Vertical rank is today’s estimated buy percentage for the same clock candle across all stocks. Final matches are the intersection of these two top lists. An uptick is BUY, a downtick is SELL, and unchanged prices inherit the prior direction; this is not exchange-confirmed trade side.',
  stocksScanned: symbols.length, stocksWithFullPriorCoverage: historical.length, stocksWithTodayCoverage: today.length,
  historicalTop, todayTop, matches,
}
const stem = `${date}-${minute.replace(':', '')}-five-prior-vs-today-buy-percent-top-${top}`
const json = unique(path.join(root, 'reports'), stem, 'json')
fs.writeFileSync(json, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' })
const outputCsv = unique(path.join(root, 'csv'), stem, 'csv')
const outputRows = symbols.map(symbol => {
  const row = rows.find(item => item.symbol === symbol)
  return { symbol, historicalRank: historicalRanks.get(symbol) ?? null, priorBuyPct: row.priorBuyPct, priorClassifiedVolume: row.priorClassifiedVolume, todayRank: todayRanks.get(symbol) ?? null, todayBuyPct: row.today?.buyPct ?? null, todayClassifiedVolume: row.today?.classifiedVolume ?? null, finalMatch: historicalRanks.has(symbol) && todayRanks.has(symbol) }
})
const columns = ['symbol', 'historicalRank', 'priorBuyPct', 'priorClassifiedVolume', 'todayRank', 'todayBuyPct', 'todayClassifiedVolume', 'finalMatch']
fs.writeFileSync(outputCsv, columns.join(',') + '\n' + outputRows.map(row => columns.map(column => csv(row[column])).join(',')).join('\n') + '\n', { flag: 'wx' })
console.log(JSON.stringify({ date, minute, priorDates, stocksWithFullPriorCoverage: historical.length, stocksWithTodayCoverage: today.length, historicalTop, todayTop, matches, json, csv: outputCsv }, null, 2))
