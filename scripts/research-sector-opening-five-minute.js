import fs from 'node:fs'
import path from 'node:path'

const root=path.resolve(import.meta.dirname,'..')
const candlesDir=path.join(root,'db','candles')
const depthDir=path.join(root,'db','cash-depth')
const reportsDir=path.join(root,'reports')
const dates=['2026-10-05','2026-10-06','2026-10-07','2026-10-08','2026-10-09','2026-10-12','2026-10-13','2026-10-14','2026-10-15','2026-10-16']
const buckets=JSON.parse(fs.readFileSync(path.join(root,'db','stocks_sector_wise'),'utf8'))
const definitions=JSON.parse(fs.readFileSync(path.join(root,'db','sector_indices'),'utf8'))
  .filter(x=>!['NIFTYPRIVBANK','NIFTYPSUBANK'].includes(x.name))
  .filter(x=>fs.existsSync(path.join(candlesDir,`${x.name}.jsonl`)))

const candleCache=new Map(),openingCache=new Map(),depthCache=new Map()
const round=(value,digits=4)=>Number(value.toFixed(digits))
const uniqueFile=name=>{
  const extension=path.extname(name),base=name.slice(0,-extension.length)
  let candidate=path.join(reportsDir,name),n=2
  while(fs.existsSync(candidate))candidate=path.join(reportsDir,`${base}-${n++}${extension}`)
  return candidate
}
const utc=(date,time)=>Date.parse(`${date}T${time}:00Z`)

function loadCandles(symbol){
  if(!candleCache.has(symbol)){
    const file=path.join(candlesDir,`${symbol}.jsonl`)
    candleCache.set(symbol,fs.existsSync(file)?fs.readFileSync(file,'utf8').trim().split(/\r?\n/).filter(Boolean).map(JSON.parse):[])
  }
  return candleCache.get(symbol)
}

function openingAndOutcome(symbol,date){
  const key=`${date}/${symbol}`
  if(openingCache.has(key))return openingCache.get(key)
  const rows=loadCandles(symbol)
  const start=utc(date,'03:45')/1000,decision=utc(date,'03:50')/1000,end=utc(date,'10:00')/1000
  const opening=rows.filter(x=>x.time>=start&&x.time<decision)
  const after=rows.filter(x=>x.time>=decision&&x.time<end)
  if(opening.length!==5||!after.length){openingCache.set(key,null);return null}
  const first=opening[0],last=opening.at(-1),entry=after[0],exit=after.at(-1)
  if(!Number.isFinite(first.open)||!Number.isFinite(last.close)||!Number.isFinite(entry.close)||!Number.isFinite(exit.close)){openingCache.set(key,null);return null}
  const result={
    ret5:(last.close/first.open-1)*100,
    entryPrice:entry.close,
    exitPrice:exit.close,
    returnPct:(exit.close/entry.close-1)*100,
    highAfter:Math.max(...after.map(x=>x.high)),
    lowAfter:Math.min(...after.map(x=>x.low))
  }
  openingCache.set(key,result)
  return result
}

function depthFiveMinute(symbol,date){
  const key=`${date}/${symbol}`
  if(depthCache.has(key))return depthCache.get(key)
  const file=path.join(depthDir,date,symbol,`${symbol}.jsonl`)
  if(!fs.existsSync(file)){depthCache.set(key,null);return null}
  const start=utc(date,'03:45'),end=utc(date,'03:50')
  let state={},values=[]
  for(const line of fs.readFileSync(file,'utf8').trim().split(/\r?\n/)){
    if(!line)continue
    const event=JSON.parse(line),received=Date.parse(event.receivedAt)
    if(received>=end)break
    if(!event.data)continue
    Object.assign(state,event.data)
    if(received<start||received>=end||!state.bid_price1||!state.ask_price1)continue
    let bid=0,ask=0
    for(let level=1;level<=5;level++){
      bid+=Number(state[`bid_size${level}`])||0
      ask+=Number(state[`ask_size${level}`])||0
    }
    if(bid+ask>0)values.push((bid-ask)/(bid+ask))
  }
  const result=values.length?{average:values.reduce((a,b)=>a+b,0)/values.length,last:values.at(-1),samples:values.length}:null
  depthCache.set(key,result)
  return result
}

function dataset(){
  const rows=[]
  for(const date of dates){
    const nifty=openingAndOutcome('NIFTY50',date)
    if(!nifty)throw new Error(`Missing NIFTY 50 opening data for ${date}`)
    for(const definition of definitions){
      const index=openingAndOutcome(definition.name,date)
      const symbols=(buckets[definition.bucket]||[]).filter(symbol=>openingAndOutcome(symbol,date))
      if(!index||symbols.length<3)continue
      const stocks=symbols.map(symbol=>{
        const bar=openingAndOutcome(symbol,date),depth=depthFiveMinute(symbol,date)
        return {symbol,...bar,depthAverage:depth?.average??null,depthLast:depth?.last??null,depthSamples:depth?.samples??0}
      })
      const positive=stocks.filter(x=>x.ret5>0)
      rows.push({
        date,index:definition.name,bucket:definition.bucket,
        sectorRet5:index.ret5,niftyRet5:nifty.ret5,relativeRet5:index.ret5-nifty.ret5,
        breadth:positive.length/stocks.length,
        positiveDepthBreadth:stocks.filter(x=>x.depthAverage!==null&&x.depthAverage>0).length/stocks.length,
        stocks
      })
    }
  }
  return rows
}

function simulate(rows,config,selectedDates){
  const trades=[],daily=[]
  for(const date of selectedDates){
    const sectors=[]
    for(const sector of rows.filter(x=>x.date===date)){
      if(config.sideMode!=='SELL'&&sector.sectorRet5>config.sectorRetMin&&sector.relativeRet5>config.relativeMin&&sector.breadth>=config.breadthMin)
        sectors.push({...sector,side:'BUY',strength:sector.relativeRet5})
      if(config.sideMode!=='BUY'&&sector.sectorRet5<-config.sectorRetMin&&sector.relativeRet5<-config.relativeMin&&(1-sector.breadth)>=config.breadthMin)
        sectors.push({...sector,side:'SELL',strength:-sector.relativeRet5})
    }
    sectors.sort((a,b)=>b.strength-a.strength||(b.side==='BUY'?b.breadth:1-b.breadth)-(a.side==='BUY'?a.breadth:1-a.breadth))
    const sector=sectors[0]
    if(!sector)continue
    const buy=sector.side==='BUY'
    const picks=sector.stocks.filter(x=>(buy?x.ret5>0:x.ret5<0)&&(!config.requireDirectionalDepth||(buy?x.depthAverage>0:x.depthAverage<0)))
      .sort((a,b)=>buy?(b.ret5-a.ret5||b.depthAverage-a.depthAverage):(a.ret5-b.ret5||a.depthAverage-b.depthAverage)).slice(0,config.stockCount)
    if(!picks.length)continue
    const tradeReturn=x=>buy?x.returnPct:-x.returnPct
    const dailyReturn=picks.reduce((sum,x)=>sum+tradeReturn(x),0)/picks.length
    daily.push({date,side:sector.side,index:sector.index,bucket:sector.bucket,sectorRet5:round(sector.sectorRet5),niftyRet5:round(sector.niftyRet5),relativeRet5:round(sector.relativeRet5),breadth:round(sector.breadth),picks:picks.map(x=>x.symbol).join('|'),returnPct:round(dailyReturn)})
    for(const pick of picks)trades.push({date,side:sector.side,index:sector.index,bucket:sector.bucket,symbol:pick.symbol,sectorRet5:round(sector.sectorRet5),niftyRet5:round(sector.niftyRet5),relativeRet5:round(sector.relativeRet5),breadth:round(sector.breadth),stockRet5:round(pick.ret5),depthAverage:pick.depthAverage===null?null:round(pick.depthAverage),entryPrice:pick.entryPrice,exitPrice:pick.exitPrice,returnPct:round(tradeReturn(pick)),maePct:round(buy?(pick.lowAfter/pick.entryPrice-1)*100:(pick.entryPrice/pick.highAfter-1)*100)})
  }
  const winners=trades.filter(x=>x.returnPct>0),losses=trades.filter(x=>x.returnPct<0)
  return {config,trades,daily,metrics:{
    signalDays:daily.length,trades:trades.length,winners:winners.length,losses:losses.length,flat:trades.length-winners.length-losses.length,
    winRatePct:trades.length?winners.length/trades.length*100:0,
    averageReturnPct:trades.length?trades.reduce((a,x)=>a+x.returnPct,0)/trades.length:0,
    totalGrossReturnPct:trades.reduce((a,x)=>a+x.returnPct,0),
    averageDailyBasketReturnPct:daily.length?daily.reduce((a,x)=>a+x.returnPct,0)/daily.length:0,
    worstDailyBasketReturnPct:daily.length?Math.min(...daily.map(x=>x.returnPct)):0,
    maximumAdverseExcursionPct:trades.length?Math.min(...trades.map(x=>x.maePct)):0
  }}
}

function compare(a,b){
  const am=a.metrics,bm=b.metrics
  return bm.averageReturnPct-am.averageReturnPct||bm.winRatePct-am.winRatePct||bm.totalGrossReturnPct-am.totalGrossReturnPct
}

const allRows=dataset()
const trainingDates=dates.slice(0,5),validationDates=dates.slice(5)
const configs=[]
for(const sideMode of ['BUY','SELL','BOTH'])for(const sectorRetMin of [0,0.1,0.3])for(const relativeMin of [0,0.25,0.5])for(const breadthMin of [0.5,0.6,0.7])for(const requireDirectionalDepth of [false,true])for(const stockCount of [1,2,3])configs.push({sideMode,sectorRetMin,relativeMin,breadthMin,requireDirectionalDepth,stockCount})
const trainingRuns=configs.map(config=>simulate(allRows,config,trainingDates)).filter(x=>x.metrics.trades>=5&&x.metrics.signalDays>=3).sort(compare)
if(!trainingRuns.length)throw new Error('No opening-sector configuration reached minimum training support')
const chosen=trainingRuns[0]
const validation=simulate(allRows,chosen.config,validationDates)

const walkforwardTrades=[],walkforwardDaily=[],walkforwardConfigs=[]
for(let i=3;i<dates.length;i++){
  const prior=dates.slice(0,i),today=[dates[i]]
  const best=configs.map(config=>simulate(allRows,config,prior)).filter(x=>x.metrics.trades>=5&&x.metrics.signalDays>=3).sort(compare)[0]
  if(!best)continue
  const out=simulate(allRows,best.config,today)
  walkforwardTrades.push(...out.trades);walkforwardDaily.push(...out.daily)
  walkforwardConfigs.push({date:dates[i],config:best.config,priorMetrics:best.metrics})
}
const walkforward={trades:walkforwardTrades,daily:walkforwardDaily,metrics:simulate(allRows,{sideMode:'BUY',sectorRetMin:Infinity,relativeMin:Infinity,breadthMin:1,requireDirectionalDepth:false,stockCount:1},[]).metrics}
Object.assign(walkforward.metrics,{
  signalDays:walkforwardDaily.length,trades:walkforwardTrades.length,winners:walkforwardTrades.filter(x=>x.returnPct>0).length,losses:walkforwardTrades.filter(x=>x.returnPct<0).length,flat:walkforwardTrades.filter(x=>x.returnPct===0).length,
  winRatePct:walkforwardTrades.length?walkforwardTrades.filter(x=>x.returnPct>0).length/walkforwardTrades.length*100:0,
  averageReturnPct:walkforwardTrades.length?walkforwardTrades.reduce((a,x)=>a+x.returnPct,0)/walkforwardTrades.length:0,
  totalGrossReturnPct:walkforwardTrades.reduce((a,x)=>a+x.returnPct,0),
  averageDailyBasketReturnPct:walkforwardDaily.length?walkforwardDaily.reduce((a,x)=>a+x.returnPct,0)/walkforwardDaily.length:0,
  worstDailyBasketReturnPct:walkforwardDaily.length?Math.min(...walkforwardDaily.map(x=>x.returnPct)):0,
  maximumAdverseExcursionPct:walkforwardTrades.length?Math.min(...walkforwardTrades.map(x=>x.maePct)):0
})

const result={
  generatedAt:new Date().toISOString(),
  protocol:{decisionTime:'09:20 IST, after five completed one-minute candles from 09:15 through 09:19',entry:'09:20 completed candle close',exit:'final completed candle of the session',sectorSelection:'strongest NIFTY-sector return relative to NIFTY 50 among sectors passing the configured directional opening strength/breadth gates',stockSelection:'strongest direction-matched opening-return stocks in the selected sector; direction-matched depth can be required as confirmation',dataThrough:'All selection inputs end before the 09:20 entry.',caveat:'Grid choice is trained only on Oct 5–9. Oct 12–16 is untouched validation. Walk-forward re-selects the configuration using prior dates only.'},
  coverage:{dates,sectors:definitions.map(x=>({index:x.name,bucket:x.bucket,stocks:(buckets[x.bucket]||[]).length})),excludedBuckets:Object.keys(buckets).filter(x=>x!=='_meta'&&!definitions.some(d=>d.bucket===x))},
  selectedFromTraining:{config:chosen.config,training:chosen.metrics,validation:validation.metrics,validationDaily:validation.daily,validationTrades:validation.trades},
  walkforward:{metrics:walkforward.metrics,daily:walkforwardDaily,trades:walkforwardTrades,configByDate:walkforwardConfigs}
}
const resultFile=uniqueFile('2026-10-05-to-2026-10-16-sector-opening-five-minute-results.json')
fs.writeFileSync(resultFile,JSON.stringify(result,null,2))
const metrics=m=>`trades ${m.trades}; winners ${m.winners}; losers ${m.losses}; win rate ${round(m.winRatePct,2)}%; average ${round(m.averageReturnPct)}%; gross total ${round(m.totalGrossReturnPct)}%; average daily basket ${round(m.averageDailyBasketReturnPct)}%; worst daily basket ${round(m.worstDailyBasketReturnPct)}%; worst MAE ${round(m.maximumAdverseExcursionPct)}%`
const ruleLines=chosen.config.sideMode==='BUY'?
  [`- Sector return > ${chosen.config.sectorRetMin}%`,`- Sector relative return vs NIFTY 50 > ${chosen.config.relativeMin}%`,`- Positive stock breadth >= ${round(chosen.config.breadthMin*100,0)}%`]:
  chosen.config.sideMode==='SELL'?
    [`- Sector return < -${chosen.config.sectorRetMin}%`,`- Sector relative return vs NIFTY 50 < -${chosen.config.relativeMin}%`,`- Negative stock breadth >= ${round(chosen.config.breadthMin*100,0)}%`]:
    [`- Either directional sector return exceeds ${chosen.config.sectorRetMin}%`,`- Absolute sector-relative return vs NIFTY 50 exceeds ${chosen.config.relativeMin}%`,`- Direction-matched stock breadth >= ${round(chosen.config.breadthMin*100,0)}%`]
const findingsFile=uniqueFile('2026-10-05-to-2026-10-16-sector-opening-five-minute-findings.md')
fs.writeFileSync(findingsFile,[
  '# Sector opening-five-minute research', '',
  'The pattern chooses the sector with the strongest 09:15–09:20 return relative to NIFTY 50, subject to sector direction and stock-breadth gates, then buys its highest-ranked qualifying stocks at the 09:20 completed-candle close. Stock selection uses only the opening return and, when required by the selected configuration, positive five-level market-depth imbalance.', '',
  '## Selected rule (fitted only on Oct 5–9)', '',
  ...ruleLines,
  `- Stocks per selected sector: ${chosen.config.stockCount}`,
  `- Direction: ${chosen.config.sideMode}`,
  `- Direction-matched average five-level depth imbalance required: ${chosen.config.requireDirectionalDepth?'yes':'no'}`,
  '',`Training (Oct 5–9): ${metrics(chosen.metrics)}.`, `Untouched validation (Oct 12–16): ${metrics(validation.metrics)}.`, '',
  '## Strict rolling walk-forward', '',
  `Each day selects the configuration using only all preceding dates: ${metrics(walkforward.metrics)}.`, '',
  'Gross total is the sum of individual-trade percentage returns, not a compounded portfolio return. Only the validation and rolling sections are chronological evidence; the training result is not live evidence.', '',
  `Exact daily selections, trade outcomes, configuration history and coverage: ${path.basename(resultFile)}.`, ''
].join('\n'))
console.log(JSON.stringify({resultFile,findingsFile,selectedConfig:chosen.config,training:chosen.metrics,validation:validation.metrics,walkforward:walkforward.metrics},null,2))
