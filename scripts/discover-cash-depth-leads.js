import fs from "node:fs"
import path from "node:path"
import readline from "node:readline"
import { readdir } from "node:fs/promises"

const root = process.cwd()
const cashRoot = path.join(root, "db", "cash-depth")
const targetPct = Number(process.argv[2] ?? 3)
if (!Number.isFinite(targetPct) || targetPct <= 0 || targetPct > 20) throw new Error("Usage: node scripts/discover-cash-depth-leads.js [forward-gain-percent]")
const stopPct = 0.5
const date = (await readdir(cashRoot, { withFileTypes: true }))
  .filter((entry) => entry.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(entry.name))
  .map((entry) => entry.name)
  .sort()
  .at(-1)
if (!date) throw new Error("No cash-depth date folder found")
const dateDirectory = path.join(cashRoot, date)
const files = []
for (const entry of await readdir(dateDirectory, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue
  const filename = path.join(dateDirectory, entry.name, `${entry.name}.jsonl`)
  if (fs.existsSync(filename)) files.push({ symbol: entry.name, filename })
}

async function* records(filename) {
  const input = fs.createReadStream(filename, { encoding: "utf8" })
  const lines = readline.createInterface({ input, crlfDelay: Infinity })
  try {
    for await (const line of lines) {
      if (!line.trim()) continue
      try { yield JSON.parse(line) } catch { /* Ignore an incomplete last row. */ }
    }
  } finally { lines.close(); input.destroy() }
}

function metrics(data) {
  let bid = 0, ask = 0, nearBid = 0, nearAsk = 0
  const bids = [], asks = []
  for (let level = 1; level <= 5; level++) {
    const bp = Number(data[`bid_price${level}`]), bq = Number(data[`bid_size${level}`])
    const ap = Number(data[`ask_price${level}`]), aq = Number(data[`ask_size${level}`])
    if (![bp, bq, ap, aq].every(Number.isFinite) || bp <= 0 || ap <= 0 || bq < 0 || aq < 0) return null
    if (level > 1 && (bp > bids.at(-1).price || ap < asks.at(-1).price)) return null
    bids.push({ price: bp, qty: bq }); asks.push({ price: ap, qty: aq })
    bid += bq; ask += aq
    if (level <= 2) { nearBid += bq; nearAsk += aq }
  }
  if (bids[0].price >= asks[0].price || bid + ask === 0) return null
  const mid = (bids[0].price + asks[0].price) / 2
  return {
    imbalance: (bid - ask) / (bid + ask), bidQty: bid, askQty: ask,
    nearBid, nearAsk, spreadPct: (asks[0].price - bids[0].price) / mid * 100,
  }
}

const all = []
let earliestAt = Infinity, latestAt = 0
for (const file of files) {
  const raw = {}, minuteMap = new Map()
  let lastAt = 0
  for await (const record of records(file.filename)) {
    const at = Date.parse(record.receivedAt)
    if (!Number.isFinite(at) || new Date(at + 330 * 60_000).toISOString().slice(0, 10) !== date) continue
    earliestAt = Math.min(earliestAt, at); latestAt = Math.max(latestAt, at)
    if (lastAt && at - lastAt > 90_000) for (const key of Object.keys(raw)) delete raw[key]
    lastAt = at
    if (record.kind === "checkpoint" || record.book) {
      for (const key of Object.keys(raw)) delete raw[key]
      Object.assign(raw, record.data)
    } else if (record.kind === "update") Object.assign(raw, record.data)
    else continue
    const book = metrics(raw)
    const context = record.marketContext
    const price = Number(context?.price)
    const priceAt = Date.parse(context?.priceAt) || at
    const volume = Number(context?.cumulativeVolume)
    if (!book || !Number.isFinite(price) || price <= 0 || priceAt > at + 1_000) continue
    const minute = Math.floor(priceAt / 60_000)
    const bucket = minuteMap.get(minute) ?? {
      at: minute * 60_000, priceOpen: price, priceHigh: price, priceLow: price, priceClose: price,
      depthCount: 0, imbalance: 0, bidQty: 0, askQty: 0, nearBid: 0, nearAsk: 0, spreadPct: 0,
      volume: null,
    }
    bucket.priceHigh = Math.max(bucket.priceHigh, price)
    bucket.priceLow = Math.min(bucket.priceLow, price)
    bucket.priceClose = price
    bucket.depthCount++
    bucket.imbalance += book.imbalance
    bucket.bidQty += book.bidQty
    bucket.askQty += book.askQty
    bucket.nearBid += book.nearBid
    bucket.nearAsk += book.nearAsk
    bucket.spreadPct += book.spreadPct
    if (Number.isSafeInteger(volume) && volume >= 0) bucket.volume = Math.max(bucket.volume ?? volume, volume)
    minuteMap.set(minute, bucket)
  }
  const minutes = [...minuteMap.values()].sort((a, b) => a.at - b.at)
  for (const minute of minutes) {
    const n = minute.depthCount
    for (const key of ["imbalance", "bidQty", "askQty", "nearBid", "nearAsk", "spreadPct"]) minute[key] /= n
  }
  if (minutes.length) all.push({ symbol: file.symbol, minutes })
}

const fmt = (at) => new Intl.DateTimeFormat("en-IN", {
  timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
}).format(new Date(at))
const hits = []
let evaluatedSignals = 0, stoppedSignals = 0, unresolvedSignals = 0
const triggerNames = ["Bid pressure shifts up", "Bid depth builds", "Ask depth thins", "Spread tightens with stable pressure", "Trade volume accelerates"]
for (const stock of all) {
  const rows = stock.minutes
  const active = new Set()
  for (let index = 10; index < rows.length; index++) {
    const prior = rows.slice(index - 10, index - 5), recent = rows.slice(index - 5, index)
    if (prior.length < 4 || recent.length < 4 || rows[index - 1].at - rows[index - 10].at !== 9 * 60_000) {
      active.clear()
      continue
    }
    const avg = (key, xs) => xs.reduce((sum, x) => sum + (x[key] ?? 0), 0) / xs.length
    const p = Object.fromEntries(["imbalance", "bidQty", "askQty", "nearBid", "nearAsk", "spreadPct"].map((key) => [key, avg(key, prior)]))
    const r = Object.fromEntries(["imbalance", "bidQty", "askQty", "nearBid", "nearAsk", "spreadPct"].map((key) => [key, avg(key, recent)]))
    const p0 = prior[0].volume, p1 = prior.at(-1).volume, r0 = recent[0].volume, r1 = recent.at(-1).volume
    const oldVol = p0 != null && p1 != null ? Math.max(0, p1 - p0) : null
    const newVol = r0 != null && r1 != null ? Math.max(0, r1 - r0) : null
    const priceNow = recent.at(-1).priceClose
    const priceChangeRecentPct = (priceNow / recent[0].priceOpen - 1) * 100
    const checks = [
      r.imbalance - p.imbalance >= 0.1 && r.imbalance > p.imbalance,
      p.bidQty > 0 && r.bidQty >= p.bidQty * 1.25 && r.askQty <= p.askQty * 1.25,
      p.askQty > 0 && r.askQty <= p.askQty * 0.75 && r.bidQty >= p.bidQty * 0.9,
      p.spreadPct > 0 && r.spreadPct <= p.spreadPct * 0.75 && r.imbalance >= p.imbalance,
      oldVol != null && newVol != null && oldVol >= 1_000 && newVol >= Math.max(10_000, oldVol * 1.5) && priceChangeRecentPct > 0,
    ]
    const timeAt = recent.at(-1).at
    for (let k = 0; k < checks.length; k++) {
      if (!checks[k]) { active.delete(k); continue }
      if (active.has(k)) continue
      active.add(k)
      evaluatedSignals++
      let outcome = null, crossing = null, maxGain = 0
      const stopPrice = priceNow * (1 - stopPct / 100)
      const targetPrice = priceNow * (1 + targetPct / 100)
      for (let future = index; future < rows.length; future++) {
        const gain = (rows[future].priceHigh / priceNow - 1) * 100
        maxGain = Math.max(maxGain, gain)
        const stopHit = rows[future].priceLow <= stopPrice
        const targetHit = rows[future].priceHigh >= targetPrice
        if (stopHit) { outcome = "stop"; break }
        if (targetHit) { outcome = "target"; crossing = rows[future]; break }
      }
      if (outcome === "stop") stoppedSignals++
      else if (!crossing) unresolvedSignals++
      else hits.push({
        signalTime: fmt(timeAt), symbol: stock.symbol, behavior: triggerNames[k],
        signalPrice: Number(priceNow.toFixed(2)), crossedTargetAt: fmt(crossing.at),
        minutesToTarget: Number(((crossing.at - timeAt) / 60_000).toFixed(1)),
        maxGainAfterSignalPct: Number(maxGain.toFixed(2)),
        stopPrice: Number(stopPrice.toFixed(2)), targetPrice: Number(targetPrice.toFixed(2)),
        imbalanceShift5m: Number((r.imbalance - p.imbalance).toFixed(3)),
      })
    }
  }
}
hits.sort((a, b) => a.signalTime.localeCompare(b.signalTime) || a.symbol.localeCompare(b.symbol))
console.log(`Exploratory cash-depth lead scan: ${date}, ${fmt(earliestAt)}–${fmt(latestAt)} IST. Compares five-minute depth/volume changes with a subsequent +${targetPct}% move from signal price.`)
console.log("Candidate triggers: +0.10 imbalance shift; +25% bid-depth build; −25% ask-depth thinning; 25% spread tightening with non-worsening imbalance; or 1.5x+ volume acceleration.")
console.log(`Risk filter: entry at signal price, stop −${stopPct}%, target +${targetPct}%; when both levels appear in one minute bar, stop is counted first.`)
if (hits.length) {
  const grouped = new Map()
  for (const hit of hits) {
    const group = grouped.get(hit.symbol) ?? { symbol: hit.symbol, behaviors: new Set(), setups: 0, firstSignal: hit.signalTime, firstTarget: hit.crossedTargetAt, strongest: hit }
    group.behaviors.add(hit.behavior)
    group.setups++
    if (hit.signalTime < group.firstSignal) group.firstSignal = hit.signalTime
    if (hit.crossedTargetAt < group.firstTarget) group.firstTarget = hit.crossedTargetAt
    if (hit.maxGainAfterSignalPct > group.strongest.maxGainAfterSignalPct) group.strongest = hit
    grouped.set(hit.symbol, group)
  }
  const summary = [...grouped.values()].map((group) => ({
    symbol: group.symbol,
    behaviors: [...group.behaviors].join(", "),
    setups: group.setups,
    firstSignal: group.firstSignal,
    firstTarget: group.firstTarget,
    bestSignal: `${group.strongest.signalTime} (${group.strongest.behavior})`,
    maxGainPct: group.strongest.maxGainAfterSignalPct,
  })).sort((a, b) => b.maxGainPct - a.maxGainPct)
  console.log(`Stocks with at least one qualifying signal: ${summary.length}`)
  console.table(summary)
}
else console.log(`No tested depth-change trigger reached +${targetPct}% before hitting the -${stopPct}% stop in the captured data.`)
console.log(`Risk filter: ${evaluatedSignals} signal events evaluated; ${hits.length} reached target before stop; ${stoppedSignals} hit stop first; ${unresolvedSignals} reached neither before capture ended.`)
console.log("Exploratory thresholds are screening rules, not validated predictive signals.")
