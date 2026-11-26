import fs from 'node:fs'
import path from 'node:path'

const root = process.cwd(), date = '2026-11-19', minuteMs = 60_000
const source = JSON.parse(fs.readFileSync(path.join(root, 'reports', `${date}-moderate-ask-rise-ema10-20-exits.json`), 'utf8'))
const startAt = Date.parse(`${date}T09:15:00+05:30`)
const clock = at => new Date(at + 330 * minuteMs).toISOString().slice(11, 16)
const round = (value, digits = 3) => Number(value.toFixed(digits))
const pct = (to, from) => 100 * (to / from - 1)
const mean = values => values.reduce((sum, value) => sum + value, 0) / (values.length || 1)

function candles(symbol) {
  return fs.readFileSync(path.join(root, 'db', 'candles', `${symbol}.jsonl`), 'utf8').split(/\r?\n/).flatMap(line => {
    try {
      const row = JSON.parse(line), at = +row.time * 1000
      return at >= startAt && clock(at) <= '15:29' ? [{ at, minute: clock(at), open: +row.open, high: +row.high, low: +row.low, close: +row.close, volume: +row.volume }] : []
    } catch { return [] }
  }).sort((a, b) => a.at - b.at)
}

function depth(symbol, endMinute) {
  const endAt = Date.parse(`${date}T${endMinute}:00+05:30`) + minuteMs
  const state = {}, snapshots = [], byMinute = new Map()
  for (const line of fs.readFileSync(path.join(root, 'db', 'cash-depth', date, symbol, `${symbol}.jsonl`), 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue
    let event; try { event = JSON.parse(line) } catch { continue }
    const at = Date.parse(event.receivedAt)
    if (!Number.isFinite(at)) continue
    if (at >= endAt) break
    if (event.kind === 'checkpoint' || event.book) for (const key of Object.keys(state)) delete state[key]
    Object.assign(state, event.data ?? {})
    if (at < startAt) continue
    let bid = 0, ask = 0, valid = true
    for (let level = 1; level <= 5; level++) {
      const bp = +state[`bid_price${level}`], ap = +state[`ask_price${level}`], bs = +state[`bid_size${level}`], as = +state[`ask_size${level}`]
      if (![bp, ap, bs, as].every(Number.isFinite) || bp <= 0 || ap <= bp) { valid = false; break }
      bid += bs; ask += as
    }
    if (!valid) continue
    const row = { minute: clock(at), askShare: 100 * ask / (bid + ask || 1), mid: (+state.bid_price1 + +state.ask_price1) / 2 }
    snapshots.push(row)
    if (!byMinute.has(row.minute)) byMinute.set(row.minute, [])
    byMinute.get(row.minute).push(row)
  }
  return { snapshots, byMinute }
}

function features(trade) {
  const rows = candles(trade.stock), [startMinute, endMinute] = trade.period.split('-')
  const signalIndex = rows.findIndex(row => row.minute === endMinute), startIndex = rows.findIndex(row => row.minute === startMinute)
  const history = rows.slice(0, signalIndex + 1), period = rows.slice(startIndex, signalIndex + 1), prior = rows.slice(Math.max(0, startIndex - 10), startIndex)
  let ema10 = history[0].close, ema20 = history[0].close
  for (const row of history.slice(1)) { ema10 += 2 / 11 * (row.close - ema10); ema20 += 2 / 21 * (row.close - ema20) }
  const points = [period[0].open, ...period.map(row => row.close)]
  let pathDistance = 0, upSteps = 0
  for (let index = 1; index < points.length; index++) { const move = points[index] - points[index - 1]; pathDistance += Math.abs(move); if (move > 0) upSteps++ }
  let peak = period[0].open, maxPullbackPct = 0
  for (const row of period) { peak = Math.max(peak, row.high); maxPullbackPct = Math.min(maxPullbackPct, pct(row.low, peak)) }
  const d = depth(trade.stock, endMinute), periodSnapshots = d.snapshots.filter(row => row.minute >= startMinute)
  const periodMinuteRows = [...d.byMinute].filter(([minute]) => minute >= startMinute).map(([minute, values]) => ({ minute, askShare: mean(values.map(row => row.askShare)), firstMid: values[0].mid, lastMid: values.at(-1).mid }))
  const allMinuteRows = [...d.byMinute].map(([minute, values]) => ({ minute, askShare: mean(values.map(row => row.askShare)), firstMid: values[0].mid, lastMid: values.at(-1).mid }))
  const half = Math.ceil(periodMinuteRows.length / 2), firstHalf = periodMinuteRows.slice(0, half), secondHalf = periodMinuteRows.slice(half)
  const maxHigh = Math.max(...period.map(row => row.high)), minLow = Math.min(...period.map(row => row.low)), last = period.at(-1)
  const slRiskPct = 100 * (trade.entry - trade.stop) / trade.entry
  return {
    stock: trade.stock, winner: trade.returnPct > 0.5, outcomePct: trade.returnPct,
    signalEndOffset: signalIndex, periodMinutes: period.length, askSharePct: trade.askSharePct,
    askDominantMinutePct: 100 * periodMinuteRows.filter(row => row.askShare >= 50).length / periodMinuteRows.length,
    ask55MinutePct: 100 * periodMinuteRows.filter(row => row.askShare >= 55).length / periodMinuteRows.length,
    askDominantSnapshotPct: 100 * periodSnapshots.filter(row => row.askShare >= 50).length / periodSnapshots.length,
    minMinuteAskSharePct: Math.min(...periodMinuteRows.map(row => row.askShare)),
    finalMinuteAskSharePct: periodMinuteRows.at(-1).askShare,
    askShareChangePct: periodMinuteRows.at(-1).askShare - periodMinuteRows[0].askShare,
    secondVsFirstAskSharePct: mean(secondHalf.map(row => row.askShare)) - mean(firstHalf.map(row => row.askShare)),
    depthMidMovePct: pct(periodSnapshots.at(-1).mid, periodSnapshots[0].mid),
    openingDepthAskSharePct: mean(allMinuteRows.slice(0, Math.min(3, allMinuteRows.length)).map(row => row.askShare)),
    signalRisePct: trade.signalRisePct,
    straightnessPct: pathDistance ? 100 * (points.at(-1) - points[0]) / pathDistance : 0,
    upStepPct: 100 * upSteps / period.length,
    greenCandlePct: 100 * period.filter(row => row.close > row.open).length / period.length,
    closeLocationPct: 100 * (last.close - minLow) / (maxHigh - minLow || 1),
    finalCandleCloseLocationPct: 100 * (last.close - last.low) / (last.high - last.low || 1),
    maxPullbackPct,
    volumeRatioPrior10: mean(period.map(row => row.volume)) / (mean(prior.map(row => row.volume)) || mean(period.map(row => row.volume))),
    finalVolumeRatioPrior10: last.volume / (mean(prior.map(row => row.volume)) || last.volume),
    emaGapBps: 10_000 * (ema10 - ema20) / last.close,
    priceVsEma10Pct: pct(last.close, ema10),
    returnFromOpenPct: pct(last.close, rows[0].open),
    slRiskPct
  }
}

const rows = source.trades.map(features)
const numeric = Object.keys(rows[0]).filter(key => !['stock', 'winner', 'outcomePct'].includes(key) && rows.every(row => Number.isFinite(row[key])))
const predicates = []
for (const key of numeric) {
  const values = [...new Set(rows.map(row => row[key]))].sort((a, b) => a - b)
  const thresholds = values.flatMap((value, index) => index ? [(value + values[index - 1]) / 2] : [])
  for (const threshold of thresholds) {
    predicates.push({ text: `${key} >= ${round(threshold)}`, test: row => row[key] >= threshold })
    predicates.push({ text: `${key} <= ${round(threshold)}`, test: row => row[key] <= threshold })
  }
}
const winners = rows.filter(row => row.winner).length
const candidates = []
function scoreRules(rules) {
  const selected = rows.filter(row => rules.every(rule => rule.test(row))), tp = selected.filter(row => row.winner).length, fp = selected.length - tp
  if (!selected.length) return
  candidates.push({ rules: rules.map(rule => rule.text), selected: selected.length, winners: tp, losers: fp, precisionPct: 100 * tp / selected.length, recallPct: 100 * tp / winners, stocks: selected.map(row => row.stock) })
}
for (const rule of predicates) scoreRules([rule])
const useful = predicates.filter(rule => { const selected = rows.filter(row => rule.test(row)); return selected.some(row => row.winner) && selected.length < rows.length })
for (let a = 0; a < useful.length; a++) for (let b = a + 1; b < useful.length; b++) scoreRules([useful[a], useful[b]])
candidates.sort((a, b) => b.precisionPct - a.precisionPct || b.winners - a.winners || a.rules.length - b.rules.length || b.recallPct - a.recallPct)
const perfectPrecision = candidates.filter(row => row.losers === 0).slice(0, 25)
const compactRows = rows.map(row => ({ stock: row.stock, winner: row.winner, outcomePct: row.outcomePct, signalEndOffset: row.signalEndOffset, periodMinutes: row.periodMinutes, askSharePct: round(row.askSharePct), askDominantMinutePct: round(row.askDominantMinutePct), ask55MinutePct: round(row.ask55MinutePct), askDominantSnapshotPct: round(row.askDominantSnapshotPct), finalMinuteAskSharePct: round(row.finalMinuteAskSharePct), signalRisePct: round(row.signalRisePct), straightnessPct: round(row.straightnessPct), closeLocationPct: round(row.closeLocationPct), maxPullbackPct: round(row.maxPullbackPct), volumeRatioPrior10: round(row.volumeRatioPrior10), emaGapBps: round(row.emaGapBps), returnFromOpenPct: round(row.returnFromOpenPct), slRiskPct: round(row.slRiskPct) }))
const report = { date, noFutureLeakage: 'Every feature uses candle/depth data received no later than the completed signal minute.', sample: { trades: rows.length, winners, losers: rows.length - winners, winnerDefinition: 'EMA/SL exit return > 0.5%' }, rows: compactRows, perfectPrecisionRules: perfectPrecision }
let suffix = 1, file
do { file = path.join(root, 'reports', `${date}-moderate-ask-rise-prefilter-discovery${suffix === 1 ? '' : `-${suffix}`}.json`); suffix++ } while (fs.existsSync(file))
fs.writeFileSync(file, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' })
console.table(compactRows)
console.log(JSON.stringify({ file, sample: report.sample, perfectPrecisionRules: perfectPrecision.slice(0, 12) }, null, 2))
