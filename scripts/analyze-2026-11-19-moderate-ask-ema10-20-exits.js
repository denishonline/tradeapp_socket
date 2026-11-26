import fs from 'node:fs'
import path from 'node:path'

const root = process.cwd()
const date = '2026-11-19'
const symbols = ['VOLTAS', 'CROMPTON', 'IREDA', 'BDL', 'HINDALCO', 'BLUESTARCO', 'EICHERMOT', 'PNB', 'PNBHOUSING', 'BEL', 'POLYCAB', 'M&M', 'MARUTI', 'PIDILITIND', 'DELHIVERY', 'HYUNDAI', 'JINDALSTEL', 'VEDL', 'KEI', 'HEROMOTOCO', 'PGEL', 'IDFCFIRSTB', 'TVSMOTOR']
const startAt = Date.parse(`${date}T09:15:00+05:30`)
const cutoffAt = Date.parse(`${date}T10:00:00+05:30`)
const clock = at => new Date(at + 330 * 60_000).toISOString().slice(11, 16)
const round = (value, digits = 3) => Number(value.toFixed(digits))
const pct = (to, from) => 100 * (to / from - 1)

function candles(symbol) {
  const file = path.join(root, 'db', 'candles', `${symbol}.jsonl`)
  return fs.readFileSync(file, 'utf8').split(/\r?\n/).flatMap(line => {
    try {
      const row = JSON.parse(line), at = Number(row.time) * 1000
      return at >= startAt && clock(at) <= '15:29' ? [{ at, minute: clock(at), open: +row.open, high: +row.high, low: +row.low, close: +row.close }] : []
    } catch { return [] }
  }).sort((a, b) => a.at - b.at)
}

function depthMinutes(symbol) {
  const file = path.join(root, 'db', 'cash-depth', date, symbol, `${symbol}.jsonl`)
  const state = {}, grouped = new Map()
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue
    let event; try { event = JSON.parse(line) } catch { continue }
    const at = Date.parse(event.receivedAt)
    if (!Number.isFinite(at)) continue
    if (at >= cutoffAt) break
    if (event.kind === 'checkpoint' || event.book) for (const key of Object.keys(state)) delete state[key]
    Object.assign(state, event.data ?? {})
    if (at < startAt) continue
    let bid = 0, ask = 0, valid = true
    for (let level = 1; level <= 5; level++) {
      const bp = +state[`bid_price${level}`], ap = +state[`ask_price${level}`], bs = +state[`bid_size${level}`], as = +state[`ask_size${level}`]
      if (![bp, ap, bs, as].every(Number.isFinite) || bp <= 0 || ap <= bp) { valid = false; break }
      bid += bs; ask += as
    }
    if (!valid) continue
    const minute = clock(at)
    if (!grouped.has(minute)) grouped.set(minute, [])
    grouped.get(minute).push(100 * bid / (bid + ask || 1))
  }
  return [...grouped].map(([minute, values]) => ({ minute, snapshots: values.length, bidShare: values.reduce((sum, value) => sum + value, 0) / values.length }))
}

function firstSignal(symbol, sessionCandles) {
  const byMinute = new Map(sessionCandles.map(row => [row.minute, row]))
  const minutes = depthMinutes(symbol)
  let earliest
  for (let from = 0; from < minutes.length; from++) for (let to = from + 2; to < Math.min(minutes.length, from + 10); to++) {
    const window = minutes.slice(from, to + 1), bars = window.map(row => byMinute.get(row.minute))
    if (bars.some(row => !row)) continue
    const snapshotCount = window.reduce((sum, row) => sum + row.snapshots, 0)
    const askShare = 100 - window.reduce((sum, row) => sum + row.bidShare * row.snapshots, 0) / snapshotCount
    const rise = pct(bars.at(-1).close, bars[0].open)
    if (askShare < 55 || rise < 0.25) continue
    const candidate = { startMinute: window[0].minute, signalMinute: window.at(-1).minute, askShare: round(askShare), signalRisePct: round(rise), stop: bars[0].low }
    if (!earliest || candidate.signalMinute < earliest.signalMinute || candidate.signalMinute === earliest.signalMinute && candidate.startMinute > earliest.startMinute) earliest = candidate
  }
  return earliest
}

function withEma(rows) {
  let fast, slow
  return rows.map((row, index) => {
    fast = index ? fast + 2 / 11 * (row.close - fast) : row.close
    slow = index ? slow + 2 / 21 * (row.close - slow) : row.close
    return { ...row, ema10: fast, ema20: slow }
  })
}

const trades = []
for (const symbol of symbols) {
  const rows = withEma(candles(symbol)), signal = firstSignal(symbol, rows)
  if (!signal) continue
  const signalAt = Date.parse(`${date}T${signal.signalMinute}:00+05:30`)
  const entryIndex = rows.findIndex(row => row.at > signalAt)
  if (entryIndex < 0 || rows[entryIndex].close <= signal.stop) continue
  const entry = rows[entryIndex].close
  let exit = rows.at(-1).close, exitMinute = rows.at(-1).minute, exitReason = 'EOD', mae = 0
  for (let index = entryIndex + 1; index < rows.length; index++) {
    const row = rows[index], previous = rows[index - 1]
    mae = Math.min(mae, pct(row.low, entry))
    const stopHit = row.low <= signal.stop
    const bearishCross = previous.ema10 >= previous.ema20 && row.ema10 < row.ema20
    if (stopHit || bearishCross) {
      exit = stopHit ? signal.stop : row.close
      exitMinute = row.minute
      exitReason = stopHit && bearishCross ? 'SL_AND_EMA10_BELOW_EMA20' : stopHit ? 'SL' : 'EMA10_BELOW_EMA20'
      break
    }
  }
  trades.push({ stock: symbol, period: `${signal.startMinute}-${signal.signalMinute}`, entryMinute: rows[entryIndex].minute, entry: round(entry), stop: round(signal.stop), exitMinute, exit: round(exit), exitReason, returnPct: round(pct(exit, entry)), maePct: round(mae), askSharePct: signal.askShare, signalRisePct: signal.signalRisePct })
}

const returns = trades.map(row => row.returnPct)
const output = {
  date,
  method: 'First 09:15-10:00 moderate ask-dominance/rise signal per requested stock. Ask share >=55%, price rise >=0.25% over 3-10 completed 1-minute candles. Enter at next completed 1-minute candle close. Stop is the signal period first candle low. Exit at first EMA10 below EMA20 cross close, stop, or EOD; stop is assumed first when both occur in the same candle. Gross returns; no costs or slippage.',
  summary: { tradeCount: trades.length, winRatePct: round(100 * trades.filter(row => row.returnPct > 0).length / trades.length, 2), averageReturnPct: round(returns.reduce((sum, value) => sum + value, 0) / returns.length), totalReturnPct: round(returns.reduce((sum, value) => sum + value, 0)), maximumAdverseExcursionPct: round(Math.min(...trades.map(row => row.maePct))), worstDay: { date, totalReturnPct: round(returns.reduce((sum, value) => sum + value, 0)) } },
  trades
}
let suffix = 1, outputFile
do { outputFile = path.join(root, 'reports', `${date}-moderate-ask-rise-ema10-20-exits${suffix === 1 ? '' : `-${suffix}`}.json`); suffix++ } while (fs.existsSync(outputFile))
fs.writeFileSync(outputFile, JSON.stringify(output, null, 2) + '\n', { flag: 'wx' })
console.table(trades)
console.log(JSON.stringify({ outputFile, summary: output.summary }, null, 2))
