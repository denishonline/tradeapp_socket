import fs from "node:fs"
import path from "node:path"

const root = process.cwd(), date = process.argv[2] ?? "2026-10-21"
const candidates = JSON.parse(fs.readFileSync(path.join(root, "reports", `${date}-selective-breakdown-candidate-research.json`), "utf8")).candidates
const selected = [], used = new Set()
for (const row of candidates) {
  if (row.signalMinute > 690 || used.has(row.symbol) || row.signalVolumeMultiple < 1 ||
    row.signalBodyPct < .05 || row.belowVwapPct < .2 || row.signalVs5AgoPct > -.2 ||
    row.signalVsOpenPct > -1) continue
  used.add(row.symbol)
  selected.push(row)
}
const minute = text => Number(text.slice(0, 2)) * 60 + Number(text.slice(3, 5))
const stamp = iso => new Date(Date.parse(iso) + 330 * 60_000).toISOString().slice(0, 16).replace("T", " ")
const mean = values => values.reduce((sum, x) => sum + x, 0) / values.length
for (const row of selected) {
  const file = path.join(root, "db", "cash-depth", date, row.symbol, `${row.symbol}.jsonl`)
  if (!fs.existsSync(file)) { row.depth = null; continue }
  const state = {}, byMinute = new Map()
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    if (!line) continue
    let event
    try { event = JSON.parse(line) } catch { continue }
    const time = stamp(event.receivedAt)
    if (time.slice(0, 10) !== date) continue
    const m = minute(time.slice(11))
    if (m > row.signalMinute) break
    if (event.kind === "checkpoint") for (const key of Object.keys(state)) delete state[key]
    Object.assign(state, event.data ?? {})
    let bid = 0, ask = 0, valid = true
    for (let level = 1; level <= 5; level++) {
      const bp = +state[`bid_price${level}`], ap = +state[`ask_price${level}`]
      const bs = +state[`bid_size${level}`], as = +state[`ask_size${level}`]
      if (![bp, ap, bs, as].every(Number.isFinite) || bp <= 0 || ap <= bp) { valid = false; break }
      bid += bs; ask += as
    }
    if (!valid || bid + ask <= 0) continue
    const snapshots = byMinute.get(m) ?? []
    snapshots.push({ sellShare: 100 * ask / (bid + ask), midpoint: (+state.bid_price1 + +state.ask_price1) / 2 })
    byMinute.set(m, snapshots)
  }
  const groups = Array.from({ length: 5 }, (_, k) => byMinute.get(row.signalMinute - 4 + k)).filter(Boolean)
  const minuteMeans = groups.map(group => ({ sellShare: mean(group.map(x => x.sellShare)), midpoint: mean(group.map(x => x.midpoint)) }))
  row.depth = { minutes: groups.length, snapshots: groups.reduce((sum, group) => sum + group.length, 0),
    sellSharePct: groups.length === 5 ? +mean(minuteMeans.map(x => x.sellShare)).toFixed(3) : null,
    midpointMovePct: groups.length >= 2 ? +(100 * (minuteMeans.at(-1).midpoint / minuteMeans[0].midpoint - 1)).toFixed(3) : null }
}
console.log(JSON.stringify(selected.map(x => ({ symbol: x.symbol, time: x.signalTime.slice(11),
  volume: x.signalVolumeMultiple, body: x.signalBodyPct, move: x.signalVs5AgoPct,
  depth: x.depth, outcome: x.exitReason })), null, 2))
