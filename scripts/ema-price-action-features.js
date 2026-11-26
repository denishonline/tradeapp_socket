import {MINUTE} from './research-ema-coverage.js'
import {sessionOpen} from './ema-session-flow-features.js'
const pct=(a,b)=>100*(a/b-1)

// All states are updated only when the current candle closes. A 2-left/2-right
// pivot is published at right-confirmation, never retroactively at its center.
export function priceActionSeries(rows){
  if(!rows.length)return []
  let swingHigh=null,swingLow=null,trend=0,lastBos=null,lastChoch=null,buySweep=null,sellSweep=null,buyOb=null,sellOb=null,buyGap=null,sellGap=null
  const brokenHigh=new Set(),brokenLow=new Set(),trs=[],bosRetests=[],orbTouches=new Map(),output=[]
  const open=sessionOpen(rows[0].t),ranges=new Map()
  for(const n of [5,15,30])if(rows.length>=n&&rows.slice(0,n).every((r,i)=>r.t===open+i*MINUTE))ranges.set(n,{h:Math.max(...rows.slice(0,n).map(r=>r.h)),l:Math.min(...rows.slice(0,n).map(r=>r.l))})
  for(let i=0;i<rows.length;i++){
    const r=rows[i],previous=rows[i-1]
    trs.push(Math.max(r.h-r.l,previous?Math.abs(r.h-previous.c):0,previous?Math.abs(r.l-previous.c):0))
    const atr=i>=13?trs.slice(-14).reduce((s,x)=>s+x,0)/14:NaN
    if(i>=4){const k=i-2,others=[rows[k-2],rows[k-1],rows[k+1],rows[k+2]]
      if(others.every(b=>rows[k].h>b.h))swingHigh={price:rows[k].h,index:k,confirmed:i}
      if(others.every(b=>rows[k].l<b.l))swingLow={price:rows[k].l,index:k,confirmed:i}
    }
    if(swingLow&&r.l<swingLow.price&&r.c>swingLow.price)buySweep={i,depth:swingLow.price-r.l}
    if(swingHigh&&r.h>swingHigh.price&&r.c<swingHigh.price)sellSweep={i,depth:r.h-swingHigh.price}
    let bos=0
    if(swingHigh&&!brokenHigh.has(swingHigh.index)&&r.c>swingHigh.price){brokenHigh.add(swingHigh.index);bos=1;lastBos={i,d:1,level:swingHigh.price}}
    else if(swingLow&&!brokenLow.has(swingLow.index)&&r.c<swingLow.price){brokenLow.add(swingLow.index);bos=-1;lastBos={i,d:-1,level:swingLow.price}}
    if(bos){if(trend&&bos!==trend)lastChoch={i,d:bos};trend=bos}
    const retest=lastBos&&i>lastBos.i&&r.l<=lastBos.level*1.0005&&r.h>=lastBos.level*.9995&&lastBos.d*(r.c-lastBos.level)>=0
    bosRetests.push(retest?lastBos.d:0)
    if(buyOb&&(i-buyOb.born>60||r.c<buyOb.lo))buyOb=null
    if(sellOb&&(i-sellOb.born>60||r.c>sellOb.hi))sellOb=null
    if(buyGap&&(i-buyGap.born>60||r.l<=buyGap.lo))buyGap=null
    if(sellGap&&(i-sellGap.born>60||r.h>=sellGap.hi))sellGap=null
    if(i>=5&&atr>0){
      const prior=rows.slice(i-5,i)
      if(r.c>Math.max(...prior.map(b=>b.h))&&r.c-r.o>.8*atr){const origin=prior.findLast(b=>b.c<b.o);if(origin)buyOb={lo:origin.l,hi:origin.h,born:i}}
      if(r.c<Math.min(...prior.map(b=>b.l))&&r.o-r.c>.8*atr){const origin=prior.findLast(b=>b.c>b.o);if(origin)sellOb={lo:origin.l,hi:origin.h,born:i}}
    }
    if(i>=2&&r.l>rows[i-2].h)buyGap={lo:rows[i-2].h,hi:r.l,born:i}
    if(i>=2&&r.h<rows[i-2].l)sellGap={lo:r.h,hi:rows[i-2].l,born:i}
    for(const [n,range]of ranges){
      const touches=orbTouches.get(n)||[]
      touches.push(i>=n?{long:r.l<=range.h*1.0005&&r.h>=range.h*.9995&&r.c>=range.h,short:r.h>=range.l*.9995&&r.l<=range.l*1.0005&&r.c<=range.l}:{long:false,short:false})
      orbTouches.set(n,touches)
    }
    const features=d=>{
      const f={pa_structureAligned:d*trend,pa_bosRecent5:lastBos?.d===d&&i-lastBos.i<=5?1:0,pa_chochRecent5:lastChoch?.d===d&&i-lastChoch.i<=5?1:0,
        pa_structureRetest3:lastBos?.d===d&&d*(r.c-lastBos.level)>=0&&bosRetests.slice(-3).includes(d)?1:0}
      const swing=d>0?swingHigh:swingLow,sweep=d>0?buySweep:sellSweep,ob=d>0?buyOb:sellOb,gap=d>0?buyGap:sellGap
      if(swing)f.pa_swingBreakGap=d*pct(r.c,swing.price)
      f.pa_sweepRecent3=sweep&&i-sweep.i<=3?1:0
      f.pa_sweepThenBos=sweep&&lastBos?.d===d&&lastBos.i>sweep.i&&i-sweep.i<=10?1:0
      if(sweep&&atr>0&&i-sweep.i<=10)f.pa_sweepDepthAtr=sweep.depth/atr
      for(const [name,zone]of [['orderBlock',ob],['fvg',gap]]){
        if(!zone)continue
        f[`pa_${name}Age`]=i-zone.born
        f[`pa_${name}Retest`]=i>zone.born&&r.l<=zone.hi&&r.h>=zone.lo&&d*(r.c-(zone.lo+zone.hi)/2)>=0?1:0
        if(atr>0)f[`pa_${name}DistanceAtr`]=d*(r.c-(d>0?zone.hi:zone.lo))/atr
      }
      for(const [n,range]of ranges)if(i>=n){
        f[`pa_orb${n}Gap`]=d*pct(r.c,d>0?range.h:range.l)
        f[`pa_orb${n}WidthPct`]=pct(range.h,range.l)
        f[`pa_orb${n}Retest3`]=d*(r.c-(d>0?range.h:range.l))>=0&&orbTouches.get(n).slice(-3).some(b=>d>0?b.long:b.short)?1:0
      }
      return Object.fromEntries(Object.entries(f).filter(([,v])=>Number.isFinite(v)))
    }
    output.push({long:features(1),short:features(-1)})
  }
  return output
}
