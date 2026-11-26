#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'

const ROOT = process.cwd()
const REPORTS = path.join(ROOT, 'reports')
const DATES = ['2026-10-01','2026-10-05','2026-10-06','2026-10-07','2026-10-08','2026-10-09','2026-10-12','2026-10-13','2026-10-14','2026-10-15','2026-10-16','2026-10-19','2026-10-21','2026-10-22','2026-10-23','2026-10-26','2026-10-27','2026-10-28','2026-10-29','2026-10-30']
const TARGET = 1.10
const STOP = 1.30
const MIN_TRADES = 10
const MAX_DEPTH = 7
const BEAM_SIZE = 30000
const round = (value, places = 3) => Number.isFinite(value) ? +value.toFixed(places) : null
const toMinute = value => { const [h,m] = value.split(':').map(Number); return h * 60 + m }

function latestCsv(date) {
  const prefix = `${date}-top-movers-support-resistance-price-action-mtf-universe-first-signal`
  return fs.readdirSync(REPORTS)
    .filter(name => name.startsWith(prefix) && name.endsWith('.csv'))
    .map(name => path.join(REPORTS, name))
    .sort((a,b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0]
}

function load(date) {
  const file = latestCsv(date)
  if (!file) throw new Error(`Missing universe scan for ${date}`)
  const [header, ...lines] = fs.readFileSync(file, 'utf8').trim().split(/\r?\n/)
  const names = header.split(',')
  return lines.map(line => {
    const row = Object.fromEntries(line.split(',').map((value,index) => [names[index], value]))
    for (const key of ['entryPrice','mtfAligned','signalMoveFromOpenPct','breakoutDistancePct','volumeRatio10','efficiency10','returnToCutoffPct','mfePct','maePct']) row[key] = Number(row[key])
    for (const key of ['tf1','tf3','tf5','tf10','tf15']) row[key] = row[key] === 'true'
    return {...row, date, signalMinute: toMinute(row.signalTime)}
  })
}

const rows = DATES.flatMap(load)
const winner = row => row.mfePct >= TARGET && row.maePct > -STOP
const oct15Winner = row => row.date === '2026-10-15' && winner(row)
const conditions = []
const add = (name, test, group) => conditions.push({name, test, group})

for (const side of ['BUY','SELL']) add(`side=${side}`, row => row.side === side, 'side')
for (const family of ['OPENING_RANGE_BREAK','PRIOR_LEVEL_BREAK','LEVEL_RETEST']) add(`family=${family}`, row => row.family === family, 'family')
for (const level of [...new Set(rows.map(row => row.level))].sort()) add(`level=${level}`, row => row.level === level, 'level')
for (const tf of ['tf1','tf3','tf5','tf10','tf15']) add(`${tf}=true`, row => row[tf], tf)
for (const value of [3,4,5]) add(`mtf>=${value}`, row => row.mtfAligned >= value, 'mtfMin')

const numeric = [
  ['move', 'signalMoveFromOpenPct', [.5,.75,1,1.25,1.5,2,2.5,3,4]],
  ['breakout', 'breakoutDistancePct', [.03,.05,.075,.1,.15,.2,.25,.35,.5,.75,1]],
  ['volume', 'volumeRatio10', [.25,.5,.75,1,1.25,1.5,2,3,5]],
  ['efficiency', 'efficiency10', [.25,.4,.5,.6,.7,.8,.9,1,1.1]],
  ['time', 'signalMinute', [560,570,580,590,600,615,630]],
]
for (const [label,key,values] of numeric) for (const value of values) {
  add(`${label}>=${value}`, row => row[key] >= value, `${label}Min`)
  add(`${label}<=${value}`, row => row[key] <= value, `${label}Max`)
}

const masks = conditions.map(condition => rows.map((row,index) => condition.test(row) ? index : -1).filter(index => index >= 0))
const keyOf = indices => indices.join(',')
const evaluate = indices => {
  let wins = 0, hasOct15 = false
  for (const index of indices) { if (winner(rows[index])) wins++; if (oct15Winner(rows[index])) hasOct15 = true }
  const precision = wins / indices.length
  // Prefer precision, but retain larger samples when precision is close.
  const score = precision + Math.min(indices.length, 100) / 10000
  return {wins, precision, hasOct15, score}
}
const intersect = (left,right) => {
  const result=[]; let i=0,j=0
  while(i<left.length&&j<right.length){if(left[i]===right[j]){result.push(left[i]);i++;j++}else if(left[i]<right[j])i++;else j++}
  return result
}

let beam = [{indices: rows.map((_,index) => index), conditionIndexes: [], groups: new Set(), last: -1, ...evaluate(rows.map((_,index) => index))}]
const qualifying = []
for (let depth = 1; depth <= MAX_DEPTH; depth++) {
  const next = new Map()
  for (const state of beam) for (let ci = state.last + 1; ci < conditions.length; ci++) {
    const condition = conditions[ci]
    if (state.groups.has(condition.group)) continue
    const indices = intersect(state.indices, masks[ci])
    if (indices.length < MIN_TRADES) continue
    const stats = evaluate(indices)
    if (!stats.hasOct15) continue
    const signature = keyOf(indices)
    const candidate = {indices, conditionIndexes:[...state.conditionIndexes,ci],groups:new Set([...state.groups,condition.group]),last:ci,...stats}
    const prior = next.get(signature)
    if (!prior || candidate.conditionIndexes.length < prior.conditionIndexes.length) next.set(signature,candidate)
    if (stats.precision > .90) qualifying.push(candidate)
  }
  beam = [...next.values()].sort((a,b) => b.score-a.score || b.indices.length-a.indices.length).slice(0,BEAM_SIZE)
  const best = beam[0]
  console.error(`depth=${depth} states=${next.size} retained=${beam.length} best=${round(100*best.precision)}%/${best.indices.length}`)
  if (!beam.length) break
}

const distinct = new Map()
for (const state of qualifying) {
  const signature = keyOf(state.indices)
  const prior = distinct.get(signature)
  if (!prior || state.conditionIndexes.length < prior.conditionIndexes.length) distinct.set(signature,state)
}
const ranked = [...distinct.values()].sort((a,b) => b.indices.length-a.indices.length || b.precision-a.precision || a.conditionIndexes.length-b.conditionIndexes.length)
const best = ranked[0] ?? null
const bestPerfect = ranked.filter(state => state.wins === state.indices.length).sort((a,b) => b.indices.length-a.indices.length || a.conditionIndexes.length-b.conditionIndexes.length)[0] ?? null
function managedReturn(row) {
  if (winner(row)) return TARGET
  if (row.maePct <= -STOP) return -STOP
  return Math.max(-STOP, Math.min(TARGET,row.returnToCutoffPct))
}
function resultFor(state) {
  if (!state) return null
  const selected = state.indices.map(index => rows[index]).sort((a,b) => a.date.localeCompare(b.date) || a.signalTime.localeCompare(b.signalTime))
  const daily = DATES.map(date => {
    const trades = selected.filter(row => row.date === date)
    return {date,trades:trades.length,winners:trades.filter(winner).length,totalReturnPct:round(trades.reduce((sum,row)=>sum+managedReturn(row),0))}
  }).filter(day => day.trades)
  return {
    conditions: state.conditionIndexes.map(index => conditions[index].name),
    tradeCount: selected.length,
    winners: selected.filter(winner).length,
    winRatePct: round(100*selected.filter(winner).length/selected.length),
    averageReturnPct: round(selected.reduce((sum,row)=>sum+managedReturn(row),0)/selected.length),
    totalReturnPct: round(selected.reduce((sum,row)=>sum+managedReturn(row),0)),
    maximumAdverseExcursionPct: round(Math.min(...selected.map(row=>row.maePct))),
    worstDay: [...daily].sort((a,b)=>a.totalReturnPct-b.totalReturnPct)[0],
    daily,
    signals: selected.map(row => ({date:row.date,symbol:row.symbol,side:row.side,family:row.family,level:row.level,signalTime:row.signalTime,entryTime:row.entryTime,entryPrice:row.entryPrice,managedReturnPct:managedReturn(row),mfePct:round(row.mfePct),maePct:round(row.maePct),winner:winner(row)})),
  }
}
const output = {warning:'Full-October outcome-fitted discovery result; causal signals but not an independent out-of-sample validation.',targetPct:TARGET,stopPct:STOP,rawSignals:rows.length,qualifyingRuleCount:ranked.length,best:resultFor(best),bestPerfect:resultFor(bestPerfect),alternatives:ranked.slice(1,6).map(resultFor)}
const out = path.join(REPORTS,'2026-10-oct15-seeded-causal-deep-filter.json')
fs.writeFileSync(out,JSON.stringify(output,null,2)+'\n')
console.log(JSON.stringify(output,null,2))
