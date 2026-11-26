import test from 'node:test'
import assert from 'node:assert/strict'
import {conditionPass,rulePass,execute,changes,choose,FAMILIES} from '../scripts/ema-five-pattern-core.js'

const start=Date.parse('2026-10-05T10:00:00+05:30')
const view=(key,delay,ret,extra={})=>({date:'2026-10-05',symbol:'TEST',side:'BUY',key,signalAt:start+delay*60000,delay,returnPct:ret,maePct:Math.min(0,ret),cohort:true,features:{x:1},baseMatch:false,...extra})
const rule={name:'familyA',delay:0,conditions:[{feature:'x',op:'>=',value:1}]}

test('new earlier pattern can displace a profitable baseline, and the damage is measured',()=>{
  const rows=[view('a',5,1,{baseMatch:true}),view('a',0,-.2)]
  const baseline=execute(rows,[]),combined=execute(rows,[rule]),change=changes(baseline,combined)
  assert.equal(combined.length,1);assert.equal(combined[0].pattern,'familyA')
  assert.equal(change.lostTargetWinners,1);assert.equal(change.newNonPositive,1);assert.equal(change.earlierReplacements,1)
})
test('baseline retains ownership when an added rule matches the same timestamp',()=>{
  const rows=[view('a',0,.5,{baseMatch:true})]
  assert.equal(execute(rows,[rule])[0].pattern,'BASE')
})
test('gross-winning non-target controls are allowed, while flat outcomes are non-positive',()=>{
  const rows=[view('a',0,0,{cohort:false}),view('b',0,.1,{cohort:false}),view('c',0,1)]
  const delta=changes([],execute(rows,[rule]))
  assert.equal(delta.newNonPositive,1);assert.equal(delta.newTargetWinners,1)
})
test('missing indicator values cannot satisfy a family condition',()=>{
  assert.equal(conditionPass({},rule.conditions[0]),false)
  assert.equal(rulePass(view('a',0,1,{features:{}}),rule),false)
  assert.equal(rulePass(view('a',3,1),rule),false)
})
test('strict calibration selection does not add a rule with new losing controls',()=>{
  const fit=[view('a',0,1),view('b',0,-.2,{cohort:false})]
  const cal=fit.map(e=>({...e,date:'2026-10-09'}))
  assert.equal(choose(fit,cal,[rule],{strict:true}).rules.length,0)
  assert.equal(choose(fit,cal,[rule]).rules.length,1)
})
test('an existing target winner may not be sacrificed for another target in calibration',()=>{
  const rows=[view('a',5,1,{baseMatch:true}),view('a',0,-.2),view('b',0,2)]
  assert.equal(choose(rows,rows,[rule]).rules.length,0)
})
test('one family is never selected twice to manufacture five nominally different patterns',()=>{
  const a={name:'familyA',delay:0,conditions:[{feature:'x',op:'>=',value:1}]},b={...a,delay:3}
  const rows=[view('a',0,1),view('b',3,1)]
  assert.equal(choose(rows,rows,[a,b]).rules.length,1)
  assert.equal(FAMILIES.length,5);assert.equal(new Set(FAMILIES.map(f=>f.name)).size,5)
})
