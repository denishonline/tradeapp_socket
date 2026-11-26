#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'

const ROOT = process.cwd(), IST = 330 * 60_000
const arg = name => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : null }
const SESSION_COUNT = +(arg('--sessions') ?? 50)
const RANK_CUTOFF = arg('--rank-cutoff') ?? '09:20'
const SIGNAL_END = arg('--signal-end') ?? '10:30'
const TOP_N = +(arg('--top') ?? 20)
const LOOKBACK = +(arg('--lookback') ?? 20)
const round = (x, p = 4) => Number.isFinite(x) ? +x.toFixed(p) : null
const sum = xs => xs.reduce((a, b) => a + b, 0), mean = xs => xs.length ? sum(xs) / xs.length : NaN
const median = xs => { const a = xs.filter(Number.isFinite).sort((x, y) => x - y); return a.length ? (a[(a.length - 1) >> 1] + a[a.length >> 1]) / 2 : NaN }
const pct = (a, b) => b ? 100 * (a / b - 1) : NaN
const stamp = epoch => new Date(epoch * 1000 + IST).toISOString().slice(0, 16).replace('T', ' ')
const dateOf = epoch => stamp(epoch).slice(0, 10)
const minuteOf = epoch => { const s = stamp(epoch).slice(11); return +s.slice(0, 2) * 60 + +s.slice(3) }
const minuteNumber = hhmm => +hhmm.slice(0, 2) * 60 + +hhmm.slice(3)
const clock = minute => `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`
const rankDescending = (rows, key, date) => { const value = rows.find(x => x.date === date)?.[key]; return Number.isFinite(value) ? 1 + rows.filter(x => x[key] > value).length : null }
const trendAngle = values => {
  if (values.length < 2 || values.some(x => !(x > 0))) return NaN
  const ys = values.map(Math.log), mx = (values.length - 1) / 2, my = mean(ys), den = sum(ys.map((_, i) => (i - mx) ** 2))
  return Math.atan(100 * sum(ys.map((y, i) => (i - mx) * (y - my))) / den) * 180 / Math.PI
}
const uniqueFile = (stem, ext) => { let n = 1, file; do { file = path.join(ROOT, 'reports', `${stem}${n === 1 ? '' : `-${n}`}.${ext}`); n++ } while (fs.existsSync(file)); return file }
const csv = value => /[",\n]/.test(String(value ?? '')) ? `"${String(value ?? '').replaceAll('"', '""')}"` : String(value ?? '')

const universe = [...new Set(JSON.parse(fs.readFileSync(path.join(ROOT, 'db', 'stocks'), 'utf8')).map(x => String(x).replace(/-EQ$/i, '').toUpperCase()))]
const niftyRows = loadRows('NIFTY50')
const calendar = [...new Set(niftyRows.map(x => x.date))].sort()
if (calendar.length < SESSION_COUNT + LOOKBACK) throw new Error(`Need at least ${SESSION_COUNT + LOOKBACK} NIFTY sessions`)
const targetDates = calendar.slice(-SESSION_COUNT), relevantDates = calendar.slice(-(SESSION_COUNT + LOOKBACK - 1))
const relevantSet = new Set(relevantDates), targetSet = new Set(targetDates)
const rankCutoffMinute = minuteNumber(RANK_CUTOFF), signalEndMinute = minuteNumber(SIGNAL_END), startMinute = 555
const expectedRankBars = rankCutoffMinute - startMinute + 1

function loadRows(symbol, dates = null) {
  const file = path.join(ROOT, 'db', 'candles', `${symbol}.jsonl`)
  if (!fs.existsSync(file)) return []
  const unique = new Map()
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!line) continue
    let x; try { x = JSON.parse(line) } catch { continue }
    const date = dateOf(+x.time), minute = minuteOf(+x.time)
    if (dates && !dates.has(date) || minute < 555 || minute > 929) continue
    if (![x.open, x.high, x.low, x.close, x.volume].every(v => Number.isFinite(+v))) continue
    unique.set(`${date}|${minute}`, { time: +x.time, date, minute, open: +x.open, high: +x.high, low: +x.low, close: +x.close, volume: +x.volume })
  }
  return [...unique.values()].sort((a, b) => a.time - b.time)
}

function rankMetrics(rows) {
  let pvi = 1000, previous = null
  for (const row of rows) {
    if (previous && row.volume > previous.volume) pvi *= row.close / previous.close
    row.pvi = pvi; previous = row
  }
  const byDate = Map.groupBy(rows, x => x.date), sessions = []
  for (const date of relevantDates) {
    const window = (byDate.get(date) ?? []).filter(x => x.minute >= startMinute && x.minute <= rankCutoffMinute)
    if (window.length !== expectedRankBars) continue
    const volume = sum(window.map(x => x.volume)), turnover = sum(window.map(x => ((x.high + x.low + x.close) / 3) * x.volume))
    sessions.push({ date, volume, turnover, returnPct: pct(window.at(-1).close, window[0].open), pviChangePct: pct(window.at(-1).pvi, window[0].pvi), pviAngleDeg: trendAngle(window.map(x => x.pvi)) })
  }
  const output = []
  for (const date of targetDates) {
    const index = sessions.findIndex(x => x.date === date)
    if (index < LOOKBACK - 1) continue
    const history = sessions.slice(index - LOOKBACK + 1, index + 1), target = history.at(-1)
    if (history.length !== LOOKBACK || target.date !== date) continue
    const ranks = {
      volumeRank: rankDescending(history, 'volume', date), turnoverRank: rankDescending(history, 'turnover', date),
      returnRank: rankDescending(history, 'returnPct', date), pviChangeRank: rankDescending(history, 'pviChangePct', date), pviAngleRank: rankDescending(history, 'pviAngleDeg', date)
    }
    if (Object.values(ranks).some(x => !Number.isFinite(x))) continue
    output.push({ date, averageRank: mean(Object.values(ranks)), ...ranks })
  }
  return output
}

console.error(`Building ${SESSION_COUNT}-session daily top-${TOP_N} cohort...`)
const rankedByDate = new Map(targetDates.map(date => [date, []]))
for (let i = 0; i < universe.length; i++) {
  const symbol = universe[i], metrics = rankMetrics(loadRows(symbol, relevantSet))
  for (const row of metrics) rankedByDate.get(row.date)?.push({ symbol, ...row })
  const width = 28, fill = Math.round(width * (i + 1) / universe.length)
  process.stderr.write(`\r[${'='.repeat(fill)}${'-'.repeat(width - fill)}] ${i + 1}/${universe.length} ${symbol.padEnd(14).slice(0, 14)}`)
}
process.stderr.write('\n')
const topByDate = new Map(), rankLookup = new Map()
for (const date of targetDates) {
  const top = (rankedByDate.get(date) ?? []).sort((a, b) => a.averageRank - b.averageRank || a.symbol.localeCompare(b.symbol)).slice(0, TOP_N)
  topByDate.set(date, top)
  for (const row of top) rankLookup.set(`${date}|${row.symbol}`, row)
}

// Decorate a symbol's complete history causally with EMA, RSI and PVI/NVI.
function decorate(rows) {
  let e9, e20, e50, avgGain, avgLoss, pvi = 1000, nvi = 1000, previous
  const changes = []
  return rows.map((row, i) => {
    e9 = e9 == null ? row.close : row.close * .2 + e9 * .8
    e20 = e20 == null ? row.close : row.close * (2 / 21) + e20 * (19 / 21)
    e50 = e50 == null ? row.close : row.close * (2 / 51) + e50 * (49 / 51)
    const change = previous ? row.close - previous.close : 0; changes.push(change)
    if (i === 14) { avgGain = mean(changes.slice(1, 15).map(x => Math.max(x, 0))); avgLoss = mean(changes.slice(1, 15).map(x => Math.max(-x, 0))) }
    else if (i > 14) { avgGain = (avgGain * 13 + Math.max(change, 0)) / 14; avgLoss = (avgLoss * 13 + Math.max(-change, 0)) / 14 }
    if (previous) { if (row.volume > previous.volume) pvi *= row.close / previous.close; if (row.volume < previous.volume) nvi *= row.close / previous.close }
    const rsi = i < 14 ? NaN : avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss)
    previous = row
    return { ...row, ema9: e9, ema20: e20, ema50: e50, rsi, pvi, nvi }
  })
}

const niftyByDate = Map.groupBy(niftyRows, x => x.date)
function rawCandidate(symbol, date, rows, rankRow, byDate) {
  const day = byDate.get(date) ?? [], firstFive = day.filter(x => x.minute >= 555 && x.minute <= 559)
  if (firstFive.length !== 5) return null
  const rangeHigh = Math.max(...firstFive.map(x => x.high)), rangeLow = Math.min(...firstFive.map(x => x.low)), sessionOpen = firstFive[0].open
  const priorDates = [...byDate.keys()].filter(x => x < date).sort(), prior3 = priorDates.slice(-3).flatMap(d => byDate.get(d) ?? [])
  const prior3High = prior3.length ? Math.max(...prior3.map(x => x.high)) : NaN, prior3Low = prior3.length ? Math.min(...prior3.map(x => x.low)) : NaN
  let cumPv = 0, cumVolume = 0
  for (let i = 0; i < day.length; i++) {
    const row = day[i]
    cumPv += ((row.high + row.low + row.close) / 3) * row.volume; cumVolume += row.volume
    row.sessionVwap = cumPv / cumVolume; row.cumVolume = cumVolume
    if (row.minute < rankCutoffMinute || row.minute > signalEndMinute || i === 0) continue
    const previous = day[i - 1]
    let side = null, level = null
    if (row.close > rangeHigh && previous.close <= rangeHigh) { side = 'BUY'; level = rangeHigh }
    else if (row.close < rangeLow && previous.close >= rangeLow) { side = 'SELL'; level = rangeLow }
    if (!side) continue
    const sign = side === 'BUY' ? 1 : -1, globalIndex = rows.findIndex(x => x.time === row.time), ema20Back = rows[Math.max(0, globalIndex - 5)].ema20
    const elapsed = i + 1, prior20 = priorDates.slice(-20).map(d => sum((byDate.get(d) ?? []).slice(0, elapsed).map(x => x.volume))).filter(x => x > 0)
    const recent = day.slice(Math.max(0, i - 4), i + 1), path = sum(recent.slice(1).map((x, j) => Math.abs(x.close - recent[j].close)))
    const niftyDay = (niftyByDate.get(date) ?? []).filter(x => x.minute <= row.minute && x.minute >= 555), niftyReturn = niftyDay.length ? pct(niftyDay.at(-1).close, niftyDay[0].open) : 0
    const directionalRsi = side === 'BUY' ? row.rsi : 100 - row.rsi, rsiRoom = side === 'BUY' ? 100 - row.rsi : row.rsi
    const threePosition = Number.isFinite(prior3High) && prior3High > prior3Low ? (side === 'BUY' ? (row.close - prior3Low) / (prior3High - prior3Low) : (prior3High - row.close) / (prior3High - prior3Low)) : NaN
    const features = {
      rankStrength: 21 - rankRow.averageRank,
      breakoutBuffer: sign * pct(row.close, level), openingMove: sign * pct(row.close, sessionOpen),
      vwapGap: sign * pct(row.close, row.sessionVwap), ema9Over20: sign * pct(row.ema9, row.ema20), ema20Over50: sign * pct(row.ema20, row.ema50),
      ema20Slope5: sign * pct(row.ema20, ema20Back) / 5, bodyStrength: sign * pct(row.close, row.open),
      closeLocation: row.high === row.low ? .5 : side === 'BUY' ? (row.close - row.low) / (row.high - row.low) : (row.high - row.close) / (row.high - row.low),
      relativeVolume: row.cumVolume / median(prior20), efficiency5: path ? sign * (recent.at(-1).close - recent[0].open) / path : 0,
      rsiStrength: directionalRsi, rsiRoom, relativeNifty: sign * (pct(row.close, sessionOpen) - niftyReturn),
      prior3Position: threePosition, gapDirection: sign * pct(sessionOpen, (byDate.get(priorDates.at(-1)) ?? []).at(-1)?.close), signalMinuteStrength: -(row.minute - rankCutoffMinute)
    }
    const entry = day[i + 1]
    if (!entry) return null
    return { date, symbol, side, signalIndex: i, signalTime: row.time, signalMinute: row.minute, entryIndex: i + 1, entryTime: entry.time, entryPrice: entry.open, level, features, day }
  }
  return null
}

console.error('Generating causal opening-range signals...')
const candidateSymbols = new Set([...topByDate.values()].flat().map(x => x.symbol)), candidates = []
let processed = 0
for (const symbol of candidateSymbols) {
  const rows = decorate(loadRows(symbol)), byDate = Map.groupBy(rows, x => x.date)
  for (const date of targetDates) {
    const rankRow = rankLookup.get(`${date}|${symbol}`)
    if (!rankRow) continue
    const candidate = rawCandidate(symbol, date, rows, rankRow, byDate)
    if (candidate) candidates.push(candidate)
  }
  processed++; process.stderr.write(`\rSignals ${processed}/${candidateSymbols.size} ${symbol.padEnd(14).slice(0, 14)}`)
}
process.stderr.write('\n')

function outcome(candidate, config) {
  const sign = candidate.side === 'BUY' ? 1 : -1, entry = candidate.entryPrice
  const stopPrice = sign > 0 ? entry * (1 - config.stop / 100) : entry * (1 + config.stop / 100)
  const targetPrice = sign > 0 ? entry * (1 + config.target / 100) : entry * (1 - config.target / 100)
  const maximumIndex = config.hold === 999 ? candidate.day.length - 1 : Math.min(candidate.day.length - 1, candidate.entryIndex + config.hold - 1)
  let worst = 0, exitPrice, exitIndex, reason
  for (let i = candidate.entryIndex; i <= maximumIndex; i++) {
    const row = candidate.day[i]
    const adverse = sign > 0 ? pct(row.low, entry) : pct(entry, row.high); worst = Math.min(worst, adverse)
    const stopHit = sign > 0 ? row.low <= stopPrice : row.high >= stopPrice
    const targetHit = sign > 0 ? row.high >= targetPrice : row.low <= targetPrice
    if (stopHit) { exitPrice = stopPrice; exitIndex = i; reason = 'STOP'; break }
    if (targetHit) { exitPrice = targetPrice; exitIndex = i; reason = 'TARGET'; break }
  }
  if (exitPrice == null) { exitIndex = maximumIndex; exitPrice = candidate.day[exitIndex].close; reason = config.hold === 999 ? 'SESSION_CLOSE' : `TIME_${config.hold}M` }
  return { returnPct: sign * pct(exitPrice, entry), maePct: worst, exitIndex, exitPrice, reason, exitTime: candidate.day[exitIndex].time }
}

function stats(rows) {
  if (!rows.length) return { trades: 0, wins: 0, bigWins: 0, losses: 0, winRate: 0, bigWinRate: 0, average: 0, total: 0, maxDrawdown: 0, mae: 0, worstDay: null }
  const ordered = [...rows].sort((a, b) => a.candidate.date.localeCompare(b.candidate.date) || a.candidate.signalTime - b.candidate.signalTime)
  let equity = 0, peak = 0, maxDrawdown = 0
  for (const row of ordered) { equity += row.outcome.returnPct; peak = Math.max(peak, equity); maxDrawdown = Math.min(maxDrawdown, equity - peak) }
  const daily = [...Map.groupBy(ordered, x => x.candidate.date)].map(([date, xs]) => ({ date, returnPct: sum(xs.map(x => x.outcome.returnPct)) })).sort((a, b) => a.returnPct - b.returnPct)
  const wins = ordered.filter(x => x.outcome.returnPct > 0), bigWins = ordered.filter(x => x.outcome.returnPct > .20), losses = ordered.filter(x => x.outcome.returnPct < 0)
  return { trades: ordered.length, wins: wins.length, bigWins: bigWins.length, losses: losses.length, winRate: 100 * wins.length / ordered.length, bigWinRate: 100 * bigWins.length / ordered.length, average: mean(ordered.map(x => x.outcome.returnPct)), total: sum(ordered.map(x => x.outcome.returnPct)), maxDrawdown, mae: Math.min(0, ...ordered.map(x => x.outcome.maePct)), worstDay: daily[0] }
}
// Precision is more important than signal count: reward >0.20% winners and
// expectancy, while penalising drawdown and ordinary losers.  The square-root
// sample term prevents a tiny hand-picked set from winning the search.
const score = summary => summary.trades ?
  8 * summary.average + .08 * summary.bigWinRate + .03 * summary.winRate -
  .45 * Math.abs(summary.maxDrawdown) / Math.sqrt(summary.trades) -
  .02 * (100 * summary.losses / summary.trades) + .03 * Math.sqrt(summary.trades) : -Infinity
const passes = (candidate, rule) => Number.isFinite(candidate.features[rule.feature]) &&
  (rule.operator === '<=' ? candidate.features[rule.feature] <= rule.threshold : candidate.features[rule.feature] >= rule.threshold)
const trainDates = new Set(targetDates.slice(0, 30)), validationDates = new Set(targetDates.slice(30, 40)), testDates = new Set(targetDates.slice(40))
const features = Object.keys(candidates[0]?.features ?? {})
function optimize(side) {
  const pool = candidates.filter(x => x.side === side), trainPool = pool.filter(x => trainDates.has(x.date))
  const atoms = []
  for (const feature of features) {
    const values = trainPool.map(x => x.features[feature]).filter(Number.isFinite).sort((a, b) => a - b)
    for (const q of [.2, .4, .6, .8]) {
      const threshold = values[Math.min(values.length - 1, Math.floor(q * values.length))]
      if (Number.isFinite(threshold)) {
        atoms.push({ feature, operator: '>=', threshold })
        atoms.push({ feature, operator: '<=', threshold })
      }
    }
  }
  const configs = []
  for (const stop of [.25, .35, .5, .7, .9]) for (const target of [.3, .4, .5, .7, 1, 1.5]) for (const hold of [15, 30, 60, 120, 999]) configs.push({ stop, target, hold })
  const fitted = []
  for (const config of configs) {
    let rules = [], used = new Set(), selected = trainPool
    let results = selected.map(candidate => ({ candidate, outcome: outcome(candidate, config) })), bestSummary = stats(results), bestScore = score(bestSummary)
    for (let depth = 0; depth < 4; depth++) {
      let best = null
      for (const atom of atoms) {
        if (used.has(atom.feature)) continue
        const next = selected.filter(x => passes(x, atom))
        if (next.length < 20) continue
        const summary = stats(next.map(candidate => ({ candidate, outcome: outcome(candidate, config) }))), value = score(summary)
        if (!best || value > best.value) best = { atom, next, summary, value }
      }
      if (!best || best.value <= bestScore) break
      rules.push(best.atom); used.add(best.atom.feature); selected = best.next; bestSummary = best.summary; bestScore = best.value
    }
    fitted.push({ side, config, rules, train: bestSummary, trainScore: bestScore })
  }
  const topTrain = fitted.sort((a, b) => b.trainScore - a.trainScore).slice(0, 100)
  for (const model of topTrain) {
    const eligible = pool.filter(x => model.rules.every(rule => passes(x, rule)))
    model.validation = stats(eligible.filter(x => validationDates.has(x.date)).map(candidate => ({ candidate, outcome: outcome(candidate, model.config) })))
    model.validationScore = score(model.validation)
  }
  // A side is deployable only if it independently clears this gate on the
  // validation block.  Failed sides produce no live signals.
  return topTrain.filter(x => x.validation.trades >= 8 && x.validation.average > .10 && x.validation.bigWinRate >= 50)
    .sort((a, b) => b.validationScore - a.validationScore || b.trainScore - a.trainScore)[0] ?? null
}

const models = [optimize('BUY'), optimize('SELL')].filter(Boolean)
const selectedSignals = []
for (const model of models) {
  const sidePool = candidates.filter(x => x.side === model.side), eligible = sidePool.filter(x => model.rules.every(rule => passes(x, rule)))
  model.test = stats(eligible.filter(x => testDates.has(x.date)).map(candidate => ({ candidate, outcome: outcome(candidate, model.config) })))
  model.all = stats(eligible.map(candidate => ({ candidate, outcome: outcome(candidate, model.config) })))
  for (const candidate of eligible) selectedSignals.push({ candidate, outcome: outcome(candidate, model.config), model })
}
selectedSignals.sort((a, b) => a.candidate.date.localeCompare(b.candidate.date) || a.candidate.signalTime - b.candidate.signalTime || a.candidate.symbol.localeCompare(b.candidate.symbol))
const combinedTest = stats(selectedSignals.filter(x => testDates.has(x.candidate.date)))
const combinedAll = stats(selectedSignals)

const rows = selectedSignals.map(x => ({
  date: x.candidate.date, signal_time: stamp(x.candidate.signalTime), symbol: x.candidate.symbol, side: x.candidate.side,
  entry_time: stamp(x.candidate.entryTime), entry_price: round(x.candidate.entryPrice), exit_time: stamp(x.outcome.exitTime), exit_price: round(x.outcome.exitPrice),
  exit_reason: x.outcome.reason, return_pct: round(x.outcome.returnPct), mae_pct: round(x.outcome.maePct), split: trainDates.has(x.candidate.date) ? 'TRAIN' : validationDates.has(x.candidate.date) ? 'VALIDATION' : 'TEST'
}))
const stem = `${targetDates[0]}-to-${targetDates.at(-1)}-top20-live-signal-research`, report = uniqueFile(stem, 'json'), csvFile = uniqueFile(stem, 'csv'), cohortFile = uniqueFile(`${stem}-daily-cohort`, 'csv')
const output = {
  parameters: { sessions: SESSION_COUNT, targetDates, rankCutoff: RANK_CUTOFF, topN: TOP_N, rankLookbackSessions: LOOKBACK, signalFamily: 'first close crossing first-five-minute high/low from rank cutoff through signal end', signalEnd: SIGNAL_END, entry: 'next one-minute candle open', split: { train: targetDates.slice(0, 30), validation: targetDates.slice(30, 40), test: targetDates.slice(40) } },
  methodology: 'Causal features at signal close only. Daily top-20 is computed at the rank cutoff from five descending ranks over the current and prior 19 sessions. Models and exits fit on the first 30 sessions, selected on the next 10, and reported on an untouched final 10-session test.',
  models: models.map(x => ({ side: x.side, stopPct: x.config.stop, targetPct: x.config.target, maximumHoldMinutes: x.config.hold, rules: x.rules.map(r => ({ feature: r.feature, operator: r.operator, value: round(r.threshold) })), train: Object.fromEntries(Object.entries(x.train).map(([k, v]) => [k, typeof v === 'number' ? round(v) : v])), validation: Object.fromEntries(Object.entries(x.validation).map(([k, v]) => [k, typeof v === 'number' ? round(v) : v])), test: Object.fromEntries(Object.entries(x.test).map(([k, v]) => [k, typeof v === 'number' ? round(v) : v])), all: Object.fromEntries(Object.entries(x.all).map(([k, v]) => [k, typeof v === 'number' ? round(v) : v])) })),
  combinedTest: Object.fromEntries(Object.entries(combinedTest).map(([k, v]) => [k, typeof v === 'number' ? round(v) : v])), combinedAll: Object.fromEntries(Object.entries(combinedAll).map(([k, v]) => [k, typeof v === 'number' ? round(v) : v])), signals: rows
}
fs.writeFileSync(report, `${JSON.stringify(output, null, 2)}\n`, { flag: 'wx' })
const fields = Object.keys(rows[0] ?? { date: '' }); fs.writeFileSync(csvFile, `${[fields.join(','), ...rows.map(r => fields.map(f => csv(r[f])).join(','))].join('\n')}\n`, { flag: 'wx' })
const cohortRows = [...topByDate].flatMap(([date, xs]) => xs.map((x, index) => ({ date, position: index + 1, symbol: x.symbol, average_rank: round(x.averageRank), volume_rank: x.volumeRank, turnover_rank: x.turnoverRank, return_rank: x.returnRank, pvi_change_rank: x.pviChangeRank, pvi_angle_rank: x.pviAngleRank })))
const cohortFields = Object.keys(cohortRows[0]); fs.writeFileSync(cohortFile, `${[cohortFields.join(','), ...cohortRows.map(r => cohortFields.map(f => csv(r[f])).join(','))].join('\n')}\n`, { flag: 'wx' })
console.log(`\nSessions: ${targetDates[0]} to ${targetDates.at(-1)} | Raw candidates: ${candidates.length} | Selected signals: ${rows.length}`)
console.table(output.models.map(x => ({ Side: x.side, Stop: x.stopPct, Target: x.targetPct, Hold: x.maximumHoldMinutes, Rules: x.rules.map(r => `${r.feature}${r.operator}${r.value}`).join(' & '), 'Train trades': x.train.trades, 'Train total': x.train.total, 'Validation trades': x.validation.trades, 'Validation total': x.validation.total, 'Test trades': x.test.trades, 'Test win %': x.test.winRate, 'Test >0.2%': x.test.bigWinRate, 'Test avg %': x.test.average, 'Test total %': x.test.total })))
console.log('\nUntouched final 10-session test:'); console.table([output.combinedTest])
console.log('\nAll chronological signals:'); console.table(rows.map(x => ({ Date: x.date, Signal: x.signal_time.slice(11), Stock: x.symbol, Side: x.side, Entry: x.entry_time.slice(11), Exit: x.exit_time.slice(11), Reason: x.exit_reason, 'Return %': x.return_pct, 'MAE %': x.mae_pct, Split: x.split })))
console.log(`Report: ${report}\nSignals CSV: ${csvFile}\nDaily cohort CSV: ${cohortFile}`)
