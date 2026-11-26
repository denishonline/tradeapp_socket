import fs from "node:fs"
import path from "node:path"

const ROOT = process.cwd(), OPTION_ROOT = path.join(ROOT, "db", "option-depth"), REPORT_ROOT = path.join(ROOT, "reports")
const percentile = (values, q) => {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b), index = (sorted.length - 1) * q
  const low = Math.floor(index), high = Math.ceil(index)
  return sorted[low] + (sorted[high] - sorted[low]) * (index - low)
}
const round = (value, digits = 2) => Number.isFinite(value) ? Number(value.toFixed(digits)) : null
const dateOf = (value) => value ? value.slice(0, 10) : null

function loadContract(file) {
  let parsed
  try { parsed = JSON.parse(fs.readFileSync(file, "utf8")) } catch { return null }
  const fields = {}, spreads = [], quoteTimes = new Set(), dates = new Set()
  for (const record of parsed.history || []) {
    Object.assign(fields, record.data || {})
    const bid = Number(fields.bid_price1), ask = Number(fields.ask_price1)
    if (!(bid > 0) || !(ask > bid)) continue
    const mid = (bid + ask) / 2, bps = 10_000 * (ask - bid) / mid
    if (!Number.isFinite(bps) || bps > 10_000) continue
    spreads.push(bps)
    const timestamp = Date.parse(record.receivedAt)
    if (Number.isFinite(timestamp)) quoteTimes.add(Math.floor(timestamp / 60_000))
    const date = dateOf(record.receivedAt); if (date) dates.add(date)
  }
  return spreads.length ? { observations: spreads.length, quotedMinutes: quoteTimes.size, sessions: dates.size,
    medianBps: percentile(spreads, 0.5), p90Bps: percentile(spreads, 0.9) } : null
}

function unique(base, extension) {
  let index = 1, target
  do { target = path.join(REPORT_ROOT, `${base}${index === 1 ? "" : `-${index}`}.${extension}`); index++ } while (fs.existsSync(target))
  return target
}

const rows = []
for (const entry of fs.readdirSync(OPTION_ROOT, { withFileTypes: true }).filter((item) => item.isDirectory())) {
  const stock = entry.name, dir = path.join(OPTION_ROOT, stock)
  const contracts = new Map()
  for (const filename of fs.readdirSync(dir).filter((name) => name.endsWith(".json") && name !== `${stock}.json`)) {
    const match = filename.slice(stock.length, -5).match(/^(\d{2}[A-Z]{3})(\d+(?:\.\d+)?)(CE|PE)$/)
    if (!match) continue
    const [, expiry, strike, side] = match, key = `${expiry}:${strike}`
    const summary = loadContract(path.join(dir, filename))
    if (!summary) continue
    const pair = contracts.get(key) || { expiry, strike: Number(strike) }
    pair[side] = summary; contracts.set(key, pair)
  }
  const pairs = [...contracts.values()].filter((pair) => pair.CE && pair.PE)
  if (!pairs.length) continue
  const scored = pairs.map((pair) => {
    const medianBps = (pair.CE.medianBps + pair.PE.medianBps) / 2
    const p90Bps = (pair.CE.p90Bps + pair.PE.p90Bps) / 2
    const quotedMinutes = Math.min(pair.CE.quotedMinutes, pair.PE.quotedMinutes)
    const sessions = Math.min(pair.CE.sessions, pair.PE.sessions)
    // Cost/continuity proxy only: no claim about direction or option expectancy.
    const score = 0.45 * Math.max(0, 1 - medianBps / 500) + 0.35 * Math.max(0, 1 - p90Bps / 1_000) + 0.20 * Math.min(1, quotedMinutes / 250)
    return { ...pair, medianBps, p90Bps, quotedMinutes, sessions, score }
  }).sort((a, b) => b.score - a.score)
  const best = scored[0]
  rows.push({ stock, expiry: best.expiry, strike: best.strike, pairedStrikes: pairs.length,
    ceMedianSpreadBps: round(best.CE.medianBps), peMedianSpreadBps: round(best.PE.medianBps),
    pairMedianSpreadBps: round(best.medianBps), pairP90SpreadBps: round(best.p90Bps), quotedMinutes: best.quotedMinutes,
    sessions: best.sessions, liquidityScore: round(100 * best.score, 1),
    // The retained option history currently spans only one short observed
    // window, so this can nominate pilot names but cannot certify production
    // liquidity or expected profitability.
    suitability: best.quotedMinutes >= 20 && best.medianBps <= 100 && best.p90Bps <= 150 ? "PILOT"
      : best.quotedMinutes >= 10 && best.medianBps <= 200 && best.p90Bps <= 300 ? "WATCH" : "EXCLUDE" })
}
rows.sort((a, b) => b.liquidityScore - a.liquidityScore || a.stock.localeCompare(b.stock))
const columns = Object.keys(rows[0] || { stock: "" }), csv = unique("delta-hedge-option-buy-liquidity-screen", "csv"), report = unique("delta-hedge-option-buy-liquidity-screen", "md")
fs.writeFileSync(csv, `${[columns.join(","), ...rows.map((row) => columns.map((key) => row[key]).join(","))].join("\n")}\n`)
const grouped = Object.groupBy(rows, (row) => row.suitability)
const names = (label) => (grouped[label] || []).map((row) => row.stock).join(", ") || "None"
fs.writeFileSync(report, `# Delta-hedged option-buy liquidity screen\n\nThis is a **liquidity feasibility** screen over all option-depth directories, not a profit or low-loss prediction. It reconstructs top-of-book updates for each CE/PE contract, pairs same-expiry/same-strike CE and PE, and ranks the best pair by median/p90 relative spread and the number of minutes with valid two-sided quotes. Cash-market depth coverage exists for all 215 local stocks.\n\nThe retained option history covers only one session and 22–34 quote-minutes per leading pair. Therefore PILOT means *lowest observed two-sided spread*, not production approval.\n\n- PILOT: ${names("PILOT")}\n- WATCH: ${names("WATCH")}\n- EXCLUDE: ${names("EXCLUDE")}\n\nA live delta hedge must still require: current ATM option pair, acceptable current spreads, tradable stock hedge quantity, live delta/IV, and a cost-aware rebalance threshold. Historical option bid/ask data is necessary to test P&L; this screen alone cannot establish high profit probability or low loss.\n\nCSV: \`${csv}\`\n`)
console.log(JSON.stringify({ stocksScreened: rows.length, pilot: grouped.PILOT?.length || 0, watch: grouped.WATCH?.length || 0, excluded: grouped.EXCLUDE?.length || 0, csv, report, pilotStocks: (grouped.PILOT || []).map((row) => row.stock) }, null, 2))
