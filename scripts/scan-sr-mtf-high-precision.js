#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import apiV3 from 'fyers-api-v3'
import { createCandleStore, normalizeCandle } from '../ui/candles.js'
import { toFyersIndexSymbol, toFyersSymbol } from '../ui/market-data.js'

const ROOT = process.cwd()
const REPORTS = path.join(ROOT, 'reports')
const SOURCE_SCANNER = path.join(ROOT, 'scripts', 'research-oct29-mover-support-resistance-mtf.js')
const IST_OFFSET_MS = 330 * 60_000

const arg = name => {
  const index = process.argv.indexOf(name)
  return index < 0 ? null : process.argv[index + 1]
}
const has = name => process.argv.includes(name)
const fail = message => { console.error(message); process.exit(1) }
const round = (value, digits = 3) => Number.isFinite(value) ? +value.toFixed(digits) : null
const dateAt = timestamp => new Date(timestamp + IST_OFFSET_MS).toISOString().slice(0, 10)
const timeAt = timestamp => new Date(timestamp + IST_OFFSET_MS).toISOString().slice(11, 16)
const minuteOf = value => { const [hour, minute] = value.split(':').map(Number); return hour * 60 + minute }
const csvValue = value => /[",\n]/.test(String(value ?? '')) ? `"${String(value ?? '').replaceAll('"', '""')}"` : String(value ?? '')

const usage = [
  'Usage:',
  '  node scripts/scan-sr-mtf-high-precision.js --date YYYY-MM-DD',
  '  node scripts/scan-sr-mtf-high-precision.js --from YYYY-MM-DD --to YYYY-MM-DD',
  '',
  'Options:',
  '  --signal-cutoff HH:mm  Last allowed signal time (default 10:15, maximum 10:30)',
  '  --exit-cutoff HH:mm    Intraday exit cutoff (default 15:29)',
  '  --target PCT           Profit target percentage (default 1.10)',
  '  --stop PCT             Stop-loss percentage (default 0.80)',
  '  --profile NAME         Rule profile: core or strict (default strict)',
  '  --reuse                Reuse the latest universe scan CSV for each date',
  '  --no-fetch             Do not fetch missing candle sessions from FYERS',
].join('\n')

if (has('--help') || has('-h')) { console.log(usage); process.exit(0) }
const oneDate = arg('--date'), fromArg = arg('--from'), toArg = arg('--to')
if (oneDate && (fromArg || toArg)) fail('Use either --date or --from/--to, not both.')
if (!oneDate && (!fromArg || !toArg)) fail(`${usage}\n\nProvide --date or both --from and --to.`)
const validateDate = value => {
  const parsed=new Date(`${value}T00:00:00Z`)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value ?? '') || Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0,10)!==value) fail(`Invalid calendar date: ${value}`)
  return value
}
const from = validateDate(oneDate ?? fromArg), to = validateDate(oneDate ?? toArg)
if (from > to) fail('--from must be on or before --to.')
const requestedProfile = (arg('--profile') ?? 'strict').toLowerCase()
const profile = ({oct14:'core',oct06:'strict'})[requestedProfile] ?? requestedProfile
if (!['core','strict'].includes(profile)) fail(`Invalid --profile: ${requestedProfile}. Use core or strict.`)
const signalCutoff = arg('--signal-cutoff') ?? '10:15'
const exitCutoff = arg('--exit-cutoff') ?? '15:29'
for (const [name,value] of [['signal cutoff',signalCutoff],['exit cutoff',exitCutoff]]) if (!/^\d{2}:\d{2}$/.test(value) || minuteOf(value) < 555 || minuteOf(value) > 929) fail(`Invalid ${name}: ${value}`)
if (minuteOf(signalCutoff) > 630) fail('--signal-cutoff cannot exceed 10:30 because the causal source scanner stops at 10:30.')
if (minuteOf(exitCutoff) <= minuteOf(signalCutoff)) fail('--exit-cutoff must be after --signal-cutoff.')
const targetPct = Number(arg('--target') ?? 1.10), stopPct = Number(arg('--stop') ?? .80)
if (!(targetPct > 1) || !(stopPct > 0)) fail('--target must be greater than 1%; --stop must be positive.')

function calendarDates() {
  const dates=[]
  for (let value=new Date(`${from}T00:00:00Z`); value<=new Date(`${to}T00:00:00Z`); value.setUTCDate(value.getUTCDate()+1)) dates.push(value.toISOString().slice(0,10))
  return dates
}

function epochForIst(date,hour,minute) {
  const [year,month,day]=date.split('-').map(Number)
  return Math.floor(Date.UTC(year,month-1,day,hour-5,minute-30)/1000)
}

function storedSessionDates(symbol) {
  const file=path.join(ROOT,'db','candles',`${symbol}.jsonl`), dates=new Set()
  if (!fs.existsSync(file)) return dates
  for (const line of fs.readFileSync(file,'utf8').split(/\r?\n/)) {
    if (!line) continue
    try {
      const row=JSON.parse(line), date=dateAt(Number(row.time)*1000)
      if (date>=from&&date<=to) dates.add(date)
    } catch {}
  }
  return dates
}

async function fyersContext(symbols) {
  let token=''
  try { token=JSON.parse(fs.readFileSync(path.join(ROOT,'db','token'),'utf8')) } catch {}
  if (typeof token!=='string'||!token.trim()) throw new Error('FYERS access token is missing. Run AutoLogin before backfilling candles.')
  const { CONSTANT }=await import('../constant.js')
  const client=new apiV3.fyersModel({enableLogging:false})
  client.setAppId(CONSTANT.appId)
  client.setAccessToken(token.trim())
  const store=await createCandleStore({directory:path.join(ROOT,'db','candles'),symbols})
  return {client,store}
}

async function fetchSymbols(symbols, allSymbols, label) {
  if (!symbols.length) return {added:0,failures:[]}
  const {client,store}=await fyersContext(allSymbols)
  let added=0
  const failures=[]
  console.log(`Missing candle data detected: fetching ${symbols.length} ${label} from FYERS (${from} to ${to})...`)
  for (let index=0;index<symbols.length;index++) {
    const symbol=symbols[index]
    try {
      const response=await client.getHistory({
        symbol:symbol==='NIFTY50'?toFyersIndexSymbol(symbol):toFyersSymbol(symbol),
        resolution:'1',date_format:'0',
        range_from:String(epochForIst(from,9,15)),range_to:String(epochForIst(to,15,30)-1),cont_flag:'1',
      })
      if (response?.s!=='ok'||!Array.isArray(response.candles)) throw new Error(response?.message||response?.msg||'FYERS returned no candle data')
      const incoming=response.candles.flatMap(row=>{
        if (!Array.isArray(row)||row.length<6) return []
        const candle=normalizeCandle({time:+row[0],open:+row[1],high:+row[2],low:+row[3],close:+row[4],volume:+row[5],source:'fyers-history'})
        return candle&&dateAt(candle.time*1000)>=from&&dateAt(candle.time*1000)<=to?[candle]:[]
      })
      const result=await store.fillMissingHistory(symbol,incoming)
      added+=result.added
      process.stdout.write(`\rFYERS history ${index+1}/${symbols.length}: ${symbol} · added ${added}`)
    } catch(error) {
      failures.push({symbol,message:error.message})
      process.stdout.write(`\rFYERS history ${index+1}/${symbols.length}: ${symbol} · failures ${failures.length}`)
    }
    if(index<symbols.length-1) await new Promise(resolve=>setTimeout(resolve,400))
  }
  process.stdout.write('\n')
  return {added,failures}
}

const authenticationFailure = result => result.failures.some(item=>/auth|token|unauthor/i.test(item.message))
async function fetchWithAuthenticationRetry(symbols,allSymbols,label) {
  let result=await fetchSymbols(symbols,allSymbols,label)
  if(!authenticationFailure(result)) return result
  console.log('FYERS rejected the saved token. Running AutoLogin once, then retrying the failed history request...')
  const {autoLogin}=await import('../autologin.js')
  await autoLogin()
  const failed=new Set(result.failures.map(item=>item.symbol))
  const retry=await fetchSymbols(symbols.filter(symbol=>failed.has(symbol)),allSymbols,`${label} retry`)
  return {added:result.added+retry.added,failures:retry.failures}
}

async function ensureCandleData() {
  if (has('--no-fetch')) return
  const stocks=JSON.parse(fs.readFileSync(path.join(ROOT,'db','stocks'),'utf8'))
  const allSymbols=[...new Set([...stocks,'NIFTY50'])]
  const requestedWeekdays=calendarDates().filter(date=>{const day=new Date(`${date}T00:00:00Z`).getUTCDay();return day!==0&&day!==6})
  let niftySessions=storedSessionDates('NIFTY50')
  const missingSentinelDates=requestedWeekdays.filter(date=>!niftySessions.has(date))
  if(!missingSentinelDates.length) return
  const indexResult=await fetchWithAuthenticationRetry(['NIFTY50'],allSymbols,'index')
  if(indexResult.failures.length) throw new Error(`FYERS NIFTY50 backfill failed: ${indexResult.failures[0].message}`)
  niftySessions=storedSessionDates('NIFTY50')
  const fetchedSessions=missingSentinelDates.filter(date=>niftySessions.has(date))
  // Dates still absent after the index request are weekends/exchange holidays.
  if(!fetchedSessions.length) return
  const result=await fetchWithAuthenticationRetry(stocks,allSymbols,'stock symbol(s)')
  if(result.failures.length) console.warn(`FYERS candle backfill completed with ${result.failures.length} failure(s): ${result.failures.slice(0,5).map(item=>`${item.symbol}: ${item.message}`).join('; ')}`)
  const stillMissing=stocks.filter(symbol=>{const available=storedSessionDates(symbol);return fetchedSessions.some(date=>!available.has(date))})
  if(stillMissing.length) console.warn(`${stillMissing.length} stock(s) still have no candles for at least one requested session and will be skipped where unavailable: ${stillMissing.slice(0,20).join(', ')}${stillMissing.length>20?'…':''}`)
}

function availableSessions() {
  const sessions = new Set()
  const file = path.join(ROOT, 'db', 'candles', 'NIFTY50.jsonl')
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!line) continue
    try { const row = JSON.parse(line); sessions.add(dateAt(Number(row.time) * 1000)) } catch {}
  }
  return [...sessions].filter(date => date >= from && date <= to).sort()
}

function latestUniverseCsv(date) {
  const prefix = `${date}-top-movers-support-resistance-price-action-mtf-universe-first-signal`
  return fs.readdirSync(REPORTS)
    .filter(name => name.startsWith(prefix) && name.endsWith('.csv'))
    .map(name => path.join(REPORTS, name))
    .sort((left,right) => fs.statSync(right).mtimeMs - fs.statSync(left).mtimeMs)[0]
}

function generateUniverseScan(date) {
  const result = spawnSync(process.execPath, [SOURCE_SCANNER, date, '--universe'], {
    cwd: ROOT, encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024,
  })
  if (result.status !== 0) throw new Error(`Source scan failed for ${date}: ${result.stderr || result.stdout}`)
  const file = latestUniverseCsv(date)
  if (!file) throw new Error(`Source scan produced no universe CSV for ${date}`)
  return file
}

function readCsv(file, date) {
  const text = fs.readFileSync(file, 'utf8').trim()
  if (!text) return []
  const [header,...lines] = text.split(/\r?\n/), names = header.split(',')
  return lines.filter(Boolean).map(line => {
    const values = line.split(',')
    const row = Object.fromEntries(values.map((value,index) => [names[index], value]))
    for (const key of ['entryPrice','mtfAligned','signalMoveFromOpenPct','breakoutDistancePct','volumeRatio10','efficiency10']) row[key] = Number(row[key])
    for (const key of ['tf1','tf3','tf5','tf10','tf15']) row[key] = row[key] === 'true'
    return {...row,date}
  })
}

function passesBase(row) {
  return row.tf10 && row.mtfAligned >= 4 && row.signalMoveFromOpenPct >= 1.5 &&
    row.breakoutDistancePct >= 0.15 && row.breakoutDistancePct <= 0.25 &&
    minuteOf(row.signalTime) <= minuteOf(signalCutoff)
}

function rejectionReason(row) {
  if (row.side === 'SELL' && row.volumeRatio10 > 3 && row.volumeRatio10 <= 10 && row.efficiency10 < 0.70) return 'SELL_HIGH_VOLUME_LOW_EFFICIENCY'
  if (row.side === 'BUY' && row.volumeRatio10 < 1 && row.signalMoveFromOpenPct >= 3) return 'LOW_VOLUME_EXTENDED_BUY'
  if (row.breakoutDistancePct >= 0.20 && row.volumeRatio10 >= 0.75 && row.volumeRatio10 <= 1.50) return 'DEEP_BREAK_LOW_MEDIUM_VOLUME'
  if (row.volumeRatio10 >= 2 && row.efficiency10 <= 0.35) return 'HIGH_VOLUME_CHURN'
  if (profile === 'core') return null
  if (row.side === 'BUY' && row.volumeRatio10 >= 3) return 'EXTREME_VOLUME_BUY'
  if (String(row.level).startsWith('OR15') && row.volumeRatio10 <= 0.75) return 'LOW_VOLUME_OR15'
  if (row.volumeRatio10 >= 2.5 && minuteOf(row.signalTime) >= 570 && minuteOf(row.signalTime) <= 575) return 'OPENING_HIGH_VOLUME_STALL'
  return null
}

const candleCache = new Map()
function dayCandles(symbol, date) {
  const cacheKey = `${symbol}|${date}`
  if (candleCache.has(cacheKey)) return candleCache.get(cacheKey)
  const file = path.join(ROOT, 'db', 'candles', `${symbol}.jsonl`), rows = []
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!line) continue
    try {
      const value = JSON.parse(line), timestamp = Number(value.time) * 1000
      if (dateAt(timestamp) !== date) continue
      rows.push({timestamp,time:timeAt(timestamp),open:+value.open,high:+value.high,low:+value.low,close:+value.close})
    } catch {}
  }
  rows.sort((a,b) => a.timestamp-b.timestamp)
  candleCache.set(cacheKey,rows)
  return rows
}

function execute(row) {
  const side = row.side, entry = row.entryPrice
  const target = side === 'BUY' ? entry * (1 + targetPct / 100) : entry * (1 - targetPct / 100)
  const stop = side === 'BUY' ? entry * (1 - stopPct / 100) : entry * (1 + stopPct / 100)
  const path = dayCandles(row.symbol,row.date).filter(bar => bar.time >= row.entryTime && bar.time <= exitCutoff)
  if (!path.length) return {...row,error:'No entry/exit candles'}
  let favorable = entry, adverse = entry, exitPrice = path.at(-1).close, exitTime = path.at(-1).time, exitReason = 'CUTOFF'
  for (const bar of path) {
    favorable = side === 'BUY' ? Math.max(favorable,bar.high) : Math.min(favorable,bar.low)
    adverse = side === 'BUY' ? Math.min(adverse,bar.low) : Math.max(adverse,bar.high)
    const hitTarget = side === 'BUY' ? bar.high >= target : bar.low <= target
    const hitStop = side === 'BUY' ? bar.low <= stop : bar.high >= stop
    // With one-minute OHLC the intrabar order is unknown; charge the stop when both occur.
    if (hitStop) { exitPrice=stop; exitTime=bar.time; exitReason=hitTarget?'STOP_SAME_BAR_AS_TARGET':'STOP'; break }
    if (hitTarget) { exitPrice=target; exitTime=bar.time; exitReason='TARGET'; break }
  }
  const direction = side === 'BUY' ? 1 : -1
  const returnPct = direction * 100 * (exitPrice / entry - 1)
  const mfePct = side === 'BUY' ? 100*(favorable/entry-1) : 100*(entry/favorable-1)
  const maePct = side === 'BUY' ? Math.min(0,100*(adverse/entry-1)) : Math.min(0,100*(entry/adverse-1))
  return {...row,targetPrice:round(target),stopPrice:round(stop),exitTime,exitPrice:round(exitPrice),exitReason,returnPct:round(returnPct),mfePct:round(mfePct),maePct:round(maePct)}
}

try { await ensureCandleData() } catch(error) { fail(`Candle backfill failed: ${error.message}`) }
const dates = availableSessions()
if (!dates.length) fail(`No NSE sessions found from ${from} through ${to}.`)
const accepted = [], rejected = [], daily = []
for (let index=0; index<dates.length; index++) {
  const date = dates[index]
  process.stdout.write(`[${index+1}/${dates.length}] ${date}: `)
  const existing = latestUniverseCsv(date)
  const file = has('--reuse') && existing ? existing : generateUniverseScan(date)
  const candidates = readCsv(file,date).filter(passesBase)
  const dayAccepted=[]
  for (const row of candidates) {
    const reason = rejectionReason(row)
    if (reason) rejected.push({...row,rejectionReason:reason})
    else dayAccepted.push(execute(row))
  }
  accepted.push(...dayAccepted)
  const total = dayAccepted.reduce((sum,row)=>sum+(row.returnPct??0),0)
  daily.push({date,signals:dayAccepted.length,winners:dayAccepted.filter(row=>row.returnPct>0).length,totalReturnPct:round(total)})
  console.log(`${dayAccepted.length} signal(s), ${candidates.length-dayAccepted.length} rejected.`)
}

const winners = accepted.filter(row => row.returnPct > 0), returns = accepted.map(row=>row.returnPct), maes=accepted.map(row=>row.maePct)
const activeDays=daily.filter(row=>row.signals)
const summary = {
  profile:profile.toUpperCase(),from,to,sessionCount:dates.length,tradeCount:accepted.length,winners:winners.length,
  winRatePct:accepted.length?round(100*winners.length/accepted.length):null,
  averageReturnPct:accepted.length?round(returns.reduce((a,b)=>a+b,0)/accepted.length):null,
  totalReturnPct:round(returns.reduce((a,b)=>a+b,0)),
  maximumAdverseExcursionPct:maes.length?round(Math.min(...maes)):null,
  worstDay:activeDays.length?[...activeDays].sort((a,b)=>a.totalReturnPct-b.totalReturnPct)[0]:null,
  rejectedSignalCount:rejected.length,targetPct,stopPct,signalCutoff,exitCutoff,
}

function unique(stem,extension) { let suffix=1,file; do { file=path.join(REPORTS,`${stem}${suffix===1?'':`-${suffix}`}.${extension}`); suffix++ } while(fs.existsSync(file)); return file }
const stem=`${from}-to-${to}-sr-mtf-high-precision-${profile}`
const json=unique(stem,'json'),csv=unique(`${stem}-signals`,'csv')
const commonRejections=['SELL AND volumeRatio10 > 3 AND volumeRatio10 <= 10 AND efficiency10 < 0.70','BUY AND volumeRatio10 < 1 AND move from open >= 3%','breakoutDistancePct >= 0.20 AND volumeRatio10 between 0.75 and 1.50','volumeRatio10 >= 2 AND efficiency10 <= 0.35']
const strictRejections=['BUY AND volumeRatio10 >= 3','OR15 level AND volumeRatio10 <= 0.75','volumeRatio10 >= 2.5 AND signal time 09:30-09:35']
const rejections=profile==='strict'?[...commonRejections,...strictRejections]:commonRejections
fs.writeFileSync(json,JSON.stringify({summary,rules:{profile:profile.toUpperCase(),base:['session VWAP aligned','directional close location >= 60%','causal S/R break or confirmed retest','10-minute timeframe aligned','at least 4/5 timeframes aligned','move from open >= 1.5%','breakout distance 0.15%-0.25%',`signal <= ${signalCutoff}`],rejections},daily,signals:accepted,rejected},null,2)+'\n',{flag:'wx'})
const fields=['date','symbol','side','signalTime','entryTime','entryPrice','exitTime','exitPrice','exitReason','returnPct','mfePct','maePct']
fs.writeFileSync(csv,[fields.join(','),...accepted.map(row=>fields.map(field=>csvValue(row[field])).join(','))].join('\n')+'\n',{flag:'wx'})

console.log(`\nSignals · ${profile.toUpperCase()} strategy`)
console.table(accepted.map(row=>({Date:row.date,Stock:row.symbol,Side:row.side,Signal:row.signalTime,Entry:`${row.entryTime} @ ${row.entryPrice}`,Exit:`${row.exitTime} @ ${row.exitPrice}`,Reason:row.exitReason,'Return %':row.returnPct})))
console.log('\nDaily')
console.table(activeDays.map(row=>({Date:row.date,Signals:row.signals,Winners:row.winners,'Return %':row.totalReturnPct})))
console.log(`Totals: ${summary.tradeCount} signals | wins=${summary.winners} | win rate=${summary.winRatePct ?? 'n/a'}% | average=${summary.averageReturnPct ?? 'n/a'}% | total=${summary.totalReturnPct}% | max MAE=${summary.maximumAdverseExcursionPct ?? 'n/a'}% | rejected=${summary.rejectedSignalCount}`)
