import fs from 'node:fs'
import path from 'node:path'

// Estimates aggressive buy volume with the tick rule: an uptick is BUY, a
// downtick is SELL, and an unchanged trade inherits the most recent direction.
// Market-depth snapshots do not provide exchange-confirmed aggressor flags.
const root = process.cwd()
const symbol = (process.argv[2] ?? 'AXISBANK').trim().toUpperCase().replace(/-EQ$/, '')
const sessions = ['2026-10-13', '2026-10-14', '2026-10-15', '2026-10-16', '2026-10-19']
const istMinute = iso => {
  const date = new Date(iso)
  return `${date.toLocaleDateString('sv-SE', { timeZone: 'Asia/Kolkata' })} ${date.toLocaleTimeString('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })}`
}
const clockMinute = iso => istMinute(iso).slice(11)
const inMarket = minute => minute >= '09:15' && minute < '15:30'
const round = (value, digits = 2) => Number(value.toFixed(digits))
const unique = (directory, stem, extension) => {
  let n = 1, file
  do { file = path.join(directory, `${stem}${n === 1 ? '' : `-${n}`}.${extension}`); n++ } while (fs.existsSync(file))
  return file
}
const escapeCsv = value => {
  const text = value == null ? '' : String(value)
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
}

function classifySession(day) {
  const file = path.join(root, 'db', 'cash-depth', day, symbol, `${symbol}.jsonl`)
  if (!fs.existsSync(file)) return { day, rows: [], reason: 'depth file missing' }
  const events = []
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue
    let event
    try { event = JSON.parse(line) } catch { continue }
    const receivedAt = event.receivedAt
    const minute = receivedAt ? clockMinute(receivedAt) : null
    const price = Number(event.marketContext?.price)
    const cumulativeVolume = Number(event.marketContext?.cumulativeVolume)
    if (!minute || !inMarket(minute) || !Number.isFinite(price) || !Number.isFinite(cumulativeVolume)) continue
    events.push({ receivedAt, minute, price, cumulativeVolume })
  }
  events.sort((a, b) => a.receivedAt.localeCompare(b.receivedAt))
  let previousPrice = null, previousVolume = null, direction = 0
  const byMinute = new Map()
  for (const event of events) {
    if (previousVolume != null) {
      const volume = event.cumulativeVolume - previousVolume
      if (volume > 0) {
        if (event.price > previousPrice) direction = 1
        else if (event.price < previousPrice) direction = -1
        if (!byMinute.has(event.minute)) byMinute.set(event.minute, { minute: event.minute, buyVolume: 0, sellVolume: 0, unclassifiedVolume: 0, events: 0 })
        const row = byMinute.get(event.minute)
        if (direction === 1) row.buyVolume += volume
        else if (direction === -1) row.sellVolume += volume
        else row.unclassifiedVolume += volume
      }
    }
    if (!byMinute.has(event.minute)) byMinute.set(event.minute, { minute: event.minute, buyVolume: 0, sellVolume: 0, unclassifiedVolume: 0, events: 0 })
    byMinute.get(event.minute).events++
    previousPrice = event.price
    previousVolume = event.cumulativeVolume
  }
  const rows = [...byMinute.values()].map(row => {
    const classifiedVolume = row.buyVolume + row.sellVolume
    const tradedVolume = classifiedVolume + row.unclassifiedVolume
    return { ...row, classifiedVolume, tradedVolume, buyPct: classifiedVolume ? round(100 * row.buyVolume / classifiedVolume) : null }
  }).sort((a, b) => a.minute.localeCompare(b.minute))
  return { day, rows, events: events.length }
}

const sessionReports = sessions.map(classifySession)
const minuteSet = new Set(sessionReports.flatMap(report => report.rows.map(row => row.minute)))
const horizontalRows = [...minuteSet].sort().map(minute => {
  const values = Object.fromEntries(sessionReports.map(report => [report.day, report.rows.find(row => row.minute === minute) ?? null]))
  const all = Object.values(values).filter(Boolean)
  const buyVolume = all.reduce((sum, row) => sum + row.buyVolume, 0)
  const sellVolume = all.reduce((sum, row) => sum + row.sellVolume, 0)
  const classifiedVolume = buyVolume + sellVolume
  return { minute, sessions: values, availableSessions: all.length, buyVolume, sellVolume, classifiedVolume, buyPct: classifiedVolume ? round(100 * buyVolume / classifiedVolume) : null }
})
const buyVolume = horizontalRows.reduce((sum, row) => sum + row.buyVolume, 0)
const sellVolume = horizontalRows.reduce((sum, row) => sum + row.sellVolume, 0)
const classifiedVolume = buyVolume + sellVolume
const total = { buyVolume, sellVolume, classifiedVolume, buyPct: classifiedVolume ? round(100 * buyVolume / classifiedVolume) : null }
const report = {
  symbol, sessions,
  method: 'Estimated buy-initiated volume from market-depth marketContext price and cumulative volume. An uptick is BUY, a downtick is SELL, and unchanged prices inherit the most recent direction. The total is volume-weighted, not an arithmetic mean of minute percentages. It is not exchange-confirmed executed-order side.',
  total,
  sessionCoverage: sessionReports.map(({ day, events, rows, reason }) => ({ day, events, availableMinutes: rows.length, reason: reason ?? null })),
  minuteRows: horizontalRows,
}
const stem = `${symbol}-five-session-minute-buy-percent`
const json = unique(path.join(root, 'reports'), stem, 'json')
fs.writeFileSync(json, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' })
const csv = unique(path.join(root, 'csv'), stem, 'csv')
const columns = ['minute', ...sessions.flatMap(day => [`${day}_buyPct`, `${day}_buyVolume`, `${day}_sellVolume`, `${day}_tradedVolume`]), 'availableSessions', 'fiveSessionBuyPct', 'fiveSessionBuyVolume', 'fiveSessionSellVolume', 'fiveSessionClassifiedVolume']
const csvRows = horizontalRows.map(row => {
  const out = { minute: row.minute, availableSessions: row.availableSessions, fiveSessionBuyPct: row.buyPct, fiveSessionBuyVolume: row.buyVolume, fiveSessionSellVolume: row.sellVolume, fiveSessionClassifiedVolume: row.classifiedVolume }
  for (const day of sessions) {
    const value = row.sessions[day]
    out[`${day}_buyPct`] = value?.buyPct ?? null
    out[`${day}_buyVolume`] = value?.buyVolume ?? null
    out[`${day}_sellVolume`] = value?.sellVolume ?? null
    out[`${day}_tradedVolume`] = value?.tradedVolume ?? null
  }
  return out
})
fs.writeFileSync(csv, columns.join(',') + '\n' + csvRows.map(row => columns.map(column => escapeCsv(row[column])).join(',')).join('\n') + '\n', { flag: 'wx' })
console.log(JSON.stringify({ symbol, sessions, total, json, csv }, null, 2))
