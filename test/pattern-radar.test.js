import assert from 'node:assert/strict'
import { it } from 'node:test'
import { createPatternRadar } from '../ui/pattern-radar.js'

const open=Date.parse('2026-10-05T09:15:00+05:30')
const rules=Array.from({length:27},(_,i)=>({id:`P${String(i+1).padStart(2,'0')}`,delay:0,
  conditions:[{feature:i?'neverPresent':'ret1',op:'>',value:-1000}]}))
const row=(i,price)=>({time:open/1000+i*60,open:price,high:price,low:price,close:price,volume:100})

it('emits a separate experimental pattern only after the next completed candle',async()=>{
  const updates=[]
  const radar=createPatternRadar({rules,sectorDefinitions:[],sectorBuckets:{},now:()=>open+60_000,
    onUpdate:s=>updates.push(s)})
  await radar.seed(['SBIN'],{read:async()=>[]})
  for(let i=0;i<20;i++)radar.observeCandle('SBIN',row(i,100+i*.1))
  radar.observeCandle('SBIN',row(20,80))
  assert.equal(radar.snapshot().length,0)
  radar.observeCandle('SBIN',row(21,79))
  const [signal]=radar.snapshot()
  assert.equal(signal.pattern,'P01')
  assert.equal(signal.direction,'SELL')
  assert.equal(signal.price,79)
  assert.equal(signal.status,'Active')
  assert.equal(signal.stop,null)
  assert.equal(signal.target,null)
  radar.observeCandle('SBIN',row(21,79))
  assert.equal(radar.snapshot().length,1)
  assert.ok(updates.length)
})

it('does not fire when a rule needs unavailable features',async()=>{
  const missing=rules.map(r=>({...r,conditions:[{feature:'depthDelta',op:'>',value:0}]}))
  const radar=createPatternRadar({rules:missing,sectorDefinitions:[],sectorBuckets:{},now:()=>open+60_000})
  await radar.seed(['SBIN'],{read:async()=>[]})
  for(let i=0;i<20;i++)radar.observeCandle('SBIN',row(i,100+i*.1))
  radar.observeCandle('SBIN',row(20,80))
  radar.observeCandle('SBIN',row(21,79))
  assert.deepEqual(radar.snapshot(),[])
})
