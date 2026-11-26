import {loadCandles,MINUTE,DATES} from './research-ema-coverage.js'
import {matching,selected} from './search-precision-ema-patterns.js'

// Price-only index context: indices have zero reported volume in these files.
// A feature for time t uses only candles whose END is <= t. No cross-day fill.
export function sectorSeries(rows){
  let e10,e20
  return rows.map((r,i)=>{
    e10=e10===undefined?r.c:e10+(r.c-e10)*2/11
    e20=e20===undefined?r.c:e20+(r.c-e20)*2/21
    const f={}
    for(const n of [3,5,10,15,30]){
      const start=i-n+1
      if(start<0||r.t-rows[start].t!==(n-1)*MINUTE)continue
      f[`ret${n}`]=100*(r.c/rows[start].o-1)
    }
    if(i>=19&&r.t-rows[i-19].t===19*MINUTE)f.emaGap=10000*(e10-e20)/r.c
    return {end:r.t+MINUTE,features:f}
  })
}

export function sectorAt(series,t){
  let low=0,high=series.length
  while(low<high){const mid=(low+high)>>>1;if(series[mid].end<=t)low=mid+1;else high=mid}
  const bar=series[low-1]
  // Require the latest minute exactly; stale/missing data cannot be a filter.
  return bar?.end===t?bar:null
}

export function attachSectorContext(events,indexDefinitions,buckets){
  const indices=new Map(),coverage=[]
  for(const {name} of indexDefinitions){
    const sessions=loadCandles(name)
    coverage.push({index:name,counts:Object.fromEntries(DATES.map(d=>[d,sessions.get(d)?.length||0]))})
    if(sessions.size)indices.set(name,new Map([...sessions].map(([d,rs])=>[d,sectorSeries(rs)])))
  }
  // These are business-sector proxies from the workspace, NOT verified official
  // point-in-time membership. Do not map the mixed telecom bucket to NIFTY MEDIA,
  // or electronics manufacturing (CYIENTDLM) to software services.
  const allowed=new Set(['NIFTY_AUTO','NIFTY_BANK','NIFTY_FMCG','NIFTY_IT','NIFTY_METAL','NIFTY_PHARMA','NIFTY_REALTY','NIFTY_HEALTHCARE'])
  const mapping={}
  for(const {name,bucket} of indexDefinitions){
    if(!allowed.has(bucket)||!indices.has(name)||['NIFTYPSUBANK','NIFTYPRIVBANK'].includes(name))continue
    for(const symbol of buckets[bucket]||[])if(symbol!=='CYIENTDLM')mapping[symbol]=name
  }
  let mappedViews=0
  const targetMapped=new Set()
  for(const e of events){
    const d=e.side==='BUY'?1:-1,returns=[]
    for(const [name,sessions] of indices){
      const bar=sectorAt(sessions.get(e.date)||[],e.signalAt)
      if(!bar)continue
      for(const key of ['ret3','ret10','ret30','emaGap'])if(Number.isFinite(bar.features[key]))e.features[`index_${name}_${key}`]=d*bar.features[key]
      if(Number.isFinite(bar.features.ret10))returns.push(d*bar.features.ret10)
    }
    if(returns.length>=3){
      e.features.sectorBreadth10=returns.filter(x=>x>0).length/returns.length
      e.features.sectorMean10=returns.reduce((a,b)=>a+b,0)/returns.length
    }
    const proxy=mapping[e.symbol],bar=proxy?sectorAt(indices.get(proxy)?.get(e.date)||[],e.signalAt):null
    if(!bar)continue
    e.sectorProxy=proxy;e.sectorDataThrough=bar.end;mappedViews++
    if(e.cohort)targetMapped.add(e.key)
    for(const [k,v] of Object.entries(bar.features))e.features[`sector_${k}`]=d*v
    for(const n of [3,5,10,15,30]){
      const own=e.features[`ret${n}`],sector=e.features[`sector_ret${n}`]
      if(Number.isFinite(own)&&Number.isFinite(sector))e.features[`sectorRelative${n}`]=own-sector
    }
  }
  return {coverage,mapping,mappedViews,mappedTargets:targetMapped.size,availableIndices:[...indices.keys()],
    mappingNote:'Workspace business-sector proxies, not official historical constituent membership. Unsupported/mixed buckets left unmapped. All available indices also provide broad market context for every stock.'}
}

export function pureCover(events,candidates,{maxRules=60,minSupport=4}={}){
  const covered=new Set(),rules=[],remaining=candidates.filter(r=>new Set(r.positiveKeys).size>=minSupport)
  while(rules.length<maxRules){
    let best,gain=0
    for(const r of remaining){
      const g=r.positiveKeys.filter(k=>!covered.has(k)).length
      if(g>gain||(g===gain&&g>0&&r.conditions.length<best.conditions.length)){best=r;gain=g}
    }
    if(!best||!gain)break
    const hits=events.filter(e=>matching(e,best))
    const support=new Set(hits.filter(e=>e.cohort&&e.returnPct>0).map(e=>e.key))
    if(support.size<minSupport||hits.some(e=>e.returnPct<=0||!Number.isFinite(e.returnPct)))throw new Error('Candidate purity/support audit failed')
    rules.push({id:`P${String(rules.length+1).padStart(2,'0')}`,delay:best.delay,conditions:best.conditions,
      standaloneTargetSupport:support.size,standaloneTrades:hits.length,standaloneDates:[...new Set(hits.map(e=>e.date))].sort(),incrementalTargets:gain})
    support.forEach(k=>covered.add(k))
  }
  const signals=selected(events,rules)
  if(signals.some(e=>e.returnPct<=0))throw new Error('Combined replay emitted non-positive fitting trade')
  return {rules,candidateGroups:candidates.length,covered:covered.size}
}
