import test from 'node:test'
import assert from 'node:assert/strict'
import {selected,stats,matching} from '../scripts/search-precision-ema-patterns.js'

const at=Date.parse('2026-10-05T10:00:00+05:30')
const view=(delay,returnPct,features={x:1},extra={})=>({date:'2026-10-05',symbol:'TEST',side:'BUY',key:'one-leg',cohort:true,
  signalAt:at+delay*60000,delay,features,returnPct,maePct:Math.min(-.1,returnPct),...extra})
const rule=delay=>({delay,conditions:[{feature:'x',op:'>=',value:1}]})

test('an earlier losing match supersedes a later winning match even if the later rule is listed first',()=>{
  const rows=[view(3,.8),view(0,-.2)],rules=[rule(3),rule(0)]
  assert.equal(selected(rows,rules)[0].delay,0)
  assert.equal(stats(rows,rules).losses,1)
  assert.equal(stats(rows,rules).profitableCohortCovered,0)
})
test('one original leg emits one trade when several timing rules match',()=>{
  const rows=[view(0,.3),view(3,.5),view(5,.6)],rules=[rule(5),rule(0),rule(3)]
  assert.equal(selected(rows,rules).length,1)
  assert.equal(stats(rows,rules).profitableCohortCovered,1)
})
test('profitable non-cohort trades are retained as winners rather than treated as false losing signals',()=>{
  const rows=[view(0,.5),view(0,.2,{x:1},{key:'another-leg',cohort:false})]
  const s=stats(rows,[rule(0)])
  assert.equal(s.trades,2);assert.equal(s.winners,2);assert.equal(s.cohortCovered,1);assert.equal(s.losses,0)
})
test('missing indicator values fail both upper and lower bound conditions',()=>{
  assert.equal(matching(view(0,.5,{}),rule(0)),false)
  assert.equal(matching(view(0,.5,{}),{delay:0,conditions:[{feature:'x',op:'<=',value:1}]}),false)
})
test('tree split equality stays on the <= branch and never leaks into the strict > branch',()=>{
  const row=view(0,.5,{x:1})
  assert.equal(matching(row,{delay:0,conditions:[{feature:'x',op:'>',value:1}]}),false)
  assert.equal(matching(row,{delay:0,conditions:[{feature:'x',op:'<=',value:1}]}),true)
  assert.equal(matching(view(0,.5,{x:1.000001}),{delay:0,conditions:[{feature:'x',op:'>',value:1}]}),true)
})
test('flat trades and cost-sensitive small gains are visible instead of being reported as loss-free net winners',()=>{
  const s=stats([view(0,0),view(0,.05,{x:1},{key:'small-gain'})],[rule(0)])
  assert.equal(s.breakeven,1);assert.equal(s.winners,1);assert.equal(s.afterHypothetical10bps.nonPositive,2)
})
