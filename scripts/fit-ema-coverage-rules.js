import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'
import {CANDLE_CACHE,DEPTH_CACHE,DATES,REPORTS,STEM,round,rowKey,uniqueFile,save,writeCsv} from './research-ema-coverage.js'
import {enforceWarmup} from './ema-feature-warmup.js'

const pop=x=>{x-=(x>>>1)&0x55555555;x=(x&0x33333333)+((x>>>2)&0x33333333);return (((x+(x>>>4))&0x0f0f0f0f)*0x01010101)>>>24}
const mask=(n)=>new Uint32Array(Math.ceil(n/32))
function set(m,i){m[i>>>5]|=1<<(i&31)}
function and(a,b){const out=mask(a.length*32);for(let i=0;i<a.length;i++)out[i]=a[i]&b[i];return out}
function union(a,b){const out=mask(a.length*32);for(let i=0;i<a.length;i++)out[i]=a[i]|b[i];return out}
function count(m){let n=0;for(const x of m)n+=pop(x);return n}
function stats(m,positive,covered){let tp=0,fp=0;for(let i=0;i<m.length;i++){const x=m[i]&~covered[i];tp+=pop(x&positive[i]);fp+=pop(x&~positive[i])}return {tp,fp}}
function quantile(values,q){if(!values.length)return NaN;const x=q*(values.length-1),i=Math.floor(x),j=Math.ceil(x);return values[i]+(values[j]-values[i])*(x-i)}
function conditionPass(f,c){const v=f[c.feature];return Number.isFinite(v)&&(c.op==='>='?v>=c.value:v<=c.value)}
function match(e,conditions){return conditions.every(c=>conditionPass(e.features,c))}
function assignment(e,rules){return rules.findIndex(r=>match(e,r.conditions))}
const penalties=[.0001,.001,.003,.006,.01,.02,.035,.05,.075,.1,.15,.25,.5,1]

function makeConditions(events,featureNames){
  const n=events.length,positive=mask(n),out=[]
  events.forEach((e,i)=>{if(e.cohort)set(positive,i)})
  for(const feature of featureNames){
    const positives=events.filter(e=>e.cohort&&Number.isFinite(e.features[feature])).map(e=>e.features[feature]).sort((a,b)=>a-b)
    if(positives.length<6||new Set(positives).size<3)continue
    const thresholds=[...new Set([0,.02,.05,.1,.2,.35,.5,.65,.8,.9,.95,.98,1].map(q=>quantile(positives,q)))]
    for(const value of thresholds)for(const op of ['>=','<=']){
      const condition={feature,op,value},m=mask(n)
      events.forEach((e,i)=>{if(conditionPass(e.features,condition))set(m,i)})
      const s=stats(m,positive,mask(n));if(s.tp<3||s.tp+s.fp===n)continue
      out.push({conditions:[condition],m})
    }
  }
  return {conditions:out,positive}
}
function chooseRule(pool,positive,covered,penalty,remainingTarget){
  function evaluate(rule){
    const {tp,fp}=stats(rule.m,positive,covered),complexity=rule.conditions.length
    // Full residual coverage is rewarded only up to the requested training target.
    return {...rule,tp,fp,score:Math.min(tp,remainingTarget)-penalty*fp-.01*complexity}
  }
  const singles=pool.map(evaluate).filter(x=>x.tp>=3).sort((a,b)=>b.score-a.score||a.fp-b.fp)
  let best=singles[0];if(!best)return null
  // Form interpretable conjunctions from diverse leading single conditions.
  const top=[];const seen=new Set()
  for(const s of singles){const key=s.conditions[0].feature;if(seen.has(key))continue;seen.add(key);top.push(s);if(top.length>=30)break}
  const pairs=[]
  for(let i=0;i<top.length;i++)for(let j=i+1;j<top.length;j++){
    const candidate=evaluate({conditions:[...top[i].conditions,...top[j].conditions],m:and(top[i].m,top[j].m)})
    if(candidate.tp<3)continue
    pairs.push(candidate);if(candidate.score>best.score)best=candidate
  }
  pairs.sort((a,b)=>b.score-a.score)
  for(const p of pairs.slice(0,6))for(const s of top){
    if(p.conditions.some(c=>c.feature===s.conditions[0].feature))continue
    const candidate=evaluate({conditions:[...p.conditions,...s.conditions],m:and(p.m,s.m)})
    if(candidate.tp>=3&&candidate.score>best.score)best=candidate
  }
  return best
}
function fit(events,featureNames,recallTarget){
  const {conditions,positive}=makeConditions(events,featureNames),target=Math.ceil(count(positive)*recallTarget),runs=[]
  for(const penalty of penalties){
    let covered=mask(events.length),rules=[]
    for(let k=0;k<5;k++){
      const coveredTp=stats(covered,positive,mask(events.length)).tp
      if(coveredTp>=target)break
      const gainTarget=process.argv.includes('--balanced')?Math.ceil((target-coveredTp)/(5-k)):target-coveredTp
      const rule=chooseRule(conditions,positive,covered,penalty,gainTarget)
      if(!rule||rule.tp<3)break
      covered=union(covered,rule.m);rules.push({conditions:rule.conditions,trainingIncrement:{tp:rule.tp,fp:rule.fp}})
    }
    const s=stats(covered,positive,mask(events.length));runs.push({penalty,rules,tp:s.tp,fp:s.fp,target})
  }
  const meeting=runs.filter(r=>r.tp>=target).sort((a,b)=>a.fp-b.fp||a.rules.length-b.rules.length)
  const chosen=meeting[0]||runs.sort((a,b)=>b.tp-a.tp||a.fp-b.fp)[0]
  return {target,trainingPositives:count(positive),chosen,sweep:runs.map(({rules,...r})=>({...r,ruleCount:rules.length}))}
}
function performance(events){
  const days=Object.fromEntries(DATES.map(d=>[d,0]))
  for(const e of events)days[e.date]+=e.returnPct
  const worst=Object.entries(days).filter(([d])=>events.some(e=>e.date===d)).sort((a,b)=>a[1]-b[1])[0]
  const total=events.reduce((s,e)=>s+e.returnPct,0)
  return {tradeCount:events.length,winRatePct:round(100*events.filter(e=>e.returnPct>0).length/(events.length||1),2),
    averageReturnPct:round(total/(events.length||1)),summedReturnPct:round(total),
    averageMaePct:round(events.reduce((s,e)=>s+e.maePct,0)/(events.length||1)),worstMaePct:round(Math.min(0,...events.map(e=>e.maePct))),
    worstDay:worst?{date:worst[0],summedReturnPct:round(worst[1])}:null,
    averageAfterHypothetical10bpsCost:round(total/(events.length||1)-.1),
    completedCrossExits:events.filter(e=>e.exitReason==='OPPOSITE_CROSS').length,eodMarks:events.filter(e=>e.exitReason==='EOD_MARK').length}
}
function evaluate(events,rules){
  const emitted=events.filter(e=>assignment(e,rules)>=0),matched=emitted.filter(e=>e.cohort)
  return {cohortCovered:matched.length,cohortTotal:events.filter(e=>e.cohort).length,
    extraSignals:emitted.length-matched.length,losingSignals:emitted.filter(e=>e.returnPct<0).length,
    cohortPrecisionPct:round(100*matched.length/(emitted.length||1),2),performance:performance(emitted),
    byDate:DATES.map(date=>{const rs=emitted.filter(e=>e.date===date);return {date,cohortCovered:rs.filter(e=>e.cohort).length,cohortTotal:events.filter(e=>e.date===date&&e.cohort).length,performance:performance(rs)}}),
    perRule:rules.map((r,i)=>{const rs=events.filter(e=>assignment(e,rules)===i);return {pattern:i+1,conditions:r.conditions,cohortCovered:rs.filter(e=>e.cohort).length,extraSignals:rs.filter(e=>!e.cohort).length,performance:performance(rs)}})}
}
function exportSignals(name,events,rules){
  const csv=uniqueFile(`${name}-signals.csv`),ledger=uniqueFile(`${name}-cohort.csv`)
  const details=events.map(e=>({...e,pattern:assignment(e,rules)+1})).sort((a,b)=>a.signalAt-b.signalAt||a.symbol.localeCompare(b.symbol))
  const flat=e=>({date:e.date,symbol:e.symbol,side:e.side,entryTime:e.entryTime,pattern:e.pattern||'UNCOVERED',cohort:e.cohort,
    entryPrice:e.entryPrice,exitTime:e.exitTime,exitReason:e.exitReason,exitPrice:e.exitPrice,returnPct:round(e.returnPct),maePct:round(e.maePct),mfePct:round(e.mfePct),
    evidence:e.pattern?rules[e.pattern-1].conditions.map(c=>`${c.feature}=${round(e.features[c.feature],7)} ${c.op} ${round(c.value,7)}`).join('; '):''})
  writeCsv(csv,details.filter(e=>e.pattern).map(flat));writeCsv(ledger,details.filter(e=>e.cohort).map(flat))
  return {signals:csv,cohortLedger:ledger}
}

const delayed=process.argv.includes('--delay3')
const prefix=delayed?'delay3-':''
const data=JSON.parse(fs.readFileSync(delayed?path.join(REPORTS,`${STEM}-delay3-candles.json`):CANDLE_CACHE,'utf8'))
if(!delayed&&fs.existsSync(DEPTH_CACHE)){
  const depth=JSON.parse(fs.readFileSync(DEPTH_CACHE,'utf8'))
  for(const e of data.events){const values=depth.rows[rowKey(e)];if(values)for(const [k,v]of Object.entries(values))if(Number.isFinite(v))e.features[k]=v}
}
const events=data.events, features=[...new Set(events.flatMap(e=>Object.keys(e.features)))].filter(k=>!['depthAvailable','depthLastAgeSec'].includes(k))
const warmup=enforceWarmup(events)
console.log(`Full-period warmup: excluded ${warmup.removed} premature feature values`)
for(const e of events){e.maePct=Math.min(e.maePct,e.returnPct);e.mfePct=Math.max(e.mfePct,e.returnPct)}
assert.equal(events.filter(e=>e.cohort).length,data.cohort)
const earlier=events.filter(e=>DATES.indexOf(e.date)<6),later=events.filter(e=>DATES.indexOf(e.date)>=6)
console.log(`Fitting ${events.length} full-universe entries, ${features.length} features; ${events.filter(e=>e.cohort).length} cohort legs`)
const frozen=fit(earlier,features,.95)
console.log(`Earlier-date fit covered ${frozen.chosen.tp}/${frozen.trainingPositives}; ${frozen.chosen.fp} extra signals`)
const allfit=fit(events,features,Math.min(1,140/data.cohort))
console.log(`All-date exploratory fit covered ${allfit.chosen.tp}/159; ${allfit.chosen.fp} extra signals`)
const frozenEvaluation={earlier:evaluate(earlier,frozen.chosen.rules),later:evaluate(later,frozen.chosen.rules),all:evaluate(events,frozen.chosen.rules)}
const allEvaluation=evaluate(events,allfit.chosen.rules)
const baseline=performance(events)
const report={
  schemaVersion:1,generatedAt:new Date().toISOString(),dates:DATES,uniqueStocks:data.symbols,entryOpportunities:events.length,cohort:159,features:features.length,
  excludedCohort:data.excludedCohort||[],warmup,
  methodology:{entry:delayed?'Wait three completed minutes after the EMA crossover; require unchanged EMA direction throughout the wait, then enter at the next open. Features use only candles completed by this later entry.':'Next one-minute candle open after completed EMA10/EMA20 crossover; no future indicator values.',exit:'Opposite crossover: next candle open; otherwise last session close marked EOD. No stop-loss or profit target.',
    returns:'BUY (exit-entry)/entry; SELL (entry-exit)/entry. No fees, slippage, leverage, portfolio capital or position caps; summed percentages are not portfolio return.',
    cohort:'Exact original 159-leg CSV membership, retained despite correcting short-return formula.',
    chronology:'Early fit uses only Oct 5-12 thresholds and labels; frozen evaluation uses Oct 13-16. All dates were previously explored, so the later dates are not an untouched holdout.',
    exploratory:'A separate all-date fit explicitly optimizes 140/159 historical coverage. Its coverage is in-sample and does not establish future recall.',
    ruleSearch:'At most five ordered rules; at most three AND conditions per rule. First matching rule owns each signal; labels, stock identity and calendar dates are excluded from rule inputs.',
    depth:'If cache present: three prior complete receipt-time minutes with span/gap/freshness gate. Missing depth values cannot pass a numeric condition.',
    indicators:'Wilder RSI5/7/14/21; MFI7/14/21; MACD5/13/4,8/21/5,12/26/9; session VWAP; simple-average true-range ATR7/14/21; resistance/support10/20/50; regression3/5/10/20; EMA gaps, volume and momentum. Complete session-anchored 3/5/10/15-minute candles; NIFTY and causal cross-stock breadth. Slopes and angles use percent log-price change per bar.'},
  baseline,
  frozenEarlierFit:{selection:frozen.sweep,trainingTarget:frozen.target,rules:frozen.chosen.rules,evaluation:frozenEvaluation,files:exportSignals(`${prefix}frozen`,events,frozen.chosen.rules)},
  exploratory140Fit:{selection:allfit.sweep,trainingTarget:allfit.target,rules:allfit.chosen.rules,evaluation:allEvaluation,files:exportSignals(`${prefix}exploratory140`,events,allfit.chosen.rules)}
}
const file=uniqueFile(`${prefix}results.json`);save(file,report)
const markdown=uniqueFile(`${prefix}findings.md`)
const describe=cs=>cs.map(c=>`\`${c.feature} ${c.op} ${Number(c.value.toPrecision(8))}\``).join(' AND ')
const table=rs=>['| Pattern | Causal conditions at crossover close | Cohort legs | Extra signals | Win rate | Average gross return |','| --- | --- | ---: | ---: | ---: | ---: |',
  ...rs.map(r=>`| ${r.pattern} | ${describe(r.conditions)} | ${r.cohortCovered} | ${r.extraSignals} | ${r.performance.winRatePct}% | ${r.performance.averageReturnPct}% |`)].join('\n')
const lines=[
  '# Five-pattern EMA coverage audit',
  `Full replay: ${events.length} crossover opportunities in ${data.symbols} unique stocks across the ten requested dates. The original 159 legs remain the target cohort.`,
  '## Historical 140-leg coverage fit',
  `Covered ${allEvaluation.cohortCovered}/159 original legs using ${allfit.chosen.rules.length} ordered rules. Extra signals: ${allEvaluation.extraSignals}; losing signals: ${allEvaluation.losingSignals}.`,
  table(allEvaluation.perRule),
  `Overall win rate: ${allEvaluation.performance.winRatePct}%; average gross return: ${allEvaluation.performance.averageReturnPct}%; summed trade returns: ${allEvaluation.performance.summedReturnPct} percentage points; worst adverse excursion: ${allEvaluation.performance.worstMaePct}%.`,
  'This fit uses labels from all ten dates to seek historical coverage. It is an exploratory fitted description, not an out-of-sample result. Coverage measures recall of the selected winners, not the win rate of emitted signals.',
  '## Earlier-fit chronological replay',
  `The earlier-only fit used Oct 5-12, with no Oct 13-16 thresholds or labels in selection. It captured ${frozenEvaluation.later.cohortCovered}/${frozenEvaluation.later.cohortTotal} later-date cohort legs while emitting ${frozenEvaluation.later.performance.tradeCount} later-date signals; ${frozenEvaluation.later.losingSignals} lost money. Later-date average gross return: ${frozenEvaluation.later.performance.averageReturnPct}%.`,
  table(frozenEvaluation.later.perRule),
  'All dates have already been inspected during prior research, so this chronological replay is not an untouched external holdout. New dates are needed for an independent test.',
  '## Exact execution and feature definitions',
  report.methodology.entry,report.methodology.exit,report.methodology.returns,report.methodology.indicators,
  'Apply rules in numbered order; the first match owns the signal. BUY directional features retain their sign; SELL directional features multiply by -1. ATR, volatility, regression fit and volume ratios retain their raw positive values. RSI/MFI values are centered on 50 before direction normalization. Numeric conditions fail for missing features.',
  'Higher-timeframe ret1 is the return of one completed bar; ret3 is three completed bars. Every frame is anchored at 09:15 IST, and unfinished bars are excluded. No stock identity, date or future return can appear in a rule.',
  'Cash-depth delta is a price-change signed cumulative-volume proxy, not exchange-aggressor trade delta or option Greek delta. Historical OI is excluded unless present in the dated archive. NIFTY volume-derived features are unavailable or constant when the provider reports zero volume.',
  delayed?'Features prefixed cross_ are the depth context at the original crossover, known three minutes before this delayed entry. They are not presented as fresh depth at the delayed entry.': 'Depth features describe the three minutes immediately preceding entry.',
  'The prior analysis compared only 318 sampled losing legs, screened rules on its claimed holdout, and described three aggregated bars as a single-bar return. It also used reciprocal short returns. Those previous precision figures and pattern descriptions should not be treated as validated live performance.',
  '## Files',
  `Full machine-readable report: ${path.basename(file)}.`,
  `Historical coverage signals: ${path.basename(report.exploratory140Fit.files.signals)}.`,
  `Every original leg, matched rule, and evidence: ${path.basename(report.exploratory140Fit.files.cohortLedger)}.`,
  `Frozen earlier-fit signals: ${path.basename(report.frozenEarlierFit.files.signals)}.`,
]
fs.writeFileSync(markdown,lines.join('\n\n')+'\n',{flag:'wx'})
console.log(JSON.stringify({report:file,findings:markdown,baseline,
  frozenLater:{coverage:frozenEvaluation.later.cohortCovered,total:frozenEvaluation.later.cohortTotal,extra:frozenEvaluation.later.extraSignals,performance:frozenEvaluation.later.performance},
  exploratory:{coverage:allEvaluation.cohortCovered,extra:allEvaluation.extraSignals,losses:allEvaluation.losingSignals,performance:allEvaluation.performance,perRule:allEvaluation.perRule}},null,2))
