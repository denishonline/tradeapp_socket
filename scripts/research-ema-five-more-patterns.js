import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'
import {REPORTS,STEM,DATES,rowKey,uniqueFile,save,round,writeCsv} from './research-ema-coverage.js'
import {prepare} from './search-precision-ema-patterns.js'
import {attachExecutionAndStructure,predict,summarize} from './ema-advanced-filter-core.js'
import {FAMILIES,discover,choose,execute,changes} from './ema-five-pattern-core.js'

const protocol={fitDates:DATES.slice(0,4),calibrationDates:DATES.slice(4,6),replayDates:DATES.slice(6),maxAdditionalPatterns:5,
  baseline:'Previously earlier-selected all-target150 forest, delay5, similarity score>=0.55. It is already lossy; additional patterns do not claim to eliminate its losses.',
  families:FAMILIES,selection:'Bounds learned only Oct5-8; up to two added bounds per family, three significant figures, at least three fitting target views and support on at least two fitting dates. Select at most one rule per family using Oct9/12 only. Preserve all existing profitable target keys on fitting and calibration. Every addition must add >=1 calibration target winner and keep combined calibration gross mean positive. Rank gained target winners/(new non-positive keys+1).',
  strict:'Also require zero new non-positive keys at each fitting/calibration selection step. Do not force five rules if fewer qualify.',
  replay:'Freeze before this replay; no later labels used to select bounds or rules. All dates were previously explored, so results are exploratory, not a pristine holdout.',
  execution:'Signals use completed data before signalAt; next completed one-minute candle CLOSE fill. Evaluate cross+0/3/5m; first qualifying entry owns the original leg, including earlier overrides of baseline. Opposite cross next-open or EOD exit, no stop/target. Non-cohort legs are controls for measuring false signals. Costs are excluded; 10bps sensitivity is hypothetical, not actual charges. Return sums are percentage-point sums, not portfolio returns.'}
const fresh=JSON.parse(fs.readFileSync(path.join(REPORTS,`${STEM}-entry-time-depth.json`),'utf8'))
const base=JSON.parse(fs.readFileSync(path.join(REPORTS,`${STEM}-trend-focused-models-2.json`),'utf8')).models.find(m=>m.name==='all-target150')
assert(base)
let events=prepare([0,3,5])
for(const e of events){const d=fresh.rows[rowKey(e)];if(d?.depthAvailable===1)for(const [k,v]of Object.entries(d))if(Number.isFinite(v))e.features[k]=v;e.features.confirmationDelay=e.delay}
events=attachExecutionAndStructure(events)
const fit=events.filter(e=>protocol.fitDates.includes(e.date)),cal=events.filter(e=>protocol.calibrationDates.includes(e.date)),later=events.filter(e=>protocol.replayDates.includes(e.date))
for(const e of [...fit,...cal])e.baseMatch=e.delay===5&&predict(base,e.features).p>=.55
console.log('Learning five candidate families on fitting dates only')
const proposals=discover(fit),strict=choose(fit,cal,proposals,{strict:true}),extension=choose(fit,cal,proposals)
const lock=uniqueFile('five-more-selection-lock.json');save(lock,{generatedAt:new Date().toISOString(),protocol,proposals,strict,extension})
console.log(`Selection locked; strict=${strict.rules.length} additions, exploratory=${extension.rules.length} additions`)
for(const e of later)e.baseMatch=e.delay===5&&predict(base,e.features).p>=.55
function evaluate(rows,rules,suffix){
  const signals=execute(rows,rules),old=execute(rows,[]),summary=summarize(signals),file=uniqueFile(`five-more-${suffix}-signals.csv`),ledger=uniqueFile(`five-more-${suffix}-cohort.csv`)
  writeCsv(file,signals.map(e=>({date:e.date,symbol:e.symbol,side:e.side,originalEntryTime:e.originalEntryTime||e.entryTime,signalTime:e.entryTime,fillTime:e.fillTime,delayMinutes:e.delay,pattern:e.pattern,cohort:e.cohort,entryPrice:e.entryPrice,exitTime:e.exitTime,exitPrice:e.exitPrice,returnPct:round(e.returnPct),maePct:round(e.maePct)})))
  const emitted=new Map(signals.map(e=>[e.key,e])),baseHits=new Map(old.map(e=>[e.key,e]))
  writeCsv(ledger,[...new Map(rows.filter(e=>e.cohort).map(e=>[e.key,e])).values()].map(e=>{const hit=emitted.get(e.key),prior=baseHits.get(e.key);return {date:e.date,symbol:e.symbol,side:e.side,originalEntryTime:e.originalEntryTime||e.entryTime,status:hit?(hit.returnPct>0?'WIN':'NON_POSITIVE'):'UNCOVERED',pattern:hit?.pattern,signalTime:hit?.entryTime,fillTime:hit?.fillTime,returnPct:hit?round(hit.returnPct):null,baselineStatus:prior?(prior.returnPct>0?'WIN':'NON_POSITIVE'):'UNCOVERED'}}))
  return {summary,changes:changes(old,signals),signals:file,cohort:ledger,byPattern:['BASE',...rules.map(r=>r.name)].map(name=>({name,...summarize(signals.filter(e=>e.pattern===name))}))}
}
const report={generatedAt:new Date().toISOString(),protocol,selectionLock:lock,proposalCount:proposals.length,
  targetCounts:{fit:new Set(fit.filter(e=>e.cohort).map(e=>e.key)).size,calibration:new Set(cal.filter(e=>e.cohort).map(e=>e.key)).size,later:new Set(later.filter(e=>e.cohort).map(e=>e.key)).size},
  baseline:{calibration:summarize(execute(cal,[])),later:summarize(execute(later,[]))},
  strict:{...strict,later:evaluate(later,strict.rules,'strict-later')},extension:{...extension,later:evaluate(later,extension.rules,'extension-later'),all:evaluate(events,extension.rules,'extension-all')}}
assert.equal(report.baseline.later.trades,649);assert.equal(report.baseline.later.profitableCohort,25)
const result=uniqueFile('five-more-results.json'),findings=uniqueFile('five-more-findings.md');save(result,report)
const condition=c=>`${c.feature} ${c.op} ${c.value}`
const lines=['# Five additional pattern families','',protocol.replay,'','## Earlier-selected rules','',
  '| Family | Delay | Conditions |','| --- | ---: | --- |',...extension.rules.map(r=>`| ${r.name} | ${r.delay}m | ${r.conditions.map(condition).join(' AND ')} |`),'',
  `Tested all five families; proposed ${proposals.length} bounded candidates. Strict additions passing fitting/calibration safety: ${strict.rules.length}. Exploratory coverage additions: ${extension.rules.length}. Rules that do not qualify are not forced into the strategy.`,
  '','## Oct13-16 replay','',
  '| Variant | Target winners /67 | Trades | Wins | Losses | Flat | Win rate % | Mean gross % | Sum pp | Worst MAE % | Mean less10bps % |',
  '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
  ...[['Baseline',report.baseline.later],['Strict additions',report.strict.later.summary],['Exploratory additions',report.extension.later.summary]].map(([name,s])=>`| ${name} | ${s.profitableCohort} | ${s.trades} | ${s.winners} | ${s.losses} | ${s.flat} | ${s.winRatePct} | ${s.averageReturnPct} | ${s.summedReturnPct} | ${s.worstMaePct} | ${s.afterHypothetical10bps.averageReturnPct} |`),
  '',`Exploratory changes versus baseline: ${JSON.stringify(report.extension.later.changes)}.`,
  '',`Worst replay day: ${JSON.stringify(report.extension.later.summary.worstDay)}.`,
  '','## All-date descriptive coverage (not independent validation)','',JSON.stringify(report.extension.all.summary,null,2),
  '','## Protocol','```json',JSON.stringify(protocol,null,2),'```','',`Exact results: ${path.basename(result)}.`,
  `Replay signals: ${path.basename(report.extension.later.signals)}. Replay cohort ledger: ${path.basename(report.extension.later.cohort)}. All159 ledger: ${path.basename(report.extension.all.cohort)}.`]
fs.writeFileSync(findings,lines.join('\n')+'\n',{flag:'wx'})
console.log(JSON.stringify({result,findings,proposals:proposals.length,strictRules:strict.rules,extensionRules:extension.rules,baseline:report.baseline.later,strict:report.strict.later.summary,extension:report.extension.later.summary,changes:report.extension.later.changes},null,2))
