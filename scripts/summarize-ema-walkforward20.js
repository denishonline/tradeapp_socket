import fs from 'node:fs'
import path from 'node:path'
import {REPORTS,STEM,uniqueFile} from './research-ema-coverage.js'
import {readCsv} from './verify-ema-advanced-outputs.js'
const read=suffix=>JSON.parse(fs.readFileSync(path.join(REPORTS,`${STEM}-${suffix}`),'utf8'))
const baseline=read('walkforward20-results.json'),advanced=read('walkforward20-orderflow-results.json'),output=uniqueFile('walkforward20-advanced-summary.md'),patternsFile=uniqueFile('walkforward20-advanced-patterns.md')
const counts=advanced.featureInventory||[],primary=advanced.outputs.find(o=>o.name==='strict')
const lines=['# Twenty-pattern chronological research with advanced price action','',
  primary.zeroLossAtLeast50?'The primary achieved >=50 original target winners with zero non-positive gross outcomes on this exploratory replay only. This is not untouched validation.':'The requested >=50 original target winners with zero losses was NOT achieved. The additional indicators do not justify an all-winner claim.','',
  '## Recorded replay outcomes','',
  '| Inputs / policy | Distinct lifetime rules | Target winners /159 | Trades | Wins | Losses | Flat | Win rate % | Mean gross % | Sum pp | Worst MAE % | Mean less10bps % |',
  '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
  ...[['Original',baseline],['Advanced',advanced]].flatMap(([name,r])=>r.outputs.map(o=>{const s=o.summary;return `| ${name} / ${o.name} | ${o.library.length} | ${s.profitableCohort} | ${s.trades} | ${s.winners} | ${s.losses} | ${s.flat} | ${s.winRatePct??'N/A'} | ${s.averageReturnPct??'N/A'} | ${s.summedReturnPct} | ${s.worstMaePct??'N/A'} | ${s.afterHypothetical10bps.averageReturnPct??'N/A'} |`})),'',
  'Neither policy deletes losing trades when a rule is deactivated. All emitted non-cohort signals remain in the counts. Total winners are not the same as retained members of the original159. No rule, threshold or policy is selected using its current-day outcome. Both variants are reported; the higher historical result is not promoted as a validated strategy.','',
  '## New inputs and limitations','',
  `The advanced run exposes ${counts.length} numerical features, including ${counts.filter(k=>k.startsWith('adv_')).length} session-flow features and ${counts.filter(k=>k.startsWith('pa_')).length} price-action features.`,'',
  '- Session VWAP: slope, hold/retest, distance and weighted deviation.',
  '- Session volume profile APPROXIMATION: fixed open-anchored0.05% bins, candle volume spread uniformly across low/high, prefix POC/70% value area, break/retest and local-volume ratios. It is not genuine traded volume-at-price.',
  '- CVD PROXIES: signed candle volume, close-location weighted volume, price/flow agreement. Existing depth delta is also an estimate, not exchange aggressor delta.',
  '- Same-clock RVOL over1/3/5m and cumulative-to-time: requires at least2 completed prior sessions from the allowed10; no future/current-day totals.',
  '- BOS/CHoCH using confirmed2-left/2-right pivots; swing sweeps and structure retests.',
  '- Rule-defined opposing-candle zones confirmed after displacement;3-candle FVG zones become usable after formation. These labels do not prove institutional orders.',
  '- ORB over5/15/30m is available only after opening-range completion.',
  '- Genuine footprint/stacked executed-trade imbalance and OI are unavailable in the stored cash-depth schema. None is fabricated.','',
  '## Features actually used in admitted advanced rules','',
  ...advanced.outputs.flatMap(o=>{const used=[...new Set(o.library.flatMap(r=>r.conditions.map(c=>c.feature)).filter(k=>/^(adv_|pa_)/.test(k)))].sort();return [`${o.name}: ${used.length} distinct new features: ${used.map(k=>'`'+k+'`').join(', ')||'none qualified'}.`,'']}),
  '## Chronology and budgets','',
  'Maximum20 distinct lifetime rules per policy, maximum3 admissions per session. Failed slots are not recycled. Strict fitting uses prior sessions excluding the last; that last prior session is validation, requiring >=2 positive matches including a target leg. Training-only is the more overfit-prone comparison. Before each new session, a rule with any prior non-positive match is disabled; its past losses remain recorded.',
  ...advanced.outputs.map(o=>`${o.name}: ${o.days.filter(d=>d.warmup).length} warmup sessions; ${o.days.filter(d=>d.warmup).reduce((s,d)=>s+d.availableTargets,0)} original target legs in warmup remain missed. Worst replay day: ${JSON.stringify(o.summary.worstDay)}.`),'',
  'Both policies use one-minute decisions at the original cross and+3/+5 completed minutes; earliest match enters at the next completed candle close. Exit is opposite-cross next-open or EOD mark, no SL/TP. Gross returns exclude actual fees/slippage;0.10% is hypothetical cost sensitivity. Return sums are percentage points, not portfolio performance.',
  '', 'All ten dates have repeatedly been studied. Even the new chronology-correct replay is exploratory, not an independent holdout. There is no guarantee of zero future losses.',
  '', 'Detailed daily ledgers, rule lifetimes and thresholds:','',
  `- ${STEM}-walkforward20-orderflow-results.json`,
  `- ${STEM}-walkforward20-orderflow-findings.md`,
  `- Human-readable admitted rules and per-rule outcomes: ${path.basename(patternsFile)}`,
  ...advanced.outputs.map(o=>`- Full159 cohort (${o.name}): ${path.basename(o.cohort)}`)
]
fs.writeFileSync(output,lines.join('\n')+'\n',{flag:'wx'});console.log(output)
const ruleLines=['# Admitted chronological rule patterns','',
  'These are conjunctions learned from earlier completed sessions, not guaranteed market behaviours. Every rule consumes a lifetime slot. A losing rule may be disabled on later days; its losses remain shown here. Exact model values and selection support are retained in the JSON result.','']
for(const o of advanced.outputs){
  const signals=readCsv(o.signals)
  ruleLines.push(`## ${o.name}`,'','| ID | Admitted before | Delay | Conditions (all must pass) | Trades | Target winners | Wins | Losses | Flat |','| ---: | --- | ---: | --- | ---: | ---: | ---: | ---: | ---: |')
  for(const r of o.library){
    const hits=signals.filter(e=>+e.ruleId===r.id),ret=e=>(e.side==='BUY'?1:-1)*(+e.exitPrice-e.entryPrice)
    ruleLines.push(`| ${r.id} | ${r.admittedBefore} | ${r.delay}m | ${r.conditions.map(c=>'`'+c.feature+' '+c.op+' '+c.value+'`').join(' AND ')} | ${hits.length} | ${hits.filter(e=>e.cohort==='true'&&ret(e)>0).length} | ${hits.filter(e=>ret(e)>0).length} | ${hits.filter(e=>ret(e)<0).length} | ${hits.filter(e=>ret(e)===0).length} |`)
  }
  if(!o.library.length)ruleLines.push('','No rules passed admission criteria.')
  ruleLines.push('')
}
fs.writeFileSync(patternsFile,ruleLines.join('\n')+'\n',{flag:'wx'});console.log(patternsFile)
