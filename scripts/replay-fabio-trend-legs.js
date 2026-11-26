import fs from "node:fs"
import path from "node:path"
import readline from "node:readline"
import { findTrendSetups } from "../ui/trading/fabio-scalper.js"

const ROOT = process.cwd(), MINUTE = 60_000, IST_OFFSET = 330 * MINUTE
const DATES = ["2026-10-05", "2026-10-06", "2026-10-07", "2026-10-08", "2026-10-09", "2026-10-12", "2026-10-13", "2026-10-14", "2026-10-15", "2026-10-16", "2026-10-19"]
const DATE_SET = new Set(DATES)
const dateAt = (at) => new Date(at + IST_OFFSET).toISOString().slice(0, 10)
const timeAt = (at) => new Date(at + IST_OFFSET).toISOString().slice(11, 16)
const round = (x, n = 4) => Number.isFinite(x) ? Number(x.toFixed(n)) : null
const pct = (value, base) => base > 0 ? 100 * (value / base - 1) : null
const csv = (value) => /[",\n]/.test(String(value ?? "")) ? `"${String(value ?? "").replaceAll('"', '""')}"` : String(value ?? "")

function parseCsv(text) {
  const [header, ...lines] = text.trim().split(/\r?\n/)
  const keys = header.split(",")
  return lines.map((line) => Object.fromEntries(keys.map((key, index) => [key, line.split(",")[index]])))
}

function loadCandles(symbol) {
  const file = path.join(ROOT, "db", "candles", `${symbol}.jsonl`)
  if (!fs.existsSync(file)) return []
  return fs.readFileSync(file, "utf8").split(/\r?\n/).flatMap((line) => {
    try {
      const x = JSON.parse(line), at = Number(x.time) * 1000
      const bar = { at, open: Number(x.open), high: Number(x.high), low: Number(x.low), close: Number(x.close), volume: Number(x.volume) }
      return DATE_SET.has(dateAt(at)) && Object.values(bar).every(Number.isFinite) ? [bar] : []
    } catch { return [] }
  }).sort((a, b) => a.at - b.at)
}

async function* records(file) {
  const input = fs.createReadStream(file, { encoding: "utf8" }), lines = readline.createInterface({ input, crlfDelay: Infinity })
  try { for await (const line of lines) { try { yield JSON.parse(line) } catch {} } } finally { lines.close(); input.destroy() }
}

function book(data) {
  const bids = [], asks = []
  for (let level = 1; level <= 5; level++) {
    const bid = Number(data[`bid_price${level}`]), ask = Number(data[`ask_price${level}`]), bq = Number(data[`bid_size${level}`]), aq = Number(data[`ask_size${level}`])
    if (![bid, ask, bq, aq].every(Number.isFinite) || bid <= 0 || ask <= bid || bq < 0 || aq < 0) return null
    bids.push([bid, bq]); asks.push([ask, aq])
  }
  const weighted = (levels) => levels.reduce((sum, [, qty], index) => sum + qty / (index + 1), 0)
  const bidQty = bids.reduce((sum, [, qty]) => sum + qty, 0), askQty = asks.reduce((sum, [, qty]) => sum + qty, 0)
  const wb = weighted(bids), wa = weighted(asks)
  return { mid: (bids[0][0] + asks[0][0]) / 2, obi: (bidQty - askQty) / (bidQty + askQty || 1), weightedObi: (wb - wa) / (wb + wa || 1) }
}

async function loadDepth(symbol, date) {
  const file = path.join(ROOT, "db", "cash-depth", date, symbol, `${symbol}.jsonl`)
  if (!fs.existsSync(file)) return []
  const fields = {}, result = []
  for await (const row of records(file)) {
    const at = Date.parse(row.receivedAt)
    if (!Number.isFinite(at)) continue
    if (row.kind === "checkpoint" || row.book) { for (const key of Object.keys(fields)) delete fields[key]; Object.assign(fields, row.data) }
    else if (row.kind === "update") Object.assign(fields, row.data)
    else continue
    const metrics = book(fields)
    if (metrics) result.push({ at, ...metrics })
  }
  return result
}

function relativeVolumes(candles) {
  const prior = new Map(), output = []
  for (const bar of candles) {
    const key = timeAt(bar.at), values = prior.get(key) || []
    const sorted = [...values].sort((a, b) => a - b), median = sorted.length ? sorted[Math.floor(sorted.length / 2)] : null
    output.push(median ? bar.volume / median : 0)
    values.push(bar.volume); prior.set(key, values.slice(-4))
  }
  return output
}

function depthByCandle(candles, samples) {
  const map = new Map()
  let start = 0, endIndex = 0
  for (const bar of candles) {
    const end = bar.at + MINUTE, startAt = end - 15_000
    while (start < samples.length && samples[start].at < startAt) start++
    if (endIndex < start) endIndex = start
    while (endIndex < samples.length && samples[endIndex].at < end) endIndex++
    map.set(end, samples.slice(start, endIndex))
  }
  return map
}

function outcome(setup, candles, endAt) {
  for (let index = setup.entryIndex; index < candles.length && candles[index].at < endAt; index++) {
    const bar = candles[index], hitStop = setup.directionSign > 0 ? bar.low <= setup.stopLoss : bar.high >= setup.stopLoss
    const hitTarget = setup.directionSign > 0 ? bar.high >= setup.target : bar.low <= setup.target
    // A one-minute OHLC bar cannot establish intrabar order; use the conservative stop-first rule.
    if (hitStop) return { exitAt: bar.at, exit: setup.stopLoss, exitReason: "STOP" }
    if (hitTarget) return { exitAt: bar.at, exit: setup.target, exitReason: "TARGET" }
  }
  const last = candles.filter((bar) => bar.at < endAt).at(-1)
  return last ? { exitAt: last.at, exit: last.close, exitReason: "LEG_END" } : null
}

function unique(base, extension) {
  let number = 1, file
  do { file = path.join(ROOT, "reports", `${base}${number === 1 ? "" : `-${number}`}.${extension}`); number++ } while (fs.existsSync(file))
  return file
}

const cohortFile = path.join(ROOT, "reports", "2026-10-05-to-2026-10-16-ema10-ema20-over-1p5-trend-legs.csv")
const legs = parseCsv(fs.readFileSync(cohortFile, "utf8"))
const bySymbol = new Map()
for (const leg of legs) bySymbol.set(leg.symbol, [...(bySymbol.get(leg.symbol) || []), leg])
const trades = []
for (const [symbol, symbolLegs] of bySymbol) {
  const candles = loadCandles(symbol), volumes = relativeVolumes(candles)
  for (const date of [...new Set(symbolLegs.map((leg) => leg.date))]) {
    const day = candles.filter((bar) => dateAt(bar.at) === date), depth = await loadDepth(symbol, date)
    const indexByAt = new Map(candles.map((bar, index) => [bar.at, index]))
    const daySetups = findTrendSetups({ candles: day, relativeVolumes: day.map((bar) => volumes[indexByAt.get(bar.at)]), depthAtEnd: depthByCandle(day, depth) })
    for (const setup of daySetups) {
      const leg = symbolLegs.find((x) => x.date === date && x.side === (setup.directionSign > 0 ? "BUY" : "SELL") &&
        timeAt(day[setup.entryIndex].at) >= x.entryTime && timeAt(day[setup.entryIndex].at) < x.exitTime)
      if (!leg) continue
      const endAt = day.find((bar) => timeAt(bar.at) === leg.exitTime)?.at ?? day.at(-1).at + MINUTE
      const exit = outcome(setup, day, endAt)
      if (!exit) continue
      trades.push({ date, symbol, side: leg.side, entryTime: timeAt(day[setup.entryIndex].at), entry: round(setup.entry), stopLoss: round(setup.stopLoss), target: round(setup.target), exitTime: timeAt(exit.exitAt), exit: round(exit.exit), exitReason: exit.exitReason, returnPct: round(setup.directionSign * pct(exit.exit, setup.entry)), maxAdversePct: round(setup.directionSign > 0 ? pct(Math.min(...day.slice(setup.entryIndex, day.findIndex((bar) => bar.at === exit.exitAt) + 1).map((bar) => bar.low)), setup.entry) : pct(setup.entry, Math.max(...day.slice(setup.entryIndex, day.findIndex((bar) => bar.at === exit.exitAt) + 1).map((bar) => bar.high))), 3), obi: round(setup.depth.obi), weightedObi: round(setup.depth.weightedObi) })
    }
  }
}
const returns = trades.map((trade) => trade.returnPct), adverse = trades.map((trade) => trade.maxAdversePct)
const perDay = Object.groupBy(trades, (trade) => trade.date)
const worstDay = Object.entries(perDay).map(([date, rows]) => ({ date, totalReturnPct: round(rows.reduce((sum, row) => sum + row.returnPct, 0)) })).sort((a, b) => a.totalReturnPct - b.totalReturnPct)[0] || null
const summary = { methodology: "Causal balance → accepted breakout → LVN/boundary retest → completed-candle confirmation. Entry is the next candle open. Depth uses only the 15 seconds before the confirmation candle closes. Stops are structural retest swings; targets are 2.5R. The backtest treats same-candle stop/target touches as a stop.", scope: { dates: DATES, cohort: cohortFile, source: "db/candles/<SYMBOL>.jsonl and db/cash-depth/<YYYY-MM-DD>/" }, tradeCount: trades.length, winRatePct: round(100 * trades.filter((trade) => trade.returnPct > 0).length / (trades.length || 1), 2), averageReturnPct: round(returns.reduce((sum, value) => sum + value, 0) / (returns.length || 1)), totalReturnPct: round(returns.reduce((sum, value) => sum + value, 0)), averageMaxAdversePct: round(adverse.reduce((sum, value) => sum + value, 0) / (adverse.length || 1)), worstMaxAdversePct: trades.length ? round(Math.min(...adverse)) : null, worstDay, trades }
const base = "2026-10-05-to-2026-10-19-fabio-trend-lvn-depth-cohort-replay", json = unique(base, "json"), report = unique(base, "md"), tradeCsv = unique(base + "-trades", "csv")
fs.writeFileSync(json, `${JSON.stringify(summary, null, 2)}\n`)
fs.writeFileSync(tradeCsv, `${[Object.keys(trades[0] || { date: "", symbol: "", side: "", entryTime: "", entry: "", stopLoss: "", target: "", exitTime: "", exit: "", exitReason: "", returnPct: "", maxAdversePct: "", obi: "", weightedObi: "" }).join(","), ...trades.map((row) => Object.values(row).map(csv).join(","))].join("\n")}\n`)
fs.writeFileSync(report, `# Fabio trend/LVN/depth replay\n\n- Trades: ${summary.tradeCount}\n- Win rate: ${summary.winRatePct}%\n- Average return: ${summary.averageReturnPct}%\n- Total return: ${summary.totalReturnPct}%\n- Average MAE: ${summary.averageMaxAdversePct}%\n- Worst MAE: ${summary.worstMaxAdversePct}%\n- Worst day: ${summary.worstDay ? `${summary.worstDay.date} (${summary.worstDay.totalReturnPct}%)` : "n/a"}\n\nJSON: \`${json}\`\nTrades CSV: \`${tradeCsv}\`\n`)
console.log(JSON.stringify({ ...summary, trades: undefined, json, report, tradeCsv }, null, 2))
