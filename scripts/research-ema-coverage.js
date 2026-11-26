import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'
import assert from 'node:assert/strict'
import {Worker,workerData,parentPort} from 'node:worker_threads'

const ROOT = process.cwd(), MINUTE = 60000, IST = 330 * MINUTE
const DATES = ['2026-10-05','2026-10-06','2026-10-07','2026-10-08','2026-10-09','2026-10-12','2026-10-13','2026-10-14','2026-10-15','2026-10-16']
const REPORTS = path.join(ROOT, 'reports')
const STEM = '2026-10-05-to-2026-10-16-ema-coverage-audit'
const CANDLE_CACHE = path.join(REPORTS, `${STEM}-candles.json`)
const DEPTH_CACHE = path.join(REPORTS, `${STEM}-depth.json`)
const COHORT = path.join(REPORTS, '2026-10-05-to-2026-10-16-ema10-ema20-over-1p5-trend-legs.csv')
const day = (t) => new Date(t + IST).toISOString().slice(0,10)
const clock = (t) => new Date(t + IST).toISOString().slice(11,16)
const round = (x, p=4) => Number.isFinite(x) ? +x.toFixed(p) : null
const avg = (xs) => xs.length ? xs.reduce((a,b)=>a+b,0)/xs.length : NaN
const pct = (a,b) => b > 0 ? 100*(a/b-1) : NaN
const rowKey = (r) => `${r.date}|${r.symbol}|${r.side}|${r.entryTime}`

function csvRead(file) {
  const [head,...lines]=fs.readFileSync(file,'utf8').trim().split(/\r?\n/), names=head.split(',')
  return lines.map(l=>Object.fromEntries(l.split(',').map((v,i)=>[names[i],v])))
}
function save(file, value) { fs.writeFileSync(file, JSON.stringify(value)+'\n', {flag:'wx'}) }
function uniqueFile(suffix) {
  let i=1, file;const parsed=path.parse(suffix)
  do { file=path.join(REPORTS,`${STEM}-${parsed.name}${i===1?'':`-${i}`}${parsed.ext}`); i++ } while(fs.existsSync(file))
  return file
}
function writeCsv(file, rows) {
  const fields=[...new Set(rows.flatMap(Object.keys))]
  const value=v=>{ const s=v==null?'':String(v); return /[",\n]/.test(s)?`"${s.replaceAll('"','""')}"`:s }
  fs.writeFileSync(file,[fields.join(','),...rows.map(r=>fields.map(f=>value(r[f])).join(','))].join('\n')+'\n',{flag:'wx'})
}
function loadCandles(symbol) {
  const file=path.join(ROOT,'db','candles',`${symbol}.jsonl`), groups=new Map()
  if(!fs.existsSync(file)) return groups
  for(const line of fs.readFileSync(file,'utf8').split(/\r?\n/)) {
    if(!line.trim()) continue
    try {
      const raw=JSON.parse(line), t=+raw.time*1000
      if(!Number.isFinite(t)||!DATES.includes(day(t))) continue
      const local=new Date(t+IST), m=local.getUTCHours()*60+local.getUTCMinutes()
      const r={t,o:+raw.open,h:+raw.high,l:+raw.low,c:+raw.close,v:+raw.volume}
      if(m<555||m>=930||t%MINUTE||!Object.values(r).every(Number.isFinite)||r.l<=0||r.v<0||r.h<Math.max(r.o,r.c)||r.l>Math.min(r.o,r.c)) continue
      const d=day(t); if(!groups.has(d)) groups.set(d,new Map())
      if(!groups.get(d).has(t)) groups.get(d).set(t,r)
    } catch {}
  }
  return new Map([...groups].map(([d,rs])=>[d,[...rs.values()].sort((a,b)=>a.t-b.t)]))
}
function emaSeries(values,n) {
  let e=NaN; const a=2/(n+1)
  return values.map((x)=>{e=Number.isFinite(e)?a*x+(1-a)*e:x;return e})
}
function wilderRsi(values,n) {
  let gain=0,loss=0; const out=values.map(()=>NaN)
  for(let i=1;i<values.length;i++) {
    const delta=values[i]-values[i-1], g=Math.max(delta,0), l=Math.max(-delta,0)
    if(i<=n){gain+=g;loss+=l;if(i===n){gain/=n;loss/=n}}
    else {gain=(gain*(n-1)+g)/n;loss=(loss*(n-1)+l)/n}
    if(i>=n)out[i]=loss?100-100/(1+gain/loss):gain?100:50
  }
  return out
}
function trend(values) {
  if(values.length<3)return [NaN,NaN]
  const ys=values.map(Math.log), x=(ys.length-1)/2,y=avg(ys)
  let cov=0,xx=0,yy=0
  ys.forEach((v,i)=>{cov+=(i-x)*(v-y);xx+=(i-x)**2;yy+=(v-y)**2})
  return [100*cov/xx,yy?cov*cov/xx/yy:0]
}
function indicators(rows) {
  const close=rows.map(r=>r.c), es=Object.fromEntries([5,10,20,26,50].map(n=>[n,emaSeries(close,n)]))
  const rsi=Object.fromEntries([5,7,14,21].map(n=>[n,wilderRsi(close,n)]))
  const macds=[[5,13,4],[8,21,5],[12,26,9]].map(([f,s,g])=>{
    const fast=emaSeries(close,f),slow=emaSeries(close,s),line=fast.map((v,i)=>v-slow[i]), signal=emaSeries(line,g)
    return {name:`macd${f}_${s}_${g}`,line,hist:line.map((v,i)=>v-signal[i]),warmup:s+g}
  })
  let volume=0,pv=0,previousSign=0
  return rows.map((r,i)=>{
    const f={}, hist=rows.slice(0,i+1), tail=n=>hist.slice(-n), tp=x=>(x.h+x.l+x.c)/3
    volume+=r.v;pv+=r.v*tp(r)
    for(const n of [1,3,5,10,15,20,30,60]) if(i+1>=n) f[`ret${n}`]=pct(r.c,rows[i-n+1].o)
    f.openReturn=pct(r.c,rows[0].o)
    f.vwapGap=volume?pct(r.c,pv/volume):NaN
    for(const n of [5,7,14,21])f[`rsi${n}`]=rsi[n][i]-50
    for(const n of [7,14,21]) {
      let pos=0,neg=0
      if(i>=n)for(let j=i-n+1;j<=i;j++){const flow=tp(rows[j])*rows[j].v; if(tp(rows[j])>tp(rows[j-1]))pos+=flow;else if(tp(rows[j])<tp(rows[j-1]))neg+=flow}
      f[`mfi${n}`]=i>=n?(neg?100-100/(1+pos/neg):pos?100:50)-50:NaN
    }
    for(const n of [5,10,20,50])f[`priceEma${n}`]=pct(r.c,es[n][i])
    f.emaGap=10000*(es[10][i]-es[20][i])/r.c
    f.emaExpansion=i?10000*((es[10][i]-es[20][i])-(es[10][i-1]-es[20][i-1]))/r.c:NaN
    for(const n of [3,5,10,20]) {
      const rs=tail(n),[slope,r2]=trend(rs.map(x=>x.c))
      f[`slope${n}`]=slope; f[`fit${n}`]=r2
      f[`angle${n}`]=Math.atan(slope)*180/Math.PI
      const lengths=rs.map(x=>x.h-x.l); f[`range${n}`]=100*(Math.max(...rs.map(x=>x.h))-Math.min(...rs.map(x=>x.l)))/r.c
      const prior=rows.slice(Math.max(0,i-n),i), av=avg(prior.map(x=>x.v))
      f[`volRatio${n}`]=av>0?r.v/av:NaN
      f[`meanRange${n}`]=100*avg(lengths)/r.c
    }
    for(const n of [7,14,21]) {
      const rs=tail(n), trs=rs.map(x=>{const at=rows.indexOf(x),p=at?rows[at-1].c:x.o;return Math.max(x.h-x.l,Math.abs(x.h-p),Math.abs(x.l-p))})
      f[`atr${n}`]=100*avg(trs)/r.c
    }
    for(const n of [10,20,50]) {
      const prior=rows.slice(Math.max(0,i-n),i)
      f[`resistance${n}`]=prior.length?pct(r.c,Math.max(...prior.map(x=>x.h))):NaN
      f[`support${n}`]=prior.length?pct(r.c,Math.min(...prior.map(x=>x.l))):NaN
    }
    f.closeLocation=r.h>r.l?100*(r.c-r.l)/(r.h-r.l)-50:0
    f.bodyPct=pct(r.c,r.o)
    for(const m of macds){f[m.name]=i>=m.warmup?10000*m.line[i]/r.c:NaN;f[`${m.name}Hist`]=i>=m.warmup?10000*m.hist[i]/r.c:NaN}
    const sign=Math.sign(es[10][i]-es[20][i]),cross=i>=19&&previousSign&&sign&&sign!==previousSign
    if(i>=19&&sign)previousSign=sign
    return {...r,f,sign,cross}
  })
}
function aggregate(rows,n) {
  const start=Date.parse(`${day(rows[0].t)}T09:15:00+05:30`), bars=[]
  for(const r of rows){const t=start+Math.floor((r.t-start)/(n*MINUTE))*n*MINUTE;let b=bars.at(-1)
    if(!b||b.t!==t){b={t,o:r.o,h:r.h,l:r.l,c:r.c,v:r.v,count:1};bars.push(b)}else{b.h=Math.max(b.h,r.h);b.l=Math.min(b.l,r.l);b.c=r.c;b.v+=r.v;b.count++}}
  return indicators(bars.filter(b=>b.count===n))
}
const undirected=(name)=>/^(atr|fit|volRatio|range|meanRange)/.test(name)
function normalize(features,d,prefix='') {
  const out={}
  for(const [k,v] of Object.entries(features))out[prefix+k]=Number.isFinite(v)?(undirected(k)?v:d*v):NaN
  // Resistance and support must switch roles for shorts.
  for(const n of [10,20,50]){
    out[`${prefix}breakout${n}`]=d>0?features[`resistance${n}`]:-features[`support${n}`]
    delete out[`${prefix}resistance${n}`];delete out[`${prefix}support${n}`]
  }
  return out
}
function timeframeFeatures(frames,t,d,prefix='') {
  const result={}
  for(const [n,bars] of frames) {
    const complete=bars.filter(b=>b.t+n*MINUTE<=t),last=complete.at(-1)
    if(!last)continue
    for(const name of ['ret1','ret3','rsi7','rsi14','mfi7','vwapGap','slope5','atr14','priceEma10']){
      const v=last.f[name]; result[`${prefix}tf${n}_${name}`]=Number.isFinite(v)?(undirected(name)?v:d*v):NaN
    }
  }
  return result
}
function buildCandles(){
  const cohortKeys=new Set(csvRead(COHORT).map(rowKey))
  const symbols=[...new Set(JSON.parse(fs.readFileSync(path.join(ROOT,'db','stocks'),'utf8')).map(x=>String(x).trim().toUpperCase().replace(/-EQ$/,'')))]
  const nifty=loadCandles('NIFTY50'), niftySeries=new Map(), niftyFrames=new Map(), events=[],breadth=new Map()
  for(const [d,rs] of nifty){niftySeries.set(d,new Map(indicators(rs).map(r=>[r.t,r])));niftyFrames.set(d,new Map([3,5,10,15].map(n=>[n,aggregate(rs,n)])))}
  for(const [si,symbol] of symbols.entries()){
    for(const [date,raw] of loadCandles(symbol)) {
      const rows=indicators(raw),frames=new Map([3,5,10,15].map(n=>[n,aggregate(raw,n)])),crosses=rows.map((r,i)=>({r,i})).filter(x=>x.r.cross)
      for(const r of rows){if(!breadth.has(r.t))breadth.set(r.t,{n:0,up:0,ret5:0});const b=breadth.get(r.t);b.n++;b.up+=r.sign>0?1:0;b.ret5+=Number.isFinite(r.f.ret5)?r.f.ret5:0}
      for(let ci=0;ci<crosses.length;ci++) {
        const cross=crosses[ci],next=crosses[ci+1],entry=rows[cross.i+1]
        if(!entry||entry.t!==cross.r.t+MINUTE)continue
        const exit=next?rows[next.i+1]:null,end=next?next.i+1:rows.length-1
        if(next&&!exit)continue
        let contiguous=true
        for(let j=cross.i+2;j<=end;j++)if(rows[j].t!==rows[j-1].t+MINUTE)contiguous=false
        if(!contiguous)continue
        const d=cross.r.sign,side=d>0?'BUY':'SELL',exitPrice=exit?exit.o:rows.at(-1).c
        const pathRows=rows.slice(cross.i+1,next?next.i+1:rows.length),hi=Math.max(...pathRows.map(r=>r.h)),lo=Math.min(...pathRows.map(r=>r.l))
        const features={...normalize(cross.r.f,d),...timeframeFeatures(frames,entry.t,d)}
        const nr=niftySeries.get(date)?.get(cross.r.t)
        if(nr){Object.assign(features,normalize(nr.f,d,'nifty_'),timeframeFeatures(niftyFrames.get(date),entry.t,d,'nifty_'));features.relativeRet5=features.ret5-features.nifty_ret5}
        const row={date,symbol,side,entryTime:clock(entry.t),signalAt:entry.t,exitTime:exit?clock(exit.t):'15:30',exitReason:exit?'OPPOSITE_CROSS':'EOD_MARK',entryPrice:entry.o,exitPrice,
          returnPct:d*100*(exitPrice-entry.o)/entry.o,legacyReturnPct:d>0?pct(exitPrice,entry.o):pct(entry.o,exitPrice),
          maePct:Math.min(0,d>0?pct(lo,entry.o):-pct(hi,entry.o)),mfePct:Math.max(0,d>0?pct(hi,entry.o):-pct(lo,entry.o)),features}
        row.cohort=cohortKeys.has(rowKey(row));events.push(row)
      }
    }
    if(si%50===0)console.log(`Candles ${si+1}/${symbols.length}; entries ${events.length}`)
  }
  for(const e of events){const b=breadth.get(e.signalAt-MINUTE),d=e.side==='BUY'?1:-1;if(b){e.features.marketBreadth=d*(100*b.up/b.n-50);e.features.marketRet5=d*b.ret5/b.n}}
  const found=new Set(events.filter(e=>e.cohort).map(rowKey));assert.equal(found.size,cohortKeys.size,'Cohort reconstruction mismatch')
  const features=[...new Set(events.flatMap(e=>Object.keys(e.features)))]
  for(const e of events)for(const k of features)if(!Number.isFinite(e.features[k]))delete e.features[k]
  const data={version:1,dates:DATES,symbols:symbols.length,cohort:found.size,features,events}
  save(CANDLE_CACHE,data);console.log(`Saved ${events.length} events; ${features.length} candle/market features`);return data
}

async function buildDepth(data, worker=false){
  const groups=Map.groupBy(data.events,e=>`${e.date}|${e.symbol}`), result={},files=[...groups.keys()];let done=0,oiFields=new Set()
  async function one(key){
    const [date,symbol]=key.split('|'),file=path.join(ROOT,'db','cash-depth',date,symbol,`${symbol}.jsonl`),buckets=new Map(),fields={};let prev=null,previousAt=NaN
    if(!fs.existsSync(file))return
    const input=fs.createReadStream(file,{encoding:'utf8'}),lines=readline.createInterface({input,crlfDelay:Infinity})
    for await(const line of lines){
      let r;try{r=JSON.parse(line)}catch{continue}
      const t=Date.parse(r.receivedAt);if(!Number.isFinite(t)||day(t)!==date)continue
      if(t<previousAt)continue
      if(t-previousAt>90000){prev=null;for(const k of Object.keys(fields))delete fields[k]}
      previousAt=t
      if(r.kind==='checkpoint'||r.book){for(const k of Object.keys(fields))delete fields[k];Object.assign(fields,r.data)}
      else if(r.kind==='update')Object.assign(fields,r.data);else continue
      for(const k of Object.keys(r.data||{}))if(/^(oi|open_interest|openInterest)$/i.test(k))oiFields.add(k)
      let bid=0,ask=0,tb=0,ta=0,bo=0,ao=0,valid=true
      for(let l=1;l<=5;l++){
        const bp=+fields[`bid_price${l}`],ap=+fields[`ask_price${l}`],bs=+fields[`bid_size${l}`],as=+fields[`ask_size${l}`]
        if(![bp,ap,bs,as].every(Number.isFinite)||bp<=0||ap<=bp||bs<0||as<0){valid=false;break}
        bid+=bs;ask+=as;if(l<=2){tb+=bs;ta+=as};bo+=+fields[`bid_order${l}`]||0;ao+=+fields[`ask_order${l}`]||0
      }
      if(!valid)continue
      const bp=+fields.bid_price1,ap=+fields.ask_price1,bs=+fields.bid_size1,as=+fields.ask_size1,mid=(bp+ap)/2,vol=+r.marketContext?.cumulativeVolume,price=+r.marketContext?.price
      const minute=Math.floor(t/MINUTE)*MINUTE
      if(!buckets.has(minute))buckets.set(minute,{t:minute,n:0,first:t,last:t,full:0,top2:0,orders:0,ofi:0,signed:0,traded:0,spread:0,firstMid:mid,lastMid:mid,firstFull:(bid-ask)/(bid+ask||1),lastFull:0,maxGap:0,bidUp:0,askUp:0,bidDown:0,askDown:0})
      const b=buckets.get(minute),full=(bid-ask)/(bid+ask||1)
      b.n++;b.last=t;b.lastMid=mid;b.lastFull=full;b.full+=full;b.top2+=(tb-ta)/(tb+ta||1);b.orders+=(bo-ao)/(bo+ao||1);b.spread+=10000*(ap-bp)/mid
      if(prev){
        const bf=bp>prev.bp?bs:bp===prev.bp?bs-prev.bs:-prev.bs,af=ap<prev.ap?as:ap===prev.ap?as-prev.as:-prev.as
        b.ofi+=(bf-af)/((bs+as+prev.bs+prev.as)/2||1)
        const traded=Number.isFinite(vol)&&vol>=prev.vol?vol-prev.vol:0;b.traded+=traded
        b.signed+=traded*Math.sign(price-prev.price||0)
        b.bidUp+=bp>prev.bp?1:0;b.bidDown+=bp<prev.bp?1:0;b.askUp+=ap>prev.ap?1:0;b.askDown+=ap<prev.ap?1:0
        if(prev.t>=minute)b.maxGap=Math.max(b.maxGap,t-prev.t)
      }
      prev={bp,ap,bs,as,vol,price,t}
    }
    for(const e of groups.get(key)){
      const ds=[3,2,1].map(m=>buckets.get(e.signalAt-m*MINUTE)),valid=ds.filter(Boolean),d=e.side==='BUY'?1:-1
      if(!valid.length)continue
      const first=valid[0],last=valid.at(-1),n=valid.reduce((s,b)=>s+b.n,0),sum=k=>valid.reduce((s,b)=>s+b[k],0)
      const quality=ds.every(b=>b&&b.n>=3&&b.last-b.first>=30000&&b.maxGap<=30000)&&e.signalAt-last.last<=15000
      result[rowKey(e)]={depthAvailable:quality?1:0,depthLastAgeSec:(e.signalAt-last.last)/1000}
      if(quality)Object.assign(result[rowKey(e)],{
        depthFull:d*sum('full')/n,depthTop2:d*sum('top2')/n,depthOrders:d*sum('orders')/n,depthOfi:d*sum('ofi')/n,
        depthDelta:sum('traded')?d*sum('signed')/sum('traded'):NaN,depthSpread:sum('spread')/n,
        depthMidReturn:d*pct(last.lastMid,first.firstMid),depthImbalanceChange:d*(last.lastFull-first.firstFull),
        depthQuoteAgreement:100*(d>0?sum('bidUp')+sum('askUp'):sum('bidDown')+sum('askDown'))/(2*n),
      })
    }
  }
  let index=0
  await Promise.all(Array.from({length:worker?1:4},async()=>{while(index<files.length){const key=files[index++];await one(key);done++;if(worker)parentPort.postMessage({progress:1});else if(done%100===0)console.log(`Depth ${done}/${files.length}`)}}))
  const report={version:1,oiFields:[...oiFields],quality:'Three full prior minutes; >=3 snapshots/minute, >=30s span/minute, <=30s internal gap, last snapshot <=15s old',rows:result}
  if(!worker){save(DEPTH_CACHE,report);console.log(`Depth saved: ${Object.keys(result).length} entries`)}
  return report
}

async function depthPool(data, output=DEPTH_CACHE){
  const groups=[...Map.groupBy(data.events,e=>`${e.date}|${e.symbol}`).values()],batches=Array.from({length:4},()=>[])
  groups.forEach((rs,i)=>batches[i%4].push(...rs.map(({date,symbol,side,entryTime,signalAt})=>({date,symbol,side,entryTime,signalAt}))))
  let completed=0
  const results=await Promise.all(batches.map(entries=>new Promise((resolve,reject)=>{
    const worker=new Worker(new URL(import.meta.url),{workerData:{entries},execArgv:[]})
    worker.on('message',m=>{if(m.progress){completed++;if(completed%100===0)console.log(`Depth ${completed}/${groups.length}`)}else if(m.result)resolve(m.result)})
    worker.on('error',reject);worker.on('exit',code=>{if(code)reject(new Error(`Depth worker exited ${code}`))})
  })))
  const report={version:1,oiFields:[...new Set(results.flatMap(r=>r.oiFields))],quality:results[0].quality,rows:Object.assign({},...results.map(r=>r.rows))}
  save(output,report);console.log(`Depth saved: ${Object.keys(report.rows).length} entries`)
}

if(workerData?.entries){parentPort.postMessage({result:await buildDepth({events:workerData.entries},true)})}

if(!workerData?.entries&&process.argv.includes('--build')){
  const data=fs.existsSync(CANDLE_CACHE)?JSON.parse(fs.readFileSync(CANDLE_CACHE,'utf8')):buildCandles()
  if(process.argv.includes('--depth')&&!fs.existsSync(DEPTH_CACHE))await depthPool(data)
}

export {CANDLE_CACHE,DEPTH_CACHE,REPORTS,STEM,DATES,MINUTE,ROOT,round,rowKey,save,uniqueFile,writeCsv,indicators,aggregate,timeframeFeatures,normalize,loadCandles,buildCandles,buildDepth,depthPool}
