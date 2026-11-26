import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'
import {REPORTS,STEM,uniqueFile} from './research-ema-coverage.js'
import {readCsv} from './verify-ema-advanced-outputs.js'

const sectorAligned=process.argv.includes('--sector-aligned')
const variant=sectorAligned?'sector-aligned-pure60':'sector-pure60'
const stem=`${STEM}-${variant}`
const data=JSON.parse(fs.readFileSync(path.join(REPORTS,`${stem}-results.json`),'utf8'))
const rules=data.retrospective.rules
const signals=readCsv(path.join(REPORTS,`${stem}-retrospective-signals.csv`))
assert(rules.length>0)
assert.equal(signals.length,data.retrospective.output.summary.trades)
assert(signals.every(s=>+s.returnPct>0))

const source=name=>name.startsWith('index_')?'Sector index':name.startsWith('sector_')?'Stock sector proxy':
  name.startsWith('nifty_')?'NIFTY 50':name.startsWith('cross_depth')?'Depth at crossover':
  name.startsWith('depth')||name==='absorptionPressure'?'Depth near signal':
  name.startsWith('pa_')?'Stock price action':name.startsWith('adv_')?'Stock session flow':
  name.startsWith('market')?'Stock-universe breadth':'Stock candles'
const fmt=c=>`${c.feature} ${c.op} ${String(c.value)}`
const lines=[
  `# Exact entry logic for all ${rules.length} patterns`,
  '',
  'These are the rules in the **all-ten-date retrospective fit**. They were selected using outcomes from October 5–16, 2026. Matching them on those dates cannot establish a live win rate. The rule IDs here match the retrospective winner list; they are different from the earlier-trained 17-rule replay even where IDs are the same.',
  '',
  ...(sectorAligned ? ['**Sector-aligned constraint:** direct `index_NIFTY...` conditions, sector breadth, and sector mean were removed before fitting. A `sector_*` condition refers only to the triggering stock’s mapped sector proxy.', ''] : []),
  '## Common logic',
  '',
  '1. Find a one-minute EMA-10/EMA-20 crossover. An upward cross gives BUY; a downward cross gives SELL.',
  '2. For each pattern, wait its listed 0, 3, or 5 minutes after the original cross. The EMA direction must still be valid. Evaluate **every** listed condition at that decision time. `>` is strict; `<=` includes equality. If any required numeric feature is missing, the pattern does not fire.',
  '3. If several rules match the same leg, use its earliest matching signal. At the same time, the lower numbered rule wins. Fill at the next completed one-minute candle close.',
  '4. Exit at the open of the candle following the opposite EMA cross, or mark the last candle close at end of day. These rules contain no stop loss or profit target.',
  '',
  sectorAligned
    ? '`tf3_`, `tf5_`, `tf10_`, and `tf15_` use only completed 3, 5, 10, or 15-minute bars. `nifty_` refers to NIFTY 50. `sector_` refers only to the triggering stock’s mapped sector proxy. `cross_depth` is market depth at the original cross; other `depth` values describe depth near the signal. `pa_` denotes price action; `adv_` denotes session flow or candle-derived proxies.'
    : '`tf3_`, `tf5_`, `tf10_`, and `tf15_` use only completed 3, 5, 10, or 15-minute bars. `nifty_` refers to NIFTY 50. `index_NIFTY...` refers to the named sector index as general market context. `cross_depth` is market depth at the original cross; other `depth` values describe depth near the signal. `pa_` denotes price action; `adv_` denotes session flow or candle-derived proxies.',
  '',
  'Signed price and indicator features are generally multiplied by +1 for BUY and −1 for SELL, so a positive threshold usually means movement in the proposed trade direction. ATR, fit, range, and relative-volume style features retain their unsigned scale. `rsi` and `mfi` are stored relative to 50 (for example, RSI feature 16 corresponds to raw RSI 66 for BUY). Sector-index returns are also direction-adjusted. Read exact feature implementations in the linked scripts if converting these thresholds to a live engine.',
  '',
  'Every row below is joined with **AND**. These are precise numerical filters found by a search; they should not be treated as 27 independently validated market behaviors.',
  '',
  `Source rules: [${stem}-results.json](${stem}-results.json). Winner list: [${stem}-pattern-wise-winners-2.md](${stem}-pattern-wise-winners-2.md).`,
  '',
  '## Pattern index',
  '',
  '| Rule | Wait after cross (min) | Conditions | Standalone target legs | Assigned winning trades |',
  '| --- | ---: | ---: | ---: | ---: |',
  ...rules.map(r=>`| [${r.id}](#${r.id.toLowerCase()}) | ${r.delay} | ${r.conditions.length} | ${r.standaloneTargetSupport} | ${signals.filter(s=>s.ruleId===r.id).length} |`),
  ''
]
for(const r of rules){
  const assigned=signals.filter(s=>s.ruleId===r.id)
  lines.push(`## ${r.id}`,'',
    `Wait: **${r.delay} minute${r.delay===1?'':'s'}** after the crossover. ${r.conditions.length} conditions must all pass. Standalone support: **${r.standaloneTargetSupport}** distinct original target legs; assigned winners after overlap resolution: **${assigned.length}**.`,
    '',
    '| Input | Exact condition |',
    '| --- | --- |',
    ...r.conditions.map(c=>`| ${source(c.feature)} | \`${fmt(c)}\` |`),
    '')
}
const file=uniqueFile(`${variant}-exact-pattern-logic.md`)
fs.writeFileSync(file,lines.join('\n')+'\n',{flag:'wx'})
console.log(JSON.stringify({file,patterns:rules.length,conditions:rules.reduce((n,r)=>n+r.conditions.length,0),assignedWinners:signals.length},null,2))
