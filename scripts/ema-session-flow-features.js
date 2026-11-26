import {MINUTE} from './research-ema-coverage.js'

const STEP=.0005
const pct=(a,b)=>100*(a/b-1)
const avg=xs=>xs.reduce((s,x)=>s+x,0)/xs.length
export const sessionOpen=t=>Date.parse(`${new Date(t+330*MINUTE).toISOString().slice(0,10)}T09:15:00+05:30`)

// Deliberate candle approximation, NOT exchange volume-at-price. Fixed log bins
// are anchored to the known session open, never the final session high/low.
export function profileSummary(bins,anchor){
  const keys=[...bins.keys()].sort((a,b)=>a-b)
  if(!keys.length)return null
  let poc=keys[0],total=0
  for(const k of keys){const v=bins.get(k);total+=v;if(v>bins.get(poc))poc=k}
  if(total<=0)return null
  let low=poc,high=poc,covered=bins.get(poc),min=keys[0],max=keys.at(-1)
  while(covered<.7*total&&(low>min||high<max)){
    const left=low>min?(bins.get(low-1)||0):-1,right=high<max?(bins.get(high+1)||0):-1
    if(right>left){high++;covered+=Math.max(0,right)}else{low--;covered+=Math.max(0,left)}
  }
  return {poc:anchor*Math.exp((poc+.5)*STEP),val:anchor*Math.exp(low*STEP),vah:anchor*Math.exp((high+1)*STEP),pocVolume:bins.get(poc),total,covered}
}

export function sessionFlowSeries(rows,previousSessions=[]){
  if(!rows.length)return []
  const anchor=rows[0].o,start=sessionOpen(rows[0].t)
  const histories=previousSessions.filter(rs=>rs.length&&rs.at(-1).t<rows[0].t).map(rs=>{
    let total=0,count=0;const slots=new Map()
    for(const r of rs){total+=r.v;count++;slots.set((r.t-sessionOpen(rs[0].t))/MINUTE,{...r,cumulative:total,count})}
    return slots
  })
  let volume=0,pv=0,pv2=0,cvd=0
  const bins=new Map(),past=[],output=[]
  for(let i=0;i<rows.length;i++){
    const r=rows[i],tp=(r.h+r.l+r.c)/3,previous=past.at(-1)
    volume+=r.v;pv+=r.v*tp;pv2+=r.v*tp*tp
    const vwap=volume>0?pv/volume:NaN,std=volume>0?Math.sqrt(Math.max(0,pv2/volume-vwap*vwap)):NaN
    const signed=r.v*Math.sign(r.c-r.o),clv=r.h>r.l?(2*r.c-r.h-r.l)/(r.h-r.l):0
    cvd+=signed
    const from=Math.floor(Math.log(r.l/anchor)/STEP),to=Math.floor(Math.log(r.h/anchor)/STEP),share=r.v/(to-from+1)
    if(r.v>0)for(let b=from;b<=to;b++)bins.set(b,(bins.get(b)||0)+share)
    const profile=profileSummary(bins,anchor),slot=(r.t-start)/MINUTE
    const state={r,vwap,profile,cvd,clv,signed,buyTouch:Number.isFinite(vwap)&&r.l<=vwap*1.0005&&r.h>=vwap*.9995&&r.c>=vwap,
      sellTouch:Number.isFinite(vwap)&&r.h>=vwap*.9995&&r.l<=vwap*1.0005&&r.c<=vwap,
      buyProfileTouch:previous?.profile&&r.l<=previous.profile.vah*1.0005&&r.h>=previous.profile.vah*.9995&&r.c>=previous.profile.vah,
      sellProfileTouch:previous?.profile&&r.h>=previous.profile.val*.9995&&r.l<=previous.profile.val*1.0005&&r.c<=previous.profile.val}
    past.push(state)
    const common={}
    for(const n of [1,3,5]){
      if(i+1<n||rows[i-n+1].t!==r.t-(n-1)*MINUTE)continue
      const current=rows.slice(i-n+1,i+1).reduce((s,b)=>s+b.v,0),prior=[]
      for(const h of histories){const bs=Array.from({length:n},(_,j)=>h.get(slot-j));if(bs.every(Boolean))prior.push(bs.reduce((s,b)=>s+b.v,0))}
      if(prior.length>=2&&avg(prior)>0)common[`adv_rvolTime${n}`]=current/avg(prior)
    }
    const cumulativePrior=histories.map(h=>h.get(slot)).filter(b=>b&&b.count===slot+1).map(b=>b.cumulative)
    if(i+1===slot+1&&cumulativePrior.length>=2&&avg(cumulativePrior)>0)common.adv_cumulativeRvolTime=volume/avg(cumulativePrior)
    if(profile&&i+1===slot+1){common.adv_profileWidthPct=pct(profile.vah,profile.val);common.adv_profileLocalVolumeRatio=(bins.get(Math.floor(Math.log(r.c/anchor)/STEP))||0)/profile.pocVolume}
    const completePrefix=i+1===slot+1
    const feature=d=>{
      const f={...common},tail=n=>past.slice(-n)
      if(completePrefix&&Number.isFinite(vwap)){
        f.adv_vwapGap=d*pct(r.c,vwap)
        if(std>0)f.adv_vwapZ=d*(r.c-vwap)/std
        if(i>=3&&Number.isFinite(past[i-3].vwap))f.adv_vwapSlope3=d*pct(vwap,past[i-3].vwap)
        if(i>=2){f.adv_vwapHold3=tail(3).filter(b=>d*(b.r.c-b.vwap)>=0).length/3;f.adv_vwapRetest3=d*(r.c-vwap)>=0&&tail(3).some(b=>d>0?b.buyTouch:b.sellTouch)?1:0}
      }
      if(completePrefix&&volume>0)f.adv_candleCvdProxyPct=d*100*cvd/volume
      if(i>=3&&rows[i-3].t===r.t-3*MINUTE){
        const rs=tail(3),v=rs.reduce((s,b)=>s+b.r.v,0),flow=cvd-past[i-3].cvd,price=d*pct(r.c,past[i-3].r.c)
        if(v>0){f.adv_candleCvdSlope3=d*100*flow/v;f.adv_candleDeltaProxy3=d*rs.reduce((s,b)=>s+b.clv*b.r.v,0)/v;f.adv_candleCvdConfirm3=price>0&&d*flow>0?1:0}
      }
      if(completePrefix&&profile){
        f.adv_profilePocGap=d*pct(r.c,profile.poc)
        if(previous?.profile){const boundary=d>0?previous.profile.vah:previous.profile.val;f.adv_profileBreakout=d*pct(r.c,boundary)
          if(i>=2)f.adv_profileRetest3=d*(r.c-boundary)>=0&&tail(3).some(b=>d>0?b.buyProfileTouch:b.sellProfileTouch)?1:0}
        if(i>=5&&past[i-5].profile)f.adv_profilePocDrift5=d*pct(profile.poc,past[i-5].profile.poc)
      }
      return Object.fromEntries(Object.entries(f).filter(([,v])=>Number.isFinite(v)))
    }
    output.push({long:feature(1),short:feature(-1)})
  }
  return output
}

export function sessionFlowMap(sessions){
  const output=new Map(),history=[]
  for(const [date,rows]of [...sessions].sort(([a],[b])=>a.localeCompare(b))){output.set(date,sessionFlowSeries(rows,history));history.push(rows)}
  return output
}
