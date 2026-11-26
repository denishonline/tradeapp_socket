import test from 'node:test'
import assert from 'node:assert/strict'
import {MINUTE} from '../scripts/research-ema-coverage.js'
import {sessionFlowSeries,profileSummary} from '../scripts/ema-session-flow-features.js'
import {priceActionSeries} from '../scripts/ema-price-action-features.js'
import {buildContext} from '../scripts/search-pure-tree-ema-patterns.js'

function candles(date,n,volume=100){const start=Date.parse(`${date}T09:15:00+05:30`);return Array.from({length:n},(_,i)=>{const o=100+Math.sin(i/4),c=o+Math.cos(i/3)/5;return {t:start+i*MINUTE,o,h:Math.max(o,c)+.2,l:Math.min(o,c)-.2,c,v:volume}})}
const past=[candles('2026-10-05',60,100),candles('2026-10-06',60,300)]

test('session VWAP, approximate profile and CVD proxy are prefix invariant',()=>{
  const rows=candles('2026-10-07',60,400),changed=rows.map((r,i)=>i<25?r:{...r,o:r.o*3,h:r.h*3,l:r.l*3,c:r.c*3,v:r.v*20})
  assert.deepEqual(sessionFlowSeries(rows.slice(0,25),past),sessionFlowSeries(changed,past).slice(0,25))
})
test('RVOL uses only previous completed sessions at the same clock and needs two samples',()=>{
  const rows=candles('2026-10-07',60,400),future=candles('2026-10-08',60,10000)
  const f=sessionFlowSeries(rows,[...past,future])[10].long
  assert.equal(f.adv_rvolTime1,2);assert.equal(f.adv_rvolTime3,2);assert.equal(f.adv_rvolTime5,2);assert.equal(f.adv_cumulativeRvolTime,2)
  assert.equal(sessionFlowSeries(rows,[past[0]])[10].long.adv_rvolTime1,undefined)
})
test('a missing opening minute does not shift the RVOL clock or fabricate complete-session VWAP',()=>{
  const rows=candles('2026-10-07',60,400).slice(1),f=sessionFlowSeries(rows,past)[0].long
  assert.equal(f.adv_rvolTime1,2);assert.equal(f.adv_cumulativeRvolTime,undefined);assert.equal(f.adv_vwapGap,undefined)
})
test('approximate profile preserves volume and its value area covers at least70 percent',()=>{
  const p=profileSummary(new Map([[0,60],[1,20],[2,20]]),100)
  assert.equal(p.total,100);assert(p.covered>=70);assert(p.vah>p.poc&&p.poc>p.val)
})
test('direction normalization mirrors signed features, not relative volume',()=>{
  const f=sessionFlowSeries(candles('2026-10-07',30,400),past)[20]
  assert.equal(f.long.adv_vwapGap,-f.short.adv_vwapGap)
  assert.equal(f.long.adv_candleCvdProxyPct,-f.short.adv_candleCvdProxyPct)
  assert.equal(f.long.adv_rvolTime5,f.short.adv_rvolTime5)
})
test('BOS, sweeps, OB, FVG and opening ranges cannot see changed future candles',()=>{
  const rows=candles('2026-10-07',80),mutated=rows.map((r,i)=>i<25?r:{...r,o:r.o*2,h:r.h*2,l:r.l*2,c:r.c*2})
  assert.deepEqual(priceActionSeries(rows.slice(0,25)),priceActionSeries(mutated).slice(0,25))
})
test('a two-right pivot is unavailable until confirmation; BOS occurs later, not at the pivot',()=>{
  const rows=candles('2026-10-07',7),highs=[10,11,14,12,11,12,15]
  rows.forEach((r,i)=>Object.assign(r,{o:highs[i]-.5,h:highs[i],l:highs[i]-1,c:highs[i]-.2}))
  const f=priceActionSeries(rows)
  assert.equal(f[3].long.pa_swingBreakGap,undefined);assert(f[4].long.pa_swingBreakGap<0)
  assert.equal(f[2].long.pa_bosRecent5,0);assert.equal(f[6].long.pa_bosRecent5,1)
})
test('FVG cannot be retested on its own formation candle',()=>{
  const rows=candles('2026-10-07',4),ohlc=[[9.5,10,9,9.7],[10.5,11,10.2,10.8],[11.2,12,11,11.5],[11.4,11.7,10.5,11.5]]
  rows.forEach((r,i)=>{[r.o,r.h,r.l,r.c]=ohlc[i]})
  const f=priceActionSeries(rows)
  assert.equal(f[2].long.pa_fvgAge,0);assert.equal(f[2].long.pa_fvgRetest,0)
  assert.equal(f[3].long.pa_fvgRetest,1)
})
test('opening range is not exposed before its formation is complete',()=>{
  const f=priceActionSeries(candles('2026-10-07',40))
  assert.equal(f[14].long.pa_orb15Gap,undefined);assert(Number.isFinite(f[15].long.pa_orb15Gap))
  assert.equal(f[29].long.pa_orb30Gap,undefined);assert(Number.isFinite(f[30].long.pa_orb30Gap))
})
test('an opposing-candle zone is activated after displacement, never backdated to its origin',()=>{
  const rows=candles('2026-10-07',15).map(r=>({...r,o:100,h:100.2,l:99.8,c:100}))
  Object.assign(rows[12],{o:100.2,h:100.3,l:99.7,c:99.9});Object.assign(rows[14],{o:100,h:102.2,l:99.9,c:102})
  const f=priceActionSeries(rows)
  assert.equal(f[12].long.pa_orderBlockAge,undefined);assert.equal(f[13].long.pa_orderBlockAge,undefined)
  assert.equal(f[14].long.pa_orderBlockAge,0);assert.equal(f[14].long.pa_orderBlockRetest,0)
})

test('event flags can participate in rule discovery, even when all fitting targets have flag1',()=>{
  const rows=Array.from({length:80},(_,i)=>({delay:0,key:`k${i}`,cohort:i<6,returnPct:i<6?1:-.1,features:{pa_bosRecent5:i<6?1:0}}))
  assert(buildContext(rows,0,{allowBinary:true}).columns.some(c=>c.feature==='pa_bosRecent5'))
})
