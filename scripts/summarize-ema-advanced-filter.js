import fs from 'node:fs'
import path from 'node:path'
import {REPORTS,STEM,uniqueFile} from './research-ema-coverage.js'
const read=suffix=>JSON.parse(fs.readFileSync(path.join(REPORTS,`${STEM}-${suffix}`),'utf8'))
const general=read('advanced-filter-results.json'),targeted=read('trend-focused-results-2.json')
const reference=targeted.highestSupported,cal=reference.configuration.summary,later=reference.replay.summary
const output=uniqueFile('advanced-filter-conclusion.md')
const lines=['# Advanced-filter research conclusion','',
  'No reliable all-winner filter was found. None of the tested trend-focused filters met both 80% calibration gross win rate and 50% target-leg retention with the required support. This does not prove that no better filter exists.','',
  '## Actual new work','',
  '- Reconstructed fresh entry-time depth at all 0/3/5-minute decision points: 66,502 of 78,875 views passed quality checks (84.31%).',
  '- Tested up to 251 causal features: stock indicators at 1/3/5/10/15 minutes; RSI, MFI, MACD, VWAP, breakout/support-resistance, volume, slopes, ATR-normalized momentum, efficiency, persistence, NIFTY and breadth; book imbalance, OFI, signed-volume proxy, spread, midprice movement and changes since the original cross.',
  '- Compared three general return-model configurations and four rare-trend-focused configurations. Original target membership is a training label only, never a signal input.',
  '- General-model fitting: Oct5-8. Threshold/model calibration: Oct9 and12. Replay: Oct13-16. Target split: 78 fitting, 14 calibration, 67 replay.',
  '- Follow-up trend-focused research occurred after the general-model replay was examined. None of these repeatedly studied dates is a pristine holdout.','',
  '## Earlier-selected trend-focused reference','',
  'The calibration-selected reference uses all inputs, target class weight150, five-minute confirmation, similarity score >=0.55. This score is NOT a calibrated win probability. It is a complex ensemble filter, not ten simple human-readable patterns.','',
  '| Metric | Calibration Oct9/12 | Replay Oct13-16 |','| --- | ---: | ---: |',
  `| Original target winners retained | ${cal.profitableCohort}/14 | ${later.profitableCohort}/67 |`,
  `| Trades | ${cal.trades} | ${later.trades} |`,
  `| Wins / losses / flat | ${cal.winners} / ${cal.losses} / ${cal.flat} | ${later.winners} / ${later.losses} / ${later.flat} |`,
  `| Gross win rate | ${cal.winRatePct}% | ${later.winRatePct}% |`,
  `| Average gross return | ${cal.averageReturnPct}% | ${later.averageReturnPct}% |`,
  `| Sum of gross returns, percentage points | ${cal.summedReturnPct} | ${later.summedReturnPct} |`,
  `| Worst adverse excursion | ${cal.worstMaePct}% | ${later.worstMaePct}% |`,
  `| Worst day, sum in percentage points | ${cal.worstDay.date}: ${cal.worstDay.sum} | ${later.worstDay.date}: ${later.worstDay.sum} |`,
  `| Mean less hypothetical 0.10% round-trip cost | ${cal.afterHypothetical10bps.averageReturnPct}% | ${later.afterHypothetical10bps.averageReturnPct}% |`,'',
  'The reference retained 37.31% of later target legs; 42 of 67 were missed. The 233 total profitable trades are NOT 233 target legs. Filtering removed many controls but did not isolate winners.','',
  '## General return-model result','',
  `No general filter passed the predeclared >=80% calibration precision requirement. A lower-precision calibration-selected filter replayed ${general.frontiers[0].replay.trades} trades with ${general.frontiers[0].replay.winners} wins, ${general.frontiers[0].replay.losses} losses and ${general.frontiers[0].replay.breakeven??general.frontiers[0].replay.flat} flat outcomes; it retained zero target legs. High win rate on unrelated small moves would not meet the target.`,
  '', '## Execution and evidence','',
  'Signals use completed historical candles and depth received before the decision. Entries now fill at the next completed one-minute candle close, as AGENTS.md specifies; older reports filled at the next open and are not directly comparable. First matching decision owns the original leg; exit is the opposite crossover next-open fill or EOD mark. No stops or targets were added.',
  '', 'Costs are sensitivity only, not an estimate of actual brokerage/slippage. Gross-only selection was checked separately so the arbitrary 0.10% assumption could not be the sole reason for rejection. Summed returns are not capital-constrained portfolio performance. Overlapping trades and multiple searches mean the Wilson ranking score is not a valid guarantee of independent-trade confidence.',
  '', 'The cash-depth files contain no genuine OI; estimated signed volume is not exchange aggressor delta. No live strategy or raw data were changed. All earlier reports were preserved.',
  '', 'Files:',
  `- Detailed results: ${STEM}-trend-focused-results-2.json`,
  `- Frozen ensemble: ${STEM}-trend-focused-models-2.json`,
  `- All replay signals: ${path.basename(reference.replay.signals)}`,
  `- Every later target leg, including misses: ${path.basename(reference.replay.cohort)}`,
  `- Earlier-only selection lock: ${path.basename(targeted.selectionLock)}`,
  '', 'Conclusion: this remains an unsuccessful entry-filter search, not a validated trading strategy. More indicator combinations have not established that losing trades can be eliminated while preserving the target legs.'
]
fs.writeFileSync(output,lines.join('\n')+'\n',{flag:'wx'});console.log(output)
