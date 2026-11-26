import fs from 'node:fs'
import path from 'node:path'

// At each completed minute, this radar requires both comparisons:
// horizontal = a stock versus its five prior, time-aligned opening windows;
// vertical   = a stock versus the whole universe at the same cutoff today.
const root = process.cwd()
const date = process.argv[2]
const arg = name => { const i = process.argv.indexOf(name); return i < 0 ? null : process.argv[i + 1] }
const start = arg('--start') ?? '09:20'
const end = arg('--end') ?? '10:00'
const top = Number(arg('--top') ?? 10)
const replay = process.argv.includes('--replay')
const sessions = ['2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09', '2026-10-12', '2026-10-13', '2026-10-14', '2026-10-15', '2026-10-16', '2026-10-19']
if (!date || !sessions.includes(date) || !/^\d{2}:\d{2}$/.test(start) || !/^\d{2}:\d{2}$/.test(end) || start > end || !Number.isInteger(top) || top < 1) {
  throw new Error('Usage: node scripts/live-opening-volume-move-radar.js YYYY-MM-DD [--start 09:20] [--end 10:00] [--top 10] [--replay]')
}
const index = sessions.indexOf(date)
if (index < 5) throw new Error(`${date} needs five prior sessions in the configured research calendar.`)
const priorDates = sessions.slice(index - 5, index)
const symbols = [...new Set(JSON.parse(fs.readFileSync(path.join(root, 'db', 'stocks'), 'utf8')).map(x => String(x).trim().toUpperCase().replace(/-EQ$/, '')))]
const toMinute = time => Number(time.slice(0, 2)) * 60 + Number(time.slice(3))
const timeString = minute => `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`
const stamp = epoch => new Date(epoch * 1000 + 330 * 60_000).toISOString().slice(0, 16).replace('T', ' ')
const round = (value, decimals = 4) => Number(value.toFixed(decimals))
const sessionStart = toMinute('09:15')
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const candleCache = new Map()

function sourceRows(symbol) {
  if (candleCache.has(symbol)) return candleCache.get(symbol)
  const file = path.join(root, 'db', 'candles', `${symbol}.jsonl`)
  if (!fs.existsSync(file)) return []
  const seen = new Map()
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue
    let raw
    try { raw = JSON.parse(line) } catch { continue }
    const time = stamp(+raw.time), day = time.slice(0, 10), minute = toMinute(time.slice(11))
    if (![...priorDates, date].includes(day) || minute < sessionStart || minute >= toMinute(end)) continue
    if (![raw.open, raw.high, raw.low, raw.close, raw.volume].every(Number.isFinite)) continue
    seen.set(time, { day, minute, open: +raw.open, close: +raw.close, volume: +raw.volume })
  }
  const rows = [...seen.values()].sort((a, b) => a.day.localeCompare(b.day) || a.minute - b.minute)
  candleCache.set(symbol, rows)
  return rows
}

function openingWindows(symbol, cutoffMinute) {
  const rowsByDay = new Map()
  for (const row of sourceRows(symbol)) {
    if (row.minute >= cutoffMinute) continue
    if (!rowsByDay.has(row.day)) rowsByDay.set(row.day, [])
    rowsByDay.get(row.day).push(row)
  }
  const result = new Map()
  for (const [day, rows] of rowsByDay) {
    rows.sort((a, b) => a.minute - b.minute)
    // A missing minute makes a historical comparison unsafe at this cutoff.
    if (rows.length !== cutoffMinute - sessionStart || rows[0].minute !== sessionStart || rows.at(-1).minute !== cutoffMinute - 1) continue
    const open = rows[0].open, close = rows.at(-1).close
    if (open <= 0) continue
    result.set(day, { volume: rows.reduce((sum, row) => sum + row.volume, 0), movePct: 100 * (close / open - 1), close })
  }
  return result
}

function scoreAt(cutoffMinute) {
  const comparable = []
  for (const symbol of symbols) {
    const windows = openingWindows(symbol, cutoffMinute)
    const today = windows.get(date)
    const previous = priorDates.map(day => windows.get(day))
    if (!today || previous.some(x => !x)) continue
    const priorMaxVolume = Math.max(...previous.map(x => x.volume))
    const priorMaxAbsoluteMovePct = Math.max(...previous.map(x => Math.abs(x.movePct)))
    comparable.push({
      symbol,
      cumulativeVolume: today.volume,
      movePct: round(today.movePct),
      absoluteMovePct: round(Math.abs(today.movePct)),
      direction: today.movePct >= 0 ? 'BUY' : 'SELL',
      priorMaxVolume,
      priorMaxAbsoluteMovePct: round(priorMaxAbsoluteMovePct),
      horizontalVolumeRecord: today.volume > priorMaxVolume,
      horizontalMoveRecord: Math.abs(today.movePct) > priorMaxAbsoluteMovePct,
      priorDates,
    })
  }
  const volumeRanked = [...comparable].sort((a, b) => b.cumulativeVolume - a.cumulativeVolume || a.symbol.localeCompare(b.symbol))
  const moveRanked = [...comparable].sort((a, b) => b.absoluteMovePct - a.absoluteMovePct || a.symbol.localeCompare(b.symbol))
  const volumeRank = new Map(volumeRanked.map((row, i) => [row.symbol, i + 1]))
  const moveRank = new Map(moveRanked.map((row, i) => [row.symbol, i + 1]))
  const rows = comparable.map(row => ({ ...row, volumeRankToday: volumeRank.get(row.symbol), moveRankToday: moveRank.get(row.symbol) }))
  const hits = rows.filter(row => row.horizontalVolumeRecord && row.horizontalMoveRecord && row.volumeRankToday <= top && row.moveRankToday <= top)
    .sort((a, b) => a.volumeRankToday - b.volumeRankToday || a.moveRankToday - b.moveRankToday || a.symbol.localeCompare(b.symbol))
  return { comparableStocks: rows.length, hits, rows }
}

function uniqueReport() {
  const stem = `${date}-${start.replace(':', '')}-to-${end.replace(':', '')}-opening-volume-move-radar`
  let suffix = 1, file
  do { file = path.join(root, 'reports', `${stem}${suffix === 1 ? '' : `-${suffix}`}.json`); suffix++ } while (fs.existsSync(file))
  return file
}
console.log(`Loading opening candles for ${symbols.length} symbols...`)
for (const symbol of symbols) sourceRows(symbol)
const output = uniqueReport()
const ledger = {
  date, start, end, top, priorDates,
  method: 'At each cutoff, uses only completed one-minute candles from 09:15 through cutoff minus one minute. Horizontal requires today cumulative volume > each of the prior five same-window cumulative volumes AND today absolute open-to-current move > each prior five absolute moves. Vertical requires rank <= top in both volume and absolute move across comparable stocks today. Direction is the signed open-to-current move.',
  snapshots: [],
}
function save() { fs.writeFileSync(output, JSON.stringify(ledger, null, 2) + '\n') }
async function tick(cutoffMinute) {
  const scored = scoreAt(cutoffMinute)
  const snapshot = { cutoff: timeString(cutoffMinute), comparableStocks: scored.comparableStocks, hits: scored.hits, rows: scored.rows }
  ledger.snapshots.push(snapshot)
  save()
  console.log(`${snapshot.cutoff} comparable=${snapshot.comparableStocks} radarHits=${snapshot.hits.length} ${snapshot.hits.map(x => `${x.symbol}:${x.direction}`).join(',')}`)
}

for (let minute = toMinute(start); minute <= toMinute(end); minute++) {
  if (!replay) {
    const wait = Date.parse(`${date}T${timeString(minute)}:05+05:30`) - Date.now()
    if (wait > 0) await sleep(wait)
  }
  await tick(minute)
}
console.log(`Saved ${output}`)
