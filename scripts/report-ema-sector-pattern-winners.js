import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'
import {REPORTS,STEM,round,uniqueFile} from './research-ema-coverage.js'
import {readCsv} from './verify-ema-advanced-outputs.js'

const stem=`${STEM}-sector-pure60`
const results=JSON.parse(fs.readFileSync(path.join(REPORTS,`${stem}-results.json`),'utf8'))
const signalsFile=path.join(REPORTS,`${stem}-retrospective-signals.csv`)
const rows=readCsv(signalsFile)
const rules=results.retrospective.rules
const summary=results.retrospective.output.summary
const cohort=new Set(readCsv(path.join(REPORTS,`${stem}-retrospective-cohort.csv`))
  .filter(r=>r.status==='WIN').map(r=>`${r.date}|${r.symbol}|${r.side}|${r.originalEntryTime}`))

assert.equal(rules.length,27)
assert.equal(rows.length,summary.trades)
assert.equal(rows.filter(r=>+r.returnPct>0).length,summary.winners)
assert.equal(rows.filter(r=>+r.returnPct<=0).length,0)
assert.equal(cohort.size,159)
assert.equal(new Set(rows.map(r=>`${r.date}|${r.symbol}|${r.side}|${r.originalEntryTime}`)).size,rows.length)
assert(rows.every(r=>rules.some(rule=>rule.id===r.ruleId)))
assert.equal(rows.filter(r=>r.cohort==='true').length,159)

const chronological=(a,b)=>a.date.localeCompare(b.date)||a.signalTime.localeCompare(b.signalTime)||a.symbol.localeCompare(b.symbol)
const groups=new Map(rules.map(rule=>[rule.id,rows.filter(r=>r.ruleId===rule.id).sort(chronological)]))
const lines=[
  '# Winners by pattern and signal time — October 5–16, 2026',
  '',
  `All-date retrospective fit: **${rules.length} patterns, ${summary.trades} winning trades, ${summary.losses} losers, ${summary.flat} flats**. The ${summary.profitableCohort} original target legs appear once each; ${summary.trades-summary.profitableCohort} additional winning trades are outside that cohort.`,
  '',
  `Average gross return **${summary.averageReturnPct}%** per trade; summed gross return **${summary.summedReturnPct} percentage points**; worst maximum adverse excursion **${summary.worstMaePct}%**; worst day by summed return **${summary.worstDay.date} (+${summary.worstDay.sum} percentage points)**. With a hypothetical 10 bps round-trip cost, ${summary.afterHypothetical10bps.nonPositive} trades become non-positive.`,
  '',
  'Signal and fill times are IST. The signal uses information available at that time; the fill is at the next completed one-minute candle close. The rules were selected using all ten dates, so this list is a retrospective fit, not an out-of-sample or live track record. Summed percentage points are not portfolio return.',
  '',
  'Standalone target support is the number of distinct original legs a rule matches by itself. Assigned target legs are the trades credited to that rule after earlier matching patterns take precedence. Standalone support can overlap across rules, so it is not summed in the total row.',
  '',
  `Source signals: [${path.basename(signalsFile)}](${path.basename(signalsFile)}). Exact conditions: [${stem}-results.json](${stem}-results.json).`,
  '',
  '## Pattern summary',
  '',
  '| Pattern | Wait (min) | Standalone target support | Assigned winners | Assigned target legs | Other winners | BUY | SELL | Mean gross % | Sum (pp) | Worst MAE % |',
  '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
  ...rules.map(rule=>{
    const group=groups.get(rule.id),target=group.filter(r=>r.cohort==='true').length
    const returns=group.map(r=>+r.returnPct),maes=group.map(r=>+r.maePct)
    const total=returns.reduce((s,x)=>s+x,0)
    return `| ${rule.id} | ${rule.delay} | ${rule.standaloneTargetSupport} | ${group.length} | ${target} | ${group.length-target} | ${group.filter(r=>r.side==='BUY').length} | ${group.filter(r=>r.side==='SELL').length} | ${round(total/group.length)} | ${round(total)} | ${round(Math.min(...maes))} |`
  }),
  `| **Total** | | | **${rows.length}** | **159** | **${rows.length-159}** | **${rows.filter(r=>r.side==='BUY').length}** | **${rows.filter(r=>r.side==='SELL').length}** | **${summary.averageReturnPct}** | **${summary.summedReturnPct}** | **${summary.worstMaePct}** |`,
  '',
  '## Winning signals',
  ''
]
for(const rule of rules){
  const group=groups.get(rule.id),target=group.filter(r=>r.cohort==='true').length
  lines.push(`### ${rule.id} — ${group.length} winners (${target} assigned target legs; ${rule.standaloneTargetSupport} standalone)`,
    '',
    '| Date | Signal (IST) | Fill (IST) | Symbol | Side | Target leg | Entry | Exit (IST) | Exit price | Gross return % | MAE % |',
    '| --- | --- | --- | --- | --- | --- | ---: | --- | ---: | ---: | ---: |',
    ...group.map(r=>`| ${r.date} | ${r.signalTime} | ${r.fillTime} | ${r.symbol} | ${r.side} | ${r.cohort==='true'?'Yes':'No'} | ${r.entryPrice} | ${r.exitTime} | ${r.exitPrice} | +${r.returnPct} | ${r.maePct} |`),
    '')
}
const file=uniqueFile('sector-pure60-pattern-wise-winners.md')
fs.writeFileSync(file,lines.join('\n')+'\n',{flag:'wx'})
console.log(JSON.stringify({report:file,patterns:rules.length,winners:rows.length,targetLegs:cohort.size,nonTargetWinners:rows.length-cohort.size},null,2))
