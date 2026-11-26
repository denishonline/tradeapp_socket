import test from 'node:test'
import assert from 'node:assert/strict'
import {selectBeforeDay,replayDay,historicalSupport,signature} from '../scripts/ema-walkforward20-core.js'

const view=(date,key,ret,features={x:1},extra={})=>({date,key,symbol:'TEST',side:'BUY',signalAt:Date.parse(`${date}T10:00:00+05:30`),delay:0,features,returnPct:ret,maePct:Math.min(0,ret),cohort:true,...extra})
const rule={delay:0,conditions:[{feature:'x',op:'>=',value:1}]}
const training=[view('2026-10-05','a',1),view('2026-10-06','b',1)]
const validation=[view('2026-10-07','c',1),view('2026-10-07','d',.2,{x:1},{cohort:false})]
const select=extra=>selectBeforeDay({history:[...training,...validation],training,validation,candidates:[rule],decisionDate:'2026-10-08',...extra})

test('admission uses distinct prior training sessions and separate prior validation',()=>{
  const s=select();assert.equal(s.admitted.length,1);assert.equal(s.library[0].id,1)
  assert.equal(s.library[0].admittedBefore,'2026-10-08');assert.equal(s.library[0].validationSupport.trades,2)
})
test('current or future rows cannot be used to select a rule',()=>{
  assert.throws(()=>select({history:[...training,view('2026-10-08','future',1)]}),/Current\/future/)
  assert.throws(()=>select({validation:[view('2026-10-09','future',1)]}),/Current\/future/)
})
test('a fitting-pure rule with any non-positive validation match cannot be admitted',()=>{
  const bad=[validation[0],{...validation[1],returnPct:0}]
  assert.equal(select({history:[...training,...bad],validation:bad}).admitted.length,0)
})
test('two targets on just one fitting date do not satisfy two-date support',()=>{
  const same=training.map(e=>({...e,date:'2026-10-05'}))
  assert.equal(select({training:same,history:[...same,...validation]}).admitted.length,0)
})
test('no held-out validation match means no strict admission, even with perfect fitting purity',()=>{
  assert.equal(select({validation:[]}).admitted.length,0)
  assert.equal(select({validation:[],requireValidation:false}).admitted.length,1)
})
test('deactivation leaves both the consumed library slot and the original loss intact',()=>{
  const admitted=select().library,loss=view('2026-10-08','lost',-.3),signals=replayDay([loss],admitted,'2026-10-08')
  const next=select({history:[...training,...validation,loss],library:admitted,candidates:[],decisionDate:'2026-10-09'})
  assert.equal(signals[0].returnPct,-.3);assert.equal(next.active.length,0);assert.equal(next.library.length,1)
  assert.equal(loss.returnPct,-.3)
})
test('a failed rule cannot free its lifetime slot for a replacement',()=>{
  const failed={...rule,id:1,admittedBefore:'2026-10-07'},loss=view('2026-10-07','lost',-.1)
  const s=select({history:[...training,...validation,loss],library:[failed],maxRules:1})
  assert.equal(s.library.length,1);assert.equal(s.admitted.length,0);assert.equal(s.active.length,0)
})
test('replay checks admission date and does not remove losing outcomes',()=>{
  const admitted={...rule,id:1,admittedBefore:'2026-10-08'}
  assert.throws(()=>replayDay([view('2026-10-07','early',1)],[admitted],'2026-10-07'),/before admission/)
  const rows=replayDay([view('2026-10-08','lose',-.2)],[admitted],'2026-10-08')
  assert.equal(rows.length,1);assert.equal(rows[0].returnPct,-.2)
})
test('signature is independent of condition order and missing indicators never pass',()=>{
  const r={...rule,conditions:[...rule.conditions,{feature:'y',op:'<=',value:2}]}
  assert.equal(signature(r),signature({...r,conditions:[...r.conditions].reverse()}))
  assert.equal(historicalSupport([view('2026-10-05','a',1,{})],rule).trades,0)
})
