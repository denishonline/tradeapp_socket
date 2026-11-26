import fs from 'node:fs'
import path from 'node:path'
import {pathToFileURL} from 'node:url'
import {prepare,stats,exportCsv} from './search-precision-ema-patterns.js'
import {DATES,round,uniqueFile,save} from './research-ema-coverage.js'
import assert from 'node:assert/strict'

const TREES=64,FEATURES_PER_SPLIT=40,MAX_RULES=10
const EXPANDED=process.argv.includes('--expanded')
function random(seed){let x=seed|0;return ()=>{x^=x<<13;x^=x>>>17;x^=x<<5;return (x>>>0)/4294967296}}
const impurity=(p,n,w)=>p+n?2*(w*p)*n/(w*p+n):0
function simplify(conditions){
  const out=new Map()
  for(const c of conditions){const key=c.feature+'|'+c.op,previous=out.get(key)
    if(!previous||(c.op==='>'?c.value>previous.value:c.value<previous.value))out.set(key,c)
  }
  return [...out.values()]
}
function buildContext(events,delay,{allowBinary=false}={}){
  const stage=events.filter(e=>e.delay===delay),features=[...new Set(stage.flatMap(e=>Object.keys(e.features)))],labels=new Int8Array(stage.length)
  stage.forEach((e,i)=>{labels[i]=e.returnPct<=0?0:e.cohort?1:-1})
  const train=Array.from(labels.keys()).filter(i=>labels[i]>=0),columns=[]
  for(const feature of features){
    const positives=train.filter(i=>labels[i]===1&&Number.isFinite(stage[i].features[feature])).map(i=>stage[i].features[feature]).sort((a,b)=>a-b)
    if(positives.length<4||!allowBinary&&new Set(positives).size<3)continue
    const background=train.filter((i,j)=>j%19===0&&Number.isFinite(stage[i].features[feature])).map(i=>stage[i].features[feature]).sort((a,b)=>a-b)
    if(allowBinary&&new Set([...positives,...background]).size<2)continue
    const coarse=Array.from({length:31},(_,i)=>background[Math.floor((i+1)/32*(background.length-1))]).filter(Number.isFinite)
    const cuts=[...new Set([...positives,...coarse])].sort((a,b)=>a-b)
    const bins=new Uint16Array(stage.length)
    stage.forEach((e,i)=>{const value=e.features[feature];if(!Number.isFinite(value)){bins[i]=65535;return}
      let low=0,high=cuts.length;while(low<high){const mid=(low+high)>>>1;if(cuts[mid]<value)low=mid+1;else high=mid}bins[i]=low
    })
    columns.push({feature,cuts,bins})
  }
  return {stage,labels,train,columns,delay}
}
function grow(ctx,treeIndex,pool,options={}){
  const rng=random((options.seed||37117)+treeIndex*1103+ctx.delay*1777),w=[10,30,100,300][treeIndex%4],depthLimit=options.maxDepth??[8,10,12,14][Math.floor(treeIndex/4)%4]
  const minPos=options.minPos??(treeIndex<48?3:2)
  function node(indices,conditions,depth){
    let p=0,n=0;for(const i of indices){if(ctx.labels[i]===1)p++;else n++}
    if(p<minPos)return
    if(!n){
      const cs=simplify(conditions),positiveKeys=[...new Set(indices.filter(i=>ctx.labels[i]===1).map(i=>ctx.stage[i].key))]
      if(positiveKeys.length<minPos)return
      const signature=positiveKeys.slice().sort().join('|'),previous=pool.get(signature)
      if(!previous||cs.length<previous.conditions.length)pool.set(signature,{delay:ctx.delay,conditions:cs,positiveKeys,depth:cs.length})
      return
    }
    if(depth>=depthLimit)return
    const featureIndices=Array.from(ctx.columns.keys())
    for(let i=featureIndices.length-1;i>0;i--){const j=Math.floor(rng()*(i+1));[featureIndices[i],featureIndices[j]]=[featureIndices[j],featureIndices[i]]}
    let best=null
    for(const ci of featureIndices.slice(0,options.featuresPerSplit??FEATURES_PER_SPLIT)){
      const col=ctx.columns[ci],hp=new Uint32Array(col.cuts.length+1),hn=new Uint32Array(col.cuts.length+1)
      let vp=0,vn=0
      for(const i of indices){const bin=col.bins[i];if(bin===65535)continue;if(ctx.labels[i]===1){hp[bin]++;vp++}else{hn[bin]++;vn++}}
      if(vp<Math.max(minPos,p*.7))continue
      let lp=0,ln=0
      for(let cut=0;cut<col.cuts.length;cut++){
        lp+=hp[cut];ln+=hn[cut];const rp=vp-lp,rn=vn-ln
        if(lp+ln===0||rp+rn===0||lp<minPos&&rp<minPos)continue
        const gain=impurity(vp,vn,w)-impurity(lp,ln,w)-impurity(rp,rn,w)
        if(!best||gain>best.gain)best={ci,cut,gain}
      }
    }
    if(!best||best.gain<=0)return
    const col=ctx.columns[best.ci],left=[],right=[]
    for(const i of indices){const bin=col.bins[i];if(bin===65535)continue;(bin<=best.cut?left:right).push(i)}
    node(left,[...conditions,{feature:col.feature,op:'<=',value:col.cuts[best.cut]}],depth+1)
    node(right,[...conditions,{feature:col.feature,op:'>',value:col.cuts[best.cut]}],depth+1)
  }
  node(ctx.train,[],0)
}
function seedCover(ctx,pool,{minPos=2,maxDepth=14,alphas=[1.5,2,2.5]}={}){
  const positives=ctx.train.filter(i=>ctx.labels[i]===1)
  const rootHist=ctx.columns.map(col=>{
    const hp=new Uint32Array(col.cuts.length+1),hn=new Uint32Array(col.cuts.length+1)
    for(const i of ctx.train){const b=col.bins[i];if(b===65535)continue;if(ctx.labels[i]===1)hp[b]++;else hn[b]++}
    return {hp,hn}
  })
  for(let seedNumber=0;seedNumber<positives.length;seedNumber++){
    const seed=positives[seedNumber]
    for(const alpha of alphas){
      let active=ctx.train,conditions=[]
      for(let depth=0;depth<maxDepth;depth++){
        let p=0,n=0;for(const i of active)if(ctx.labels[i]===1)p++;else n++
        if(p<minPos)break
        if(!n){
          const positiveKeys=[...new Set(active.filter(i=>ctx.labels[i]===1).map(i=>ctx.stage[i].key))],cs=simplify(conditions),signature=positiveKeys.slice().sort().join('|'),previous=pool.get(signature)
          if(positiveKeys.length>=minPos&&(!previous||cs.length<previous.conditions.length))pool.set(signature,{delay:ctx.delay,conditions:cs,positiveKeys,depth:cs.length})
          break
        }
        let best=null
        for(let ci=0;ci<ctx.columns.length;ci++){
          const col=ctx.columns[ci],sb=col.bins[seed];if(sb===65535)continue
          let hp,hn
          if(depth===0){({hp,hn}=rootHist[ci])}
          else{
            hp=new Uint32Array(col.cuts.length+1);hn=new Uint32Array(col.cuts.length+1)
            for(const i of active){const b=col.bins[i];if(b===65535)continue;if(ctx.labels[i]===1)hp[b]++;else hn[b]++}
          }
          const vp=hp.reduce((a,b)=>a+b,0),vn=hn.reduce((a,b)=>a+b,0)
          let lp=0,ln=0
          for(let cut=0;cut<col.cuts.length;cut++){
            lp+=hp[cut];ln+=hn[cut]
            const left=sb<=cut,cp=left?lp:vp-lp,cn=left?ln:vn-ln
            if(cp<minPos||cp===p&&cn===n)continue
            const score=Math.pow(cp,alpha)/(cn+1)
            if(!best||score>best.score||score===best.score&&cp>best.cp)best={ci,cut,left,score,cp}
          }
        }
        if(!best)break
        const col=ctx.columns[best.ci]
        conditions.push({feature:col.feature,op:best.left?'<=':'>',value:col.cuts[best.cut]})
        active=active.filter(i=>col.bins[i]!==65535&&(best.left?col.bins[i]<=best.cut:col.bins[i]>best.cut))
      }
    }
    if((seedNumber+1)%40===0)console.log(`Seed search delay ${ctx.delay}: ${seedNumber+1}/${positives.length}; ${pool.size} pure groups`)
  }
}
function optimizeCover(candidates){
  const keys=[...new Set(candidates.flatMap(r=>r.positiveKeys))],index=new Map(keys.map((k,i)=>[k,i])),words=Math.ceil(keys.length/32)
  const pop=x=>{x-=(x>>>1)&0x55555555;x=(x&0x33333333)+((x>>>2)&0x33333333);return (((x+(x>>>4))&0x0f0f0f0f)*0x01010101)>>>24}
  const masks=candidates.map(r=>{const bits=new Uint32Array(words);for(const key of r.positiveKeys){const i=index.get(key);bits[i>>>5]|=1<<(i&31)}return bits})
  let beam=[{bits:new Uint32Array(words),ids:[],count:0,complexity:0}]
  for(let depth=0;depth<MAX_RULES;depth++){
    const next=[],seen=new Set()
    for(const parent of beam)for(let i=0;i<candidates.length;i++){
      const bits=parent.bits.map((v,j)=>v|masks[i][j]);let count=0;for(const x of bits)count+=pop(x)
      if(count===parent.count)continue
      const signature=Array.from(bits).join(',');if(seen.has(signature))continue;seen.add(signature)
      next.push({bits,ids:[...parent.ids,i],count,complexity:parent.complexity+candidates[i].conditions.length})
    }
    if(!next.length)break
    next.sort((a,b)=>b.count-a.count||a.complexity-b.complexity);beam=next.slice(0,64)
  }
  return beam[0].ids.map(i=>candidates[i])
}
function fit(events,name){
  const pool=new Map()
  for(const delay of [0,3,5]){
    const ctx=buildContext(events,delay)
    for(let tree=0;tree<TREES;tree++){grow(ctx,tree,pool);if((tree+1)%16===0)console.log(`${name}: delay ${delay}, trees ${tree+1}/${TREES}, unique pure groups ${pool.size}`)}
    if(EXPANDED)seedCover(ctx,pool)
  }
  const rules=[],covered=new Set(),candidates=[...pool.values()]
  for(let step=0;step<MAX_RULES;step++){
    let best=null,gain=0
    for(const r of candidates){const incremental=r.positiveKeys.filter(k=>!covered.has(k)).length
      if(incremental>gain||incremental===gain&&incremental>0&&r.conditions.length<best.conditions.length){best=r;gain=incremental}}
    if(!best||gain<2)break
    rules.push({delay:best.delay,conditions:best.conditions,trainingIncrement:gain})
    best.positiveKeys.forEach(k=>covered.add(k))
  }
  if(EXPANDED){const optimized=optimizeCover(candidates);if(new Set(optimized.flatMap(r=>r.positiveKeys)).size>covered.size){rules.splice(0,rules.length,...optimized.map(({delay,conditions})=>({delay,conditions})))}}
  const training=stats(events,rules)
  assert.equal(training.losses,0,'A purported pure tree rule emitted a losing fitting-data trade')
  assert.equal(training.breakeven,0,'A purported pure tree rule emitted a flat fitting-data trade')
  console.log(`${name}: ${rules.length} rules, ${training.profitableCohortCovered} cohort, ${training.trades} trades, zero fitting losses`)
  return {rules,training,candidateGroups:pool.size,largestGroups:candidates.sort((a,b)=>b.positiveKeys.length-a.positiveKeys.length).slice(0,20).map(r=>({cohort:r.positiveKeys.length,conditions:r.conditions.length,delay:r.delay})),...(EXPANDED?{candidateRules:candidates}:{} )}
}
async function main(){
const events=prepare([0,3,5]),earlier=events.filter(e=>DATES.indexOf(e.date)<6),later=events.filter(e=>DATES.indexOf(e.date)>=6)
const frozen=fit(earlier,'Earlier-tree fit'),exploratory=fit(events,'All-date-tree fit')
const report={generatedAt:new Date().toISOString(),protocol:{objective:'At most 10 rules; all selected fitting-data outcomes strictly positive; maximize unique profitable original 159-leg coverage.',
  treesPerTiming:TREES,timings:[0,3,5],depths:[8,10,12,14],minTargetSupport:[3,2],featuresPerSplit:FEATURES_PER_SPLIT,
  method:EXPANDED?'Classification-tree leaves plus target-seeded one-sided covering at three purity/support tradeoffs; simplify bounds; deduplicate target coverage; beam-search the union of at most ten pure rules. Profitable non-cohort trades are neutral/allowed.':'Random feature-subset weighted classification trees; extract pure leaves, simplify repeated bounds, deduplicate target coverage, greedily select at most ten pure groups. Profitable non-cohort trades are neutral/allowed.',
  selection:'Only Oct5-12 labels and thresholds define the earlier-fit rules. Oct13-16 is replayed unchanged. A separate all-date fit describes retrospective coverage. No symbol, date, clock-time or future-outcome inputs.',
  caveats:'Deep rules and all-date purity can overfit. Zero historical fitting losses do not establish zero future losses. The ten dates have all been previously explored; no untouched holdout remains. All returns exclude fees/slippage.',
  timing:'Choose earliest matching entry at original crossover +0/+3/+5 minutes; require unchanged EMA direction during each wait; no stop or target, exit opposite cross or last-session-close mark. Depth is the original-cross context.'},
  frozen:{...frozen,later:stats(later,frozen.rules),all:stats(events,frozen.rules),files:exportCsv(events,frozen.rules,'trees-frozen')},
  exploratory:{...exploratory,files:exportCsv(events,exploratory.rules,'trees-exploratory')}}
const file=uniqueFile(`precision10-${EXPANDED?'expanded':'trees'}-results.json`);save(file,report)
const describe=cs=>cs.map(c=>`\`${c.feature} ${c.op} ${Number(c.value.toPrecision(8))}\``).join(' AND ')
const table=rs=>['| Pattern | Wait | Target legs | Trades | Non-positive | Conditions |','| --- | ---: | ---: | ---: | ---: | --- |',...rs.map(r=>`| ${r.pattern} | ${r.delay} min | ${r.cohortCovered} | ${r.trades} | ${r.losses} | ${describe(r.conditions)} |`)].join('\n')
const markdown=uniqueFile(`precision10-${EXPANDED?'expanded':'trees'}-findings.md`)
const text=[
  '# Ten-rule search with zero fitting losses',
  `Exploratory all-date result: ${exploratory.training.profitableCohortCovered}/159 original target legs, ${exploratory.rules.length} rules, ${exploratory.training.trades} total trades, ${exploratory.training.losses} losing and ${exploratory.training.breakeven} flat trades. Gross average return ${exploratory.training.averageReturnPct}%; total ${exploratory.training.summedReturnPct} summed percentage points; worst adverse excursion ${exploratory.training.worstMaePct}%.`,
  table(exploratory.training.byPattern),
  `Earlier fit: ${frozen.training.profitableCohortCovered}/${frozen.training.cohortAvailable} target legs, zero fitting losses. Unchanged later-date replay: ${report.frozen.later.profitableCohortCovered}/${report.frozen.later.cohortAvailable} profitable target legs, ${report.frozen.later.trades} trades, ${report.frozen.later.losses} losing and ${report.frozen.later.breakeven} flat trades, ${report.frozen.later.winRatePct}% win rate, ${report.frozen.later.averageReturnPct}% gross average return.`,
  table(report.frozen.later.byPattern),
  'All-date purity is a fitted historical result. The chronological replay provides the relevant check for whether those relationships repeat; even it uses dates already examined in previous research. These rules can have up to fourteen split conditions before simplification.',
  'RSI/MFI are centered on 50 and multiplied by entry direction. Returns, gaps, slopes and flow are direction-normalized; volatility and volume ratios are not. Missing numeric features fail conditions. All indicator warmups are enforced and only fully closed higher-timeframe candles are used. Cross-depth features are context at the original cross, not fresh depth at later entries.',
  'Cost sensitivity and complete training/later metrics are included in the JSON report. Non-cohort profitable trades are retained; any fitting-data non-positive trade causes an assertion failure.',
  `Machine report: ${file}.`,
  `Exploratory signals: ${report.exploratory.files.signals}.`,
  `Every original leg and coverage status: ${report.exploratory.files.cohort}.`,
  `Frozen-rule signals: ${report.frozen.files.signals}.`,
].join('\n\n')+'\n'
fs.writeFileSync(markdown,text,{flag:'wx'})
console.log(JSON.stringify({report:file,findings:markdown,exploratory:exploratory.training,frozenTraining:frozen.training,frozenLater:report.frozen.later},null,2))
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href)await main()
export {buildContext,grow,simplify,seedCover}
