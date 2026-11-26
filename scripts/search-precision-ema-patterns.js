import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'
import {pathToFileURL} from 'node:url'
import {CANDLE_CACHE,DEPTH_CACHE,DATES,REPORTS,STEM,round,rowKey,uniqueFile,save,writeCsv} from './research-ema-coverage.js'
import {enforceWarmup} from './ema-feature-warmup.js'

const MAX_RULES=10, MAX_DEPTH=8, BEAM=24, POOL=360
const pop=x=>{x-=(x>>>1)&0x55555555;x=(x&0x33333333)+((x>>>2)&0x33333333);return (((x+(x>>>4))&0x0f0f0f0f)*0x01010101)>>>24}
const mask=n=>new Uint32Array(Math.ceil(n/32))
const set=(m,i)=>{m[i>>>5]|=1<<(i&31)}
function intersect(a,b){const out=new Uint32Array(a.length);for(let i=0;i<a.length;i++)out[i]=a[i]&b[i];return out}
function remove(a,b){for(let i=0;i<a.length;i++)a[i]&=~b[i]}
function count(a){let n=0;for(const x of a)n+=pop(x);return n}
function countAnd(a,b){let n=0;for(let i=0;i<a.length;i++)n+=pop(a[i]&b[i]);return n}
function quantile(v,q){const x=(v.length-1)*q,i=Math.floor(x),j=Math.ceil(x);return v[i]+(v[j]-v[i])*(x-i)}
function originalKey(e){return rowKey({...e,entryTime:e.originalEntryTime||e.entryTime})}
function passes(value,c){return Number.isFinite(value)&&(c.op==='>='?value>=c.value:c.op==='>'?value>c.value:c.op==='<'?value<c.value:value<=c.value)}
function matching(e,r){return e.delay===r.delay&&r.conditions.every(c=>passes(e.features[c.feature],c))}

function prepare(delays=[0,3]){
  const data=JSON.parse(fs.readFileSync(CANDLE_CACHE,'utf8')),depth=JSON.parse(fs.readFileSync(DEPTH_CACHE,'utf8')).rows
  for(const e of data.events){const dep=depth[rowKey(e)];if(dep)for(const [k,v]of Object.entries(dep))if(Number.isFinite(v)&&!['depthAvailable','depthLastAgeSec'].includes(k))e.features[`cross_${k}`]=v;e.delay=0}
  const events=[...data.events]
  for(const delay of delays.filter(d=>d!==0)){
    const delayed=JSON.parse(fs.readFileSync(path.join(REPORTS,`${STEM}-delay${delay}-candles.json`),'utf8'))
    for(const e of delayed.events)e.delay=delay
    events.push(...delayed.events)
  }
  enforceWarmup(events)
  for(const e of events){e.key=originalKey(e);e.maePct=Math.min(e.maePct,e.returnPct);e.mfePct=Math.max(e.mfePct,e.returnPct)}
  assert.equal(new Set(events.filter(e=>e.cohort).map(e=>e.key)).size,159)
  console.log(`Prepared ${events.length} entry views; ${new Set(events.map(e=>e.key)).size} unique legs`)
  return events
}

function makeAtoms(events,delay){
  const stage=events.filter(e=>e.delay===delay),n=stage.length,features=[...new Set(stage.flatMap(e=>Object.keys(e.features)))],atoms=[]
  for(const feature of features){
    const vals=stage.filter(e=>e.cohort&&e.returnPct>0&&Number.isFinite(e.features[feature])).map(e=>e.features[feature]).sort((a,b)=>a-b)
    if(vals.length<4||new Set(vals).size<3)continue
    const thresholds=[...new Set([0,.025,.05,.1,.15,.2,.3,.4,.5,.6,.7,.8,.85,.9,.95,.975,1].map(q=>quantile(vals,q)))]
    for(const value of thresholds)for(const op of ['>=','<=']){
      const c={feature,op,value},m=mask(n)
      stage.forEach((e,i)=>{if(passes(e.features[feature],c))set(m,i)})
      atoms.push({c,m})
    }
  }
  const positive=mask(n),negative=mask(n)
  stage.forEach((e,i)=>{if(e.cohort&&e.returnPct>0)set(positive,i);if(e.returnPct<=0)set(negative,i)})
  return {stage,delay,atoms,positive,negative,n}
}

function learnRule(ctx,coveredKeys,minimum=3){
  const positive=ctx.positive.slice(),negative=ctx.negative.slice()
  ctx.stage.forEach((e,i)=>{if(coveredKeys.has(e.key)){positive[i>>>5]&=~(1<<(i&31));if(coveredKeys.get(e.key)<=e.signalAt)negative[i>>>5]&=~(1<<(i&31))}})
  if(count(positive)<minimum)return null
  function assess(m,conditions){
    const tp=countAnd(m,positive),loss=countAnd(m,negative)
    return {m,conditions,tp,loss,score:tp/Math.sqrt(loss+1)-.015*conditions.length}
  }
  const singles=ctx.atoms.map(a=>({...assess(a.m,[a.c]),atom:a})).filter(x=>x.tp>=minimum)
  singles.sort((a,b)=>b.score-a.score||b.tp-a.tp)
  const atomPool=[],perFeature=new Map()
  for(const s of singles){const feature=s.atom.c.feature,n=perFeature.get(feature)||0;if(n>=3)continue;perFeature.set(feature,n+1);atomPool.push(s.atom);if(atomPool.length>=POOL)break}
  // Retain some broad bounds as well as high-scoring marginal conditions, so
  // intervals and interactions can rescue individually weak predictors.
  const broad=singles.filter(s=>s.tp>=Math.max(minimum,count(positive)*.45)).sort((a,b)=>a.loss-b.loss)
  const known=new Set(atomPool.map(a=>`${a.c.feature}|${a.c.op}|${a.c.value}`))
  for(const s of broad){const key=`${s.atom.c.feature}|${s.atom.c.op}|${s.atom.c.value}`;if(known.has(key))continue;known.add(key);atomPool.push(s.atom);if(atomPool.length>=POOL+100)break}
  let beam=singles.slice(0,BEAM),pure=singles.filter(x=>x.loss===0),frontier=[]
  for(let depth=2;depth<=MAX_DEPTH;depth++){
    const candidates=[],seen=new Set()
    for(const parent of beam)for(const atom of atomPool){
      if(parent.conditions.some(c=>c.feature===atom.c.feature&&c.op===atom.c.op))continue
      const conditions=[...parent.conditions,atom.c]
      const signature=conditions.map(c=>`${c.feature}|${c.op}|${c.value}`).sort().join('&');if(seen.has(signature))continue;seen.add(signature)
      const m=intersect(parent.m,atom.m),tp=countAnd(m,positive)
      if(tp<minimum||tp===parent.tp&&countAnd(m,negative)===parent.loss)continue
      const candidate=assess(m,conditions)
      if(candidate.loss===0)pure.push(candidate)
      candidates.push(candidate)
    }
    if(!candidates.length)break
    candidates.sort((a,b)=>b.score-a.score||b.tp-a.tp||a.conditions.length-b.conditions.length)
    frontier.push(...candidates.slice(0,10).map(({tp,loss,conditions})=>({tp,loss,conditions:conditions.length})))
    beam=[];const maskSeen=new Set()
    for(const c of candidates){
      // Avoid filling the beam with different descriptions of the same matching set.
      let hash=2166136261;for(const x of c.m)hash=Math.imul(hash^x,16777619)
      const key=`${c.tp}|${c.loss}|${hash>>>0}`;if(maskSeen.has(key))continue;maskSeen.add(key);beam.push(c);if(beam.length>=BEAM)break
    }
  }
  pure.sort((a,b)=>b.tp-a.tp||a.conditions.length-b.conditions.length)
  if(!pure.length)return {best:null,frontier}
  const best=pure[0]
  return {best:{delay:ctx.delay,conditions:best.conditions,tp:best.tp,loss:best.loss},frontier}
}

function selected(events,rules){
  const grouped=new Map()
  for(const e of events){const pattern=rules.findIndex(r=>matching(e,r));if(pattern<0)continue
    const old=grouped.get(e.key)
    if(!old||e.signalAt<old.signalAt||e.signalAt===old.signalAt&&pattern<old.pattern)grouped.set(e.key,{...e,pattern})
  }
  return [...grouped.values()].sort((a,b)=>a.signalAt-b.signalAt||a.symbol.localeCompare(b.symbol))
}
function stats(events,rules){
  const signals=selected(events,rules),cohort=signals.filter(e=>e.cohort),total=signals.reduce((s,e)=>s+e.returnPct,0),days=new Map()
  for(const e of signals)days.set(e.date,(days.get(e.date)||0)+e.returnPct)
  const worst=[...days].sort((a,b)=>a[1]-b[1])[0]
  return {cohortCovered:cohort.length,profitableCohortCovered:cohort.filter(e=>e.returnPct>0).length,cohortAvailable:new Set(events.filter(e=>e.cohort).map(e=>e.key)).size,
    trades:signals.length,winners:signals.filter(e=>e.returnPct>0).length,losses:signals.filter(e=>e.returnPct<0).length,breakeven:signals.filter(e=>e.returnPct===0).length,
    winRatePct:round(100*signals.filter(e=>e.returnPct>0).length/(signals.length||1),2),averageReturnPct:round(total/(signals.length||1)),summedReturnPct:round(total),
    averageMaePct:round(signals.reduce((s,e)=>s+e.maePct,0)/(signals.length||1)),worstMaePct:round(Math.min(0,...signals.map(e=>e.maePct))),
    worstDay:worst?{date:worst[0],summedReturnPct:round(worst[1])}:null,
    afterHypothetical10bps:{winners:signals.filter(e=>e.returnPct>.1).length,nonPositive:signals.filter(e=>e.returnPct<=.1).length,averageReturnPct:round(total/(signals.length||1)-.1)},
    byPattern:rules.map((r,i)=>{const ss=signals.filter(e=>e.pattern===i);return {pattern:i+1,delay:r.delay,cohortCovered:ss.filter(e=>e.cohort).length,trades:ss.length,losses:ss.filter(e=>e.returnPct<=0).length,conditions:r.conditions}})}
}
function fit(events,name){
  const contexts=[makeAtoms(events,0),makeAtoms(events,3)],rules=[],covered=new Map(),history=[]
  for(let step=0;step<MAX_RULES;step++){
    const attempts=contexts.map(ctx=>learnRule(ctx,covered)).filter(Boolean)
    const candidates=attempts.map(a=>a.best).filter(Boolean).sort((a,b)=>b.tp-a.tp||a.conditions.length-b.conditions.length||a.delay-b.delay)
    let picked=null
    for(const candidate of candidates){
      const combined=[...rules,candidate],s=stats(events,combined)
      // Check actual chronological execution: an earlier entry can supersede
      // a later rule, so stand-alone purity alone is insufficient.
      if(s.losses===0&&s.breakeven===0){picked=candidate;break}
    }
    history.push({step:step+1,candidates,frontier:attempts.flatMap(a=>a.frontier).slice(0,30)})
    if(!picked)break
    rules.push(picked)
    for(const e of selected(events,rules))covered.set(e.key,e.signalAt)
    const s=stats(events,rules)
    console.log(`${name} rule ${rules.length}: ${s.profitableCohortCovered} cohort, ${s.trades} trades, ${s.losses} losses; depth ${picked.conditions.length}, delay ${picked.delay}`)
  }
  return {rules,history,training:stats(events,rules)}
}
function exportCsv(events,rules,suffix){
  const signals=selected(events,rules),signalMap=new Map(signals.map(e=>[e.key,e]))
  const file=uniqueFile(`precision10-${suffix}-signals.csv`),ledger=uniqueFile(`precision10-${suffix}-cohort.csv`)
  const flat=e=>({date:e.date,symbol:e.symbol,side:e.side,originalEntryTime:e.originalEntryTime||e.entryTime,entryTime:e.entryTime,delayMinutes:e.delay,
    pattern:e.pattern+1,cohort:e.cohort,entryPrice:e.entryPrice,exitTime:e.exitTime,exitReason:e.exitReason,exitPrice:e.exitPrice,returnPct:round(e.returnPct),maePct:round(e.maePct)})
  writeCsv(file,signals.map(flat))
  const cohort=[...new Map(events.filter(e=>e.cohort).map(e=>[e.key,e])).values()].map(e=>{
    const hit=signalMap.get(e.key);return hit?flat(hit):{date:e.date,symbol:e.symbol,side:e.side,originalEntryTime:e.originalEntryTime||e.entryTime,pattern:'UNCOVERED'}
  })
  writeCsv(ledger,cohort);return {signals:file,cohort:ledger}
}

async function main(){
const events=prepare(),earlier=events.filter(e=>DATES.indexOf(e.date)<6),later=events.filter(e=>DATES.indexOf(e.date)>=6)
const frozen=fit(earlier,'Earlier fit'),exploratory=fit(events,'All-date exploratory fit')
const report={generatedAt:new Date().toISOString(),objective:'At most ten ordered entry rules, zero non-positive gross outcomes on fitting data, maximize unique profitable original-cohort coverage.',
  protocol:{dates:DATES,maxRules:MAX_RULES,maxConditions:MAX_DEPTH,beam:BEAM,
    target:'125-159 of the original 159 legs; a captured leg counts as successful only when the selected entry itself has positive gross return.',
    negative:'All return<=0 entry outcomes; profitable non-cohort legs are neutral allowed trades. Future outcomes are training labels only, never input features.',
    inputs:'Existing causal candle, multi-timeframe, NIFTY, cross-stock breadth and original-cross depth features; full lookback warmup enforced. No symbol/date/time identity conditions.',
    timing:'Check rules at the next open after completed EMA crossover and again three completed minutes later if no entry occurred. Earliest matching entry owns the leg. No stop-loss or profit target; opposite cross or EOD mark exits.',
    limitations:'Up to eight thresholds per pattern can overfit. All-date zero-loss fits are retrospective descriptions. Earlier-only fit is replayed unchanged on Oct13-16; these dates have previously been explored and are not a fresh holdout. Costs are excluded; 10bps is a hypothetical cost sensitivity, not an estimate of actual charges.'},
  frozen:{...frozen,later:stats(later,frozen.rules),all:stats(events,frozen.rules),files:exportCsv(events,frozen.rules,'frozen')},
  exploratory:{...exploratory,files:exportCsv(events,exploratory.rules,'exploratory')},
}
const file=uniqueFile('precision10-results.json');save(file,report)
const describe=cs=>cs.map(c=>`\`${c.feature} ${c.op} ${Number(c.value.toPrecision(8))}\``).join(' AND ')
const table=(rs)=>['| Pattern | Delay | Conditions | Target legs | Trades | Non-positive |','| --- | ---: | --- | ---: | ---: | ---: |',...rs.map(r=>`| ${r.pattern} | ${r.delay} min | ${describe(r.conditions)} | ${r.cohortCovered} | ${r.trades} | ${r.losses} |`)].join('\n')
const markdown=uniqueFile('precision10-findings.md')
const text=[
  '# Precision-first ten-pattern research',
  'The objective is zero non-positive outcomes on fitting data, with as much original-cohort coverage as possible. This objective replaces the previous coverage-first search.',
  `All-date exploratory fit: ${exploratory.rules.length} rules; ${exploratory.training.profitableCohortCovered}/159 profitable cohort legs; ${exploratory.training.trades} trades; ${exploratory.training.losses} losses and ${exploratory.training.breakeven} breakeven outcomes; average gross return ${exploratory.training.averageReturnPct}%. These are fitted historical results.`,
  table(exploratory.training.byPattern),
  `Earlier-fit chronological replay: training covered ${frozen.training.profitableCohortCovered}/${frozen.training.cohortAvailable} target legs with ${frozen.training.losses} losses. Later-date replay covered ${report.frozen.later.profitableCohortCovered}/${report.frozen.later.cohortAvailable} profitably, with ${report.frozen.later.trades} trades and ${report.frozen.later.losses} losses; average return ${report.frozen.later.averageReturnPct}%. No later labels or thresholds were used to pick those rules.`,
  table(report.frozen.later.byPattern),
  JSON.stringify(report.protocol,null,2),
  `Exact thresholds, metrics, and search support: ${path.basename(file)}.`,
  `All exploratory signals: ${path.basename(report.exploratory.files.signals)}.`,
  `Every cohort leg and its exploratory assignment: ${path.basename(report.exploratory.files.cohort)}.`,
  `Frozen-rule signals: ${path.basename(report.frozen.files.signals)}.`,
].join('\n\n')+'\n'
fs.writeFileSync(markdown,text,{flag:'wx'})
console.log(JSON.stringify({report:file,findings:markdown,exploratory:exploratory.training,frozenTraining:frozen.training,frozenLater:report.frozen.later},null,2))
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href)await main()
export {prepare,stats,selected,exportCsv,matching,passes}
