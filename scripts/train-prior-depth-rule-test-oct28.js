import fs from 'node:fs'
import path from 'node:path'

const root = process.cwd()
const trainFiles = ['2026-10-26-11of12-depth-features.json', '2026-10-27-11of12-depth-features.json'].map(x => path.join(root, 'reports', x))
const testFile = path.join(root, 'reports', '2026-10-28-11of12-depth-features.json')
const train = trainFiles.flatMap(file => JSON.parse(fs.readFileSync(file, 'utf8')).rows)
const test = JSON.parse(fs.readFileSync(testFile, 'utf8')).rows
const round = (x, p = 4) => Number.isFinite(x) ? +x.toFixed(p) : null
const mean = a => a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN
const std = a => { const m = mean(a); return Math.sqrt(mean(a.map(x => (x - m) ** 2))) }
const quantile = (a, p) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor((s.length - 1) * p)] }
const features = [
  'bidShareMean','bidShareMedian','bidShareP25','bidShareP75','bidShareStd','bidShareLast','bidShareDelta','bidShareLateVsEarly',
  'bidAbove50Pct','bidAbove55Pct','bidAbove60Pct','topBidShareMean','orderBidShareMean','spreadMeanBps','spreadMaxBps',
  'midReturnPct','midRangePct','bidSizeLateVsEarlyPct','askSizeLateVsEarlyPct','bookRatioLateVsEarly','conditionsPassed',
  'maxConfirmationPullbackPct','confirmationClosesAboveVwap','confirmationAdvanceVolumeRatio',
]

const conditions = []
for (const feature of features) {
  const values = train.map(x => x[feature]).filter(Number.isFinite)
  for (const p of [.1,.2,.3,.4,.5,.6,.7,.8,.9]) {
    const threshold = quantile(values, p)
    conditions.push({ feature, op: '>=', threshold, pass: x => Number.isFinite(x[feature]) && x[feature] >= threshold })
    conditions.push({ feature, op: '<=', threshold, pass: x => Number.isFinite(x[feature]) && x[feature] <= threshold })
  }
}

function evaluate(rule, rows) {
  const selected = rows.filter(x => rule.every(c => c.pass(x))), returns = selected.map(x => x.returnPct)
  const average = mean(returns), deviation = std(returns), count = selected.length
  return {
    rule, selected, count,
    winRatePct: count ? 100 * selected.filter(x => x.returnPct > 0).length / count : 0,
    averageReturnPct: average,
    totalReturnPct: returns.reduce((s, x) => s + x, 0),
    lowerMeanScore: count ? average - .5 * deviation / Math.sqrt(count) : -Infinity,
  }
}
function eligible(x) { return x.count >= 30 && x.winRatePct >= 50 && x.averageReturnPct > 0 }
function compare(a, b) { return b.lowerMeanScore - a.lowerMeanScore || b.averageReturnPct - a.averageReturnPct || b.count - a.count }

let singles = conditions.map(c => evaluate([c], train)).filter(eligible).sort(compare).slice(0, 80)
let pairs = []
for (let i = 0; i < singles.length; i++) for (let j = i + 1; j < singles.length; j++) {
  if (singles[i].rule[0].feature === singles[j].rule[0].feature) continue
  const x = evaluate([singles[i].rule[0], singles[j].rule[0]], train)
  if (eligible(x)) pairs.push(x)
}
pairs.sort(compare); pairs = pairs.slice(0, 100)
let triples = []
for (const pair of pairs.slice(0, 60)) for (const single of singles.slice(0, 60)) {
  if (pair.rule.some(x => x.feature === single.rule[0].feature)) continue
  const x = evaluate([...pair.rule, single.rule[0]], train)
  if (eligible(x)) triples.push(x)
}
const pool = [...singles, ...pairs, ...triples].sort(compare)
if (!pool.length) throw new Error('No prior-session rule met minimum training requirements.')
const chosen = pool[0], tested = evaluate(chosen.rule, test)
const describe = x => ({ feature: x.feature, op: x.op, threshold: round(x.threshold) })
const stats = x => ({ tradeCount:x.count, winRatePct:round(x.winRatePct), averageReturnPct:round(x.averageReturnPct), totalReturnPct:round(x.totalReturnPct), maximumAdverseExcursionPct:x.selected.length?round(Math.min(...x.selected.map(r=>r.maximumAdverseExcursionPct))):null })
const output = {
  chronology: 'Depth filter selected exclusively from 26–27 October outcomes; thresholds then frozen and applied unchanged to 28 October.',
  limitation: 'The underlying 11-of-12 candle rule was originally developed from 28 October examples. Therefore only the added depth layer is genuinely held out on 28 October.',
  trainingDates:['2026-10-26','2026-10-27'], testDate:'2026-10-28', trainingRows:train.length, testRows:test.length,
  selectionPolicy:'At most three numeric filters; at least 30 training signals, >=50% training win rate, positive training average; maximize average-return lower-confidence score.',
  frozenRule:chosen.rule.map(describe), training:stats(chosen), test:stats(tested),
  testSignals:tested.selected.map(x=>({symbol:x.symbol,signalTime:x.signalTime,entryTime:x.entryTime,exitTime:x.exitTime,conditionsPassed:x.conditionsPassed,failedRule:x.failedRule,returnPct:x.returnPct,maximumAdverseExcursionPct:x.maximumAdverseExcursionPct})),
}
let n=1,file
do { file=path.join(root,'reports',`2026-10-26-27-trained-depth-rule-tested-2026-10-28${n===1?'':`-${n}`}.json`);n++ } while(fs.existsSync(file))
fs.writeFileSync(file,JSON.stringify(output,null,2)+'\n',{flag:'wx'})
const csvFile=file.replace(/\.json$/,'.csv'),columns=['symbol','signalTime','entryTime','exitTime','conditionsPassed','failedRule','returnPct','maximumAdverseExcursionPct'];fs.writeFileSync(csvFile,[columns.join(','),...output.testSignals.map(x=>columns.map(k=>x[k]??'').join(','))].join('\n')+'\n',{flag:'wx'})
console.log(JSON.stringify({file,csvFile,frozenRule:output.frozenRule,training:output.training,test:output.test,testSignals:output.testSignals},null,2))
