import fs from 'node:fs'
import path from 'node:path'

const root = process.cwd(), tradeDate = process.argv[2] ?? '2026-10-19'
const priorDates = ['2026-10-13', '2026-10-14', '2026-10-15', '2026-10-16']
const source = path.join(root, 'reports', `${tradeDate}-all-stocks-opening-context-2.json`)
if (!fs.existsSync(source)) throw new Error(`Missing source report: ${source}`)
const sourceReport = JSON.parse(fs.readFileSync(source, 'utf8'))
const trades = sourceReport.selected.trades
const round = (x, p = 4) => Number.isFinite(x) ? Number(x.toFixed(p)) : null
const mean = a => a.reduce((s, x) => s + x, 0) / a.length
const local = epoch => new Date(epoch * 1000 + 330 * 60_000).toISOString().slice(0, 16).replace('T', ' ')

function readCandles(symbol) {
  const unique = new Map()
  for (const line of fs.readFileSync(path.join(root, 'db', 'candles', `${symbol}.jsonl`), 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue
    let row; try { row = JSON.parse(line) } catch { continue }
    const stamp = local(+row.time), date = stamp.slice(0, 10), minute = stamp.slice(11)
    if (![...priorDates, tradeDate].includes(date) || minute < '09:15' || minute > '15:29') continue
    unique.set(stamp, { stamp, date, minute, open: +row.open, high: +row.high, low: +row.low, close: +row.close, volume: +row.volume })
  }
  const rows = [...unique.values()].sort((a, b) => a.stamp.localeCompare(b.stamp))
  return Object.fromEntries([...priorDates, tradeDate].map(date => [date, rows.filter(x => x.date === date)]))
}

function pct(a, b) { return 100 * (a / b - 1) }
function features(trade) {
  const byDate = readCandles(trade.symbol), today = byDate[tradeDate], opening = today.slice(0, 15)
  const direction = trade.side === 'BUY' ? 1 : -1
  const chunks = [opening.slice(0, 5), opening.slice(5, 10), opening.slice(10, 15)]
  const segmentReturn = rows => direction * pct(rows.at(-1).close, rows[0].open)
  const segmentVolume = rows => rows.reduce((s, x) => s + x.volume, 0)
  const priorDaily = priorDates.map(date => {
    const rows = byDate[date], high = Math.max(...rows.map(x => x.high)), low = Math.min(...rows.map(x => x.low)), close = rows.at(-1).close
    return { high, low, close, open: rows[0].open, rangePct: pct(high, low), closeLocation: 100 * (close - low) / (high - low), first15Volume: segmentVolume(rows.slice(0, 15)) }
  })
  const openingHigh = Math.max(...opening.map(x => x.high)), openingLow = Math.min(...opening.map(x => x.low)), openingClose = opening.at(-1).close
  const absoluteMoves = opening.slice(1).map((x, i) => Math.abs(pct(x.close, opening[i].close)))
  const netMove = Math.abs(pct(openingClose, opening[0].open))
  const depth = trade.depth
  const previous = priorDaily.at(-1), previousBoundary = trade.side === 'BUY' ? previous.high : previous.low
  const fourDayBoundary = trade.side === 'BUY' ? Math.max(...priorDaily.map(x => x.high)) : Math.min(...priorDaily.map(x => x.low))
  return {
    sideBuy: trade.side === 'BUY' ? 1 : 0,
    openingMoveAbsPct: Math.abs(trade.openingReturnPct),
    relativeVolume: trade.relativeVolume,
    vwapGapDirectionalPct: trade.vwapGapDirectionalPct,
    gapDirectionalPct: direction * pct(opening[0].open, previous.close),
    previousBreak: trade.previousBreak ? 1 : 0,
    fourDayBreak: trade.fourDayBreak ? 1 : 0,
    fiveMinuteStructure: trade.fiveMinuteStructure ? 1 : 0,
    depthDirectionalSharePct: depth ? (trade.side === 'BUY' ? depth.avgBidSharePct : 100 - depth.avgBidSharePct) : NaN,
    depthDirectionalDominantPct: depth ? (trade.side === 'BUY' ? depth.bidDominantPct : 100 - depth.bidDominantPct) : NaN,
    depthDirectionalMidpointMovePct: depth ? direction * depth.midpointMovePct : NaN,
    depthSpreadBps: depth?.avgSpreadBps ?? NaN,
    first5ReturnDirectionalPct: segmentReturn(chunks[0]),
    second5ReturnDirectionalPct: segmentReturn(chunks[1]),
    third5ReturnDirectionalPct: segmentReturn(chunks[2]),
    returnAccelerationPct: segmentReturn(chunks[2]) - segmentReturn(chunks[0]),
    secondToFirstVolumeRatio: segmentVolume(chunks[1]) / segmentVolume(chunks[0]),
    thirdToFirstVolumeRatio: segmentVolume(chunks[2]) / segmentVolume(chunks[0]),
    thirdToSecondVolumeRatio: segmentVolume(chunks[2]) / segmentVolume(chunks[1]),
    openingRangePct: pct(openingHigh, openingLow),
    openingDirectionalCloseLocationPct: trade.side === 'BUY' ? 100 * (openingClose - openingLow) / (openingHigh - openingLow) : 100 * (openingHigh - openingClose) / (openingHigh - openingLow),
    openingEfficiency: netMove / (absoluteMoves.reduce((s, x) => s + x, 0) || 1),
    priorAverageDailyRangePct: mean(priorDaily.map(x => x.rangePct)),
    previousDayCloseDirectionalLocationPct: trade.side === 'BUY' ? previous.closeLocation : 100 - previous.closeLocation,
    distancePastPreviousBoundaryPct: direction * pct(openingClose, previousBoundary),
    distancePastFourDayBoundaryPct: direction * pct(openingClose, fourDayBoundary),
    priorVolumeRatio: segmentVolume(opening) / mean(priorDaily.map(x => x.first15Volume))
  }
}

const dataset = trades.map((trade, index) => ({ index, trade, y: trade.returnPct > 0 ? 1 : 0, x: features(trade) }))
const featureNames = Object.keys(dataset[0].x).filter(name => dataset.every(row => Number.isFinite(row.x[name])))
const gini = rows => {
  if (!rows.length) return 0
  const p = rows.filter(x => x.y === 1).length / rows.length
  return 2 * p * (1 - p)
}
function candidateThresholds(rows, feature) {
  const values = [...new Set(rows.map(row => row.x[feature]))].sort((a, b) => a - b)
  const thresholds = []
  for (let i = 0; i < values.length - 1; i++) {
    const leftClass = new Set(rows.filter(row => row.x[feature] <= values[i]).map(row => row.y))
    const rightClass = new Set(rows.filter(row => row.x[feature] >= values[i + 1]).map(row => row.y))
    if (leftClass.size > 1 && rightClass.size > 1 && i % 2 === 1) continue
    thresholds.push((values[i] + values[i + 1]) / 2)
  }
  return thresholds
}
function buildTree(rows, depth, maxDepth, minLeaf) {
  const positives = rows.filter(x => x.y === 1).length
  if (depth >= maxDepth || positives === 0 || positives === rows.length || rows.length < 2 * minLeaf) return { leaf: true, rows, positives, negatives: rows.length - positives }
  let best = null
  for (const feature of featureNames) for (const threshold of candidateThresholds(rows, feature)) {
    const left = rows.filter(row => row.x[feature] <= threshold), right = rows.filter(row => row.x[feature] > threshold)
    if (left.length < minLeaf || right.length < minLeaf) continue
    const impurity = (left.length * gini(left) + right.length * gini(right)) / rows.length
    const balancePenalty = 0.0001 * Math.abs(left.length - right.length)
    if (!best || impurity + balancePenalty < best.score) best = { feature, threshold, left, right, score: impurity + balancePenalty }
  }
  if (!best) return { leaf: true, rows, positives, negatives: rows.length - positives }
  return { leaf: false, feature: best.feature, threshold: best.threshold, left: buildTree(best.left, depth + 1, maxDepth, minLeaf), right: buildTree(best.right, depth + 1, maxDepth, minLeaf) }
}
function purePositiveBranches(tree, conditions = [], output = []) {
  if (tree.leaf) {
    if (tree.positives > 0 && tree.negatives === 0) output.push({ conditions, rows: tree.rows })
    return output
  }
  purePositiveBranches(tree.left, [...conditions, { feature: tree.feature, operator: '<=', threshold: round(tree.threshold, 6) }], output)
  purePositiveBranches(tree.right, [...conditions, { feature: tree.feature, operator: '>', threshold: round(tree.threshold, 6) }], output)
  return output
}
const models = []
for (const maxDepth of [2, 3, 4, 5, 6]) for (const minLeaf of [1, 2, 3]) {
  const tree = buildTree(dataset, 0, maxDepth, minLeaf), branches = purePositiveBranches(tree)
  const kept = [...new Map(branches.flatMap(branch => branch.rows).map(row => [row.index, row])).values()]
  const returns = kept.map(row => row.trade.returnPct)
  models.push({ maxDepth, minLeaf, tree, branches, kept, tradeCount: kept.length, totalReturnPct: round(returns.reduce((s, x) => s + x, 0)), averageReturnPct: kept.length ? round(mean(returns)) : null, maximumAdverseExcursionPct: kept.length ? round(Math.min(...kept.map(row => row.trade.maximumAdverseExcursionPct))) : null })
}
const eligible = models.filter(model => model.totalReturnPct > 10)
eligible.sort((a, b) => a.maxDepth - b.maxDepth || b.minLeaf - a.minLeaf || b.totalReturnPct - a.totalReturnPct)
const selected = eligible[0] ?? models.sort((a, b) => b.totalReturnPct - a.totalReturnPct)[0]
const keptTrades = selected.kept.map(row => row.trade).sort((a, b) => a.symbol.localeCompare(b.symbol))
const keptIndexes = new Set(selected.kept.map(row => row.index))
const conditionPasses = (row, condition) => condition.operator === '<=' ? row.x[condition.feature] <= condition.threshold : row.x[condition.feature] > condition.threshold
const excluded = dataset.filter(row => !keptIndexes.has(row.index)).map(row => ({ symbol: row.trade.symbol, side: row.trade.side, returnPct: row.trade.returnPct, exitReason: row.trade.exitReason, openingMoveAbsPct: round(row.x.openingMoveAbsPct), third5ReturnDirectionalPct: round(row.x.third5ReturnDirectionalPct), failedConditions: selected.branches.flatMap(branch => branch.conditions.filter(condition => !conditionPasses(row, condition))) }))
const report = {
  source,
  warning: 'The filter tree was fitted to the same October 19 outcomes it reports. Zero stops is an in-sample fit, not evidence of zero future stops.',
  featurePolicy: 'Only 09:29-or-earlier candle, matching-time prior-session, VWAP and depth features were eligible. Symbol identity, exit data and future candles were excluded from predicates.',
  search: { featureCount: featureNames.length, features: featureNames, modelsTested: models.length, selectedMaxDepth: selected.maxDepth, selectedMinimumLeafSize: selected.minLeaf },
  selected: { branches: selected.branches.map(branch => ({ conditions: branch.conditions, retainedSymbols: branch.rows.map(row => row.trade.symbol) })), tradeCount: keptTrades.length, filteredOut: trades.length - keptTrades.length, filteredStops: excluded.filter(row => row.exitReason === 'stop').length, filteredPositiveTrades: excluded.filter(row => row.returnPct > 0).length, stopCount: 0, winRatePct: keptTrades.length ? 100 : null, averageReturnPct: selected.averageReturnPct, totalCombinedReturnPct: selected.totalReturnPct, maximumAdverseExcursionPct: selected.maximumAdverseExcursionPct, worstDay: { date: tradeDate, totalCombinedReturnPct: selected.totalReturnPct }, costSensitivity: { after0_03PctPerTrade: round(selected.totalReturnPct - keptTrades.length * 0.03), after0_05PctPerTrade: round(selected.totalReturnPct - keptTrades.length * 0.05) }, trades: keptTrades, excluded },
  modelComparison: models.map(({ tree, branches, kept, ...summary }) => summary)
}
let n = 1, output
do { output = path.join(root, 'reports', `${tradeDate}-opening-stop-filter-research${n === 1 ? '' : `-${n}`}.json`); n++ } while (fs.existsSync(output))
fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' })
const columns = ['symbol', 'side', 'signalTime', 'entryTime', 'entryPrice', 'stop', 'target', 'exitTime', 'exitPrice', 'exitReason', 'returnPct', 'maximumAdverseExcursionPct']
const csvValue = value => /[",\n]/.test(String(value ?? '')) ? `"${String(value ?? '').replaceAll('"', '""')}"` : String(value ?? '')
let csvN = 1, csvOutput
do { csvOutput = path.join(root, 'csv', `${tradeDate}-opening-zero-stop-filtered-signals${csvN === 1 ? '' : `-${csvN}`}.csv`); csvN++ } while (fs.existsSync(csvOutput))
fs.writeFileSync(csvOutput, [columns.join(','), ...keptTrades.map(row => columns.map(column => csvValue(row[column])).join(','))].join('\n') + '\n', { flag: 'wx' })
console.log(JSON.stringify({ search: report.search, selected: { ...report.selected, excluded: undefined, trades: keptTrades.map(x => ({ symbol: x.symbol, side: x.side, entryPrice: x.entryPrice, stop: x.stop, target: x.target, returnPct: x.returnPct, exitReason: x.exitReason })) }, output, csvOutput }, null, 2))
