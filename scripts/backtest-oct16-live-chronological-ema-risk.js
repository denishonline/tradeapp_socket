import fs from 'node:fs'
import path from 'node:path'

const root = process.cwd()
const date = '2026-10-16'
const from = Date.parse(`${date}T09:15:00+05:30`) / 1000
const to = Date.parse(`${date}T15:30:00+05:30`) / 1000
const targetPct = Number(process.argv.find(arg => arg.startsWith('--target='))?.split('=')[1] ?? 2.2)
if (!Number.isFinite(targetPct) || targetPct < 0.5) throw new Error('Target must be at least 0.5%')
const stopPct = 0.5
const symbols = [...new Set(JSON.parse(fs.readFileSync(path.join(root, 'db/stocks'), 'utf8'))
  .map(s => String(s).trim().toUpperCase().replace(/-EQ$/, '')))]
const round = n => Number.isFinite(n) ? Number(n.toFixed(4)) : null
const hhmm = seconds => new Date(seconds * 1000 + 330 * 60_000).toISOString().slice(11, 16)
const saveUnique = (stem, ext, value) => {
  let i = 1, file
  do { file = path.join(root, 'reports', `${stem}${i === 1 ? '' : `-${i}`}.${ext}`); i++ } while (fs.existsSync(file))
  fs.writeFileSync(file, value, { flag: 'wx' })
  return file
}

function candles(symbol) {
  const file = path.join(root, 'db/candles', `${symbol}.jsonl`)
  if (!fs.existsSync(file)) return []
  const rows = []
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue
    let r
    try { r = JSON.parse(line) } catch { continue }
    if (!Number.isFinite(r.time) || r.time < from || r.time >= to ||
      ![r.open, r.high, r.low, r.close, r.volume].every(Number.isFinite) ||
      r.low <= 0 || r.volume < 0 || r.high < Math.max(r.open, r.close) || r.low > Math.min(r.open, r.close)) continue
    rows.push(r)
  }
  rows.sort((a, b) => a.time - b.time)
  const unique = rows.filter((r, i) => !i || r.time !== rows[i - 1].time)
  let ema10, ema20, previousSign = 0
  for (let i = 0; i < unique.length; i++) {
    const r = unique[i]
    ema10 = ema10 === undefined ? r.close : r.close * 2 / 11 + ema10 * 9 / 11
    ema20 = ema20 === undefined ? r.close : r.close * 2 / 21 + ema20 * 19 / 21
    r.ema10 = ema10; r.ema20 = ema20
    r.sign = Math.sign(ema10 - ema20)
    r.cross = i >= 19 && previousSign && r.sign && r.sign !== previousSign
    if (i >= 19 && r.sign) previousSign = r.sign
  }
  return unique
}

function depthRows(symbol) {
  const file = path.join(root, 'db/cash-depth', date, symbol, `${symbol}.jsonl`)
  if (!fs.existsSync(file)) return []
  const rows = []
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue
    try {
      const r = JSON.parse(line), received = Date.parse(r.receivedAt)
      if (Number.isFinite(received)) rows.push({ received, data: r.data })
    } catch {}
  }
  rows.sort((a, b) => a.received - b.received)
  return rows
}

function latestDepth(rows, at) {
  let lo = 0, hi = rows.length
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (rows[mid].received <= at) lo = mid + 1
    else hi = mid
  }
  const r = rows[lo - 1]
  if (!r) return { available: false }
  const bidSize = [1, 2, 3, 4, 5].reduce((s, n) => s + (Number(r.data?.[`bid_size${n}`]) || 0), 0)
  const askSize = [1, 2, 3, 4, 5].reduce((s, n) => s + (Number(r.data?.[`ask_size${n}`]) || 0), 0)
  return { available: true, receivedAt: new Date(r.received).toISOString(), ageSeconds: round((at - r.received) / 1000),
    bid: Number(r.data?.bid_price1), ask: Number(r.data?.ask_price1),
    fiveLevelBidSize: bidSize, fiveLevelAskSize: askSize,
    imbalance: bidSize + askSize ? round((bidSize - askSize) / (bidSize + askSize)) : null }
}

function replay(rows, entryIndex, dir) {
  const entry = rows[entryIndex], entryPrice = entry.open
  const stopPrice = entryPrice * (1 - dir * stopPct / 100)
  const targetPrice = entryPrice * (1 + dir * targetPct / 100)
  let worst = 0
  for (let i = entryIndex; i < rows.length; i++) {
    const r = rows[i]
    if (i > entryIndex && r.time !== rows[i - 1].time + 60) {
      const price = rows[i - 1].close
      return { exitAt: (rows[i - 1].time + 60) * 1000, exitTime: hhmm(rows[i - 1].time + 60),
        exitReason: 'data gap', exitPrice: price, returnPct: round(dir * 100 * (price / entryPrice - 1)), maxAdversePct: round(worst) }
    }
    const barAdverse = dir === 1 ? 100 * (r.low / entryPrice - 1) : 100 * (1 - r.high / entryPrice)
    const openPastStop = dir === 1 ? r.open <= stopPrice : r.open >= stopPrice
    const stopHit = dir === 1 ? r.low <= stopPrice : r.high >= stopPrice
    const targetHit = dir === 1 ? r.high >= targetPrice : r.low <= targetPrice
    if (openPastStop || stopHit || targetHit) {
      const stop = openPastStop || stopHit
      const price = stop ? (openPastStop ? r.open : stopPrice) : targetPrice
      const returnPct = round(dir * 100 * (price / entryPrice - 1))
      worst = Math.min(worst, stop ? returnPct : barAdverse)
      return { exitAt: (r.time + 60) * 1000, exitTime: hhmm(r.time), exitReason: stop ? 'stop' : 'target',
        exitPrice: round(price), returnPct,
        maxAdversePct: round(worst), sameBarStopAndTarget: stopHit && targetHit }
    }
    worst = Math.min(worst, barAdverse)
    if (i >= 19 && r.cross && r.sign === -dir) {
      const next = rows[i + 1]
      const price = next?.time === r.time + 60 ? next.open : r.close
      const exitAt = next?.time === r.time + 60 ? next.time * 1000 : (r.time + 60) * 1000
      return { exitAt, exitTime: hhmm(exitAt / 1000), exitReason: 'opposite EMA cross',
        exitPrice: price, returnPct: round(dir * 100 * (price / entryPrice - 1)), maxAdversePct: round(worst) }
    }
  }
  const last = rows.at(-1)
  return { exitAt: (last.time + 60) * 1000, exitTime: hhmm(last.time + 60), exitReason: 'session close',
    exitPrice: last.close, returnPct: round(dir * 100 * (last.close / entryPrice - 1)), maxAdversePct: round(worst) }
}

const nifty = new Map(candles('NIFTY50').map(r => [r.time, r.close]))
const trades = []
const audit = { symbols: symbols.length, withCandles: 0, withDepth: 0, rawCrosses: 0,
  noConfirmation: 0, confirmationReversed: 0, noEntry: 0, overlappingSkipped: 0, missingDepthAtSignal: 0 }

for (const symbol of symbols) {
  const rows = candles(symbol)
  if (!rows.length) continue
  audit.withCandles++
  let book = null, busyUntil = -Infinity
  for (let i = 0; i < rows.length; i++) {
    if (!rows[i].cross) continue
    audit.rawCrosses++
    if (!rows[i + 1] || rows[i + 1].time !== rows[i].time + 60) { audit.noConfirmation++; continue }
    if (rows[i + 1].sign !== rows[i].sign) { audit.confirmationReversed++; continue }
    if (!rows[i + 2] || rows[i + 2].time !== rows[i + 1].time + 60) { audit.noEntry++; continue }
    const entry = rows[i + 2]
    if (entry.time * 1000 < busyUntil) { audit.overlappingSkipped++; continue }
    if (book === null) { book = depthRows(symbol); if (book.length) audit.withDepth++ }
    const signal = rows[i + 1], signalAt = (signal.time + 60) * 1000
    const depth = latestDepth(book, signalAt)
    if (!depth.available) audit.missingDepthAtSignal++
    const dir = rows[i].sign
    const outcome = replay(rows, i + 2, dir)
    busyUntil = outcome.exitAt
    trades.push({ date, symbol, side: dir > 0 ? 'BUY' : 'SELL', crossoverTime: hhmm(rows[i].time),
      signalTime: hhmm(signal.time), signalAt: new Date(signalAt).toISOString(), entryTime: hhmm(entry.time),
      entryPrice: entry.open, stopPrice: round(entry.open * (1 - dir * stopPct / 100)),
      targetPrice: round(entry.open * (1 + dir * targetPct / 100)),
      confirmationEmaDirectionMatches: signal.sign === dir, ema10: round(signal.ema10), ema20: round(signal.ema20),
      nifty50CloseAtConfirmation: nifty.get(signal.time) ?? null, depth, ...outcome })
  }
}
trades.sort((a, b) => a.signalAt.localeCompare(b.signalAt) || a.symbol.localeCompare(b.symbol))
const total = trades.reduce((sum, r) => sum + r.returnPct, 0)
const winners = trades.filter(r => r.returnPct > 0).length
const stops = trades.filter(r => r.exitReason === 'stop').length
const summary = { date, tradeCount: trades.length, winners, targetHits: trades.filter(r => r.exitReason === 'target').length,
  stops, winRatePct: round(100 * winners / (trades.length || 1)),
  targetHitRatePct: round(100 * trades.filter(r => r.exitReason === 'target').length / (trades.length || 1)),
  stopRatePct: round(100 * stops / (trades.length || 1)), averageReturnPct: round(total / (trades.length || 1)),
  totalReturnPct: round(total), maximumAdverseExcursionPct: trades.length ? round(Math.min(...trades.map(r => r.maxAdversePct))) : null,
  worstDay: { date, totalReturnPct: round(total) },
  otherExits: trades.filter(r => !['stop', 'target'].includes(r.exitReason)).length,
  confirmationEmaDirectionMismatches: trades.filter(r => !r.confirmationEmaDirectionMatches).length }
const method = `All ${symbols.length} symbols in db/stocks, without ex-post cohort selection. Session-seeded one-minute EMA10/20 crossover after 20 completed candles. Require the EMA direction to persist through the next completed candle; capture EMA and latest depth received no later than its end; enter at following candle open. Fixed 0.5% stop and ${targetPct}% target. For a bar hitting both, stop takes priority; stop gaps fill at open. If neither hits, exit at the open after a completed opposite EMA cross or at session close. At most one position per symbol. No depth or NIFTY filter. Gross equal-trade percentage sum, no spread, fees, slippage or capital constraints.`
const output = { method, source: ['db/stocks', 'db/candles/<SYMBOL>.jsonl', 'db/candles/NIFTY50.jsonl', 'db/cash-depth/2026-10-16/<SYMBOL>/<SYMBOL>.jsonl'],
  audit, summary, trades }
const stem = `2026-10-16-live-chronological-ema10-20-stop0p5-target${String(targetPct).replace('.', 'p')}`
const json = saveUnique(stem, 'json', JSON.stringify(output, null, 2) + '\n')
const columns = ['date','symbol','side','crossoverTime','signalTime','entryTime','entryPrice','stopPrice','targetPrice','exitTime','exitReason','exitPrice','returnPct','maxAdversePct','confirmationEmaDirectionMatches','nifty50CloseAtConfirmation','depthAvailable','depthAgeSeconds','depthImbalance']
const csvValue = v => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s }
const csvRows = trades.map(r => ({ ...r, depthAvailable: r.depth.available, depthAgeSeconds: r.depth.ageSeconds, depthImbalance: r.depth.imbalance }))
const csv = saveUnique(stem, 'csv', columns.join(',') + '\n' + csvRows.map(r => columns.map(c => csvValue(r[c])).join(',')).join('\n') + '\n')
console.log(JSON.stringify({ json, csv, audit, summary }, null, 2))
