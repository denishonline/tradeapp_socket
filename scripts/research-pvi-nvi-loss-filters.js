#!/usr/bin/env node

// Research only: find causal, indicator-based rejection clauses for an existing
// PVI/NVI signal CSV. Clauses are fitted on the supplied historical outcomes;
// they must not be treated as forward-validated trading rules.

import fs from 'node:fs'
import path from 'node:path'
import { load, featureRow } from './discover-0920-pvi-nvi-short-filter.js'

const ROOT = process.cwd()
const DEFAULT_CSV = path.join(ROOT, 'csv', '2026-10-01-to-2026-10-30-pvi-nvi-top10-both-three-or-0917-0940.csv')
const arg = name => {
  const index = process.argv.indexOf(name)
  return index < 0 ? null : process.argv[index + 1]
}
const has = name => process.argv.includes(name)
const usage = [
  'Usage: node scripts/research-pvi-nvi-loss-filters.js [--csv PATH] [--max-clauses 12]',
  '',
  'Fits zero-winner-loss clauses separately for BUY and SELL signals. Every feature',
  'is calculated from candles available at the original signal time only.'
].join('\n')
const fail = message => { throw new Error(`${message}\n\n${usage}`) }
const round = (value, digits = 5) => Number.isFinite(value) ? +value.toFixed(digits) : null
const bits = value => { let x = value >>> 0, count = 0; while (x) { x &= x - 1; count++ } return count }
const maskKey = mask => `${mask.lo >>> 0}:${mask.hi >>> 0}`
const andMask = (left, right) => ({ lo: (left.lo & right.lo) >>> 0, hi: (left.hi & right.hi) >>> 0 })
const andNotMask = (left, right) => ({ lo: (left.lo & ~right.lo) >>> 0, hi: (left.hi & ~right.hi) >>> 0 })
const orMask = (left, right) => ({ lo: (left.lo | right.lo) >>> 0, hi: (left.hi | right.hi) >>> 0 })
const maskCount = mask => bits(mask.lo) + bits(mask.hi)
const emptyMask = () => ({ lo: 0, hi: 0 })
const bitFor = index => index < 32 ? { lo: (1 << index) >>> 0, hi: 0 } : { lo: 0, hi: (1 << (index - 32)) >>> 0 }
const clockMinute = value => Number(value.slice(0, 2)) * 60 + Number(value.slice(3, 5))
const csvCell = value => {
  if (value == null) return ''
  const text = String(value)
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
}
const uniquePath = (directory, stem, extension) => {
  let suffix = 1, file
  do {
    file = path.join(ROOT, directory, `${stem}${suffix === 1 ? '' : `-${suffix}`}.${extension}`)
    suffix++
  } while (fs.existsSync(file))
  return file
}

function parseCsv(text) {
  const rows = []
  let row = [], cell = '', quoted = false
  for (let i = 0; i < text.length; i++) {
    const char = text[i]
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') { cell += '"'; i++ }
      else if (char === '"') quoted = false
      else cell += char
      continue
    }
    if (char === '"') quoted = true
    else if (char === ',') { row.push(cell); cell = '' }
    else if (char === '\n') { row.push(cell.replace(/\r$/, '')); rows.push(row); row = []; cell = '' }
    else cell += char
  }
  if (cell || row.length) { row.push(cell.replace(/\r$/, '')); rows.push(row) }
  const headers = rows.shift()
  if (!headers?.length) fail('CSV has no header row')
  return rows.filter(values => values.some(Boolean)).map(values => Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ''])))
}

if (has('--help')) { console.log(usage); process.exit(0) }
const source = path.resolve(arg('--csv') ?? DEFAULT_CSV)
if (!fs.existsSync(source)) fail(`CSV not found: ${source}`)
const maxClauses = Number(arg('--max-clauses') ?? 12)
if (!Number.isInteger(maxClauses) || maxClauses < 1 || maxClauses > 30) fail('--max-clauses must be an integer from 1 to 30')
const signals = parseCsv(fs.readFileSync(source, 'utf8')).map((row, sourceIndex) => ({ ...row, sourceIndex, grossReturnPct: Number(row.grossReturnPct) }))
if (!signals.length) fail('CSV has no signal rows')
if (signals.some(row => !['buy', 'sell'].includes(row.side) || !Number.isFinite(row.grossReturnPct))) fail('CSV must include side and numeric grossReturnPct columns')

const candleCache = new Map()
const candlesFor = symbol => {
  if (!candleCache.has(symbol)) candleCache.set(symbol, load(symbol))
  return candleCache.get(symbol)
}
const priorDatesFor = (rows, date) => [...new Set(rows.filter(row => row.date < date).map(row => row.date))].sort().slice(-2)
const stockSessionCache = new Map()
const stockAt = (symbol, date) => {
  const key = `${symbol}|${date}`
  if (stockSessionCache.has(key)) return stockSessionCache.get(key)
  const all = candlesFor(symbol), prior = priorDatesFor(all, date)
  const value = prior.length === 2 ? load(symbol, [...prior, date]) : null
  stockSessionCache.set(key, value)
  return value
}
const niftyCache = new Map()
const niftyAt = date => {
  if (niftyCache.has(date)) return niftyCache.get(date)
  const all = candlesFor('NIFTY50'), prior = priorDatesFor(all, date)
  const value = prior.length === 2 ? load('NIFTY50', [...prior, date]) : null
  niftyCache.set(date, value)
  return value
}

function causalFeatures(signal) {
  const stock = stockAt(signal.symbol, signal.date), nifty = niftyAt(signal.date)
  const observedMinute = clockMinute(signal.signalTime) - 1
  if (!stock || !nifty) return null
  const row = featureRow(signal.date, signal.symbol, stock, nifty, observedMinute)
  if (!row) return null
  const features = { ...row.features }
  // These are known at the fixed ranking time, before the first signal.
  for (const key of ['pviMovePct', 'nviMovePct', 'averageMovePct']) {
    const value = Number(signal[key])
    if (Number.isFinite(value)) features[key] = value
  }
  // The buy-side model uses this directional version of the same causal PVI/NVI
  // calculation. It is included as a possible rejection indicator for BUY only.
  if (signal.side === 'buy' && Number.isFinite(features.pviNviAverageDrop)) features.pviNviAverageGain = -features.pviNviAverageDrop
  return features
}

console.log(`Loading ${signals.length} historical signals and rebuilding causal indicator snapshots...`)
const rows = []
for (const [index, signal] of signals.entries()) {
  const features = causalFeatures(signal)
  if (!features) continue
  rows.push({ ...signal, features, winner: signal.grossReturnPct > 0 })
  if ((index + 1) % 20 === 0 || index + 1 === signals.length) process.stdout.write(` ${index + 1}/${signals.length}`)
}
console.log()
if (rows.length !== signals.length) console.log(`Skipped ${signals.length - rows.length} signals without two prior sessions or a causal feature snapshot.`)

function featureNamesFor(group) {
  const excluded = new Set(['return0916to0920']) // duplicate of an opening-window return label; keep independent measures.
  return [...new Set(group.flatMap(row => Object.keys(row.features)))].filter(name => !excluded.has(name) && group.every(row => Number.isFinite(row.features[name])))
}

function buildAtoms(group, names) {
  const atomsByMask = new Map()
  for (const feature of names) {
    const values = [...new Set(group.map(row => row.features[feature]))].sort((a, b) => a - b)
    for (let valueIndex = 0; valueIndex < values.length - 1; valueIndex++) {
      const threshold = (values[valueIndex] + values[valueIndex + 1]) / 2
      for (const op of ['lt', 'gt']) {
        let mask = emptyMask()
        group.forEach((row, index) => {
          if (op === 'lt' ? row.features[feature] < threshold : row.features[feature] > threshold) mask = orMask(mask, bitFor(index))
        })
        if (!maskCount(mask) || maskCount(mask) === group.length) continue
        const key = maskKey(mask), atom = { rules: [{ feature, op, threshold: round(threshold, 8) }], mask }
        // The same set may be produced by several indicators. Keep the first
        // deterministic form; exact-mask duplication does not improve coverage.
        if (!atomsByMask.has(key)) atomsByMask.set(key, atom)
      }
    }
  }
  return [...atomsByMask.values()]
}

function pureCandidates(group, names) {
  const winnerMask = group.reduce((mask, row, index) => row.winner ? orMask(mask, bitFor(index)) : mask, emptyMask())
  const lossMask = group.reduce((mask, row, index) => !row.winner ? orMask(mask, bitFor(index)) : mask, emptyMask())
  const atoms = buildAtoms(group, names)
  const candidates = new Map()
  const add = candidate => {
    const rejectedWinners = andMask(candidate.mask, winnerMask)
    const rejectedLosses = andMask(candidate.mask, lossMask)
    if (maskCount(rejectedWinners) || !maskCount(rejectedLosses)) return
    const key = maskKey(rejectedLosses), previous = candidates.get(key)
    if (!previous || candidate.rules.length < previous.rules.length) candidates.set(key, { ...candidate, lossMask: rejectedLosses })
  }
  atoms.forEach(add)
  // Pair conjunctions let a rejection clause isolate a loss without discarding
  // any winner. This is bounded to two conditions to keep rules inspectable.
  for (let i = 0; i < atoms.length; i++) {
    for (let j = i + 1; j < atoms.length; j++) {
      const mask = andMask(atoms[i].mask, atoms[j].mask)
      if (!maskCount(mask)) continue
      add({ rules: [...atoms[i].rules, ...atoms[j].rules], mask })
    }
  }
  return { atoms: atoms.length, candidates: [...candidates.values()], lossMask, winnerMask }
}

function chooseClauses(candidates, lossUniverse, limit) {
  let uncovered = lossUniverse, covered = emptyMask()
  const chosen = []
  while (maskCount(uncovered) && chosen.length < limit) {
    let best = null, bestCoverage = 0
    for (const candidate of candidates) {
      const newLosses = andMask(candidate.lossMask, uncovered), coverage = maskCount(newLosses)
      if (!coverage) continue
      if (!best || coverage > bestCoverage || (coverage === bestCoverage && candidate.rules.length < best.rules.length)) {
        best = candidate
        bestCoverage = coverage
      }
    }
    if (!best) break
    chosen.push(best)
    covered = orMask(covered, best.lossMask)
    uncovered = andNotMask(uncovered, best.lossMask)
  }
  return { chosen, covered, uncovered }
}

function matchesClause(row, clause) {
  return clause.rules.every(rule => {
    const value = row.features[rule.feature]
    return Number.isFinite(value) && (rule.op === 'lt' ? value < rule.threshold : value > rule.threshold)
  })
}

const studies = []
for (const side of ['sell', 'buy']) {
  const group = rows.filter(row => row.side === side)
  const names = featureNamesFor(group)
  console.log(`${side.toUpperCase()}: testing ${names.length} causal numerical indicators over ${group.length} signals...`)
  const pool = pureCandidates(group, names)
  const selected = chooseClauses(pool.candidates, pool.lossMask, maxClauses)
  const removed = group.filter(row => selected.chosen.some(clause => matchesClause(row, clause)))
  const retained = group.filter(row => !removed.includes(row))
  studies.push({
    side, featureCount: names.length, featuresTested: names, atomCount: pool.atoms, pureCandidateCount: pool.candidates.length,
    clauses: selected.chosen.map(clause => ({ rules: clause.rules, rejectedLosses: maskCount(clause.lossMask) })),
    uncoveredLosses: maskCount(selected.uncovered),
    original: { trades: group.length, winners: group.filter(row => row.winner).length, losers: group.filter(row => !row.winner).length },
    removed: { trades: removed.length, winners: removed.filter(row => row.winner).length, losers: removed.filter(row => !row.winner).length },
    retained: { trades: retained.length, winners: retained.filter(row => row.winner).length, losers: retained.filter(row => !row.winner).length, totalReturnPct: round(retained.reduce((sum, row) => sum + row.grossReturnPct, 0)), averageReturnPct: retained.length ? round(retained.reduce((sum, row) => sum + row.grossReturnPct, 0) / retained.length) : null },
  })
}

const clausesBySide = Object.fromEntries(studies.map(study => [study.side, study.clauses]))
const annotated = rows.map(row => {
  const matchedClause = clausesBySide[row.side].findIndex(clause => matchesClause(row, clause))
  return { ...row, filteredOut: matchedClause >= 0, matchedClause: matchedClause >= 0 ? matchedClause + 1 : null }
})
const survivors = annotated.filter(row => !row.filteredOut)
const summary = {
  inputTrades: rows.length, inputWinners: rows.filter(row => row.winner).length, inputLosers: rows.filter(row => !row.winner).length,
  retainedTrades: survivors.length, retainedWinners: survivors.filter(row => row.winner).length, retainedLosers: survivors.filter(row => !row.winner).length,
  removedTrades: annotated.filter(row => row.filteredOut).length, removedWinners: annotated.filter(row => row.filteredOut && row.winner).length, removedLosers: annotated.filter(row => row.filteredOut && !row.winner).length,
  retainedWinRatePct: survivors.length ? round(100 * survivors.filter(row => row.winner).length / survivors.length) : null,
  retainedTotalReturnPct: round(survivors.reduce((sum, row) => sum + row.grossReturnPct, 0)),
  retainedAverageReturnPct: survivors.length ? round(survivors.reduce((sum, row) => sum + row.grossReturnPct, 0) / survivors.length) : null,
}

const stem = `${path.basename(source, '.csv')}-causal-loss-filter-study`
const jsonFile = uniquePath('reports', stem, 'json')
const mdFile = uniquePath('reports', stem, 'md')
const csvFile = uniquePath('csv', `${stem}-survivors`, 'csv')
fs.mkdirSync(path.dirname(jsonFile), { recursive: true })
fs.mkdirSync(path.dirname(csvFile), { recursive: true })
const output = {
  generatedAt: new Date().toISOString(), sourceCsv: source, scope: 'Historical causal feature study. Thresholds were selected using the supplied outcomes and are not forward validation.',
  maxClauses, summary, studies,
  filteredOut: annotated.filter(row => row.filteredOut).map(row => ({ date: row.date, side: row.side, symbol: row.symbol, signalTime: row.signalTime, grossReturnPct: row.grossReturnPct, winner: row.winner, matchedClause: row.matchedClause })),
}
fs.writeFileSync(jsonFile, `${JSON.stringify(output, null, 2)}\n`, { flag: 'wx' })

const originalHeaders = Object.keys(signals[0])
const survivorHeaders = [...originalHeaders, 'winner']
fs.writeFileSync(csvFile, `${survivorHeaders.join(',')}\n${survivors.map(row => survivorHeaders.map(key => csvCell(row[key])).join(',')).join('\n')}\n`, { flag: 'wx' })
const formatRule = rule => `${rule.feature} ${rule.op === 'lt' ? '<' : '>'} ${rule.threshold}`
const md = [
  '# Causal loss-filter study for PVI/NVI signals', '',
  `Source: ${source}`, '',
  `Summary: ${JSON.stringify(summary)}`, '',
  'Each rejection clause is applied only to its stated side. A signal is removed if it matches any clause for that side.', '',
  ...studies.flatMap(study => [
    `## ${study.side.toUpperCase()}`, '',
    `Indicators tested: ${study.featureCount}. Atomic patterns: ${study.atomCount}. Zero-winner rejection candidates: ${study.pureCandidateCount}.`, '',
    `Original: ${JSON.stringify(study.original)}. Removed: ${JSON.stringify(study.removed)}. Retained: ${JSON.stringify(study.retained)}. Uncovered losses: ${study.uncoveredLosses}.`, '',
    'Rejection clauses:', '',
    ...study.clauses.map((clause, index) => `${index + 1}. ${clause.rules.map(formatRule).join(' AND ')} — removes ${clause.rejectedLosses} historical loser(s) and zero historical winners.`), '',
    `Features: ${study.featuresTested.join(', ')}`, '',
  ]),
  '## Limitation', '',
  'All thresholds were fit after observing returns in this one CSV. The features are causal at each signal time, but the resulting clauses are in-sample and can overfit. They should be frozen and tested on later, untouched dates before being enabled in the live scanner.', '',
  `JSON: ${jsonFile}`, `Retained-signal CSV: ${csvFile}`,
].join('\n')
fs.writeFileSync(mdFile, `${md}\n`, { flag: 'wx' })

console.log(JSON.stringify({ json: jsonFile, md: mdFile, survivors: csvFile, summary, studies: studies.map(study => ({ side: study.side, featureCount: study.featureCount, clauses: study.clauses.length, uncoveredLosses: study.uncoveredLosses, removed: study.removed, retained: study.retained })) }, null, 2))

