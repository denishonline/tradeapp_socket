import fs from 'node:fs'
import path from 'node:path'

// Usage: node scripts/scan-0916-opening-breakdown.js "2026-11-19 09:26"
// A causal 09:16 scanner. SELL uses the opening-breakdown pattern; BUY is its
// exact mirror: two green candles, top-three strength, and mirrored depth/context.
const ROOT = process.cwd()
const IST_OFFSET_MS = 330 * 60_000
const OPENING_START = '09:15'
const OPENING_END = '09:16'
const MIN_CUTOFF = '09:17'
const MIN_DEPTH_SNAPSHOTS = 20

const cutoff = parseCutoff(process.argv.slice(2).join(' '))
if (cutoff.minute < MIN_CUTOFF) throw new Error(`Cutoff must be ${MIN_CUTOFF} IST or later, after the 09:16 candle completes.`)

const universe = JSON.parse(fs.readFileSync(path.join(ROOT, 'db', 'stocks_sector_wise'), 'utf8'))
const symbols = [...new Set(Object.entries(universe).filter(([key]) => key !== '_meta').flatMap(([, rows]) => rows))].sort()

function parseCutoff(value) {
  const match = String(value).trim().match(/^(\d{4}-\d{2}-\d{2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?(?:\s*IST)?$/i)
  if (!match) throw new Error('Usage: node scripts/scan-0916-opening-breakdown.js "YYYY-MM-DD HH:MM"')
  const hour = Number(match[2]), minute = Number(match[3]), second = Number(match[4] || 0)
  if (hour > 23 || minute > 59 || second > 59) throw new Error('Invalid cutoff time.')
  return {
    date: match[1], minute: `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`,
    ms: Date.UTC(...match[1].split('-').map(Number).map((value, index) => index === 1 ? value - 1 : value), hour, minute, second) - IST_OFFSET_MS,
  }
}

function localStamp(seconds) {
  return new Date(Number(seconds) * 1000 + IST_OFFSET_MS).toISOString().slice(0, 16).replace('T', ' ')
}

function readCandles(symbol) {
  const file = path.join(ROOT, 'db', 'candles', `${symbol}.jsonl`)
  if (!fs.existsSync(file)) return []
  // The scanner needs only the current and five prior sessions.  Reading the
  // file tail keeps the live full-universe pass fast even with long histories.
  const size = fs.statSync(file).size, bytes = Math.min(size, 1_500_000)
  const handle = fs.openSync(file, 'r'), buffer = Buffer.alloc(bytes)
  fs.readSync(handle, buffer, 0, bytes, size - bytes)
  fs.closeSync(handle)
  const contents = buffer.toString('utf8')
  const byDay = new Map()
  for (const line of contents.split(/\r?\n/).slice(bytes === size ? 0 : 1)) {
    try {
      if (!line.trim()) continue
      const row = JSON.parse(line), stamp = localStamp(row.time), date = stamp.slice(0, 10), minute = stamp.slice(11)
      if (!byDay.has(date)) byDay.set(date, [])
      byDay.get(date).push({ minute, open: Number(row.open), high: Number(row.high), low: Number(row.low), close: Number(row.close), volume: Number(row.volume) || 0 })
    } catch {}
  }
  return byDay
}

function openingReturn(rows) {
  const first = rows.find((row) => row.minute === OPENING_START)
  const second = rows.find((row) => row.minute === OPENING_END)
  if (!first || !second || !(first.open > 0)) return null
  return { first, second, returnPct: 100 * (second.close / first.open - 1) }
}

function readDepth(symbol) {
  const file = path.join(ROOT, 'db', 'cash-depth', cutoff.date, symbol, `${symbol}.jsonl`)
  if (!fs.existsSync(file)) return []
  const fields = {}, rows = []
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    try {
      if (!line.trim()) continue
      const event = JSON.parse(line), at = Date.parse(event.receivedAt)
      if (!Number.isFinite(at) || at > cutoff.ms) continue
      const minute = new Date(at + IST_OFFSET_MS).toISOString().slice(11, 16)
      if (minute < OPENING_START || minute > OPENING_END) continue
      if (event.kind === 'checkpoint') for (const key of Object.keys(fields)) delete fields[key]
      Object.assign(fields, event.data || {})
      const bids = Array.from({ length: 5 }, (_, index) => Number(fields[`bid_size${index + 1}`]))
      const asks = Array.from({ length: 5 }, (_, index) => Number(fields[`ask_size${index + 1}`]))
      const bid = Number(fields.bid_price1), ask = Number(fields.ask_price1)
      if (![bid, ask, ...bids, ...asks].every(Number.isFinite) || ask <= bid) continue
      const bidSize = bids.reduce((sum, value) => sum + value, 0), askSize = asks.reduce((sum, value) => sum + value, 0)
      rows.push({ mid: (bid + ask) / 2, imbalance: (bidSize - askSize) / (bidSize + askSize) })
    } catch {}
  }
  return rows
}

function depthClassification(rows, side) {
  if (rows.length < MIN_DEPTH_SNAPSHOTS) return { label: 'PRICE_ONLY', snapshots: rows.length, imbalance: null, midpointPct: null }
  const imbalance = rows.reduce((sum, row) => sum + row.imbalance, 0) / rows.length
  const negativeShare = rows.filter((row) => row.imbalance < 0).length / rows.length
  const positiveShare = rows.filter((row) => row.imbalance > 0).length / rows.length
  const midpointPct = 100 * (rows.at(-1).mid / rows[0].mid - 1)
  const finalImbalance = rows.at(-1).imbalance
  if (side === 'SELL') {
    if (finalImbalance >= 0.25 && midpointPct <= -0.25) return { label: 'SELL_ABSORPTION', snapshots: rows.length, imbalance, midpointPct }
    if (imbalance <= -0.10 || negativeShare >= 0.50) return { label: 'SELL_CONFIRMED', snapshots: rows.length, imbalance, midpointPct }
    return { label: 'SELL_PRICE_LED', snapshots: rows.length, imbalance, midpointPct }
  }
  if (finalImbalance <= -0.25 && midpointPct >= 0.25) return { label: 'BUY_ABSORPTION', snapshots: rows.length, imbalance, midpointPct }
  if (imbalance >= 0.10 || positiveShare >= 0.50) return { label: 'BUY_CONFIRMED', snapshots: rows.length, imbalance, midpointPct }
  return { label: 'BUY_PRICE_LED', snapshots: rows.length, imbalance, midpointPct }
}

function ema(rows, period) {
  const alpha = 2 / (period + 1)
  let value = rows[0]?.close
  return rows.map((row, index) => value = index === 0 ? row.close : row.close * alpha + value * (1 - alpha))
}

// Performance is deliberately calculated after signal selection. It is a
// research column only and never influences the causal 09:17 signal.
function ema10Ema20Exit(rows, side) {
  const ordered = [...rows].sort((left, right) => left.minute.localeCompare(right.minute))
  const entryIndex = ordered.findIndex((row) => row.minute === '09:17')
  if (entryIndex < 0 || !(ordered[entryIndex].close > 0)) return { entry: null, exit: null, exitTime: null, exitReason: 'NO_09:17_CANDLE', returnPct: null }
  const ema10 = ema(ordered, 10), ema20 = ema(ordered, 20)
  const entry = ordered[entryIndex].close
  for (let index = entryIndex + 1; index < ordered.length; index++) {
    const crossed = side === 'SELL'
      ? ema10[index - 1] <= ema20[index - 1] && ema10[index] > ema20[index]
      : ema10[index - 1] >= ema20[index - 1] && ema10[index] < ema20[index]
    if (crossed) {
      const exit = ordered[index].close
      return { entry, exit, exitTime: ordered[index].minute, exitReason: side === 'SELL' ? 'EMA10>EMA20' : 'EMA10<EMA20', returnPct: 100 * (side === 'SELL' ? entry / exit - 1 : exit / entry - 1) }
    }
  }
  const last = ordered.at(-1)
  return { entry, exit: last.close, exitTime: last.minute, exitReason: 'EOD', returnPct: 100 * (side === 'SELL' ? entry / last.close - 1 : last.close / entry - 1) }
}

function dailySessions(byDay, beforeDate) {
  return [...byDay.entries()]
    .filter(([date]) => date < beforeDate)
    .map(([date, rows]) => {
      const ordered = [...rows].sort((left, right) => left.minute.localeCompare(right.minute))
      return { date, open: ordered[0].open, high: Math.max(...ordered.map((row) => row.high)), low: Math.min(...ordered.map((row) => row.low)), close: ordered.at(-1).close }
    })
    .sort((left, right) => left.date.localeCompare(right.date))
}

function preSessionProfile({ side, todayOpen, openingReturnPct, classification, sessions }) {
  if (sessions.length < 5) return null
  const prior = sessions.at(-1), priorFive = sessions.slice(-5)
  const gapPct = 100 * (todayOpen / prior.close - 1)
  const priorDayReturnPct = 100 * (prior.close / prior.open - 1)
  const fiveSessionReturnPct = 100 * (prior.close / priorFive[0].close - 1)
  const priorCloseLocationPct = 100 * (prior.close - prior.low) / (prior.high - prior.low || 1)
  // These three mutually exclusive profiles were selected only from data
  // available by 09:17.  They consolidate the earlier four same-day branches.
  let profile = null
  if (side === 'SELL') {
    if (gapPct <= -1.0) profile = 'GAP_SHOCK'
    else if (priorDayReturnPct >= 3.5 && fiveSessionReturnPct >= 4.0) profile = 'MOMENTUM_UNWIND'
    else if (priorDayReturnPct <= 0 && priorCloseLocationPct <= 30 && openingReturnPct <= -1.10 && ['PRICE_ONLY', 'SELL_ABSORPTION'].includes(classification)) profile = 'FAILED_CLOSE_BREAKDOWN'
  } else {
    if (gapPct >= 1.0) profile = 'GAP_SHOCK'
    else if (priorDayReturnPct <= -3.5 && fiveSessionReturnPct <= -4.0) profile = 'MOMENTUM_UNWIND'
    else if (priorDayReturnPct >= 0 && priorCloseLocationPct >= 70 && openingReturnPct >= 1.10 && ['PRICE_ONLY', 'BUY_ABSORPTION'].includes(classification)) profile = 'FAILED_CLOSE_BREAKOUT'
  }
  return { gapPct, priorDayReturnPct, fiveSessionReturnPct, priorCloseLocationPct, profile }
}

function mayMatchPreSession({ side, todayOpen, openingReturnPct, sessions }) {
  if (sessions.length < 5) return false
  const prior = sessions.at(-1), priorFive = sessions.slice(-5)
  const gapPct = 100 * (todayOpen / prior.close - 1)
  const priorDayReturnPct = 100 * (prior.close / prior.open - 1)
  const fiveSessionReturnPct = 100 * (prior.close / priorFive[0].close - 1)
  const priorCloseLocationPct = 100 * (prior.close - prior.low) / (prior.high - prior.low || 1)
  if (side === 'SELL') return gapPct <= -1.0 || (priorDayReturnPct >= 3.5 && fiveSessionReturnPct >= 4.0) || (priorDayReturnPct <= 0 && priorCloseLocationPct <= 30 && openingReturnPct <= -1.10)
  return gapPct >= 1.0 || (priorDayReturnPct <= -3.5 && fiveSessionReturnPct <= -4.0) || (priorDayReturnPct >= 0 && priorCloseLocationPct >= 70 && openingReturnPct >= 1.10)
}

const signals = []
for (let index = 0; index < symbols.length; index++) {
  const symbol = symbols[index]
  process.stdout.write(`\rScanning... ${index + 1}/${symbols.length} ${symbol}`.padEnd(64))
  const byDay = readCandles(symbol)
  const today = openingReturn(byDay.get(cutoff.date) || [])
  if (!today) continue
  const priorDays = [...byDay.keys()].filter((day) => day < cutoff.date).sort().slice(-5)
  if (priorDays.length < 5) continue
  const priorReturns = priorDays.map((day) => openingReturn(byDay.get(day) || [])?.returnPct).filter(Number.isFinite)
  if (priorReturns.length < 5) continue
  const sessions = dailySessions(byDay, cutoff.date)
  for (const side of ['SELL', 'BUY']) {
    const isSell = side === 'SELL'
    const candlesPass = isSell
      ? today.first.close < today.first.open && today.second.close < today.second.open && today.second.close < today.first.close && today.returnPct <= -0.50
      : today.first.close > today.first.open && today.second.close > today.second.open && today.second.close > today.first.close && today.returnPct >= 0.50
    if (!candlesPass) continue
    const rank = 1 + priorReturns.filter((value) => isSell ? value < today.returnPct : value > today.returnPct).length
    if (rank > 3) continue
    if (!mayMatchPreSession({ side, todayOpen: today.first.open, openingReturnPct: today.returnPct, sessions })) continue
    const depthRows = readDepth(symbol)
    const depth = depthClassification(depthRows, side)
    const preSession = preSessionProfile({ side, todayOpen: today.first.open, openingReturnPct: today.returnPct, classification: depth.label, sessions })
    if (!preSession?.profile) continue
    const exit = ema10Ema20Exit(byDay.get(cutoff.date) || [], side)
    signals.push({
      Stock: symbol, Side: side, 'Signal time': '09:17', '09:15–09:16 return %': Number(today.returnPct.toFixed(3)),
      [`${isSell ? 'Weakness' : 'Strength'} rank /6`]: rank,
      'Prior 5 avg return %': Number((priorReturns.reduce((sum, value) => sum + value, 0) / priorReturns.length).toFixed(3)),
      Classification: depth.label, 'Depth snapshots': depth.snapshots,
      'L5 imbalance %': depth.imbalance === null ? null : Number((depth.imbalance * 100).toFixed(1)),
      'Depth midpoint %': depth.midpointPct === null ? null : Number(depth.midpointPct.toFixed(3)),
      'Pre-session profile': preSession.profile, 'Gap %': Number(preSession.gapPct.toFixed(3)),
      'Prior day return %': Number(preSession.priorDayReturnPct.toFixed(3)), 'Prior 5-session return %': Number(preSession.fiveSessionReturnPct.toFixed(3)),
      'Prior close location %': Number(preSession.priorCloseLocationPct.toFixed(1)),
      'EMA10/20 exit': exit.exitTime ? `${exit.exitTime} ${exit.exitReason}` : exit.exitReason,
      'EMA10/20 return %': exit.returnPct === null ? null : Number(exit.returnPct.toFixed(3)),
    })
  }
}
process.stdout.write('\n')
signals.sort((left, right) => left['Signal time'].localeCompare(right['Signal time']) || left.Side.localeCompare(right.Side) || left.Stock.localeCompare(right.Stock))
console.log(`\n09:16 opening-breakdown BUY and SELL signals through ${cutoff.date} ${cutoff.minute} IST`)
console.table(signals)
const buyNseSymbols = signals.filter((signal) => signal.Side === 'BUY').map((signal) => `NSE:${signal.Stock}-EQ`).join(', ')
const sellNseSymbols = signals.filter((signal) => signal.Side === 'SELL').map((signal) => `NSE:${signal.Stock}-EQ`).join(', ')
console.log(`BUY: ${buyNseSymbols || 'No signals'}`)
console.log(`SELL: ${sellNseSymbols || 'No signals'}`)

let sequence = 1, report
do { report = path.join(ROOT, 'reports', `${cutoff.date}-${cutoff.minute.replace(':', '')}-0916-opening-breakdown-signals${sequence === 1 ? '' : `-${sequence}`}.json`); sequence++ } while (fs.existsSync(report))
fs.writeFileSync(report, `${JSON.stringify({ cutoff: `${cutoff.date} ${cutoff.minute} IST`, chronology: 'The 09:17 signal uses only the completed 09:15 and 09:16 candles, five prior completed sessions, and depth snapshots received by the supplied cutoff.', rules: { sell: { firstTwoCandles: 'both red; second close below first close; combined return <= -0.50%', historical: 'current two-minute return is among the three weakest of five prior sessions', depth: 'SELL_CONFIRMED for ask-led book; SELL_ABSORPTION for a falling midpoint despite final bid rebuild; PRICE_ONLY below 20 snapshots', preSessionProfiles: { GAP_SHOCK: 'opening gap <= -1.0%', MOMENTUM_UNWIND: 'prior day return >= 3.5% and prior five-session return >= 4.0%', FAILED_CLOSE_BREAKDOWN: 'prior day return <= 0%, prior close in bottom 30% of its range, opening return <= -1.10%, and PRICE_ONLY or SELL_ABSORPTION depth' } }, buy: { firstTwoCandles: 'both green; second close above first close; combined return >= +0.50%', historical: 'current two-minute return is among the three strongest of five prior sessions', depth: 'BUY_CONFIRMED for bid-led book; BUY_ABSORPTION for a rising midpoint despite final ask rebuild; PRICE_ONLY below 20 snapshots', preSessionProfiles: { GAP_SHOCK: 'opening gap >= +1.0%', MOMENTUM_UNWIND: 'prior day return <= -3.5% and prior five-session return <= -4.0%', FAILED_CLOSE_BREAKOUT: 'prior day return >= 0%, prior close in top 30% of its range, opening return >= +1.10%, and PRICE_ONLY or BUY_ABSORPTION depth' } } }, signals, buyNseSymbols, sellNseSymbols }, null, 2)}\n`, { flag: 'wx' })
console.log(`Report: ${report}`)
