import fs from 'node:fs'
import path from 'node:path'

const root = process.cwd()
const date = process.argv[2]
const cutoff = process.argv[3] ?? '10:00'
const top = Number(process.argv[4] ?? 10)
const calendar = ['2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09', '2026-10-12', '2026-10-13', '2026-10-14', '2026-10-15', '2026-10-16', '2026-10-19']
if (!calendar.includes(date) || !/^\d{2}:\d{2}$/.test(cutoff) || !Number.isInteger(top) || top < 1) throw new Error('Usage: node scripts/rank-low-volume-opening-movers.js YYYY-MM-DD [HH:MM] [top]')
const index = calendar.indexOf(date)
if (index < 5) throw new Error(`${date} needs five prior sessions in the configured research calendar.`)
const priorDates = calendar.slice(index - 5, index)
const symbols = [...new Set(JSON.parse(fs.readFileSync(path.join(root, 'db', 'stocks'), 'utf8')).map(x => String(x).trim().toUpperCase().replace(/-EQ$/, '')))]
const minute = time => Number(time.slice(0, 2)) * 60 + Number(time.slice(3))
const openMinute = minute('09:15'), cutoffMinute = minute(cutoff)
const stamp = epoch => new Date(epoch * 1000 + 330 * 60_000).toISOString().slice(0, 16).replace('T', ' ')
const round = (value, digits = 2) => Number(value.toFixed(digits))
const unique = (folder, stem, extension) => { let n = 1, file; do { file = path.join(folder, `${stem}${n === 1 ? '' : `-${n}`}.${extension}`); n++ } while (fs.existsSync(file)); return file }
const csv = value => { const text = value == null ? '' : String(value); return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text }

function windowFor(symbol) {
  const file = path.join(root, 'db', 'candles', `${symbol}.jsonl`)
  if (!fs.existsSync(file)) return new Map()
  const uniqueRows = new Map()
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue
    let row
    try { row = JSON.parse(line) } catch { continue }
    const time = stamp(+row.time), day = time.slice(0, 10), clock = minute(time.slice(11))
    if (![...priorDates, date].includes(day) || clock < openMinute || clock >= cutoffMinute) continue
    if (![row.open, row.close, row.volume].every(value => Number.isFinite(+value))) continue
    uniqueRows.set(time, { day, clock, open: +row.open, close: +row.close, volume: +row.volume })
  }
  const grouped = new Map()
  for (const row of uniqueRows.values()) { if (!grouped.has(row.day)) grouped.set(row.day, []); grouped.get(row.day).push(row) }
  const result = new Map()
  for (const [day, rows] of grouped) {
    rows.sort((a, b) => a.clock - b.clock)
    if (rows.length !== cutoffMinute - openMinute || rows[0].clock !== openMinute || rows.at(-1).clock !== cutoffMinute - 1) continue
    const openingPrice = rows[0].open, closingPrice = rows.at(-1).close
    if (openingPrice <= 0) continue
    result.set(day, { volume: rows.reduce((sum, row) => sum + row.volume, 0), movePct: 100 * (closingPrice / openingPrice - 1) })
  }
  return result
}

const rows = symbols.map(symbol => {
  const windows = windowFor(symbol), today = windows.get(date), prior = priorDates.map(day => windows.get(day))
  if (!today || prior.some(value => !value)) return null
  const priorMinVolume = Math.min(...prior.map(value => value.volume))
  return { symbol, movePct: round(today.movePct, 3), volume: today.volume, priorMinVolume, priorAverageVolume: round(prior.reduce((sum, value) => sum + value.volume, 0) / prior.length), volumeVsPriorMinPct: round(100 * (today.volume / priorMinVolume - 1), 2), isSixSessionVolumeLow: today.volume < priorMinVolume }
}).filter(Boolean)
const qualified = rows.filter(row => row.isSixSessionVolumeLow)
const upTop = qualified.filter(row => row.movePct > 0).sort((a, b) => b.movePct - a.movePct || a.volume - b.volume).slice(0, top)
const downTop = qualified.filter(row => row.movePct < 0).sort((a, b) => a.movePct - b.movePct || a.volume - b.volume).slice(0, top)
const report = { date, cutoff, window: `09:15:00–${cutoff}:00 IST (cutoff candle excluded)`, priorDates,
  method: 'For each stock, sums one-minute candle volume and calculates open-to-last-completed-close movement over the opening window. A stock qualifies only when today volume is lower than every prior-five same-window volume. Up and down lists rank the qualified stocks by signed percentage move.',
  stocksScanned: symbols.length, stocksComparable: rows.length, lowVolumeQualified: qualified.length, upTop, downTop, rows }
const stem = `${date}-0915-to-${cutoff.replace(':', '')}-low-volume-opening-movers-top-${top}`
const json = unique(path.join(root, 'reports'), stem, 'json'); fs.writeFileSync(json, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' })
const outputCsv = unique(path.join(root, 'csv'), stem, 'csv'), columns = ['symbol', 'movePct', 'volume', 'priorMinVolume', 'priorAverageVolume', 'volumeVsPriorMinPct', 'isSixSessionVolumeLow']
fs.writeFileSync(outputCsv, columns.join(',') + '\n' + rows.sort((a, b) => a.symbol.localeCompare(b.symbol)).map(row => columns.map(column => csv(row[column])).join(',')).join('\n') + '\n', { flag: 'wx' })
console.log(JSON.stringify({ date, cutoff, stocksScanned: symbols.length, stocksComparable: rows.length, lowVolumeQualified: qualified.length, upTop, downTop, json, csv: outputCsv }, null, 2))
