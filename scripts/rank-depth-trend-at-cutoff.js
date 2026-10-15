import fs from "node:fs"
import path from "node:path"
import readline from "node:readline"

const ROOT = process.cwd()
const DEPTH_ROOT = path.join(ROOT, "db", "cash-depth")
const CANDLE_ROOT = path.join(ROOT, "db", "candles")
const MINUTE = 60_000
const IST_OFFSET = 330 * MINUTE

const WEIGHTS = Object.freeze({
  priceResponse: 0.22,
  ofi: 0.18,
  tradeDelta: 0.16,
  liquidityDynamics: 0.14,
  persistence: 0.12,
  spreadDepthQuality: 0.08,
  depthPriceDivergence: 0.10,
})

const clamp = (value, low = 0, high = 1) => Math.max(low, Math.min(high, value))
const mean = (values) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : NaN
const sum = (values) => values.reduce((total, value) => total + value, 0)
const pct = (value, base) => base > 0 ? (value / base - 1) * 100 : NaN
const round = (value, digits = 4) => Number.isFinite(value) ? Number(value.toFixed(digits)) : null
const indiaDate = (at) => new Date(at + IST_OFFSET).toISOString().slice(0, 10)
const indiaTime = (at) => new Date(at + IST_OFFSET).toISOString().slice(11, 19)
const dateTime = (at) => `${indiaDate(at)} ${indiaTime(at)}`

function commandLine(argv) {
  const options = { cutoff: null, minutes: 5, top: 5, output: null }
  for (let index = 0; index < argv.length; index++) {
    const value = argv[index]
    if (value === "--cutoff") options.cutoff = argv[++index]
    else if (value.startsWith("--cutoff=")) options.cutoff = value.slice(9)
    else if (value === "--minutes") options.minutes = Number(argv[++index])
    else if (value.startsWith("--minutes=")) options.minutes = Number(value.slice(10))
    else if (value === "--top") options.top = Number(argv[++index])
    else if (value.startsWith("--top=")) options.top = Number(value.slice(6))
    else if (value === "--output") options.output = argv[++index]
    else if (value.startsWith("--output=")) options.output = value.slice(9)
    else if (value === "--help" || value === "-h") options.help = true
    else throw new Error(`Unknown option: ${value}`)
  }
  if (!Number.isInteger(options.minutes) || options.minutes < 3 || options.minutes > 30) {
    throw new Error("--minutes must be an integer from 3 through 30")
  }
  if (!Number.isInteger(options.top) || options.top < 1 || options.top > 50) {
    throw new Error("--top must be an integer from 1 through 50")
  }
  return options
}

function usage() {
  return [
    "Usage:",
    "  node scripts/rank-depth-trend-at-cutoff.js --cutoff \"2026-10-15 10:20\"",
    "  node scripts/rank-depth-trend-at-cutoff.js --cutoff 10:20 --minutes 5 --top 5",
    "",
    "Cutoff is exclusive and interpreted in IST. HH:MM uses the newest archived date.",
    "Only fully completed one-minute candles and depth received before the cutoff are used.",
  ].join("\n")
}

function availableDates() {
  if (!fs.existsSync(DEPTH_ROOT)) return []
  return fs.readdirSync(DEPTH_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(entry.name))
    .map((entry) => entry.name).sort()
}

function cutoffTimestamp(raw, newestDate) {
  if (!raw) throw new Error(usage())
  const value = String(raw).trim()
  let normalized
  if (/^\d{2}:\d{2}(:\d{2})?$/.test(value)) {
    normalized = `${newestDate}T${value}${value.length === 5 ? ":00" : ""}+05:30`
  } else if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2})?$/.test(value)) {
    normalized = `${value.replace(" ", "T")}${value.length === 16 ? ":00" : ""}+05:30`
  } else normalized = value
  const parsed = Date.parse(normalized)
  if (!Number.isFinite(parsed)) throw new Error(`Invalid cutoff '${raw}'`)
  return parsed
}

async function* jsonLines(filename) {
  const input = fs.createReadStream(filename, { encoding: "utf8" })
  const lines = readline.createInterface({ input, crlfDelay: Infinity })
  try {
    for await (const line of lines) {
      if (!line.trim()) continue
      try { yield JSON.parse(line) } catch { /* Ignore an incomplete final record. */ }
    }
  } finally {
    lines.close()
    input.destroy()
  }
}

function completeBook(fields) {
  const bids = [], asks = []
  let bidOrders = 0, askOrders = 0
  for (let level = 1; level <= 5; level++) {
    const bid = { price: Number(fields[`bid_price${level}`]), size: Number(fields[`bid_size${level}`]) }
    const ask = { price: Number(fields[`ask_price${level}`]), size: Number(fields[`ask_size${level}`]) }
    if (![bid.price, bid.size, ask.price, ask.size].every(Number.isFinite) ||
        bid.price <= 0 || ask.price <= bid.price || bid.size < 0 || ask.size < 0) return null
    bids.push(bid); asks.push(ask)
    bidOrders += Number(fields[`bid_order${level}`]) || 0
    askOrders += Number(fields[`ask_order${level}`]) || 0
  }
  const bidSize = sum(bids.map((row) => row.size)), askSize = sum(asks.map((row) => row.size))
  const bidTop2 = bids[0].size + bids[1].size, askTop2 = asks[0].size + asks[1].size
  const mid = (bids[0].price + asks[0].price) / 2
  return {
    bid: bids[0].price, ask: asks[0].price, bid1: bids[0].size, ask1: asks[0].size,
    bidSize, askSize, mid,
    full: (bidSize - askSize) / (bidSize + askSize || 1),
    top2: (bidTop2 - askTop2) / (bidTop2 + askTop2 || 1),
    orders: (bidOrders - askOrders) / (bidOrders + askOrders || 1),
    spreadBps: 10_000 * (asks[0].price - bids[0].price) / mid,
  }
}

function transition(current, previous) {
  const epsilon = 1e-9
  return {
    bidReplenish: current.bid > previous.bid ||
      current.bid === previous.bid && current.bid1 > previous.bid1 * 1.10 + epsilon,
    askReplenish: current.ask < previous.ask ||
      current.ask === previous.ask && current.ask1 > previous.ask1 * 1.10 + epsilon,
    askDeplete: current.ask > previous.ask ||
      current.ask === previous.ask && current.ask1 < previous.ask1 * 0.90 - epsilon,
    bidDeplete: current.bid < previous.bid ||
      current.bid === previous.bid && current.bid1 < previous.bid1 * 0.90 - epsilon,
  }
}

async function loadDepth(symbol, date, storeFrom, cutoff) {
  const filename = path.join(DEPTH_ROOT, date, symbol, `${symbol}.jsonl`)
  if (!fs.existsSync(filename)) return []
  const fields = {}, samples = []
  let previous = null, lastTradeDirection = 0
  for await (const record of jsonLines(filename)) {
    const at = Date.parse(record.receivedAt)
    if (!Number.isFinite(at) || at >= cutoff) continue
    if (previous && at - previous.at > 90_000) {
      previous = null; lastTradeDirection = 0
      for (const key of Object.keys(fields)) delete fields[key]
    }
    if (record.kind === "checkpoint" || record.book) {
      for (const key of Object.keys(fields)) delete fields[key]
      Object.assign(fields, record.data)
    } else if (record.kind === "update") Object.assign(fields, record.data)
    else continue

    const book = completeBook(fields)
    const price = Number(record.marketContext?.price)
    const cumulativeVolume = Number(record.marketContext?.cumulativeVolume)
    if (!book || !(price > 0) || !Number.isFinite(cumulativeVolume)) continue
    let ofi = 0, traded = 0, signed = 0
    let changes = { bidReplenish: false, askReplenish: false, askDeplete: false, bidDeplete: false }
    if (previous) {
      let rawOfi = book.bid > previous.bid ? book.bid1
        : book.bid === previous.bid ? book.bid1 - previous.bid1 : -previous.bid1
      rawOfi -= book.ask < previous.ask ? book.ask1
        : book.ask === previous.ask ? book.ask1 - previous.ask1 : -previous.ask1
      ofi = rawOfi / ((book.bid1 + book.ask1 + previous.bid1 + previous.ask1) / 2 || 1)
      traded = cumulativeVolume >= previous.cumulativeVolume
        ? cumulativeVolume - previous.cumulativeVolume : 0
      if (price > previous.price) lastTradeDirection = 1
      else if (price < previous.price) lastTradeDirection = -1
      signed = traded * lastTradeDirection
      changes = transition(book, previous)
    }
    if (at >= storeFrom) samples.push({ at, price, cumulativeVolume, ofi, traded, signed, ...changes, ...book })
    previous = { at, price, cumulativeVolume, ...book }
  }
  return samples
}

function loadCandles(symbol, date, start, cutoff) {
  const filename = path.join(CANDLE_ROOT, `${symbol}.jsonl`)
  if (!fs.existsSync(filename)) return new Map()
  const rows = fs.readFileSync(filename, "utf8").split(/\r?\n/).flatMap((line) => {
    if (!line.trim()) return []
    try {
      const value = JSON.parse(line), at = Number(value.time) * 1000
      if (!Number.isFinite(at) || indiaDate(at) !== date || at < start || at + MINUTE > cutoff || value.partial) return []
      const row = { at, open: Number(value.open), high: Number(value.high), low: Number(value.low),
        close: Number(value.close), volume: Number(value.volume) }
      return Object.values(row).every(Number.isFinite) ? [row] : []
    } catch { return [] }
  })
  return new Map(rows.map((row) => [row.at, row]))
}

function maximumRun(values) {
  let current = 0, maximum = 0
  for (const value of values) {
    current = value ? current + 1 : 0
    maximum = Math.max(maximum, current)
  }
  return maximum
}

function minuteMetric(at, samples, candle) {
  if (!samples.length) return null
  const traded = sum(samples.map((row) => row.traded))
  const gaps = samples.slice(1).map((row, index) => (row.at - samples[index].at) / 1000)
  const maximumGapSeconds = gaps.length ? Math.max(...gaps) : 60
  const spanSeconds = (samples.at(-1).at - samples[0].at) / 1000
  const depthPriceReturnPct = pct(samples.at(-1).price, samples[0].price)
  const candleReturnPct = candle ? pct(candle.close, candle.open) : depthPriceReturnPct
  const quality = clamp(spanSeconds / 45) * clamp(samples.length / 10) *
    (1 - clamp((maximumGapSeconds - 5) / 20))
  return {
    at, samples: samples.length, spanSeconds, maximumGapSeconds, quality,
    priceReturnPct: candleReturnPct,
    midReturnPct: pct(samples.at(-1).mid, samples[0].mid),
    ofi: mean(samples.map((row) => row.ofi)),
    full: mean(samples.map((row) => row.full)),
    top2: mean(samples.map((row) => row.top2)),
    orders: mean(samples.map((row) => row.orders)),
    closeFull: samples.at(-1).full,
    spreadBps: mean(samples.map((row) => row.spreadBps)),
    traded, delta: traded ? sum(samples.map((row) => row.signed)) / traded : 0,
    bidReplenishRate: mean(samples.map((row) => Number(row.bidReplenish))),
    askReplenishRate: mean(samples.map((row) => Number(row.askReplenish))),
    askDepleteRate: mean(samples.map((row) => Number(row.askDeplete))),
    bidDepleteRate: mean(samples.map((row) => Number(row.bidDeplete))),
  }
}

function sideScores(metrics, direction, quality) {
  const directionalPrice = direction * metrics.priceReturnPct
  const directionalMid = direction * metrics.midReturnPct
  const directionalDelta = direction * metrics.delta
  const directionalOfi = direction * metrics.ofi
  const directionalDepth = direction * metrics.full
  const directionalClosingDepth = direction * metrics.closeFull
  const directionalDepthShift = direction * metrics.depthShift

  const priceProgress = mean([
    clamp(directionalPrice / 0.20),
    clamp(directionalMid / 0.15),
  ])
  const absorptionResponse = directionalDelta < 0 && directionalPrice >= -0.02
    ? clamp(-directionalDelta / 0.50) * clamp((directionalPrice + 0.02) / 0.10) : 0
  const aggressiveResponse = directionalDelta > 0
    ? clamp(directionalDelta / 0.50) * clamp((directionalPrice + 0.01) / 0.12) : 0
  const priceResponse = 100 * (0.70 * priceProgress +
    0.30 * Math.max(aggressiveResponse, absorptionResponse))

  const ofi = 100 * (0.70 * clamp(directionalOfi / 0.20) +
    0.30 * clamp(direction * metrics.ofiShift / 0.15))

  const flowAgreement = clamp(directionalDelta / 0.60) * clamp((directionalPrice + 0.01) / 0.12)
  const tradeDelta = 100 * (0.70 * clamp(directionalDelta / 0.60) + 0.30 * flowAgreement)

  const supportRate = direction > 0 ? metrics.bidReplenishRate : metrics.askReplenishRate
  const opposingDepletionRate = direction > 0 ? metrics.askDepleteRate : metrics.bidDepleteRate
  const opposingReplenishmentRate = direction > 0 ? metrics.askReplenishRate : metrics.bidReplenishRate
  const liquidityDynamics = 100 * clamp(0.55 * supportRate + 0.55 * opposingDepletionRate -
    0.30 * opposingReplenishmentRate)

  const persistentMinutes = metrics.minutes.map((row) => {
    const votes = Number(direction * row.priceReturnPct > 0) + Number(direction * row.ofi > 0) +
      Number(direction * row.delta > 0) + Number(direction * row.full > 0)
    return votes >= 3
  })
  const persistence = 100 * (0.65 * mean(persistentMinutes.map(Number)) +
    0.35 * maximumRun(persistentMinutes) / metrics.minutes.length)

  const spreadStability = 1 - clamp(Math.max(0, metrics.spreadExpansionPct) / 60)
  const depthSupport = mean([
    clamp(directionalDepth / 0.25),
    clamp(directionalClosingDepth / 0.30),
    clamp(directionalDepthShift / 0.20),
  ])
  const spreadDepthQuality = 100 * quality * (0.30 * spreadStability + 0.70 * depthSupport)

  const adverseDeltaAbsorption = directionalDelta < 0 && directionalPrice >= -0.02
    ? clamp(-directionalDelta / 0.50) * clamp((directionalPrice + 0.02) / 0.10) : 0
  const oppositeBookProgress = directionalDepth < 0 && directionalPrice > 0
    ? clamp(-directionalDepth / 0.25) * clamp(directionalPrice / 0.12) : 0
  const depthPriceDivergence = 100 * Math.max(adverseDeltaAbsorption, oppositeBookProgress)

  const components = { priceResponse, ofi, tradeDelta, liquidityDynamics, persistence,
    spreadDepthQuality, depthPriceDivergence }
  const weighted = Object.entries(WEIGHTS).reduce((total, [key, weight]) => total + weight * components[key], 0)
  let conflictPenalty = 0
  const conflicts = []
  if (directionalPrice < -0.03) { conflictPenalty += 8; conflicts.push("price opposes") }
  if (directionalOfi < -0.04) { conflictPenalty += 5; conflicts.push("OFI opposes") }
  if (directionalDelta < -0.20 && directionalPrice < 0) { conflictPenalty += 7; conflicts.push("delta confirms opposite") }
  const score = clamp((weighted - conflictPenalty) * (0.40 + 0.60 * quality), 0, 100)
  return { score, components, conflictPenalty, conflicts }
}

function summarizeStock(symbol, minutes, windowStart, cutoff) {
  const available = minutes.filter(Boolean)
  if (!available.length) return null
  const traded = sum(available.map((row) => row.traded))
  const earlyCount = Math.max(1, Math.floor(available.length / 2))
  const early = available.slice(0, earlyCount), recent = available.slice(earlyCount)
  const averageSpread = mean(available.map((row) => row.spreadBps))
  const firstSpread = mean(early.map((row) => row.spreadBps))
  const finalSpread = mean(available.slice(-Math.max(1, Math.ceil(available.length / 2))).map((row) => row.spreadBps))
  const lastAt = available.at(-1).at + MINUTE
  const completeness = available.length / minutes.length
  const freshness = 1 - clamp((cutoff - lastAt) / (2 * MINUTE))
  const quality = completeness * mean(available.map((row) => row.quality)) * freshness
  const full = mean(available.map((row) => row.full))
  const metrics = {
    minutes: available,
    priceReturnPct: sum(available.map((row) => row.priceReturnPct)),
    midReturnPct: sum(available.map((row) => row.midReturnPct)),
    ofi: mean(available.map((row) => row.ofi)),
    ofiShift: mean((recent.length ? recent : early).map((row) => row.ofi)) - mean(early.map((row) => row.ofi)),
    full,
    closeFull: available.at(-1).closeFull,
    depthShift: mean((recent.length ? recent : early).map((row) => row.full)) - mean(early.map((row) => row.full)),
    delta: traded ? sum(available.map((row) => row.delta * row.traded)) / traded : 0,
    bidReplenishRate: mean(available.map((row) => row.bidReplenishRate)),
    askReplenishRate: mean(available.map((row) => row.askReplenishRate)),
    askDepleteRate: mean(available.map((row) => row.askDepleteRate)),
    bidDepleteRate: mean(available.map((row) => row.bidDepleteRate)),
    spreadExpansionPct: firstSpread > 0 ? 100 * (finalSpread / firstSpread - 1) : 0,
  }
  const buy = sideScores(metrics, 1, quality), sell = sideScores(metrics, -1, quality)
  const eligible = available.length >= Math.max(3, minutes.length - 1) && quality >= 0.45
  const componentNames = {
    priceResponse: "price response", ofi: "OFI", tradeDelta: "trade delta",
    liquidityDynamics: "liquidity dynamics", persistence: "persistence",
    spreadDepthQuality: "spread/depth", depthPriceDivergence: "depth-price divergence",
  }
  const reasons = (side) => Object.entries(side.components)
    .sort((left, right) => WEIGHTS[right[0]] * right[1] - WEIGHTS[left[0]] * left[1])
    .slice(0, 3).map(([key, value]) => `${componentNames[key]} ${round(value, 1)}`).join("; ")
  const rating = (score) => score >= 70 ? "STRONG" : score >= 55 ? "GOOD" : score >= 40 ? "WATCH" : "WEAK"
  return {
    symbol, window: `${dateTime(windowStart)} to ${dateTime(cutoff)}`, eligible,
    dataQualityPct: round(100 * quality, 2), completeMinutes: available.length,
    priceReturnPct: round(metrics.priceReturnPct), midReturnPct: round(metrics.midReturnPct),
    deltaPct: round(100 * metrics.delta, 2), ofi: round(metrics.ofi), ofiShift: round(metrics.ofiShift),
    fullImbalancePct: round(100 * metrics.full, 2), closingFullImbalancePct: round(100 * metrics.closeFull, 2),
    depthShiftPct: round(100 * metrics.depthShift, 2), averageSpreadBps: round(averageSpread, 2),
    spreadExpansionPct: round(metrics.spreadExpansionPct, 2),
    buyScore: round(buy.score, 2), buyRating: rating(buy.score), buyReasons: reasons(buy),
    buyConflicts: buy.conflicts.join("; "),
    sellScore: round(sell.score, 2), sellRating: rating(sell.score), sellReasons: reasons(sell),
    sellConflicts: sell.conflicts.join("; "),
    ...Object.fromEntries(Object.entries(buy.components).map(([key, value]) => [`buy_${key}`, round(value, 2)])),
    ...Object.fromEntries(Object.entries(sell.components).map(([key, value]) => [`sell_${key}`, round(value, 2)])),
  }
}

function csvValue(value) {
  const text = value == null ? "" : String(value)
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
}

function writeCsv(filename, rows) {
  const columns = [...new Set(rows.flatMap((row) => Object.keys(row)))]
  const lines = [columns.join(","), ...rows.map((row) => columns.map((key) => csvValue(row[key])).join(","))]
  fs.writeFileSync(filename, `${lines.join("\n")}\n`)
}

const cli = commandLine(process.argv.slice(2))
if (cli.help) { console.log(usage()); process.exit(0) }
const dates = availableDates()
if (!dates.length) throw new Error("No depth archives found")
const requestedCutoff = cutoffTimestamp(cli.cutoff, dates.at(-1))
const cutoff = Math.floor(requestedCutoff / MINUTE) * MINUTE
const date = indiaDate(cutoff - 1)
const dateRoot = path.join(DEPTH_ROOT, date)
if (!fs.existsSync(dateRoot)) throw new Error(`No depth archive for cutoff date ${date}`)
const sessionOpen = Date.parse(`${date}T09:15:00+05:30`)
const sessionClose = Date.parse(`${date}T15:15:00+05:30`)
if (cutoff <= sessionOpen || cutoff > sessionClose) throw new Error("Cutoff must be after 09:15 and no later than 15:15 IST")
const windowStart = cutoff - cli.minutes * MINUTE
if (windowStart < sessionOpen) throw new Error(`Need ${cli.minutes} completed minutes after the 09:15 open`)
const symbols = fs.readdirSync(dateRoot, { withFileTypes: true })
  .filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort()

const rankings = []
for (const symbol of symbols) {
  const samples = await loadDepth(symbol, date, windowStart - MINUTE, cutoff)
  const candleMap = loadCandles(symbol, date, windowStart, cutoff)
  const minutes = []
  for (let at = windowStart; at < cutoff; at += MINUTE) {
    const minuteSamples = samples.filter((row) => row.at >= at && row.at < at + MINUTE)
    minutes.push(minuteMetric(at, minuteSamples, candleMap.get(at)))
  }
  const result = summarizeStock(symbol, minutes, windowStart, cutoff)
  if (result) rankings.push(result)
}

const eligible = rankings.filter((row) => row.eligible)
const topBuy = eligible.slice().sort((left, right) => right.buyScore - left.buyScore ||
  right.dataQualityPct - left.dataQualityPct || left.symbol.localeCompare(right.symbol)).slice(0, cli.top)
const topSell = eligible.slice().sort((left, right) => right.sellScore - left.sellScore ||
  right.dataQualityPct - left.dataQualityPct || left.symbol.localeCompare(right.symbol)).slice(0, cli.top)
const slug = indiaTime(cutoff).slice(0, 5).replace(":", "")
const prefix = `${date}-${slug}-${cli.minutes}m-depth-trend`
const jsonFile = path.resolve(ROOT, cli.output || path.join("csv", `${prefix}-top.json`))
const csvFile = path.join(path.dirname(jsonFile), `${path.basename(jsonFile, path.extname(jsonFile))}-all.csv`)
fs.mkdirSync(path.dirname(jsonFile), { recursive: true })
writeCsv(csvFile, rankings)
const report = {
  cutoff: dateTime(cutoff), cutoffSemantics: "exclusive; last completed minute ends at cutoff",
  window: `${dateTime(windowStart)} to ${dateTime(cutoff)}`, windowMinutes: cli.minutes,
  universe: symbols.length, scored: rankings.length, eligible: eligible.length,
  weights: WEIGHTS, topBuy, topSell, csvFile,
}
fs.writeFileSync(jsonFile, `${JSON.stringify(report, null, 2)}\n`)

const display = (rows, side) => rows.map((row, index) => ({ rank: index + 1, symbol: row.symbol,
  score: row[`${side}Score`], rating: row[`${side}Rating`], qualityPct: row.dataQualityPct,
  pricePct: row.priceReturnPct, deltaPct: row.deltaPct, ofi: row.ofi,
  fullDepthPct: row.fullImbalancePct, reasons: row[`${side}Reasons`] }))
console.log(`Depth trend ranking | cutoff ${dateTime(cutoff)} IST (exclusive) | ${cli.minutes} completed minutes`)
console.log(`Universe ${symbols.length}; scored ${rankings.length}; eligible ${eligible.length}`)
console.log("Top BUY")
console.table(display(topBuy, "buy"))
console.log("Top SELL")
console.table(display(topSell, "sell"))
console.log(`JSON: ${jsonFile}`)
console.log(`All-stock audit CSV: ${csvFile}`)

