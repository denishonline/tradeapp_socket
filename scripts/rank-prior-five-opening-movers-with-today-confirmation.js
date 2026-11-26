import fs from 'node:fs'
import path from 'node:path'

const root = process.cwd()
const date = process.argv[2]
const cutoff = process.argv[3] ?? '09:30'
const threshold = Number(process.argv[4] ?? 1)
const calendar = ['2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09', '2026-10-12', '2026-10-13', '2026-10-14', '2026-10-15', '2026-10-16', '2026-10-19']
if (!calendar.includes(date) || !/^\d{2}:\d{2}$/.test(cutoff) || !Number.isFinite(threshold) || threshold <= 0) throw new Error('Usage: node scripts/rank-prior-five-opening-movers-with-today-confirmation.js YYYY-MM-DD [HH:MM] [percentThreshold]')
const index = calendar.indexOf(date)
if (index < 5) throw new Error(`${date} needs five prior sessions in the configured research calendar.`)
const priorDates = calendar.slice(index - 5, index)
const symbols = [...new Set(JSON.parse(fs.readFileSync(path.join(root, 'db', 'stocks'), 'utf8')).map(x => String(x).trim().toUpperCase().replace(/-EQ$/, '')))]
const toMinute = time => Number(time.slice(0, 2)) * 60 + Number(time.slice(3))
const openingMinute = toMinute('09:15'), cutoffMinute = toMinute(cutoff)
const stamp = epoch => new Date(epoch * 1000 + 330 * 60_000).toISOString().slice(0, 16).replace('T', ' ')
const round = (value, digits = 3) => Number(value.toFixed(digits))
const unique = (folder, stem, extension) => { let n = 1, file; do { file = path.join(folder, `${stem}${n === 1 ? '' : `-${n}`}.${extension}`); n++ } while (fs.existsSync(file)); return file }
const csv = value => { const text = value == null ? '' : String(value); return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text }

function moves(symbol) {
  const file = path.join(root, 'db', 'candles', `${symbol}.jsonl`)
  if (!fs.existsSync(file)) return new Map()
  const deduplicated = new Map()
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue
    let raw
    try { raw = JSON.parse(line) } catch { continue }
    const time = stamp(+raw.time), day = time.slice(0, 10), minute = toMinute(time.slice(11))
    if (![...priorDates, date].includes(day) || minute < openingMinute || minute >= cutoffMinute || ![raw.open, raw.close].every(value => Number.isFinite(+value))) continue
    deduplicated.set(time, { day, minute, open: +raw.open, close: +raw.close })
  }
  const grouped = new Map()
  for (const row of deduplicated.values()) { if (!grouped.has(row.day)) grouped.set(row.day, []); grouped.get(row.day).push(row) }
  const result = new Map()
  for (const [day, rows] of grouped) {
    rows.sort((a, b) => a.minute - b.minute)
    if (rows.length !== cutoffMinute - openingMinute || rows[0].minute !== openingMinute || rows.at(-1).minute !== cutoffMinute - 1 || rows[0].open <= 0) continue
    result.set(day, 100 * (rows.at(-1).close / rows[0].open - 1))
  }
  return result
}

const rows = symbols.map(symbol => {
  const dailyMoves = moves(symbol), prior = priorDates.map(day => dailyMoves.get(day)), todayMove = dailyMoves.get(date)
  if (prior.some(value => !Number.isFinite(value)) || !Number.isFinite(todayMove)) return null
  const absolutePrior = prior.map(Math.abs)
  return { symbol, todayMovePct: round(todayMove), priorAverageAbsoluteMovePct: round(absolutePrior.reduce((sum, value) => sum + value, 0) / absolutePrior.length), priorMaximumAbsoluteMovePct: round(Math.max(...absolutePrior)), priorMovesPct: Object.fromEntries(priorDates.map((day, i) => [day, round(prior[i])])) }
}).filter(Boolean)
const up = rows.filter(row => row.todayMovePct > threshold).sort((a, b) => b.priorAverageAbsoluteMovePct - a.priorAverageAbsoluteMovePct || b.todayMovePct - a.todayMovePct)
const down = rows.filter(row => row.todayMovePct < -threshold).sort((a, b) => b.priorAverageAbsoluteMovePct - a.priorAverageAbsoluteMovePct || a.todayMovePct - b.todayMovePct)
const report = { date, cutoff, window: `09:15:00–${cutoff}:00 IST (cutoff candle excluded)`, priorDates, thresholdPct: threshold,
  method: 'Historical movement strength is the arithmetic mean of the five prior same-window absolute open-to-last-completed-close percentage moves. Today must move strictly above +threshold for UP or below -threshold for DOWN. Lists rank qualifying stocks by historical movement strength.',
  stocksScanned: symbols.length, stocksComparable: rows.length, up, down, rows }
const stem = `${date}-0915-to-${cutoff.replace(':', '')}-prior-five-movers-today-${threshold}pct-confirmed`
const json = unique(path.join(root, 'reports'), stem, 'json'); fs.writeFileSync(json, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' })
const outputCsv = unique(path.join(root, 'csv'), stem, 'csv'), columns = ['symbol', 'todayMovePct', 'priorAverageAbsoluteMovePct', 'priorMaximumAbsoluteMovePct', ...priorDates]
fs.writeFileSync(outputCsv, columns.join(',') + '\n' + rows.sort((a, b) => b.priorAverageAbsoluteMovePct - a.priorAverageAbsoluteMovePct).map(row => columns.map(column => csv(priorDates.includes(column) ? row.priorMovesPct[column] : row[column])).join(',')).join('\n') + '\n', { flag: 'wx' })
console.log(JSON.stringify({ date, cutoff, thresholdPct: threshold, stocksComparable: rows.length, up, down, json, csv: outputCsv }, null, 2))
