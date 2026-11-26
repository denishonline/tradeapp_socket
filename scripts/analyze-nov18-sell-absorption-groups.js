#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import apiV3 from 'fyers-api-v3'
import { CONSTANT } from '../constant.js'

const ROOT=process.cwd(),DATE='2026-11-18',IST=330*60_000
const cases=[
  {symbol:'NBCC',group:1,start:'09:18',end:'09:28'},
  {symbol:'BSE',group:1,start:'09:30',end:'09:40'},
  {symbol:'BAJAJFINSV',group:2,start:'09:17',end:'09:27'},
  {symbol:'KEI',group:2,start:'09:39',end:'09:49'},
]
const minuteOf=x=>+x.slice(0,2)*60 + +x.slice(3),round=(x,d=4)=>Number.isFinite(x)?+x.toFixed(d):null
const ema=(values,n)=>{let value=NaN;const alpha=2/(n+1);return values.map(x=>(value=Number.isFinite(value)?alpha*x+(1-alpha)*value:x))}
const local=iso=>new Date(Date.parse(iso)+IST).toISOString()
function candles(symbol){
  const unique=new Map()
  for(const line of fs.readFileSync(path.join(ROOT,'db','candles',`${symbol}.jsonl`),'utf8').split(/\r?\n/)){try{const x=JSON.parse(line),stamp=new Date(+x.time*1000+IST).toISOString(),date=stamp.slice(0,10),time=stamp.slice(11,16);unique.set(`${date} ${time}`,{date,time,minute:minuteOf(time),o:+x.open,h:+x.high,l:+x.low,c:+x.close,v:+x.volume})}catch{}}
  return[...unique.values()].sort((a,b)=>(a.date+' '+a.time).localeCompare(b.date+' '+b.time))
}
function depth(symbol){
  const file=path.join(ROOT,'db','cash-depth',DATE,symbol,`${symbol}.jsonl`),state={},out=[]
  for(const line of fs.readFileSync(file,'utf8').split(/\r?\n/)){if(!line.trim())continue;let e;try{e=JSON.parse(line)}catch{continue};const stamp=local(e.receivedAt),date=stamp.slice(0,10),time=stamp.slice(11,16),minute=minuteOf(time);if(date!==DATE)continue;if(e.kind==='checkpoint')for(const key of Object.keys(state))delete state[key];Object.assign(state,e.data||{});let bid=0,ask=0,bidOrders=0,askOrders=0,valid=true;for(let n=1;n<=5;n++){const bp=+state[`bid_price${n}`],ap=+state[`ask_price${n}`],bs=+state[`bid_size${n}`],as=+state[`ask_size${n}`];if(![bp,ap,bs,as].every(Number.isFinite)||ap<=bp){valid=false;break}bid+=bs;ask+=as;bidOrders+=+state[`bid_order${n}`]||0;askOrders+=+state[`ask_order${n}`]||0}if(valid){const bid1=+state.bid_size1,ask1=+state.ask_size1,bp=+state.bid_price1,ap=+state.ask_price1;out.push({time,minute,bidShare:100*bid/(bid+ask||1),bidOrderShare:100*bidOrders/(bidOrders+askOrders||1),topBidShare:100*bid1/(bid+ask||1),mid:(bp+ap)/2,spreadBps:10000*(ap-bp)/((ap+bp)/2)})}}
  return out
}
function depthFeatures(rows){
  if(!rows.length)return{}
  const minutes=[...new Set(rows.map(x=>x.minute))],minuteRows=minutes.map(minute=>{const z=rows.filter(x=>x.minute===minute);return{minute,bid:z.reduce((s,x)=>s+x.bidShare,0)/z.length,first:z[0].mid,last:z.at(-1).mid}})
  const half=Math.floor(rows.length/2),last3=rows.filter(x=>x.minute>=minutes.at(-1)-2)
  return{snapshots:rows.length,meanBidShare:rows.reduce((s,x)=>s+x.bidShare,0)/rows.length,bidDominantMinutes:100*minuteRows.filter(x=>x.bid>50).length/minuteRows.length,firstHalfBidShare:rows.slice(0,half).reduce((s,x)=>s+x.bidShare,0)/(half||1),secondHalfBidShare:rows.slice(half).reduce((s,x)=>s+x.bidShare,0)/(rows.length-half||1),last3BidShare:last3.reduce((s,x)=>s+x.bidShare,0)/(last3.length||1),meanBidOrderShare:rows.reduce((s,x)=>s+x.bidOrderShare,0)/rows.length,meanSpreadBps:rows.reduce((s,x)=>s+x.spreadBps,0)/rows.length,midpointMovePct:100*(rows.at(-1).mid/rows[0].mid-1),downMidpointMinutesPct:100*minuteRows.filter(x=>x.last<x.first).length/minuteRows.length}
}
const token=JSON.parse(fs.readFileSync(path.join(ROOT,'db','token'),'utf8')),client=new apiV3.fyersModel({enableLogging:false});client.setAppId(CONSTANT.appId);client.setAccessToken(token)
async function priorClose(symbol){const response=await client.getHistory({symbol:`NSE:${symbol}-EQ`,resolution:'1',date_format:'1',range_from:'2026-11-17',range_to:'2026-11-17',cont_flag:'1'});return +response.candles?.at(-1)?.[4]}

const rows=[]
for(const item of cases){
  const all=candles(item.symbol),today=all.filter(x=>x.date===DATE),from=minuteOf(item.start),to=minuteOf(item.end),window=today.filter(x=>x.minute>=from&&x.minute<to),session=today.filter(x=>x.minute>=555&&x.minute<to),book=depth(item.symbol),windowDepth=book.filter(x=>x.minute>=from&&x.minute<to),sessionDepth=book.filter(x=>x.minute>=555&&x.minute<to)
  const open=window[0].o,close=window.at(-1).c,high=Math.max(...window.map(x=>x.h)),low=Math.min(...window.map(x=>x.l)),volume=window.reduce((s,x)=>s+x.v,0),vwap=window.reduce((s,x)=>s+x.v*(x.h+x.l+x.c)/3,0)/(volume||1),e5=ema(session.map(x=>x.c),5),e10=ema(session.map(x=>x.c),10),pc=await priorClose(item.symbol)
  rows.push({symbol:item.symbol,group:item.group,statusTime:item.end,window:`${item.start}-${item.end}`,todayReturnPct:100*(close/pc-1),windowReturnPct:100*(close/open-1),peakToClosePct:100*(close/high-1),closeLocationPct:100*(close-low)/(high-low||1),maxUpsidePct:100*(high/open-1),closeVsVwapPct:100*(close/vwap-1),redCandlePct:100*window.filter(x=>x.c<x.o).length/window.length,last3ReturnPct:100*(close/window.at(-4).c-1),ema5Vs10Pct:100*(e5.at(-1)/e10.at(-1)-1),ema5Slope3Pct:100*(e5.at(-1)/e5.at(-4)-1),...Object.fromEntries(Object.entries(depthFeatures(windowDepth)).map(([k,v])=>[`window_${k}`,v])),...Object.fromEntries(Object.entries(depthFeatures(sessionDepth)).map(([k,v])=>[`session_${k}`,v]))})
}
const rounded=rows.map(row=>Object.fromEntries(Object.entries(row).map(([k,v])=>[k,typeof v==='number'?round(v):v])))
const rule=row=>row.window_meanBidShare>=60&&row.window_midpointMovePct<=-.1&&row.peakToClosePct<=-.7&&row.closeLocationPct<=25
for(const row of rounded)row.additionalSellProof=rule(row)?'PASS':'FAIL'
const output=path.join(ROOT,'reports','2026-11-18-NBCC-BSE-vs-BAJAJFINSV-KEI-sell-absorption-proof.json')
fs.writeFileSync(output,JSON.stringify({warning:'Retrospective 2-vs-2 comparison; candidate separator is in-sample and requires validation.',candidateAdditionalSellProof:['Mean window bid share >=60%','Window midpoint move <=-0.10%','Peak-to-close reversal <=-0.70%','Window close location <=25%'],rows:rounded},null,2)+'\n',{flag:'wx'})
console.table(rounded.map(x=>({Stock:x.symbol,Group:x.group,'Bid share':x.window_meanBidShare,'Mid move':x.window_midpointMovePct,'Peak-close':x.peakToClosePct,'Close location':x.closeLocationPct,'VWAP distance':x.closeVsVwapPct,'EMA5 slope':x.ema5Slope3Pct,'09:15-status bid':x.session_meanBidShare,Proof:x.additionalSellProof})))
console.log(output)
