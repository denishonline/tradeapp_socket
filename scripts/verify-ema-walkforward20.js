import fs from 'node:fs'
import assert from 'node:assert/strict'
import {DATES,MINUTE,loadCandles} from './research-ema-coverage.js'
import {readCsv} from './verify-ema-advanced-outputs.js'

const report=JSON.parse(fs.readFileSync(process.argv[2],'utf8')),priceCheck=process.argv.includes('--prices'),all=[],audits=[]
assert.deepEqual(report.protocol.dates,DATES)
const key=e=>`${e.date}|${e.symbol}|${e.side}|${e.originalEntryTime}`
for(const output of report.outputs){
  const signals=readCsv(output.signals),cohort=readCsv(output.cohort),rules=new Map(output.library.map(r=>[r.id,r]))
  assert(output.library.length<=20);assert.equal(rules.size,output.library.length)
  assert.equal(signals.length,output.summary.trades);assert.equal(cohort.length,159)
  assert.equal(new Set(signals.map(key)).size,signals.length);assert.equal(new Set(cohort.map(key)).size,159)
  assert.equal(cohort.filter(e=>e.status==='WIN').length,output.summary.profitableCohort)
  const outcome=e=>(e.side==='BUY'?1:-1)*(+e.exitPrice-e.entryPrice)
  assert.equal(signals.filter(e=>outcome(e)<0).length,output.summary.losses)
  assert.equal(signals.filter(e=>outcome(e)===0).length,output.summary.flat)
  assert.equal(output.days.reduce((s,d)=>s+d.admitted.length,0),output.library.length)
  for(const d of output.days){
    const rows=signals.filter(e=>e.date===d.date)
    assert.equal(rows.length,d.performance.trades);assert(d.admitted.length<=3)
    if(d.warmup){assert.equal(rows.length,0);continue}
    const lock=JSON.parse(fs.readFileSync(d.selectionLock,'utf8'))
    assert(lock.trainingThrough<d.date);assert.deepEqual(lock.active.map(r=>r.id),d.activeRuleIds)
    if(output.name==='strict')assert(lock.validationDate<d.date&&lock.validationDate>lock.trainingThrough)
    for(const r of lock.active){
      assert(r.admittedBefore<=d.date);assert(r.conditions.length<=8)
      for(const c of r.conditions){assert(Number.isFinite(c.value));assert(!/^(date|symbol|side|cohort|returnPct|maePct|mfePct|exitPrice|exitTime|entryPrice|signalAt)$/.test(c.feature))}
      for(const date of r.fitSupport.dates)assert(date<r.admittedBefore)
      for(const date of r.validationSupport.dates)assert(date<r.admittedBefore)
      assert.equal(r.fitSupport.nonPositive,0);assert(r.fitSupport.targetDates.length>=2)
      if(output.name==='strict'){assert.equal(r.validationSupport.nonPositive,0);assert(r.validationSupport.trades>=2);assert(r.validationSupport.targetKeys.length>=1)}
    }
    for(const e of rows){assert(d.activeRuleIds.includes(+e.ruleId));assert(rules.get(+e.ruleId).admittedBefore<=e.date)}
  }
  for(const e of signals){
    assert(DATES.includes(e.date))
    const signal=Date.parse(`${e.date}T${e.signalTime}:00+05:30`),fill=Date.parse(`${e.date}T${e.fillTime}:00+05:30`),exit=Date.parse(`${e.date}T${e.exitTime}:00+05:30`)
    assert.equal(fill-signal,MINUTE);assert(exit>=fill)
    const ret=100*outcome(e)/e.entryPrice
    assert(Math.abs(ret-e.returnPct)<.000051);assert(+e.maePct<=Math.min(0,ret)+.000051)
    all.push(e)
  }
  audits.push({name:output.name,rules:output.library.length,trades:signals.length,cohortRows:cohort.length,losses:output.summary.losses})
}
if(priceCheck)for(const [symbol,rows]of Map.groupBy(all,e=>e.symbol)){
  const sessions=loadCandles(symbol)
  for(const e of rows){const at=Date.parse(`${e.date}T${e.signalTime}:00+05:30`),bar=sessions.get(e.date).find(r=>r.t===at);assert(bar);assert.equal(+e.entryPrice,bar.c)}
}
console.log(JSON.stringify({audits,ruleAdmissionChronology:'passed',rawFillPriceCheck:priceCheck},null,2))
