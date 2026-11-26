import fs from 'node:fs'
import path from 'node:path'

const ROOT = process.cwd(), IST = 330 * 60_000
const DATE = process.argv[2] || '2026-11-20', CUTOFF = process.argv[3] || '11:00'
const CUTOFF_MINUTE = minuteNumber(CUTOFF), OPEN = 9 * 60 + 15, WINDOW = 5
if (!/^\d{4}-\d{2}-\d{2}$/.test(DATE) || CUTOFF_MINUTE < OPEN + WINDOW) throw new Error('Usage: node scripts/scan-high-participation-bearish-pressure.js YYYY-MM-DD HH:MM')
const universe = JSON.parse(fs.readFileSync(path.join(ROOT, 'db', 'stocks_sector_wise'), 'utf8'))
const symbols = [...new Set(Object.entries(universe).filter(([key]) => key !== '_meta').flatMap(([, values]) => values))].sort()
const local = time => new Date(Number(time) * 1000 + IST).toISOString().slice(0, 16).replace('T', ' ')
const minuteLabel = value => `${String(Math.floor(value / 60)).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}`
function minuteNumber(value) { const [hour, minute] = value.split(':').map(Number); return hour * 60 + minute }
const sum = values => values.reduce((total, value) => total + value, 0)
const round = (value, places = 3) => +value.toFixed(places)

function candles(symbol) {
  const file = path.join(ROOT, 'db', 'candles', `${symbol}.jsonl`)
  if (!fs.existsSync(file)) return []
  return fs.readFileSync(file, 'utf8').split(/\r?\n/).flatMap(line => {
    try {
      const row = JSON.parse(line), stamp = local(row.time)
      return [{ day: stamp.slice(0, 10), minute: stamp.slice(11), open: +row.open, close: +row.close, volume: +row.volume || 0 }]
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
      if (minute < '09:15' || minute >= CUTOFF) continue
      if (event.kind === 'checkpoint') for (const key of Object.keys(fields)) delete fields[key]
      Object.assign(fields, event.data || {})
      const bp = +fields.bid_price1, ap = +fields.ask_price1
      const bids = Array.from({ length: 5 }, (_, index) => +fields[`bid_size${index + 1}`])
      const asks = Array.from({ length: 5 }, (_, index) => +fields[`ask_size${index + 1}`])
      if (![bp, ap, ...bids, ...asks].every(Number.isFinite) || ap <= bp) continue
      const ofi = previous && at - previous.at <= 90_000
        ? (bp >= previous.bp ? bids[0] : 0) - (bp <= previous.bp ? previous.bid1 : 0) - (ap <= previous.ap ? asks[0] : 0) + (ap >= previous.ap ? previous.ask1 : 0)
        : 0
      rows.push({ minute, mid: (bp + ap) / 2, bp, ap, ofi })
      previous = { at, bp, ap, bid1: bids[0], ask1: asks[0] }
    } catch {}
  }
  return rows
}

function episodesFor(symbol) {
  const candleRows = candles(symbol), depthRows = depth(symbol)
  const priorDays = [...new Set(candleRows.map(row => row.day))].filter(day => day < DATE).sort().slice(-5)
  if (priorDays.length < 5) return []
  const hits = []
  for (let startNumber = OPEN; startNumber + WINDOW <= CUTOFF_MINUTE; startNumber++) {
    const start = minuteLabel(startNumber), endExclusive = minuteLabel(startNumber + WINDOW), end = minuteLabel(startNumber + WINDOW - 1)
    const book = depthRows.filter(row => row.minute >= start && row.minute < endExclusive)
    const bars = candleRows.filter(row => row.day === DATE && row.minute >= start && row.minute < endExclusive)
    if (book.length < 2 || bars.length < WINDOW) continue
    const first = book[0], last = book.at(-1)
    const midpointPct = 100 * (last.mid / first.mid - 1), bidPct = 100 * (last.bp / first.bp - 1), askPct = 100 * (last.ap / first.ap - 1)
    const ofi = sum(book.map(row => row.ofi)), returnPct = 100 * (bars.at(-1).close / bars[0].open - 1)
    const currentVolume = sum(bars.map(row => row.volume))
    const priorVolumes = priorDays.map(day => sum(candleRows.filter(row => row.day === day && row.minute >= start && row.minute < endExclusive).map(row => row.volume)))
    const volumeAverage = sum(priorVolumes) / priorVolumes.length, volumeRatio = currentVolume / volumeAverage
    const match = midpointPct <= -.15 && bidPct < 0 && askPct < 0 && ofi <= -25_000 && returnPct <= -.15 && volumeRatio >= 1.5
    if (match) hits.push({ start, end, knownAt: endExclusive, midpointPct: round(midpointPct), bidPct: round(bidPct), askPct: round(askPct), ofi: Math.round(ofi), returnPct: round(returnPct), volume: currentVolume, volumeRatio: round(volumeRatio, 2) })
  }
  const episodes = []
  for (const hit of hits) {
    const current = episodes.at(-1)
    if (current && minuteNumber(hit.start) <= minuteNumber(current.end) + 1) {
      current.end = hit.end; current.knownAt = hit.knownAt; current.windows.push(hit)
    } else episodes.push({ start: hit.start, end: hit.end, knownAt: hit.knownAt, windows: [hit] })
  }
  return episodes.map(episode => {
    const strongest = [...episode.windows].sort((left, right) => right.volumeRatio - left.volumeRatio || left.midpointPct - right.midpointPct)[0]
    return { Stock: symbol, Episode: `${episode.start}–${episode.end}`, 'Known at': episode.knownAt, Windows: episode.windows.length, 'Midpoint %': strongest.midpointPct, 'Best bid %': strongest.bidPct, 'Best ask %': strongest.askPct, OFI: strongest.ofi, 'Return %': strongest.returnPct, Volume: strongest.volume, 'Volume ratio': strongest.volumeRatio }
  })
}

const episodes = []
for (let index = 0; index < symbols.length; index++) {
  const symbol = symbols[index]
  process.stdout.write(`\rScanning ${index + 1}/${symbols.length} ${symbol}`.padEnd(52))
  episodes.push(...episodesFor(symbol))
}
process.stdout.write('\n')
episodes.sort((left, right) => right['Volume ratio'] - left['Volume ratio'] || left['Midpoint %'] - right['Midpoint %'] || left.Stock.localeCompare(right.Stock))
console.table(episodes)
let suffix = 1, report
do { report = path.join(ROOT, 'reports', `${DATE}-${CUTOFF.replace(':', '')}-high-participation-bearish-pressure${suffix === 1 ? '' : `-${suffix}`}.json`); suffix++ } while (fs.existsSync(report))
fs.writeFileSync(report, `${JSON.stringify({ date: DATE, cutoff: CUTOFF, chronology: 'Each five-minute window uses only depth snapshots and completed candles inside that window. A matching window becomes known at its end; overlapping matches are grouped into one episode.', rules: { midpointPct: '<= -0.15', bestBidPct: '< 0', bestAskPct: '< 0', quoteBasedOfi: '<= -25000', fiveMinuteReturnPct: '<= -0.15', volumeRatioVsPriorFiveSessionsSameClock: '>= 1.5' }, episodeCount: episodes.length, episodes }, null, 2)}\n`, { flag: 'wx' })
console.log(`Episodes: ${episodes.length}; report: ${report}`)
console.log(`NSE symbols: ${[...new Set(episodes.map(row => `NSE:${row.Stock}-EQ`))].join(', ')}`)
