import test from 'node:test'
import assert from 'node:assert/strict'
import {indicators,aggregate,timeframeFeatures,normalize,MINUTE} from '../scripts/research-ema-coverage.js'

const start=Date.parse('2026-10-05T09:15:00+05:30')
function candles(n){return Array.from({length:n},(_,i)=>{const o=100+Math.sin(i/4),c=o+Math.cos(i/3)/5;return {t:start+i*MINUTE,o,h:Math.max(o,c)+.2,l:Math.min(o,c)-.2,c,v:100+i}})}

test('one-minute indicators have identical historical values when future candles change',()=>{
  const rs=candles(90),prefix=indicators(rs.slice(0,50)),mutated=rs.map((r,i)=>i<50?r:{...r,o:r.o*2,h:r.h*2,l:r.l*2,c:r.c*2})
  assert.deepEqual(indicators(mutated).slice(0,50),prefix)
})
test('higher timeframe features cannot see the unfinished interval',()=>{
  const rs=candles(30),cutoff=start+13*MINUTE,frames=new Map([[5,aggregate(rs,5)]])
  const before=timeframeFeatures(frames,cutoff,1)
  const changed=rs.map((r,i)=>i<10?r:{...r,o:r.o*3,h:r.h*3,l:r.l*3,c:r.c*3})
  assert.deepEqual(timeframeFeatures(new Map([[5,aggregate(changed,5)]]),cutoff,1),before)
})
test('one-bar timeframe return covers exactly one complete interval',()=>{
  const rs=candles(20),bars=aggregate(rs,5),at=start+10*MINUTE
  const f=timeframeFeatures(new Map([[5,bars]]),at,1)
  assert.equal(f.tf5_ret1,100*(rs[9].c/rs[5].o-1))
})
test('a missing minute excludes the incomplete higher-timeframe candle',()=>{
  const rs=candles(15).filter((_,i)=>i!==7),bars=aggregate(rs,5)
  assert.deepEqual(bars.map(b=>b.t),[start,start+10*MINUTE])
})
test('short breakout compares price to prior support; RSI reverses and ATR does not',()=>{
  const f=normalize({support20:-.2,resistance20:-.5,rsi14:-15,atr14:.12},-1)
  assert.equal(f.breakout20,.2);assert.equal(f.rsi14,15);assert.equal(f.atr14,.12)
})
