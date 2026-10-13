import fs from "node:fs"
import path from "node:path"

const ROOT = process.cwd(), MINUTE = 60_000
const input = path.join(ROOT, "csv", "2026-10-12-to-13-strategy-radar-stop-path-audit.csv")
const output = path.join(ROOT, "csv", "2026-10-12-to-13-strategy-radar-filter-audit.csv")
const parseCsv = (filename) => {
  const text = fs.readFileSync(filename, "utf8"), records = []
  let row = [], value = "", quoted = false
  for (let index = 0; index < text.length; index++) {
    const char = text[index]
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') { value += '"'; index++ }
      else if (char === '"') quoted = false
      else value += char
    } else if (char === '"') quoted = true
    else if (char === ",") { row.push(value); value = "" }
    else if (char === "\n") { row.push(value.replace(/\r$/, "")); records.push(row); row = []; value = "" }
    else value += char
  }
  const columns = records.shift()
  return records.filter((record) => record.some(Boolean)).map((record) =>
    Object.fromEntries(columns.map((column, index) => [column, record[index] ?? ""])))
}
const csvValue = (value) => {
  const text = value == null ? "" : String(value)
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
}

const reasonBySymbol = {
  SUPREMEIND: "10-minute move was already extended; breakout produced no durable follow-through",
  EXIDEIND: "Extended setup and late-day breakout with no positive excursion",
  NESTLEIND: "Overextended 10-minute trend; price peaked below target then fully reversed",
  SBILIFE: "Candle/depth breakout lacked a strong flow, momentum or relative-volume leg",
  DIVISLAB: "Valid broad setup, but follow-through stalled below half the target",
  IREDA: "Price recovery conflicted with falling depth and negative top-two imbalance",
  INOXWIND: "Recovery was already stretched and reversed immediately after entry",
  ICICIGI: "Only 6.7% positive-depth minutes with negative imbalance and negative depth change",
  PFC: "Only 13.3% positive-depth minutes and strongly negative top-two imbalance",
  CYIENT: "Opening sell signal failed to confirm and reversed sharply within two minutes",
  CYIENTDLM: "Opening sell signal failed to confirm and reversed sharply within two minutes",
  PAYTM: "Sell move was deeply extended and failed the fresh downside confirmation",
  FORTIS: "Two-percent target was emitted with only about 22 minutes left in the session",
  DMART: "Confirmed direction, but the weak-recovery branch did not reach its two-percent target",
  RBLBANK: "Normal whipsaw: stopped first, then reached the original target later",
  MCX: "Bid collapse was incomplete; 29.6% bid share remained after the sweep",
  MFSL: "Bid collapse was incomplete; 30.2% bid share remained after the sweep",
  POLICYBZR: "Bid collapse was incomplete; 24.6% bid share remained; target came only after stop",
  RELIANCE: "Persistent-depth setup had no 0.05% price confirmation within five minutes",
  TATACONSUM: "Persistent-depth setup had no 0.05% price confirmation within five minutes",
}
const confirmationRejected = new Set([
  "IREDA", "INOXWIND", "ICICIGI", "PFC", "CYIENT", "CYIENTDLM", "PAYTM",
  "RELIANCE", "TATACONSUM",
])

const rows = parseCsv(input).filter((row) => row.savedStatus === "Stopped").map((row) => {
  const metrics = JSON.parse(row.metrics || "{}")
  let decision = "KEEP"
  let filter = "No broad winner-preserving entry filter found"
  if (row.strategy === "Bid Support Breakout") {
    const quality = Number(metrics.liveFlow) >= 0.30 || Number(metrics.return3Pct) >= 0.15 ||
      Number(metrics.volume5Ratio) >= 0.50
    if (Number(metrics.trendPct) > 1 || !quality) decision = "FILTER"
    filter = "trendPct <= 1.00 and (liveFlow >= 0.30 or return3Pct >= 0.15 or volume5Ratio >= 0.50)"
  } else if (row.strategy === "Failed Bid Absorption") {
    if (Number(metrics.postSweepBidSharePct) > 20) decision = "FILTER"
    filter = "postSweepBidSharePct <= 20"
  } else if (row.strategy === "Multi-Frame Depth Recovery") {
    if (confirmationRejected.has(row.symbol)) decision = "FILTER"
    filter = "confirm +0.08% within 20m; cancel at -0.20%"
  } else if (row.strategy === "Multi-Frame Depth Continuation") {
    if (confirmationRejected.has(row.symbol) || row.symbol === "FORTIS") decision = "FILTER"
    filter = "confirm +0.20% SELL progress within 10m; cancel at -0.40%; no 2% entry after 14:30"
  } else if (row.strategy === "Persistent Bid Absorption Breakout") {
    if (confirmationRejected.has(row.symbol)) decision = "FILTER"
    filter = "confirm +0.05% within 5m; cancel at -0.15%"
  }
  return { date: row.date, strategy: row.strategy, symbol: row.symbol, signalIst: row.signalIst,
    decision, reason: reasonBySymbol[row.symbol] || "Insufficient post-signal continuation",
    proposedFilter: filter, mfePct: row.mfePct, maePct: row.maePct,
    targetEventually: row.targetEventually, eodReturnPct: row.eodReturnPct }
})
const columns = Object.keys(rows[0])
fs.writeFileSync(output, `${columns.join(",")}\n${rows.map((row) =>
  columns.map((column) => csvValue(row[column])).join(",")).join("\n")}\n`)
console.log(JSON.stringify({ output, stoppedSignals: rows.length,
  filtered: rows.filter((row) => row.decision === "FILTER").length,
  kept: rows.filter((row) => row.decision === "KEEP").map((row) => row.symbol) }, null, 2))
