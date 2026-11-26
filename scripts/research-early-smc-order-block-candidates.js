#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'

const ROOT = process.cwd()
const COHORT = path.join(ROOT, 'reports', '2026-10-05-to-2026-10-16-ema10-ema20-over-1p5-trend-legs.csv')
const ALLOWED = new Set(['2026-10-05','2026-10-06','2026-10-07','2026-10-08','2026-10-09','2026-10-12','2026-10-13','2026-10-14','2026-10-15','2026-10-16','2026-10-19'])
const TRAIN_END = '2026-10-14'
const TEST_DATES = new Set(['2026-10-15', '2026-10-16'])
const IST_MS = 330 * 60_000
const round = (value, digits = 4) => Number.isFinite(value) ? +value.toFixed(digits) : null
const median = values => { const sorted = values.filter(Number.isFinite).sort((a,b) => a-b); return sorted.length ? sorted[Math.floor(sorted.length / 2)] : NaN }
const stampOf = epoch => new Date(+epoch * 1000 + IST_MS).toISOString().slice(0,16).replace('T',' ')
const endTime = stamp => { const d = new Date(`${stamp.replace(' ', 'T')}:00+05:30`); d.setMinutes(d.getMinutes()+5); return new Date(d.getTime()+IST_MS).toISOString().slice(11,16) }

function cohortPairs() {
  const lines = fs.readFileSync(COHORT, 'utf8').trim().split(/\r?\n/)
  const headers = lines.shift().split(',')
  const dateAt = headers.indexOf('date'), symbolAt = headers.indexOf('symbol')
  return [...new Map(lines.map(line => {
    const fields = line.split(','), date = fields[dateAt], symbol = fields[symbolAt]
    return [`${date}|${symbol}`, { date, symbol }]
  })).values()].filter(row => ALLOWED.has(row.date))
}

function loadBars(symbol) {
  const file = path.join(ROOT, 'db', 'candles', `${symbol}.jsonl`)
  const unique = new Map()
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue
    let x
    try { x = JSON.parse(line) } catch { continue }
    const stamp = stampOf(x.time), date = stamp.slice(0,10), minute = stamp.slice(11)
    if (minute < '09:15' || minute > '15:29') continue
    unique.set(stamp, { stamp, date, minute, o:+x.open, h:+x.high, l:+x.low, c:+x.close, v:+x.volume })
  }
  const buckets = new Map()
  for (const x of [...unique.values()].sort((a,b)=>a.stamp.localeCompare(b.stamp))) {
    const [hour, minute] = x.minute.split(':').map(Number)
    const start = 555 + Math.floor((hour*60+minute-555)/5)*5
    const key = `${x.date} ${String(Math.floor(start/60)).padStart(2,'0')}:${String(start%60).padStart(2,'0')}`
    const b = buckets.get(key)
    if (!b) buckets.set(key, { ...x, stamp:key, minute:key.slice(11), n:1 })
    else { b.h=Math.max(b.h,x.h); b.l=Math.min(b.l,x.l); b.c=x.c; b.v+=x.v; b.n++ }
  }
  return [...buckets.values()].filter(x=>x.n===5).sort((a,b)=>a.stamp.localeCompare(b.stamp))
}

function smcBearishEvents(bars) {
  const pivot = () => ({ level:NaN, crossed:false, index:-1 })
  const swingHigh=pivot(), swingLow=pivot(), internalHigh=pivot(), internalLow=pivot()
  let swingLeg=0, internalLeg=0, internalTrend=0
  const active=[], events=[], pendingOrigins=new Set()
  const update = (i,size,internal) => {
    if (i<size) return
    const candidate=bars[i-size], recent=bars.slice(i-size+1,i+1)
    const high=candidate.h>Math.max(...recent.map(x=>x.h)), low=candidate.l<Math.min(...recent.map(x=>x.l))
    const old=internal?internalLeg:swingLeg
    let next=old
    if (high) next=0; else if (low) next=1
    if (internal) internalLeg=next; else swingLeg=next
    if (next===old) return
    const p=next-old===1?(internal?internalLow:swingLow):(internal?internalHigh:swingHigh)
    p.level=next-old===1?candidate.l:candidate.h; p.crossed=false; p.index=i-size
  }
  for (let i=0;i<bars.length;i++) {
    const oldHigh=internalHigh.level, oldLow=internalLow.level
    update(i,50,false); update(i,5,true)
    const previous=i?bars[i-1].c:NaN
    if (Number.isFinite(internalHigh.level)&&bars[i].c>internalHigh.level&&previous<=oldHigh&&!internalHigh.crossed&&internalHigh.level!==swingHigh.level) {
      internalHigh.crossed=true; internalTrend=1
    }
    if (Number.isFinite(internalLow.level)&&bars[i].c<internalLow.level&&previous>=oldLow&&!internalLow.crossed&&internalLow.level!==swingLow.level) {
      internalLow.crossed=true
      const candidates=[]
      for(let j=internalLow.index;j<i;j++) if(bars[j].minute!=='09:15') candidates.push(j)
      if(candidates.length) {
        let origin=candidates[0]
        for(const j of candidates.slice(1)) if(bars[j].h>bars[origin].h) origin=j
        const block={ origin, confirmation:i, high:bars[origin].h, low:bars[origin].l, invalidated:null, structure:internalTrend===1?'CHoCH':'BOS' }
        events.push(block); active.push(block)
      }
      internalTrend=-1
    }
    if (Number.isFinite(internalLow.level) && !internalLow.crossed && internalLow.index >= 0 && internalLow.index < i) {
      const candidates=[]
      for(let j=internalLow.index;j<=i;j++) if(bars[j].minute!=='09:15') candidates.push(j)
      if(candidates.length) {
        let origin=candidates[0]
        for(const j of candidates.slice(1)) if(bars[j].h>bars[origin].h) origin=j
        if(origin===i) pendingOrigins.add(i)
      }
    }
    for(let j=active.length-1;j>=0;j--) if(bars[i].h>active[j].high) { active[j].invalidated=i; active.splice(j,1) }
  }
  return { events:events.filter(x=>x.invalidated===null || x.invalidated>x.confirmation), pendingOrigins }
}

function ema(values, period) {
  const out=[], alpha=2/(period+1); let value=NaN
  for (const x of values) { value=Number.isFinite(value)?alpha*x+(1-alpha)*value:x; out.push(value) }
  return out
}

function rowsForPair(pair, bars, smc) {
  const ema10=ema(bars.map(x=>x.c),10), ema20=ema(bars.map(x=>x.c),20)
  const positives=new Map(smc.events.filter(x=>bars[x.origin].date===pair.date && x.confirmation-x.origin<=6).map(x=>[x.origin,x]))
  const rows=[]
  for(let i=20;i<bars.length-7;i++) {
    const b=bars[i]
    if(b.date!==pair.date || b.minute<'09:20' || b.minute>'14:30') continue
    const prior=bars.slice(i-20,i), range=b.h-b.l || 1, ranges=prior.map(x=>x.h-x.l), volumes=prior.map(x=>x.v)
    const event=positives.get(i), entry=bars[i+1], exit=bars[i+7], path=bars.slice(i+2,i+8)
    rows.push({
      date:pair.date,symbol:pair.symbol,index:i,time:b.minute,signalAt:endTime(b.stamp),positive:Boolean(event),confirmedAt:event?endTime(bars[event.confirmation].stamp):null,
      pendingBearishOrigin:smc.pendingOrigins.has(i),red:b.c<b.o,body:Math.abs(b.c-b.o)/range,closeLocation:(b.c-b.l)/range,upperWick:(b.h-Math.max(b.o,b.c))/range,
      localHigh3:b.h>=Math.max(...bars.slice(i-3,i).map(x=>x.h)),localHigh5:b.h>=Math.max(...bars.slice(i-5,i).map(x=>x.h)),
      rangeRatio:range/(median(ranges)||range),volumeRatio:b.v/(median(volumes)||b.v),
      emaBear:ema10[i]<ema20[i],closeBelowEma10:b.c<ema10[i],return3:100*(b.c/bars[i-3].c-1),
      tradeReturn:100*(entry.c-exit.c)/entry.c,mae:100*(entry.c-Math.max(...path.map(x=>x.h)))/entry.c
    })
  }
  return rows
}

const rules = {
  'pending SMC origin': x=>x.pendingBearishOrigin,
  'pending+red rejection': x=>x.pendingBearishOrigin&&x.red&&x.body>=.45&&x.closeLocation<=.35,
  'pending+red rejection+volume': x=>x.pendingBearishOrigin&&x.red&&x.body>=.45&&x.closeLocation<=.35&&x.volumeRatio>=1,
  'rejection': x=>x.red&&x.localHigh3&&x.body>=.45&&x.closeLocation<=.35&&x.rangeRatio>=.8,
  'rejection+volume': x=>x.red&&x.localHigh3&&x.body>=.45&&x.closeLocation<=.35&&x.rangeRatio>=.8&&x.volumeRatio>=1,
  'displacement': x=>x.red&&x.body>=.55&&x.closeLocation<=.25&&x.rangeRatio>=1.2,
  'local-high breakdown': x=>x.red&&x.localHigh5&&x.closeLocation<=.4&&x.rangeRatio>=1,
  'score 5/7': x=>[x.red,x.localHigh3,x.body>=.45,x.closeLocation<=.35,x.rangeRatio>=1,x.volumeRatio>=1,x.closeBelowEma10].filter(Boolean).length>=5,
  'score 6/7': x=>[x.red,x.localHigh3,x.body>=.45,x.closeLocation<=.35,x.rangeRatio>=1,x.volumeRatio>=1,x.closeBelowEma10].filter(Boolean).length>=6,
}

function metrics(source, rule) {
  const selected=source.filter(rule), tp=selected.filter(x=>x.positive), positives=source.filter(x=>x.positive)
  const returns=selected.map(x=>x.tradeReturn), byDay=new Map()
  for(const x of selected) byDay.set(x.date,(byDay.get(x.date)||0)+x.tradeReturn)
  const days=[...byDay].sort((a,b)=>a[1]-b[1])
  return { candidates:selected.length,trueOrigins:tp.length,precisionPct:round(100*tp.length/(selected.length||1)),recallPct:round(100*tp.length/(positives.length||1)),winRatePct:round(100*selected.filter(x=>x.tradeReturn>0).length/(selected.length||1)),averageReturnPct:round(returns.reduce((a,b)=>a+b,0)/(returns.length||1)),totalReturnPct:round(returns.reduce((a,b)=>a+b,0)),maximumAdverseExcursionPct:selected.length?round(Math.min(...selected.map(x=>x.mae))):null,worstDay:days.length?{date:days[0][0],returnPct:round(days[0][1])}:null}
}

const pairs=cohortPairs(), bySymbol=Map.groupBy(pairs,x=>x.symbol), all=[]
for(const [symbol,symbolPairs] of bySymbol) {
  const bars=loadBars(symbol), smc=smcBearishEvents(bars)
  for(const pair of symbolPairs) all.push(...rowsForPair(pair,bars,smc))
}
const train=all.filter(x=>x.date<=TRAIN_END), test=all.filter(x=>TEST_DATES.has(x.date))
const variants=Object.entries(rules).map(([name,rule])=>({name,train:metrics(train,rule),validation:metrics(test,rule)}))
const selected=variants.slice().sort((a,b)=>b.train.precisionPct-a.train.precisionPct||b.train.trueOrigins-a.train.trueOrigins||b.train.totalReturnPct-a.train.totalReturnPct)[0]
const report={generatedAt:new Date().toISOString(),scope:'159 EMA-10/EMA-20 cohort stock-days; five-minute causal early bearish SMC-origin prediction',trainDates:[...new Set(train.map(x=>x.date))],validationDates:[...TEST_DATES],label:'A candle later selected as a bearish internal order-block origin and confirmed within 30 minutes',entry:'Close of the next completed five-minute candle after candidate detection',exit:'Close 30 minutes after entry',selectedRule:selected.name,variants}
const output=path.join(ROOT,'reports','2026-10-05-to-2026-10-16-early-smc-sell-candidate-research-2.json')
fs.writeFileSync(output,JSON.stringify(report,null,2)+'\n')
console.log(JSON.stringify({output,rows:all.length,positiveOrigins:all.filter(x=>x.positive).length,selectedRule:selected.name,train:selected.train,validation:selected.validation},null,2))
