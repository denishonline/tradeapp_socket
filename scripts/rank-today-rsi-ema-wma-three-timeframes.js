import fs from 'node:fs'
import path from 'node:path'

const root=process.cwd(),offset=330*60_000,now=Date.now()
const stamp=ms=>new Date(ms+offset).toISOString().slice(0,16).replace('T',' ')
const today=stamp(now).slice(0,10)
const args=process.argv.slice(2)
let requestedTime,requestedSymbol,requestedWeights
for(let i=0;i<args.length;i++){
  if(args[i]==='--cutoff'&&!requestedTime)requestedTime=args[++i]
  else if(args[i]==='--symbol'&&!requestedSymbol)requestedSymbol=args[++i]
  else if(args[i]==='--weights'&&!requestedWeights)requestedWeights=args[++i]
  else if(!requestedTime&&/^\d{2}:\d{2}$/.test(args[i]))requestedTime=args[i]
  else throw new Error('Usage: node scripts/rank-today-rsi-ema-wma-three-timeframes.js [--cutoff HH:MM] [--symbol SYMBOL] [--weights 20,35,45]')
}
const cutoffMatch=requestedTime?.match(/^(?:(\d{4}-\d{2}-\d{2})[ T])?(\d{2}:\d{2})$/)
const targetDate=cutoffMatch?.[1]||today
const targetTime=cutoffMatch?.[2]||requestedTime
if((requestedTime!==undefined&&!cutoffMatch)||
   (requestedSymbol!==undefined&&!/^[A-Z0-9-]+$/.test(requestedSymbol))){
  throw new Error('Invalid cutoff or symbol')
}
const weightParts=requestedWeights?.split(',')
if(weightParts&&(weightParts.length!==3||weightParts.some(x=>!/^\d+(?:\.\d+)?$/.test(x))||Math.abs(weightParts.map(Number).reduce((a,b)=>a+b,0)-100)>1e-8)){
  throw new Error('Weights must be three nonnegative percentages totaling 100, ordered 1m,5m,15m')
}
const timeframeWeights=Object.fromEntries([1,5,15].map((n,i)=>[`${n}m`,weightParts?Number(weightParts[i])/100:1/3]))
const cutoff=requestedTime?Date.parse(`${targetDate}T${targetTime}:00+05:30`):Math.floor(now/60_000)*60_000
if(!Number.isFinite(cutoff)||cutoff>Math.floor(now/60_000)*60_000||stamp(cutoff).slice(11)<'09:16'||stamp(cutoff).slice(11)>'15:30'){
  throw new Error('Cutoff must be a completed IST market minute, 09:16–15:30; full form: YYYY-MM-DD HH:MM')
}
const openingCandle=Date.parse(`${targetDate}T09:15:00+05:30`)
const allowed=new Set(['2026-10-05','2026-10-06','2026-10-07','2026-10-08','2026-10-09','2026-10-12','2026-10-13','2026-10-14','2026-10-15','2026-10-16','2026-10-19','2026-10-21','2026-10-22',targetDate])
const round=(x,p=2)=>Number(x.toFixed(p))
function load(symbol) {
  const file=path.join(root,'db','candles',`${symbol}.jsonl`)
  if(!fs.existsSync(file))return []
  const map=new Map()
  for(const line of fs.readFileSync(file,'utf8').split(/\r?\n/)){
    if(!line)continue
    const x=JSON.parse(line),ms=Number(x.time)*1000
    if(ms+60_000<=cutoff&&allowed.has(stamp(ms).slice(0,10))&&Number.isFinite(Number(x.close))&&Number.isFinite(Number(x.open)))map.set(ms,{ms,open:Number(x.open),close:Number(x.close)})
  }
  return [...map.values()].sort((a,b)=>a.ms-b.ms)
}
function aggregate(rows,n){
  const out=[]
  for(const x of rows){
    const d=new Date(x.ms+offset),m=d.getUTCHours()*60+d.getUTCMinutes()
    if(m<555||m>=930)continue
    const key=`${stamp(x.ms).slice(0,10)}|${Math.floor((m-555)/n)}`
    let b=out.at(-1)
    if(b?.key!==key){b={key,count:0,last:x.ms,close:x.close};out.push(b)}
    b.count++;b.last=x.ms;b.close=x.close
  }
  // RSI and its averages use the interval close. A missing intermediate
  // one-minute candle does not hide a completed 5m/15m close; the final
  // minute of the interval must still be present.
  return out.filter(x=>{
    const d=new Date(x.last+offset),m=d.getUTCHours()*60+d.getUTCMinutes()
    return (m-555)%n===n-1
  }).map(x=>({...x,complete:x.last+60_000}))
}
function indicator(bars){
  let previous=null,gain=0,loss=0,ema=null
  const rsis=[]
  return bars.map((b,i)=>{
    const change=previous==null?0:b.close-previous;previous=b.close
    if(i<=9){gain+=Math.max(change,0);loss+=Math.max(-change,0)}
    if(i===9){gain/=9;loss/=9}
    else if(i>9){gain=(gain*8+Math.max(change,0))/9;loss=(loss*8+Math.max(-change,0))/9}
    const rsi=i<9?null:loss===0?(gain===0?50:100):100-100/(1+gain/loss)
    if(rsi!=null){rsis.push(rsi);ema=ema==null?rsi:(rsi+ema)/2}
    const wma=rsis.length<21?null:rsis.slice(-21).reduce((s,v,j)=>s+v*(j+1),0)/231
    return {...b,rsi,ema,wma}
  })
}
function angleAt(bars,key,i){
  if(i<3||!Number.isFinite(bars[i]?.[key])||!Number.isFinite(bars[i-3]?.[key]))return null
  return Math.atan((bars[i][key]-bars[i-3][key])/3)*180/Math.PI
}
function turnScore(bars,key,direction){
  const i=bars.length-1,current=angleAt(bars,key,i)
  if(current==null||direction*current<5)return {score:0,turnTime:null}
  for(let j=i;j>=Math.max(4,i-3);j--){
    const prior=angleAt(bars,key,j-1),after=angleAt(bars,key,j)
    if(prior!=null&&direction*prior<0&&direction*after>0){
      const age=i-j
      return {score:round(Math.min(10,Math.abs(current)/9)*(1-age/4)),turnTime:stamp(bars[j].complete)}
    }
  }
  return {score:0,turnTime:null}
}
const symbols=[...new Set(['NIFTY50',...(requestedSymbol?[requestedSymbol]:JSON.parse(fs.readFileSync(path.join(root,'db','stocks'),'utf8')))])]
const rows=[]
for(const symbol of symbols){
  const candles=load(symbol),last=candles.at(-1)?.ms+60_000
  if(!last||stamp(last).slice(0,10)!==targetDate||cutoff-last>2*60_000)continue
  const open=candles.find(x=>x.ms===openingCandle)?.open
  if(!(open>0))continue
  const frames={},scores={up:{},down:{}},angles={},turns={up:{},down:{}}
  let ready=true
  for(const n of [1,5,15]){
    const bars=indicator(aggregate(candles,n)),b=bars.at(-1)
    const completedToday=b&&stamp(b.complete).slice(0,10)===targetDate
    // Before the first 5m/15m close today, carry the last completed bar from
    // the prior session. Keep its date visible so it cannot look like a new turn.
    if(!b||bars.length<34||(completedToday&&cutoff-b.complete>n*60_000)||!Number.isFinite(b.wma)){ready=false;break}
    frames[`${n}m`]={complete:stamp(b.complete),carriedFromPriorSession:!completedToday,rsi:round(b.rsi),ema3:round(b.ema),wma21:round(b.wma)}
    for(const key of ['rsi','ema','wma']){
      const label=`${n}m_${key==='ema'?'ema3':key==='wma'?'wma21':'rsi'}`
      const degrees=round(angleAt(bars,key,bars.length-1))
      angles[label]=degrees
      for(const [name,direction] of [['up',1],['down',-1]]){
        const turn=turnScore(bars,key,direction)
        scores[name][label]=turn.score
        turns[name][label]=turn.turnTime
      }
    }
  }
  if(!ready)continue
  rows.push({symbol,lastCompleted:stamp(last),todayMovePct:round(100*(candles.at(-1).close/open-1)),frames,anglesDeg:angles,up:{total:round(Object.values(scores.up).reduce((a,b)=>a+b,0)),indicators:scores.up,turnTimes:turns.up},down:{total:round(Object.values(scores.down).reduce((a,b)=>a+b,0)),indicators:scores.down,turnTimes:turns.down}})
}
const minimumDirectionalAngleDeg=5
const eligible=(row,direction)=>Object.values(row[direction].indicators).every(value=>value>0)
for(const row of rows)for(const direction of ['up','down']){
  const frameScores=Object.fromEntries([1,5,15].map(n=>[`${n}m`,round(['rsi','ema3','wma21'].reduce((sum,key)=>sum+row[direction].indicators[`${n}m_${key}`],0))]))
  row[direction].frameScores=frameScores
  row[direction].total=round(Object.entries(frameScores).reduce((sum,[frame,score])=>sum+score*3*timeframeWeights[frame],0))
}
const nifty50=rows.find(x=>x.symbol==='NIFTY50')||null
const stockRows=rows.filter(x=>x.symbol!=='NIFTY50')
const up=[...stockRows].sort((a,b)=>b.up.total-a.up.total||a.symbol.localeCompare(b.symbol)).slice(0,10)
const down=[...stockRows].sort((a,b)=>b.down.total-a.down.total||a.symbol.localeCompare(b.symbol)).slice(0,10)
const output={date:targetDate,cutoffIST:stamp(cutoff),checkedAt:stamp(now),stocksScored:stockRows.length,timeframeWeightsPct:Object.fromEntries(Object.entries(timeframeWeights).map(([frame,value])=>[frame,round(value*100,4)])),nifty50:nifty50?{...nifty50,qualifiedUp:eligible(nifty50,'up'),qualifiedDown:eligible(nifty50,'down')}:null,minimumDirectionalAngleDeg,eligibleUp:stockRows.filter(x=>eligible(x,'up')).length,eligibleDown:stockRows.filter(x=>eligible(x,'down')).length,method:'Move % = 100*(last completed one-minute close at cutoff / target session 09:15 one-minute open - 1). Historical full-date cutoffs are supported. Completed 1m, 5m, 15m RSI9 Wilder, EMA3(RSI), WMA21(RSI). Before the first 5m or 15m close on the target date, the latest completed prior-session bar supplies that frame; its timestamp and carriedFromPriorSession flag are reported. Three-bar angle in degrees = atan((indicator now - indicator three completed bars earlier)/3), with one bar as one x-axis unit and one RSI point as one y-axis unit. An UP turn requires this angle to change from negative to positive; DOWN reverses signs. Turn must occur within the latest four completed bars and current angle must reach at least 5 degrees in the new direction. Each indicator scores 0-10. Weighted total = sum(timeframe score out of 30 * 3 * timeframe weight), maximum 90. Default weights are equal; --weights accepts 1m,5m,15m percentages. NIFTY50 is displayed separately above the stock top 10. Top-10 rankings include all scored stocks; qualified means all nine indicators recently turned in the chosen direction. Only candles at or before the cutoff are used.',top10Up:up.map(x=>({...x,qualified:eligible(x,'up')})),top10Down:down.map(x=>({...x,qualified:eligible(x,'down')})),rows:stockRows}
let i=0,file
do{file=path.join(root,'reports',`${targetDate}-${stamp(cutoff).slice(11).replace(':','')}-${requestedSymbol?`${requestedSymbol.toLowerCase()}-`:''}rsi-ema-wma-three-timeframe-turn-angle-rank${requestedWeights?`-weights-${weightParts.join('-')}`:''}${i?`-${i+1}`:''}.json`);i++}while(fs.existsSync(file))
fs.writeFileSync(file,JSON.stringify(output,null,2)+'\n',{flag:'wx'})
console.log(`Cutoff ${output.cutoffIST} IST | ${stockRows.length} stocks | weights 1m/5m/15m ${Object.values(output.timeframeWeightsPct).join('/')}% | today move from 09:15 open`)
console.log(nifty50
  ? `NIFTY 50  UP ${nifty50.up.total.toFixed(2)}/90 (${eligible(nifty50,'up')?'qualified':'partial'})  DOWN ${nifty50.down.total.toFixed(2)}/90 (${eligible(nifty50,'down')?'qualified':'partial'})  today ${nifty50.todayMovePct>=0?'+':''}${nifty50.todayMovePct.toFixed(2)}%  frames ${[1,5,15].map(n=>`${n}m ${nifty50.frames[`${n}m`].complete}${nifty50.frames[`${n}m`].carriedFromPriorSession?' prior':''}`).join(', ')} IST`
  : 'NIFTY 50  unavailable at this cutoff')
if(requestedSymbol&&requestedSymbol!=='NIFTY50'){
  const selected=stockRows.find(x=>x.symbol===requestedSymbol)
  if(selected)console.log(JSON.stringify(selected,null,2))
}
for(const direction of ['up','down']){
  console.log(`${direction.toUpperCase()} top 10 (turn score /90, today move %, all nine turned)`)
  for(const [index,row] of (direction==='up'?up:down).entries())console.log(`${String(index+1).padStart(2)} ${row.symbol.padEnd(16)} ${row[direction].total.toFixed(2).padStart(6)} ${`${row.todayMovePct>=0?'+':''}${row.todayMovePct.toFixed(2)}%`.padStart(8)} ${eligible(row,direction)?'YES':'no'}`)
}
console.log(`Full report: ${file}`)
