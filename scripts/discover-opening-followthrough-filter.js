import fs from 'node:fs'
import path from 'node:path'
import { loadCandles, indicators, aggregate } from './research-ema-coverage.js'

const ROOT = process.cwd(), MINUTE = 60_000
const REPORTS = path.join(ROOT, 'reports')
const dates = ['2026-10-14', '2026-10-15', '2026-10-16']
const rejected = new Set([
  '2026-10-14|BSE', '2026-10-14|TATAELXSI',
  '2026-10-15|PGEL', '2026-10-15|PERSISTENT', '2026-10-15|CAMS', '2026-10-15|LICI',
])
const round = (x, p = 5) => Number.isFinite(x) ? +x.toFixed(p) : null
const mean = xs => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN
const pct = (a, b) => b ? 100 * (a / b - 1) : NaN

function jsonl(file) {
  if (!fs.existsSync(file)) return []
  return fs.readFileSync(file, 'utf8').split(/\r?\n/).flatMap(line => {
    try { return line ? [JSON.parse(line)] : [] } catch { return [] }
  })
}

function frameShape(rows, prefix) {
  if (!rows.length) return {}
  const last = rows.at(-1), first = rows[0]
  const ranges = rows.map(r => r.h - r.l), bodies = rows.map(r => Math.abs(r.c - r.o))
  const path = rows.reduce((sum, r, i) => sum + Math.abs(Math.log(r.c / (i ? rows[i - 1].c : r.o))), 0)
  let peak = first.o, maxDrawdown = 0
  for (const r of rows) { peak = Math.max(peak, r.h); maxDrawdown = Math.min(maxDrawdown, pct(r.l, peak)) }
  return {
    [`${prefix}return`]: pct(last.c, first.o),
    [`${prefix}closeLocation`]: last.h > last.l ? 100 * (last.c - last.l) / (last.h - last.l) : 50,
    [`${prefix}greenShare`]: 100 * rows.filter(r => r.c > r.o).length / rows.length,
    [`${prefix}higherCloseShare`]: rows.length > 1 ? 100 * rows.slice(1).filter((r, i) => r.c > rows[i].c).length / (rows.length - 1) : 0,
    [`${prefix}efficiency`]: path ? 100 * Math.abs(Math.log(last.c / first.o)) / path : 0,
    [`${prefix}maxDrawdown`]: maxDrawdown,
    [`${prefix}peakToClose`]: pct(last.c, Math.max(...rows.map(r => r.h))),
    [`${prefix}bodyRangeShare`]: ranges.reduce((a, b) => a + b, 0) ? 100 * bodies.reduce((a, b) => a + b, 0) / ranges.reduce((a, b) => a + b, 0) : 0,
    [`${prefix}lastVolumeShare`]: 100 * last.v / rows.reduce((s, r) => s + r.v, 0),
  }
}

function validBook(fields) {
  let bid = 0, ask = 0, topBid = 0, topAsk = 0, bidOrders = 0, askOrders = 0
  for (let i = 1; i <= 5; i++) {
    const bp = +fields[`bid_price${i}`], ap = +fields[`ask_price${i}`]
    const bs = +fields[`bid_size${i}`], as = +fields[`ask_size${i}`]
    if (![bp, ap, bs, as].every(Number.isFinite) || bp <= 0 || ap <= bp || bs < 0 || as < 0) return null
    bid += bs; ask += as; bidOrders += +fields[`bid_order${i}`] || 0; askOrders += +fields[`ask_order${i}`] || 0
    if (i <= 2) { topBid += bs; topAsk += as }
  }
  const bp = +fields.bid_price1, ap = +fields.ask_price1
  return { bp, ap, bs: +fields.bid_size1, as: +fields.ask_size1, mid: (bp + ap) / 2,
    full: (bid - ask) / (bid + ask || 1), top2: (topBid - topAsk) / (topBid + topAsk || 1),
    orders: (bidOrders - askOrders) / (bidOrders + askOrders || 1), spread: 10000 * (ap - bp) / ((ap + bp) / 2) }
}

function depthFeatures(date, symbol) {
  const start = Date.parse(`${date}T09:15:00+05:30`), end = Date.parse(`${date}T09:30:00+05:30`)
  const fields = {}, samples = []; let previous = null
  for (const event of jsonl(path.join(ROOT, 'db/cash-depth', date, symbol, `${symbol}.jsonl`))) {
    const at = Date.parse(event.receivedAt)
    if (!Number.isFinite(at) || at >= end) continue
    if (event.kind === 'checkpoint' || event.book) { for (const k of Object.keys(fields)) delete fields[k]; Object.assign(fields, event.data) }
    else if (event.kind === 'update') Object.assign(fields, event.data); else continue
    if (at < start) continue
    const book = validBook(fields); if (!book) continue
    const volume = +event.marketContext?.cumulativeVolume, price = +event.marketContext?.price
    let ofi = 0, signed = 0, traded = 0
    if (previous) {
      const bf = book.bp > previous.bp ? book.bs : book.bp === previous.bp ? book.bs - previous.bs : -previous.bs
      const af = book.ap < previous.ap ? book.as : book.ap === previous.ap ? book.as - previous.as : -previous.as
      ofi = (bf - af) / ((book.bs + book.as + previous.bs + previous.as) / 2 || 1)
      traded = Number.isFinite(volume) && volume >= previous.volume ? volume - previous.volume : 0
      signed = traded * Math.sign(price - previous.price || 0)
    }
    samples.push({ at, ofi, signed, traded, ...book })
    previous = { ...book, volume, price }
  }
  if (!samples.length) return {}
  const window = (name, from, to) => {
    const xs = samples.filter(x => x.at >= start + from * MINUTE && x.at < start + to * MINUTE)
    if (!xs.length) return {}
    const traded = xs.reduce((s, x) => s + x.traded, 0)
    return {
      [`${name}full`]: mean(xs.map(x => x.full)), [`${name}top2`]: mean(xs.map(x => x.top2)),
      [`${name}orders`]: mean(xs.map(x => x.orders)), [`${name}spread`]: mean(xs.map(x => x.spread)),
      [`${name}ofi`]: mean(xs.map(x => x.ofi)), [`${name}delta`]: traded ? xs.reduce((s, x) => s + x.signed, 0) / traded : 0,
      [`${name}midReturn`]: pct(xs.at(-1).mid, xs[0].mid),
      [`${name}imbalanceChange`]: xs.at(-1).full - xs[0].full,
      [`${name}bidQuoteUpPct`]: xs.length > 1 ? 100 * xs.slice(1).filter((x, i) => x.bp > xs[i].bp).length / (xs.length - 1) : 0,
      [`${name}askQuoteUpPct`]: xs.length > 1 ? 100 * xs.slice(1).filter((x, i) => x.ap > xs[i].ap).length / (xs.length - 1) : 0,
    }
  }
  return { ...window('dAll_', 0, 15), ...window('dEarly_', 0, 5), ...window('dMiddle_', 5, 10), ...window('dLate_', 10, 15) }
}

function addIndicators(out, prefix, rows) {
  if (!rows.length) return
  const f = indicators(rows).at(-1)?.f ?? {}
  for (const [key, value] of Object.entries(f)) if (Number.isFinite(value)) out[`${prefix}${key}`] = value
}

const nifty = loadCandles('NIFTY50'), rows = []
for (const date of dates) {
  const screen = JSON.parse(fs.readFileSync(path.join(REPORTS, `${date}-0930-consolidated-screen-replay.json`), 'utf8'))
  for (const selected of screen.eligible) {
    const raw = loadCandles(selected.symbol).get(date)?.filter(r => r.t < Date.parse(`${date}T09:30:00+05:30`)) ?? []
    const nr = nifty.get(date)?.filter(r => r.t < Date.parse(`${date}T09:30:00+05:30`)) ?? []
    const features = { volumeChangePct: selected.volumeChangePct, angleChangeDeg: selected.angleChangeDeg,
      bidDominantMinutes: selected.bidDominantMinutes, quoteMidMovePct: selected.quoteMidMovePct,
      meanSpreadBps: selected.meanSpreadBps, previousCloseMovePct: selected.movePct,
      top2PositiveStepSharePct: selected.top2PositiveStepSharePct, largestBodyPct: selected.largestBodyPct,
      ...frameShape(raw, 'm1_'), ...depthFeatures(date, selected.symbol) }
    addIndicators(features, 'm1i_', raw)
    addIndicators(features, 'nifty1i_', nr)
    for (const frame of [3, 5, 10, 15]) {
      const bars = aggregate(raw, frame), nbars = aggregate(nr, frame)
      Object.assign(features, frameShape(bars, `m${frame}_`))
      addIndicators(features, `m${frame}i_`, bars)
      addIndicators(features, `nifty${frame}i_`, nbars)
    }
    for (const key of Object.keys(features)) if (!Number.isFinite(features[key])) delete features[key]
    rows.push({ date, symbol: selected.symbol, rejected: rejected.has(`${date}|${selected.symbol}`), features })
  }
}

const featureNames = [...new Set(rows.flatMap(r => Object.keys(r.features)))]
const predicates = []
for (const feature of featureNames) {
  const values = [...new Set(rows.map(r => r.features[feature]).filter(Number.isFinite))].sort((a, b) => a - b)
  if (values.length < rows.length * 0.8) continue
  for (let i = 0; i < values.length - 1; i++) {
    const threshold = (values[i] + values[i + 1]) / 2
    for (const direction of ['lt', 'gt']) {
      const matches = rows.filter(r => direction === 'lt' ? r.features[feature] < threshold : r.features[feature] > threshold)
      const bad = matches.filter(r => r.rejected).length, good = matches.length - bad
      if (bad) predicates.push({ feature, direction, threshold, bad, good,
        matches: matches.map(r => `${r.date}|${r.symbol}`) })
    }
  }
}
const cleanSingles = predicates.filter(p => p.good === 0).sort((a, b) => b.bad - a.bad)
const compact = cleanSingles.filter((p, i, all) => !all.slice(0, i).some(q => q.feature === p.feature && q.direction === p.direction && q.bad === p.bad)).slice(0, 50)
let best = []
for (let i = 0; i < compact.length; i++) for (let j = i + 1; j < compact.length; j++) {
  const covered = new Set([...compact[i].matches, ...compact[j].matches])
  best.push({ rules: [compact[i], compact[j]], bad: covered.size, covered: [...covered] })
}
best.sort((a, b) => b.bad - a.bad)
const output = { methodology: 'All features use candles and depth received by 09:30 IST. Labels are the six user-marked stocks. Threshold search excludes symbol/date/time identity and later outcome fields. This is in-sample discovery over 28 selected stocks, not validation.',
  counts: { rows: rows.length, rejected: rows.filter(r => r.rejected).length, retained: rows.filter(r => !r.rejected).length, features: featureNames.length },
  cleanSingleRules: compact.slice(0, 30), bestCleanTwoRuleUnions: best.slice(0, 20), rows }
let n = 1, file
do { file = path.join(REPORTS, `2026-10-14-to-16-0930-multiframe-depth-filter-discovery${n === 1 ? '' : `-${n}`}.json`); n++ } while (fs.existsSync(file))
fs.writeFileSync(file, JSON.stringify(output, null, 2) + '\n', { flag: 'wx' })
console.log(JSON.stringify({ file, counts: output.counts, cleanSingles: output.cleanSingleRules.slice(0, 10), bestPairs: output.bestCleanTwoRuleUnions.slice(0, 5) }, null, 2))
