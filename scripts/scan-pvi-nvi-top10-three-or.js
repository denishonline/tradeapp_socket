#!/usr/bin/env node

// Rank the complete candle universe by the same PVI/NVI-last-candles method
// used by rank-pvi-nvi-decline-last-candles.js, then apply the frozen three-OR
// short rule, plus its explicitly mirrored long rule, only to each day's
// top-ranked names.

import fs from 'node:fs'
import path from 'node:path'
import { load, featureRow } from './discover-0920-pvi-nvi-short-filter.js'

const ROOT = process.cwd()
const MARKET_OPEN = 555
const MARKET_CLOSE = 930
const SIGNAL_START = 556 // 09:17 availability; last completed candle is 09:16
const SIGNAL_END = 579   // 09:40 availability; last completed candle is 09:39
const DEFAULT_CANDLES = 3
const DEFAULT_TOP = 10
const DEFAULT_MODEL = path.join(ROOT, 'reports', '2026-10-26-to-2026-10-30-three-or-0917-0940-two-session-2.json')

const arg = name => {
  const i = process.argv.indexOf(name)
  return i < 0 ? null : process.argv[i + 1]
}
const optionalArg = name => {
  const i = process.argv.indexOf(name), value = i < 0 ? null : process.argv[i + 1]
  return value && !value.startsWith('--') ? value : null
}
const has = name => process.argv.includes(name)
const usage = [
  'Usage:',
  '  node scripts/scan-pvi-nvi-top10-three-or.js --date YYYY-MM-DD',
  '  node scripts/scan-pvi-nvi-top10-three-or.js --from YYYY-MM-DD --to YYYY-MM-DD',
  '',
  'Options:',
  '  --model PATH       Frozen model JSON (defaults to the saved three-OR model)',
  '  --rank-time HH:mm  Ranking cutoff (default 09:16; use completed candle time)',
  '  --candles N        PVI/NVI candles (default 3)',
  '  --top N            Number of ranked stocks (default 10)',
  '  --side MODE        sell, buy, or both (default both)',
  '  --stop-pct N       Protective stop as a positive percent (default 0.80; use 0 to disable)',
  '  --loss-filter [PATH] Use the matching default study, or an explicit study JSON',
  '  --no-loss-filter    Do not load a matching default loss-filter study',
  '  --json             Also print the complete result JSON after the tables',
  '  --help'
].join('\n')
const fail = message => { throw new Error(`${message}\n\n${usage}`) }
const round = (value, digits = 5) => Number.isFinite(value) ? +value.toFixed(digits) : null
const pct = (a, b) => b > 0 ? 100 * (a / b - 1) : NaN
const clock = minute => `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`
const parseClock = value => {
  if (!/^\d{2}:\d{2}$/.test(value ?? '')) fail('Time must use HH:mm')
  const minute = Number(value.slice(0, 2)) * 60 + Number(value.slice(3))
  if (!Number.isInteger(minute) || minute < MARKET_OPEN || minute >= MARKET_CLOSE) fail('Time must be from 09:15 through 15:29 IST')
  return minute
}
const parseDate = value => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value ?? '')) fail('Dates must use YYYY-MM-DD')
  const d = new Date(`${value}T00:00:00Z`)
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== value) fail(`Invalid date: ${value}`)
  return value
}
const dateRange = (from, to) => {
  const out = []
  for (let d = new Date(`${from}T00:00:00Z`); d <= new Date(`${to}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + 1)) out.push(d.toISOString().slice(0, 10))
  return out
}
const csvCell = value => {
  if (value == null) return ''
  const text = typeof value === 'object' ? JSON.stringify(value) : String(value)
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
}
const uniquePath = (directory, stem, extension) => {
  let suffix = 1
  let file
  do {
    file = path.join(ROOT, directory, `${stem}${suffix === 1 ? '' : `-${suffix}`}.${extension}`)
    suffix++
  } while (fs.existsSync(file))
  return file
}

if (has('--help')) {
  console.log(usage)
  process.exit(0)
}

const oneDate = arg('--date')
const fromArg = arg('--from')
const toArg = arg('--to')
if (oneDate && (fromArg || toArg)) fail('Use either --date or --from/--to, not both')
if (!oneDate && (!fromArg || !toArg)) fail('Provide --date YYYY-MM-DD or both --from and --to')
const from = parseDate(oneDate ?? fromArg)
const to = parseDate(oneDate ?? toArg)
if (from > to) fail('--from must be on or before --to')
const dates = dateRange(from, to)

const rankMinute = parseClock(arg('--rank-time') ?? '09:16')
const candleCount = Number(arg('--candles') ?? DEFAULT_CANDLES)
const top = Number(arg('--top') ?? DEFAULT_TOP)
const sideMode = (arg('--side') ?? 'both').toLowerCase()
const stopPct = Number(arg('--stop-pct') ?? 0.8)
if (!Number.isInteger(candleCount) || candleCount < 2) fail('--candles must be an integer of at least 2')
if (!Number.isInteger(top) || top < 1) fail('--top must be a positive integer')
if (!['sell', 'buy', 'both'].includes(sideMode)) fail('--side must be sell, buy, or both')
if (!Number.isFinite(stopPct) || stopPct < 0 || stopPct >= 100) fail('--stop-pct must be from 0 (disabled) to less than 100')
if (rankMinute >= SIGNAL_END) fail('--rank-time must be before the signal window ends')
// A ranking made later than 09:16 cannot be used to create an earlier signal.
// observedMinute is the label of the last completed candle; availability is
// one minute later.
const scanStartObservedMinute = Math.max(SIGNAL_START, rankMinute)

const modelFile = path.resolve(arg('--model') ?? DEFAULT_MODEL)
if (!fs.existsSync(modelFile)) fail(`Model file not found: ${modelFile}`)
const frozen = JSON.parse(fs.readFileSync(modelFile, 'utf8'))
const branches = frozen.model?.branches
if (!Array.isArray(branches) || !branches.length) fail('Model JSON does not contain model.branches')
const sides = sideMode === 'both' ? ['sell', 'buy'] : [sideMode]

// The long rules mirror the structure and thresholds of the saved short model:
// signed returns/gaps reverse sign and comparison, prior low becomes prior
// high, range remains a magnitude check, and the PVI/NVI drop guard becomes
// the corresponding gain guard. These are mirrored rules, not a buy-side fit.
const buyBranches = branches.map(branch => branch.map(rule => {
  if (rule.feature === 'windowRange') return { ...rule }
  if (rule.feature === 'pviNviAverageDrop') return { feature: 'pviNviAverageGain', op: rule.op, threshold: Math.abs(rule.threshold) }
  const feature = rule.feature === 'distancePrior60Low' ? 'distancePrior60High' : rule.feature
  return { feature, op: rule.op === 'lt' ? 'gt' : 'lt', threshold: -rule.threshold }
}))
const rulesFor = side => side === 'sell' ? branches : buyBranches

const lossStudySuffix = '-pvi-nvi-top10-both-three-or-0917-0940-causal-loss-filter-study.json'
function matchingLossStudy() {
  const exact = path.join(ROOT, 'reports', `${from}-to-${to}${lossStudySuffix}`)
  if (fs.existsSync(exact)) return exact
  // For --date, reuse a saved range study that contains the requested date.
  // This makes a day replay use the same frozen monthly filter as its range.
  if (from !== to || !fs.existsSync(path.join(ROOT, 'reports'))) return null
  const matches = fs.readdirSync(path.join(ROOT, 'reports'))
    .map(name => {
      const match = /^(\d{4}-\d{2}-\d{2})-to-(\d{4}-\d{2}-\d{2})-pvi-nvi-top10-both-three-or-0917-0940-causal-loss-filter-study\.json$/.exec(name)
      return match && match[1] <= from && match[2] >= to ? { file: path.join(ROOT, 'reports', name), from: match[1], to: match[2] } : null
    })
    .filter(Boolean)
    .sort((left, right) => (left.to.localeCompare(left.from)).localeCompare(right.to.localeCompare(right.from)) || left.file.localeCompare(right.file))
  return matches[0]?.file ?? null
}
const defaultLossFilter = matchingLossStudy()
const requestedLossFilter = has('--loss-filter')
const lossFilterValue = optionalArg('--loss-filter')
const lossFilterFile = has('--no-loss-filter') ? null : lossFilterValue ? path.resolve(lossFilterValue) : fs.existsSync(defaultLossFilter) ? defaultLossFilter : null
const lossFilters = new Map()
if (requestedLossFilter && !has('--no-loss-filter') && !lossFilterFile) fail(`No default loss-filter study exists for ${from} through ${to}. Create a matching study first, or provide --loss-filter PATH.`)
if (lossFilterFile) {
  if (!fs.existsSync(lossFilterFile)) fail(`Loss-filter JSON not found: ${lossFilterFile}`)
  const study = JSON.parse(fs.readFileSync(lossFilterFile, 'utf8'))
  if (!Array.isArray(study.studies)) fail('Loss-filter JSON must contain studies[]')
  for (const sideStudy of study.studies) {
    if (!['sell', 'buy'].includes(sideStudy.side) || !Array.isArray(sideStudy.clauses)) continue
    const clauses = sideStudy.clauses.filter(clause => Array.isArray(clause.rules) && clause.rules.length && clause.rules.every(rule => typeof rule.feature === 'string' && ['lt', 'gt'].includes(rule.op) && Number.isFinite(rule.threshold)))
    lossFilters.set(sideStudy.side, clauses)
  }
  if (!lossFilters.size) fail('Loss-filter JSON contains no valid BUY or SELL clauses')
}

function symbols() {
  const file = path.join(ROOT, 'db', 'stocks')
  if (fs.existsSync(file)) {
    try {
      return [...new Set(JSON.parse(fs.readFileSync(file, 'utf8')).map(value => String(value).trim().toUpperCase().replace(/-EQ$/, '')))]
        .filter(Boolean).sort()
    } catch {}
  }
  return fs.readdirSync(path.join(ROOT, 'db', 'candles'))
    .filter(fileName => fileName.endsWith('.jsonl') && fileName !== 'NIFTY50.jsonl')
    .map(fileName => fileName.slice(0, -6)).sort()
}

const universe = symbols()
const candleCache = new Map()
const candlesFor = symbol => {
  if (!candleCache.has(symbol)) candleCache.set(symbol, load(symbol))
  return candleCache.get(symbol)
}

// This uses the rank-pvi-nvi-decline-last-candles.js calculation in both
// directions: zero-volume rows are excluded and PVI/NVI are seeded at 1000 on
// the first selected genuine-volume candle. SELL ranks both-down names; BUY
// ranks both-up names.
function rankAt(date, side) {
  const selectedAt = rankMinute
  const rows = []
  for (const symbol of universe) {
    const all = candlesFor(symbol)
    const comparable = all.filter(row => row.date < date || (row.date === date && row.minute <= selectedAt))
    if (!comparable.some(row => row.date === date && row.minute === selectedAt)) continue
    const genuine = comparable.filter(row => row.v > 0)
    const selected = genuine.slice(-candleCount)
    if (selected.length !== candleCount || selected.at(-1).date !== date || selected.at(-1).minute !== selectedAt) continue
    let pvi = 1000, nvi = 1000
    for (let i = 1; i < selected.length; i++) {
      if (selected[i].v > selected[i - 1].v) pvi *= selected[i].c / selected[i - 1].c
      else if (selected[i].v < selected[i - 1].v) nvi *= selected[i].c / selected[i - 1].c
    }
    const pviChangePct = 100 * (pvi / 1000 - 1), nviChangePct = 100 * (nvi / 1000 - 1)
    const pviMovePct = side === 'sell' ? Math.max(0, -pviChangePct) : Math.max(0, pviChangePct)
    const nviMovePct = side === 'sell' ? Math.max(0, -nviChangePct) : Math.max(0, nviChangePct)
    if (!(pviMovePct > 0 && nviMovePct > 0)) continue
    rows.push({
      symbol, start: selected[0].stamp, end: selected.at(-1).stamp, pvi: round(pvi, 4), nvi: round(nvi, 4),
      pviMovePct: round(pviMovePct, 4), nviMovePct: round(nviMovePct, 4), averageMovePct: round((pviMovePct + nviMovePct) / 2), candles: selected,
    })
  }
  return rows.sort((a, b) => b.averageMovePct - a.averageMovePct || a.symbol.localeCompare(b.symbol)).slice(0, top).map((row, i) => ({ rank: i + 1, ...row }))
}

function outcome(day, observedMinute, side) {
  // Signal is available at observedMinute+1. Fill is the next completed
  // candle close, observedMinute+2. SELL profits from a lower price; BUY from
  // a higher price. A zero stopPct explicitly disables the protective stop.
  const entry = day.find(row => row.minute === observedMinute + 1)
  if (!entry || entry.v <= 0) return null
  const subsequent = day.filter(row => row.minute > observedMinute + 1)
  if (!subsequent.length) return null
  const targetPrice = entry.c * (side === 'sell' ? 0.98 : 1.02)
  const stopPrice = stopPct > 0 ? entry.c * (side === 'sell' ? 1 + stopPct / 100 : 1 - stopPct / 100) : null
  let cross = null, stop = null, target = null, previous = entry
  for (const row of subsequent) {
    const hitTarget = side === 'sell' ? row.l <= targetPrice : row.h >= targetPrice
    const hitStop = stopPrice != null && (side === 'sell' ? row.h >= stopPrice : row.l <= stopPrice)
    // OHLC data cannot establish the intrabar sequence. Treat a dual hit as
    // a stop, which avoids claiming an unobservable target fill.
    if (hitStop) { stop = { row, sameBarAsTarget: hitTarget }; break }
    if (hitTarget) { target = row; break }
    const crossed = side === 'sell'
      ? previous.ema[20] <= previous.ema[40] && row.ema[20] > row.ema[40]
      : previous.ema[20] >= previous.ema[40] && row.ema[20] < row.ema[40]
    if (crossed) { cross = row; break }
    previous = row
  }
  const pathRows = subsequent.filter(row => row.minute <= (stop?.row.minute ?? target?.minute ?? cross?.minute ?? day.at(-1).minute))
  const last = day.at(-1), crossFill = cross && day.find(row => row.minute === cross.minute + 1)
  const exitRow = stop?.row || target || crossFill || last
  if (!exitRow) return null
  const exitPrice = stop ? stopPrice : target ? targetPrice : exitRow.c
  const untilExit = subsequent.filter(row => row.minute <= exitRow.minute)
  const maxHigh = Math.max(entry.c, ...untilExit.map(row => row.h))
  const minLow = Math.min(entry.c, ...pathRows.map(row => row.l))
  for (let minute = observedMinute + 2; minute <= exitRow.minute; minute++) if (!day.some(row => row.minute === minute)) return null
  const grossReturnPct = side === 'sell' ? 100 * (entry.c - exitPrice) / entry.c : 100 * (exitPrice - entry.c) / entry.c
  const emaExitPrice = (crossFill || last).c
  return {
    signalTime: clock(observedMinute + 1), lastObservedCandle: clock(observedMinute), entryTime: clock(observedMinute + 2), entryPrice: entry.c,
    exitTime: stop || target ? `${clock(exitRow.minute)}-${clock(exitRow.minute + 1)}` : clock(exitRow.minute + 1), exitPrice,
    exitReason: stop ? stop.sameBarAsTarget ? 'STOP same bar as target' : 'STOP' : target ? '2% target' : cross ? side === 'sell' ? 'EMA20 crosses above EMA40' : 'EMA20 crosses below EMA40' : 'session close', targetHit: Boolean(target),
    grossReturnPct: round(grossReturnPct), after20BpsPct: round(grossReturnPct - 0.2),
    maePct: round(side === 'sell' ? 100 * (maxHigh - entry.c) / entry.c : 100 * (entry.c - minLow) / entry.c),
    mfePct: round(side === 'sell' ? 100 * (entry.c - minLow) / entry.c : 100 * (maxHigh - entry.c) / entry.c),
    oppositeCrossCandle: cross ? clock(cross.minute) : null,
    emaExitReturnPct: round(side === 'sell' ? 100 * (entry.c - emaExitPrice) / entry.c : 100 * (emaExitPrice - entry.c) / entry.c),
  }
}

const applies = (features, rules) => rules.every(rule => {
  const value = features[rule.feature]
  return Number.isFinite(value) && (rule.op === 'lt' ? value < rule.threshold : value > rule.threshold)
})

const directionalFeatures = (features, side) => side === 'sell'
  ? features
  : { ...features, pviNviAverageGain: -features.pviNviAverageDrop }

function priorDatesFor(rows, date) {
  return [...new Set(rows.filter(row => row.date < date).map(row => row.date))].sort().slice(-2)
}

async function scanDate(date, side) {
  const ranking = rankAt(date, side)
  if (!ranking.length) return { date, side, ranking: [], signals: [], filteredOut: [], skipped: 'No comparable top PVI/NVI rows at the requested ranking time' }
  const niftyAll = candlesFor('NIFTY50')
  const niftyPrior = priorDatesFor(niftyAll, date)
  const nifty = load('NIFTY50', [...niftyPrior, date])
  const signals = [], filteredOut = []
  for (const ranked of ranking) {
    const all = candlesFor(ranked.symbol), prior = priorDatesFor(all, date)
    if (prior.length < 2) continue
    const stock = load(ranked.symbol, [...prior, date]), day = stock.filter(row => row.date === date)
    for (let observedMinute = scanStartObservedMinute; observedMinute <= SIGNAL_END; observedMinute++) {
      const row = featureRow(date, ranked.symbol, stock, nifty, observedMinute)
      if (!row) continue
      const features = directionalFeatures(row.features, side)
      const branch = rulesFor(side).findIndex(rules => applies(features, rules))
      if (branch < 0) continue
      const lossClause = (lossFilters.get(side) ?? []).findIndex(clause => applies(features, clause.rules))
      if (lossClause >= 0) {
        filteredOut.push({ date, side, symbol: ranked.symbol, rank: ranked.rank, signalTime: clock(observedMinute + 1), branch: branch + 1, lossClause: lossClause + 1 })
        break // do not create a later, unstudied replacement signal for this stock-day
      }
      const future = outcome(day, observedMinute, side)
      if (!future) continue
      signals.push({ date, side, symbol: ranked.symbol, rank: ranked.rank, pviMovePct: ranked.pviMovePct, nviMovePct: ranked.nviMovePct, averageMovePct: ranked.averageMovePct, branch: branch + 1, ...future })
      break // one earliest signal per ranked stock-day
    }
  }
  return { date, side, ranking, signals, filteredOut }
}

const results = []
for (const [index, date] of dates.entries()) {
  // Keep long range runs readable: one updating line per trading date rather
  // than streaming every ranked stock or every candle decision.
  process.stdout.write(`[${index + 1}/${dates.length}] ${date}: ranking PVI/NVI top ${top} at ${clock(rankMinute)} and scanning ${clock(scanStartObservedMinute + 1)}-${clock(SIGNAL_END + 1)}... `)
  const dateResults = []
  for (const side of sides) dateResults.push(await scanDate(date, side))
  results.push(...dateResults)
  console.log(dateResults.map(result => `${result.side.toUpperCase()}: ${result.ranking.length} ranked, ${result.signals.length} signal${result.signals.length === 1 ? '' : 's'}${result.filteredOut.length ? `, ${result.filteredOut.length} filtered` : ''}`).join(' | ') + '.')
}
const signals = results.flatMap(result => result.signals).sort((a, b) => a.date.localeCompare(b.date) || a.signalTime.localeCompare(b.signalTime) || a.symbol.localeCompare(b.symbol))
const filteredSignals = results.flatMap(result => result.filteredOut).sort((a, b) => a.date.localeCompare(b.date) || a.signalTime.localeCompare(b.signalTime) || a.symbol.localeCompare(b.symbol))
const daily = dates.map(date => {
  const dayResults = results.filter(result => result.date === date), daySignals = dayResults.flatMap(result => result.signals)
  return { date, sellRanked: dayResults.find(result => result.side === 'sell')?.ranking.length ?? 0, buyRanked: dayResults.find(result => result.side === 'buy')?.ranking.length ?? 0, sellSignals: daySignals.filter(row => row.side === 'sell').length, buySignals: daySignals.filter(row => row.side === 'buy').length, filtered: dayResults.reduce((sum, result) => sum + result.filteredOut.length, 0), totalReturnPct: round(daySignals.reduce((sum, row) => sum + row.grossReturnPct, 0)) }
})
const summary = {
  dates: dates.length, sides, rankedDateSides: results.filter(result => result.ranking.length > 0).length, signalCount: signals.length, filteredSignalCount: filteredSignals.length,
  targetHits: signals.filter(row => row.targetHit).length, stoppedTrades: signals.filter(row => row.exitReason.startsWith('STOP')).length, profitableTrades: signals.filter(row => row.grossReturnPct > 0).length,
  winRatePct: signals.length ? round(100 * signals.filter(row => row.grossReturnPct > 0).length / signals.length) : null,
  averageReturnPct: signals.length ? round(signals.reduce((sum, row) => sum + row.grossReturnPct, 0) / signals.length) : null,
  totalReturnPct: round(signals.reduce((sum, row) => sum + row.grossReturnPct, 0)),
  totalAfter20BpsPct: round(signals.reduce((sum, row) => sum + row.after20BpsPct, 0)),
  maximumAdverseExcursionPct: signals.length ? round(Math.max(...signals.map(row => row.maePct))) : null,
  daily,
}
const output = {
  generatedAt: new Date().toISOString(), timezone: 'Asia/Kolkata', dates, rankTime: clock(rankMinute), requestedCandles: candleCount, top, stopPct,
  signalWindow: `${clock(scanStartObservedMinute + 1)}-${clock(SIGNAL_END + 1)} IST`, model: modelFile, lossFilter: lossFilterFile,
  method: 'SELL ranks both PVI and NVI declines and uses the frozen short rules, a 2% lower-price target, a protective stop, and an EMA20/40 bullish-cross exit. BUY ranks both PVI and NVI gains and uses the mirrored long rules, a 2% higher-price target, a protective stop, and an EMA20/40 bearish-cross exit. Features use two prior stock sessions and current candles through each decision. When both target and stop occur in one OHLC candle, the stop is used conservatively. An optional loss-filter rejects the earliest matching stock-day signal without replacing it with a later signal.',
  rules: { sell: branches, buyMirrored: buyBranches }, summary, results, filteredSignals,
}

const stem = `${from}-to-${to}-pvi-nvi-top${top}-${sideMode}-three-or-0917-0940`
const jsonFile = uniquePath('reports', stem, 'json')
const mdFile = uniquePath('reports', stem, 'md')
const csvFile = uniquePath('csv', stem, 'csv')
fs.mkdirSync(path.dirname(jsonFile), { recursive: true })
fs.mkdirSync(path.dirname(csvFile), { recursive: true })
fs.writeFileSync(jsonFile, `${JSON.stringify(output, null, 2)}\n`, { flag: 'wx' })
const csvHeaders = ['date', 'side', 'symbol', 'rank', 'signalTime', 'entryTime', 'branch', 'pviMovePct', 'nviMovePct', 'averageMovePct', 'entryPrice', 'exitTime', 'exitReason', 'grossReturnPct', 'targetHit', 'maePct']
fs.writeFileSync(csvFile, `${csvHeaders.join(',')}\n${signals.map(row => csvHeaders.map(key => csvCell(row[key])).join(',')).join('\n')}\n`, { flag: 'wx' })
const ruleText = rules => rules.map((branch, index) => `- ${index + 1}: ${branch.map(rule => `${rule.feature} ${rule.op === 'lt' ? '<' : '>'} ${rule.threshold}`).join(' AND ')}`)
const md = [
  `# PVI/NVI top-${top} ${sideMode} three-OR scan`, '',
  `Dates: ${from} through ${to} | ranking candles end ${clock(rankMinute)} IST | signal window ${clock(scanStartObservedMinute + 1)}-${clock(SIGNAL_END + 1)} IST | stop: ${stopPct ? `-${stopPct}%` : 'disabled'}`, '',
  `Model: ${modelFile}`, '',
  `Loss filter: ${lossFilterFile ?? 'none'}`, '',
  `Summary: ${JSON.stringify(summary)}`, '',
  'SELL rules:', '', ...ruleText(branches), '',
  'BUY mirrored rules:', '', ...ruleText(buyBranches), '',
  '| Date | Side | Stock | Rank | Signal | Entry | Branch | PVI/NVI move | Return | Exit |',
  '|---|---|---|---:|---|---|---:|---:|---:|---|',
  ...signals.map(row => `| ${row.date} | ${row.side.toUpperCase()} | ${row.symbol} | ${row.rank} | ${row.signalTime} | ${row.entryTime} | ${row.branch} | ${row.pviMovePct}% / ${row.nviMovePct}% | ${row.grossReturnPct}% | ${row.exitReason} |`), '',
  'The ranking is independently calculated for each date before its rule window. BUY rules are a structural mirror of the SELL rules, not separately fitted or validated. Returns are retrospective, use the next completed candle close for entry, a 2% target, and the configured protective stop. An optional loss-filter is outcome-fitted research and requires fresh-date validation.', '',
  `JSON: ${jsonFile}`, `CSV: ${csvFile}`,
].join('\n') + '\n'
fs.writeFileSync(mdFile, md, { flag: 'wx' })

console.log('\nSignals by date')
for (const result of results) {
  console.log(`\n${result.date} | ${result.side.toUpperCase()} | top-${top} ranked: ${result.ranking.length} | signals: ${result.signals.length}`)
  if (!result.signals.length) {
    console.log('No rule signal.')
    continue
  }
  console.table(result.signals.map(row => ({
    Stock: row.symbol,
    Rank: row.rank,
    [row.side === 'sell' ? 'PVI down %' : 'PVI up %']: row.pviMovePct,
    [row.side === 'sell' ? 'NVI down %' : 'NVI up %']: row.nviMovePct,
    Signal: row.signalTime,
    Entry: row.entryTime,
    Branch: row.branch,
    'Return %': row.grossReturnPct,
    Exit: row.exitReason,
  })))
}
console.log('\nDaily summary')
console.table(daily.map(row => ({ Date: row.date, 'SELL ranked': row.sellRanked, 'SELL signals': row.sellSignals, 'BUY ranked': row.buyRanked, 'BUY signals': row.buySignals, Filtered: row.filtered, 'Gross return %': row.totalReturnPct })))
console.log(`Totals: ${summary.signalCount} signals | filtered=${summary.filteredSignalCount} | wins=${summary.profitableTrades} | win rate=${summary.winRatePct ?? 'n/a'}% | average=${summary.averageReturnPct ?? 'n/a'}% | gross sum=${summary.totalReturnPct}% | max MAE=${summary.maximumAdverseExcursionPct ?? 'n/a'}%`)
console.log(`Reports: ${mdFile}\nJSON: ${jsonFile}\nCSV: ${csvFile}`)
if (has('--json')) console.log(JSON.stringify({ json: jsonFile, md: mdFile, csv: csvFile, summary, signals }, null, 2))

