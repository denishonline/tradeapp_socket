import fs from 'node:fs'

const sourceFile = process.argv[2] ?? 'reports/2026-10-22-23-0930-high-precision-context-2.json'
const rows = JSON.parse(fs.readFileSync(sourceFile, 'utf8')).signals
const ge = (label, key, values) => values.map(value => [`${label}>=${value}`, row => row[key] >= value])
const le = (label, key, values) => values.map(value => [`${label}<=${value}`, row => row[key] <= value])
const predicates = [
  ['BUY', x => x.side === 'BUY'], ['SELL', x => x.side === 'SELL'],
  ...['09:35','09:40','09:45','09:50'].map(v => [`time>=${v}`, x => x.signalAt.slice(11) >= v]),
  ...['09:40','09:45','09:50','09:55'].map(v => [`time<${v}`, x => x.signalAt.slice(11) < v]),
  ...ge('two','twoDirectionalPct',[.25,.35,.5]), ...ge('five','fiveDirectionalPct',[.4,.6,.8]),
  ...ge('candles','directionalCandles5',[4,5]), ...ge('depth','depthSharePct',[55,60,65,70]),
  ...ge('mid','depthMidMovePct',[.02,.05,.1,.2]), ...ge('nifty','nifty3DirectionalPct',[0,.05,.1]),
  ...ge('recentVol','recentVolumeRatio',[.8,1,1.2,1.5]),
  ...ge('ema50x200','ema50Vs200DirectionalPct',[0,.25,.5,1]),
  ...ge('priceEma50','priceVsEma50DirectionalPct',[0,.25,.5,1]),
  ...ge('priceEma200','priceVsEma200DirectionalPct',[0,.5,1,2]),
  ...ge('m3','move3mDirectionalPct',[0,.15,.3]), ...ge('m5','move5mDirectionalPct',[0,.2,.4]),
  ...ge('m10','move10mDirectionalPct',[0,.25,.5]), ...ge('m15','move15mDirectionalPct',[0,.25,.5]),
  ...ge('relativeVol','currentVsPriorSameTimeVolumeRatio',[.8,1,1.5]),
  ...le('relativeVol','currentVsPriorSameTimeVolumeRatio',[2,3,4]),
  ...ge('priorTrend','priorTwoSessionTrendDirectionalPct',[0,1,2]),
  ...ge('rangePosition','priorRangeDirectionalPositionPct',[50,100]),
  ...le('rangePosition','priorRangeDirectionalPositionPct',[125,150]),
]
function pick(date, tests) {
  const selected = new Map()
  for (const row of rows) {
    if (row.date !== date || !tests.every(test => test[1](row))) continue
    if (!selected.has(row.symbol)) selected.set(row.symbol, row)
  }
  return [...selected.values()]
}
const stat = selected => {
  const total = selected.reduce((sum,row)=>sum+row.returnPct,0)
  return { trades:selected.length, wins:selected.filter(x=>x.reason==='TARGET').length,
    winRatePct:selected.length ? Number((100*selected.filter(x=>x.reason==='TARGET').length/selected.length).toFixed(4)) : 0,
    averageReturnPct:selected.length ? Number((total/selected.length).toFixed(4)) : 0, totalReturnPct:Number(total.toFixed(4)),
    maximumAdverseExcursionPct:selected.length ? Math.min(...selected.map(x=>x.maxAdverseExcursionPct)) : null }
}
let beam=[{tests:[],used:-1}], qualified=[]
for(let depth=1;depth<=6;depth++){
  const next=[]
  for(const item of beam) for(let i=item.used+1;i<predicates.length;i++){
    const tests=[...item.tests,predicates[i]], trainRows=pick('2026-10-22',tests), train=stat(trainRows)
    if(train.trades<4) continue
    const candidate={tests,used:i,train}
    if(train.winRatePct>=90) qualified.push(candidate)
    next.push(candidate)
  }
  next.sort((a,b)=>b.train.winRatePct-a.train.winRatePct||b.train.wins-a.train.wins||b.train.trades-a.train.trades)
  beam=next.slice(0,1500)
}
for(const item of qualified){
  item.holdout=stat(pick('2026-10-23',item.tests))
  item.combined=stat([...pick('2026-10-22',item.tests),...pick('2026-10-23',item.tests)])
}
const robust=qualified.filter(x=>x.holdout.trades>=5).sort((a,b)=>b.holdout.winRatePct-a.holdout.winRatePct||b.holdout.wins-a.holdout.wins||b.combined.trades-a.combined.trades)
const trainOnlyBest=[...qualified].sort((a,b)=>b.train.winRatePct-a.train.winRatePct||b.train.trades-a.train.trades||a.tests.length-b.tests.length)[0]
const best=robust.slice(0,20).map(x=>({rule:x.tests.map(t=>t[0]),train:x.train,holdout:x.holdout,combined:x.combined}))
let outputFile='reports/2026-10-22-23-0930-high-precision-mtf-rule-search.json', suffix=2
while(fs.existsSync(outputFile)) outputFile=`reports/2026-10-22-23-0930-high-precision-mtf-rule-search-${suffix++}.json`
fs.writeFileSync(outputFile,`${JSON.stringify({sourceFile,predicateCount:predicates.length,qualifiedTrainRules:qualified.length,best},null,2)}\n`,{flag:'wx'})
const selected=robust[0]
const selectedRows=selected ? [...pick('2026-10-22',selected.tests),...pick('2026-10-23',selected.tests)] : []
const byDay=['2026-10-22','2026-10-23'].map(date=>({date,...stat(selectedRows.filter(x=>x.date===date))}))
const bySide=['BUY','SELL'].map(side=>({side,...stat(selectedRows.filter(x=>x.side===side))}))
let signalFile='reports/2026-10-22-23-0930-high-precision-mtf-signals.csv'; suffix=2
while(fs.existsSync(signalFile)) signalFile=`reports/2026-10-22-23-0930-high-precision-mtf-signals-${suffix++}.csv`
const columns=['date','symbol','side','signalAt','entryAt','entryPrice','exitAt','exitPrice','reason','returnPct','maxAdverseExcursionPct','directionalCandles5','twoDirectionalPct','ema50Vs200DirectionalPct','priceVsEma50DirectionalPct','move10mDirectionalPct','currentVsPriorSameTimeVolumeRatio','depthSharePct','depthMidMovePct']
fs.writeFileSync(signalFile,`${columns.join(',')}\n${selectedRows.map(row=>columns.map(key=>row[key]??'').join(',')).join('\n')}\n`,{flag:'wx'})
console.log(JSON.stringify({outputFile,signalFile,predicateCount:predicates.length,qualifiedTrainRules:qualified.length,trainOnlyBest:{rule:trainOnlyBest?.tests.map(t=>t[0]),train:trainOnlyBest?.train,holdout:trainOnlyBest?.holdout,combined:trainOnlyBest?.combined},selected:{rule:selected?.tests.map(t=>t[0]),train:selected?.train,holdout:selected?.holdout,combined:selected?.combined,byDay,bySide,worstDay:byDay.sort((a,b)=>a.totalReturnPct-b.totalReturnPct)[0],signals:selectedRows.map(x=>`${x.date} ${x.symbol} ${x.side} ${x.signalAt.slice(11)} ${x.entryAt.slice(11)} ${x.exitAt.slice(11)} ${x.reason}`)},otherTopRules:best.slice(1,5)},null,2))
