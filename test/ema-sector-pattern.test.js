import test from 'node:test'
import assert from 'node:assert/strict'
import {sectorSeries,sectorAt,pureCover} from '../scripts/ema-sector-pattern-core.js'
import {buildContext,seedCover,grow} from '../scripts/search-pure-tree-ema-patterns.js'
import {matching} from '../scripts/search-precision-ema-patterns.js'

const start=Date.parse('2026-10-05T09:15:00+05:30'),minute=60000
const bars=Array.from({length:40},(_,i)=>({t:start+i*minute,o:100+i,c:101+i,h:102+i,l:99+i,v:0}))
const event=(i,extra={})=>({key:`k${i}`,date:'2026-10-05',symbol:'TEST',side:'BUY',delay:0,signalAt:start+i*minute,cohort:true,returnPct:1,features:{x:i},...extra})
const rule=keys=>({delay:0,conditions:[{feature:'x',op:'>',value:-1}],positiveKeys:keys})

test('sector context is prefix-invariant and uses only completed candles',()=>{
  const full=sectorSeries(bars),prefix=sectorSeries(bars.slice(0,25)),t=start+25*minute
  assert.deepEqual(sectorAt(full,t),sectorAt(prefix,t))
  assert.equal(sectorAt(full,t).end,t)
  const changed=bars.map((r,i)=>i<25?r:{...r,c:r.c*20,o:r.o*20})
  assert.deepEqual(sectorAt(full,t),sectorAt(sectorSeries(changed),t))
  assert.equal(sectorAt(full,start),null)
})
test('sector context rejects stale data and requires complete minute windows',()=>{
  assert.equal(sectorAt(sectorSeries(bars.slice(0,25)),start+26*minute),null)
  const gap=sectorSeries(bars.filter((_,i)=>i!==23)),bar=sectorAt(gap,start+25*minute)
  assert.equal(bar.features.ret3,undefined)
  assert.equal(bar.features.emaGap,undefined)
  assert.equal(sectorAt(sectorSeries(bars),start+2*minute).features.ret3,undefined)
})
test('pure cover counts four different target legs, not duplicated views',()=>{
  const events=[event(1),event(2),event(3)]
  assert.equal(pureCover(events,[rule(['k1','k1','k2','k3'])]).rules.length,0)
  assert.throws(()=>pureCover(events,[rule(['k1','k2','k3','invented'])]),/support/)
})
test('non-target losers and flat trades disqualify a purported pure rule',()=>{
  const winners=[0,1,2,3].map(i=>event(i)),candidate=rule(winners.map(e=>e.key))
  for(const ret of [-1,0,NaN])assert.throws(()=>pureCover([...winners,event(5,{cohort:false,returnPct:ret})],[candidate]),/purity/)
})
test('pure cover retains winning controls, deduplicates overlap, and obeys budget',()=>{
  const events=[0,1,2,3,4].map(i=>event(i)),candidate=rule(events.map(e=>e.key))
  const output=pureCover([...events,event(6,{cohort:false})],[candidate,candidate],{maxRules:1})
  assert.equal(output.rules.length,1);assert.equal(output.covered,5)
  assert.equal(output.rules[0].standaloneTrades,6)
  assert.equal(output.rules[0].standaloneTargetSupport,5)
})
test('seed covering and tree leaves enforce configurable minimum four target keys',()=>{
  const rows=Array.from({length:8},(_,i)=>event(i,{cohort:i>=4,returnPct:i>=4?1:-1,features:{x:i>=4?i:0}})),ctx=buildContext(rows,0,{allowBinary:true}),pool=new Map()
  seedCover(ctx,pool,{minPos:4,maxDepth:4})
  grow(ctx,0,pool,{minPos:4,maxDepth:4,featuresPerSplit:1})
  assert(pool.size>0)
  for(const r of pool.values()){
    assert(new Set(r.positiveKeys).size>=4)
    assert(rows.filter(e=>matching(e,r)).every(e=>e.returnPct>0))
  }
})
