import fs from 'node:fs'
import path from 'node:path'
import {REPORTS,STEM,CANDLE_CACHE,depthPool} from './research-ema-coverage.js'

const output=path.join(REPORTS,`${STEM}-entry-time-depth.json`)
if(fs.existsSync(output)){console.log(`Already built: ${output}`);process.exit(0)}
const files=[CANDLE_CACHE,...[3,5].map(n=>path.join(REPORTS,`${STEM}-delay${n}-candles.json`))]
const events=files.flatMap(file=>JSON.parse(fs.readFileSync(file,'utf8')).events.map(({date,symbol,side,entryTime,signalAt})=>({date,symbol,side,entryTime,signalAt})))
await depthPool({events},output)
