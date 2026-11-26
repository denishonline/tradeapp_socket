import fs from 'node:fs'
import path from 'node:path'
import {REPORTS,STEM,uniqueFile} from './research-ema-coverage.js'
const result=JSON.parse(fs.readFileSync(path.join(REPORTS,`${STEM}-five-more-results.json`),'utf8'))
const lock=JSON.parse(fs.readFileSync(result.selectionLock,'utf8'))
const later=result.extension.later.summary,output=uniqueFile('five-more-summary.md')
const lines=['# Five additional pattern families: results','',
  'No additional rule qualified for selection in this experiment. Five family definitions were tested at 0/3/5-minute confirmation points; four generated 486 bounded candidates with sufficient fitting support. The pullback/reclaim definition did not meet fitting support requirements.','',
  '| Family | Fitting-supported candidate rules | Selected additions |',
  '| --- | ---: | ---: |',
  ...lock.protocol.families.map(f=>`| ${f.name} | ${lock.proposals.filter(r=>r.name===f.name).length} | ${result.extension.rules.filter(r=>r.name===f.name).length} |`),'',
  '## Selection requirements','',
  '- Learn bounds on Oct5-8 only, with at least three profitable target views and support on at least two fitting dates.',
  '- On Oct9/12, add at least one profitable target leg, preserve all existing profitable target keys on both fitting/calibration dates, and retain a positive combined gross average return.',
  '- Strict version additionally forbids new non-positive keys on fitting/calibration dates. Both versions selected zero additions. No hypothetical transaction-cost assumption was used to reject coverage extensions.',
  '- These conditions were applied to actual first-entry-per-leg execution, including earlier signals that could replace an existing baseline entry.','',
  'The result means none of these candidates satisfied all requirements together; it does not establish that no other pattern can work. No five-rule package was forced into the strategy.','',
  '## Oct13-16 result: unchanged baseline','',
  `- Target winners: ${later.profitableCohort}/67.`,
  `- Trades: ${later.trades}; winners ${later.winners}, losers ${later.losses}, flat ${later.flat}; win rate ${later.winRatePct}%.`,
  `- Average gross return: ${later.averageReturnPct}%; sum: ${later.summedReturnPct} percentage points (not compounded portfolio return).`,
  `- Worst adverse excursion: ${later.worstMaePct}%. Worst day: ${later.worstDay.date}, summed return ${later.worstDay.sum} percentage points.`,
  `- Average less hypothetical 0.10% round-trip cost: ${later.afterHypothetical10bps.averageReturnPct}%.`,
  '', 'These dates have repeatedly been examined and are not an untouched holdout. The original baseline is already lossy; no approved additions does not mean the baseline is approved. No live strategy or raw data were changed.','',
  `Exact rules and selection protocol: ${path.basename(result.selectionLock)}.`,
  `All159 descriptive cohort ledger: ${path.basename(result.extension.all.cohort)}.`,
  `Detailed results: ${STEM}-five-more-results.json.`]
fs.writeFileSync(output,lines.join('\n')+'\n',{flag:'wx'});console.log(output)
