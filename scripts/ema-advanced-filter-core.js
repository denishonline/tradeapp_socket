import {MINUTE,loadCandles,round,DATES} from './research-ema-coverage.js'
import {sessionFlowMap} from './ema-session-flow-features.js'
import {priceActionSeries} from './ema-price-action-features.js'

export function random(seed){return ()=>{seed|=0;seed=seed+0x6D2B79F5|0;let t=Math.imul(seed^seed>>>15,1|seed);t=t+Math.imul(t^t>>>7,61|t)^t;return ((t^t>>>14)>>>0)/4294967296}}

// Order is placed using information at signalAt. Fill at the close of the
// following one-minute candle, not its open and not an outcome-selected price.
export function completedCandleFill(e,rows){
  const index=rows.findIndex(r=>r.t===e.signalAt),entry=rows[index]
  if(!entry)return null
  const entryAt=entry.t+MINUTE,exitAt=Date.parse(`${e.date}T${e.exitTime}:00+05:30`)
  if(exitAt<entryAt)return null
  // Rebuild the exit from the current raw candle file. Older research caches
  // can retain a stale EOD mark after the source history is refreshed.
  const exitBar=rows.find(r=>r.t===exitAt)
  // exitReason exists on the persisted research events. Preserve the helper's
  // explicit exit-price contract for small synthetic callers/tests.
  const exitPrice=e.exitReason?(exitBar?exitBar.o:rows.at(-1)?.c):e.exitPrice
  if(!Number.isFinite(exitPrice))return null
  const d=e.side==='BUY'?1:-1,entryPrice=entry.c
  const future=rows.filter(r=>r.t>=entryAt&&r.t<exitAt)
  const hi=Math.max(entryPrice,exitPrice,...future.map(r=>r.h)),lo=Math.min(entryPrice,exitPrice,...future.map(r=>r.l))
  return {...e,entryAt,entryPrice,exitPrice,fillTime:new Date(entryAt+330*MINUTE).toISOString().slice(11,16),
    returnPct:d*100*(exitPrice-entryPrice)/entryPrice,
    maePct:Math.min(0,d*100*((d>0?lo:hi)-entryPrice)/entryPrice),
    mfePct:Math.max(0,d*100*((d>0?hi:lo)-entryPrice)/entryPrice)}
}

export function interactionFeatures(f){
  const out={...f}
  for(const n of [1,3,5,10,20])if(Number.isFinite(f[`ret${n}`])&&f.atr14>0)out[`returnAtr${n}`]=f[`ret${n}`]/f.atr14
  for(const k of ['vwapGap','priceEma10','priceEma20','breakout10','breakout20'])if(Number.isFinite(f[k])&&f.atr14>0)out[`${k}Atr`]=f[k]/f.atr14
  for(const n of [3,5,10])if(Number.isFinite(f[`slope${n}`])&&Number.isFinite(f[`fit${n}`]))out[`trendQuality${n}`]=f[`slope${n}`]*f[`fit${n}`]
  for(const n of [3,5,10])if(Number.isFinite(f[`nifty_ret${n}`])&&Number.isFinite(f[`ret${n}`]))out[`relative${n}`]=f[`ret${n}`]-f[`nifty_ret${n}`]
  for(const k of ['depthFull','depthTop2','depthOfi','depthDelta','depthMidReturn','depthImbalanceChange']){
    if(Number.isFinite(f[k])&&Number.isFinite(f[`cross_${k}`]))out[`${k}ChangeSinceCross`]=f[k]-f[`cross_${k}`]
  }
  if(Number.isFinite(f.depthFull)&&Number.isFinite(f.depthMidReturn))out.absorptionPressure=f.depthFull*Math.sign(f.depthMidReturn)
  return out
}

export function attachExecutionAndStructure(events,{advancedFlow=false}={}){
  const output=[]
  for(const [symbol,group]of Map.groupBy(events,e=>e.symbol)){
    const sessions=loadCandles(symbol)
    const advanced=advancedFlow?sessionFlowMap(sessions):null
    const priceAction=advancedFlow?new Map([...sessions].map(([date,rows])=>[date,priceActionSeries(rows)])):null
    for(const e of group){
      const rows=sessions.get(e.date)||[],filled=completedCandleFill(e,rows)
      if(!filled)continue
      const at=rows.findIndex(r=>r.t===e.signalAt),d=e.side==='BUY'?1:-1,f=interactionFeatures(e.features)
      if(advanced){Object.assign(f,advanced.get(e.date)?.[at-1]?.[d>0?'long':'short'],priceAction.get(e.date)?.[at-1]?.[d>0?'long':'short']);if(Number.isFinite(f.depthDelta)&&Number.isFinite(f.adv_candleDeltaProxy3))f.adv_depthCandleDeltaAgreement=f.depthDelta>0&&f.adv_candleDeltaProxy3>0?1:0}
      for(const n of [3,5,10,20]){
        if(at<n+1)continue
        const prior=rows.slice(at-n,at),steps=prior.map((r,i)=>r.c-(i?prior[i-1].c:r.o)),travel=steps.reduce((s,x)=>s+Math.abs(x),0)
        f[`efficiency${n}`]=travel?d*(prior.at(-1).c-prior[0].o)/travel:0
        f[`bodyPersistence${n}`]=prior.filter(r=>d*(r.c-r.o)>0).length/n
        f[`closeBreakout${n}`]=d>0?100*(prior.at(-1).c/Math.max(...prior.slice(0,-1).map(r=>r.h))-1):100*(Math.min(...prior.slice(0,-1).map(r=>r.l))/prior.at(-1).c-1)
      }
      output.push({...filled,features:f})
    }
  }
  return output
}

function gini(sum,n){return n?sum*(1-sum/n):0}
export function fitForest(rows,features,{seed=421,trees=48,maxDepth=8,minLeaf=35,featureTrials=16,cutTrials=4,objective='returns',positiveWeight=1}={}){
  const rng=random(seed),matrix=features.map(k=>Float64Array.from(rows,e=>e.features[k]??NaN))
  const label=e=>objective==='cohort'?(e.cohort&&e.returnPct>0?1:0):(e.returnPct>.1?1:0)
  const net=Float64Array.from(rows,label),big=Float64Array.from(rows,e=>objective==='cohort'?label(e):(e.returnPct>.5?1:0)),gross=Float64Array.from(rows,e=>e.returnPct>0?1:0),rets=Float64Array.from(rows,e=>Math.max(-2,Math.min(3,e.returnPct)))
  const weights=Float64Array.from(rows,e=>label(e)?positiveWeight:1)
  const importance=new Map(),forest=[]
  function build(ids,depth){
    let wins=0,large=0,profit=0,ret=0,mass=0
    for(const i of ids){const w=weights[i];mass+=w;wins+=w*net[i];large+=w*big[i];profit+=w*gross[i];ret+=w*rets[i]}
    const leaf={p:(wins+1)/(mass+2),pGross:(profit+1)/(mass+2),pBig:(large+1)/(mass+2),mean:ret/mass,n:ids.length}
    if(depth>=maxDepth||ids.length<minLeaf*2||wins===0||wins===mass)return leaf
    const parent=gini(wins,mass)+.5*gini(large,mass)
    let best=null
    for(let trial=0;trial<featureTrials;trial++){
      const j=Math.floor(rng()*features.length),col=matrix[j]
      for(let c=0;c<cutTrials;c++){
        const cut=col[ids[Math.floor(rng()*ids.length)]];if(!Number.isFinite(cut))continue
        let nl=0,wl=0,bl=0,nr=0,wr=0,br=0,missing=0,wm=0,bm=0,ml=0,mr=0,mm=0
        for(const i of ids){const v=col[i],w=weights[i];if(!Number.isFinite(v)){missing++;mm+=w;wm+=w*net[i];bm+=w*big[i]}else if(v<=cut){nl++;ml+=w;wl+=w*net[i];bl+=w*big[i]}else{nr++;mr+=w;wr+=w*net[i];br+=w*big[i]}}
        for(const missingLeft of [false,true]){
          const l=nl+(missingLeft?missing:0),r=nr+(missingLeft?0:missing)
          if(l<minLeaf||r<minLeaf)continue
          const lm=ml+(missingLeft?mm:0),rm=mr+(missingLeft?0:mm)
          const gain=parent-gini(wl+(missingLeft?wm:0),lm)-gini(wr+(missingLeft?0:wm),rm)-.5*(gini(bl+(missingLeft?bm:0),lm)+gini(br+(missingLeft?0:bm),rm))
          if(gain>0&&(!best||gain>best.gain))best={j,cut,missingLeft,gain}
        }
      }
    }
    if(!best)return leaf
    const left=[],right=[]
    for(const i of ids){const v=matrix[best.j][i];(Number.isFinite(v)?v<=best.cut:best.missingLeft)?left.push(i):right.push(i)}
    const feature=features[best.j];importance.set(feature,(importance.get(feature)||0)+best.gain)
    return {feature,cut:best.cut,missingLeft:best.missingLeft,left:build(left,depth+1),right:build(right,depth+1)}
  }
  for(let t=0;t<trees;t++){
    // Subsample, never bootstrap across calendar partitions.
    const ids=Array.from({length:rows.length},(_,i)=>i).filter(()=>rng()<.8)
    forest.push(build(ids,0))
    if((t+1)%16===0)console.log(`Forest ${t+1}/${trees}, ${rows.length} fitting rows, ${features.length} features`)
  }
  return {features,forest,importance:[...importance].sort((a,b)=>b[1]-a[1]),config:{seed,trees,maxDepth,minLeaf,featureTrials,cutTrials,objective,positiveWeight}}
}

export function predict(model,features){
  let p=0,pGross=0,pBig=0,mean=0
  for(let node of model.forest){
    while(node.feature){const v=features[node.feature];node=(Number.isFinite(v)?v<=node.cut:node.missingLeft)?node.left:node.right}
    p+=node.p;pGross+=node.pGross;pBig+=node.pBig;mean+=node.mean
  }
  const n=model.forest.length
  return {p:p/n,pGross:pGross/n,pBig:pBig/n,mean:mean/n}
}

export function summarize(rows){
  const days=DATES.map(date=>{const r=rows.filter(e=>e.date===date);return {date,trades:r.length,winners:r.filter(e=>e.returnPct>0).length,losses:r.filter(e=>e.returnPct<0).length,netWinners:r.filter(e=>e.returnPct>.1).length,cohort:r.filter(e=>e.cohort&&e.returnPct>0).length,sum:round(r.reduce((s,e)=>s+e.returnPct,0))}})
  const sum=rows.reduce((s,e)=>s+e.returnPct,0),wins=rows.filter(e=>e.returnPct>0).length
  return {trades:rows.length,winners:wins,losses:rows.filter(e=>e.returnPct<0).length,flat:rows.filter(e=>e.returnPct===0).length,
    winRatePct:rows.length?round(100*wins/rows.length):null,averageReturnPct:rows.length?round(sum/rows.length):null,summedReturnPct:round(sum),
    profitableCohort:rows.filter(e=>e.cohort&&e.returnPct>0).length,
    averageMaePct:rows.length?round(rows.reduce((s,e)=>s+e.maePct,0)/rows.length):null,worstMaePct:rows.length?round(rows.reduce((s,e)=>Math.min(s,e.maePct),0)):null,
    worstDay:days.filter(d=>d.trades).sort((a,b)=>a.sum-b.sum)[0]||null,afterHypothetical10bps:{winners:rows.filter(e=>e.returnPct>.1).length,nonPositive:rows.filter(e=>e.returnPct<=.1).length,averageReturnPct:rows.length?round(sum/rows.length-.1):null},days}
}

export function firstSignals(rows,gate){
  const byKey=new Map()
  for(const e of rows){if(!gate(e))continue;const old=byKey.get(e.key);if(!old||e.signalAt<old.signalAt)byKey.set(e.key,e)}
  return [...byKey.values()].sort((a,b)=>a.signalAt-b.signalAt||a.symbol.localeCompare(b.symbol))
}

export function wilson(w,n,z=1.96){if(!n)return 0;const p=w/n;return (p+z*z/(2*n)-z*Math.sqrt((p*(1-p)+z*z/(4*n))/n))/(1+z*z/n)}
