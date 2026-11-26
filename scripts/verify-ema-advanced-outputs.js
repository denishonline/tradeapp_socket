import fs from 'node:fs'
import assert from 'node:assert/strict'
import {pathToFileURL} from 'node:url'
import path from 'node:path'
import {DATES,MINUTE,loadCandles} from './research-ema-coverage.js'

export function readCsv(file){const [header,...lines]=fs.readFileSync(file,'utf8').trim().split(/\r?\n/);const keys=header.split(',');return lines.filter(Boolean).map(line=>Object.fromEntries(line.split(',').map((v,i)=>[keys[i],v])))}
export function verifyReport(file,{prices=false}={}){
  const report=JSON.parse(fs.readFileSync(file,'utf8')),checks=[]
  assert.deepEqual(report.protocol.fitDates,DATES.slice(0,4));assert.deepEqual(report.protocol.calibrationDates,DATES.slice(4,6));assert.deepEqual(report.protocol.replayDates,DATES.slice(6))
  const entries=(report.frontiers||[]).filter(e=>e.replay?.signals)
  if(report.highestSupported?.replay)entries.push(report.highestSupported)
  if(report.primary?.replay?.signals)entries.push(report.primary)
  if(report.strict?.later?.signals)entries.push({replay:report.strict.later})
  if(report.extension?.later?.signals)entries.push({replay:report.extension.later})
  if(report.extension?.all?.signals)entries.push({replay:report.extension.all,expectedTargets:Object.values(report.targetCounts).reduce((s,n)=>s+n,0),dates:DATES})
  const all=[]
  for(const entry of entries){
    const {summary,signals,cohort}=entry.replay,rows=readCsv(signals),ledger=readCsv(cohort)
    assert.equal(rows.length,summary.trades);assert.equal(ledger.length,entry.expectedTargets??report.targetCounts.later)
    const key=e=>`${e.date}|${e.symbol}|${e.side}|${e.originalEntryTime}`
    assert.equal(new Set(rows.map(key)).size,rows.length);assert.equal(new Set(ledger.map(key)).size,ledger.length)
    assert.equal(ledger.filter(e=>e.status==='WIN').length,summary.profitableCohort)
    const realized=e=>(e.side==='BUY'?1:-1)*(+e.exitPrice-e.entryPrice)
    assert.equal(rows.filter(e=>realized(e)<0).length,summary.losses)
    assert.equal(rows.filter(e=>realized(e)===0).length,summary.flat)
    for(const e of rows){
      assert((entry.dates||report.protocol.replayDates).includes(e.date))
      const signal=Date.parse(`${e.date}T${e.signalTime}:00+05:30`),fill=Date.parse(`${e.date}T${e.fillTime}:00+05:30`),exit=Date.parse(`${e.date}T${e.exitTime}:00+05:30`)
      assert.equal(fill-signal,MINUTE);assert(exit>=fill)
      const expected=(e.side==='BUY'?1:-1)*100*(+e.exitPrice-e.entryPrice)/e.entryPrice
      assert(Math.abs(+e.returnPct-expected)<=.000051)
      assert(+e.maePct<=Math.min(0,expected)+.000051)
      all.push(e)
    }
    checks.push({signals,rows:rows.length,cohortRows:ledger.length})
  }
  if(prices)for(const [symbol,group]of Map.groupBy(all,e=>e.symbol)){
    const sessions=loadCandles(symbol)
    for(const e of group){const t=Date.parse(`${e.date}T${e.signalTime}:00+05:30`),bar=sessions.get(e.date).find(r=>r.t===t);assert(bar);assert.equal(+e.entryPrice,bar.c)}
  }
  return {file,checkedSignalFiles:checks.length,checks,independentRawFillPrices:prices}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href)console.log(JSON.stringify(verifyReport(process.argv[2],{prices:process.argv.includes('--prices')}),null,2))
