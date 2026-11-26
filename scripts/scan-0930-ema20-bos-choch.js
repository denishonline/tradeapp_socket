#!/usr/bin/env node
import fs from "node:fs"
import path from "node:path"
const ROOT=process.cwd(), DATE=process.argv.find(value=>value.startsWith("--date="))?.split("=")[1]??"2026-11-03", IST=330*60_000, pct=(a,b)=>100*(a/b-1), stamp=t=>new Date(t*1000+IST).toISOString().slice(11,16)
const rowsFor=s=>fs.readFileSync(path.join(ROOT,"db/candles",`${s}.jsonl`),"utf8").trim().split(/\r?\n/).map(JSON.parse).sort((a,b)=>a.time-b.time)
const minute=t=>{const d=new Date(t*1000+IST);return d.getUTCHours()*60+d.getUTCMinutes()}
const stocks=JSON.parse(fs.readFileSync(path.join(ROOT,"db/stocks"),"utf8"))
const results=[]
for(const symbol of stocks){
  let ema=null;const all=rowsFor(symbol),today=[]
  for(const x of all){ema=ema==null?x.close:(2/21)*x.close+(19/21)*ema;const d=new Date(x.time*1000+IST).toISOString().slice(0,10),m=minute(x.time);if(d===DATE&&m>=555&&m<=569)today.push({...x,ema,m})}
  if(today.length<15)continue
  for(const end of [560,565,569]){
    const w=today.filter(x=>x.m<=end);if(w.length<end-555+1)continue
    const angle=Math.atan((w.at(-1).ema-w[0].ema)/(w.length-1))*180/Math.PI
    const gaps=w.map(x=>pct(x.close,x.ema));if(angle<=15||gaps.some(x=>x<=.8))continue
    const last=w.at(-1), prior=w.slice(0,-1), priorHigh=Math.max(...prior.slice(-5).map(x=>x.high)), priorLow=Math.min(...prior.slice(-5).map(x=>x.low))
    const side=last.close>priorHigh?"BUY":last.close<priorLow?"SELL":null
    if(!side)continue
    results.push({symbol,window:`09:15-${stamp(last.time)}`,signalTime:stamp(last.time),side,event:"BOS/CHOCH_BREAKOUT",rawAngleDeg:+angle.toFixed(3),minimumEmaCloseDiffPct:+Math.min(...gaps).toFixed(3),emaCloseDiffPct:+gaps.at(-1).toFixed(3),breakoutLevel:+(side==='BUY'?priorHigh:priorLow).toFixed(4),close:last.close})
  }
}
const unique=[...new Map(results.map(x=>[x.symbol,x])).values()].sort((a,b)=>b.rawAngleDeg-a.rawAngleDeg)
const out={date:DATE,method:"Causal scan through completed candles at 09:30; raw EMA20 angle = atan((EMA20 end - start)/(candle intervals)); every candle in window must have close > EMA20 by >0.8%; breakout is close beyond prior five-candle high/low.",signals:unique}
let n=1,file;do{file=path.join(ROOT,"reports",`${DATE}-ema20-angle-bos-choch-before-0930${n===1?'':`-${n}`}.json`);n++}while(fs.existsSync(file));fs.writeFileSync(file,JSON.stringify(out,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify({file,count:unique.length,signals:unique},null,2))
