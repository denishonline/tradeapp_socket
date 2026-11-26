#!/usr/bin/env node

// Discover causal reversal rules inside daily PVI/NVI top-10 rankings.
// SELL ranking -> BUY reversal; BUY ranking -> SELL reversal.

import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'
import { load, featureRow } from './discover-0920-pvi-nvi-short-filter.js'

const ROOT = process.cwd()
const DEFAULT_SOURCE = path.join(ROOT, 'reports', '2026-10-01-to-2026-10-30-pvi-nvi-top10-both-three-or-0917-0940.json')
const SIGNAL_FIRST_BAR = 556 // completed 09:16, signal available 09:17
const SIGNAL_LAST_BAR = 579  // completed 09:39, signal available 09:40
const arg = name => { const i = process.argv.indexOf(name); return i < 0 ? null : process.argv[i + 1] }
const has = name => process.argv.includes(name)
const usage = [
  'Usage: node scripts/research-pvi-nvi-top10-reversal-rules.js [options]',
  '',
  '  --source PATH          Ranking JSON (default October top-10 JSON)',
  '  --target PCT           Reversal target percentage (default 1)',
  '  --min-precision PCT    Minimum fitted target-hit rate (default 90)',
  '  --min-signals N        Minimum fitted signals per reversal side (default 5)',
  '  --frozen-model PATH    Replay finalFit rules from an existing study; do not fit',
  '  --no-depth             Exclude market-depth features',
  '  --help',
].join('\n')
const fail = message => { throw new Error(`${message}\n\n${usage}`) }
const round = (value, digits = 5) => Number.isFinite(value) ? +value.toFixed(digits) : null
const pct = (a, b) => b > 0 ? 100 * (a / b - 1) : NaN
const avg = values => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : NaN
const clock = minute => `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`
const uniquePath = (directory, stem, extension) => {
  let suffix = 1, file
  do { file = path.join(ROOT, directory, `${stem}${suffix === 1 ? '' : `-${suffix}`}.${extension}`); suffix++ } while (fs.existsSync(file))
  return file
}
const csvCell = value => {
  if (value == null) return ''
  const text = String(value)
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
}

if (has('--help')) { console.log(usage); process.exit(0) }
const sourceFile = path.resolve(arg('--source') ?? DEFAULT_SOURCE)
const targetPct = Number(arg('--target') ?? 1)
const minimumPrecision = Number(arg('--min-precision') ?? 90) / 100
const minimumSignals = Number(arg('--min-signals') ?? 5)
const useDepth = !has('--no-depth')
const frozenModelFile = arg('--frozen-model') ? path.resolve(arg('--frozen-model')) : null
if (!fs.existsSync(sourceFile)) fail(`Source JSON not found: ${sourceFile}`)
if (frozenModelFile && !fs.existsSync(frozenModelFile)) fail(`Frozen model JSON not found: ${frozenModelFile}`)
if (!Number.isFinite(targetPct) || targetPct <= 0) fail('--target must be positive')
if (!Number.isFinite(minimumPrecision) || minimumPrecision <= 0 || minimumPrecision > 1) fail('--min-precision must be from 0 through 100')
if (!Number.isInteger(minimumSignals) || minimumSignals < 1) fail('--min-signals must be a positive integer')

const source = JSON.parse(fs.readFileSync(sourceFile, 'utf8'))
if (!Array.isArray(source.results)) fail('Source JSON must contain results[]')
const rankingGroups = source.results.filter(result => ['buy', 'sell'].includes(result.side) && Array.isArray(result.ranking) && result.ranking.length)
const allDates = [...new Set(rankingGroups.map(group => group.date))].sort()
const activeDates = [...new Set(rankingGroups.filter(group => group.ranking.length).map(group => group.date))].sort()
const splitDate = activeDates[Math.floor(activeDates.length / 2)]
const validationDate = activeDates[Math.floor(activeDates.length / 4)]

const rawCache = new Map()
const raw = symbol => {
  if (!rawCache.has(symbol)) rawCache.set(symbol, load(symbol))
  return rawCache.get(symbol)
}
const priorDates = (rows, date) => [...new Set(rows.filter(row => row.date < date).map(row => row.date))].sort().slice(-2)
const sessionCache = new Map()
const session = (symbol, date) => {
  const key = `${symbol}|${date}`
  if (sessionCache.has(key)) return sessionCache.get(key)
  const prior = priorDates(raw(symbol), date)
  const value = prior.length === 2 ? load(symbol, [...prior, date]) : null
  sessionCache.set(key, value)
  return value
}
const niftyCache = new Map()
const niftyFor = date => {
  if (niftyCache.has(date)) return niftyCache.get(date)
  const prior = priorDates(raw('NIFTY50'), date)
  const value = prior.length === 2 ? load('NIFTY50', [...prior, date]) : null
  niftyCache.set(date, value)
  return value
}

function reversalOutcome(day, observedMinute, tradeSide) {
  // Signal is known after observedMinute completes. Entry is the close of the
  // following candle, one minute after signal availability.
  const entry = day.find(row => row.minute === observedMinute + 1)
  if (!entry || entry.v <= 0) return null
  const subsequent = day.filter(row => row.minute > observedMinute + 1)
  if (!subsequent.length) return null
  let cross = null, previous = entry
  for (const row of subsequent) {
    const oppositeCross = tradeSide === 'buy'
      ? previous.ema[20] >= previous.ema[40] && row.ema[20] < row.ema[40]
      : previous.ema[20] <= previous.ema[40] && row.ema[20] > row.ema[40]
    if (oppositeCross) { cross = row; break }
    previous = row
  }
  const path = subsequent.filter(row => !cross || row.minute <= cross.minute)
  const targetPrice = entry.c * (tradeSide === 'buy' ? 1 + targetPct / 100 : 1 - targetPct / 100)
  const target = path.find(row => tradeSide === 'buy' ? row.h >= targetPrice : row.l <= targetPrice)
  const last = day.at(-1), crossFill = cross && day.find(row => row.minute === cross.minute + 1)
  const exitRow = target || crossFill || last
  if (!exitRow) return null
  for (let minute = observedMinute + 2; minute <= exitRow.minute; minute++) if (!day.some(row => row.minute === minute)) return null
  const exitPrice = target ? targetPrice : exitRow.c
  const held = subsequent.filter(row => row.minute <= exitRow.minute)
  const high = Math.max(entry.c, ...held.map(row => row.h)), low = Math.min(entry.c, ...held.map(row => row.l))
  const grossReturnPct = tradeSide === 'buy'
    ? 100 * (exitPrice - entry.c) / entry.c
    : 100 * (entry.c - exitPrice) / entry.c
  return {
    signalTime: clock(observedMinute + 1), entryTime: clock(observedMinute + 2), entryPrice: entry.c,
    exitTime: target ? `${clock(target.minute)}-${clock(target.minute + 1)}` : clock(exitRow.minute + 1), exitPrice,
    exitReason: target ? `${targetPct}% target` : cross ? `EMA20 crosses ${tradeSide === 'buy' ? 'below' : 'above'} EMA40` : 'session close',
    targetHit: Boolean(target), grossReturnPct: round(grossReturnPct),
    maePct: round(tradeSide === 'buy' ? 100 * (entry.c - low) / entry.c : 100 * (high - entry.c) / entry.c),
    mfePct: round(tradeSide === 'buy' ? 100 * (high - entry.c) / entry.c : 100 * (entry.c - low) / entry.c),
  }
}

function extraFeatures(stock, date, observedMinute) {
  const observed = stock.filter(row => row.date < date || row.minute <= observedMinute)
  const today = observed.filter(row => row.date === date), current = today.at(-1)
  if (!current) return {}
  const prior = observed.filter(row => row.date < date)
  const priorHigh = Math.max(...prior.map(row => row.h)), priorLow = Math.min(...prior.map(row => row.l))
  const features = { distanceTwoSessionHigh: pct(current.c, priorHigh), distanceTwoSessionLow: pct(current.c, priorLow) }
  for (const period of [3, 5, 10, 15]) {
    const before = today.slice(Math.max(0, today.length - period - 1), -1)
    if (before.length === period) {
      const high = Math.max(...before.map(row => row.h)), low = Math.min(...before.map(row => row.l))
      features[`breakPrior${period}Low`] = pct(current.c, low)
      features[`breakPrior${period}High`] = pct(current.c, high)
      features[`sweep${period}HighReject`] = Number(current.h > high && current.c < high)
      features[`sweep${period}LowRecover`] = Number(current.l < low && current.c > low)
      features[`volumeVsPrior${period}`] = current.v / (avg(before.map(row => row.v)) || 1)
    }
    const end = 555 + Math.floor((observedMinute + 1 - 555) / period) * period
    const bars = today.filter(row => row.minute >= end - period && row.minute < end)
    if (bars.length === period) {
      const high = Math.max(...bars.map(row => row.h)), low = Math.min(...bars.map(row => row.l))
      features[`completed${period}mReturn`] = pct(bars.at(-1).c, bars[0].o)
      features[`completed${period}mCloseLocation`] = high > low ? 100 * (bars.at(-1).c - low) / (high - low) : 50
    }
  }
  return features
}

function directionalFeatures(base, sourceSide) {
  // Positive values mean movement in the original ranking direction. Negative
  // values mean the opening move is already reversing.
  const direction = sourceSide === 'buy' ? 1 : -1
  const directionalNames = [
    'openReturn', 'last1Return', 'last3Return', 'last5Return', 'windowMaxDown', 'bounceFromLow', 'peakToClose',
    'priceVwap', 'priceEma5', 'priceEma10', 'priceEma20', 'priceEma40', 'ema3_8Gap', 'ema5_10Gap', 'ema10_20Gap',
    'ema20_40Gap', 'ema5Slope3', 'ema10Slope3', 'ema20Slope5', 'ema40Slope5', 'gapFromPriorClose', 'relativeWindowReturn',
    'relativeOpenReturn', 'priorDayCloseToOpen', 'priorDayTail20Return', 'priorDayTail60Return', 'prior2SessionReturn',
    'preSessionEma20_40Gap', 'preSessionEma20Slope20', 'bar3Return', 'bar5Return', 'completed3mReturn', 'completed5mReturn',
    'completed10mReturn', 'completed15mReturn',
  ]
  const out = { ...base }
  for (const name of directionalNames) if (Number.isFinite(base[name])) out[`dir_${name}`] = direction * base[name]
  return out
}

const depthCache = new Map()
async function depthSnapshots(date, symbol, tradeSide) {
  const key = `${date}|${symbol}|${tradeSide}`
  if (depthCache.has(key)) return depthCache.get(key)
  const file = path.join(ROOT, 'db', 'cash-depth', date, symbol, `${symbol}.jsonl`)
  if (!useDepth || !fs.existsSync(file)) { const empty = new Map(); depthCache.set(key, empty); return empty }
  const state = {}, samples = []
  let previous = null
  const endAll = Date.parse(`${date}T09:40:00+05:30`)
  const input = fs.createReadStream(file, { encoding: 'utf8' }), lines = readline.createInterface({ input, crlfDelay: Infinity })
  try {
    for await (const line of lines) {
      let event
      try { event = JSON.parse(line) } catch { continue }
      const at = Date.parse(event.receivedAt)
      if (!Number.isFinite(at)) continue
      if (at >= endAll) break
      if (event.kind === 'checkpoint' || event.book) {
        for (const field of Object.keys(state)) delete state[field]
        Object.assign(state, event.data)
      } else if (event.kind === 'update') Object.assign(state, event.data)
      else continue
      let bid = 0, ask = 0, topBid = 0, topAsk = 0, bidOrders = 0, askOrders = 0, valid = true
      for (let level = 1; level <= 5; level++) {
        const bp = +state[`bid_price${level}`], ap = +state[`ask_price${level}`], bs = +state[`bid_size${level}`], as = +state[`ask_size${level}`]
        if (![bp, ap, bs, as].every(Number.isFinite) || bp <= 0 || ap <= bp || bs < 0 || as < 0) { valid = false; break }
        bid += bs; ask += as; bidOrders += +state[`bid_order${level}`] || 0; askOrders += +state[`ask_order${level}`] || 0
        if (level <= 2) { topBid += bs; topAsk += as }
      }
      if (!valid) continue
      const bp = +state.bid_price1, ap = +state.ask_price1, bs = +state.bid_size1, as = +state.ask_size1, mid = (bp + ap) / 2
      const cumulativeVolume = +event.marketContext?.cumulativeVolume, price = +event.marketContext?.price
      let ofi = 0, traded = 0, signed = 0, quoteDown = 0
      if (previous) {
        const bidFlow = bp > previous.bp ? bs : bp === previous.bp ? bs - previous.bs : -previous.bs
        const askFlow = ap < previous.ap ? as : ap === previous.ap ? as - previous.as : -previous.as
        ofi = (bidFlow - askFlow) / ((bs + as + previous.bs + previous.as) / 2 || 1)
        traded = Number.isFinite(cumulativeVolume) && cumulativeVolume >= previous.cumulativeVolume ? cumulativeVolume - previous.cumulativeVolume : 0
        signed = traded * Math.sign(price - previous.price || 0)
        quoteDown = (bp < previous.bp ? 1 : 0) + (ap < previous.ap ? 1 : 0)
      }
      samples.push({ at, mid, full: (bid - ask) / (bid + ask || 1), top2: (topBid - topAsk) / (topBid + topAsk || 1), orders: (bidOrders - askOrders) / (bidOrders + askOrders || 1), spread: 10000 * (ap - bp) / mid, ofi, traded, signed, quoteDown })
      previous = { bp, ap, bs, as, cumulativeVolume, price }
    }
  } finally { lines.close(); input.destroy() }
  const snapshots = new Map(), tradeDirection = tradeSide === 'buy' ? 1 : -1
  for (let observedMinute = SIGNAL_FIRST_BAR; observedMinute <= SIGNAL_LAST_BAR; observedMinute++) {
    const startMinute = Math.max(555, observedMinute - 4)
    const start = Date.parse(`${date}T${clock(startMinute)}:00+05:30`), end = Date.parse(`${date}T${clock(observedMinute + 1)}:00+05:30`)
    const rows = samples.filter(sample => sample.at >= start && sample.at < end)
    if (rows.length < 2) continue
    const mean = field => avg(rows.map(row => row[field])), traded = rows.reduce((sum, row) => sum + row.traded, 0)
    const half = Math.max(1, Math.floor(rows.length / 2)), early = rows.slice(0, half), late = rows.slice(half)
    const rawFeatures = {
      depthSamples: rows.length, depthMidReturn: pct(rows.at(-1).mid, rows[0].mid), depthFull: mean('full'), depthTop2: mean('top2'), depthOrders: mean('orders'),
      depthAskDominantShare: 100 * rows.filter(row => row.full < 0).length / rows.length,
      depthOfi: rows.reduce((sum, row) => sum + row.ofi, 0), depthDelta: traded ? rows.reduce((sum, row) => sum + row.signed, 0) / traded : 0,
      depthSpread: mean('spread'), depthImbalanceChange: rows.at(-1).full - rows[0].full,
      depthLateVsEarlyImbalance: avg(late.map(row => row.full)) - avg(early.map(row => row.full)),
      depthQuoteDownShare: 50 * rows.reduce((sum, row) => sum + row.quoteDown, 0) / rows.length,
    }
    const directional = {}
    for (const name of ['depthMidReturn', 'depthFull', 'depthTop2', 'depthOrders', 'depthOfi', 'depthDelta', 'depthImbalanceChange', 'depthLateVsEarlyImbalance']) directional[`trade_${name}`] = tradeDirection * rawFeatures[name]
    directional.tradeDepthDominantShare = tradeSide === 'buy' ? 100 - rawFeatures.depthAskDominantShare : rawFeatures.depthAskDominantShare
    directional.tradeDepthQuoteMoveShare = tradeSide === 'buy' ? 100 - rawFeatures.depthQuoteDownShare : rawFeatures.depthQuoteDownShare
    snapshots.set(observedMinute, { ...rawFeatures, ...directional })
  }
  depthCache.set(key, snapshots)
  return snapshots
}

const dataset = []
console.log(`Building reversal snapshots from ${rankingGroups.reduce((sum, group) => sum + group.ranking.length, 0)} ranked stock-days...`)
for (const date of allDates) {
  const nifty = niftyFor(date)
  const dateGroups = rankingGroups.filter(group => group.date === date)
  let built = 0
  for (const rankingGroup of dateGroups) {
    const tradeSide = rankingGroup.side === 'sell' ? 'buy' : 'sell'
    for (const ranked of rankingGroup.ranking) {
      const stock = session(ranked.symbol, date)
      if (!stock || !nifty) continue
      const day = stock.filter(row => row.date === date), events = [], depthByMinute = await depthSnapshots(date, ranked.symbol, tradeSide)
      for (let observedMinute = SIGNAL_FIRST_BAR; observedMinute <= SIGNAL_LAST_BAR; observedMinute++) {
        const row = featureRow(date, ranked.symbol, stock, nifty, observedMinute)
        const outcome = reversalOutcome(day, observedMinute, tradeSide)
        if (!row || !outcome) continue
        const rankingFeatures = {
          rank: ranked.rank, pviMovePct: ranked.pviMovePct, nviMovePct: ranked.nviMovePct, averageMovePct: ranked.averageMovePct,
          pviNviMoveDifference: Math.abs(ranked.pviMovePct - ranked.nviMovePct),
        }
        const features = directionalFeatures({ ...row.features, ...extraFeatures(stock, date, observedMinute), ...rankingFeatures, ...(depthByMinute.get(observedMinute) ?? {}) }, rankingGroup.side)
        events.push({ observedMinute, features: Object.fromEntries(Object.entries(features).filter(([, value]) => Number.isFinite(value))), ...outcome })
      }
      if (events.length) {
        dataset.push({ date, sourceSide: rankingGroup.side, tradeSide, symbol: ranked.symbol, rank: ranked.rank, events })
        built++
      }
    }
  }
  console.log(`${date}: ${built} ranked stock-days with causal snapshots`)
}

const firstBit = word => 31 - Math.clz32((word & -word) >>> 0)
const predicateMask = (groups, predicate) => {
  const mask = new Uint32Array(groups.length)
  groups.forEach((group, groupIndex) => group.events.forEach((event, eventIndex) => {
    const value = event.features[predicate.feature]
    if (Number.isFinite(value) && (predicate.op === 'lt' ? value < predicate.threshold : value > predicate.threshold)) mask[groupIndex] |= 1 << eventIndex
  }))
  return mask
}
const combineMask = (left, right, op = 'and') => {
  const mask = new Uint32Array(left.length)
  for (let i = 0; i < left.length; i++) mask[i] = op === 'and' ? left[i] & right[i] : left[i] | right[i]
  return mask
}
function maskStats(groups, mask, indices) {
  let signals = 0, targets = 0
  for (const index of indices) {
    if (!mask[index]) continue
    signals++
    if (groups[index].events[firstBit(mask[index])].targetHit) targets++
  }
  return { signals, targets, misses: signals - targets, precision: signals ? targets / signals : 0 }
}
function candidateQuality(candidate) {
  return candidate.stats.targets * 20 - candidate.stats.misses * 45 + candidate.stats.precision * 5 - candidate.rules.length * 0.05
}

function fit(groups, trainIndices, validationIndices = null) {
  const featureNames = [...new Set(trainIndices.flatMap(index => groups[index].events.flatMap(event => Object.keys(event.features))))]
    .filter(name => !['return0916to0920'].includes(name))
  const atoms = []
  for (const feature of featureNames) {
    const values = trainIndices.flatMap(index => groups[index].events.map(event => event.features[feature])).filter(Number.isFinite).sort((a, b) => a - b)
    if (values.length < 4) continue
    const thresholds = new Set()
    for (let q = 1; q <= 32; q++) {
      const i = Math.min(values.length - 2, Math.floor(q * (values.length - 1) / 33))
      thresholds.add((values[i] + values[i + 1]) / 2)
    }
    for (const threshold of thresholds) for (const op of ['lt', 'gt']) {
      const rules = [{ feature, op, threshold: round(threshold, 8) }]
      const mask = predicateMask(groups, rules[0]), stats = maskStats(groups, mask, trainIndices)
      if (stats.targets) atoms.push({ rules, mask, stats })
    }
  }
  atoms.sort((a, b) => candidateQuality(b) - candidateQuality(a) || b.stats.targets - a.stats.targets)
  const beam = []
  const seenMasks = new Set()
  for (const atom of atoms) {
    const key = Array.from(atom.mask).join(',')
    if (seenMasks.has(key)) continue
    seenMasks.add(key); beam.push(atom)
    if (beam.length >= 420) break
  }
  const candidates = [...beam]
  for (let i = 0; i < beam.length; i++) for (let j = i + 1; j < beam.length; j++) {
    if (beam[i].rules[0].feature === beam[j].rules[0].feature) continue
    const mask = combineMask(beam[i].mask, beam[j].mask), stats = maskStats(groups, mask, trainIndices)
    if (!stats.targets) continue
    candidates.push({ rules: [...beam[i].rules, ...beam[j].rules], mask, stats })
  }
  if (validationIndices) {
    const validated = candidates.map(candidate => ({ ...candidate, validationStats: maskStats(groups, candidate.mask, validationIndices) }))
      .filter(candidate => candidate.stats.signals >= 3 && candidate.stats.precision >= 0.95 && candidate.validationStats.signals >= 2 && candidate.validationStats.precision >= minimumPrecision)
      .sort((a, b) => b.validationStats.targets - a.validationStats.targets || b.validationStats.precision - a.validationStats.precision || b.stats.targets - a.stats.targets || a.rules.length - b.rules.length)
    return { featureCount: featureNames.length, atomCount: atoms.length, model: validated.length ? [validated[0]] : [], metMinimum: Boolean(validated.length), validationStats: validated[0]?.validationStats ?? null }
  }
  const eligible = candidates.filter(candidate => candidate.stats.signals >= minimumSignals && candidate.stats.precision >= minimumPrecision)
    .sort((a, b) => b.stats.targets - a.stats.targets || b.stats.precision - a.stats.precision || a.rules.length - b.rules.length)
  if (!eligible.length) {
    const fallback = candidates.filter(candidate => candidate.stats.signals >= minimumSignals)
      .sort((a, b) => b.stats.precision - a.stats.precision || b.stats.targets - a.stats.targets)[0]
    return { featureCount: featureNames.length, atomCount: atoms.length, model: fallback ? [fallback] : [], metMinimum: false }
  }
  // Greedily union clean, high-precision branches while preserving the requested
  // aggregate precision. First-match timing is recalculated after every union.
  let unionMask = new Uint32Array(groups.length), unionStats = { signals: 0, targets: 0, misses: 0, precision: 0 }, selected = []
  for (;;) {
    let best = null
    for (const candidate of eligible) {
      if (selected.includes(candidate)) continue
      const mask = combineMask(unionMask, candidate.mask, 'or'), stats = maskStats(groups, mask, trainIndices)
      if (stats.precision < minimumPrecision || stats.targets <= unionStats.targets) continue
      if (!best || stats.targets > best.stats.targets || (stats.targets === best.stats.targets && stats.misses < best.stats.misses)) best = { candidate, mask, stats }
    }
    if (!best || selected.length >= 4) break
    selected.push(best.candidate); unionMask = best.mask; unionStats = best.stats
  }
  return { featureCount: featureNames.length, atomCount: atoms.length, model: selected, metMinimum: unionStats.precision >= minimumPrecision }
}

function fitPriceActionPairs(groups, trainIndices, tradeSide) {
  const pairs = tradeSide === 'sell' ? [
    [['windowRange', 'gt'], ['windowMaxDown', 'lt']],
    [['priceVwap', 'lt'], ['ema5Slope3', 'lt']],
    [['completed5mReturn', 'lt'], ['completed5mCloseLocation', 'lt']],
    [['last3Return', 'lt'], ['closeLocation', 'lt']],
    [['breakPrior5Low', 'lt'], ['ema10Slope3', 'lt']],
  ] : [
    [['windowRange', 'gt'], ['bounceFromLow', 'gt']],
    [['priceVwap', 'gt'], ['ema5Slope3', 'gt']],
    [['completed5mReturn', 'gt'], ['completed5mCloseLocation', 'gt']],
    [['last3Return', 'gt'], ['closeLocation', 'gt']],
    [['breakPrior5High', 'gt'], ['ema10Slope3', 'gt']],
  ]
  const candidates = []
  for (const pair of pairs) {
    const masks = pair.map(([feature, op]) => {
      const values = trainIndices.flatMap(index => groups[index].events.map(event => event.features[feature])).filter(Number.isFinite).sort((a, b) => a - b)
      if (values.length < 4) return []
      const thresholds = new Set()
      for (let q = 1; q <= 40; q++) {
        const i = Math.min(values.length - 2, Math.floor(q * (values.length - 1) / 41))
        thresholds.add((values[i] + values[i + 1]) / 2)
      }
      return [...thresholds].map(threshold => {
        const rule = { feature, op, threshold: round(threshold, 8) }
        return { rule, mask: predicateMask(groups, rule) }
      })
    })
    for (const left of masks[0]) for (const right of masks[1]) {
      const mask = combineMask(left.mask, right.mask), stats = maskStats(groups, mask, trainIndices)
      if (stats.signals < 3 || stats.precision < 1) continue
      const dates = new Set(trainIndices.filter(index => mask[index]).map(index => groups[index].date))
      if (dates.size < 2) continue
      candidates.push({ rules: [left.rule, right.rule], mask, stats, trainingDates: dates.size })
    }
  }
  candidates.sort((a, b) => b.stats.targets - a.stats.targets || b.trainingDates - a.trainingDates || candidateQuality(b) - candidateQuality(a))
  return candidates[0] ?? null
}

function replay(groups, model, indices) {
  if (!model.length) return []
  const unionMask = model.reduce((mask, branch) => combineMask(mask, branch.mask, 'or'), new Uint32Array(groups.length))
  const trades = []
  for (const index of indices) {
    const eventBits = unionMask[index]
    if (!eventBits) continue
    const eventIndex = firstBit(eventBits), event = groups[index].events[eventIndex]
    const branch = model.findIndex(candidate => candidate.mask[index] & (1 << eventIndex))
    const { features, observedMinute, ...outcome } = event
    trades.push({ date: groups[index].date, sourceSide: groups[index].sourceSide, tradeSide: groups[index].tradeSide, symbol: groups[index].symbol, rank: groups[index].rank, branch: branch + 1, ...outcome })
  }
  return trades.sort((a, b) => a.date.localeCompare(b.date) || a.signalTime.localeCompare(b.signalTime) || a.symbol.localeCompare(b.symbol))
}
function summarize(trades) {
  const daily = [...new Set(trades.map(trade => trade.date))].sort().map(date => {
    const rows = trades.filter(trade => trade.date === date)
    return { date, trades: rows.length, targets: rows.filter(row => row.targetHit).length, totalReturnPct: round(rows.reduce((sum, row) => sum + row.grossReturnPct, 0)) }
  })
  return {
    tradeCount: trades.length, targetHits: trades.filter(trade => trade.targetHit).length,
    targetHitRatePct: trades.length ? round(100 * trades.filter(trade => trade.targetHit).length / trades.length) : null,
    profitableTrades: trades.filter(trade => trade.grossReturnPct > 0).length,
    winRatePct: trades.length ? round(100 * trades.filter(trade => trade.grossReturnPct > 0).length / trades.length) : null,
    averageReturnPct: trades.length ? round(avg(trades.map(trade => trade.grossReturnPct))) : null,
    totalReturnPct: round(trades.reduce((sum, trade) => sum + trade.grossReturnPct, 0)),
    maximumAdverseExcursionPct: trades.length ? round(Math.max(...trades.map(trade => trade.maePct))) : null,
    worstDay: daily.length ? [...daily].sort((a, b) => a.totalReturnPct - b.totalReturnPct)[0] : null, daily,
  }
}

if (frozenModelFile) {
  const frozen = JSON.parse(fs.readFileSync(frozenModelFile, 'utf8'))
  const frozenStudies = [], frozenTrades = []
  for (const tradeSide of ['buy', 'sell']) {
    const groups = dataset.filter(group => group.tradeSide === tradeSide), indices = groups.map((_, index) => index)
    const rules = frozen.studies?.find(study => study.tradeSide === tradeSide)?.finalFit?.model
    if (!Array.isArray(rules)) fail(`Frozen model has no finalFit.model for ${tradeSide}`)
    const model = rules.map(branchRules => {
      let mask = null
      for (const rule of branchRules) {
        const current = predicateMask(groups, rule)
        mask = mask ? combineMask(mask, current) : current
      }
      return { rules: branchRules, mask: mask ?? new Uint32Array(groups.length), stats: {} }
    })
    const trades = replay(groups, model, indices)
    frozenTrades.push(...trades)
    frozenStudies.push({ tradeSide, sourceSide: tradeSide === 'buy' ? 'sell' : 'buy', model: rules, summary: summarize(trades), trades })
  }
  frozenTrades.sort((a, b) => a.date.localeCompare(b.date) || a.signalTime.localeCompare(b.signalTime) || a.symbol.localeCompare(b.symbol))
  const frozenResult = {
    generatedAt: new Date().toISOString(), source: sourceFile, frozenModel: frozenModelFile,
    method: 'Frozen rule replay only; no thresholds or branches were fitted on this source period.',
    dataset: { rankedStockDays: dataset.length, dates: allDates, marketDepth: useDepth }, studies: frozenStudies, combinedSummary: summarize(frozenTrades),
  }
  const sourceStem = path.basename(sourceFile, '.json'), modelStem = path.basename(frozenModelFile, '.json')
  const stem = `${sourceStem}-frozen-reversal-replay-${modelStem}`
  const jsonFile = uniquePath('reports', stem, 'json'), mdFile = uniquePath('reports', stem, 'md'), csvFile = uniquePath('csv', stem, 'csv')
  fs.mkdirSync(path.dirname(jsonFile), { recursive: true }); fs.mkdirSync(path.dirname(csvFile), { recursive: true })
  fs.writeFileSync(jsonFile, `${JSON.stringify(frozenResult, null, 2)}\n`, { flag: 'wx' })
  const headers = ['date', 'sourceSide', 'tradeSide', 'symbol', 'rank', 'signalTime', 'entryTime', 'branch', 'exitTime', 'exitReason', 'targetHit', 'grossReturnPct', 'maePct', 'mfePct']
  fs.writeFileSync(csvFile, `${headers.join(',')}\n${frozenTrades.map(trade => headers.map(key => csvCell(trade[key])).join(',')).join('\n')}\n`, { flag: 'wx' })
  const table = ['| Date | Ranked side | Reversal | Stock | Signal | Target | Return |', '|---|---|---|---|---|---|---:|', ...frozenTrades.map(trade => `| ${trade.date} | ${trade.sourceSide.toUpperCase()} | ${trade.tradeSide.toUpperCase()} | ${trade.symbol} | ${trade.signalTime} | ${trade.targetHit ? 'YES' : 'NO'} | ${trade.grossReturnPct}% |`)].join('\n')
  fs.writeFileSync(mdFile, `# Frozen reversal replay\n\nSource: ${sourceFile}\n\nModel: ${frozenModelFile}\n\nSummary: ${JSON.stringify(frozenResult.combinedSummary)}\n\n${table}\n\nNo fitting was performed on the source period.\n`, { flag: 'wx' })
  console.log(JSON.stringify({ json: jsonFile, md: mdFile, csv: csvFile, combinedSummary: frozenResult.combinedSummary, studies: frozenStudies.map(study => ({ tradeSide: study.tradeSide, summary: study.summary })) }, null, 2))
  process.exit(0)
}

const studies = []
for (const tradeSide of ['buy', 'sell']) {
  const groups = dataset.filter(group => group.tradeSide === tradeSide)
  const allIndices = groups.map((_, index) => index)
  const trainIndices = allIndices.filter(index => groups[index].date < splitDate)
  const testIndices = allIndices.filter(index => groups[index].date >= splitDate)
  const discoveryIndices = allIndices.filter(index => groups[index].date < validationDate)
  const validationIndices = allIndices.filter(index => groups[index].date >= validationDate && groups[index].date < splitDate)
  console.log(`Searching ${tradeSide.toUpperCase()} reversal rules: ${groups.length} stock-days, split ${splitDate}...`)
  const priceActionFit = fitPriceActionPairs(groups, trainIndices, tradeSide)
  const priceActionTrainTrades = replay(groups, priceActionFit ? [priceActionFit] : [], trainIndices)
  const priceActionTestTrades = replay(groups, priceActionFit ? [priceActionFit] : [], testIndices)
  const strictFit = fit(groups, discoveryIndices, validationIndices)
  const strictDiscoveryTrades = replay(groups, strictFit.model, discoveryIndices)
  const strictValidationTrades = replay(groups, strictFit.model, validationIndices)
  const strictTestTrades = replay(groups, strictFit.model, testIndices)
  const splitFit = fit(groups, trainIndices)
  const splitTrainTrades = replay(groups, splitFit.model, trainIndices), splitTestTrades = replay(groups, splitFit.model, testIndices)
  const finalFit = fit(groups, allIndices), finalTrades = replay(groups, finalFit.model, allIndices)
  studies.push({
    tradeSide, sourceSide: tradeSide === 'buy' ? 'sell' : 'buy', featureCount: finalFit.featureCount,
    priceActionChronological: { trainBefore: splitDate, model: priceActionFit ? [priceActionFit.rules] : [], trainSummary: summarize(priceActionTrainTrades), trainTrades: priceActionTrainTrades, testFrom: splitDate, testSummary: summarize(priceActionTestTrades), testTrades: priceActionTestTrades },
    strictChronological: { discoveryBefore: validationDate, validationFrom: validationDate, testFrom: splitDate, model: strictFit.model.map(branch => branch.rules), discoverySummary: summarize(strictDiscoveryTrades), validationSummary: summarize(strictValidationTrades), testSummary: summarize(strictTestTrades), testTrades: strictTestTrades },
    chronologicalSplit: { trainBefore: splitDate, testFrom: splitDate, model: splitFit.model.map(branch => branch.rules), trainSummary: summarize(splitTrainTrades), testSummary: summarize(splitTestTrades), testTrades: splitTestTrades },
    finalFit: { metMinimum: finalFit.metMinimum, model: finalFit.model.map(branch => branch.rules), summary: summarize(finalTrades), trades: finalTrades },
  })
}

const finalTrades = studies.flatMap(study => study.finalFit.trades).sort((a, b) => a.date.localeCompare(b.date) || a.signalTime.localeCompare(b.signalTime) || a.symbol.localeCompare(b.symbol))
const splitTestTrades = studies.flatMap(study => study.chronologicalSplit.testTrades).sort((a, b) => a.date.localeCompare(b.date) || a.signalTime.localeCompare(b.signalTime) || a.symbol.localeCompare(b.symbol))
const strictTestTrades = studies.flatMap(study => study.strictChronological.testTrades).sort((a, b) => a.date.localeCompare(b.date) || a.signalTime.localeCompare(b.signalTime) || a.symbol.localeCompare(b.symbol))
const priceActionTestTrades = studies.flatMap(study => study.priceActionChronological.testTrades).sort((a, b) => a.date.localeCompare(b.date) || a.signalTime.localeCompare(b.signalTime) || a.symbol.localeCompare(b.symbol))
const result = {
  generatedAt: new Date().toISOString(), source: sourceFile,
  method: {
    reversal: 'SELL-ranked stocks are evaluated for BUY reversals; BUY-ranked stocks are evaluated for SELL reversals.',
    window: 'Signal available 09:17 through 09:40 IST, using only completed candles through the prior minute.',
    entry: 'Next completed one-minute candle close, one minute after signal availability.',
    target: `${targetPct}% favorable move before the direction-specific opposite EMA20/EMA40 cross; otherwise exit at the next completed candle close after the cross or session close.`,
    history: 'Exactly two prior sessions plus current candles through decision; ranking values were fixed at 09:16.',
    fitting: `Up to four OR branches, each with one or two numeric conditions; aggregate fitted target-hit rate constrained to at least ${round(minimumPrecision * 100)}% when feasible.`,
    validation: `Strict chronology: discover before ${validationDate}, choose one rule on ${validationDate} through the session before ${splitDate}, then freeze from ${splitDate}. A second diagnostic fits all dates before ${splitDate}. Final rules are refit on the whole month and are in-sample.`,
  },
  dataset: { rankedStockDays: dataset.length, dates: allDates, validationDate, splitDate, marketDepth: useDepth }, studies,
  combinedFinalSummary: summarize(finalTrades), combinedChronologicalTestSummary: summarize(splitTestTrades), combinedStrictChronologicalTestSummary: summarize(strictTestTrades), combinedPriceActionChronologicalTestSummary: summarize(priceActionTestTrades),
}

const sourceStem = path.basename(sourceFile, '.json')
const stem = `${sourceStem}-reversal-${String(targetPct).replace('.', 'p')}pct-rule-study`
const jsonFile = uniquePath('reports', stem, 'json'), mdFile = uniquePath('reports', stem, 'md'), csvFile = uniquePath('csv', stem, 'csv')
fs.mkdirSync(path.dirname(jsonFile), { recursive: true }); fs.mkdirSync(path.dirname(csvFile), { recursive: true })
fs.writeFileSync(jsonFile, `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx' })
const headers = ['date', 'sourceSide', 'tradeSide', 'symbol', 'rank', 'signalTime', 'entryTime', 'branch', 'exitTime', 'exitReason', 'targetHit', 'grossReturnPct', 'maePct', 'mfePct']
fs.writeFileSync(csvFile, `${headers.join(',')}\n${finalTrades.map(trade => headers.map(key => csvCell(trade[key])).join(',')).join('\n')}\n`, { flag: 'wx' })
const ruleLines = study => study.finalFit.model.map((branch, index) => `${index + 1}. ${branch.map(rule => `${rule.feature} ${rule.op === 'lt' ? '<' : '>'} ${rule.threshold}`).join(' AND ')}`)
const table = ['| Date | Ranked side | Reversal | Stock | Signal | Entry | Branch | Target | Return | MAE |', '|---|---|---|---|---|---|---:|---|---:|---:|', ...finalTrades.map(trade => `| ${trade.date} | ${trade.sourceSide.toUpperCase()} | ${trade.tradeSide.toUpperCase()} | ${trade.symbol} | ${trade.signalTime} | ${trade.entryTime} | ${trade.branch} | ${trade.targetHit ? 'YES' : 'NO'} | ${trade.grossReturnPct}% | ${trade.maePct}% |`)].join('\n')
const md = [
  `# PVI/NVI top-10 reversal rule study: ${targetPct}% target`, '',
  `Final full-month fit: ${JSON.stringify(result.combinedFinalSummary)}`, '',
  `Fixed price-action chronological test: ${JSON.stringify(result.combinedPriceActionChronologicalTestSummary)}`, '',
  `Strict chronological test: ${JSON.stringify(result.combinedStrictChronologicalTestSummary)}`, '',
  `Chronological second-half test: ${JSON.stringify(result.combinedChronologicalTestSummary)}`, '',
  ...studies.flatMap(study => [
    `## ${study.tradeSide.toUpperCase()} reversal from ${study.sourceSide.toUpperCase()} ranking`, '',
    `Final fitted summary: ${JSON.stringify(study.finalFit.summary)}`, '',
    'Final rules (OR):', '', ...ruleLines(study), '',
    `Fixed price-action rule trained before ${splitDate}: ${study.priceActionChronological.model.length ? study.priceActionChronological.model[0].map(rule => `${rule.feature} ${rule.op === 'lt' ? '<' : '>'} ${rule.threshold}`).join(' AND ') : 'No qualifying rule.'}`, '',
    `Fixed price-action train: ${JSON.stringify(study.priceActionChronological.trainSummary)}`, '',
    `Fixed price-action frozen test: ${JSON.stringify(study.priceActionChronological.testSummary)}`, '',
    `Strict chronological rule: ${study.strictChronological.model.length ? study.strictChronological.model[0].map(rule => `${rule.feature} ${rule.op === 'lt' ? '<' : '>'} ${rule.threshold}`).join(' AND ') : 'No rule passed discovery and validation requirements.'}`, '',
    `Strict validation: ${JSON.stringify(study.strictChronological.validationSummary)}`, '',
    `Strict frozen test from ${splitDate}: ${JSON.stringify(study.strictChronological.testSummary)}`, '',
    `Chronological train before ${splitDate}: ${JSON.stringify(study.chronologicalSplit.trainSummary)}`, '',
    `Frozen chronological test from ${splitDate}: ${JSON.stringify(study.chronologicalSplit.testSummary)}`, '',
  ]),
  '## Final fitted trades', '', table, '',
  'The final rules were selected after observing the same October outcomes shown here. Their fitted target-hit rate is descriptive, while the chronological second-half section is the more relevant validation result.', '',
  `JSON: ${jsonFile}`, `CSV: ${csvFile}`,
].join('\n') + '\n'
fs.writeFileSync(mdFile, md, { flag: 'wx' })
console.log(JSON.stringify({ json: jsonFile, md: mdFile, csv: csvFile, combinedFinalSummary: result.combinedFinalSummary, combinedPriceActionChronologicalTestSummary: result.combinedPriceActionChronologicalTestSummary, combinedStrictChronologicalTestSummary: result.combinedStrictChronologicalTestSummary, combinedChronologicalTestSummary: result.combinedChronologicalTestSummary, studies: studies.map(study => ({ tradeSide: study.tradeSide, priceActionModel: study.priceActionChronological.model, priceActionTrain: study.priceActionChronological.trainSummary, priceActionTest: study.priceActionChronological.testSummary, strictModel: study.strictChronological.model, strictValidation: study.strictChronological.validationSummary, strictTest: study.strictChronological.testSummary, finalModel: study.finalFit.model, finalSummary: study.finalFit.summary, chronologicalTest: study.chronologicalSplit.testSummary })) }, null, 2))

