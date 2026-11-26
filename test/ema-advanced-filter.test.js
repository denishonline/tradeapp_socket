import test from 'node:test'
import assert from 'node:assert/strict'
import {MINUTE} from '../scripts/research-ema-coverage.js'
import {completedCandleFill,interactionFeatures,fitForest,predict,firstSignals,summarize,wilson} from '../scripts/ema-advanced-filter-core.js'

const at=Date.parse('2026-10-05T10:00:00+05:30')
const event={date:'2026-10-05',symbol:'TEST',key:'one',side:'BUY',signalAt:at,entryTime:'10:00',exitTime:'10:03',exitPrice:105,cohort:true,features:{x:1}}
const rows=[{t:at,o:100,c:101,h:102,l:99},{t:at+MINUTE,o:101,c:103,h:104,l:100},{t:at+2*MINUTE,o:103,c:105,h:106,l:102}]

test('fill uses next completed candle close, and does not charge its pre-fill adverse excursion',()=>{
  const e=completedCandleFill(event,rows)
  assert.equal(e.entryPrice,101);assert.equal(e.fillTime,'10:01');assert.equal(e.entryAt,at+MINUTE)
  assert.equal(e.returnPct,100*4/101);assert.equal(e.maePct,-100/101)
})
test('short return is cash-price normalized and includes the exit gap in MAE',()=>{
  const e=completedCandleFill({...event,side:'SELL',exitPrice:108},rows)
  assert.equal(e.returnPct,-100*7/101);assert.equal(e.maePct,-100*7/101)
})
test('a reversal at the fill timestamp remains in the ledger as a flat or losing trade, not discarded',()=>{
  const e=completedCandleFill({...event,exitTime:'10:01',exitPrice:100},rows)
  assert(e);assert(e.returnPct<0)
})
test('derived indicators cannot change when labels or future records change',()=>{
  const f={ret3:.2,atr14:.1,depthFull:.3,cross_depthFull:.1}
  assert.deepEqual(interactionFeatures(f),interactionFeatures({...f}))
  assert.equal(interactionFeatures(f).returnAtr3,2)
  assert(Math.abs(interactionFeatures(f).depthFullChangeSinceCross-.2)<1e-12)
  assert.equal(interactionFeatures({ret3:.2}).returnAtr3,undefined)
})
test('earliest signal is selected without consulting outcomes',()=>{
  const base={...event,returnPct:-.2,delay:0,maePct:-.3},later={...base,signalAt:at+3*MINUTE,returnPct:1,delay:3}
  assert.equal(firstSignals([later,base],()=>true)[0].returnPct,-.2)
})
test('frozen forest inference depends only on features, with deterministic missing-value handling',()=>{
  const training=Array.from({length:100},(_,i)=>({features:{x:i%7===0?NaN:i},returnPct:i>50?1:-.2}))
  const model=fitForest(training,['x'],{trees:3,maxDepth:3,minLeaf:5,featureTrials:3,cutTrials:3,seed:42})
  const before=JSON.stringify(model),score=predict(model,{x:80})
  assert(score.pGross>predict(model,{x:20}).pGross)
  assert.deepEqual(score,predict(model,{x:80,returnPct:-100,cohort:false,date:'2099-01-01'}))
  assert(Number.isFinite(predict(model,{}).p));assert.equal(JSON.stringify(model),before)
})
test('zero-signal filter has undefined win rate instead of a misleading 100% result',()=>{
  assert.equal(summarize([]).winRatePct,null);assert.equal(wilson(0,0),0)
  assert(wilson(20,20)<1)
})

test('rare-target weighting changes the fitting objective without introducing cohort identity as an input',()=>{
  const training=Array.from({length:100},(_,i)=>({features:{x:1},cohort:i<5,returnPct:i<5?1:-.2}))
  const settings={trees:8,maxDepth:0,minLeaf:2,seed:9,objective:'cohort'}
  const ordinary=fitForest(training,['x'],{...settings,positiveWeight:1}),weighted=fitForest(training,['x'],{...settings,positiveWeight:50})
  assert(predict(weighted,{x:1}).p>predict(ordinary,{x:1}).p)
  assert.deepEqual(predict(weighted,{x:1}),predict(weighted,{x:1,cohort:false,returnPct:-100}))
  assert.deepEqual(weighted.features,['x'])
})
