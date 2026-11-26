import fs from 'node:fs'
import path from 'node:path'

const root = process.cwd(), date = process.argv[2]
const value = name => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : null }
const start = value('--start') ?? '09:20', candidateEnd = value('--candidate-end') ?? '15:00', end = value('--end') ?? '15:00', topCount = Number(value('--top') ?? 10), minimumGapExpansionPct = Number(value('--min-gap') ?? 1.5), minimumTwoReturnPct = Number(value('--min-return') ?? 0.15), minimumDepthSharePct = Number(value('--min-depth') ?? 50), minimumMidpointMovePct = Number(value('--min-midpoint') ?? 0.02), replay = process.argv.includes('--replay'), recalculateReversals = process.argv.includes('--recalculate-reversals'), reversalOnly = process.argv.includes('--reversal-only')
if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(start) || !/^\d{2}:\d{2}$/.test(candidateEnd) || !/^\d{2}:\d{2}$/.test(end) || start > candidateEnd || candidateEnd > end || !Number.isInteger(topCount) || topCount < 1 || !Number.isFinite(minimumGapExpansionPct) || minimumGapExpansionPct < 0) throw new Error('Usage: node scripts/live-ema-gap-reversal-radar.js YYYY-MM-DD [--start 09:20] [--candidate-end 15:00] [--end 15:00] [--top 10] [--min-gap 1.5] [--replay] [--recalculate-reversals]')
const sessions = [...new Set(fs.readFileSync(path.join(root, 'db', 'candles', 'NIFTY50.jsonl'), 'utf8').split(/\r?\n/).flatMap(line => { try { const row = JSON.parse(line); return [new Date(+row.time * 1000 + 330 * 60_000).toISOString().slice(0, 10)] } catch { return [] } }))].sort()
// The target session need not be in NIFTY50 history yet when the server starts
// before market open. Only five completed, earlier trading sessions are needed.
const priorDates = sessions.filter(day => day < date).slice(-5)
if (priorDates.length < 5) throw new Error(`${date} needs five prior sessions in the available NIFTY50 candle calendar.`)
const symbols = [...new Set(JSON.parse(fs.readFileSync(path.join(root, 'db', 'stocks'), 'utf8')).map(x => String(x).trim().toUpperCase().replace(/-EQ$/, '')))]
const reportSuffix = process.argv.includes('--min-gap') ? `-min-gap-${String(minimumGapExpansionPct).replace('.', '_')}` : ''
const outputOverride = value('--output')
const out = outputOverride ? path.resolve(root, outputOverride) : path.join(root, 'reports', `${date}-0920-to-1000-live-ema-gap-reversal-radar${reportSuffix}.json`), round=(x,p=4)=>Number.isFinite(x)?Number(x.toFixed(p)):null, mean=xs=>xs.reduce((a,b)=>a+b,0)/xs.length
const stamp=epoch=>new Date(epoch*1000+330*60_000).toISOString().slice(0,16).replace('T',' '), pct=(a,b)=>100*(a/b-1), minutes=t=>Number(t.slice(0,2))*60+Number(t.slice(3))
const sessionStart=555, allDates=new Set([...priorDates,date])
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms))
const candleCache=new Map(), depthCache=new Map()

function candleSeries(symbol, cutoffMinute) {
  if(!candleCache.has(symbol)){const file=path.join(root,'db','candles',`${symbol}.jsonl`);if(!fs.existsSync(file)){candleCache.set(symbol,[])}else{const unique=new Map();for(const line of fs.readFileSync(file,'utf8').split(/\r?\n/)){if(!line.trim())continue;let r;try{r=JSON.parse(line)}catch{continue};const s=stamp(+r.time),day=s.slice(0,10),minute=minutes(s.slice(11));if(day>date||minute<sessionStart||minute>=930||![r.open,r.high,r.low,r.close,r.volume].every(x=>Number.isFinite(+x)))continue;unique.set(s,{time:s,day,minute,open:+r.open,high:+r.high,low:+r.low,close:+r.close,volume:+r.volume})}candleCache.set(symbol,[...unique.values()].sort((a,b)=>a.time.localeCompare(b.time)))}}
  return candleCache.get(symbol).filter(row=>row.day!==date||row.minute<cutoffMinute).map(row=>({...row}))
}
function gapCandidate(symbol, cutoffMinute) {
  const rows=candleSeries(symbol,cutoffMinute); if(!rows.length)return null
  let e9=rows[0].close,e45=rows[0].close;const gaps={}
  for(const row of rows){if(row!==rows[0]){e9=.2*row.close+.8*e9;e45=(2/46)*row.close+(44/46)*e45}if(allDates.has(row.day)&&row.minute===cutoffMinute-1)gaps[row.day]=100*(e9/e45-1)}
  if(reversalOnly){const current=gaps[date],priorValues=priorDates.map(day=>gaps[day]).filter(Number.isFinite),priorAverage=priorValues.length?mean(priorValues.map(Math.abs)):0; if(!Number.isFinite(current))return null;return {symbol,gapPct:round(current),absoluteGapPct:round(Math.abs(current)),gapExpansionPct:round(Math.abs(current)-priorAverage),priorAverageAbsoluteGapPct:round(priorAverage),initialDirection:current>=0?'BUY':'SELL'}}
  if(![...priorDates,date].every(day=>Number.isFinite(gaps[day])))return null
  const prior=priorDates.map(day=>gaps[day]), current=gaps[date], abs=Math.abs(current), avg=mean(prior.map(Math.abs)), max=Math.max(...prior.map(Math.abs))
  if(!(abs>max))return null
  return {symbol,gapPct:round(current),absoluteGapPct:round(abs),gapExpansionPct:round(abs-avg),priorAverageAbsoluteGapPct:round(avg),initialDirection:current>=0?'BUY':'SELL'}
}
function depthMinutes(symbol, cutoffMinute) {
  if(!depthCache.has(symbol)){const file=path.join(root,'db','cash-depth',date,symbol,`${symbol}.jsonl`);const state={},out=new Map();if(fs.existsSync(file))for(const line of fs.readFileSync(file,'utf8').split(/\r?\n/)){if(!line.trim())continue;let e;try{e=JSON.parse(line)}catch{continue};const s=stamp(Date.parse(e.receivedAt)/1000),minute=minutes(s.slice(11));if(s.slice(0,10)!==date||minute<sessionStart||minute>=930)continue;if(e.kind==='checkpoint')for(const k of Object.keys(state))delete state[k];Object.assign(state,e.data??{});let bid=0,ask=0,ok=true;for(let n=1;n<=5;n++){const bp=+state[`bid_price${n}`],ap=+state[`ask_price${n}`],bs=+state[`bid_size${n}`],as=+state[`ask_size${n}`];if(![bp,ap,bs,as].every(Number.isFinite)||bp<=0||ap<=bp){ok=false;break}bid+=bs;ask+=as}if(ok)out.set(s,{bidShare:100*bid/(bid+ask||1),mid:(+state.bid_price1 + +state.ask_price1)/2})}depthCache.set(symbol,out)}
  return new Map([...depthCache.get(symbol)].filter(([s])=>minutes(s.slice(11))<cutoffMinute))
}
function rsi14(closes){if(closes.length<15)return null;let gain=0,loss=0;for(let i=closes.length-14;i<closes.length;i++){const change=closes[i]-closes[i-1];if(change>0)gain+=change;else loss-=change}return loss===0?100:100-100/(1+gain/loss)}
function mfi14(rows){if(rows.length<15)return null;let pos=0,neg=0;for(let i=rows.length-14;i<rows.length;i++){const previous=(rows[i-1].high+rows[i-1].low+rows[i-1].close)/3,current=(rows[i].high+rows[i].low+rows[i].close)/3,flow=current*rows[i].volume;if(current>previous)pos+=flow;else if(current<previous)neg+=flow}return neg===0?100:100-100/(1+pos/neg)}
function scoreReversal(candidate,rows,right,twoReturn,reverse){
  const direction=reverse==='BUY'?1:-1, closes=rows.map(row=>row.close), current=right.close
  let ema45=closes[0];for(let i=1;i<closes.length;i++)ema45=2/46*closes[i]+44/46*ema45
  const prior=priorDates.map(day=>rows.filter(row=>row.day===day)).filter(dayRows=>dayRows.length), previousFive=prior.slice(-5), priorFiveTotal=previousFive.length?100*(previousFive.at(-1).at(-1).close/previousFive[0][0].open-1):null
  const earlier=rows.find(row=>row.day===right.day&&row.minute<=right.minute-15), momentum15=earlier?100*(current/earlier.close-1):null, rsi=rsi14(closes),mfi=mfi14(rows),ema45Gap=100*(current/ema45-1)
  const checks={gapExpansion:candidate.gapExpansionPct>=minimumGapExpansionPct,bearishImpulse:direction*twoReturn>=.30,rsiAligned:Number.isFinite(rsi)&&(reverse==='BUY'?rsi>45:rsi<55),mfiAligned:Number.isFinite(mfi)&&(reverse==='BUY'?mfi>45:mfi<55),momentum15Aligned:Number.isFinite(momentum15)&&direction*momentum15>0,priorFiveAligned:Number.isFinite(priorFiveTotal)&&direction*priorFiveTotal>0,ema45Aligned:reverse==='BUY'?ema45Gap>-1:ema45Gap<1}
  return {score:Object.values(checks).filter(Boolean).length,scoreMax:Object.keys(checks).length,scoreChecks:checks,scoreRsi14:round(rsi),scoreMfi14:round(mfi),scoreMomentum15Pct:round(momentum15),scorePriorFivePct:round(priorFiveTotal),scoreEma45GapPct:round(ema45Gap)}
}
function reversal(candidate, cutoffMinute) {
  if(!reversalOnly&&candidate.gapExpansionPct<minimumGapExpansionPct)return null
  const rows=candleSeries(candidate.symbol,cutoffMinute), initial=candidate.initialDirection, reverse=initial==='BUY'?'SELL':'BUY', direction=reverse==='BUY'?1:-1, startAt=minutes(candidate.detectedAt.slice(11)), depth=depthMinutes(candidate.symbol,cutoffMinute)
  let e5;for(const row of rows){e5=e5==null?row.close:row.close*(2/6)+e5*(4/6);row.e5=e5}
  for(let i=1;i<rows.length;i++){
    if(rows[i].day!==date||rows[i].minute<=startAt)continue
    const left=rows[i-1],right=rows[i], twoReturn=direction*pct(right.close,left.open), depthRows=[depth.get(left.time),depth.get(right.time)]
    if(depthRows.some(x=>!x))continue
    const share=mean(depthRows.map(x=>reverse==='BUY'?x.bidShare:100-x.bidShare)), midMove=direction*pct(depthRows[1].mid,depthRows[0].mid)
    if(twoReturn>=minimumTwoReturnPct&&direction*(right.e5-left.e5)>0&&direction*(right.close-right.e5)>0&&share>=minimumDepthSharePct&&midMove>minimumMidpointMovePct)return {symbol:candidate.symbol,initialDirection:initial,reverseDirection:reverse,detectedAt:candidate.detectedAt,signalTime:right.time,entryTime:`${date} ${timeString(right.minute+1)}`,gapExpansionPct:candidate.gapExpansionPct,depthDirectionalSharePct:round(share),depthMidpointMovePct:round(midMove),...scoreReversal(candidate,rows,right,twoReturn,reverse)}
  }
  return null
}
function storedReversalState(candidate, cutoffMinute) {
  const rows=candleSeries(candidate.symbol,cutoffMinute);if(!rows.length)return null
  let e9=rows[0].close,e45=rows[0].close,vwapDay=null,priceVolume=0,volume=0
  for(const row of rows){if(row!==rows[0]){e9=.2*row.close+.8*e9;e45=(2/46)*row.close+(44/46)*e45}if(row.day!==vwapDay){vwapDay=row.day;priceVolume=0;volume=0}volume+=row.volume;priceVolume+=((row.high+row.low+row.close)/3)*row.volume}
  const vwap=priceVolume/volume, reversedSide=candidate.initialDirection==='BUY'?e9<e45&&e9<vwap:e9>e45&&e9>vwap
  return {checkedAt:`${date} ${timeString(cutoffMinute-1)}`,ema9:round(e9),ema45:round(e45),vwap:round(vwap),reversedSide}
}
function loadLedger(){if(fs.existsSync(out))return JSON.parse(fs.readFileSync(out,'utf8'));return {date,start,candidateEnd,end,priorDates,config:{topCount,minimumGapExpansionPct,reversalOnly,minimumTwoReturnPct,minimumDepthSharePct,minimumMidpointMovePct,earlyReversal:'two-minute opposite return; EMA5 turn; close beyond EMA5; directional depth share; midpoint move'},snapshots:[],storedStatus:{},reversals:[]}}
function save(ledger){fs.writeFileSync(out,JSON.stringify(ledger,null,2)+'\n')}
function timeString(minute){return `${String(Math.floor(minute/60)).padStart(2,'0')}:${String(minute%60).padStart(2,'0')}`}
async function runTick(cutoffMinute,ledger){const cutoff=timeString(cutoffMinute);let snapshot=ledger.snapshots.find(x=>x.cutoff===cutoff);if(cutoffMinute<=minutes(candidateEnd)&&!snapshot){const candidates=symbols.map(symbol=>gapCandidate(symbol,cutoffMinute)).filter(Boolean).sort((a,b)=>b.gapExpansionPct-a.gapExpansionPct).slice(0,topCount).map(row=>({...row,detectedAt:`${date} ${timeString(cutoffMinute-1)}`}));snapshot={cutoff,candidates};ledger.snapshots.push(snapshot)}const known=new Set(ledger.reversals.map(x=>`${x.symbol}|${x.reverseDirection}|${x.signalTime}`));const active=new Map();for(const priorSnapshot of ledger.snapshots.filter(x=>x.cutoff<=candidateEnd))for(const candidate of priorSnapshot.candidates){const key=`${candidate.symbol}|${candidate.initialDirection}`, prior=active.get(key);if(!prior||(prior.gapExpansionPct<minimumGapExpansionPct&&candidate.gapExpansionPct>=minimumGapExpansionPct))active.set(key,candidate)}ledger.storedStatus??={};for(const [key,candidate] of active){const state=storedReversalState(candidate,cutoffMinute);if(state)ledger.storedStatus[key]=state}for(const candidate of active.values()){const found=reversal(candidate,cutoffMinute);if(found){const key=`${found.symbol}|${found.reverseDirection}|${found.signalTime}`;if(!known.has(key)){ledger.reversals.push(found);known.add(key)}}}save(ledger);console.log(`${cutoff}  candidates=${snapshot?.candidates.length??0}  reversals=${ledger.reversals.length}`)}
const ledger=loadLedger(), startMinute=minutes(start),endMinute=minutes(end)
ledger.start=start;ledger.candidateEnd=candidateEnd;ledger.end=end;ledger.config={...(ledger.config||{}),topCount,minimumGapExpansionPct,reversalOnly,minimumTwoReturnPct,minimumDepthSharePct,minimumMidpointMovePct}
if(recalculateReversals){ledger.reversals=[];save(ledger)}
for(let cutoffMinute=startMinute;cutoffMinute<=endMinute;cutoffMinute++){
  if(!replay){const at=Date.parse(`${date}T${timeString(cutoffMinute)}:05+05:30`),wait=at-Date.now();if(wait>0)await sleep(wait)}
  await runTick(cutoffMinute,ledger)
}
