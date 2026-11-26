const fs = require('node:fs')
const path = require('node:path')

const dates = new Set(['2026-10-19', '2026-10-21', '2026-10-22', '2026-10-23'])
const dir = path.join(process.cwd(), 'db', 'candles')
const day = t => new Date(t * 1000).toISOString().slice(0, 10)
const hm = t => new Date(t * 1000 + 330 * 60000).toISOString().slice(11, 16)
const round = (x, n = 3) => Number.isFinite(x) ? Number(x.toFixed(n)) : null
const pct = (a, b) => 100 * (a / b - 1)

function load(symbol) {
  return fs.readFileSync(path.join(dir, `${symbol}.jsonl`), 'utf8').trim().split(/\r?\n/)
    .map(line => JSON.parse(line)).filter(row => Number.isFinite(+row.close))
    .sort((a, b) => a.time - b.time)
}

const rows = []
for (const file of fs.readdirSync(dir).filter(x => x.endsWith('.jsonl') && x !== 'NIFTY50.jsonl')) {
  const symbol = file.slice(0, -6)
  const candles = load(symbol)
  let ema10 = null, ema20 = null, ema45 = null, priorDiff = null
  let avgGain = null, avgLoss = null, seedGain = 0, seedLoss = 0
  const closes = [], signals = new Map(), crosses = new Map(), previousClose = new Map()
  let priorSessionClose = null, activeDay = null
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i], d = day(c.time), close = +c.close
    if (activeDay !== d) {
      if (activeDay !== null) priorSessionClose = closes.at(-1)
      activeDay = d
      previousClose.set(d, priorSessionClose)
    }
    const old10 = ema10, old20 = ema20, old45 = ema45
    ema10 = ema10 === null ? close : ema10 + 2 / 11 * (close - ema10)
    ema20 = ema20 === null ? close : ema20 + 2 / 21 * (close - ema20)
    ema45 = ema45 === null ? close : ema45 + 2 / 46 * (close - ema45)
    const diff = ema10 - ema20
    const prev = closes.at(-1)
    if (prev !== undefined) {
      const change = close - prev, gain = Math.max(change, 0), loss = Math.max(-change, 0)
      if (avgGain === null) {
        seedGain += gain; seedLoss += loss
        if (i >= 20) { avgGain = seedGain / 20; avgLoss = seedLoss / 20 }
      } else {
        avgGain = (19 * avgGain + gain) / 20
        avgLoss = (19 * avgLoss + loss) / 20
      }
    }
    closes.push(close)
    if (dates.has(d) && !signals.has(d) && 100 * (1 - ema20 / ema45) > .1 &&
        100 * (1 - ema20 / ema45) < .2 && 100 * (1 - close / ema45) > 1.5) {
      const last20 = closes.slice(-20)
      const wma20 = last20.length === 20 ? last20.reduce((s, x, j) => s + (j + 1) * x, 0) / 210 : null
      const rsi20 = avgGain === null ? null : avgLoss === 0 ? (avgGain === 0 ? 50 : 100) : 100 - 100 / (1 + avgGain / avgLoss)
      const priorDay = previousClose.get(d)
      signals.set(d, {
        date: d, symbol, signalTime: hm(c.time), signalEpoch: c.time, signalClose: close,
        features: {
          rsi20, closeWma20Pct: wma20 ? pct(close, wma20) : null,
          closeEma10Pct: pct(close, ema10), ema10Ema20Pct: pct(ema10, ema20),
          ema20Ema45BelowPct: 100 * (1 - ema20 / ema45),
          closeEma45BelowPct: 100 * (1 - close / ema45),
          ema45ChangePct: old45 ? pct(ema45, old45) : null,
          candleBodyPct: pct(close, +c.open),
          closePriorSessionPct: priorDay ? pct(close, priorDay) : null,
          closePriorCandlePct: prev ? pct(close, prev) : null,
          candleRangePct: 100 * (+c.high - +c.low) / close,
          minuteOfDay: Number(hm(c.time).slice(0, 2)) * 60 + Number(hm(c.time).slice(3))
        }
      })
    }
    const signal = signals.get(d)
    if (signal && c.time > signal.signalEpoch && !crosses.has(d))
      signal.maxAdverseHigh = Math.max(signal.maxAdverseHigh ?? signal.signalClose, +c.high)
    if (signal && c.time > signal.signalEpoch && !crosses.has(d) && priorDiff !== null &&
        ((priorDiff <= 0 && diff > 0) || (priorDiff >= 0 && diff < 0))) {
      crosses.set(d, { crossTime: hm(c.time), crossClose: close, direction: diff > 0 ? 'ABOVE' : 'BELOW' })
    }
    priorDiff = diff
  }
  for (const [d, signal] of signals) {
    const cross = crosses.get(d)
    rows.push({ ...signal, ...cross, shortReturnPct: cross ? 100 * (signal.signalClose - cross.crossClose) / signal.signalClose : null,
      maePct: cross ? 100 * ((signal.maxAdverseHigh ?? signal.signalClose) / signal.signalClose - 1) : null,
      outcome: !cross ? 'NO_CROSS' : cross.crossClose < signal.signalClose ? 'WIN' : cross.crossClose > signal.signalClose ? 'LOSS' : 'FLAT' })
  }
}
rows.sort((a, b) => a.date.localeCompare(b.date) || a.signalTime.localeCompare(b.signalTime) || a.symbol.localeCompare(b.symbol))
// Market context is sampled no later than each stock's completed signal candle.
const nifty = load('NIFTY50')
const marketAt = new Map()
let m10 = null, m20 = null, m45 = null, mAvgG = null, mAvgL = null, mSeedG = 0, mSeedL = 0
let mPriorClose = null, mDay = null, mOpen = null
const mCloses = []
for (let i = 0; i < nifty.length; i++) {
  const c = nifty[i], d = day(c.time), v = +c.close
  if (d !== mDay) { if (mDay !== null) mPriorClose = mCloses.at(-1); mDay = d; mOpen = +c.open }
  m10 = m10 === null ? v : m10 + 2 / 11 * (v - m10)
  m20 = m20 === null ? v : m20 + 2 / 21 * (v - m20)
  m45 = m45 === null ? v : m45 + 2 / 46 * (v - m45)
  const prev = mCloses.at(-1)
  if (prev !== undefined) {
    const change = v - prev, gain = Math.max(change, 0), loss = Math.max(-change, 0)
    if (mAvgG === null) { mSeedG += gain; mSeedL += loss; if (i >= 20) { mAvgG = mSeedG / 20; mAvgL = mSeedL / 20 } }
    else { mAvgG = (19 * mAvgG + gain) / 20; mAvgL = (19 * mAvgL + loss) / 20 }
  }
  mCloses.push(v)
  marketAt.set(c.time, {
    niftyGapPct: mPriorClose ? pct(mOpen, mPriorClose) : null,
    niftyFromOpenPct: pct(v, mOpen), niftyFromPriorClosePct: mPriorClose ? pct(v, mPriorClose) : null,
    niftyEma10Ema20Pct: pct(m10, m20), niftyEma20Ema45Pct: pct(m20, m45),
    niftyRsi20: mAvgG === null ? null : mAvgL === 0 ? (mAvgG === 0 ? 50 : 100) : 100 - 100 / (1 + mAvgG / mAvgL),
    niftyMomentum5Pct: mCloses.length >= 6 ? pct(v, mCloses.at(-6)) : null,
    niftyMomentum15Pct: mCloses.length >= 16 ? pct(v, mCloses.at(-16)) : null
  })
}
for (const row of rows) Object.assign(row.features, marketAt.get(row.signalEpoch) || {})
const wins = rows.filter(x => x.outcome === 'WIN'), losses = rows.filter(x => x.outcome === 'LOSS')
const candidates = []
for (const key of Object.keys(rows[0].features)) {
  const values = [...new Set(rows.map(x => x.features[key]).filter(Number.isFinite))].sort((a, b) => a - b)
  for (let i = 0; i < values.length - 1; i++) {
    const threshold = (values[i] + values[i + 1]) / 2
    for (const op of ['<', '>']) {
      const test = row => Number.isFinite(row.features[key]) && (op === '<' ? row.features[key] < threshold : row.features[key] > threshold)
      if (wins.some(test)) continue
      const caught = losses.filter(test)
      if (caught.length) candidates.push({ key, op, threshold, caught: caught.map(x => `${x.date}|${x.symbol}`) })
    }
  }
}
candidates.sort((a, b) => b.caught.length - a.caught.length || a.key.localeCompare(b.key))
const best = candidates.slice(0, 15).map(x => ({ ...x, threshold: round(x.threshold, 5) }))
// Check whether a two-condition rule can reject more losers without rejecting winners.
const allMask = (1n << BigInt(rows.length)) - 1n
const winMask = wins.reduce((m, row) => m | (1n << BigInt(rows.indexOf(row))), 0n)
const lossMask = losses.reduce((m, row) => m | (1n << BigInt(rows.indexOf(row))), 0n)
const masks = new Map()
for (const key of Object.keys(rows[0].features)) {
  const values = [...new Set(rows.map(x => x.features[key]).filter(Number.isFinite))].sort((a, b) => a - b)
  for (let i = 0; i < values.length - 1; i++) for (const op of ['<', '>']) {
    const threshold = (values[i] + values[i + 1]) / 2
    const mask = rows.reduce((m, row, j) => Number.isFinite(row.features[key]) &&
      (op === '<' ? row.features[key] < threshold : row.features[key] > threshold) ? m | (1n << BigInt(j)) : m, 0n)
    if (!(mask & lossMask) || mask === allMask) continue
    if (!masks.has(mask.toString())) masks.set(mask.toString(), { key, op, threshold, mask })
  }
}
const pool = [...masks.values()]
let bestPair = null
for (let i = 0; i < pool.length; i++) for (let j = i + 1; j < pool.length; j++) {
  const mask = pool[i].mask & pool[j].mask
  if (mask & winMask || !(mask & lossMask)) continue
  const caught = rows.filter((row, k) => row.outcome === 'LOSS' && (mask & (1n << BigInt(k))))
  if (!bestPair || caught.length > bestPair.caught.length) bestPair = {
    conditions: [pool[i], pool[j]].map(({ key, op, threshold }) => ({ key, op, threshold: round(threshold, 5) })),
    caught: caught.map(x => `${x.date}|${x.symbol}`)
  }
}
// Round the fitted boundaries to simple values, then evaluate them again.
const bodyLimit = -2.9
const selectedPair = [
  { key: 'ema10Ema20Pct', op: '>', threshold: -0.4 },
  { key: 'niftyEma10Ema20Pct', op: '<', threshold: -0.03 }
]
const rejected = rows.filter(row => row.features.candleBodyPct < bodyLimit ||
  selectedPair.every(({ key, op, threshold }) => op === '<' ? row.features[key] < threshold : row.features[key] > threshold))
const kept = rows.filter(row => !rejected.includes(row))
function stats(input) {
  const trades = input.filter(x => Number.isFinite(x.shortReturnPct))
  const returns = trades.map(x => x.shortReturnPct)
  const dayTotals = [...new Set(trades.map(x => x.date))].map(date => ({ date,
    returnPct: trades.filter(x => x.date === date).reduce((s, x) => s + x.shortReturnPct, 0) }))
  dayTotals.sort((a, b) => a.returnPct - b.returnPct)
  return { tradeCount: trades.length, winRatePct: round(100 * trades.filter(x => x.shortReturnPct > 0).length / trades.length),
    averageReturnPct: round(returns.reduce((a, b) => a + b, 0) / trades.length),
    totalReturnPct: round(returns.reduce((a, b) => a + b, 0)),
    maximumAdverseExcursionPct: round(Math.max(...trades.map(x => x.maePct))),
    worstDay: { date: dayTotals[0].date, totalReturnPct: round(dayTotals[0].returnPct) },
    noCross: input.filter(x => x.outcome === 'NO_CROSS').map(x => `${x.date}|${x.symbol}`) }
}
const filter = { rejectIfEither: [
  { conditions: [{ key: 'candleBodyPct', op: '<', threshold: round(bodyLimit, 5) }] },
  { conditions: selectedPair }
], rejected: rejected.map(x => ({ date: x.date, symbol: x.symbol, outcome: x.outcome })),
  before: stats(rows), after: stats(kept) }
const result = { method: 'One-minute stock candles through signal only for filters. First signal per symbol/day. Short at signal close, cover at first same-session EMA10/EMA20 cross close. Gross returns.',
  dates: [...dates], counts: { signals: rows.length, winners: wins.length, losers: losses.length, noCross: rows.filter(x => x.outcome === 'NO_CROSS').length },
  bestZeroWinnerLossFilters: best, bestTwoConditionFilter: bestPair, filter,
  signals: rows.map(x => ({ ...x, features: Object.fromEntries(Object.entries(x.features).map(([k, v]) => [k, round(v)])), shortReturnPct: round(x.shortReturnPct) })) }
const base = path.join(process.cwd(), 'reports', '2026-10-19-to-23-ema-gap-short-loss-filter')
let output = `${base}.json`, suffix = 2
while (fs.existsSync(output)) output = `${base}-${suffix++}.json`
fs.writeFileSync(output, JSON.stringify(result, null, 2) + '\n')
console.log(JSON.stringify({ output, counts: result.counts, filter }, null, 2))
