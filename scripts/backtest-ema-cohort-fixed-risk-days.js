import fs from 'node:fs'
import path from 'node:path'

const root = process.cwd()
const dates = ['2026-10-12', '2026-10-13', '2026-10-14', '2026-10-15']
const targetPct = 2.2
const stopPct = 0.5
const round = n => Number(n.toFixed(4))
const hhmm = seconds => new Date(seconds * 1000 + 330 * 60_000).toISOString().slice(11, 16)
const cohort = fs.readFileSync(path.join(root, 'reports/2026-10-05-to-2026-10-16-ema10-ema20-over-1p5-trend-legs.csv'), 'utf8')
  .trim().split(/\r?\n/).slice(1).map(line => {
    const [date, symbol, side, crossoverTime, , , oppositeCrossoverTime] = line.split(',')
    return { date, symbol, side, crossoverTime, oppositeCrossoverTime }
  }).filter(row => dates.includes(row.date))
  .sort((a, b) => a.date.localeCompare(b.date) || a.crossoverTime.localeCompare(b.crossoverTime) || a.symbol.localeCompare(b.symbol))
const cache = new Map()

function load(leg) {
  const key = `${leg.date}/${leg.symbol}`
  if (cache.has(key)) return cache.get(key)
  const from = Date.parse(`${leg.date}T00:00:00+05:30`) / 1000
  const to = from + 24 * 60 * 60
  const file = path.join(root, 'db/candles', `${leg.symbol}.jsonl`)
  const rows = fs.readFileSync(file, 'utf8').trim().split(/\r?\n/).map(JSON.parse)
    .filter(row => row.time >= from && row.time < to &&
      [row.open, row.high, row.low, row.close].every(Number.isFinite) && row.open > 0 &&
      row.high >= Math.max(row.open, row.close) && row.low <= Math.min(row.open, row.close))
    .sort((a, b) => a.time - b.time)
    .filter((row, index, all) => !index || row.time !== all[index - 1].time)
  let ema10, ema20
  for (const row of rows) {
    ema10 = ema10 === undefined ? row.close : row.close * 2 / 11 + ema10 * 9 / 11
    ema20 = ema20 === undefined ? row.close : row.close * 2 / 21 + ema20 * 19 / 21
    row.ema10 = ema10
    row.ema20 = ema20
  }
  const depthFile = path.join(root, 'db/cash-depth', leg.date, leg.symbol, `${leg.symbol}.jsonl`)
  const depth = fs.existsSync(depthFile) ? fs.readFileSync(depthFile, 'utf8').trim().split(/\r?\n/)
    .map(line => { try { return JSON.parse(line) } catch { return null } })
    .filter(row => row && Number.isFinite(Date.parse(row.receivedAt)))
    .sort((a, b) => Date.parse(a.receivedAt) - Date.parse(b.receivedAt)) : []
  const result = { rows, depth }
  cache.set(key, result)
  return result
}

function availableDepth(depth, at) {
  let lo = 0, hi = depth.length
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (Date.parse(depth[mid].receivedAt) <= at) lo = mid + 1
    else hi = mid
  }
  const row = depth[lo - 1]
  if (!row) return { available: false }
  const bidSize = [1, 2, 3, 4, 5].reduce((sum, i) => sum + (Number(row.data?.[`bid_size${i}`]) || 0), 0)
  const askSize = [1, 2, 3, 4, 5].reduce((sum, i) => sum + (Number(row.data?.[`ask_size${i}`]) || 0), 0)
  return { available: true, receivedAt: row.receivedAt, ageSeconds: round((at - Date.parse(row.receivedAt)) / 1000),
    bid: Number(row.data?.bid_price1), ask: Number(row.data?.ask_price1),
    fiveLevelBidSize: bidSize, fiveLevelAskSize: askSize,
    imbalance: bidSize + askSize ? round((bidSize - askSize) / (bidSize + askSize)) : null }
}

function replay(leg) {
  const { rows, depth } = load(leg)
  const cross = rows.findIndex(row => hhmm(row.time) === leg.crossoverTime)
  const reverse = rows.findIndex(row => hhmm(row.time) === leg.oppositeCrossoverTime)
  if (cross < 0 || reverse < cross + 2 || reverse + 1 >= rows.length) return { leg, error: 'missing candle or reversal' }
  const confirm = cross + 1, entry = cross + 2
  if (rows[confirm].time !== rows[cross].time + 60 || rows[entry].time !== rows[confirm].time + 60)
    return { leg, error: 'entry candles not contiguous' }
  const dir = leg.side === 'BUY' ? 1 : -1
  const entryPrice = rows[entry].open
  const stopPrice = entryPrice * (1 - dir * stopPct / 100)
  const targetPrice = entryPrice * (1 + dir * targetPct / 100)
  const at = (rows[confirm].time + 60) * 1000
  let worst = 0, exitPrice, exitTime, exitReason, sameBarTargetAlsoHit = false
  for (let i = entry; i <= reverse + 1; i++) {
    const row = rows[i]
    if (i > entry && row.time !== rows[i - 1].time + 60) return { leg, error: 'holding candles not contiguous' }
    if (i === reverse + 1) {
      exitPrice = row.open; exitTime = hhmm(row.time); exitReason = 'ema10/20 reversal'; break
    }
    worst = Math.min(worst, dir === 1 ? 100 * (row.low / entryPrice - 1) : 100 * (1 - row.high / entryPrice))
    const openPastStop = dir === 1 ? row.open <= stopPrice : row.open >= stopPrice
    const stopHit = dir === 1 ? row.low <= stopPrice : row.high >= stopPrice
    const targetHit = dir === 1 ? row.high >= targetPrice : row.low <= targetPrice
    if (openPastStop || stopHit) {
      exitPrice = openPastStop ? row.open : stopPrice
      exitTime = hhmm(row.time); exitReason = 'stop'; sameBarTargetAlsoHit = targetHit; break
    }
    if (targetHit) {
      exitPrice = targetPrice; exitTime = hhmm(row.time); exitReason = 'target'; break
    }
  }
  return { date: leg.date, symbol: leg.symbol, side: leg.side, crossoverTime: leg.crossoverTime,
    signalTime: hhmm(rows[confirm].time), entryTime: hhmm(rows[entry].time), entryPrice: round(entryPrice),
    stopPrice: round(stopPrice), targetPrice: round(targetPrice), exitTime, exitPrice: round(exitPrice), exitReason,
    returnPct: round(dir * 100 * (exitPrice / entryPrice - 1)), maxAdversePct: round(worst), sameBarTargetAlsoHit,
    ema10: round(rows[confirm].ema10), ema20: round(rows[confirm].ema20),
    confirmationEmaDirectionMatches: dir * (rows[confirm].ema10 - rows[confirm].ema20) > 0,
    depth: availableDepth(depth, at) }
}

function summary(trades, date) {
  const total = trades.reduce((sum, row) => sum + row.returnPct, 0)
  return { date, tradeCount: trades.length, targetHits: trades.filter(row => row.exitReason === 'target').length,
    stops: trades.filter(row => row.exitReason === 'stop').length,
    otherExits: trades.filter(row => row.exitReason === 'ema10/20 reversal').length,
    winRatePct: round(100 * trades.filter(row => row.returnPct > 0).length / (trades.length || 1)),
    targetHitRatePct: round(100 * trades.filter(row => row.exitReason === 'target').length / (trades.length || 1)),
    stopRatePct: round(100 * trades.filter(row => row.exitReason === 'stop').length / (trades.length || 1)),
    averageReturnPct: round(total / (trades.length || 1)), totalReturnPct: round(total),
    maximumAdverseExcursionPct: trades.length ? round(Math.min(...trades.map(row => row.maxAdversePct))) : null,
    depthAvailable: trades.filter(row => row.depth.available).length,
    confirmationEmaDirectionMismatches: trades.filter(row => !row.confirmationEmaDirectionMatches).length }
}

const results = cohort.map(replay)
const skipped = results.filter(row => row.error)
const trades = results.filter(row => !row.error)
const days = dates.map(date => summary(trades.filter(row => row.date === date), date))
const overall = summary(trades, '2026-10-12 to 2026-10-15')
const worstDay = days.reduce((a, b) => !a || b.totalReturnPct < a.totalReturnPct ? b : a, null)
const output = { rule: 'Fixed from October 16 search: recorded EMA10/20 crossover, next complete candle confirms, enter at following open, 0.5% stop, 2.2% target, otherwise exit at open after opposite EMA10/20 crossover. Same-candle stop priority; stop gaps fill at open. Depth and indicators are available by confirmation time but do not filter trades.',
  scope: 'Only legs from the preselected 159-leg >1.5% EMA10/20 cohort on October 12-15; this is retrospectively selected, not an unbiased prospective signal set.',
  costs: 'Gross, one equal trade per leg, percentage-point sum; excludes spread, fees and slippage.',
  cohortLegs: cohort.length, skipped, days, overall, worstDay: { date: worstDay.date, totalReturnPct: worstDay.totalReturnPct }, trades }
let n = 1, file
do { file = path.join(root, 'reports', `2026-10-12-to-2026-10-15-ema-cohort-fixed-risk${n === 1 ? '' : `-${n}`}.json`); n++ } while (fs.existsSync(file))
fs.writeFileSync(file, JSON.stringify(output, null, 2) + '\n')
console.log(JSON.stringify({ file, cohortLegs: cohort.length, skipped: skipped.length, days, overall, worstDay: output.worstDay }, null, 2))
