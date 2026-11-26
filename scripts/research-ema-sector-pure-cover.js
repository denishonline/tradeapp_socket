import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'
import {REPORTS,STEM,DATES,rowKey,uniqueFile,save,round,writeCsv,loadCandles,MINUTE} from './research-ema-coverage.js'
import {prepare,matching,selected} from './search-precision-ema-patterns.js'
import {attachExecutionAndStructure,summarize} from './ema-advanced-filter-core.js'
import {buildContext,grow,seedCover} from './search-pure-tree-ema-patterns.js'
import {attachSectorContext,pureCover} from './ema-sector-pattern-core.js'
import {readCsv} from './verify-ema-advanced-outputs.js'

const sectorAligned=process.argv.includes('--sector-aligned')
const variant=sectorAligned?'sector-aligned-pure60':'sector-pure60'
const protocol={dates:DATES,fitDates:DATES.slice(0,6),replayDates:DATES.slice(6),
  maxRules:60,minDistinctTargetLegsPerRule:4,treesPerTiming:128,timings:[0,3,5],maxDepth:12,featuresPerSplit:48,seed:181026,
  objective:'Maximize distinct profitable original159 legs, each standalone rule supported by >=4 distinct target legs and zero non-positive trades in the entire fitting candidate universe. Overlap counts once in the union; a pattern can add fewer than4 NEW legs.',
  search:'Weighted randomized feature-subset classification trees plus target-seeded greedy covering; pure leaves, repeated-bound simplification, coverage deduplication, greedy set cover. More than30 rules allowed, no redundant padding. Bounded heuristic, not proof of global maximum.',
  chronology:'Fit Oct5-12, save exact rules, replay Oct13-16 unchanged. Separately fit all ten dates for retrospective coverage. The all-date result is NOT a prior-trained chronological strategy even though its features and fills are causal.',
  execution:'Decision at crossover +0/+3/+5m while EMA direction persists; fill NEXT one-minute candle CLOSE. Exit opposite-cross next-open or EOD mark. No stop/target. Earliest matching view per leg; first rule breaks ties. All non-target emitted trades retained.',
  data:sectorAligned
    ? 'Existing205-stock historical candidate universe; not the recently expanded215 list. Target focus remains original159. Stock1/3/5/10/15m, NIFTY, fresh-quality depth, VWAP, candle-based profile/CVD proxies, RVOL, BOS/CHoCH, sweeps, FVG, ORB, plus only the stock’s mapped own-sector proxy (`sector_*`). All direct named-index and cross-sector breadth features are excluded. No true aggressor delta, footprint or OI fabricated.'
    : 'Existing205-stock historical candidate universe; not the recently expanded215 list. Target focus remains original159. Stock1/3/5/10/15m, NIFTY, fresh-quality depth, VWAP, candle-based profile/CVD proxies, RVOL, BOS/CHoCH, sweeps, FVG, ORB, plus sector-index price context. No true aggressor delta, footprint or OI fabricated.',
  support:'Minimum4 is standalone distinct target legs, not four duplicate entry timings. Pattern attribution after overlapping signals is reported separately. No symbol/date/time identity features.',
  costs:'Primary purity is GROSS return>0, not net. Also show10bps round-trip sensitivity. Sums are percentage points, not portfolio returns; simultaneous trades/capital constraints not simulated.',
  caveats:'All dates repeatedly researched; no untouched holdout. Deep data-mined rules can memorize winners. Minimum4 observations does not establish reliability. No guarantee of future zero losses.'}
const protocolFile=uniqueFile(`${variant}-protocol-lock.json`);save(protocolFile,{generatedAt:new Date().toISOString(),protocol})
let events=prepare(protocol.timings)
const fresh=JSON.parse(fs.readFileSync(path.join(REPORTS,`${STEM}-entry-time-depth.json`),'utf8'))
let freshViews=0
for(const e of events){
  // Never silently substitute original-cross depth for unavailable entry depth.
  for(const k of Object.keys(e.features))if(k.startsWith('depth'))delete e.features[k]
  const dep=fresh.rows[rowKey(e)]
  if(dep?.depthAvailable===1){freshViews++;for(const [k,v] of Object.entries(dep))if(Number.isFinite(v)&&!['depthAvailable','depthLastAgeSec'].includes(k))e.features[k]=v}
}
events=attachExecutionAndStructure(events,{advancedFlow:true})
const sector=attachSectorContext(events,JSON.parse(fs.readFileSync('db/sector_indices','utf8')),JSON.parse(fs.readFileSync('db/stocks_sector_wise','utf8')))
let removedCrossSectorFeatures=0
if(sectorAligned){
  for(const e of events)for(const key of Object.keys(e.features)){
    if(key.startsWith('index_')||key.startsWith('sectorBreadth')||key.startsWith('sectorMean')){
      delete e.features[key];removedCrossSectorFeatures++
    }
  }
}
const inventory=[...new Set(events.flatMap(e=>Object.keys(e.features)))].sort()
assert(!inventory.some(k=>/^(symbol|date|clock|signalAt|returnPct|maePct|mfePct|cohort|exit)/i.test(k)))
if(sectorAligned)assert(!inventory.some(k=>k.startsWith('index_')||k.startsWith('sectorBreadth')||k.startsWith('sectorMean')),'Cross-sector feature leaked into aligned search')
const cohort=[...new Map(events.filter(e=>e.cohort).map(e=>[e.key,e])).values()]
assert.equal(cohort.length,159)
const original=readCsv(path.join(REPORTS,'2026-10-05-to-2026-10-16-ema10-ema20-over-1p5-trend-legs.csv'))
const cohortThreshold={originalLegs:original.length,selectionThresholdPct:1.5,legacyCsvOver2:original.filter(e=>+e.returnPct>2).length,
  correctedCashOver2:original.filter(e=>(e.side==='BUY'?1:-1)*100*(+e.exitPrice-e.entryPrice)/e.entryPrice>2).length}
console.log(JSON.stringify({variant,sectorAligned,views:events.length,features:inventory.length,removedCrossSectorFeatures,stocks:new Set(events.map(e=>e.symbol)).size,freshViews,mappedTargets:sector.mappedTargets,sectorIndices:sector.availableIndices,cohortThreshold}))

function fit(rows,name){
  const pool=new Map()
  for(const delay of protocol.timings){
    const ctx=buildContext(rows,delay,{allowBinary:true})
    for(let tree=0;tree<protocol.treesPerTiming;tree++){
      grow(ctx,tree,pool,{minPos:4,maxDepth:protocol.maxDepth,featuresPerSplit:protocol.featuresPerSplit,seed:protocol.seed})
      if((tree+1)%32===0)console.log(`${name} delay${delay}: trees${tree+1}, pureGroups${pool.size}`)
    }
    seedCover(ctx,pool,{minPos:4,maxDepth:protocol.maxDepth})
  }
  const result=pureCover(rows,[...pool.values()],{maxRules:protocol.maxRules,minSupport:4})
  const summary=summarize(selected(rows,result.rules))
  console.log(JSON.stringify({stage:name,rules:result.rules.length,candidates:result.candidateGroups,summary}))
  return {...result,summary}
}

// Independent checks of raw fills, cash return denominator, excursion, and exit.
function auditSignals(signals,rules){
  assert.equal(new Set(signals.map(e=>e.key)).size,signals.length)
  for(const [symbol,group] of Map.groupBy(signals,e=>e.symbol)){
    const sessions=loadCandles(symbol)
    for(const e of group){
      assert(matching(e,rules[e.pattern]))
      const rows=sessions.get(e.date),bar=rows.find(r=>r.t===e.signalAt)
      assert.equal(e.entryPrice,bar.c);assert.equal(e.entryAt,e.signalAt+MINUTE)
      const exitAt=Date.parse(`${e.date}T${e.exitTime}:00+05:30`),exitBar=rows.find(r=>r.t===exitAt)
      assert(exitAt>=e.entryAt)
      assert.equal(e.exitPrice,exitBar?exitBar.o:rows.at(-1).c)
      const direction=e.side==='BUY'?1:-1
      assert(Math.abs(e.returnPct-direction*100*(e.exitPrice-e.entryPrice)/e.entryPrice)<1e-10)
      const exposed=rows.filter(r=>r.t>=e.entryAt&&r.t<exitAt)
      const adverse=direction>0?Math.min(e.entryPrice,e.exitPrice,...exposed.map(r=>r.l)):Math.max(e.entryPrice,e.exitPrice,...exposed.map(r=>r.h))
      assert(Math.abs(e.maePct-Math.min(0,direction*100*(adverse-e.entryPrice)/e.entryPrice))<1e-10)
      if(e.sectorDataThrough)assert(e.sectorDataThrough<=e.signalAt)
    }
  }
}

function output(rows,rules,label){
  const signals=selected(rows,rules),summary=summarize(signals),byKey=new Map(signals.map(e=>[e.key,e]))
  auditSignals(signals,rules)
  const signalsFile=uniqueFile(`${variant}-${label}-signals.csv`),ledgerFile=uniqueFile(`${variant}-${label}-cohort.csv`)
  writeCsv(signalsFile,signals.map(e=>({date:e.date,symbol:e.symbol,side:e.side,originalEntryTime:e.originalEntryTime||e.entryTime,signalTime:e.entryTime,fillTime:e.fillTime,
    ruleId:rules[e.pattern].id,delay:e.delay,cohort:e.cohort,sectorProxy:e.sectorProxy,entryPrice:e.entryPrice,exitTime:e.exitTime,exitPrice:e.exitPrice,returnPct:round(e.returnPct),maePct:round(e.maePct)})))
  const activeDates=new Set(rows.map(e=>e.date))
  writeCsv(ledgerFile,cohort.map(e=>{const hit=byKey.get(e.key);return {date:e.date,symbol:e.symbol,side:e.side,originalEntryTime:e.originalEntryTime||e.entryTime,
    status:hit?(hit.returnPct>0?'WIN':'NON_POSITIVE'):(activeDates.has(e.date)?'UNCOVERED':'OUTSIDE_REPLAY'),ruleId:hit?rules[hit.pattern].id:null,
    signalTime:hit?.entryTime,fillTime:hit?.fillTime,returnPct:hit?round(hit.returnPct):null}}))
  return {summary,signalsFile,ledgerFile,availableTargets:new Set(rows.filter(e=>e.cohort).map(e=>e.key)).size,
    attribution:rules.map((r,i)=>({id:r.id,...summarize(signals.filter(e=>e.pattern===i))}))}
}

const earlier=events.filter(e=>protocol.fitDates.includes(e.date)),later=events.filter(e=>protocol.replayDates.includes(e.date))
const frozen=fit(earlier,'EARLIER ONLY')
const frozenLock=uniqueFile(`${variant}-frozen-rules-lock.json`)
save(frozenLock,{generatedAt:new Date().toISOString(),fitDates:protocol.fitDates,rules:frozen.rules})
const replay=output(later,frozen.rules,'frozen-later')
console.log(JSON.stringify({stage:'UNCHANGED LATER REPLAY',summary:replay.summary}))
const retrospective=fit(events,'ALL DATE RETROSPECTIVE')
const fitted=output(events,retrospective.rules,'retrospective')
const training=output(earlier,frozen.rules,'frozen-training')
const usedFeatures=[...new Set(retrospective.rules.flatMap(r=>r.conditions.map(c=>c.feature)))].sort()
const resultFile=uniqueFile(`${variant}-results.json`),findingsFile=uniqueFile(`${variant}-findings.md`)
save(resultFile,{generatedAt:new Date().toISOString(),protocol,protocolFile,frozenLock,cohortThreshold,sector,featureInventory:inventory,usedFeatures,
  universe:{stocks:new Set(events.map(e=>e.symbol)).size,views:events.length,legs:new Set(events.map(e=>e.key)).size,freshViews,sectorAligned,removedCrossSectorFeatures},
  frozen:{...frozen,training,replay},retrospective:{...retrospective,output:fitted},verification:'Every selected raw candle close, exit price, cash return, MAE and rule match independently checked; unique legs and >=4 standalone support enforced.'})
const row=(name,r,s)=>`| ${name} | ${r} | ${s.profitableCohort} | ${s.trades} | ${s.winners} | ${s.losses} | ${s.flat} | ${s.winRatePct} | ${s.averageReturnPct} | ${s.summedReturnPct} | ${s.worstMaePct} |`
const describe=r=>r.conditions.map(c=>`\`${c.feature} ${c.op} ${c.value}\``).join(' AND ')
const lines=[sectorAligned?'# Sector-aligned pure-pattern search':'# Sector-aware pure-pattern search','',
  `Original cohort:159 legs selected above1.5%, not2%. Corrected cash returns exceed2% for ${cohortThreshold.correctedCashOver2} original legs. Entry changes can change realized returns.`,
  '',`Retrospective fitted coverage: **${fitted.summary.profitableCohort}/159** with **${retrospective.rules.length} patterns**, each matching >=4 distinct target legs on its own. ${fitted.summary.losses} losses and ${fitted.summary.flat} flats among ALL emitted fitting-universe trades. This is a historical fit, NOT validated zero-loss trading.`,
  '', '| Evaluation | Rules | Target wins | Trades | Wins | Losses | Flat | Win rate % | Mean gross % | Sum pp | Worst MAE % |',
  '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
  row('All10 dates FITTED',retrospective.rules.length,fitted.summary),row('Oct5-12 FITTED',frozen.rules.length,training.summary),row('Oct13-16 unchanged REPLAY',frozen.rules.length,replay.summary),
  '',`Later replay target denominator: ${replay.availableTargets}; all ten dates have been explored previously, so even this replay is not an untouched holdout.`,
  '',`10bps sensitivity: fitted non-positive trades ${fitted.summary.afterHypothetical10bps.nonPositive}, mean ${fitted.summary.afterHypothetical10bps.averageReturnPct}%; later replay non-positive ${replay.summary.afterHypothetical10bps.nonPositive}, mean ${replay.summary.afterHypothetical10bps.averageReturnPct}%.`,
  '',`Worst fitted day: ${JSON.stringify(fitted.summary.worstDay)}. Worst replay day: ${JSON.stringify(replay.summary.worstDay)}. Sums are percentage points, not portfolio returns.`,
  '',sectorAligned
    ? `Inputs: ${inventory.length} features; ${removedCrossSectorFeatures} direct named-index/cross-sector features excluded before fitting. A \`sector_*\` feature, when selected, is the stock’s own mapped sector proxy only. Stock-sector proxies available for ${sector.mappedTargets}/159 targets. Unsupported stocks can still be evaluated by stock, depth and NIFTY conditions but cannot satisfy a rule requiring \`sector_*\`. ${sector.mappingNote}`
    : `Inputs: ${inventory.length} features; ${sector.availableIndices.length}/14 sector indices available. Stock-sector proxies available for ${sector.mappedTargets}/159 targets. Unsupported stocks still have NIFTY and available broad-sector context. ${sector.mappingNote}`,
  '',`Unavailable indices: ${sector.coverage.filter(x=>Object.values(x.counts).every(v=>!v)).map(x=>x.index).join(', ')}. No missing index history was invented.`,
  '',`Universe: ${new Set(events.map(e=>e.symbol)).size} stocks, ${new Set(events.map(e=>e.key)).size} candidate legs. This does not certify zero losses for the newly expanded215-stock universe or arbitrary non-EMA entry times.`,
  '', '## Exact retrospective rules','',
  'Features are direction-normalized where appropriate. Missing features fail conditions. Delay is minutes after the initial EMA-cross decision; fill is the next candle close. Standalone support overlaps; assigned targets below count each executed leg once. Different threshold conjunctions are distinct rules, not proof of independent economic patterns.',
  '', '| Rule | Delay | Standalone target legs | Standalone trades | Target increment at selection | Assigned target wins | Conditions |',
  '| --- | ---: | ---: | ---: | ---: | ---: | --- |',
  ...retrospective.rules.map((r,i)=>`| ${r.id} | ${r.delay} | ${r.standaloneTargetSupport} | ${r.standaloneTrades} | ${r.incrementalTargets} | ${fitted.attribution[i].profitableCohort} | ${describe(r)} |`),
  '', '## Daily retrospective results','', '| Date | Trades | Wins | Losses | Flat | Target wins | Sum pp |','| --- | ---: | ---: | ---: | ---: | ---: | ---: |',
  ...fitted.summary.days.map(d=>`| ${d.date} | ${d.trades} | ${d.winners} | ${d.losses} | ${d.trades-d.winners-d.losses} | ${d.cohort} | ${d.sum} |`),
  '',`Pattern support of four observations is weak evidence; many optimized splits can memorize these dates. ${protocol.caveats}`,
  '',`All exact thresholds, sector mappings/coverage, per-pattern attribution, protocol and metrics: ${path.basename(resultFile)}.`,
  '',`All emitted fitted signals: ${path.basename(fitted.signalsFile)}. All159 coverage statuses: ${path.basename(fitted.ledgerFile)}.`,
  '',`Unchanged later signals: ${path.basename(replay.signalsFile)}. Frozen earlier-only rules: ${path.basename(frozenLock)}.`]
fs.writeFileSync(findingsFile,lines.join('\n')+'\n',{flag:'wx'})
console.log(JSON.stringify({resultFile,findingsFile,retrospective:fitted.summary,replay:replay.summary,rules:retrospective.rules.length,usedFeatures},null,2))
