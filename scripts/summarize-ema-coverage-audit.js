import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'
import {REPORTS,STEM,uniqueFile,writeCsv} from './research-ema-coverage.js'

const records=fs.readdirSync(REPORTS).filter(name=>name.startsWith(STEM)&&/results(?:-\d+)?\.json(?:-\d+)?$/.test(name)).map(name=>{
  try {const report=JSON.parse(fs.readFileSync(path.join(REPORTS,name),'utf8'));return report.warmup?{name,report}:null}catch{return null}
}).filter(Boolean).sort((a,b)=>a.report.generatedAt.localeCompare(b.report.generatedAt))
const exact=records.filter(x=>!x.name.includes('delay3')).at(-1),delay=records.filter(x=>x.name.includes('delay3')).at(-1)
assert(exact&&delay,'Both corrected reports must be complete')
const profiles=[{label:'At crossover',...exact},{label:'After three minutes',...delay}]
function readCsv(file){const [header,...lines]=fs.readFileSync(file,'utf8').trim().split(/\r?\n/),fields=header.split(',');return lines.map(l=>Object.fromEntries(l.split(',').map((v,i)=>[fields[i],v])))}
const original=readCsv(path.join(REPORTS,'2026-10-05-to-2026-10-16-ema10-ema20-over-1p5-trend-legs.csv'))
const key=r=>`${r.date}|${r.symbol}|${r.side}|${r.entryTime}`
const ledger=new Map(original.map(r=>[key(r),{date:r.date,symbol:r.symbol,side:r.side,originalEntryTime:r.entryTime}]))
for(const [index,p]of profiles.entries()){
  for(const [kind,fit]of [['Exploratory',p.report.exploratory140Fit],['Frozen',p.report.frozenEarlierFit]]){
  const rows=readCsv(fit.files.cohortLedger),prefix=(index?'delay3':'exact')+kind
  const evaluation=kind==='Frozen'?fit.evaluation.all:fit.evaluation
  assert.equal(rows.length,159)
  assert.equal(rows.filter(r=>r.pattern!=='UNCOVERED').length,evaluation.cohortCovered)
  assert.equal(evaluation.perRule.reduce((sum,r)=>sum+r.cohortCovered,0),evaluation.cohortCovered)
  for(const r of rows){
    const entryTime=index?new Date(Date.parse(`${r.date}T${r.entryTime}:00+05:30`)-3*60000+330*60000).toISOString().slice(11,16):r.entryTime
    const target=ledger.get(key({...r,entryTime}));assert(target,`No original leg for ${key(r)}`)
    target[`${prefix}EntryTime`]=r.entryTime;target[`${prefix}Pattern`]=r.pattern;target[`${prefix}ReturnPct`]=+r.returnPct;target[`${prefix}MaePct`]=+r.maePct
  }
  }
}
const ledgerFile=uniqueFile('final-cohort-ledger.csv');writeCsv(ledgerFile,[...ledger.values()])
const describe=cs=>cs.map(c=>`\`${c.feature} ${c.op} ${Number(c.value.toPrecision(8))}\``).join(' AND ')
const primary=delay.report.frozenEarlierFit.evaluation,perf=primary.all.performance
const lines=[
  '# Final EMA entry coverage research',
  `${delay.report.frozenEarlierFit.rules.length} rules fitted on Oct 5-12 cover ${primary.all.cohortCovered}/159 original legs in the three-minute confirmation replay: ${primary.earlier.cohortCovered}/${primary.earlier.cohortTotal} on fitting dates and ${primary.later.cohortCovered}/${primary.later.cohortTotal} on later dates. They emit ${perf.tradeCount} trades, including ${primary.all.losingSignals} losers; win rate is ${perf.winRatePct}%, average gross return is ${perf.averageReturnPct}%, summed trade returns are ${perf.summedReturnPct} percentage points, worst adverse excursion is ${perf.worstMaePct}%, and worst day is ${perf.worstDay.date} (${perf.worstDay.summedReturnPct} summed percentage points). This is a historical coverage fit, not an established profitable entry system.`,
  '## Separate all-date coverage fits',
  '| Timing | Patterns | Original legs covered | Total signals | Losing signals | Win rate | Average gross return | Worst adverse move |',
  '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
  ...profiles.map(p=>{const x=p.report.exploratory140Fit.evaluation;return `| ${p.label} | ${x.perRule.length} | ${x.cohortCovered}/159 | ${x.performance.tradeCount} | ${x.losingSignals} | ${x.performance.winRatePct}% | ${x.performance.averageReturnPct}% | ${x.performance.worstMaePct}% |`}),
  '',
  'Coverage is historical recall of the selected cohort; it is not signal precision or trade win rate. All crossovers in all 205 unique stocks are replayed, including losing, small-profit, and end-of-day cases. Signals use only information available when emitted. No stop-loss or profit target is applied: exit follows the opposite EMA cross, or a last-session-close mark.',
  'The 140-leg coverage fits use all ten dates for fitting. They are exploratory and cannot be described as independent validation. Earlier reports claiming a clean holdout used that holdout to screen candidates and used only sampled losing controls; their precision claims are superseded here.',
  '## Earlier-fit chronological check',
  '| Timing | Earlier-date target coverage | Later-date target coverage | Later signals | Later win rate | Later average gross return |',
  '| --- | ---: | ---: | ---: | ---: | ---: |',
  ...profiles.map(p=>{const f=p.report.frozenEarlierFit.evaluation;return `| ${p.label} | ${f.earlier.cohortCovered}/${f.earlier.cohortTotal} | ${f.later.cohortCovered}/${f.later.cohortTotal} | ${f.later.performance.tradeCount} | ${f.later.performance.winRatePct}% | ${f.later.performance.averageReturnPct}% |`}),
  '',
  'The earlier-fit rules use only Oct 5-12 observations and labels, then replay unchanged on Oct 13-16. Because all ten dates have already been examined during this research, the later dates are not an untouched holdout.',
  '## Pattern definitions',
]
lines.push('### Primary result: five earlier-fit rules with three-minute confirmation',delay.report.methodology.entry,
  '| Pattern | Conditions, after earlier patterns fail | Cohort coverage across all ten dates | Extra signals |',
  '| --- | --- | ---: | ---: |')
for(const r of delay.report.frozenEarlierFit.evaluation.all.perRule)lines.push(`| ${r.pattern} | ${describe(r.conditions)} | ${r.cohortCovered} | ${r.extraSignals} |`)
lines.push('',`All primary-result signals: [${path.basename(delay.report.frozenEarlierFit.files.signals)}](${path.basename(delay.report.frozenEarlierFit.files.signals)}).`,'')
for(const p of profiles){
  lines.push(`### ${p.label}`,p.report.methodology.entry,'| Pattern | Conditions | Incremental cohort coverage | Extra signals |','| --- | --- | ---: | ---: |')
  for(const r of p.report.exploratory140Fit.evaluation.perRule)lines.push(`| ${r.pattern} | ${describe(r.conditions)} | ${r.cohortCovered} | ${r.extraSignals} |`)
  lines.push('',`Full report: [${p.name}](${p.name}).`,`All signals: [${path.basename(p.report.exploratory140Fit.files.signals)}](${path.basename(p.report.exploratory140Fit.files.signals)}).`,'')
}
lines.push('## Interpretation and reproducibility',
  'Apply rules in order; the first matching rule owns a signal. Conditions use the full numeric thresholds in the JSON report; displayed thresholds are rounded. For SELL, returns, RSI/MFI centered at 50, slopes, price gaps and depth flow are multiplied by -1. ATR and volume ratios retain positive values. MACD values are basis points of price, ATR/returns/gaps are percentages, and slope is percent log-price change per bar. Higher-timeframe ret1 covers one completed bar and ret3 covers three.',
  'Every rolling indicator must have its complete period of actual observations. Missing features cannot pass a numeric condition. Complete higher-timeframe bars are anchored at 09:15 IST. The five causal timing tests passed.',
  'Features prefixed cross_depth in the three-minute version refer to the depth observed at the original crossover, which is already known at the later entry. They are not fresh depth at that later time. Estimated delta uses price changes and cumulative volume; genuine aggressor-side trades and historical OI are not available in these archives.',
  'Returns exclude fees and slippage. SELL return is (entry-exit)/entry. Summed percentage returns are not portfolio returns; trades can overlap across stocks. Waiting three minutes changes the entry price and may reduce the captured move below the original 1.5% threshold. Cohort coverage still refers to the original 159 legs, not a claim that every delayed trade earns 1.5%.',
  `Every original leg and its matched exact/delayed pattern: [${path.basename(ledgerFile)}](${path.basename(ledgerFile)}).`,
  'Reproduce from saved data: `node scripts/fit-ema-coverage-rules.js --balanced`, then `node scripts/fit-ema-coverage-rules.js --delay3 --balanced`, then `node scripts/summarize-ema-coverage-audit.js`. The cache builder is `node scripts/research-ema-coverage.js --build --depth`; the delayed context builder is `node scripts/build-ema-confirmed-entries.js`.',
)
const rendered=[]
for(const line of lines){
  if(line.startsWith('|'))rendered.push(line)
  else {if(rendered.length&&rendered.at(-1)!=='')rendered.push('');rendered.push(line);if(line)rendered.push('')}
}
const output=uniqueFile('final-findings.md');fs.writeFileSync(output,rendered.join('\n')+'\n',{flag:'wx'})
console.log(JSON.stringify({findings:output,ledger:ledgerFile,profiles:profiles.map(p=>({name:p.label,report:p.name,coverage:p.report.exploratory140Fit.evaluation.cohortCovered,signals:p.report.exploratory140Fit.evaluation.performance.tradeCount,losses:p.report.exploratory140Fit.evaluation.losingSignals,performance:p.report.exploratory140Fit.evaluation.performance}))},null,2))
