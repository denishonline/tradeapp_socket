import fs from 'node:fs'

const source = JSON.parse(fs.readFileSync('reports/2026-10-22-23-0930-weakness-bidirectional-research-5.json', 'utf8'))
const candidates = source.candidates
const predicates = [
  ['BUY', x => x.side === 'BUY'], ['SELL', x => x.side === 'SELL'],
  ...['09:35','09:40','09:45','09:50'].map(v => [`time>=${v}`, x => x.signalAt.slice(11) >= v]),
  ...['09:40','09:45','09:50','09:55'].map(v => [`time<${v}`, x => x.signalAt.slice(11) < v]),
  ...[.25,.35,.5].map(v => [`two>=${v}`, x => x.twoDirectionalPct >= v]),
  ...[.4,.6,.8].map(v => [`five>=${v}`, x => x.fiveDirectionalPct >= v]),
  ...[4,5].map(v => [`candles>=${v}`, x => x.directionalCandles5 >= v]),
  ...[55,60,65,70].map(v => [`depth>=${v}`, x => x.depthSharePct >= v]),
  ...[.02,.05,.1,.2].map(v => [`mid>=${v}`, x => x.depthMidMovePct >= v]),
  ...[0,.05,.1].map(v => [`nifty>=${v}`, x => x.nifty3DirectionalPct >= v]),
  ...[.1,.25,.4,.6].map(v => [`5m>=${v}`, x => x.completed5mDirectionalPct >= v]),
  ...[55,60,65,70].map(v => [`rsi>=${v}`, x => x.rsi14Directional >= v]),
  ...[.25,.5,1].map(v => [`vwap>=${v}`, x => x.priceVsVwapDirectionalPct >= v]),
  ...[.05,.1,.2].map(v => [`emaGap>=${v}`, x => x.ema10Vs20DirectionalPct >= v]),
  ...[.8,1,1.2,1.5].map(v => [`vol>=${v}`, x => x.recentVolumeRatio >= v]),
  ...[0,.25,.5,1].map(v => [`from0930>=${v}`, x => x.versus0930Pct >= v]),
]
function pick(date, tests) {
  const output = new Map()
  for (const x of candidates) {
    if (x.date !== date || !tests.every(t => t[1](x))) continue
    if (!output.has(x.symbol)) output.set(x.symbol, x)
  }
  return [...output.values()]
}
const stat = rows => ({ trades: rows.length, wins: rows.filter(x => x.reason === 'TARGET').length, winRate: rows.length ? 100 * rows.filter(x => x.reason === 'TARGET').length / rows.length : 0, total: rows.reduce((s,x)=>s+x.returnPct,0) })
let beam = [{ tests: [], used: -1 }], qualified = []
for (let depth = 1; depth <= 6; depth++) {
  const next = []
  for (const item of beam) for (let i = item.used + 1; i < predicates.length; i++) {
    const tests = [...item.tests, predicates[i]], rows = pick('2026-10-22', tests), s = stat(rows)
    if (s.trades < 4) continue
    const candidate = { tests, used: i, train: s }
    if (s.winRate >= 90) qualified.push(candidate)
    next.push(candidate)
  }
  next.sort((a,b) => b.train.winRate-a.train.winRate || b.train.wins-a.train.wins || b.train.trades-a.train.trades)
  const seen = new Set(); beam=[]
  for (const x of next) { const key=x.tests.map(t=>t[0]).join('|'); if(!seen.has(key)){seen.add(key);beam.push(x)} if(beam.length>=1000)break }
}
for (const q of qualified) { q.holdout=stat(pick('2026-10-23',q.tests)); q.combined=stat([...pick('2026-10-22',q.tests),...pick('2026-10-23',q.tests)]); q.signals=[...pick('2026-10-22',q.tests),...pick('2026-10-23',q.tests)].map(x=>`${x.date} ${x.symbol} ${x.side} ${x.signalAt.slice(11)} ${x.reason}`) }
qualified.sort((a,b)=>b.holdout.winRate-a.holdout.winRate||b.holdout.wins-a.holdout.wins||b.combined.winRate-a.combined.winRate)
const compact = qualified.slice(0,20).map(x=>({rule:x.tests.map(t=>t[0]),train:x.train,holdout:x.holdout,combined:x.combined}))
const balanced = qualified.find(x => x.tests.map(t=>t[0]).join('|') === 'time>=09:45|time<09:50|candles>=4|nifty>=0|vol>=0.8')
const ultra = qualified.find(x => x.tests.map(t=>t[0]).join('|') === 'time<09:40|two>=0.25|depth>=70|mid>=0.1|nifty>=0')
const detailedStat = rows => {
  const byDay = [...new Set(rows.map(x => x.date))].map(date => ({ date, ...stat(rows.filter(x => x.date === date)) }))
  return { ...stat(rows), average: rows.length ? rows.reduce((s,x)=>s+x.returnPct,0)/rows.length : 0,
    maximumAdverseExcursionPct: rows.length ? Math.min(...rows.map(x=>x.maxAdverseExcursionPct)) : null,
    worstDay: byDay.sort((a,b)=>a.total-b.total)[0] ?? null }
}
let reportFile = 'reports/2026-10-22-23-0930-high-precision-rule.json', suffix = 2
while (fs.existsSync(reportFile)) reportFile = `reports/2026-10-22-23-0930-high-precision-rule-${suffix++}.json`
let csvFile = 'reports/2026-10-22-23-0930-high-precision-signals.csv'; suffix = 2
while (fs.existsSync(csvFile)) csvFile = `reports/2026-10-22-23-0930-high-precision-signals-${suffix++}.csv`
const profile = (name, selected) => {
  const signals = selected ? [...pick('2026-10-22',selected.tests),...pick('2026-10-23',selected.tests)] : []
  return { name, rule: selected?.tests.map(t=>t[0]) ?? [], train: detailedStat(signals.filter(x=>x.date==='2026-10-22')),
    holdout: detailedStat(signals.filter(x=>x.date==='2026-10-23')), combined: detailedStat(signals), signals }
}
const profiles = [profile('ULTRA_SELECTIVE', ultra), profile('BALANCED_90_PLUS', balanced)]
const report = { caveat: 'Exploratory result from only two sessions. Rule predicates were selected on 2026-10-22; 2026-10-23 was evaluated afterward but many candidate rules were searched, so validation on additional unseen sessions is required.', profiles }
fs.writeFileSync(reportFile, `${JSON.stringify(report,null,2)}\n`, {flag:'wx'})
const cols=['date','symbol','side','signalAt','entryAt','entryPrice','exitAt','exitPrice','reason','returnPct','maxAdverseExcursionPct','directionalCandles5','nifty3DirectionalPct','recentVolumeRatio','twoDirectionalPct','fiveDirectionalPct','depthSharePct','depthMidMovePct']
fs.writeFileSync(csvFile, `profile,${cols.join(',')}\n${profiles.flatMap(p=>p.signals.map(x=>[p.name,...cols.map(k=>x[k]??'')].join(','))).join('\n')}\n`, {flag:'wx'})
console.log(JSON.stringify({predicateCount:predicates.length,qualifiedTrainRules:qualified.length,best:compact.slice(0,5),profiles:profiles.map(p=>({name:p.name,rule:p.rule,train:p.train,holdout:p.holdout,combined:p.combined,signals:p.signals.map(x=>`${x.date} ${x.symbol} ${x.side} ${x.signalAt.slice(11)} ${x.reason}`)})),reportFile,csvFile},null,2))
