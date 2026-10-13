import apiV3 from "fyers-api-v3"
import fs from "node:fs"
import path from "node:path"
import readline from "node:readline"
import { CONSTANT } from "../constant.js"
import { getFromStorage } from "../utils.js"
import { loadCurrentMetadata, restBook } from "../ui/trading/broker.js"

const ROOT = process.cwd()
const MINUTE = 60_000
const YEAR_MS = 365.25 * 24 * 60 * MINUTE
const RATE = 0.065
const clamp = (value, low = 0, high = 1) => Math.max(low, Math.min(high, value))
const mean = (values) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0
const pct = (value, base) => base > 0 ? (value / base - 1) * 100 : 0
const round = (value, digits = 2) => Number.isFinite(value) ? Number(value.toFixed(digits)) : null
const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))
const indiaDate = (at) => new Date(at + 330 * MINUTE).toISOString().slice(0, 10)
const indiaTime = (at) => new Date(at + 330 * MINUTE).toISOString().slice(11, 16)
const indiaStamp = (at) => new Date(at + 330 * MINUTE).toISOString().slice(0, 16).replace("T", "-").replace(":", "")

function book(data) {
  const bids = [], asks = []
  for (let level = 1; level <= 5; level++) {
    const bid = { price: Number(data?.[`bid_price${level}`]), size: Number(data?.[`bid_size${level}`]) }
    const ask = { price: Number(data?.[`ask_price${level}`]), size: Number(data?.[`ask_size${level}`]) }
    if (![bid.price, bid.size, ask.price, ask.size].every(Number.isFinite) ||
        bid.price <= 0 || ask.price <= bid.price || bid.size < 0 || ask.size < 0) return null
    bids.push(bid); asks.push(ask)
  }
  const bidSize = bids.reduce((sum, row) => sum + row.size, 0)
  const askSize = asks.reduce((sum, row) => sum + row.size, 0)
  if (!(bidSize + askSize > 0)) return null
  let run = 0, longestRun = 0
  for (let level = 0; level < 5; level++) {
    run = bids[level].size >= 1.5 * Math.max(1, asks[level].size) ? run + 1 : 0
    longestRun = Math.max(longestRun, run)
  }
  return { bids, asks, bidSize, askSize, bestBid: bids[0].price, bestAsk: asks[0].price,
    bid1: bids[0].size, ask1: asks[0].size, mid: (bids[0].price + asks[0].price) / 2,
    spread: asks[0].price - bids[0].price, stackedBid: longestRun >= 3 }
}

async function readWindow(filename, start, cutoff) {
  const buckets = new Map()
  if (!fs.existsSync(filename)) return buckets
  const lines = readline.createInterface({ input: fs.createReadStream(filename), crlfDelay: Infinity })
  for await (const line of lines) {
    if (!line.trim()) continue
    let row
    try { row = JSON.parse(line) } catch { continue }
    const at = Date.parse(row.receivedAt)
    if (!Number.isFinite(at) || at < start || at >= cutoff) continue
    const current = book(row.data)
    const price = Number(row.marketContext?.price), volume = Number(row.marketContext?.cumulativeVolume)
    if (!current || !(price > 0) || !Number.isFinite(volume)) continue
    const minute = Math.floor(at / MINUTE) * MINUTE
    const bucket = buckets.get(minute) || []
    bucket.push({ at, price, volume, book: current })
    buckets.set(minute, bucket)
  }
  return buckets
}

function scoreMinute(samples, minute) {
  if (!samples?.length) return { minute: indiaTime(minute), score: 0, updates: 0, dataQualityPct: 0 }
  samples.sort((a, b) => a.at - b.at)
  const coverage = (samples.at(-1).at - samples[0].at) / 1000
  const gaps = samples.slice(1).map((row, index) => (row.at - samples[index].at) / 1000)
  const maximumGap = gaps.length ? Math.max(...gaps) : 60
  const quality = mean([clamp(samples.length / 15), clamp(coverage / 50),
    maximumGap <= 1 ? 1 : clamp((5 - maximumGap) / 4)])
  const averageAskDepth = mean(samples.map((row) => row.book.askSize)) || 1
  let traded = 0, signed = 0, buyVolume = 0, sellVolume = 0, lastDirection = 0
  let askDepletion = 0, askLifts = 0, bidUp = 0, askUp = 0, volumeUpdates = 0
  const ofis = [], replenishments = []
  for (let index = 1; index < samples.length; index++) {
    const previous = samples[index - 1], current = samples[index]
    const increment = Math.max(0, current.volume - previous.volume)
    if (current.price > previous.price) lastDirection = 1
    else if (current.price < previous.price) lastDirection = -1
    if (increment > 0) {
      volumeUpdates++
      traded += increment
      signed += increment * lastDirection
      if (lastDirection > 0) buyVolume += increment
      else if (lastDirection < 0) sellVolume += increment
      if (current.book.bestAsk > previous.book.bestAsk) {
        askLifts++
        askDepletion += previous.book.ask1
      } else if (current.book.bestAsk === previous.book.bestAsk && current.book.ask1 < previous.book.ask1) {
        askDepletion += previous.book.ask1 - current.book.ask1
      }
    }
    if (current.book.bestBid > previous.book.bestBid) bidUp++
    if (current.book.bestAsk > previous.book.bestAsk) askUp++
    const ofi = (current.book.bestBid >= previous.book.bestBid ? current.book.bid1 : 0) -
      (current.book.bestBid <= previous.book.bestBid ? previous.book.bid1 : 0) -
      (current.book.bestAsk <= previous.book.bestAsk ? current.book.ask1 : 0) +
      (current.book.bestAsk >= previous.book.bestAsk ? previous.book.ask1 : 0)
    const visible = (current.book.bid1 + current.book.ask1 + previous.book.bid1 + previous.book.ask1) / 2
    ofis.push(ofi / Math.max(1, visible))
    replenishments.push(current.book.bestBid > previous.book.bestBid ||
      current.book.bestBid === previous.book.bestBid && current.book.bid1 > previous.book.bid1 ? 1 : 0)
  }
  const transitions = Math.max(1, samples.length - 1)
  const activeSeconds = Math.max(1, coverage)
  const upExecutionRate = buyVolume / activeSeconds
  const normalizedUpExecutionRate = upExecutionRate / averageAskDepth
  const estimatedDeltaPct = traded > 0 ? 100 * signed / traded : 0
  const askDepletionTurns = askDepletion / averageAskDepth
  const askLiftPct = 100 * askLifts / transitions
  const priceReturnPct = pct(samples.at(-1).price, samples[0].price)
  const midReturnPct = pct(samples.at(-1).book.mid, samples[0].book.mid)
  const priceSpeedBpsSecond = 100 * priceReturnPct / activeSeconds
  const midSpeedBpsSecond = 100 * midReturnPct / activeSeconds
  const bidProgressPct = 100 * bidUp / transitions, askProgressPct = 100 * askUp / transitions
  const updateRate = samples.length / activeSeconds
  const volumeUpdatePct = 100 * volumeUpdates / transitions
  const normalizedOfi = mean(ofis)
  const replenishmentPct = 100 * mean(replenishments)
  const stackedBidPct = 100 * samples.filter((row) => row.book.stackedBid).length / samples.length
  const startSpread = mean(samples.slice(0, Math.max(1, Math.ceil(samples.length / 5))).map((row) => row.book.spread / row.book.mid))
  const endSpread = mean(samples.slice(-Math.max(1, Math.ceil(samples.length / 5))).map((row) => row.book.spread / row.book.mid))
  const spreadExpansionPct = startSpread > 0 ? 100 * (endSpread / startSpread - 1) : 0
  const buyDepthTurns = buyVolume / averageAskDepth
  const executionEfficiency = buyDepthTurns > 0 ? priceReturnPct / Math.max(0.25, Math.sqrt(buyDepthTurns)) : 0

  const executionScore = 18 * clamp(normalizedUpExecutionRate / 0.55)
  const deltaScore = 14 * clamp((estimatedDeltaPct + 10) / 60)
  const askScore = 13 * mean([clamp(askDepletionTurns / 6), clamp(askLiftPct / 20)])
  const priceScore = 13 * mean([clamp(priceReturnPct / 0.25), clamp(midReturnPct / 0.20),
    clamp(priceSpeedBpsSecond / 0.40), clamp(midSpeedBpsSecond / 0.30)])
  const progressionScore = 8 * mean([clamp(bidProgressPct / 20), clamp(askProgressPct / 20)])
  const intensityScore = 6 * mean([clamp(updateRate / 1.2), clamp(volumeUpdatePct / 45)])
  const ofiScore = 8 * clamp((normalizedOfi + 0.05) / 0.25)
  const replenishmentScore = 6 * clamp(replenishmentPct / 45)
  const stackedScore = 4 * clamp(stackedBidPct / 30)
  const spreadScore = 3 * clamp((30 - spreadExpansionPct) / 30)
  const efficiencyScore = 3 * clamp(executionEfficiency / 0.08)
  const qualityScore = 4 * quality
  const raw = executionScore + deltaScore + askScore + priceScore + progressionScore + intensityScore +
    ofiScore + replenishmentScore + stackedScore + spreadScore + efficiencyScore + qualityScore
  const score = clamp(raw * (0.40 + 0.60 * quality), 0, 100)
  return { minute: indiaTime(minute), score: round(score), updates: samples.length,
    dataQualityPct: round(100 * quality), coverageSeconds: round(coverage), maximumGapSeconds: round(maximumGap),
    buyExecutedEstimate: round(buyVolume, 0), sellExecutedEstimate: round(sellVolume, 0),
    upwardExecutionPerSecond: round(upExecutionRate), normalizedUpExecutionRate: round(normalizedUpExecutionRate, 4),
    estimatedDeltaPct: round(estimatedDeltaPct), askDepletionTurns: round(askDepletionTurns),
    askLiftPct: round(askLiftPct), priceReturnPct: round(priceReturnPct, 4), midReturnPct: round(midReturnPct, 4),
    priceSpeedBpsSecond: round(priceSpeedBpsSecond, 4), midSpeedBpsSecond: round(midSpeedBpsSecond, 4),
    bidProgressPct: round(bidProgressPct), askProgressPct: round(askProgressPct), updateRate: round(updateRate),
    volumeUpdatePct: round(volumeUpdatePct), normalizedOfi: round(normalizedOfi, 4),
    replenishmentPct: round(replenishmentPct), stackedBidPct: round(stackedBidPct),
    spreadExpansionPct: round(spreadExpansionPct), executionEfficiency: round(executionEfficiency, 4) }
}

function normalCdf(value) {
  const sign = value < 0 ? -1 : 1, x = Math.abs(value) / Math.sqrt(2), t = 1 / (1 + 0.3275911 * x)
  const erf = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t -
    0.284496736) * t + 0.254829592) * t * Math.exp(-x * x)
  return 0.5 * (1 + sign * erf)
}
const normalPdf = (value) => Math.exp(-value * value / 2) / Math.sqrt(2 * Math.PI)
function optionMetrics(spot, strike, years, volatility, type) {
  const rootT = Math.sqrt(years)
  const d1 = (Math.log(spot / strike) + (RATE + volatility * volatility / 2) * years) / (volatility * rootT)
  const d2 = d1 - volatility * rootT, discounted = strike * Math.exp(-RATE * years)
  const price = type === "CE" ? spot * normalCdf(d1) - discounted * normalCdf(d2)
    : discounted * normalCdf(-d2) - spot * normalCdf(-d1)
  const delta = type === "CE" ? normalCdf(d1) : normalCdf(d1) - 1
  const gamma = normalPdf(d1) / (spot * volatility * rootT)
  const commonTheta = -(spot * normalPdf(d1) * volatility) / (2 * rootT)
  const thetaYear = type === "CE" ? commonTheta - RATE * discounted * normalCdf(d2)
    : commonTheta + RATE * discounted * normalCdf(-d2)
  return { price, delta, gamma, thetaDay: thetaYear / 365.25 }
}
function impliedVolatility(price, spot, strike, years, type) {
  if (!(price > 0 && spot > 0 && strike > 0 && years > 0)) return NaN
  let low = 0.005, high = 5
  for (let index = 0; index < 80; index++) {
    const middle = (low + high) / 2
    if (optionMetrics(spot, strike, years, middle, type).price > price) high = middle
    else low = middle
  }
  return (low + high) / 2
}
function percentile(items, getter, higher = true) {
  const values = items.map(getter).filter(Number.isFinite).sort((a, b) => a - b)
  return (item) => {
    const value = getter(item)
    if (!Number.isFinite(value) || !values.length) return 0
    let index = 0
    while (index < values.length && values[index] <= value) index++
    const score = values.length === 1 ? 100 : 100 * (index - 1) / (values.length - 1)
    return higher ? score : 100 - score
  }
}
function scenarioValue(pair, movePct, minutesForward) {
  const years = Math.max(1 / (365.25 * 24 * 60), pair.years - minutesForward / (365.25 * 24 * 60))
  const scenarioSpot = pair.spot * (1 + movePct / 100)
  return optionMetrics(scenarioSpot, pair.ce.strike, years, pair.ce.iv, "CE").price +
    optionMetrics(scenarioSpot, pair.pe.strike, years, pair.pe.iv, "PE").price
}
function buildPairs(response, stock, now) {
  if (response?.s !== "ok" || !Array.isArray(response.data?.optionsChain)) return []
  const underlying = response.data.optionsChain.find((row) => Number(row.strike_price) === -1)
  const spot = Number(underlying?.ltp), expiry = Number(response.data.expiryData?.[0]?.expiry) * 1000
  if (!(spot > 0 && expiry > now)) return []
  const years = (expiry - now) / YEAR_MS
  const legs = response.data.optionsChain.flatMap((row) => {
    const type = row.option_type, strike = Number(row.strike_price), bid = Number(row.bid), ask = Number(row.ask)
    if (!["CE", "PE"].includes(type) || !(strike > 0 && bid > 0 && ask >= bid)) return []
    const midpoint = (bid + ask) / 2, iv = impliedVolatility(midpoint, spot, strike, years, type)
    if (!Number.isFinite(iv) || iv < 0.03 || iv > 3) return []
    const metrics = optionMetrics(spot, strike, years, iv, type)
    const spreadPct = 100 * (ask - bid) / midpoint, oi = Number(row.oi) || 0, volume = Number(row.volume) || 0
    if (spreadPct > 10 || oi < 500 || volume < 50) return []
    return [{ symbol: row.symbol, type, strike, bid, ask, midpoint, iv, spreadPct, oi, volume, ...metrics }]
  })
  const strikes = [...new Set(legs.map((row) => row.strike))].sort((a, b) => a - b)
  if (strikes.length < 2) return []
  const gaps = strikes.slice(1).map((strike, index) => strike - strikes[index]).filter((gap) => gap > 0)
  const step = Math.min(...gaps), near = legs.filter((row) => Math.abs(row.strike - spot) <= Math.max(4 * step, spot * 0.05))
  const pairs = []
  for (const ce of near.filter((row) => row.type === "CE")) for (const pe of near.filter((row) => row.type === "PE")) {
    const sameStrike = ce.strike === pe.strike
    const symmetric = ce.strike >= spot && pe.strike <= spot && Math.abs((ce.strike - spot) - (spot - pe.strike)) <= step * 0.6
    if (!sameStrike && !symmetric) continue
    const combinedAsk = ce.ask + pe.ask, combinedBid = ce.bid + pe.bid, netDelta = ce.delta + pe.delta
    if (!(combinedAsk > 0) || Math.abs(netDelta) > 0.25) continue
    const pair = { stock: stock.symbol, structure: sameStrike ? "STRADDLE" : "STRANGLE", spot, expiry, years,
      ce, pe, combinedAsk, combinedBid, netDelta, combinedSpreadPct: 100 * (combinedAsk - combinedBid) / ((combinedAsk + combinedBid) / 2),
      gammaEfficiency: 100 * spot * spot * (ce.gamma + pe.gamma) / combinedAsk,
      thetaCostPctDay: 100 * Math.abs(ce.thetaDay + pe.thetaDay) / combinedAsk,
      minOi: Math.min(ce.oi, pe.oi), minVolume: Math.min(ce.volume, pe.volume) }
    pair.up15 = 100 * (scenarioValue(pair, 1.5, 60) / combinedAsk - 1)
    pair.down15 = 100 * (scenarioValue(pair, -1.5, 60) / combinedAsk - 1)
    pair.balanced15 = Math.min(pair.up15, pair.down15)
    pairs.push(pair)
  }
  const gammaRank = percentile(pairs, (row) => row.gammaEfficiency)
  const liquidityRank = percentile(pairs, (row) => Math.log1p(row.minVolume) + 0.5 * Math.log1p(row.minOi))
  const spreadRank = percentile(pairs, (row) => row.combinedSpreadPct, false)
  const neutralityRank = percentile(pairs, (row) => Math.abs(row.netDelta), false)
  const payoffRank = percentile(pairs, (row) => row.balanced15)
  const thetaRank = percentile(pairs, (row) => row.thetaCostPctDay, false)
  for (const pair of pairs) pair.pairScore = 0.25 * gammaRank(pair) + 0.20 * liquidityRank(pair) +
    0.15 * spreadRank(pair) + 0.15 * neutralityRank(pair) + 0.20 * payoffRank(pair) + 0.05 * thetaRank(pair)
  return pairs.sort((a, b) => b.pairScore - a.pairScore)
}
function fillVwap(levels, quantity) {
  let remaining = quantity, cost = 0
  for (const level of levels) {
    const filled = Math.min(remaining, level.qty)
    cost += filled * level.price; remaining -= filled
    if (remaining <= 0) break
  }
  return { complete: remaining <= 0, vwap: quantity > remaining ? cost / (quantity - remaining) : NaN }
}
function csvValue(value) {
  const text = value === null || value === undefined ? "" : String(value)
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
}
function writeCsv(filename, records) {
  const columns = [...new Set(records.flatMap((row) => Object.keys(row)))]
  fs.writeFileSync(filename, `${[columns.join(","), ...records.map((row) => columns.map((key) => csvValue(row[key])).join(","))].join("\n")}\n`)
}

async function main() {
  const now = Date.now(), cutoff = Math.floor(now / MINUTE) * MINUTE, start = cutoff - 5 * MINUTE
  const date = indiaDate(now), symbols = [...new Set(JSON.parse(fs.readFileSync(path.join(ROOT, "db", "stocks"), "utf8")))]
  const ranking = [], minuteAudit = []
  for (const symbol of symbols) {
    const filename = path.join(ROOT, "db", "cash-depth", date, symbol, `${symbol}.jsonl`)
    const buckets = await readWindow(filename, start, cutoff), minutes = []
    for (let at = start; at < cutoff; at += MINUTE) minutes.push(scoreMinute(buckets.get(at) || [], at))
    const totalScore = minutes.reduce((sum, row) => sum + row.score, 0)
    const latest = [...buckets.values()].flat().sort((a, b) => a.at - b.at).at(-1)
    ranking.push({ symbol, totalScore: round(totalScore), averageMinuteScore: round(totalScore / 5),
      minutesWithDepth: minutes.filter((row) => row.updates > 0).length,
      totalUpdates: minutes.reduce((sum, row) => sum + row.updates, 0),
      averageQualityPct: round(mean(minutes.map((row) => row.dataQualityPct))), spotFromDepth: round(latest?.price) })
    minuteAudit.push(...minutes.map((row) => ({ symbol, ...row })))
  }
  ranking.sort((a, b) => b.totalScore - a.totalScore)
  ranking.forEach((row, index) => { row.allStockRank = index + 1 })

  const token = String(getFromStorage("token") || "").trim()
  if (!token) throw new Error("Run AutoLogin before requesting live option chains")
  const { contracts } = await loadCurrentMetadata({ options: true, now })
  const fnoUnderlyings = new Set([...contracts.values()].map((row) => row.underlying))
  const fnoRanking = ranking.filter((row) => fnoUnderlyings.has(`NSE:${row.symbol}-EQ`))
  fnoRanking.forEach((row, index) => { row.fnoRank = index + 1 })
  const selectedStocks = fnoRanking.slice(0, 5)
  const client = new apiV3.fyersModel({ enableLogging: false })
  client.setAppId(CONSTANT.appId); client.setAccessToken(token)
  const results = [], errors = []
  for (const stock of selectedStocks) {
    try {
      const response = await client.getOptionChain({ symbol: `NSE:${stock.symbol}-EQ`, strikecount: 10, timestamp: "" })
      await delay(1100)
      const pair = buildPairs(response, stock, now)[0]
      if (!pair) { errors.push({ symbol: stock.symbol, message: "No pair passed liquidity, spread and delta constraints" }); continue }
      const lotSize = contracts.get(pair.ce.symbol)?.lot || contracts.get(pair.pe.symbol)?.lot || 1
      let entryUnit = pair.combinedAsk, exitUnit = pair.combinedBid, bookComplete = false
      try {
        const ceDepth = await client.getMarketDepth({ symbol: [pair.ce.symbol], ohlcv_flag: 1 })
        await delay(1100)
        const peDepth = await client.getMarketDepth({ symbol: [pair.pe.symbol], ohlcv_flag: 1 })
        await delay(1100)
        const ceBook = restBook(ceDepth, pair.ce.symbol), peBook = restBook(peDepth, pair.pe.symbol)
        const ceBuy = ceBook && fillVwap(ceBook.asks, lotSize), peBuy = peBook && fillVwap(peBook.asks, lotSize)
        const ceSell = ceBook && fillVwap(ceBook.bids, lotSize), peSell = peBook && fillVwap(peBook.bids, lotSize)
        bookComplete = Boolean(ceBuy?.complete && peBuy?.complete && ceSell?.complete && peSell?.complete)
        if (bookComplete) { entryUnit = ceBuy.vwap + peBuy.vwap; exitUnit = ceSell.vwap + peSell.vwap }
      } catch (error) { errors.push({ symbol: stock.symbol, message: `Option depth: ${error.message}` }) }
      const lowerBreakEven = pair.structure === "STRADDLE" ? pair.ce.strike - entryUnit : pair.pe.strike - entryUnit
      const upperBreakEven = pair.structure === "STRADDLE" ? pair.ce.strike + entryUnit : pair.ce.strike + entryUnit
      results.push({ stock: stock.symbol, allStockDepthRank: stock.allStockRank, fnoDepthRank: stock.fnoRank,
        fiveMinuteDepthScore: stock.totalScore, averageMinuteScore: stock.averageMinuteScore,
        depthWindow: `${indiaTime(start)}–${indiaTime(cutoff - MINUTE)}`, structure: pair.structure,
        expiry: indiaDate(pair.expiry), spot: round(pair.spot), ceSymbol: pair.ce.symbol, ceStrike: pair.ce.strike,
        ceBid: pair.ce.bid, ceAsk: pair.ce.ask, peSymbol: pair.pe.symbol, peStrike: pair.pe.strike,
        peBid: pair.pe.bid, peAsk: pair.pe.ask, lotSize, executableUnitDebit: round(entryUnit),
        executableLotDebit: round(entryUnit * lotSize), immediateExitUnitCredit: round(exitUnit),
        immediateSpreadLoss: round((entryUnit - exitUnit) * lotSize), maximumPremiumLoss: round(entryUnit * lotSize),
        lowerExpiryBreakEven: round(lowerBreakEven), upperExpiryBreakEven: round(upperBreakEven),
        netDelta: round(pair.netDelta, 4), combinedGamma: round(pair.ce.gamma + pair.pe.gamma, 8),
        averageIvPct: round(50 * (pair.ce.iv + pair.pe.iv)), thetaCostPctDay: round(pair.thetaCostPctDay),
        combinedSpreadPct: round(pair.combinedSpreadPct), modeledPlus1_5PctReturn60m: round(100 * (scenarioValue(pair, 1.5, 60) / entryUnit - 1)),
        modeledMinus1_5PctReturn60m: round(100 * (scenarioValue(pair, -1.5, 60) / entryUnit - 1)),
        pairScoreWithinStock: round(pair.pairScore), optionBookComplete: bookComplete })
    } catch (error) { errors.push({ symbol: stock.symbol, message: error.message }) }
  }
  const prefix = `${date}-${indiaTime(start).replace(":", "")}-to-${indiaTime(cutoff - MINUTE).replace(":", "")}`
  const rankingFile = path.join(ROOT, "csv", `${prefix}-five-minute-upward-execution-ranking.csv`)
  const auditFile = path.join(ROOT, "csv", `${prefix}-five-minute-upward-execution-audit.csv`)
  const pairFile = path.join(ROOT, "csv", `${prefix}-best-option-buy-pairs.json`)
  writeCsv(rankingFile, ranking); writeCsv(auditFile, minuteAudit)
  const report = { generatedAt: new Date().toISOString(), date, depthWindow: `${indiaTime(start)}–${indiaTime(cutoff - MINUTE)}`,
    universe: symbols.length, methodology: "Each of five completed minutes is scored 0-100 for normalized upward execution speed, delta, ask depletion/lifts, price and mid progression, book progression, update intensity, OFI, replenishment, stacked bids, spread, execution efficiency and data quality; five scores are added.",
    optionScope: "Top five depth-ranked F&O stocks; nearest expiry; one liquid approximately delta-neutral CE+PE pair per stock; executable one-lot depth used when available.",
    costsIncluded: false, zeroLossGuaranteed: false, selectedStocks, optionPairs: results, errors, rankingFile, auditFile }
  fs.writeFileSync(pairFile, `${JSON.stringify(report, null, 2)}\n`)
  console.log(JSON.stringify({ pairFile, ...report }, null, 2))
}

main().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1 })
