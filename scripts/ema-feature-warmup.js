import {loadCandles,MINUTE} from './research-ema-coverage.js'

function endsByFrame(rows){
  const map=new Map([[1,rows.map(r=>r.t+MINUTE)]])
  if(!rows.length)return map
  const open=Date.parse(`${new Date(rows[0].t+330*MINUTE).toISOString().slice(0,10)}T09:15:00+05:30`)
  for(const frame of [3,5,10,15]){
    const slots=new Map()
    for(const r of rows){const t=open+Math.floor((r.t-open)/(frame*MINUTE))*frame*MINUTE;slots.set(t,(slots.get(t)||0)+1)}
    map.set(frame,[...slots].filter(([,n])=>n===frame).map(([t])=>t+frame*MINUTE).sort((a,b)=>a-b))
  }
  return map
}
function completedCount(ends,t){let low=0,high=ends.length;while(low<high){const mid=(low+high)>>>1;if(ends[mid]<=t)low=mid+1;else high=mid}return low}
function minimum(name){
  const period=+(name.match(/\d+$/)?.[0]||0)
  if(/^(ret|atr|slope|fit|angle|range|meanRange)\d+$/.test(name))return period
  if(/^(rsi|mfi|volRatio|breakout)\d+$/.test(name))return period+1
  return 0
}
export function enforceWarmup(events){
  const nifty=new Map([...loadCandles('NIFTY50')].map(([date,rows])=>[date,endsByFrame(rows)]))
  let removed=0
  for(const [symbol,group]of Map.groupBy(events,e=>e.symbol)){
    const stock=new Map([...loadCandles(symbol)].map(([date,rows])=>[date,endsByFrame(rows)]))
    for(const e of group)for(const key of Object.keys(e.features)){
      if(key.startsWith('cross_')||key.startsWith('depth'))continue
      let name=key;const market=name.startsWith('nifty_');if(market)name=name.slice(6)
      const tf=name.match(/^tf(\d+)_(.+)$/),frame=tf?+tf[1]:1;if(tf)name=tf[2]
      const needed=minimum(name);if(!needed)continue
      const ends=(market?nifty:stock).get(e.date)?.get(frame)||[]
      if(completedCount(ends,e.signalAt)<needed){delete e.features[key];removed++}
    }
  }
  return {removed,policy:'Every named rolling-period feature requires its full number of actual completed bars; RSI/MFI require period+1 and volume/breakout require full prior window. Partial-period ATR, trend and volume-ratio values are excluded.'}
}
