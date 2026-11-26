import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'
import {REPORTS,STEM,DATES,rowKey,uniqueFile,save,round,writeCsv} from './research-ema-coverage.js'
import {prepare,matching} from './search-precision-ema-patterns.js'
import {attachExecutionAndStructure,summarize} from './ema-advanced-filter-core.js'
import {buildContext,grow} from './search-pure-tree-ema-patterns.js'
import {selectBeforeDay,replayDay,signature} from './ema-walkforward20-core.js'
import {attachSectorContext} from './ema-sector-pattern-core.js'

const advanced=process.argv.includes('--advanced-flow'),sectorAligned=process.argv.includes('--sector-aligned')
const variant=sectorAligned?(advanced?'walkforward20-sector-aligned-orderflow':'walkforward20-sector-aligned'):(advanced?'walkforward20-orderflow':'walkforward20')
const protocol={dates:DATES,objective:'50-100 profitable legs from the original159 with zero non-positive emitted trades, not merely 50-100 total winning trades accompanied by hidden losses.',
  primary:'Strict walk-forward: propose pure rules on all prior sessions except the last; that last prior session must have >=2 strictly positive matching trades including >=1 original target. No current-day labels select a rule.',
  benchmark:'Prior-fit-only walk-forward: same rules and budgets but no separate validation session; overfit-prone benchmark, not an alternative chosen using replay performance.',
  budgets:{maxDistinctLifetimeRules:20,maxNewPerDay:3,treesPerTiming:24,featuresPerSplit:32,maxConditionsBeforeSimplification:8,minTrainingTargetKeys:2,minTrainingTargetDates:2,timings:[0,3,5]},
  management:'Start without a lossy baseline. A rule is admitted once and consumes one of20 lifetime slots; no recycling failed slots. Before each later day, deactivate any rule matching a non-positive outcome in any completed prior session. Such losses stay permanently in replay metrics. Existing rules need no new previous-day match to stay active. Up to3 admissions/day spreads the budget; no stop after observing an eventual loss.',
  warmup:'Strict cannot trade before Oct8 (two fitting sessions plus one prior validation session). Prior-fit-only cannot trade before Oct7. Warmup legs remain missed in full159 coverage.',
  inputs:sectorAligned
    ? 'Same causal candle1/3/5/10/15m, NIFTY, price structure and fresh three-minute depth features, plus only the triggering stock’s mapped own-sector proxy. Direct named-sector-index and cross-sector breadth features are excluded. Target flags/outcomes are past training labels only, never indicator inputs. Missing numeric fields fail conditions. No symbol/date/clock identity rules.'
    : 'Same causal candle1/3/5/10/15m, NIFTY, breadth, price structure and fresh three-minute depth features. Target flags/outcomes are past training labels only, never indicator inputs. Missing numeric fields fail conditions. No symbol/date/clock identity rules.',
  execution:'First matching signal at cross+0/+3/+5m, then fill at next completed1m candle close. Opposite-cross next-open exit or EOD mark; no SL/TP. Record all universe signals to measure false positives; focus is original159 target coverage.',
  caveats:'All ten dates were explored previously. This is a new chronology-correct exploratory replay, not independent validation or a promise of zero future losses. Gross costs excluded; hypothetical10bps shown separately. Percentage-point sums are not portfolio returns.'}
if(advanced)protocol.advancedInputs={vwap:'Session typical-price volume-weighted VWAP, slope3, hold3, retest3 and weighted deviation; candles only.',profile:'APPROXIMATION: candle volume distributed uniformly between candle low/high over fixed0.05% log bins anchored to known session open. Prefix POC and contiguous70% value area; never full-day extrema. Not actual volume-at-price.',cvd:'PROXY: signed candle volume and close-location weighted volume. Not aggressor buy/sell delta. Fresh depth delta is also an estimate.',footprint:'UNAVAILABLE: no per-trade aggressor/price-level execution data. No genuine footprint or stacked trade imbalance is fabricated.',rvol:'Current closed1/3/5-minute window or session-to-time volume / average same-time volume from at least2 completed prior sessions in scope. Never current/future session totals.'}
if(advanced)protocol.advancedInputs.priceAction='BOS/CHoCH from 2-left/2-right CONFIRMED pivots, never backdated; confirmed swing sweeps/retests; rule-defined opposing-candle zones activated after a5-bar breakout with body>0.8ATR14; 3-candle wick FVG zones usable only after formation; 5/15/30m opening ranges only after completion. OB/FVG expire after60 bars and invalidate on specified breaches. These are definitions to test, not proof of institutional activity.'
const protocolFile=uniqueFile(`${variant}-protocol-lock.json`);save(protocolFile,{generatedAt:new Date().toISOString(),protocol})
const fresh=JSON.parse(fs.readFileSync(path.join(REPORTS,`${STEM}-entry-time-depth.json`),'utf8'))
let events=prepare([0,3,5])
for(const e of events){const dep=fresh.rows[rowKey(e)];if(dep?.depthAvailable===1)for(const [k,v]of Object.entries(dep))if(Number.isFinite(v))e.features[k]=v}
events=attachExecutionAndStructure(events,{advancedFlow:advanced})
for(const e of events)for(const k of ['depthAvailable','depthLastAgeSec'])delete e.features[k]
const sector=attachSectorContext(events,JSON.parse(fs.readFileSync('db/sector_indices','utf8')),JSON.parse(fs.readFileSync('db/stocks_sector_wise','utf8')))
let removedCrossSectorFeatures=0
if(sectorAligned)for(const e of events)for(const key of Object.keys(e.features)){
  if(key.startsWith('index_')||key.startsWith('sectorBreadth')||key.startsWith('sectorMean')){delete e.features[key];removedCrossSectorFeatures++}
}
const featureInventory=[...new Set(events.flatMap(e=>Object.keys(e.features)))].sort()
if(sectorAligned)assert(!featureInventory.some(k=>k.startsWith('index_')||k.startsWith('sectorBreadth')||k.startsWith('sectorMean')))
console.log(`Features: ${featureInventory.length}; new flow/price-action: ${featureInventory.filter(k=>/^(adv_|pa_)/.test(k)).length}; sector-aligned: ${sectorAligned}; excluded cross-sector: ${removedCrossSectorFeatures}`)
const discoveryCache=new Map()
function proposalsThrough(lastIndex){
  if(lastIndex<1)return []
  if(discoveryCache.has(lastIndex))return discoveryCache.get(lastIndex)
  const rows=events.filter(e=>DATES.indexOf(e.date)<=lastIndex),pool=new Map()
  for(const delay of [0,3,5]){
    const context=buildContext(rows,delay,{allowBinary:advanced})
    for(let i=0;i<24;i++)grow(context,i,pool,{maxDepth:8,minPos:2,featuresPerSplit:32,seed:73119})
    console.log(`Through ${DATES[lastIndex]} delay${delay}: ${pool.size} pure candidate groups`)
  }
  const rules=[...pool.values()].map(({delay,conditions})=>({delay,conditions}))
  discoveryCache.set(lastIndex,rules);return rules
}
const states=[{name:'strict',requireValidation:true,library:[],days:[],signals:[]},{name:'prior-fit-only',requireValidation:false,library:[],days:[],signals:[]}]
for(let dayIndex=0;dayIndex<DATES.length;dayIndex++){
  const date=DATES[dayIndex],today=events.filter(e=>e.date===date),history=events.filter(e=>e.date<date)
  for(const state of states){
    const lastTraining=dayIndex-(state.requireValidation?2:1)
    if(lastTraining<1){state.days.push({date,warmup:true,availableTargets:new Set(today.filter(e=>e.cohort).map(e=>e.key)).size,activeRuleIds:[],admitted:[],performance:summarize([])});continue}
    const training=history.filter(e=>DATES.indexOf(e.date)<=lastTraining),validation=state.requireValidation?history.filter(e=>e.date===DATES[dayIndex-1]):[]
    const selection=selectBeforeDay({history,training,validation,candidates:proposalsThrough(lastTraining),library:state.library,requireValidation:state.requireValidation,decisionDate:date})
    state.library=selection.library
    // Persist exact rules and prior-only support before producing today's outcomes.
    const dailyLock=uniqueFile(`${variant}-${state.name}-${date}-lock.json`)
    save(dailyLock,{date,trainingThrough:DATES[lastTraining],validationDate:state.requireValidation?DATES[dayIndex-1]:null,active:selection.active,admitted:selection.admitted,librarySize:state.library.length})
    const signals=replayDay(today,selection.active,date);state.signals.push(...signals)
    state.days.push({date,warmup:false,availableTargets:new Set(today.filter(e=>e.cohort).map(e=>e.key)).size,trainingThrough:DATES[lastTraining],validationDate:state.requireValidation?DATES[dayIndex-1]:null,
      candidateCount:proposalsThrough(lastTraining).length,eligibleCount:selection.eligible,admitted:selection.admitted.map(r=>r.id),activeRuleIds:selection.active.map(r=>r.id),lifetimeRules:state.library.length,selectionLock:dailyLock,performance:summarize(signals)})
    console.log(`${state.name} ${date}: library${state.library.length}, active${selection.active.length}, signals${signals.length}, target${signals.filter(e=>e.cohort&&e.returnPct>0).length}, nonpositive${signals.filter(e=>e.returnPct<=0).length}`)
  }
}
const outputs=[]
for(const state of states){
  const summary=summarize(state.signals),file=uniqueFile(`${variant}-${state.name}-signals.csv`),ledger=uniqueFile(`${variant}-${state.name}-cohort.csv`)
  writeCsv(file,state.signals.map(e=>({date:e.date,symbol:e.symbol,side:e.side,originalEntryTime:e.originalEntryTime||e.entryTime,signalTime:e.entryTime,fillTime:e.fillTime,delayMinutes:e.delay,ruleId:e.ruleId,cohort:e.cohort,entryPrice:e.entryPrice,exitTime:e.exitTime,exitPrice:e.exitPrice,returnPct:round(e.returnPct),maePct:round(e.maePct)})))
  const emitted=new Map(state.signals.map(e=>[e.key,e])),warmupDates=new Set(state.days.filter(d=>d.warmup).map(d=>d.date)),cohort=[...new Map(events.filter(e=>e.cohort).map(e=>[e.key,e])).values()]
  writeCsv(ledger,cohort.map(e=>{const hit=emitted.get(e.key);return {date:e.date,symbol:e.symbol,side:e.side,originalEntryTime:e.originalEntryTime||e.entryTime,status:hit?(hit.returnPct>0?'WIN':'NON_POSITIVE'):(warmupDates.has(e.date)?'WARMUP_MISSED':'UNCOVERED'),ruleId:hit?.ruleId,signalTime:hit?.entryTime,fillTime:hit?.fillTime,returnPct:hit?round(hit.returnPct):null}}))
  assert.equal(cohort.length,159);assert(state.library.length<=20);assert.equal(new Set(state.library.map(signature)).size,state.library.length)
  assert.equal(new Set(state.signals.map(e=>e.key)).size,state.signals.length)
  for(const e of state.signals){const rule=state.library.find(r=>r.id===e.ruleId);assert(rule.admittedBefore<=e.date);assert(matching(e,rule))}
  outputs.push({name:state.name,summary,goalAchieved:summary.profitableCohort>=50&&summary.profitableCohort<=100&&summary.losses===0&&summary.flat===0,
    zeroLossAtLeast50:summary.profitableCohort>=50&&summary.losses===0&&summary.flat===0,library:state.library,days:state.days,signals:file,cohort:ledger})
}
const result=uniqueFile(`${variant}-results.json`),findings=uniqueFile(`${variant}-findings.md`);save(result,{generatedAt:new Date().toISOString(),protocol,protocolLock:protocolFile,featureInventory,sector:{...sector,removedCrossSectorFeatures},outputs})
const lines=['# Up to20 lifetime patterns: chronological replay','',protocol.caveats,'',
  '| Policy | Lifetime rules | Target winners /159 | Trades | Wins | Losses | Flat | Win rate % | Average gross % | Sum pp | Worst MAE % | Avg less10bps % |',
  '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
  ...outputs.map(o=>{const s=o.summary;return `| ${o.name} | ${o.library.length} | ${s.profitableCohort} | ${s.trades} | ${s.winners} | ${s.losses} | ${s.flat} | ${s.winRatePct??'N/A'} | ${s.averageReturnPct??'N/A'} | ${s.summedReturnPct} | ${s.worstMaePct??'N/A'} | ${s.afterHypothetical10bps.averageReturnPct??'N/A'} |`}),
  '',`Primary target achieved: ${outputs[0].zeroLossAtLeast50?'YES on this exploratory replay only':'NO'}. No historical loss is deleted when a rule is later disabled. Warmup targets remain missed.`,
  ...outputs.flatMap(o=>['',`## ${o.name} by day`,'','| Date | Warmup | Admitted | Active | Targets available | Targets captured | Trades | Losses | Flat | Mean gross % |','| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
    ...o.days.map(d=>`| ${d.date} | ${d.warmup} | ${d.admitted.join(', ')} | ${d.activeRuleIds.length} | ${d.availableTargets} | ${d.performance.profitableCohort} | ${d.performance.trades} | ${d.performance.losses} | ${d.performance.flat} | ${d.performance.averageReturnPct??'N/A'} |`),
    '',`Worst day: ${JSON.stringify(o.summary.worstDay)}.`,
    '',`Signals: ${path.basename(o.signals)}. Full159 cohort: ${path.basename(o.cohort)}.`]),
  '','## Protocol','```json',JSON.stringify(protocol,null,2),'```','',`Exact rule lifetimes, thresholds and metrics: ${path.basename(result)}.`]
fs.writeFileSync(findings,lines.join('\n')+'\n',{flag:'wx'});console.log(JSON.stringify({result,findings,outputs:outputs.map(({name,summary,library,zeroLossAtLeast50})=>({name,summary,rules:library.length,zeroLossAtLeast50}))},null,2))
