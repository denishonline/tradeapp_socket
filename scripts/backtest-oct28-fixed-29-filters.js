import fs from 'node:fs'
import path from 'node:path'

const root = process.cwd()
const date = '2026-10-28'
const candidateFile = path.join(root, 'reports', `${date}-all-stocks-all-bullish-cross-next15-to-ema-downcross-overlap-2.json`)
const depthFile = path.join(root, 'reports', `${date}-11of12-depth-features-4.json`)
const ruleFile = path.join(root, 'reports', `${date}-cross15-fit-listed16.json`)

const candidates = JSON.parse(fs.readFileSync(candidateFile, 'utf8')).trades
const depthRows = JSON.parse(fs.readFileSync(depthFile, 'utf8')).rows
const rules = JSON.parse(fs.readFileSync(ruleFile, 'utf8')).candlePlusDepth.rules
const depthMap = new Map(depthRows.map(row => [`${row.symbol}|${row.startTime}|${row.signalTime}`, row]))

const minute = time => {
  const [hour, value] = time.split(':').map(Number)
  return hour * 60 + value
}
const round = (value, places = 4) => Number.isFinite(value) ? +value.toFixed(places) : null
const passes = (row, rule) => {
  const value = row[rule.feature]
  if (!Number.isFinite(value)) return false
  if (rule.op === '>=') return value >= rule.threshold
  if (rule.op === '<=') return value <= rule.threshold
  throw new Error(`Unsupported operator: ${rule.op}`)
}
const quote = value => `"${String(value ?? '').replaceAll('"', '""')}"`
const nextFile = (base, extension) => {
  let suffix = ''
  let number = 1
  let file
  do {
    file = path.join(root, 'reports', `${base}${suffix}.${extension}`)
    suffix = `-${++number}`
  } while (fs.existsSync(file))
  return file
}

const evaluated = candidates.map(candidate => {
  const depth = depthMap.get(`${candidate.symbol}|${candidate.startTime}|${candidate.signalTime}`)
  const row = {...candidate, startMinute: minute(candidate.startTime), ...(depth ?? {})}
  const failedFilters = rules.filter(rule => !passes(row, rule)).map(rule => `${rule.feature}${rule.op}${rule.threshold}`)
  return {...row, hasDepth: Boolean(depth), passed29: failedFilters.length === 0, failedFilters}
})

const signals = evaluated
  .filter(row => row.passed29)
  .sort((a, b) => a.signalTime.localeCompare(b.signalTime) || a.symbol.localeCompare(b.symbol))
  .map(row => ({
    date: row.date,
    symbol: row.symbol,
    crossoverTime: row.originTime,
    windowStartTime: row.startTime,
    signalTime: row.signalTime,
    entryTime: row.entryTime,
    entryPrice: row.entryPrice,
    exitTime: row.exitTime,
    exitPrice: row.exitPrice,
    exitReason: row.exitReason,
    holdMinutes: row.holdMinutes,
    returnPct: row.returnPct,
    maximumFavorableExcursionPct: row.maximumFavorableExcursionPct,
    maximumAdverseExcursionPct: row.maximumAdverseExcursionPct
  }))

const returns = signals.map(row => row.returnPct)
const wins = signals.filter(row => row.returnPct > 0)
const losses = signals.filter(row => row.returnPct <= 0)
const summary = {
  tradeCount: signals.length,
  winCount: wins.length,
  lossCount: losses.length,
  winRatePct: round(100 * wins.length / signals.length),
  averageReturnPct: round(returns.reduce((sum, value) => sum + value, 0) / signals.length),
  totalReturnPct: round(returns.reduce((sum, value) => sum + value, 0)),
  maximumAdverseExcursionPct: round(Math.min(...signals.map(row => row.maximumAdverseExcursionPct))),
  worstTrade: [...signals].sort((a, b) => a.returnPct - b.returnPct)[0],
  worstDay: {date, totalReturnPct: round(returns.reduce((sum, value) => sum + value, 0))}
}

const output = {
  date,
  mode: 'Chronological causal replay with frozen 29-filter thresholds',
  warning: 'The replay is chronological, but the thresholds were previously fitted on the same 2026-10-28 target examples and remain in-sample.',
  timing: 'After an EMA10 bullish crossover, the next 15 completed one-minute candles form the confirmation window; signal follows candle 15; entry is the following candle open; exit is the next open after EMA10 crosses below EMA20.',
  sources: {candidateFile: path.relative(root, candidateFile), depthFile: path.relative(root, depthFile), ruleFile: path.relative(root, ruleFile)},
  universe: {
    bullishCrossCandidates: evaluated.length,
    candidatesWithDepth: evaluated.filter(row => row.hasDepth).length,
    candidatesWithoutDepth: evaluated.filter(row => !row.hasDepth).length,
    ruleCount: rules.length
  },
  rules,
  summary,
  signals
}

const base = `${date}-fixed-29-filter-chronological-backtest`
const jsonFile = nextFile(base, 'json')
const csvFile = nextFile(base, 'csv')
fs.writeFileSync(jsonFile, `${JSON.stringify(output, null, 2)}\n`, {flag: 'wx'})

const columns = ['date', 'symbol', 'crossoverTime', 'windowStartTime', 'signalTime', 'entryTime', 'entryPrice', 'exitTime', 'exitPrice', 'exitReason', 'holdMinutes', 'returnPct', 'maximumFavorableExcursionPct', 'maximumAdverseExcursionPct']
const csv = [columns.map(quote).join(','), ...signals.map(row => columns.map(column => quote(row[column])).join(','))].join('\n')
fs.writeFileSync(csvFile, `${csv}\n`, {flag: 'wx'})

console.log(JSON.stringify({jsonFile, csvFile, universe: output.universe, summary, signals}, null, 2))
