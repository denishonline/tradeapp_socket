import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'
import {REPORTS,STEM,DATES,rowKey,uniqueFile,save,round,writeCsv} from './research-ema-coverage.js'
import {prepare} from './search-precision-ema-patterns.js'
import {attachExecutionAndStructure,fitForest,predict,firstSignals,summarize,wilson} from './ema-advanced-filter-core.js'

const grossOnly=process.argv.includes('--gross-only')
const savedModels=process.argv.includes('--reuse-models')?JSON.parse(fs.readFileSync(path.join(REPORTS,`${STEM}-trend-focused-models.json`),'utf8')).models:null
const protocol={fitDates:DATES.slice(0,4),calibrationDates:DATES.slice(4,6),replayDates:DATES.slice(6),
  status:'Exploratory follow-up after the general return classifier failed. Oct13-16 was already examined; this is NOT independent validation.',
  labels:'Fit only profitable original target-leg views and all non-positive controls. Other profitable legs are neutral and omitted from fitting; their emitted trades remain in evaluations. No cohort flag, return, MAE, symbol or date is a feature.',
  models:'Four fixed randomized-forest configurations: stock-only target weight50; all inputs weight10,50,150. 48 trees, depth7, leaf>=35 records. Weighted scores rank target similarity; they are NOT calibrated win probabilities.',
  selection:'Use Oct9/12 only to select model, delay (0/3/5 or first match), score threshold 0.05..0.95. Require >=20 emitted calibration trades, both dates, >=3 profitable original target legs. Primary also requires >=50% calibration target retention and >=80% gross win rate. Predeclare 25/50/75/90/100% target-retention frontiers, maximizing gross Wilson lower bound subject to '+(grossOnly?'positive GROSS mean. This sensitivity removes the arbitrary 10bps eligibility requirement, but still reports costs.':'positive net mean after hypothetical10bps.'),
  execution:'Use only information strictly before signalAt; fill at next completed one-minute candle close. First qualifying signal per original leg; opposite EMA cross next-open or EOD exit, no SL/TP.',
  limitations:'Only ten sessions, multiple prior searches, many correlated views and indicators. No guarantee of all winners or no losses. Cash depth has no OI. Delta is signed-volume proxy. Return sums are percentage points, not portfolio returns.'}
console.log(JSON.stringify(protocol,null,2))
const fresh=JSON.parse(fs.readFileSync(path.join(REPORTS,`${STEM}-entry-time-depth.json`),'utf8'))
let events=prepare([0,3,5])
for(const e of events){const dep=fresh.rows[rowKey(e)];if(dep?.depthAvailable===1)for(const [k,v]of Object.entries(dep))if(Number.isFinite(v))e.features[k]=v;e.features.confirmationDelay=e.delay}
events=attachExecutionAndStructure(events)
const fit=events.filter(e=>protocol.fitDates.includes(e.date)&&(e.returnPct<=0||e.cohort)),calibration=events.filter(e=>protocol.calibrationDates.includes(e.date)),later=events.filter(e=>protocol.replayDates.includes(e.date))
const targetCount=rows=>new Set(rows.filter(e=>e.cohort).map(e=>e.key)).size
const totalCal=targetCount(calibration),totalLater=targetCount(later)
const features=[...new Set(fit.flatMap(e=>Object.keys(e.features)))].filter(k=>!['depthAvailable','depthLastAgeSec'].includes(k)).sort()
const configs=[{name:'stock-target50',weight:50,features:features.filter(k=>!/^nifty_|^depth|^cross_depth|^market|^relative|^absorption/.test(k)),seed:801},
  ...[10,50,150].map((weight,i)=>({name:`all-target${weight}`,weight,features,seed:802+i}))]
const timings={all:[0,3,5],cross:[0],confirm3:[3],confirm5:[5]},models=[],candidates=[]
function eligible(e,c){return timings[c.timing].includes(e.delay)&&e.scores[c.model]>=c.threshold}
function rank(a,b){return b.lowerBound-a.lowerBound||b.summary.profitableCohort-a.summary.profitableCohort||b.summary.afterHypothetical10bps.averageReturnPct-a.summary.afterHypothetical10bps.averageReturnPct||a.model.localeCompare(b.model)||a.threshold-b.threshold}
for(const config of configs){
  console.log(`Fitting ${config.name}, ${fit.length} rows, ${fit.filter(e=>e.cohort&&e.returnPct>0).length} positive target views`)
  const model=savedModels?.find(m=>m.name===config.name)||fitForest(fit,config.features,{seed:config.seed,trees:48,maxDepth:7,minLeaf:35,objective:'cohort',positiveWeight:config.weight})
  assert.deepEqual(model.features,config.features)
  models.push({name:config.name,...model})
  for(const e of calibration){e.scores??={};e.scores[config.name]=predict(model,e.features).p}
  for(const timing of Object.keys(timings))for(let i=1;i<=19;i++){
    const c={model:config.name,timing,threshold:i*.05},signals=firstSignals(calibration,e=>eligible(e,c))
    if(signals.length<20||new Set(signals.map(e=>e.date)).size<2)continue
    const summary=summarize(signals);if(summary.profitableCohort<3||(grossOnly?summary.averageReturnPct:summary.afterHypothetical10bps.averageReturnPct)<=0)continue
    candidates.push({...c,summary,retentionPct:round(100*summary.profitableCohort/totalCal),lowerBound:round(100*wilson(summary.winners,summary.trades))})
  }
}
const primary=candidates.filter(c=>c.retentionPct>=50&&c.summary.winRatePct>=80).sort((a,b)=>b.summary.profitableCohort-a.summary.profitableCohort||rank(a,b))[0]||null
const frontiers=[25,50,75,90,100].map(retention=>({retention,configuration:candidates.filter(c=>c.retentionPct>=retention).sort(rank)[0]||null}))
const ablations=configs.map(c=>({name:c.name,configuration:candidates.filter(x=>x.model===c.name&&x.retentionPct>=50).sort(rank)[0]||null}))
const highestSupported=[...candidates].sort(rank)[0]||null
const lock=uniqueFile('trend-focused-selection-lock.json')
save(lock,{generatedAt:new Date().toISOString(),protocol,primary,frontiers,ablations,highestSupported,calibrationTargets:totalCal,candidates:candidates.length,allCandidates:candidates})
console.log(`Selection locked: ${lock}`)
for(const e of later){e.scores={};for(const model of models)e.scores[model.name]=predict(model,e.features).p}
function evaluate(c,suffix){
  if(!c)return null
  const signals=firstSignals(later,e=>eligible(e,c)),summary=summarize(signals),file=uniqueFile(`trend-focused-${suffix}-later-signals.csv`)
  writeCsv(file,signals.map(e=>({date:e.date,symbol:e.symbol,side:e.side,originalEntryTime:e.originalEntryTime||e.entryTime,signalTime:e.entryTime,fillTime:e.fillTime,delayMinutes:e.delay,cohort:e.cohort,entryPrice:e.entryPrice,exitTime:e.exitTime,exitPrice:e.exitPrice,returnPct:round(e.returnPct),maePct:round(e.maePct),targetSimilarityScore:round(e.scores[c.model],6)})))
  const emitted=new Map(signals.filter(e=>e.cohort).map(e=>[e.key,e])),ledger=uniqueFile(`trend-focused-${suffix}-later-cohort.csv`)
  writeCsv(ledger,[...new Map(later.filter(e=>e.cohort).map(e=>[e.key,e])).values()].map(e=>{const hit=emitted.get(e.key);return {date:e.date,symbol:e.symbol,side:e.side,originalEntryTime:e.originalEntryTime||e.entryTime,status:hit?(hit.returnPct>0?'WIN':'NON_POSITIVE'):'UNCOVERED',signalTime:hit?.entryTime,fillTime:hit?.fillTime,returnPct:hit?round(hit.returnPct):null}}))
  assert.equal(summary.profitableCohort,[...emitted.values()].filter(e=>e.returnPct>0).length)
  return {summary,retentionPct:round(100*summary.profitableCohort/totalLater),signals:file,cohort:ledger}
}
const report={generatedAt:new Date().toISOString(),protocol,selectionLock:lock,targetCounts:{fit:targetCount(fit),calibration:totalCal,later:totalLater},
  primary:{configuration:primary,replay:evaluate(primary,'primary')},
  highestSupported:{configuration:highestSupported,replay:evaluate(highestSupported,'highest-supported')},
  frontiers:frontiers.map(c=>({...c,replay:evaluate(c.configuration,`${c.retention}retention`)})),
  ablations:ablations.map(c=>({...c,replay:c.configuration?summarize(firstSignals(later,e=>eligible(e,c.configuration))):null})),
  modelDiagnostics:models.map(m=>({name:m.name,features:m.features.length,config:m.config,topFeatures:m.importance.slice(0,20)}))}
const results=uniqueFile('trend-focused-results.json'),modelFile=uniqueFile('trend-focused-models.json'),findings=uniqueFile('trend-focused-findings.md')
save(results,report);save(modelFile,{protocol,primary,frontiers,models})
const lines=['# Trend-focused chronological filter research','',protocol.status,'',
  '| Required calibration target retention | Calibration targets | Calibration trades | Calibration wins % | Later targets | Later trades | Later wins % | Later losses | Later mean % | Later mean less10bps % |',
  '| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |']
for(const r of report.frontiers){const c=r.configuration?.summary,s=r.replay?.summary;lines.push(c?`| ${r.retention}% | ${c.profitableCohort}/${totalCal} | ${c.trades} | ${c.winRatePct} | ${s.profitableCohort}/${totalLater} | ${s.trades} | ${s.winRatePct??'N/A'} | ${s.losses} | ${s.averageReturnPct??'N/A'} | ${s.afterHypothetical10bps.averageReturnPct??'N/A'} |`:`| ${r.retention}% | No sufficiently supported positive-net-mean calibration candidate | | | | | | | | |`)}
lines.push('','Primary >=80% precision and >=50% target-retention requirement: '+(primary?'Met on calibration; later replay below.':'NOT met on calibration. No primary strategy is proposed.'),'',
  '## Highest supported precision, even if below retention requirements','```json',JSON.stringify(report.highestSupported,null,2),'```','',
  '## Feature ablations','```json',JSON.stringify(report.ablations,null,2),'```','','## Protocol','```json',JSON.stringify(protocol,null,2),'```','',`Exact metrics: ${path.basename(results)}. Models: ${path.basename(modelFile)}.`)
fs.writeFileSync(findings,lines.join('\n')+'\n',{flag:'wx'})
console.log(JSON.stringify({findings,results,primary:report.primary,frontiers:report.frontiers.map(c=>({retention:c.retention,configuration:c.configuration&&{model:c.configuration.model,timing:c.configuration.timing,threshold:c.configuration.threshold,calibration:c.configuration.summary},replay:c.replay}))},null,2))
