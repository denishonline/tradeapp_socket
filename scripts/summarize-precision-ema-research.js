import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'
import {REPORTS,STEM,uniqueFile,writeCsv} from './research-ema-coverage.js'

const names=fs.readdirSync(REPORTS).filter(n=>n.startsWith(STEM)&&/precision10-(trees|expanded)-results(?:-\d+)?\.json$/.test(n))
const reports=names.map(name=>({name,report:JSON.parse(fs.readFileSync(path.join(REPORTS,name),'utf8'))}))
assert(reports.length,'No precision-search results exist')
const best=reports.slice().sort((a,b)=>b.report.exploratory.training.profitableCohortCovered-a.report.exploratory.training.profitableCohortCovered||b.report.generatedAt.localeCompare(a.report.generatedAt))[0]
const expanded=reports.filter(r=>r.name.includes('-expanded-')).sort((a,b)=>a.report.generatedAt.localeCompare(b.report.generatedAt)).at(-1)
const selected=expanded||best,fit=best.report.exploratory.training,forward=selected.report.frozen.later
function csvRead(file){const [head,...lines]=fs.readFileSync(file,'utf8').trim().split(/\r?\n/),keys=head.split(',');return lines.map(l=>Object.fromEntries(l.split(',').map((v,i)=>[keys[i],v])))}
const signalRows=csvRead(best.report.exploratory.files.signals),cohort=csvRead(best.report.exploratory.files.cohort)
assert.equal(cohort.length,159)
assert.equal(signalRows.length,fit.trades)
assert.equal(signalRows.filter(r=>+r.returnPct<0).length,0)
assert.equal(cohort.filter(r=>r.pattern!=='UNCOVERED').length,fit.profitableCohortCovered)
const finalLedger=uniqueFile('precision10-final-cohort.csv');writeCsv(finalLedger,cohort)
const lines=[
  '# Precision-first entry-pattern results',
  `Requested goal: 125-159 profitable original trend legs with at most 10 patterns and zero losing signals. Best historical fitted result: ${fit.profitableCohortCovered}/159 profitable target legs, ${best.report.exploratory.rules.length} patterns, ${fit.trades} total trades, ${fit.losses} losses and ${fit.breakeven} flat outcomes before costs. ${fit.profitableCohortCovered>=125?'The historical coverage/count constraint was met; independent predictive performance remains a separate requirement.':'The requested 125-leg minimum was not reached.'}`,
  '## Results on all ten fitting dates',
  '| Search | Patterns | Target legs | Trades | Losses | Average gross return |',
  '| --- | ---: | ---: | ---: | ---: | ---: |',
  ...reports.map(({name,report:r})=>{const s=r.exploratory.training;return `| ${name.includes('expanded')?'Trees + seeded covering + combination search':'Tree leaf rules'} | ${r.exploratory.rules.length} | ${s.profitableCohortCovered}/159 | ${s.trades} | ${s.losses} | ${s.averageReturnPct}% |`}),
  '',
  `Best fitted metrics: win rate ${fit.winRatePct}%; average return ${fit.averageReturnPct}%; summed trade returns ${fit.summedReturnPct} percentage points; average maximum adverse move ${fit.averageMaePct}%; worst maximum adverse move ${fit.worstMaePct}%; worst day ${fit.worstDay?.date||'none'} (${fit.worstDay?.summedReturnPct||0} summed percentage points).`,
  `At a hypothetical 0.10% round-trip cost, ${fit.afterHypothetical10bps.nonPositive} fitted trades become non-positive and average return is ${fit.afterHypothetical10bps.averageReturnPct}%. This is a cost sensitivity, not an estimate of actual broker/exchange costs.`,
  '## Chronological check',
  `Using the ${selected.name.includes('expanded')?'expanded':'tree'} method, rules fitted only on Oct 5-12 covered ${selected.report.frozen.training.profitableCohortCovered}/${selected.report.frozen.training.cohortAvailable} training target legs with zero fitting losses. Applied unchanged to Oct 13-16, they produced ${forward.trades} trades: ${forward.winners} winners, ${forward.losses} losers, and ${forward.breakeven} flat trades. Profitable original targets captured: ${forward.profitableCohortCovered}/${forward.cohortAvailable}. Win rate: ${forward.winRatePct}%; average gross return: ${forward.averageReturnPct}%.`,
  'Zero-loss fitting describes what the rules retained from data used to build them. It does not describe their later-date performance. The later dates were already examined in previous research, so this is not an untouched holdout.',
  '## Pattern support and complexity',
  '| Pattern | Entry delay | Target legs retained | Trades | Conditions | Dates matched |',
  '| --- | ---: | ---: | ---: | ---: | ---: |',
  ...fit.byPattern.map(r=>`| ${r.pattern} | ${r.delay} min | ${r.cohortCovered} | ${r.trades} | ${r.conditions.length} | ${new Set(signalRows.filter(e=>+e.pattern===r.pattern).map(e=>e.date)).size} |`),
  '',
  'These are conjunctions of indicator bounds and may be quite complex; deep conjunctions can memorize historical cases. They should not be described as ten validated recurring market behaviours solely because their fitting trades were positive.',
  '## Execution and data',
  'The search checks the original crossover, then three and five completed minutes later. The EMA regime must stay intact during each wait. The earliest matching entry wins; one trade per original leg. Exit remains the opposite EMA crossover or last-session-close mark, without stop-loss or profit target.',
  'Cohort coverage refers to the original 159 selected legs. A later entry can earn less than the original 1.5% move; retaining a target leg is not a claim that the selected trade itself returns more than 1.5%.',
  'Features include RSI, MFI, three MACD settings, session VWAP, momentum, volume, ATR, support/resistance, regression trend/angle, completed 3/5/10/15-minute bars, NIFTY context, market breadth and original-cross depth imbalance/OFI/delta proxies. Indicators require their actual full lookback; missing values fail predicates. No future outcomes, stock identity, date or clock-time predicates are used for signals.',
  'All non-positive trades are negatives. Profitable non-cohort trades are allowed winners. Previous searches instead penalized all non-cohort trades and focused primarily on coverage; those objectives did not meet the user\'s requirement.',
  'Fitting zero-loss assertions passed, and chronological execution, strict tree-boundary, missing-feature and indicator-causality tests passed. Gross returns exclude costs and leverage; summed percentage returns are not portfolio returns.',
  '## Files',
  `Every original leg and fitted coverage: [${path.basename(finalLedger)}](${path.basename(finalLedger)}).`,
  `Exact rules and all metrics: [${best.name}](${best.name}).`,
  `All best-fitted signals: [${path.basename(best.report.exploratory.files.signals)}](${path.basename(best.report.exploratory.files.signals)}).`,
  `Chronological replay signals: [${path.basename(selected.report.frozen.files.signals)}](${path.basename(selected.report.frozen.files.signals)}).`,
]
const formatted=[]
for(const line of lines){if(line.startsWith('|'))formatted.push(line);else{if(formatted.length&&formatted.at(-1)!=='')formatted.push('');formatted.push(line);if(line)formatted.push('')}}
const findings=uniqueFile('precision10-final-findings.md');fs.writeFileSync(findings,formatted.join('\n')+'\n',{flag:'wx'})
console.log(JSON.stringify({findings,ledger:finalLedger,bestReport:best.name,bestFitted:{targetLegs:fit.profitableCohortCovered,patterns:best.report.exploratory.rules.length,trades:fit.trades,losses:fit.losses,averageReturnPct:fit.averageReturnPct},chronologicalLater:{targetLegs:forward.profitableCohortCovered,trades:forward.trades,winners:forward.winners,losses:forward.losses,winRatePct:forward.winRatePct,averageReturnPct:forward.averageReturnPct}},null,2))
