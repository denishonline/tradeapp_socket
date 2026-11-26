import fs from 'node:fs'
import path from 'node:path'

const root=process.cwd(), offset=330*60_000
const direction=process.argv.includes('--down')?'down':'up'
const now=Date.now(), today=new Date(now+offset).toISOString().slice(0,10)
const cutoff=Math.floor(now/60_000)*60_000
const allowed=new Set(['2026-10-05','2026-10-06','2026-10-07','2026-10-08','2026-10-09','2026-10-12','2026-10-13','2026-10-14','2026-10-15','2026-10-16','2026-10-19',today])
const stamp=ms=>new Date(ms+offset).toISOString().slice(0,16).replace('T',' ')
const day=ms=>stamp(ms).slice(0,10)
const round=x=>Number(x.toFixed(2))
function load(symbol) {
  const file=path.join(root,'db','candles',`${symbol}.jsonl`)
  if (!fs.existsSync(file)) return []
  const byTime=new Map()
  for (const line of fs.readFileSync(file,'utf8').split(/\r?\n/)) {
    if (!line) continue
    const x=JSON.parse(line),ms=Number(x.time)*1000
    if (allowed.has(day(ms)) && ms+60_000<=cutoff && Number.isFinite(Number(x.close))) byTime.set(ms,{ms,open:Number(x.open),high:Number(x.high),low:Number(x.low),close:Number(x.close)})
  }
  return [...byTime.values()].sort((a,b)=>a.ms-b.ms)
}
function aggregate(rows,n) {
  const out=[]
  for (const x of rows) {
    const local=new Date(x.ms+offset),m=local.getUTCHours()*60+local.getUTCMinutes()
    if (m<555 || m>=930) continue
    const key=`${day(x.ms)}|${Math.floor((m-555)/n)}`
    let b=out.at(-1)
    if (b?.key!==key) {b={key,count:0,last:x.ms,close:x.close};out.push(b)}
    b.count++;b.last=x.ms;b.close=x.close
  }
  return out.filter(x=>x.count===n).map(x=>({...x,complete:x.last+60_000}))
}
function indicator(bars) {
  let previous=null,gain=0,loss=0,ema=null
  const values=[]
  return bars.map((b,i)=>{
    const change=previous==null?0:b.close-previous;previous=b.close
    if (i<=9) {gain+=Math.max(change,0);loss+=Math.max(-change,0)}
    if (i===9) {gain/=9;loss/=9}
    else if (i>9) {gain=(8*gain+Math.max(change,0))/9;loss=(8*loss+Math.max(-change,0))/9}
    const rsi=i<9?null:loss===0?(gain===0?50:100):100-100/(1+gain/loss)
    if (rsi!=null) {values.push(rsi);ema=ema==null?rsi:(rsi+ema)/2}
    const wma=values.length<21?null:values.slice(-21).reduce((s,v,j)=>s+v*(j+1),0)/231
    return {...b,rsi,ema,wma}
  })
}
function states(bars) {
  let turn=null,base=null
  return bars.map((b,i)=>{
    const p=bars[i-1],q=bars[i-2]
    if (!p || !q || b.wma==null || p.wma==null || q.wma==null) return {...b,active:false,turn:null}
    if (day(b.complete)!==day(p.complete)) {turn=null;base=null}
    const moving=direction==='down'
      ? b.rsi<p.rsi && b.ema<p.ema && b.wma<p.wma
      : b.rsi>p.rsi && b.ema>p.ema && b.wma>p.wma
    const recentOpposite=['rsi','ema','wma'].every(key=>{
      for(let j=Math.max(1,i-5);j<i;j++)
        if(bars[j-1]?.wma!=null && day(bars[j].complete)===today &&
          (direction==='down'?bars[j][key]>bars[j-1][key]:bars[j][key]<bars[j-1][key])) return true
      return false
    })
    if (moving && recentOpposite && !turn) {turn=b.complete;base={rsi:p.rsi,ema:p.ema,wma:p.wma}}
    if (turn && ['rsi','ema','wma'].some(key=>direction==='down'?b[key]>=base[key]:b[key]<=base[key])) {turn=null;base=null}
    return {...b,active:!!turn && day(turn)===today && moving,turn}
  })
}
function latestAt(bars,t) {
  let lo=0,hi=bars.length
  while(lo<hi){const mid=(lo+hi)>>1;if(bars[mid].complete<=t)lo=mid+1;else hi=mid}
  return bars[lo-1]
}
const symbols=JSON.parse(fs.readFileSync(path.join(root,'db','stocks'),'utf8'))
const matches=[],alignedNow=[],coverage=[],frameCounts={"1m":0,"5m":0,"15m":0}
for(const symbol of symbols) {
  const rows=load(symbol),todayRows=rows.filter(x=>day(x.ms)===today)
  if(!todayRows.length) continue
  const series=Object.fromEntries([1,5,15].map(n=>[n,states(indicator(aggregate(rows,n)))]))
  const last=rows.at(-1).ms+60_000
  coverage.push(last)
  const current=[1,5,15].map(n=>latestAt(series[n],last))
  for(const [j,n] of [1,5,15].entries()) if(series[n].some(x=>day(x.complete)===today && x.active)) frameCounts[`${n}m`]++
  if(current.every(x=>x?.active)) alignedNow.push({symbol,lastCompleted:stamp(last),frames:Object.fromEntries([1,5,15].map((n,j)=>[`${n}m`,{rsi:round(current[j].rsi),ema3:round(current[j].ema),wma21:round(current[j].wma),turnTime:stamp(current[j].turn)}]))})
  let first=null
  for(const b of series[1]) {
    if(day(b.complete)!==today || b.complete>last) continue
    const a=[1,5,15].map(n=>latestAt(series[n],b.complete))
    if(a.every(x=>x?.active)) {first={at:b.complete,frames:Object.fromEntries([1,5,15].map((n,j)=>[`${n}m`,{turnTime:stamp(a[j].turn),rsi:round(a[j].rsi),ema3:round(a[j].ema),wma21:round(a[j].wma)}]))};break}
  }
  if(first)matches.push({symbol,firstAligned:stamp(first.at),lastCompleted:stamp(last),activeAtLastCompleted:current.every(x=>x?.active),framesAtFirstAlignment:first.frames})
}
matches.sort((a,b)=>a.firstAligned.localeCompare(b.firstAligned)||a.symbol.localeCompare(b.symbol))
const report={date:today,direction,checkedAt:stamp(now),lastCandleCompletion:coverage.length?stamp(Math.max(...coverage)):null,stocksWithTodayCandles:coverage.length,frameCounts,matchCount:matches.length,alignedNowCount:alignedNow.length,method:`All listed db/stocks. RSI9 Wilder, EMA3(RSI), WMA21(RSI) on completed 1m/5m/15m candles. A timeframe turns ${direction} today when each of the three lines has moved ${direction==='down'?'up':'down'} within the preceding five completed bars and all three then move ${direction} together. They must remain ${direction==='down'?'below':'above'} their pre-turn values. Match requires active turns on all three timeframes at the same completed minute today. No 50-level condition. Only candles complete by scan time are used.`,matches,alignedNow}
let i=0,file
do {file=path.join(root,'reports',`${today}-three-timeframe-${direction==='down'?'top-fall':'bottom-rise'}${i?`-${i+1}`:''}.json`);i++}while(fs.existsSync(file))
fs.writeFileSync(file,JSON.stringify(report,null,2)+'\n',{flag:'wx'})
console.log(JSON.stringify({file,date:today,checkedAt:report.checkedAt,lastCandleCompletion:report.lastCandleCompletion,stocksWithTodayCandles:coverage.length,frameCounts,matchCount:matches.length,alignedNowCount:alignedNow.length,matches:matches.map(x=>({symbol:x.symbol,firstAligned:x.firstAligned,activeAtLastCompleted:x.activeAtLastCompleted,turnTimes:Object.fromEntries(Object.entries(x.framesAtFirstAlignment).map(([n,f])=>[n,f.turnTime]))})),alignedNow:alignedNow.map(x=>x.symbol)},null,2))
