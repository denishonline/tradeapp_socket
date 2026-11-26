#!/usr/bin/env node
import fs from "node:fs"
import path from "node:path"
import readline from "node:readline"
import { pathToFileURL } from "node:url"

const ROOT = process.cwd(), IST = 330 * 60_000
const IS_MAIN = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
const CUTOFF_MINUTE = IS_MAIN ? Number(process.argv[2] ?? 560) : 560
if (!Number.isInteger(CUTOFF_MINUTE) || CUTOFF_MINUTE < 556 || CUTOFF_MINUTE > 580) throw new Error("Optional cutoff must be a minute from 556 (09:16) through 580 (09:40)")
const DATES = ["2026-10-26", "2026-10-27", "2026-10-28", "2026-10-29", "2026-10-30"]
const SIGNALS = {
  "2026-10-26": ["AUBANK", "SHRIRAMFIN", "BANKINDIA", "INFY", "CHOLAFIN", "ABCAPITAL", "MOTILALOFS", "BANDHANBNK", "PNB", "ADANIPOWER"],
  "2026-10-27": ["DALBHARAT", "RECLTD", "WIPRO", "KPITTECH", "CYIENT", "TATAELXSI", "SHREECEM", "ICICIGI", "BPCL", "INDUSINDBK"],
  "2026-10-28": ["PAGEIND", "WAAREEENER", "MAZDOCK", "SAIL", "PATANJALI", "DIVISLAB", "KALYANKJIL", "IRCTC", "CDSL", "ALKEM"],
  "2026-10-29": ["TITAGARH", "TRENT", "TIINDIA", "BOSCHLTD", "KPITTECH", "NATIONALUM", "MCX", "BAJAJHLDNG", "BHARATFORG", "PERSISTENT"],
  "2026-10-30": ["GODREJCP", "BLUESTARCO", "CAMS", "SUZLON", "COALINDIA", "WAAREEENER", "DALBHARAT", "RECLTD", "INOXWIND", "GMRAIRPORT"],
}
const round = (x, n = 4) => Number.isFinite(x) ? +x.toFixed(n) : null
const mean = xs => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN
const pct = (a, b) => b > 0 ? 100 * (a / b - 1) : NaN
const stamp = seconds => new Date(seconds * 1000 + IST).toISOString().slice(0, 16).replace("T", " ")
const minute = text => +text.slice(11, 13) * 60 + +text.slice(14, 16)
const unique = (dir, stem, ext) => { let i = 1, f; do { f = path.join(ROOT, dir, `${stem}${i === 1 ? "" : `-${i}`}.${ext}`); i++ } while (fs.existsSync(f)); return f }
const csvCell = v => { const s = v == null ? "" : String(v); return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s }

function load(symbol, allowedDates = null) {
  const file = path.join(ROOT, "db", "candles", `${symbol}.jsonl`), seen = new Map()
  if (!fs.existsSync(file)) return []
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    if (!line) continue
    let x; try { x = JSON.parse(line) } catch { continue }
    const s = stamp(+x.time), m = minute(s), row = { stamp: s, date: s.slice(0, 10), minute: m, o: +x.open, h: +x.high, l: +x.low, c: +x.close, v: +x.volume }
    if (allowedDates && !allowedDates.includes(row.date)) continue
    if (m < 555 || m >= 930 || ![row.o, row.h, row.l, row.c, row.v].every(Number.isFinite) || row.l <= 0 || row.v < 0) continue
    seen.set(s, row)
  }
  const rows = [...seen.values()].sort((a, b) => a.stamp.localeCompare(b.stamp))
  const periods = [3, 5, 8, 10, 20, 40, 50], values = Object.fromEntries(periods.map(n => [n, NaN]))
  let gain5 = 0, loss5 = 0, gain14 = 0, loss14 = 0
  return rows.map((row, i) => {
    for (const n of periods) values[n] = Number.isFinite(values[n]) ? values[n] + 2 / (n + 1) * (row.c - values[n]) : row.c
    if (i) {
      const delta = row.c - rows[i - 1].c, gain = Math.max(delta, 0), loss = Math.max(-delta, 0)
      if (i <= 5) { gain5 += gain; loss5 += loss; if (i === 5) { gain5 /= 5; loss5 /= 5 } } else { gain5 = (gain5 * 4 + gain) / 5; loss5 = (loss5 * 4 + loss) / 5 }
      if (i <= 14) { gain14 += gain; loss14 += loss; if (i === 14) { gain14 /= 14; loss14 /= 14 } } else { gain14 = (gain14 * 13 + gain) / 14; loss14 = (loss14 * 13 + loss) / 14 }
    }
    const rsi = (g, l) => l ? 100 - 100 / (1 + g / l) : g ? 100 : 50
    return { ...row, ema: { ...values }, rsi5: i >= 5 ? rsi(gain5, loss5) : NaN, rsi14: i >= 14 ? rsi(gain14, loss14) : NaN }
  })
}

function pviNviFeatures(all, cutoffIndex) {
  const targetDate = all[cutoffIndex].date
  const xs = all.slice(0, cutoffIndex + 1).filter(row => row.v > 0 && (row.date < targetDate || row.minute <= 556)).slice(-3)
  if (xs.length !== 3) return {}
  let pvi = 1000, nvi = 1000
  for (let i = 1; i < xs.length; i++) {
    if (xs[i].v > xs[i - 1].v) pvi *= xs[i].c / xs[i - 1].c
    else if (xs[i].v < xs[i - 1].v) nvi *= xs[i].c / xs[i - 1].c
  }
  return { pviDrop: 100 * (1 - pvi / 1000), nviDrop: 100 * (1 - nvi / 1000), pviNviAverageDrop: 50 * (2 - pvi / 1000 - nvi / 1000) }
}

function featureRow(date, symbol, stock, nifty, CUTOFF_MINUTE = 560) {
  const i = stock.findIndex(row => row.date === date && row.minute === CUTOFF_MINUTE)
  const entryIndex = stock.findIndex((row, index) => index > i && row.date === date && row.minute === CUTOFF_MINUTE + 1)
  if (i < 0 || entryIndex < 0) return null
  const day = stock.filter(row => row.date === date && row.minute <= CUTOFF_MINUTE), window = day.filter(row => row.minute >= Math.max(555, CUTOFF_MINUTE - 4))
  if (window.length < 2 || !day.some(row => row.minute === 555)) return null
  const current = stock[i], entry = stock[entryIndex], prior = stock[i - 1], back3 = stock[Math.max(0, i - 3)], back5 = stock[Math.max(0, i - 5)]
  const previousDates = [...new Set(stock.filter(row => row.date < date).map(row => row.date))].sort(), previousDate = previousDates.at(-1)
  const previousDay = stock.filter(row => row.date === previousDate), priorClose = previousDay.at(-1)?.c
  const priorLow = Math.min(...previousDay.map(row => row.l)), priorHigh = Math.max(...previousDay.map(row => row.h))
  const priorRows = stock.filter(row => row.date < date), priorTail20 = priorRows.slice(-20), priorTail60 = priorRows.slice(-60)
  const priorSessionDates = [...new Set(priorRows.map(row => row.date))].sort().slice(-2)
  const sessions = priorSessionDates.map(sessionDate => priorRows.filter(row => row.date === sessionDate))
  const dailyReturn = count => { const xs = sessions.slice(-count); return xs.length ? pct(xs.at(-1).at(-1).c, xs[0][0].o) : NaN }
  const priorRange = pct(priorHigh, priorLow)
  const high = Math.max(...window.map(row => row.h)), low = Math.min(...window.map(row => row.l)), path = window.reduce((sum, row, k) => sum + Math.abs(Math.log(row.c / (k ? window[k - 1].c : row.o))), 0)
  const totalVolume = window.reduce((sum, row) => sum + row.v, 0), redVolume = window.filter(row => row.c < row.o).reduce((sum, row) => sum + row.v, 0)
  const sessionVolume = day.reduce((sum, row) => sum + row.v, 0), vwap = sessionVolume ? day.reduce((sum, row) => sum + row.v * (row.h + row.l + row.c) / 3, 0) / sessionVolume : NaN
  const slope = (field, back) => pct(current.ema[field], stock[i - back].ema[field]) / back
  const nf = nifty.find(row => row.date === date && row.minute === CUTOFF_MINUTE), nstart = nifty.find(row => row.date === date && row.minute === Math.max(555, CUTOFF_MINUTE - 4)), nopen = nifty.find(row => row.date === date && row.minute === 555)
  const features = {
    return0916to0920: pct(current.c, window[0].o), openReturn: pct(current.c, day[0].o), last1Return: pct(current.c, prior.c), last3Return: pct(current.c, back3.c), last5Return: pct(current.c, back5.c),
    windowRange: 100 * (high - low) / window[0].o, windowMaxDown: pct(low, window[0].o), bounceFromLow: pct(current.c, low), peakToClose: pct(current.c, high),
    redShare: 100 * window.filter(row => row.c < row.o).length / window.length, lowerHighShare: 100 * window.slice(1).filter((row, k) => row.h < window[k].h).length / (window.length - 1), lowerLowShare: 100 * window.slice(1).filter((row, k) => row.l < window[k].l).length / (window.length - 1),
    closeLocation: high > low ? 100 * (current.c - low) / (high - low) : 50, efficiency: path ? 100 * Math.abs(Math.log(current.c / window[0].o)) / path : 0,
    lastVolumeShare: totalVolume ? 100 * current.v / totalVolume : 0, redVolumeShare: totalVolume ? 100 * redVolume / totalVolume : 0, lateEarlyVolumeRatio: mean(window.slice(-2).map(row => row.v)) / (mean(window.slice(0, 2).map(row => row.v)) || 1),
    priceVwap: pct(current.c, vwap), rsi5: current.rsi5 - 50, rsi14: current.rsi14 - 50,
    priceEma5: pct(current.c, current.ema[5]), priceEma10: pct(current.c, current.ema[10]), priceEma20: pct(current.c, current.ema[20]), priceEma40: pct(current.c, current.ema[40]),
    ema3_8Gap: 100 * (current.ema[3] - current.ema[8]) / current.c, ema5_10Gap: 100 * (current.ema[5] - current.ema[10]) / current.c, ema10_20Gap: 100 * (current.ema[10] - current.ema[20]) / current.c, ema20_40Gap: 100 * (current.ema[20] - current.ema[40]) / current.c,
    ema5Slope3: slope(5, 3), ema10Slope3: slope(10, 3), ema20Slope5: slope(20, 5), ema40Slope5: slope(40, 5),
    gapFromPriorClose: pct(day[0].o, priorClose), distancePriorLow: pct(current.c, priorLow), distancePriorHigh: pct(current.c, priorHigh), previousDayReturn: pct(previousDay.at(-1).c, previousDay[0].o),
    bar3Return: pct(current.c, window.slice(-3)[0].o), bar3BodyRange: 100 * (current.c - window.slice(-3)[0].o) / (Math.max(...window.slice(-3).map(row => row.h)) - Math.min(...window.slice(-3).map(row => row.l)) || 1),
    bar5Return: pct(day.find(row => row.minute === Math.min(559, CUTOFF_MINUTE))?.c, day[0].o),
    relativeWindowReturn: nf && nstart ? pct(current.c, window[0].o) - pct(nf.c, nstart.o) : NaN,
    relativeOpenReturn: nf && nopen ? pct(current.c, day[0].o) - pct(nf.c, nopen.o) : NaN,
    priorDayCloseToOpen: pct(previousDay.at(-1).c, previousDay[0].o), priorDayTail20Return: pct(priorTail20.at(-1).c, priorTail20[0].o), priorDayTail60Return: pct(priorTail60.at(-1).c, priorTail60[0].o),
    prior2SessionReturn: dailyReturn(2),
    gapVsPriorRange: priorRange ? pct(day[0].o, priorClose) / priorRange : NaN, priorRangePct: priorRange,
    preSessionEma20_40Gap: 100 * (previousDay.at(-1).ema[20] - previousDay.at(-1).ema[40]) / previousDay.at(-1).c,
    preSessionEma20Slope20: pct(previousDay.at(-1).ema[20], priorTail20[0].ema[20]) / priorTail20.length,
    distancePrior20Low: pct(current.c, Math.min(...priorTail20.map(row => row.l))), distancePrior20High: pct(current.c, Math.max(...priorTail20.map(row => row.h))),
    distancePrior60Low: pct(current.c, Math.min(...priorTail60.map(row => row.l))), distancePrior60High: pct(current.c, Math.max(...priorTail60.map(row => row.h))),
    ...pviNviFeatures(stock, i),
  }

  let cross = -1
  for (let k = entryIndex; k < stock.length && stock[k].date === date; k++) if (stock[k - 1].ema[20] <= stock[k - 1].ema[40] && stock[k].ema[20] > stock[k].ema[40]) { cross = k; break }
  const end = cross >= 0 ? cross : stock.findLastIndex(row => row.date === date), pathRows = stock.slice(entryIndex, end + 1), targetPrice = entry.o * 0.98
  const targetOffset = pathRows.findIndex(row => row.l <= targetPrice), beforeTarget = targetOffset >= 0 ? pathRows.slice(0, targetOffset + 1) : pathRows
  const mfePct = 100 * (entry.o - Math.min(...pathRows.map(row => row.l))) / entry.o
  const maeBeforeTargetPct = 100 * (Math.max(...beforeTarget.map(row => row.h)) - entry.o) / entry.o
  return { date, symbol, entryPrice: entry.o, targetHit: mfePct >= 2, straightDown: mfePct >= 2 && maeBeforeTargetPct <= 0.5, mfePct: round(mfePct), maeBeforeTargetPct: round(maeBeforeTargetPct), features: Object.fromEntries(Object.entries(features).filter(([, v]) => Number.isFinite(v)).map(([k, v]) => [k, round(v, 6)])) }
}

async function depthFeatures(date, symbol, CUTOFF_MINUTE = 560) {
  const file = path.join(ROOT, "db", "cash-depth", date, symbol, `${symbol}.jsonl`)
  if (!fs.existsSync(file)) return { depthAvailable: 0 }
  const startMinute = Math.max(555, CUTOFF_MINUTE - 4), start = Date.parse(`${date}T${String(Math.floor(startMinute / 60)).padStart(2, "0")}:${String(startMinute % 60).padStart(2, "0")}:00+05:30`), end = Date.parse(`${date}T${String(Math.floor((CUTOFF_MINUTE + 1) / 60)).padStart(2, "0")}:${String((CUTOFF_MINUTE + 1) % 60).padStart(2, "0")}:00+05:30`), state = {}, samples = []
  let previous = null
  const input = fs.createReadStream(file, { encoding: "utf8" }), lines = readline.createInterface({ input, crlfDelay: Infinity })
  try {
    for await (const line of lines) {
      let event; try { event = JSON.parse(line) } catch { continue }
      const at = Date.parse(event.receivedAt)
      if (!Number.isFinite(at)) continue
      if (at >= end) break
      if (event.kind === "checkpoint" || event.book) { for (const key of Object.keys(state)) delete state[key]; Object.assign(state, event.data) }
      else if (event.kind === "update") Object.assign(state, event.data)
      else continue
      if (at < start) continue
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
  if (samples.length < 2) return { depthAvailable: 0 }
  const traded = samples.reduce((sum, row) => sum + row.traded, 0), average = key => mean(samples.map(row => row[key]))
  const half = Math.floor(samples.length / 2), early = samples.slice(0, half), late = samples.slice(half)
  return {
    depthAvailable: 1, depthSamples: samples.length, depthMidReturn: pct(samples.at(-1).mid, samples[0].mid), depthFull: average("full"), depthTop2: average("top2"), depthOrders: average("orders"),
    depthAskDominantShare: 100 * samples.filter(row => row.full < 0).length / samples.length, depthOfi: samples.reduce((sum, row) => sum + row.ofi, 0), depthDelta: traded ? samples.reduce((sum, row) => sum + row.signed, 0) / traded : 0,
    depthSpread: average("spread"), depthImbalanceChange: samples.at(-1).full - samples[0].full, depthLateVsEarlyImbalance: mean(late.map(row => row.full)) - mean(early.map(row => row.full)), depthQuoteDownShare: 50 * samples.reduce((sum, row) => sum + row.quoteDown, 0) / samples.length,
  }
}

function metrics(selected, positive) {
  const tp = selected.filter(positive).length, fp = selected.length - tp
  return { selected: selected.length, tp, fp, precision: selected.length ? tp / selected.length : 0, recall: 0, f1: 0 }
}
function discover(train, positive = row => row.targetHit) {
  const positives = train.filter(positive).length
  const names = [...new Set(train.flatMap(row => Object.keys(row.features)))].filter(name => train.filter(row => Number.isFinite(row.features[name])).length >= train.length * 0.7)
  const predicates = []
  for (const feature of names) {
    const values = [...new Set(train.map(row => row.features[feature]).filter(Number.isFinite))].sort((a, b) => a - b)
    for (let i = 0; i < values.length - 1; i++) {
      const threshold = (values[i] + values[i + 1]) / 2
      for (const direction of ["lt", "gt"]) {
        const test = row => Number.isFinite(row.features[feature]) && (direction === "lt" ? row.features[feature] < threshold : row.features[feature] > threshold)
        const m = metrics(train.filter(test), positive); m.recall = positives ? m.tp / positives : 0; m.f1 = m.precision + m.recall ? 2 * m.precision * m.recall / (m.precision + m.recall) : 0
        if (m.tp) predicates.push({ feature, direction, threshold, test, ...m })
      }
    }
  }
  const quality = x => x.f1 * 10000 + x.precision * 1000 + x.recall * 100 - x.selected
  predicates.sort((a, b) => quality(b) - quality(a))
  const pool = predicates.slice(0, 120), candidates = [...pool]
  for (let i = 0; i < pool.length; i++) for (let j = i + 1; j < pool.length; j++) {
    if (pool[i].feature === pool[j].feature) continue
    const test = row => pool[i].test(row) && pool[j].test(row), selected = train.filter(test), m = metrics(selected, positive)
    m.recall = positives ? m.tp / positives : 0; m.f1 = m.precision + m.recall ? 2 * m.precision * m.recall / (m.precision + m.recall) : 0
    if (m.tp) candidates.push({ rules: [pool[i], pool[j]], test, ...m })
  }
  candidates.sort((a, b) => quality(b) - quality(a))
  const best = candidates[0]
  if (!best.rules) best.rules = [best]
  return { ...best, rules: best.rules.map(({ feature, direction, threshold }) => ({ feature, direction, threshold: round(threshold, 6) })) }
}
const applies = (row, rules) => rules.every(rule => Number.isFinite(row.features[rule.feature]) && (rule.direction === "lt" ? row.features[rule.feature] < rule.threshold : row.features[rule.feature] > rule.threshold))

if (IS_MAIN) {
const cache = new Map(), get = symbol => { if (!cache.has(symbol)) cache.set(symbol, load(symbol)); return cache.get(symbol) }
const nifty = get("NIFTY50")
const rows = Object.entries(SIGNALS).flatMap(([date, symbols]) => symbols.map(symbol => featureRow(date, symbol, get(symbol), nifty, CUTOFF_MINUTE))).filter(Boolean)
let depthIndex = 0
await Promise.all(Array.from({ length: 5 }, async () => {
  while (depthIndex < rows.length) {
    const row = rows[depthIndex++]
    Object.assign(row.features, Object.fromEntries(Object.entries(await depthFeatures(row.date, row.symbol, CUTOFF_MINUTE)).filter(([, value]) => Number.isFinite(value)).map(([key, value]) => [key, round(value, 6)])))
  }
}))
const folds = DATES.map(heldOutDate => {
  const train = rows.filter(row => row.date !== heldOutDate), test = rows.filter(row => row.date === heldOutDate), model = discover(train)
  const selected = test.filter(row => applies(row, model.rules)), m = metrics(selected, row => row.targetHit), positives = test.filter(row => row.targetHit).length
  m.recall = positives ? m.tp / positives : 0; m.f1 = m.precision + m.recall ? 2 * m.precision * m.recall / (m.precision + m.recall) : 0
  return { heldOutDate, trainingRules: model.rules, training: { selected: model.selected, tp: model.tp, fp: model.fp, precisionPct: round(100 * model.precision), recallPct: round(100 * model.recall) }, test: { positives, selected: selected.length, tp: m.tp, fp: m.fp, precisionPct: round(100 * m.precision), recallPct: round(100 * m.recall), selectedStocks: selected.map(row => ({ symbol: row.symbol, targetHit: row.targetHit, mfePct: row.mfePct })) } }
})
const rankFolds = DATES.map(heldOutDate => {
  const train = rows.filter(row => row.date !== heldOutDate), test = rows.filter(row => row.date === heldOutDate)
  const positive = train.filter(row => row.targetHit), negative = train.filter(row => !row.targetHit)
  const names = [...new Set(train.flatMap(row => Object.keys(row.features)))].filter(name => train.every(row => Number.isFinite(row.features[name])))
  const candidates = names.map(feature => {
    const center = mean(train.map(row => row.features[feature])), variance = mean(train.map(row => (row.features[feature] - center) ** 2)), scale = Math.sqrt(variance) || 1
    const effect = (mean(positive.map(row => row.features[feature])) - mean(negative.map(row => row.features[feature]))) / scale
    return { feature, center, scale, effect }
  }).sort((left, right) => Math.abs(right.effect) - Math.abs(left.effect))
  const model = candidates[0]
  const selected = test.map(row => ({ row, score: model.effect * (row.features[model.feature] - model.center) / model.scale })).sort((left, right) => right.score - left.score).slice(0, 2)
  return { heldOutDate, feature: model.feature, effect: round(model.effect), selected: selected.map(item => ({ symbol: item.row.symbol, score: round(item.score), targetHit: item.row.targetHit, mfePct: item.row.mfePct })) }
})
const fullModel = discover(rows), selected = rows.filter(row => applies(row, fullModel.rules))
const cvSelected = folds.reduce((sum, fold) => sum + fold.test.selected, 0), cvTp = folds.reduce((sum, fold) => sum + fold.test.tp, 0), totalPositive = rows.filter(row => row.targetHit).length
const rankTp = rankFolds.flatMap(fold => fold.selected).filter(row => row.targetHit).length
const summary = {
  candidates: rows.length, postSignalTargetHits: totalPositive, postSignalStraightDownHits: rows.filter(row => row.straightDown).length,
  fullSampleRules: fullModel.rules, fullSampleSelected: selected.length, fullSampleTruePositive: selected.filter(row => row.targetHit).length, fullSampleFalsePositive: selected.filter(row => !row.targetHit).length,
  fullSamplePrecisionPct: round(100 * selected.filter(row => row.targetHit).length / selected.length), fullSampleRecallPct: round(100 * selected.filter(row => row.targetHit).length / totalPositive),
  leaveOneDayOutSelected: cvSelected, leaveOneDayOutTruePositive: cvTp, leaveOneDayOutFalsePositive: cvSelected - cvTp,
  leaveOneDayOutPrecisionPct: round(100 * cvTp / cvSelected), leaveOneDayOutRecallPct: round(100 * cvTp / totalPositive),
  leaveOneDayOutTop2Selected: 10, leaveOneDayOutTop2TruePositive: rankTp, leaveOneDayOutTop2FalsePositive: 10 - rankTp,
  leaveOneDayOutTop2PrecisionPct: round(10 * rankTp), leaveOneDayOutTop2RecallPct: round(100 * rankTp / totalPositive),
  depthAvailableCount: rows.filter(row => row.features.depthAvailable === 1).length,
}
const cutoffClock = `${String(Math.floor(CUTOFF_MINUTE / 60)).padStart(2, "0")}:${String(CUTOFF_MINUTE % 60).padStart(2, "0")}`
const entryClock = `${String(Math.floor((CUTOFF_MINUTE + 1) / 60)).padStart(2, "0")}:${String((CUTOFF_MINUTE + 1) % 60).padStart(2, "0")}`
const result = { generatedAt: new Date().toISOString(), cutoff: `Features through completed ${cutoffClock} candle only; entry ${entryClock} open`, target: "At least 2% short MFE before EMA20 crosses above EMA40", warning: "Five dates and a small number of causal positives are too small for production deployment. Full-sample rules are discovery/overfit; leave-one-day-out is the more honest estimate.", summary, fullSampleSelected: selected.map(row => ({ date: row.date, symbol: row.symbol, targetHit: row.targetHit, straightDown: row.straightDown, mfePct: row.mfePct, maeBeforeTargetPct: row.maeBeforeTargetPct })), causalWinners: rows.filter(row => row.targetHit).map(row => ({ date: row.date, symbol: row.symbol, straightDown: row.straightDown, mfePct: row.mfePct, maeBeforeTargetPct: row.maeBeforeTargetPct })), folds, rankFolds, rows }
const stem = `2026-10-26-to-2026-10-30-${cutoffClock.replace(":", "")}-pvi-nvi-short-filter-discovery`, json = unique("reports", stem, "json"), csv = unique("csv", stem, "csv"), md = unique("reports", stem, "md")
fs.writeFileSync(json, `${JSON.stringify(result, null, 2)}\n`, { flag: "wx" })
const headers = ["date", "symbol", "targetHit", "straightDown", "mfePct", "maeBeforeTargetPct", "selectedByFullModel"]
fs.writeFileSync(csv, `${headers.join(",")}\n${rows.map(row => headers.map(key => csvCell(key === "selectedByFullModel" ? applies(row, fullModel.rules) : row[key])).join(",")).join("\n")}\n`, { flag: "wx" })
const ruleText = fullModel.rules.map(rule => `${rule.feature} ${rule.direction === "lt" ? "<" : ">"} ${rule.threshold}`).join(" AND ")
const selectedTable = ["| Date | Stock | Selected | >2% | MFE | Pre-target MAE |", "|---|---|---|---|---:|---:|", ...rows.filter(row => applies(row, fullModel.rules) || row.targetHit).map(row => `| ${row.date} | ${row.symbol} | ${applies(row, fullModel.rules) ? "YES" : "NO"} | ${row.targetHit ? "YES" : "NO"} | ${row.mfePct}% | ${row.maeBeforeTargetPct}% |`)].join("\n")
const report = [`# ${cutoffClock} filter discovery for PVI+NVI short candidates`, "", "## Conclusion", "", `Causal winners from a ${entryClock} entry: ${totalPositive}/50. Full-sample rule: ${ruleText}.`, "", `Full sample: selected ${summary.fullSampleSelected}, TP ${summary.fullSampleTruePositive}, FP ${summary.fullSampleFalsePositive}, precision ${summary.fullSamplePrecisionPct}%, recall ${summary.fullSampleRecallPct}%.`, "", `Leave-one-day-out absolute thresholds: selected ${summary.leaveOneDayOutSelected}, TP ${summary.leaveOneDayOutTruePositive}, FP ${summary.leaveOneDayOutFalsePositive}, precision ${summary.leaveOneDayOutPrecisionPct}%, recall ${summary.leaveOneDayOutRecallPct}%.`, "", `Leave-one-day-out daily top-2 ranking: selected 10, TP ${summary.leaveOneDayOutTop2TruePositive}, FP ${summary.leaveOneDayOutTop2FalsePositive}, precision ${summary.leaveOneDayOutTop2PrecisionPct}%, recall ${summary.leaveOneDayOutTop2RecallPct}%. Depth was usable for ${summary.depthAvailableCount}/50 candidates and did not produce the best held-out rule.`, "", `Warning: ${result.warning}`, "", "## Selected and causal winners", "", selectedTable, "", `JSON: ${json}`, "", `CSV: ${csv}`].join("\n")
fs.writeFileSync(md, `${report}\n`, { flag: "wx" })
console.log(JSON.stringify({ json, csv, md, summary, fullSampleSelected: result.fullSampleSelected, folds }, null, 2))
}

export { load, featureRow, depthFeatures, SIGNALS, DATES }
