import fs from 'node:fs'
import path from 'node:path'

// Usage: node scripts/score-sammaancap-30-indicators-2026-10-29.js SYMBOL YYYY-MM-DD HH:MM [--stdout]
// Example: node scripts/score-sammaancap-30-indicators-2026-10-29.js SAMMAANCAP 2026-10-29 09:30
// The cutoff is IST and exclusive: a 09:30 score uses completed candles through
// 09:29 and depth received before 09:30. "Best" is direction-neutral.
const args = process.argv.slice(2), stdoutOnly = args.includes('--stdout')
const positional = args.filter(x => x !== '--stdout')
const [rawSymbol = 'SAMMAANCAP', date = '2026-10-29', cutoffText = '09:30'] = positional
const symbol = rawSymbol.toUpperCase().replace(/-EQ$/, '')
const cutoffMatch = /^(\d{2}):(\d{2})$/.exec(cutoffText)
if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !cutoffMatch) throw new Error('Usage: node scripts/score-sammaancap-30-indicators-2026-10-29.js SYMBOL YYYY-MM-DD HH:MM [--stdout]')
const cutoff = Number(cutoffMatch[1]) * 60 + Number(cutoffMatch[2])
if (cutoff < 556 || cutoff > 930) throw new Error('Cutoff must be between 09:16 and 15:30 IST.')
const root = process.cwd()
const ist = epoch => new Date(Number(epoch) * 1000 + 330 * 60_000)
const mean = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : null
const round = (x, p = 4) => Number.isFinite(x) ? Number(x.toFixed(p)) : null
function stamp(t) { const d = ist(t); return { day: d.toISOString().slice(0, 10), minute: d.getUTCHours() * 60 + d.getUTCMinutes() } }
function ema(values, n) { const k = 2 / (n + 1); return values.reduce((e, x, i) => i ? k * x + (1 - k) * e : x, 0) }
function trueRange(r, prev) { return Math.max(r.high - r.low, Math.abs(r.high - prev.close), Math.abs(r.low - prev.close)) }
function atr(rows, n = 14) { return mean(rows.slice(-n).map((r, i, a) => trueRange(r, a[i - 1] ?? rows[rows.length - n - 1] ?? r))) }
function rsi(values, n = 14) { const d = values.slice(-(n + 1)).slice(1).map((x, i, a) => x - values.slice(-(n + 1))[i]); const g = mean(d.map(x => Math.max(x, 0))), l = mean(d.map(x => Math.max(-x, 0))); return l ? 100 - 100 / (1 + g / l) : g ? 100 : 50 }
function regression(values) { const n = values.length, xm = (n - 1) / 2, ym = mean(values); let num = 0, den = 0, sy = 0; values.forEach((y, i) => { num += (i - xm) * (y - ym); den += (i - xm) ** 2; sy += (y - ym) ** 2 }); const slope = num / den, r2 = sy ? num * num / (den * sy) : 0; return { slope, r2 } }
function percentile(a, p) { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor((s.length - 1) * p)] : null }
function candleData() { const file = path.join(root, 'db', 'candles', `${symbol}.jsonl`), out = []; for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) { if (!line) continue; let x; try { x = JSON.parse(line) } catch { continue }; const s = stamp(x.time); if (s.day > date || (s.day === date && s.minute >= cutoff) || s.minute < 555 || s.minute >= 930) continue; if ([x.open, x.high, x.low, x.close, x.volume].every(Number.isFinite) && +x.volume > 0) out.push({ ...x, ...s, open:+x.open, high:+x.high, low:+x.low, close:+x.close, volume:+x.volume }) } return out.sort((a,b) => a.time-b.time) }
function depthData() { const file = path.join(root, 'db', 'cash-depth', date, symbol, `${symbol}.jsonl`); const state = {}, out = []; if (!fs.existsSync(file)) return out; for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) { if (!line) continue; let x; try { x = JSON.parse(line) } catch { continue }; const s = stamp(Date.parse(x.receivedAt) / 1000); if (s.day !== date || s.minute >= cutoff) continue; if (x.kind === 'checkpoint') for (const k of Object.keys(state)) delete state[k]; Object.assign(state, x.data ?? {}); let bid = 0, ask = 0, valid = true; for (let n=1;n<=5;n++) { const bp=+state[`bid_price${n}`], ap=+state[`ask_price${n}`], bs=+state[`bid_size${n}`], as=+state[`ask_size${n}`]; if (![bp,ap,bs,as].every(Number.isFinite) || ap <= bp) { valid=false; break } bid += bs; ask += as } if (valid) out.push(100 * bid / (bid + ask)) } return out }
const all = candleData(), today = all.filter(x => x.day === date), recent = all.slice(-15), closes = all.map(x => x.close), rows = all.slice(-60), c = recent.map(x => x.close), last = recent.at(-1), prev = all.filter(x => x.day < date), directions = x => x > 0 ? 'bullish' : x < 0 ? 'bearish' : 'neutral'
if (!today.length) throw new Error(`No positive-volume candle for ${date} before the cutoff`)
if (recent.length !== 15) throw new Error(`Expected at least 15 positive-volume candles before cutoff, got ${recent.length}`)
const e10 = ema(closes,10), e20 = ema(closes,20), e50 = ema(closes,50), e10p = ema(closes.slice(0,-3),10), e20p = ema(closes.slice(0,-3),20)
const sessionVWAP = today.reduce((s,x)=>s+((x.high+x.low+x.close)/3)*x.volume,0)/today.reduce((s,x)=>s+x.volume,0)
const vwapEarly = today.slice(0,5).reduce((s,x)=>s+((x.high+x.low+x.close)/3)*x.volume,0)/today.slice(0,5).reduce((s,x)=>s+x.volume,0)
const trs = rows.slice(1).map((x,i)=>trueRange(x,rows[i])), currentATR = mean(trs.slice(-14)), priorATR = mean(trs.slice(-24,-10))
const up = rows.slice(1).map((x,i)=>Math.max(0,x.high-rows[i].high)), down = rows.slice(1).map((x,i)=>Math.max(0,rows[i].low-x.low)), pdi=100*mean(up.slice(-14))/(currentATR||1), mdi=100*mean(down.slice(-14))/(currentATR||1), adx=100*Math.abs(pdi-mdi)/(pdi+mdi||1)
const macdAt = n => ema(closes.slice(0,n),12)-ema(closes.slice(0,n),26), macds=[-3,-2,-1].map(i=>macdAt(closes.length+i)); const signalAt=n=>ema(Array.from({length:9},(_,i)=>macdAt(n-8+i)),9); const hist=macds.map((m,i)=>m-signalAt(closes.length-3+i)); const macdGap=macds.at(-1)-signalAt(closes.length)
const rsis = [-2,-1,0].map(i=>rsi(closes.slice(0, closes.length+i),14)); const rsiNow=rsis.at(-1); const rsi14=rsi(closes,14)
const rsiSeries=closes.map((_,i)=>i>=14?rsi(closes.slice(0,i+1),14):50), stochWindow=rsiSeries.slice(-14), stoch=(rsiNow-Math.min(...stochWindow))/(Math.max(...stochWindow)-Math.min(...stochWindow)||1)
const typical=rows.map(x=>(x.high+x.low+x.close)/3), tpMean=mean(typical.slice(-20)), md=mean(typical.slice(-20).map(x=>Math.abs(x-tpMean))), cci=(typical.at(-1)-tpMean)/(.015*(md||1))
const roc=100*(last.close/closes.at(-11)-1), basis=ema(closes,20), sd=Math.sqrt(mean(closes.slice(-20).map(x=>(x-basis)**2))), bandWidth=400*sd/(basis||1), prevBasis=ema(closes.slice(0,-3),20), prevSd=Math.sqrt(mean(closes.slice(-23,-3).map(x=>(x-prevBasis)**2))), prevBandWidth=400*prevSd/(prevBasis||1), pb=(last.close-(basis-2*sd))/(4*sd||1)
const kcOuter=basis+2*currentATR, kcLower=basis-2*currentATR
let obv=0, ad=0; const obvs=[], ads=[]; for(let i=1;i<recent.length;i++){obv += recent[i].close>recent[i-1].close?recent[i].volume:recent[i].close<recent[i-1].close?-recent[i].volume:0; obvs.push(obv); ad += (recent[i].high===recent[i].low?0:(2*recent[i].close-recent[i].high-recent[i].low)/(recent[i].high-recent[i].low))*recent[i].volume; ads.push(ad)}
let pos=0, neg=0; for(let i=1;i<recent.length;i++){const a=(recent[i-1].high+recent[i-1].low+recent[i-1].close)/3,b=(recent[i].high+recent[i].low+recent[i].close)/3,f=b*recent[i].volume;if(b>a)pos+=f;else if(b<a)neg+=f}; const mfi=neg?100-100/(1+pos/neg):pos?100:50
const donchianHigh=Math.max(...closes.slice(-21,-1)), donchianLow=Math.min(...closes.slice(-21,-1)); const sumTR=trs.slice(-14).reduce((a,b)=>a+b,0), range20=Math.max(...rows.slice(-14).map(x=>x.high))-Math.min(...rows.slice(-14).map(x=>x.low)), chop=100*Math.log10(sumTR/(range20||1))/Math.log10(14)
const reg=regression(c), openingVolumes = []; for (const day of [...new Set(prev.map(x=>x.day))].slice(-20)) { const d=prev.filter(x=>x.day===day && x.minute<cutoff); if(d.length===today.length) openingVolumes.push(d.reduce((s,x)=>s+x.volume,0)) }; const relVol=today.reduce((s,x)=>s+x.volume,0)/(mean(openingVolumes)||1)
const depth=depthData(), bidShare=mean(depth), depthPersistent=depth.length?100*depth.filter(x=>x>=60||x<=40).length/depth.length:0
const sign=last.close-sessionVWAP, side=directions(sign)
const indicators=[
 ['ADX (14)', adx, adx>30, 'ADX > 30'], ['DI separation', pdi-mdi, Math.abs(pdi-mdi)>10, '|+DI − −DI| > 10'],
 ['EMA 10 / 20', 100*(e10/e20-1), (e10>e20&&e20>e20p&&e10-e20>e10p-e20p)||(e10<e20&&e20<e20p&&e10-e20<e10p-e20p), 'aligned and widening'],
 ['EMA 20 / 50',100*(e20/e50-1),(e20>e50&&e20>e20p)||(e20<e50&&e20<e20p),'aligned with slope'],
 ['Price vs VWAP',100*(last.close/sessionVWAP-1),Math.abs(last.close/sessionVWAP-1)>=0.002 && today.slice(-5).every(x=>(x.close-sessionVWAP)*sign>0),'≥0.20% one side, last 5 hold'],
 ['VWAP slope',100*(sessionVWAP/vwapEarly-1),Math.abs(sessionVWAP/vwapEarly-1)>=0.002,'|slope| ≥ 0.20%'],
 ['Supertrend proxy',100*(last.close/basis-1),Math.abs(last.close-basis)>2*currentATR,'outside 2×ATR channel'],
 ['MACD histogram',hist.at(-1),Math.abs(hist[2])>Math.abs(hist[1])&&Math.abs(hist[1])>Math.abs(hist[0])&&Math.sign(hist[2])===Math.sign(hist[0]),'same sign, expanding 3 bars'],
 ['MACD / signal separation',macdGap,Math.abs(macdGap)>0.1*currentATR,'gap > 0.1×ATR'], ['RSI (14)',rsi14,(rsi14>=60&&rsi14<=80)||(rsi14>=20&&rsi14<=40),'60–80 or 20–40'],
 ['RSI range shift',rsiNow,rsis.every(x=>x>50)||rsis.every(x=>x<50),'3 readings one side of 50'], ['Stochastic RSI',stoch,(stoch>=.8&&rsis.every(x=>x>50))||(stoch<=.2&&rsis.every(x=>x<50)),'extreme with RSI confirmation'],
 ['CCI (20)',cci,Math.abs(cci)>100,'|CCI| > 100'], ['ROC (10)',roc,Math.abs(roc)>1,'|ROC| > 1%'], ['Momentum (10)',roc,Math.abs(roc)>1,'|10-bar momentum| > 1%'],
 ['Bollinger width',bandWidth,bandWidth>prevBandWidth*1.2,'>20% expansion'], ['Bollinger position',pb,pb>=1||pb<=0,'at/outside outer band'], ['Keltner channel',100*(last.close/basis-1),recent.slice(-3).every(x=>x.close>kcOuter)||recent.slice(-3).every(x=>x.close<kcLower),'3 closes beyond outer channel'],
 ['ATR / price',100*currentATR/last.close,currentATR>percentile(trs,0.7),'above 70th percentile'], ['ATR expansion',100*(currentATR/(priorATR||1)-1),currentATR>priorATR*1.2,'>20% above earlier ATR'],
 ['Relative volume',relVol,relVol>2,'>2.0× same-cutoff opening average'], ['Volume trend',recent.slice(-5).reduce((s,x)=>s+x.volume,0)/recent.slice(0,5).reduce((s,x)=>s+x.volume,0),recent.slice(-5).reduce((s,x)=>s+x.volume,0)>1.5*recent.slice(0,5).reduce((s,x)=>s+x.volume,0)&&Math.sign(roc)===Math.sign(last.close-recent[0].open),'last 5 >1.5× first 5, aligned'],
 ['OBV',obv,obv===Math.max(...obvs)||obv===Math.min(...obvs),'new session extreme'], ['MFI (14)',mfi,mfi>60||mfi<40,'>60 or <40'], ['A/D line',ad,ad===Math.max(...ads)||ad===Math.min(...ads),'new session extreme'],
 ['Donchian (20)',last.close,last.close>donchianHigh||last.close<donchianLow,'20-bar breakout'], ['Choppiness (14)',chop,chop<38,'<38'], ['Regression slope',100*reg.slope/mean(c),Math.abs(reg.slope/mean(c))>=.0003,'|slope| ≥0.03%/bar'], ['R-squared',reg.r2,reg.r2>.7,'>0.70'],
 ['Top-5 depth imbalance',bidShare,(bidShare>=60||bidShare<=40)&&depthPersistent>=70,'≥60:40 and persistent ≥70%']
].map(([indicator,value,best,rule])=>({indicator,value:round(value),best,rule}))
const cutoffLabel = `${String(Math.floor(cutoff / 60)).padStart(2, '0')}:${String(cutoff % 60).padStart(2, '0')}`
const completedThrough = cutoff - 1
const completedLabel = `${String(Math.floor(completedThrough / 60)).padStart(2, '0')}:${String(completedThrough % 60).padStart(2, '0')}`
const best=indicators.filter(x=>x.best), out={symbol:`${symbol}-EQ`,date,asOfIST:`${cutoffLabel} (uses completed candles through ${completedLabel} only)`,direction:side,bestCount:best.length,totalIndicators:30,bestIndicators:best,notBest:indicators.filter(x=>!x.best),keyValues:{close:last.close,sessionVWAP:round(sessionVWAP),adx:round(adx),pdi:round(pdi),mdi:round(mdi),depthSnapshots:depth.length,currentSessionPositiveVolumeCandles:today.length,technicalWindow:'Last 15 positive-volume candles, rolling into the prior session when needed.'},methodology:'Rules operationalize the Best thresholds stated in the preceding response. Zero-volume candles are excluded. Values are computed solely from locally recorded one-minute candles and top-five depth available before the cutoff.'}
if (stdoutOnly) console.log(JSON.stringify(out))
else { const safeCutoff=cutoffLabel.replace(':',''); let n=1,file; do { file=path.join(root,'reports',`${date}-${symbol}-${safeCutoff}-30-indicator-best-score${n===1?'':`-${n}`}.json`); n++ } while(fs.existsSync(file)); fs.writeFileSync(file,JSON.stringify(out,null,2)+'\n',{flag:'wx'}); console.log(JSON.stringify({file,bestCount:out.bestCount,direction:out.direction,best:best.map(x=>({indicator:x.indicator,value:x.value}))},null,2)) }
