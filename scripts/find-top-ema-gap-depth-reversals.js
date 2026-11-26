import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const root = process.cwd(), date = process.argv[2] ?? '2026-10-19', cutoff = process.argv[3] ?? '09:30', topCount = Number(process.argv[4] ?? 10)
const early = process.argv.includes('--early')
if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(cutoff) || !Number.isInteger(topCount) || topCount < 1) throw new Error('Usage: node scripts/find-top-ema-gap-depth-reversals.js YYYY-MM-DD HH:MM [top-count]')
const findGapReports = () => fs.readdirSync(path.join(root, 'reports')).filter(name => new RegExp(`^${date}-${cutoff.replace(':','')}-ema9-ema45-vs-prior5.*\\.json$`).test(name)).map(name => path.join(root, 'reports', name)).sort((a,b)=>fs.statSync(b).mtimeMs-fs.statSync(a).mtimeMs)
let reportFiles = findGapReports()
if (!reportFiles.length) {
  execFileSync(process.execPath, ['scripts/rank-ema9-ema45-vs-prior5.js', date, cutoff], { cwd: root, stdio: 'ignore' })
  reportFiles = findGapReports()
}
if (!reportFiles.length) throw new Error(`Could not create EMA-gap input for ${date} ${cutoff}.`)
const gapReport = JSON.parse(fs.readFileSync(reportFiles[0], 'utf8'))
const qualifiedGapRows = gapReport.qualified ?? gapReport.rows.filter(row => {
  const priorGaps = row.priorGapPct ?? row.priorFiveGapPct
  return Array.isArray(priorGaps) && row.absoluteGapPct > Math.max(...priorGaps.map(Math.abs))
})
const candidates = qualifiedGapRows.slice(0, topCount)
const round = (x,p=4) => Number.isFinite(x) ? Number(x.toFixed(p)) : null
const stamp = epoch => new Date(epoch * 1000 + 330 * 60_000).toISOString().slice(0,16).replace('T',' ')
const pct=(a,b)=>100*(a/b-1), mean=xs=>xs.reduce((a,b)=>a+b,0)/xs.length

function candles(symbol) {
  const file=path.join(root,'db','candles',`${symbol}.jsonl`); if(!fs.existsSync(file)) return []
  const unique=new Map()
  for(const line of fs.readFileSync(file,'utf8').split(/\r?\n/)){if(!line.trim())continue;let r;try{r=JSON.parse(line)}catch{continue};const t=stamp(+r.time);if(t.slice(0,10)!==date||t.slice(11)<'09:15'||t.slice(11)>'15:29'||![r.open,r.high,r.low,r.close,r.volume].every(x=>Number.isFinite(+x)))continue;unique.set(t,{time:t,open:+r.open,high:+r.high,low:+r.low,close:+r.close,volume:+r.volume})}
  const rows=[...unique.values()].sort((a,b)=>a.time.localeCompare(b.time));let ema5,ema9
  for(const row of rows){ema5=ema5==null?row.close:row.close*(2/6)+ema5*(4/6);ema9=ema9==null?row.close:row.close*.2+ema9*.8;row.ema5=ema5;row.ema9=ema9}
  return rows
}
function depthByMinute(symbol) {
  const file=path.join(root,'db','cash-depth',date,symbol,`${symbol}.jsonl`);if(!fs.existsSync(file))return new Map()
  const state={}, byMinute=new Map()
  for(const line of fs.readFileSync(file,'utf8').split(/\r?\n/)){if(!line.trim())continue;let e;try{e=JSON.parse(line)}catch{continue};const time=stamp(Date.parse(e.receivedAt)/1000);if(time.slice(0,10)!==date||time.slice(11)<'09:15'||time.slice(11)>'15:29')continue;if(e.kind==='checkpoint')for(const k of Object.keys(state))delete state[k];Object.assign(state,e.data??{});let bid=0,ask=0,ok=true;for(let level=1;level<=5;level++){const bp=+state[`bid_price${level}`],ap=+state[`ask_price${level}`],bs=+state[`bid_size${level}`],as=+state[`ask_size${level}`];if(![bp,ap,bs,as].every(Number.isFinite)||bp<=0||ap<=bp){ok=false;break}bid+=bs;ask+=as}if(!ok)continue;byMinute.set(time,{bidShare:100*bid/(bid+ask||1),mid:(+state.bid_price1 + +state.ask_price1)/2})}
  return byMinute
}
function findReversal(candidate) {
  const rows=candles(candidate.symbol), depth=depthByMinute(candidate.symbol), initial=candidate.gapPct>=0?'BUY':'SELL', reverse=initial==='BUY'?'SELL':'BUY', start=rows.findIndex(row=>row.time.slice(11)>=cutoff)
  // The high initial EMA-gap expansion distinguishes genuine opening dislocation
  // from ordinary intraday pullbacks among the ten candidate names.
  if (early && candidate.gapExpansionPct < 1.5) return {symbol:candidate.symbol,initialDirection:initial,reverseDirection:reverse,status:'rejected: EMA-gap expansion below 1.50pp'}
  if(start<3)return {symbol:candidate.symbol,initial,reverse,reason:'missing post-cutoff candles'}
  let pv=0,vol=0
  const sessionVwap=[];for(const row of rows){pv+=((row.high+row.low+row.close)/3)*row.volume;vol+=row.volume;sessionVwap.push(pv/vol)}
  for(let i=start+(early?1:2);i<rows.length;i++){
    const last3=rows.slice(i-2,i+1), direction=reverse==='BUY'?1:-1, threeMinuteReturn=direction*pct(last3.at(-1).close,last3[0].open)
    const priceSide=reverse==='BUY'?rows[i].close>sessionVwap[i]:rows[i].close<sessionVwap[i]
    const emaSide=reverse==='BUY'?rows[i].ema5>rows[i].ema9:rows[i].ema5<rows[i].ema9
    const closesDirectional=last3.filter((row,j)=>j&&direction*(row.close-last3[j-1].close)>0).length>=2
    const depthRows=last3.map(row=>depth.get(row.time)).filter(Boolean)
    const directionalBidShare=depthRows.length===3?mean(depthRows.map(row=>reverse==='BUY'?row.bidShare:100-row.bidShare)):null
    const midpointMove=depthRows.length===3?direction*pct(depthRows.at(-1).mid,depthRows[0].mid):null
    const depthConfirmed=directionalBidShare!=null&&directionalBidShare>=52&&midpointMove>0
    if(!early && priceSide&&emaSide&&closesDirectional&&threeMinuteReturn>=.15&&depthConfirmed) return {symbol:candidate.symbol,initialDirection:initial,reverseDirection:reverse,signalTime:rows[i].time,entryTime:rows[i+1]?.time??null,price:round(rows[i].close),vwap:round(sessionVwap[i]),ema5:round(rows[i].ema5),ema9:round(rows[i].ema9),threeMinuteReturnPct:round(threeMinuteReturn),depthDirectionalSharePct:round(directionalBidShare),depthMidpointMovePct:round(midpointMove),status:'eligible'}
    if(early) {
      const last2=rows.slice(i-1,i+1), twoMinuteReturn=direction*pct(last2.at(-1).close,last2[0].open)
      const depth2=last2.map(row=>depth.get(row.time)).filter(Boolean)
      const depth2Share=depth2.length===2?mean(depth2.map(row=>reverse==='BUY'?row.bidShare:100-row.bidShare)):null
      const depth2Midpoint=depth2.length===2?direction*pct(depth2.at(-1).mid,depth2[0].mid):null
      const ema5Turn=direction*(rows[i].ema5-rows[i-1].ema5)>0
      const priceSupportsTurn=direction*(rows[i].close-rows[i].ema5)>0
      if(twoMinuteReturn>=.15&&ema5Turn&&priceSupportsTurn&&depth2Share!=null&&depth2Share>=58&&depth2Midpoint>.02) return {symbol:candidate.symbol,initialDirection:initial,reverseDirection:reverse,signalTime:rows[i].time,entryTime:rows[i+1]?.time??null,price:round(rows[i].close),vwap:round(sessionVwap[i]),ema5:round(rows[i].ema5),ema9:round(rows[i].ema9),twoMinuteReturnPct:round(twoMinuteReturn),depthDirectionalSharePct:round(depth2Share),depthMidpointMovePct:round(depth2Midpoint),status:'eligible early'}
    }
  }
  return {symbol:candidate.symbol,initialDirection:initial,reverseDirection:reverse,status:'no causal smooth reversal confirmation'}
}
const reviewed=candidates.map(findReversal), eligible=reviewed.filter(row=>row.status.startsWith('eligible'))
const report={date,cutoff,source:reportFiles[0],candidateCount:candidates.length,rule:early?'Early reversal: initial EMA9/EMA45 five-session gap expansion >=1.50pp; two-minute opposite return >=0.15%; EMA5 turns in that direction; close is beyond EMA5; both depth minutes have directional five-level share >=58% and midpoint move >0.02%. Entry is next completed candle.':'Confirmed reversal: three-minute opposite return >=0.15%; at least two directional close-to-close steps; price on opposite side of session VWAP; EMA5 on opposite side of EMA9; all three depth minutes available with directional five-level share >=52% and directional midpoint move >0%. Entry is next completed candle.',eligibleCount:eligible.length,eligible,reviewed}
let n=1,output;do{output=path.join(root,'reports',`${date}-${cutoff.replace(':','')}-top-ema-gap-depth-reversals${n===1?'':`-${n}`}.json`);n++}while(fs.existsSync(output));fs.writeFileSync(output,JSON.stringify(report,null,2)+'\n',{flag:'wx'})
for(const row of eligible) console.log(`${row.symbol}\t${row.reverseDirection}\t${row.signalTime}`)
