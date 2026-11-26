import {firstSignals,summarize} from './ema-advanced-filter-core.js'

export const FAMILIES=[
  {name:'Momentum expansion',conditions:[{feature:'returnAtr3',op:'>=',value:.5},{feature:'efficiency5',op:'>=',value:.3}]},
  {name:'Pullback reclaim',conditions:[{feature:'rsi14',op:'<=',value:0},{feature:'priceEma10',op:'>=',value:0},{feature:'ret3',op:'>',value:0}]},
  {name:'NIFTY-relative breakout',conditions:[{feature:'breakout20',op:'>=',value:0},{feature:'relativeRet5',op:'>=',value:.05}]},
  {name:'Multi-timeframe continuation',conditions:[{feature:'tf3_priceEma10',op:'>=',value:0},{feature:'tf5_priceEma10',op:'>=',value:0}]},
  {name:'Price-led depth absorption',conditions:[{feature:'depthFull',op:'<=',value:-.1},{feature:'depthMidReturn',op:'>',value:0},{feature:'ret3',op:'>',value:0}]}
]
export function conditionPass(features,c){const v=features[c.feature];return Number.isFinite(v)&&(c.op==='>'?v>c.value:c.op==='>='?v>=c.value:c.op==='<'?v<c.value:v<=c.value)}
export function rulePass(e,r){return e.delay===r.delay&&r.conditions.every(c=>conditionPass(e.features,c))}
export function execute(rows,rules){
  return firstSignals(rows,e=>e.baseMatch||rules.some(r=>rulePass(e,r))).map(e=>({...e,pattern:e.baseMatch?'BASE':rules.find(r=>rulePass(e,r)).name}))
}
export function changes(before,after){
  const old=new Map(before.map(e=>[e.key,e])),next=new Map(after.map(e=>[e.key,e]))
  const newBad=after.filter(e=>e.returnPct<=0&&(!old.has(e.key)||old.get(e.key).returnPct>0))
  const removedBad=before.filter(e=>e.returnPct<=0&&(!next.has(e.key)||next.get(e.key).returnPct>0))
  const gained=after.filter(e=>e.cohort&&e.returnPct>0&&(!old.has(e.key)||old.get(e.key).returnPct<=0))
  const lost=before.filter(e=>e.cohort&&e.returnPct>0&&(!next.has(e.key)||next.get(e.key).returnPct<=0))
  return {newTargetWinners:gained.length,lostTargetWinners:lost.length,newNonPositive:newBad.length,removedNonPositive:removedBad.length,
    newlyTradedKeys:after.filter(e=>!old.has(e.key)).length,earlierReplacements:after.filter(e=>old.has(e.key)&&e.signalAt<old.get(e.key).signalAt).length,
    newTargetKeys:gained.map(e=>e.key),lostTargetKeys:lost.map(e=>e.key)}
}

const pop=x=>{x-=(x>>>1)&0x55555555;x=(x&0x33333333)+((x>>>2)&0x33333333);return (((x+(x>>>4))&0x0f0f0f0f)*0x01010101)>>>24}
const mask=n=>new Uint32Array(Math.ceil(n/32))
const set=(m,i)=>{m[i>>>5]|=1<<(i&31)}
function intersect(a,b){const out=new Uint32Array(a.length);for(let i=0;i<a.length;i++)out[i]=a[i]&b[i];return out}
function countAnd(a,b){let n=0;for(let i=0;i<a.length;i++)n+=pop(a[i]&b[i]);return n}
function quantile(xs,q){return xs[Math.floor((xs.length-1)*q)]}
function signature(cs){return cs.map(c=>`${c.feature}:${c.op}:${c.value}`).sort().join('|')}

export function discover(rows,{maxExtra=2,beamWidth=16}={}){
  const baseline=new Map(execute(rows,[]).map(e=>[e.key,e])),proposals=[]
  for(const delay of [0,3,5]){
    const stage=rows.filter(e=>e.delay===delay),positive=mask(stage.length),bad=mask(stage.length),lost=mask(stage.length)
    stage.forEach((e,i)=>{
      const b=baseline.get(e.key),canReplace=!b||e.signalAt<b.signalAt
      if(e.cohort&&e.returnPct>0)set(positive,i)
      if(canReplace&&e.returnPct<=0&&(!b||b.returnPct>0))set(bad,i)
      if(canReplace&&e.returnPct<=0&&b?.cohort&&b.returnPct>0)set(lost,i)
    })
    const atoms=[]
    const features=[...new Set(stage.flatMap(e=>Object.keys(e.features)))].filter(k=>!['depthAvailable','depthLastAgeSec','confirmationDelay'].includes(k))
    for(const feature of features){
      const vals=stage.filter(e=>e.cohort&&Number.isFinite(e.features[feature])).map(e=>e.features[feature]).sort((a,b)=>a-b)
      if(vals.length<8||new Set(vals).size<4)continue
      const cuts=[...new Set([0,...[.1,.25,.5,.75,.9].map(q=>Number(quantile(vals,q).toPrecision(3)))])]
      for(const value of cuts)for(const op of ['>=','<=']){
        const c={feature,value,op},m=mask(stage.length)
        stage.forEach((e,i)=>{if(conditionPass(e.features,c))set(m,i)})
        atoms.push({c,m})
      }
    }
    const assess=(m,conditions)=>({m,conditions,tp:countAnd(m,positive),bad:countAnd(m,bad),lost:countAnd(m,lost)})
    for(const family of FAMILIES){
      const base=mask(stage.length);stage.forEach((e,i)=>{if(family.conditions.every(c=>conditionPass(e.features,c)))set(base,i)})
      const initial=assess(base,family.conditions);if(initial.tp<3)continue
      const singles=atoms.map(a=>({...assess(intersect(base,a.m),[...family.conditions,a.c]),atom:a})).filter(x=>x.tp>=3&&x.lost===0)
      const scoring=x=>x.tp/Math.sqrt(x.bad+1)-.02*x.conditions.length
      singles.sort((a,b)=>scoring(b)-scoring(a)||b.tp-a.tp)
      const pool=[],counts=new Map()
      for(const s of singles){const n=counts.get(s.atom.c.feature)||0;if(n>=2)continue;counts.set(s.atom.c.feature,n+1);pool.push(s.atom);if(pool.length>=160)break}
      let beam=[initial,...singles.slice(0,beamWidth)],all=[initial,...singles],seen=new Set()
      for(let depth=2;depth<=maxExtra;depth++){
        const expanded=[]
        for(const parent of beam)for(const atom of pool){
          if(parent.conditions.some(c=>c.feature===atom.c.feature&&c.op===atom.c.op))continue
          const cs=[...parent.conditions,atom.c],id=signature(cs);if(seen.has(id))continue;seen.add(id)
          const candidate=assess(intersect(parent.m,atom.m),cs);if(candidate.tp<3||candidate.lost)continue
          expanded.push(candidate)
        }
        expanded.sort((a,b)=>scoring(b)-scoring(a)||b.tp-a.tp)
        beam=expanded.slice(0,beamWidth);all.push(...expanded)
      }
      const picked=new Map()
      for(const penalty of [0,.01,.03,.1,.3,1,3]){
        const ranked=all.filter(x=>x.lost===0).sort((a,b)=>(b.tp-penalty*b.bad-.02*b.conditions.length)-(a.tp-penalty*a.bad-.02*a.conditions.length))
        for(const c of ranked.slice(0,8))picked.set(signature(c.conditions),c)
      }
      for(const c of picked.values()){
        const hit=stage.filter((e,i)=>!!(c.m[i>>>5]&(1<<(i&31))))
        if(new Set(hit.filter(e=>e.cohort&&e.returnPct>0).map(e=>e.date)).size<2)continue
        proposals.push({name:family.name,delay,conditions:c.conditions,fitTargetSupport:c.tp,fitNewNonPositive:c.bad})
      }
      console.log(`${family.name}, delay${delay}: ${initial.tp} target support; ${picked.size} proposed bounds`)
    }
  }
  return proposals
}

export function choose(rowsFit,rowsCal,proposals,{strict=false,maxPatterns=5}={}){
  const rules=[],steps=[],used=new Set();let beforeFit=execute(rowsFit,[]),beforeCal=execute(rowsCal,[])
  for(let step=0;step<maxPatterns;step++){
    const candidates=[]
    for(const rule of proposals){
      if(used.has(rule.name))continue
      const combined=[...rules,rule],afterFit=execute(rowsFit,combined),fitChange=changes(beforeFit,afterFit)
      if(fitChange.lostTargetWinners||strict&&fitChange.newNonPositive)continue
      const afterCal=execute(rowsCal,combined),calChange=changes(beforeCal,afterCal)
      if(calChange.lostTargetWinners||calChange.newTargetWinners<1||strict&&calChange.newNonPositive)continue
      const calStats=summarize(afterCal)
      if(calStats.averageReturnPct<=0)continue
      candidates.push({rule,fitChange,calChange,afterFit,afterCal,calStats,
        score:calChange.newTargetWinners/(calChange.newNonPositive+1)})
    }
    candidates.sort((a,b)=>b.score-a.score||b.calChange.newTargetWinners-a.calChange.newTargetWinners||a.calChange.newNonPositive-b.calChange.newNonPositive||a.rule.conditions.length-b.rule.conditions.length||a.rule.name.localeCompare(b.rule.name))
    const best=candidates[0];if(!best)break
    rules.push(best.rule);used.add(best.rule.name);beforeFit=best.afterFit;beforeCal=best.afterCal
    steps.push({pattern:rules.length,...Object.fromEntries(Object.entries(best).filter(([k])=>!['afterFit','afterCal','score'].includes(k)))})
  }
  return {rules,steps,fit:summarize(beforeFit),calibration:summarize(beforeCal)}
}
