import fs from 'node:fs'
import path from 'node:path'

// Transcript indicator, evaluated only on the fixed 159-leg research cohort.
const root = process.cwd()
const source = path.join(root, 'reports', '2026-10-05-to-2026-10-16-ema10-ema20-over-1p5-trend-legs.csv')
const dates = new Set(['2026-10-05','2026-10-06','2026-10-07','2026-10-08','2026-10-09','2026-10-12','2026-10-13','2026-10-14','2026-10-15','2026-10-16','2026-10-19'])
const offset = 330 * 60_000
const round = (n, p = 3) => Number.isFinite(n) ? Number(n.toFixed(p)) : null
const stamp = ms => new Date(ms + offset).toISOString().slice(0,16).replace('T',' ')
const minute = ms => stamp(ms).slice(11)
const day = ms => stamp(ms).slice(0,10)
const pct = (a,b) => 100 * (a / b - 1)
const legs = fs.readFileSync(source,'utf8').trim().split(/\r?\n/).slice(1).map(line => {
  const [date,symbol,side,crossoverTime,entryTime,entryPrice,oppositeCrossoverTime,exitTime,exitPrice] = line.split(',')
  return {date,symbol,side,crossoverTime,entryTime,entryPrice:Number(entryPrice),oppositeCrossoverTime,exitTime,exitPrice:Number(exitPrice)}
})
if (legs.length !== 159 || legs.filter(x => x.side === 'BUY').length !== 84) throw new Error('Research cohort changed')
const at = (date,time) => Date.parse(`${date}T${time}:00+05:30`)
function candles(symbol) {
  const file = path.join(root,'db','candles',`${symbol}.jsonl`)
  const rows = fs.readFileSync(file,'utf8').split(/\r?\n/).filter(Boolean).map(x => JSON.parse(x)).map(x => ({...x,ms:Number(x.time)*1000}))
    .filter(x => dates.has(day(x.ms)) && x.ms % 60_000 === 0 && Number.isFinite(x.close) && Number.isFinite(x.volume))
    .sort((a,b) => a.ms-b.ms)
  return rows.filter((x,i) => !i || x.ms !== rows[i-1].ms)
}
function aggregate(rows, interval) {
  const out = []
  for (const x of rows) {
    const local = new Date(x.ms + offset)
    const m = local.getUTCHours()*60+local.getUTCMinutes()
    if (m < 555 || m >= 930) continue
    const bucket = Math.floor((m-555)/interval)
    const key = `${day(x.ms)}|${bucket}`
    let bar = out.at(-1)
    if (bar?.key !== key) { bar={key,ms:x.ms,open:x.open,high:x.high,low:x.low,close:x.close,count:0,last:x.ms}; out.push(bar) }
    bar.high=Math.max(bar.high,x.high); bar.low=Math.min(bar.low,x.low); bar.close=x.close; bar.count++; bar.last=x.ms
  }
  return out.filter(x => x.count === interval && minute(x.last) < '15:30').map(x => ({...x,complete:x.last+60_000}))
}
function indicator(bars) {
  let gain=0,loss=0,previous=null,ema=null
  const rsi=[]
  return bars.map((b,i) => {
    const change=previous==null?0:b.close-previous
    previous=b.close
    if (i<=9) { gain+=Math.max(change,0); loss+=Math.max(-change,0) }
    if (i===9) { gain/=9; loss/=9 }
    else if (i>9) { gain=(gain*8+Math.max(change,0))/9; loss=(loss*8+Math.max(-change,0))/9 }
    const value=i<9?null:loss===0?(gain===0?50:100):100-100/(1+gain/loss)
    if (value!==null) { rsi.push(value); ema=ema==null?value:(value+ema)/2 }
    const wma=rsi.length<21?null:rsi.slice(-21).reduce((s,v,j)=>s+v*(j+1),0)/231
    return {...b,rsi:value,ema,wma,ready:wma!==null}
  })
}
function upward50Events(bars) {
  let lastEvent = null
  return bars.map((b,i) => {
    const p=bars[i-1]
    if (!b.ready || !p?.ready) return {...b,event:null}
    if (day(b.complete)!==day(p.complete)) lastEvent=null
    const rising=b.rsi>p.rsi && b.ema>p.ema && b.wma>p.wma
    const above50=b.rsi>50 && b.ema>50 && b.wma>50
    // The event is when all three rising lines have cleared 50, with at least
    // one still at/below 50 on the preceding completed bar.
    if (rising && above50 && (p.rsi<=50 || p.ema<=50 || p.wma<=50)) lastEvent={crossTime:b.complete}
    if (!above50) lastEvent=null
    return {...b,event:lastEvent}
  })
}
function status(bars, t, interval) {
  let lo=0,hi=bars.length
  while (lo<hi) { const mid=(lo+hi)>>1; if (bars[mid].complete<=t) lo=mid+1; else hi=mid }
  const i=lo-1, b=bars[i], p=bars[i-1]
  if (!b?.ready || !p?.ready) return null
  const age=b.event ? t-b.event.crossTime : Infinity
  const bullish=b.event && day(b.event.crossTime)===day(t) &&
    b.rsi>50 && b.ema>50 && b.wma>50 && b.rsi>p.rsi && b.ema>p.ema && b.wma>p.wma
  return {b,bullish,age}
}
const bySymbol = new Map()
for (const symbol of new Set(legs.map(x=>x.symbol))) {
  const one=candles(symbol)
  bySymbol.set(symbol,{one,series:Object.fromEntries([1,5,15].map(n=>[n,upward50Events(indicator(aggregate(one,n)))]))})
}
const signals=[]
for (const leg of legs) {
  const {one,series}=bySymbol.get(leg.symbol)
  const start=at(leg.date,leg.crossoverTime), end=at(leg.date,leg.oppositeCrossoverTime)
  for (const bar of one) {
    const t=bar.ms+60_000
    if (t<=start || t>=end) continue
    const s=[1,5,15].map(n=>status(series[n],t,n))
    if (s.some(x=>!x?.bullish)) continue
    const next=one.find(x=>x.ms===t)
    if (!next || next.ms+60_000>=end) continue
    const entry=next.close, entryTime=next.ms+60_000
    // Fixed, auditable exit: final completed 1m candle before the cohort leg ends.
    const path=one.filter(x=>x.ms>=next.ms && x.ms+60_000<=end)
    if (!path.length) continue
    const exit=path.at(-1)
    signals.push({date:leg.date,symbol:leg.symbol,cohortLegSide:leg.side,signalTime:minute(t),entryTime:minute(entryTime),exitTime:minute(exit.ms+60_000),
      frames:Object.fromEntries([1,5,15].map((n,j)=>[`${n}m`,{crossTime:stamp(s[j].b.event.crossTime),rsi:round(s[j].b.rsi),ema3:round(s[j].b.ema),wma21:round(s[j].b.wma)}])),
      entry:round(entry),exit:round(exit.close),returnPct:round(pct(exit.close,entry)),maxAdversePct:round(pct(Math.min(...path.map(x=>x.low)),entry))})
    break
  }
}
signals.sort((a,b)=>a.date.localeCompare(b.date) || a.signalTime.localeCompare(b.signalTime) || a.symbol.localeCompare(b.symbol))
const byDate=Object.groupBy(signals,x=>x.date)
const worstDay=Object.entries(byDate).map(([date,x])=>({date,totalReturnPct:round(x.reduce((s,r)=>s+r.returnPct,0))})).sort((a,b)=>a.totalReturnPct-b.totalReturnPct)[0]||null
const summary={cohortLegs:legs.length,buyLegs:84,sellLegs:75,tradeCount:signals.length,winRatePct:signals.length?round(100*signals.filter(x=>x.returnPct>0).length/signals.length):null,
  averageReturnPct:signals.length?round(signals.reduce((s,x)=>s+x.returnPct,0)/signals.length):null,totalReturnPct:round(signals.reduce((s,x)=>s+x.returnPct,0)),
  maximumAdverseExcursionPct:signals.length?round(Math.min(...signals.map(x=>x.maxAdversePct))):null,worstDay}
const output={method:'First aligned upward-50 event per leg in the fixed 159-leg cohort. On each of completed 1m, 5m, and 15m bars, RSI9 Wilder, EMA3(RSI), and WMA21(RSI) are all rising and above 50 after the three lines first cleared 50 on the same IST session. All frames must currently be rising above 50; crosses need not be simultaneous. WMA21 is time weighted, not traded volume weighted. Entry at next completed 1m close; exit at final completed 1m close before cohort leg end. Gross retrospective returns; cohort and exit depend on future trend outcomes.',summary,signals}
let suffix=0,file
do { file=path.join(root,'reports',`hilega-milega-upward-50-three-timeframes-159-legs${suffix?`-${suffix+1}`:''}.json`);suffix++ } while(fs.existsSync(file))
fs.writeFileSync(file,JSON.stringify(output,null,2)+'\n',{flag:'wx'})
console.log(JSON.stringify({file,summary,matches:signals.map(({date,symbol,signalTime,frames,returnPct})=>({date,symbol,signalTime,crossTimes:Object.fromEntries(Object.entries(frames).map(([n,x])=>[n,x.crossTime.slice(11)])),returnPct}))},null,2))
