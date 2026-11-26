import fs from 'node:fs'
import path from 'node:path'

const root = process.cwd(), date = process.argv[2] ?? '2026-11-19', minute = 60_000, minimumDepthMinutes = process.argv.includes('--allow-partial-depth') ? 3 : 5
if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('Usage: node scripts/analyze-opening-directional-behaviour-shares.js YYYY-MM-DD')
const start = Date.parse(`${date}T09:15:00+05:30`), end = Date.parse(`${date}T09:20:00+05:30`), confirmEnd = Date.parse(`${date}T09:21:00+05:30`)
const day = at => new Date(at + 330 * minute).toISOString().slice(0, 10)
const clock = at => new Date(at + 330 * minute).toISOString().slice(11, 16)
const pct = (to, from) => 100 * (to / from - 1)
const median = values => { const list = [...values].sort((a, b) => a - b); return list.length ? list[Math.floor(list.length / 2)] : null }
const symbols = fs.readdirSync(path.join(root, 'db', 'cash-depth', date), { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name).sort()

function allCandles(symbol) {
  const file = path.join(root, 'db', 'candles', `${symbol}.jsonl`)
  if (!fs.existsSync(file)) return []
  return fs.readFileSync(file, 'utf8').split(/\r?\n/).flatMap(line => {
    try { const raw = JSON.parse(line), at = +raw.time * 1000; return Number.isFinite(at) ? [{ at, date: day(at), minute: clock(at), open: +raw.open, high: +raw.high, low: +raw.low, close: +raw.close, volume: +raw.volume || 0 }] : [] } catch { return [] }
  }).sort((a, b) => a.at - b.at)
}

function opening(rows, session) {
  const five = rows.filter(row => row.date === session && row.minute >= '09:15' && row.minute < '09:20')
  if (five.length !== 5) return null
  const high = Math.max(...five.map(row => row.high)), low = Math.min(...five.map(row => row.low)), open = five[0].open, close = five.at(-1).close
  let ema10, ema20
  for (const row of five) { ema10 ??= row.close; ema20 ??= row.close; ema10 += 2 / 11 * (row.close - ema10); ema20 += 2 / 21 * (row.close - ema20) }
  const range = high - low, bodies = five.map(row => Math.abs(row.close - row.open))
  const upperLong = five.filter(row => row.high - Math.max(row.open, row.close) > 0.5 * (row.high - row.low || 1)).length
  const lowerLong = five.filter(row => Math.min(row.open, row.close) - row.low > 0.5 * (row.high - row.low || 1)).length
  return { open, high, low, close, returnPct: pct(close, open), emaUp: ema10 > ema20, green: five.filter(row => row.close > row.open).length, closeLocation: 100 * (close - low) / (range || 1), rangePct: 100 * range / open, bodyRatio: bodies.reduce((sum, value) => sum + value, 0) / (range || 1), upperLong, lowerLong, volume: five.reduce((sum, row) => sum + row.volume, 0) }
}

function depth(symbol) {
  const file = path.join(root, 'db', 'cash-depth', date, symbol, `${symbol}.jsonl`)
  if (!fs.existsSync(file)) return null
  const state = {}, snapshots = [], byMinute = new Map()
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!line) continue
    let event; try { event = JSON.parse(line) } catch { continue }
    const at = Date.parse(event.receivedAt); if (!Number.isFinite(at)) continue
    if (at >= end) break
    if (event.kind === 'checkpoint' || event.book) for (const key of Object.keys(state)) delete state[key]
    Object.assign(state, event.data ?? {})
    if (at < start) continue
    let bidSize = 0, askSize = 0, valid = true
    for (let level = 1; level <= 5; level++) { const bp = +state[`bid_price${level}`], ap = +state[`ask_price${level}`], bs = +state[`bid_size${level}`], as = +state[`ask_size${level}`]; if (![bp, ap, bs, as].every(Number.isFinite) || bp <= 0 || ap <= bp) { valid = false; break }; bidSize += bs; askSize += as }
    if (!valid) continue
    const bid = +state.bid_price1, ask = +state.ask_price1, row = { mid: (bid + ask) / 2, spreadBps: 10_000 * (ask - bid) / ((ask + bid) / 2), visible: bidSize + askSize }
    snapshots.push(row); byMinute.set(clock(at), row)
  }
  const minutes = [...byMinute.values()]
  if (minutes.length < minimumDepthMinutes || snapshots.length < minimumDepthMinutes) return null
  const changes = minutes.slice(1).map((row, index) => row.mid - minutes[index].mid)
  const rises = changes.filter(value => value > 0).length, falls = changes.filter(value => value < 0).length
  const neededDirectionalChanges = Math.ceil(changes.length * .75)
  return { midpointReturn: pct(minutes.at(-1).mid, minutes[0].mid), bullPersistent: rises >= neededDirectionalChanges && Math.min(...minutes.map(row => row.mid)) >= minutes[0].mid, bearPersistent: falls >= neededDirectionalChanges && Math.max(...minutes.map(row => row.mid)) <= minutes[0].mid, spreadBps: snapshots.reduce((sum, row) => sum + row.spreadBps, 0) / snapshots.length, visible: snapshots.reduce((sum, row) => sum + row.visible, 0) / snapshots.length }
}

const rows = [], skipped = []
for (const [index, symbol] of symbols.entries()) {
  process.stdout.write(`\r\x1b[2KAnalysing [${index + 1}/${symbols.length}] ${symbol}...`)
  const candles = allCandles(symbol), current = opening(candles, date), book = current && depth(symbol)
  const sessions = [...new Set(candles.filter(row => row.date < date).map(row => row.date))].sort().slice(-10)
  const historical = sessions.map(session => opening(candles, session)).filter(Boolean)
  const confirm = candles.find(row => row.date === date && row.minute === '09:20')
  if (!current || !book || historical.length !== 10 || !confirm) { skipped.push(symbol); continue }
  const priorClose = candles.filter(row => row.date < date).at(-1)?.close
  if (!priorClose) { skipped.push(symbol); continue }
  const rangeMedian = median(historical.map(row => row.rangePct)), volumeMedian = median(historical.map(row => row.volume))
  const spreadMedian = median(rows.map(row => row.book.spreadBps).filter(Number.isFinite))
  rows.push({ symbol, current, book, priorClose, confirm, rangeMedian, volumeMedian, spreadMedian })
}
process.stdout.write('\r\x1b[2K')

// Cross-sectional liquidity floor is set after all stocks are available.
const visibleFloor = median(rows.map(row => row.book.visible)) * 0.5
const rules = [
  ['EMA structure', row => row.current.emaUp, row => !row.current.emaUp],
  ['Five-candle return', row => row.current.returnPct > 0, row => row.current.returnPct < 0],
  ['Depth midpoint return', row => row.book.midpointReturn > 0, row => row.book.midpointReturn < 0],
  ['Price + midpoint', row => row.current.returnPct > 0 && row.book.midpointReturn > 0, row => row.current.returnPct < 0 && row.book.midpointReturn < 0],
  ['Candle direction', row => row.current.green >= 3, row => row.current.green <= 2],
  ['Closing location', row => row.current.closeLocation >= 75, row => row.current.closeLocation <= 25],
  ['Alignment', row => row.current.returnPct >= .5 && row.book.midpointReturn >= .5 && row.current.emaUp && row.current.green >= 3 && row.current.closeLocation >= 75, row => row.current.returnPct <= -.5 && row.book.midpointReturn <= -.5 && !row.current.emaUp && row.current.green <= 2 && row.current.closeLocation <= 25],
  ['Opening gap', row => pct(row.current.open, row.priorClose) > 0 && row.current.close > row.priorClose, row => pct(row.current.open, row.priorClose) < 0 && row.current.close < row.priorClose],
  ['Range and body quality', row => row.current.rangePct >= row.rangeMedian && row.current.bodyRatio >= .55 && row.current.green >= 3, row => row.current.rangePct >= row.rangeMedian && row.current.bodyRatio >= .55 && row.current.green <= 2],
  ['Wick / rejection', row => row.current.upperLong <= 1, row => row.current.lowerLong <= 1],
  ['Opening-range confirmation', row => row.confirm.close > row.current.high, row => row.confirm.close < row.current.low],
  ['Depth persistence', row => row.book.bullPersistent, row => row.book.bearPersistent],
  ['Spread and liquidity', row => row.book.spreadBps <= 10 && row.book.visible >= visibleFloor, row => row.book.spreadBps <= 10 && row.book.visible >= visibleFloor],
  ['Relative volume', row => row.current.volume > row.volumeMedian, row => row.current.volume > row.volumeMedian]
]
const count = predicate => rows.filter(predicate).length
const table = rules.map(([behaviour, bull, bear]) => ({ Behaviour: behaviour, Bullish: count(bull), 'Bullish share': `${(100 * count(bull) / rows.length).toFixed(1)}%`, Bearish: count(bear), 'Bearish share': `${(100 * count(bear) / rows.length).toFixed(1)}%` }))
const bullAll = count(row => rules.every(([, bull]) => bull(row))), bearAll = count(row => rules.every(([, , bear]) => bear(row)))
table.push({ Behaviour: 'TOTAL — all listed conditions', Bullish: bullAll, 'Bullish share': `${(100 * bullAll / rows.length).toFixed(1)}%`, Bearish: bearAll, 'Bearish share': `${(100 * bearAll / rows.length).toFixed(1)}%` })
const report = { date, window: '09:15-09:20 IST; opening-range confirmation uses completed 09:20 candle', minimumDepthMinutes, analyzed: rows.length, skipped: skipped.length, definitions: { expandedRange: 'Opening range >= stock prior-10-session median opening range.', bodyQuality: 'Aggregate candle bodies >=55% of opening range.', longWick: 'Wick >50% of its candle range; no more than one adverse long wick.', depthPersistence: 'At least 75% of observed one-minute midpoint changes in direction; midpoint never crosses the opening midpoint against direction.', liquidity: 'Mean top-of-book spread <=10 bps and mean top-five visible quantity >=50% of cross-sectional median.', relativeVolume: 'First five-minute volume exceeds stock prior-10-session median.' }, behaviours: table }
let number = 1, output
do { output = path.join(root, 'reports', `${date}-opening-directional-behaviour-shares${number === 1 ? '' : `-${number}`}.json`); number++ } while (fs.existsSync(output))
fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' })
console.table(table)
console.log(`Analyzed ${rows.length}/${symbols.length}; saved ${output}`)
