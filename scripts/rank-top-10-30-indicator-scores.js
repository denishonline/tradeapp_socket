import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'

// Usage: node scripts/rank-top-10-30-indicator-scores.js YYYY-MM-DD HH:MM
// Example: node scripts/rank-top-10-30-indicator-scores.js 2026-10-29 09:30
// Cutoff is IST and exclusive: no candle or depth update at/after it is used.
const [date = '2026-10-29', cutoff = '09:30'] = process.argv.slice(2)
if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(cutoff)) throw new Error('Usage: node scripts/rank-top-10-30-indicator-scores.js YYYY-MM-DD HH:MM')
const root = process.cwd(), scorer = path.join(root, 'scripts', 'score-sammaancap-30-indicators-2026-10-29.js')
const showProgress = text => process.stdout.write(`\r${text.padEnd(120)}`)
const endProgress = () => process.stdout.write('\n')
// Execute the existing scorer in a fresh context. Candle rows are indexed locally
// for the active stock only; depth is read per session and never retained, so the
// process cannot accumulate all stocks' JSON/depth snapshots in memory.
const baseScorerSource = fs.readFileSync(scorer, 'utf8').replace(/^import fs[^\n]*\nimport path[^\n]*\n/m, '')
const candleCache = new Map()
function cachedCandleData(symbol, targetDate, cutoffMinute) {
  if (!candleCache.has(symbol)) {
    const rows = []
    for (const line of fs.readFileSync(path.join(root, 'db', 'candles', `${symbol}.jsonl`), 'utf8').split(/\r?\n/)) {
      if (!line) continue
      let x; try { x = JSON.parse(line) } catch { continue }
      const d = new Date(Number(x.time) * 1000 + 330 * 60_000), day = d.toISOString().slice(0, 10), minute = d.getUTCHours() * 60 + d.getUTCMinutes()
      if (minute < 555 || minute >= 930 || ![x.open, x.high, x.low, x.close, x.volume].every(Number.isFinite) || +x.volume <= 0) continue
      rows.push({ ...x, day, minute, open:+x.open, high:+x.high, low:+x.low, close:+x.close, volume:+x.volume })
    }
    candleCache.set(symbol, rows.sort((a, b) => a.time - b.time))
  }
  return candleCache.get(symbol).filter(x => x.day < targetDate || (x.day === targetDate && x.minute < cutoffMinute))
}
const scorerSource = baseScorerSource.replace(/function candleData\(\) \{[^\n]*\n/, 'function candleData() { return cachedCandleData(symbol, date, cutoff) }\n')
function score(symbol, session) {
  let output = ''
  const context = { fs, path, JSON, cachedCandleData, process: { argv: ['node', 'score', symbol, session, cutoff, '--stdout'], cwd: () => root }, console: { log: value => { output += String(value) } } }
  try { vm.runInNewContext(scorerSource, context, { filename: scorer }); return JSON.parse(output) } catch (error) { return { error: String(error.message ?? error) } }
}
const symbols = fs.readdirSync(path.join(root, 'db', 'candles'), { withFileTypes: true })
  .filter(x => x.isFile() && x.name.endsWith('.jsonl') && x.name !== 'NIFTY50.jsonl')
  .map(x => path.basename(x.name, '.jsonl')).sort()
const scored = [], skipped = []
for (const [index, symbol] of symbols.entries()) {
  showProgress(`Scoring current cutoff: ${index + 1}/${symbols.length} | scored ${scored.length} | skipped ${skipped.length}`)
  const result = score(symbol, date)
  if (result.error) { skipped.push({ symbol, reason: result.error.slice(0, 180) }); candleCache.delete(symbol); continue }
  scored.push(result)
  candleCache.delete(symbol)
}
const ranked = scored.sort((a,b) => b.bestCount-a.bestCount || b.keyValues.adx-a.keyValues.adx || a.symbol.localeCompare(b.symbol))
const istDate = epoch => new Date(Number(epoch) * 1000 + 330 * 60_000).toISOString().slice(0, 10)
const sessionCache = new Map()
function priorSessions(symbol) {
  if (sessionCache.has(symbol)) return sessionCache.get(symbol)
  const sessions = new Set()
  for (const line of fs.readFileSync(path.join(root, 'db', 'candles', `${symbol}.jsonl`), 'utf8').split(/\r?\n/)) {
    if (!line) continue
    try { const row = JSON.parse(line); if (Number.isFinite(+row.time) && +row.volume > 0) { const day = istDate(row.time); if (day < date) sessions.add(day) } } catch {}
  }
  const result = [...sessions].sort().slice(-20)
  sessionCache.set(symbol, result)
  return result
}
function historicalGate(current, qualifiedCount) {
  const symbol = current.symbol.replace(/-EQ$/, '')
  const sessions = priorSessions(symbol), history = [], historySkipped = []
  for (const [index, session] of sessions.entries()) {
    showProgress(`Checking 20-session maximum: ${current.symbol} ${index + 1}/${sessions.length} | qualified ${qualifiedCount}/10`)
    const result = score(symbol, session)
    if (result.error) { historySkipped.push(session); continue }
    history.push(result.bestCount)
  }
  const historicalMax = history.length ? Math.max(...history) : null
  candleCache.delete(symbol)
  return { priorSessionsAvailable: sessions.length, priorSessionsScored: history.length, historicalMaxBestCount: historicalMax, historySkipped, qualifies: history.length === 20 && current.bestCount >= historicalMax }
}
const qualified = [], historicalRejected = []
for (const current of ranked) {
  const gate = historicalGate(current, qualified.length)
  if (gate.qualifies) qualified.push({ ...current, gate })
  else historicalRejected.push({ symbol: current.symbol, bestCount: current.bestCount, ...gate })
  if (qualified.length === 10) break
}
const safeCutoff = cutoff.replace(':', '')
const out = { date, cutoffIST: cutoff, asOfRule: `Only completed 1-minute candles before ${cutoff} and depth received before ${cutoff} were used.`, qualificationRule: 'A stock must have 20 prior positive-volume trading sessions available and today’s score must equal or exceed its highest score across those 20 sessions at the same cutoff.', universe: { candleFiles: symbols.length, scored: scored.length, skipped: skipped.length }, top10: qualified.map((x, rank) => ({ rank: rank+1, symbol: x.symbol, bestCount: x.bestCount, totalIndicators: x.totalIndicators, direction: x.direction, historicalMaxBestCount: x.gate.historicalMaxBestCount, priorSessionsScored: x.gate.priorSessionsScored, close: x.keyValues.close, sessionVWAP: x.keyValues.sessionVWAP, adx: x.keyValues.adx, depthSnapshots: x.keyValues.depthSnapshots, bestIndicators: x.bestIndicators.map(y => y.indicator) })), historicalRejected, skipped }
let n=1,file; do { file=path.join(root,'reports',`${date}-${safeCutoff}-top-10-30-indicator-scores${n===1?'':`-${n}`}.json`); n++ } while(fs.existsSync(file))
fs.writeFileSync(file, JSON.stringify(out, null, 2) + '\n', { flag: 'wx' })
endProgress()
console.log(JSON.stringify({ file, universe: out.universe, top10: out.top10.map(x => ({ rank:x.rank, symbol:x.symbol, bestCount:x.bestCount, direction:x.direction })) }, null, 2))
