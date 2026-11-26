#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'

const ROOT = process.cwd()
const IST = 330 * 60_000
const SOURCE = path.join(ROOT, 'reports', '2026-10-26-to-2026-10-29-ema20-ema40-volume10-separation040-full-universe.json')
const source = JSON.parse(fs.readFileSync(SOURCE, 'utf8'))
const TRAIN_DATES = new Set(['2026-10-26', '2026-10-27', '2026-10-28'])
const TEST_DATE = '2026-10-29'
const round = (x, p = 4) => Number.isFinite(x) ? +x.toFixed(p) : null
const mean = a => a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN
const pct = (x, b) => Number.isFinite(x) && Number.isFinite(b) && b ? 100 * (x / b - 1) : NaN
const day = t => new Date(t + IST).toISOString().slice(0, 10)
const clock = t => new Date(t + IST).toISOString().slice(11, 16)
const minute = s => { const [h, m] = s.split(':').map(Number); return h * 60 + m }
const unique = (stem, ext) => { let n = 1, f; do { f = path.join(ROOT, 'reports', `${stem}${n === 1 ? '' : `-${n}`}.${ext}`); n++ } while (fs.existsSync(f)); return f }
const rsi = values => {
  if (values.length < 15) return NaN
  let gain = 0, loss = 0
  for (let i = values.length - 14; i < values.length; i++) { const d = values[i] - values[i - 1]; if (d > 0) gain += d; else loss -= d }
  return loss ? 100 - 100 / (1 + gain / loss) : 100
}
const regressionSlope = values => {
  if (values.length < 2) return NaN
  const xm = (values.length - 1) / 2, ym = mean(values)
  let top = 0, bottom = 0
  for (let i = 0; i < values.length; i++) { top += (i - xm) * (values[i] - ym); bottom += (i - xm) ** 2 }
  return top / bottom
}

function load(symbol) {
  const rows = fs.readFileSync(path.join(ROOT, 'db', 'candles', `${symbol}.jsonl`), 'utf8').split(/\r?\n/).flatMap(line => {
    try {
      const x = JSON.parse(line), t = +x.time * 1000
      const row = { t, date: day(t), time: clock(t), o: +x.open, h: +x.high, l: +x.low, c: +x.close, v: +x.volume }
      return row.date <= TEST_DATE && [row.t, row.o, row.h, row.l, row.c, row.v].every(Number.isFinite) ? [row] : []
    } catch { return [] }
  }).sort((a, b) => a.t - b.t)
  let e20, e40
  for (const x of rows) {
    e20 = e20 == null ? x.c : e20 + 2 / 21 * (x.c - e20)
    e40 = e40 == null ? x.c : e40 + 2 / 41 * (x.c - e40)
    x.e20 = e20; x.e40 = e40
  }
  return rows
}

function aggregate(rows, size) {
  const bars = []
  for (const [date, dayRows] of Object.entries(Object.groupBy(rows, x => x.date))) {
    const groups = new Map()
    for (const x of dayRows) {
      const offset = minute(x.time) - 555
      if (offset < 0 || offset >= 375) continue
      const key = Math.floor(offset / size)
      if (!groups.has(key)) groups.set(key, [])
      groups.get(key).push(x)
    }
    for (const g of groups.values()) {
      g.sort((a, b) => a.t - b.t)
      if (g.length !== size || g.some((x, i) => i && x.t !== g[i - 1].t + 60_000)) continue
      bars.push({ date, t: g.at(-1).t, o: g[0].o, h: Math.max(...g.map(x => x.h)), l: Math.min(...g.map(x => x.l)), c: g.at(-1).c, v: g.reduce((s, x) => s + x.v, 0) })
    }
  }
  bars.sort((a, b) => a.t - b.t)
  let e20, e40
  for (const x of bars) { e20 = e20 == null ? x.c : e20 + 2 / 21 * (x.c - e20); e40 = e40 == null ? x.c : e40 + 2 / 41 * (x.c - e40); x.e20 = e20; x.e40 = e40 }
  return bars
}

const cache = new Map()
const nifty = load('NIFTY50')
function data(symbol) {
  if (!cache.has(symbol)) { const rows = load(symbol); cache.set(symbol, { rows, tf: Object.fromEntries([3, 5, 10, 15].map(n => [n, aggregate(rows, n)])) }) }
  return cache.get(symbol)
}

function directionalFeatures(trade) {
  const direction = trade.side === 'BUY' ? 1 : -1
  const { rows, tf } = data(trade.symbol)
  const index = rows.findIndex(x => x.date === trade.date && x.time === trade.signalTime)
  if (index < 0) return null
  const signal = rows[index], session = rows.filter(x => x.date === trade.date && x.t <= signal.t)
  const si = session.length - 1, closes = rows.slice(0, index + 1).map(x => x.c)
  const priorDayRows = rows.filter(x => x.date < trade.date).reduce((map, x) => map.set(x.date, [...(map.get(x.date) ?? []), x]), new Map())
  const priorDate = [...priorDayRows.keys()].sort().at(-1), prior = priorDate ? priorDayRows.get(priorDate) : []
  const window = n => session.slice(Math.max(0, si - n + 1), si + 1)
  const ret = n => session.length > n ? direction * pct(signal.c, session[si - n].c) : NaN
  const slope = (field, n) => { const w = rows.slice(Math.max(0, index - n + 1), index + 1); return w.length === n ? direction * 100 * regressionSlope(w.map(x => x[field])) / signal.c : NaN }
  const vwap = session.reduce((s, x) => s + ((x.h + x.l + x.c) / 3) * x.v, 0) / (session.reduce((s, x) => s + x.v, 0) || 1)
  const trueRanges = window(15).map((x, i, a) => { const pc = i ? a[i - 1].c : x.o; return Math.max(x.h - x.l, Math.abs(x.h - pc), Math.abs(x.l - pc)) })
  const atrPct = 100 * mean(trueRanges) / signal.c
  const w20 = window(20), path20 = w20.slice(1).reduce((s, x, i) => s + Math.abs(x.c - w20[i].c), 0)
  const efficiency20 = direction * 100 * (signal.c - w20[0].c) / (path20 || 1)
  const favorableShare20 = 100 * w20.filter(x => direction * (x.c - x.o) > 0).length / (w20.length || 1)
  const favorableVolume = w20.filter(x => direction * (x.c - x.o) > 0).reduce((s, x) => s + x.v, 0)
  const adverseVolume = w20.filter(x => direction * (x.c - x.o) < 0).reduce((s, x) => s + x.v, 0)
  const prior20 = session.slice(Math.max(0, si - 20), si)
  const prior60 = session.slice(Math.max(0, si - 60), si)
  const directionalBreak = w => !w.length ? NaN : direction > 0 ? pct(signal.c, Math.max(...w.map(x => x.h))) : pct(Math.min(...w.map(x => x.l)), signal.c)
  const opening15 = session.slice(0, 15)
  const sessionHigh = Math.max(...session.map(x => x.h)), sessionLow = Math.min(...session.map(x => x.l))
  const sessionPosition = direction > 0 ? 100 * (signal.c - sessionLow) / (sessionHigh - sessionLow || 1) : 100 * (sessionHigh - signal.c) / (sessionHigh - sessionLow || 1)
  const signalRange = signal.h - signal.l
  const signalCloseLocation = direction > 0 ? 100 * (signal.c - signal.l) / (signalRange || 1) : 100 * (signal.h - signal.c) / (signalRange || 1)
  const nSession = nifty.filter(x => x.date === trade.date && x.t <= signal.t), ni = nSession.length - 1
  const nRet = n => ni >= n ? direction * pct(nSession[ni].c, nSession[ni - n].c) : NaN
  const out = {
    minuteOfDay: minute(trade.signalTime), minutesToClose: 929 - minute(trade.signalTime),
    absoluteSignalCloseVsEma20Pct: trade.absoluteSignalCloseVsEma20Pct,
    signalVolumeVsPrior20: trade.signalVolumeVsPrior20,
    emaGapDirectionalBps: direction * 10000 * (signal.e20 / signal.e40 - 1),
    ema20Slope3DirectionalPct: slope('e20', 3), ema20Slope5DirectionalPct: slope('e20', 5), ema20Slope10DirectionalPct: slope('e20', 10),
    ema40Slope5DirectionalPct: slope('e40', 5), ema40Slope10DirectionalPct: slope('e40', 10),
    return3DirectionalPct: ret(3), return5DirectionalPct: ret(5), return10DirectionalPct: ret(10), return15DirectionalPct: ret(15), return30DirectionalPct: ret(30),
    fromOpenDirectionalPct: direction * pct(signal.c, session[0].o), priceVsVwapDirectionalPct: direction * pct(signal.c, vwap),
    rsi14Directional: direction > 0 ? rsi(closes) : 100 - rsi(closes), atr14Pct: atrPct,
    efficiency20Directional: efficiency20, favorableCandleShare20Pct: favorableShare20,
    favorableAdverseVolumeRatio20: favorableVolume / (adverseVolume || 1),
    prior20BreakDirectionalPct: directionalBreak(prior20), prior60BreakDirectionalPct: directionalBreak(prior60),
    opening15BreakDirectionalPct: directionalBreak(opening15),
    priorDayBreakDirectionalPct: !prior.length ? NaN : direction > 0 ? pct(signal.c, Math.max(...prior.map(x => x.h))) : pct(Math.min(...prior.map(x => x.l)), signal.c),
    sessionPositionDirectionalPct: sessionPosition,
    signalBodyDirectionalPct: direction * 100 * (signal.c - signal.o) / signal.o,
    signalCloseLocationDirectionalPct: signalCloseLocation,
    niftyReturn5DirectionalPct: nRet(5), niftyReturn15DirectionalPct: nRet(15),
    relativeReturn15Pct: ret(15) - nRet(15),
  }
  for (const size of [3, 5, 10, 15]) {
    const bars = tf[size].filter(x => x.t <= signal.t), last = bars.at(-1), prior3 = bars.at(-4)
    out[`tf${size}EmaAligned`] = last ? direction * (last.e20 - last.e40) > 0 ? 1 : 0 : NaN
    out[`tf${size}PriceVsEma20DirectionalPct`] = last ? direction * pct(last.c, last.e20) : NaN
    out[`tf${size}Ema20Slope3DirectionalPct`] = last && prior3 ? direction * pct(last.e20, prior3.e20) : NaN
    out[`tf${size}Return3DirectionalPct`] = last && prior3 ? direction * pct(last.c, prior3.c) : NaN
  }
  return { ...trade, target: trade.returnPct > 1, profitable: trade.returnPct > 0, ...Object.fromEntries(Object.entries(out).map(([k, v]) => [k, round(v)])) }
}

const features = source.trades.map(directionalFeatures).filter(Boolean)
const train = features.filter(x => TRAIN_DATES.has(x.date)), test = features.filter(x => x.date === TEST_DATE)
const featureNames = Object.keys(features[0]).filter(k => !['date','symbol','side','signalTime','entryTime','entryPrice','exitTime','exitPrice','exitReason','holdMinutes','returnPct','maximumFavorableExcursionPct','maximumAdverseExcursionPct','target','profitable'].includes(k) && features.some(x => Number.isFinite(x[k])))

const conditions = []
for (const feature of featureNames) {
  const values = [...new Set(train.map(x => x[feature]).filter(Number.isFinite))].sort((a, b) => a - b)
  for (const threshold of values) {
    for (const op of ['>=', '<=']) {
      const pass = x => Number.isFinite(x[feature]) && (op === '>=' ? x[feature] >= threshold : x[feature] <= threshold)
      const selected = train.filter(pass), targets = selected.filter(x => x.target).length
      if (targets >= 2 && selected.length <= 20) conditions.push({ feature, op, threshold, pass, targets, falsePositives: selected.length - targets })
    }
  }
}
conditions.sort((a, b) => b.targets - a.targets || a.falsePositives - b.falsePositives)
const pool = conditions.slice(0, 300)
const rules = []
for (let i = 0; i < pool.length; i++) {
  for (let j = i; j < pool.length; j++) {
    if (i === j) continue
    const selected = train.filter(x => pool[i].pass(x) && pool[j].pass(x))
    const targets = selected.filter(x => x.target)
    if (targets.length < 2 || selected.length !== targets.length) continue
    const testSelected = test.filter(x => pool[i].pass(x) && pool[j].pass(x))
    rules.push({
      conditions: [pool[i], pool[j]].map(({feature, op, threshold}) => ({feature, op, threshold})),
      trainTargetCount: targets.length,
      trainSelected: targets.map(x => ({date:x.date,symbol:x.symbol,side:x.side,signalTime:x.signalTime,returnPct:x.returnPct})),
      testSelected: testSelected.map(x => ({date:x.date,symbol:x.symbol,side:x.side,signalTime:x.signalTime,returnPct:x.returnPct,target:x.target})),
      testAllWinnersOver1: testSelected.length > 0 && testSelected.every(x => x.target),
    })
  }
}
const dedup = new Map()
for (const rule of rules) {
  const key = JSON.stringify(rule.conditions)
  if (!dedup.has(key)) dedup.set(key, rule)
}
const ranked = [...dedup.values()].sort((a, b) => b.trainTargetCount - a.trainTargetCount || Number(b.testAllWinnersOver1) - Number(a.testAllWinnersOver1) || b.testSelected.length - a.testSelected.length)
const best = ranked[0] ?? null
const validationSafe = ranked.find(x => x.testAllWinnersOver1) ?? null
const advancedFilter = x => x.minuteOfDay <= 900 &&
  x.sessionPositionDirectionalPct >= 95 &&
  x.efficiency20Directional >= 58 &&
  x.relativeReturn15Pct >= 1
const advancedSelected = features.filter(advancedFilter)
const advancedReturns = advancedSelected.map(x => x.returnPct)
const advancedDaily = ['2026-10-26','2026-10-27','2026-10-28','2026-10-29'].map(date => {
  const rows = advancedSelected.filter(x => x.date === date), returns = rows.map(x => x.returnPct)
  return { date, tradeCount: rows.length, totalReturnPct: round(returns.reduce((s,x)=>s+x,0)), signals: rows.map(x => ({symbol:x.symbol,side:x.side,signalTime:x.signalTime,returnPct:x.returnPct})) }
})
const advancedSummary = {
  tradeCount: advancedSelected.length,
  buyCount: advancedSelected.filter(x=>x.side==='BUY').length,
  sellCount: advancedSelected.filter(x=>x.side==='SELL').length,
  winRatePct: round(100 * advancedSelected.filter(x=>x.returnPct>0).length / (advancedSelected.length || 1)),
  winnersOver1Pct: advancedSelected.filter(x=>x.returnPct>1).length,
  averageReturnPct: round(advancedReturns.reduce((s,x)=>s+x,0)/(advancedReturns.length||1)),
  totalReturnPct: round(advancedReturns.reduce((s,x)=>s+x,0)),
  maximumAdverseExcursionPct: advancedSelected.length ? round(Math.min(...advancedSelected.map(x=>x.maximumAdverseExcursionPct))) : null,
  worstTradingDay: [...advancedDaily].filter(x=>x.tradeCount).sort((a,b)=>a.totalReturnPct-b.totalReturnPct)[0] ?? null,
}
const advancedSignals = advancedSelected.map(x => ({date:x.date,symbol:x.symbol,side:x.side,signalTime:x.signalTime,entryTime:x.entryTime,entryPrice:x.entryPrice,exitTime:x.exitTime,exitPrice:x.exitPrice,returnPct:x.returnPct,maximumFavorableExcursionPct:x.maximumFavorableExcursionPct,maximumAdverseExcursionPct:x.maximumAdverseExcursionPct,sessionPositionDirectionalPct:x.sessionPositionDirectionalPct,efficiency20Directional:x.efficiency20Directional,relativeReturn15Pct:x.relativeReturn15Pct}))
const result = {
  warning: 'Thresholds were fitted on 26-28 October. Only 29 October is held out. Four training winners and one validation winner are far too few to establish robustness.',
  source: SOURCE,
  targetDefinition: 'Gross return above 1% using the source EMA20/40 opposite-cross-or-EOD exit.',
  chronology: 'All engineered features use candles completed no later than the signal candle. Multi-timeframe features use only fully completed 3/5/10/15-minute bars.',
  trainDates: [...TRAIN_DATES], testDate: TEST_DATE,
  counts: {trainSignals: train.length, trainTargets: train.filter(x=>x.target).length, testSignals: test.length, testTargets: test.filter(x=>x.target).length, candidateTwoConditionRules: ranked.length},
  bestTrainingRule: best,
  firstRuleAlsoCleanOnHeldOutDate: validationSafe,
  advancedStructureRule: {
    status: 'Post-discovery candidate: chronological inputs, but selected after examining this small four-day sample.',
    conditions: [
      'Signal time <= 15:00 IST',
      'Directional session position >= 95% (near the high for BUY or near the low for SELL)',
      'Directional 20-candle price efficiency >= 58%',
      'Directional 15-candle stock return minus matching NIFTY return >= 1.00 percentage point',
    ],
    summary: advancedSummary,
    daily: advancedDaily,
    signals: advancedSignals,
  },
  topRules: ranked.slice(0, 20),
  features,
}
const json = unique('2026-10-26-to-2026-10-29-ema20-40-advanced-loser-filter', 'json')
fs.writeFileSync(json, JSON.stringify(result, null, 2) + '\n', {flag:'wx'})
const csv = unique('2026-10-26-to-2026-10-29-ema20-40-advanced-loser-filter-signals', 'csv')
const fields = ['date','symbol','side','signalTime','entryTime','entryPrice','exitTime','exitPrice','returnPct','maximumFavorableExcursionPct','maximumAdverseExcursionPct','sessionPositionDirectionalPct','efficiency20Directional','relativeReturn15Pct']
fs.writeFileSync(csv, [fields.join(','), ...advancedSignals.map(x=>fields.map(k=>x[k]).join(','))].join('\n')+'\n', {flag:'wx'})
const md = unique('2026-10-26-to-2026-10-29-ema20-40-advanced-loser-filter', 'md')
const table = ['| Date | Symbol | Side | Signal | Entry | Exit | Return | MFE | MAE | Session pos. | Efficiency | Rel. 15m |','|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|',...advancedSignals.map(x=>`| ${x.date} | ${x.symbol} | ${x.side} | ${x.signalTime} | ${x.entryTime} @ ${x.entryPrice} | ${x.exitTime} @ ${x.exitPrice} | ${x.returnPct}% | ${x.maximumFavorableExcursionPct}% | ${x.maximumAdverseExcursionPct}% | ${x.sessionPositionDirectionalPct}% | ${x.efficiency20Directional}% | ${x.relativeReturn15Pct}% |`)].join('\n')
fs.writeFileSync(md, [`# EMA20/40 advanced loser-filter candidate: 26-29 October 2026`,'',`Warning: ${result.advancedStructureRule.status}`,'','## Rule','',...result.advancedStructureRule.conditions.map(x=>`- ${x}`),'','## Result','',`- Trades: ${advancedSummary.tradeCount} (${advancedSummary.buyCount} BUY, ${advancedSummary.sellCount} SELL)`,`- Win rate: ${advancedSummary.winRatePct}%`,`- Winners above 1%: ${advancedSummary.winnersOver1Pct}`,`- Average / summed return: ${advancedSummary.averageReturnPct}% / ${advancedSummary.totalReturnPct}%`,`- Worst MAE: ${advancedSummary.maximumAdverseExcursionPct}%`,`- Worst trading day: ${advancedSummary.worstTradingDay?.date}, ${advancedSummary.worstTradingDay?.totalReturnPct}%`,'','## Signals','',table,'','All selection features use only completed candles through the signal. Entry is the next one-minute open; exit is the completed opposite EMA20/40 cross or EOD. Gross returns; no costs.','',`JSON: ${json}`,`CSV: ${csv}`].join('\n')+'\n', {flag:'wx'})
console.log(JSON.stringify({json,csv,md,warning:result.advancedStructureRule.status,summary:advancedSummary,daily:advancedDaily,signals:advancedSignals}, null, 2))
