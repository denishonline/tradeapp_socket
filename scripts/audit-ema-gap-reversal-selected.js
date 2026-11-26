import fs from 'node:fs'
import path from 'node:path'

const root = process.cwd(), date = process.argv[2] ?? '2026-10-19'
const moveThreshold = Number(process.argv[3] ?? 2)
const calendar = [...new Set(fs.readFileSync(path.join(root, 'db', 'candles', 'NIFTY50.jsonl'), 'utf8').split(/\r?\n/).flatMap(line => { try { const row = JSON.parse(line); return [new Date(+row.time * 1000 + 330 * 60_000).toISOString().slice(0, 10)] } catch { return [] } }))].sort()
const sessionIndex = calendar.indexOf(date)
if (sessionIndex < 5) throw new Error(`${date} needs five prior sessions in the available candle calendar.`)
if (!Number.isFinite(moveThreshold) || moveThreshold <= 0) throw new Error('The intraday move threshold must be positive.')
const priorDates = calendar.slice(sessionIndex - 5, sessionIndex)
const universe = [...new Set(JSON.parse(fs.readFileSync(path.join(root, 'db', 'stocks'), 'utf8')).map(value => String(value).trim().toUpperCase().replace(/-EQ$/, '')))]
const allDates = new Set([...priorDates, date]), startMinute = 9 * 60 + 15
const minute = time => Number(time.slice(0, 2)) * 60 + Number(time.slice(3))
const timeString = value => `${String(Math.floor(value / 60)).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}`
const stamp = epoch => new Date(epoch * 1000 + 330 * 60_000).toISOString().slice(0, 16).replace('T', ' ')
const pct = (a, b) => 100 * (a / b - 1), mean = values => values.reduce((sum, value) => sum + value, 0) / values.length, round = (value, digits = 4) => Number(value.toFixed(digits))
const candleCache = new Map(), depthCache = new Map()

function candles(symbol) {
  if (candleCache.has(symbol)) return candleCache.get(symbol)
  const file = path.join(root, 'db', 'candles', `${symbol}.jsonl`), unique = new Map()
  if (fs.existsSync(file)) for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue
    let raw; try { raw = JSON.parse(line) } catch { continue }
    const time = stamp(+raw.time), day = time.slice(0, 10), clock = minute(time.slice(11))
    if (!allDates.has(day) || clock < startMinute || clock >= 930 || ![raw.open, raw.high, raw.low, raw.close, raw.volume].every(value => Number.isFinite(+value))) continue
    unique.set(time, { time, day, minute: clock, open: +raw.open, close: +raw.close })
  }
  const rows = [...unique.values()].sort((a, b) => a.time.localeCompare(b.time)); candleCache.set(symbol, rows); return rows
}
function depth(symbol) {
  if (depthCache.has(symbol)) return depthCache.get(symbol)
  const file = path.join(root, 'db', 'cash-depth', date, symbol, `${symbol}.jsonl`), state = {}, out = new Map()
  if (fs.existsSync(file)) for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue
    let event; try { event = JSON.parse(line) } catch { continue }
    const time = stamp(Date.parse(event.receivedAt) / 1000), clock = minute(time.slice(11))
    if (time.slice(0, 10) !== date || clock < startMinute || clock >= 930) continue
    if (event.kind === 'checkpoint') for (const key of Object.keys(state)) delete state[key]
    Object.assign(state, event.data ?? {})
    let bid = 0, ask = 0, valid = true
    for (let level = 1; level <= 5; level++) { const bp = +state[`bid_price${level}`], ap = +state[`ask_price${level}`], bs = +state[`bid_size${level}`], as = +state[`ask_size${level}`]; if (![bp, ap, bs, as].every(Number.isFinite) || bp <= 0 || ap <= bp) { valid = false; break } bid += bs; ask += as }
    if (valid) out.set(time, { bidShare: 100 * bid / (bid + ask || 1), mid: (+state.bid_price1 + +state.ask_price1) / 2 })
  }
  depthCache.set(symbol, out); return out
}
function intradayMove(symbol) {
  const rows = candles(symbol).filter(row => row.day === date && row.minute >= 9 * 60 + 15)
  if (!rows.length || rows[0].open <= 0) return null
  const open = rows[0].open, moves = rows.map(row => 100 * (row.close / open - 1))
  return { maxUpPct: Math.max(...moves), maxDownPct: Math.min(...moves), maxAbsoluteMovePct: Math.max(...moves.map(Math.abs)) }
}
function candidate(symbol, cutoff) {
  const rows = candles(symbol).filter(row => row.day !== date || row.minute < cutoff); if (!rows.length) return null
  let e9 = rows[0].close, e45 = rows[0].close; const gaps = {}
  for (const row of rows) { if (row !== rows[0]) { e9 = .2 * row.close + .8 * e9; e45 = 2 / 46 * row.close + 44 / 46 * e45 } if (row.minute === cutoff - 1) gaps[row.day] = 100 * (e9 / e45 - 1) }
  if (![...priorDates, date].every(day => Number.isFinite(gaps[day]))) return null
  const prior = priorDates.map(day => gaps[day]), current = gaps[date], abs = Math.abs(current)
  if (!(abs > Math.max(...prior.map(Math.abs)))) return null
  return { symbol, gapExpansionPct: round(abs - mean(prior.map(Math.abs))), initialDirection: current >= 0 ? 'BUY' : 'SELL', detectedAt: `${date} ${timeString(cutoff - 1)}` }
}
function reversal(active, cutoff) {
  if (active.gapExpansionPct < 1.5) return null
  const rows = candles(active.symbol).filter(row => row.day !== date || row.minute < cutoff), reverse = active.initialDirection === 'BUY' ? 'SELL' : 'BUY', direction = reverse === 'BUY' ? 1 : -1, startAt = minute(active.detectedAt.slice(11)), books = depth(active.symbol)
  let e5; for (const row of rows) { e5 = e5 == null ? row.close : row.close * 2 / 6 + e5 * 4 / 6; row.e5 = e5 }
  for (let i = 1; i < rows.length; i++) {
    if (rows[i].day !== date || rows[i].minute <= startAt) continue
    const left = rows[i - 1], right = rows[i], first = books.get(left.time), second = books.get(right.time); if (!first || !second) continue
    const twoReturn = direction * pct(right.close, left.open), share = mean([first, second].map(book => reverse === 'BUY' ? book.bidShare : 100 - book.bidShare)), midMove = direction * pct(second.mid, first.mid)
    if (twoReturn >= .15 && direction * (right.e5 - left.e5) > 0 && direction * (right.close - right.e5) > 0 && share >= 58 && midMove > .02) return { symbol: active.symbol, initialDirection: active.initialDirection, reverseDirection: reverse, detectedAt: active.detectedAt, signalTime: right.time, entryTime: `${date} ${timeString(right.minute + 1)}`, gapExpansionPct: active.gapExpansionPct, depthDirectionalSharePct: round(share), depthMidpointMovePct: round(midMove) }
  }
  return null
}

const intradayMoves = Object.fromEntries(universe.map(symbol => [symbol, intradayMove(symbol)]).filter(([, value]) => value))
const symbols = Object.entries(intradayMoves).filter(([, value]) => value.maxAbsoluteMovePct >= moveThreshold).map(([symbol]) => symbol)
const active = new Map(), signals = [], candidateCount = new Map(symbols.map(symbol => [symbol, 0]))
for (let cutoff = 9 * 60 + 20; cutoff <= 10 * 60; cutoff++) for (const symbol of symbols) {
  const found = candidate(symbol, cutoff); if (found) { candidateCount.set(symbol, candidateCount.get(symbol) + 1); const prior = active.get(symbol); if (!prior || (prior.gapExpansionPct < 1.5 && found.gapExpansionPct >= 1.5)) active.set(symbol, found) }
  const signal = active.has(symbol) ? reversal(active.get(symbol), cutoff) : null
  if (signal && !signals.some(row => row.symbol === signal.symbol && row.reverseDirection === signal.reverseDirection && row.signalTime === signal.signalTime)) signals.push(signal)
}
const output = { date, selection: `All stocks that reached an absolute move of at least ${moveThreshold}% from the 09:15 open at any completed minute on ${date}`, stocksScanned: universe.length, eligibleSymbols: symbols.map(symbol => ({ symbol, ...Object.fromEntries(Object.entries(intradayMoves[symbol]).map(([key, value]) => [key, round(value)])) })), method: 'Direct audit of the existing EMA gap reversal rule for every eligible stock, bypassing only the live radar’s cross-sectional top-candidate display limit. Uses only data available by each minute cutoff.', signals, noSignalSymbols: symbols.filter(symbol => !signals.some(signal => signal.symbol === symbol)), candidateMinutes: Object.fromEntries(candidateCount) }
const file = path.join(root, 'reports', `${date}-ema-gap-reversal-direct-audit-intraday-move-${moveThreshold}pct.json`); fs.writeFileSync(file, JSON.stringify(output, null, 2) + '\n')
console.log(JSON.stringify({ stocksScanned: universe.length, eligibleCount: symbols.length, signals, noSignalCount: output.noSignalSymbols.length, file }, null, 2))
