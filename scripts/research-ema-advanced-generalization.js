import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'
import {REPORTS,STEM,DATES,rowKey,uniqueFile,save,round,writeCsv} from './research-ema-coverage.js'
import {prepare} from './search-precision-ema-patterns.js'
import {attachExecutionAndStructure,fitForest,predict,firstSignals,summarize,wilson} from './ema-advanced-filter-core.js'

const depthFile=path.join(REPORTS,`${STEM}-entry-time-depth.json`)
assert(fs.existsSync(depthFile),'Build entry-time depth first: node scripts/build-ema-entry-time-depth.js')
const protocol={fitDates:DATES.slice(0,4),calibrationDates:DATES.slice(4,6),replayDates:DATES.slice(6),
  features:'Causal stock 1m/3m/5m/10m/15m indicators, NIFTY, breadth, ATR-normalized interactions, efficiency, candle persistence, fresh three-minute book metrics and changes from original-cross depth.',
  labels:'All completed historical leg outcomes; classification predicts positive gross return, >0.10% return and >0.50% return. Cohort membership is never a model input or fitting weight.',
  execution:'Evaluate 0, 3 and 5 completed minutes after EMA cross. Signal uses only completed candles and depth received strictly before signal time. Place order then fill at following completed 1m candle close. Earliest qualifying signal owns each original leg. Opposite EMA cross next-open exit or EOD mark; no stop or target.',
  modelSelection:'Fixed 48-tree depth-8 randomized forests, minimum leaf 35; three predeclared feature ablations. Fit Oct5-8 only; select score thresholds, timing and physical gate using Oct9 and12 only. Freeze before reading Oct13-16 outcomes. At most three timing branches, not ten post-hoc exception rules.',
  objective:'Primary requires >=80% calibration gross wins, >=20 calibration trades, trades on both calibration days and positive mean after hypothetical 10bps cost. Maximize profitable original-cohort coverage subject to those constraints. Also predeclare 60/70/90/100% precision frontiers.',
  limitations:'All ten dates have previously been studied. This is a new chronological experiment, not a pristine holdout. Hypothetical 10bps is sensitivity, not actual costs. Summed returns are percentage-point sums, not portfolio performance. Non-cohort legs are negative/neutral controls required to measure false signals; focus remains original 159 targets. Cash data contain no true OI; signed-volume delta is an estimate.'}
console.log(JSON.stringify(protocol,null,2))
const fresh=JSON.parse(fs.readFileSync(depthFile,'utf8'))
let events=prepare([0,3,5])
let quality=0
for(const e of events){
  const dep=fresh.rows[rowKey(e)]
  if(dep?.depthAvailable===1){quality++;for(const [k,v]of Object.entries(dep))if(Number.isFinite(v))e.features[k]=v}
  e.features.confirmationDelay=e.delay
}
events=attachExecutionAndStructure(events)
assert.equal(new Set(events.filter(e=>e.cohort).map(e=>e.key)).size,159)
const fit=events.filter(e=>protocol.fitDates.includes(e.date)),calibration=events.filter(e=>protocol.calibrationDates.includes(e.date)),later=events.filter(e=>protocol.replayDates.includes(e.date))
const names=[...new Set(fit.flatMap(e=>Object.keys(e.features)))].filter(k=>!['depthAvailable','depthLastAgeSec'].includes(k)).sort()
const configurations=[
  {name:'stock-only',features:names.filter(k=>!/^nifty_|^depth|^cross_depth|^market|^relative|^absorption/.test(k)),seed:421},
  {name:'stock-nifty-breadth',features:names.filter(k=>!/^depth|^cross_depth|^absorption/.test(k)),seed:422},
  {name:'stock-nifty-fresh-depth',features:names,seed:423}
]
const gates={
  none:()=>true,
  'efficient-momentum':f=>f.returnAtr3>=.5&&f.efficiency5>=.3&&f.volRatio5>=1,
  'market-relative-strength':f=>f.relativeRet5>=.05&&f.nifty_ret5>=0&&f.vwapGap>=0,
  'fresh-book-flow':f=>f.depthOfi>0&&f.depthMidReturn>0,
  'price-led-absorption':f=>f.depthDelta>.1&&f.returnAtr3>=.5&&f.depthMidReturn>0
}
const timings={all:[0,3,5],cross:[0],confirm3:[3],confirm5:[5]}
const thresholds=[.3,.35,.4,.45,.5,.55,.6,.65,.7,.75,.8,.85,.9]
const targets=[60,70,80,90,100],models=[],candidates=[]
function eligible(e,c){const p=e.scores[c.model];return timings[c.timing].includes(e.delay)&&p.pGross>=c.p&&p.mean>=c.mean&&p.pBig>=c.big&&gates[c.gate](e.features)}
function rank(a,b){return b.summary.profitableCohort-a.summary.profitableCohort||b.lowerBound-a.lowerBound||b.summary.afterHypothetical10bps.averageReturnPct-a.summary.afterHypothetical10bps.averageReturnPct||b.summary.trades-a.summary.trades||JSON.stringify(a).localeCompare(JSON.stringify(b))}
for(const config of configurations){
  console.log(`Fitting ${config.name}`)
  const model=fitForest(fit,config.features,{seed:config.seed});models.push({name:config.name,...model})
  for(const e of calibration){e.scores??={};e.scores[config.name]=predict(model,e.features)}
  let count=0
  for(const timing of Object.keys(timings))for(const gate of Object.keys(gates))for(const p of thresholds)for(const mean of [0,.05,.1,.2])for(const big of [0,.1]){
    const c={model:config.name,timing,gate,p,mean,big},signals=firstSignals(calibration,e=>eligible(e,c))
    if(signals.length<20||new Set(signals.map(e=>e.date)).size<2)continue
    const summary=summarize(signals)
    if(summary.afterHypothetical10bps.averageReturnPct<=0)continue
    candidates.push({...c,summary,lowerBound:round(wilson(summary.winners,summary.trades)*100)});count++
  }
  console.log(`Calibration ${config.name}: ${count} sufficiently supported positive-net-mean candidates`)
}
const chosen=targets.map(target=>({target,configuration:candidates.filter(c=>c.summary.winRatePct>=target).sort(rank)[0]||null}))
const ablations=configurations.map(({name})=>({name,configuration:candidates.filter(c=>c.model===name&&c.summary.winRatePct>=80).sort(rank)[0]||null,
  highestSupportedPrecision:candidates.filter(c=>c.model===name).sort((a,b)=>b.summary.winRatePct-a.summary.winRatePct||rank(a,b))[0]||null}))
const lockFile=uniqueFile('advanced-filter-selection-lock.json')
save(lockFile,{generatedAt:new Date().toISOString(),protocol,chosen,ablations,calibrationCandidateCount:candidates.length,
  calibrationHighestPrecision:[...candidates].sort((a,b)=>b.summary.winRatePct-a.summary.winRatePct||rank(a,b)).slice(0,10)})
console.log(`Locked selection before later replay: ${lockFile}`)
// Later labels do not participate in any model, threshold, timing or gate choice.
for(const e of later){e.scores={};for(const model of models)e.scores[model.name]=predict(model,e.features)}
const outputs=[]
for(const choice of chosen){
  if(!choice.configuration){outputs.push({...choice,replay:null});continue}
  const c=choice.configuration,signals=firstSignals(later,e=>eligible(e,c)),file=uniqueFile(`advanced-filter-${choice.target}pct-later-signals.csv`)
  writeCsv(file,signals.map(e=>({date:e.date,symbol:e.symbol,side:e.side,originalEntryTime:e.originalEntryTime||e.entryTime,signalTime:e.entryTime,fillTime:e.fillTime,delayMinutes:e.delay,cohort:e.cohort,entryPrice:e.entryPrice,exitTime:e.exitTime,exitPrice:e.exitPrice,returnPct:round(e.returnPct),maePct:round(e.maePct),grossWinScore:round(e.scores[c.model].pGross,6),estimatedReturn:round(e.scores[c.model].mean,6)})))
  outputs.push({...choice,replay:summarize(signals),signalsFile:file})
}
const byTiming=[0,3,5].map(delay=>({delay,earlier:summarize(events.filter(e=>e.delay===delay&&DATES.indexOf(e.date)<6)),later:summarize(later.filter(e=>e.delay===delay))}))
const report={generatedAt:new Date().toISOString(),protocol,selectionLock:lockFile,freshDepth:{quality,views:events.length,qualityPct:round(quality/events.length*100),oiFields:fresh.oiFields},
  availableCohort:{fit:new Set(fit.filter(e=>e.cohort).map(e=>e.key)).size,calibration:new Set(calibration.filter(e=>e.cohort).map(e=>e.key)).size,later:new Set(later.filter(e=>e.cohort).map(e=>e.key)).size},
  primary:outputs.find(c=>c.target===80),frontiers:outputs,byTiming,
  ablations:ablations.map(a=>({...a,replay:a.configuration?summarize(firstSignals(later,e=>eligible(e,a.configuration))):null,
    highestSupportedPrecisionReplay:a.highestSupportedPrecision?summarize(firstSignals(later,e=>eligible(e,a.highestSupportedPrecision))):null})),
  modelDiagnostics:models.map(m=>({name:m.name,features:m.features.length,config:m.config,topFeatures:m.importance.slice(0,25)}))}
const results=uniqueFile('advanced-filter-results.json'),modelFile=uniqueFile('advanced-filter-models.json'),findings=uniqueFile('advanced-filter-findings.md')
save(results,report);save(modelFile,{protocol,chosen,models})
const lines=['# Fresh-depth and chronological advanced-filter research','',
  'Thresholds and model choice use Oct5-12 only; Oct13-16 is replayed once after a selection lock. These dates were explored before, so this is not an untouched holdout. Entries now use the next candle close, unlike the earlier next-open reports.','',
  '| Calibration precision requirement | Calibration trades | Calibration wins % | Calibration target legs | Later trades | Later wins % | Later losses | Later target legs | Later mean gross % | Later mean less 10bps % |',
  '| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |']
for(const r of outputs){const c=r.configuration?.summary,s=r.replay;lines.push(c?`| ${r.target}% | ${c.trades} | ${c.winRatePct} | ${c.profitableCohort} | ${s.trades} | ${s.winRatePct??'N/A'} | ${s.losses} | ${s.profitableCohort}/${report.availableCohort.later} | ${s.averageReturnPct??'N/A'} | ${s.afterHypothetical10bps.averageReturnPct??'N/A'} |`:`| ${r.target}% | No sufficiently supported calibration filter | | | | | | | | |`)}
lines.push('','## Primary predeclared 80% precision filter','',JSON.stringify(report.primary,null,2),'','## Feature ablations','',JSON.stringify(report.ablations,null,2),'','## Fresh depth coverage','',JSON.stringify(report.freshDepth,null,2),'','## Baselines and limitations','',
  'Unfiltered controls are needed because the 159 historical legs alone cannot measure false positives. All profits, losses and uncovered target legs remain in the reports; non-cohort winners are not counted as target coverage. Missing depth is never replaced with future or invented values. No changes to live strategy.',
  '','Protocol:','```json',JSON.stringify(protocol,null,2),'```','',`Exact results: ${path.basename(results)}. Frozen models: ${path.basename(modelFile)}.`,
  '',...byTiming.map(b=>`Timing ${b.delay} minutes, later baseline: ${JSON.stringify(b.later)}`))
fs.writeFileSync(findings,lines.join('\n')+'\n',{flag:'wx'})
console.log(JSON.stringify({results,findings,primary:report.primary,frontiers:outputs.map(r=>({target:r.target,calibration:r.configuration?.summary,replay:r.replay}))},null,2))
