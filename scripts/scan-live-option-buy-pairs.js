import apiV3 from "fyers-api-v3"
import fs from "node:fs"
import path from "node:path"
import { CONSTANT } from "../constant.js"
import { getFromStorage } from "../utils.js"
import { loadCurrentMetadata, restBook } from "../ui/trading/broker.js"

const ROOT = process.cwd()
const MINUTE = 60_000
const YEAR_MS = 365.25 * 24 * 60 * MINUTE
const RATE = 0.065
const clamp = (value, low = 0, high = 1) => Math.max(low, Math.min(high, value))
const pct = (value, base) => base > 0 ? (value / base - 1) * 100 : NaN
const mean = (values) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : NaN
const stdev = (values) => {
  if (values.length < 2) return 0
  const average = mean(values)
  return Math.sqrt(mean(values.map((value) => (value - average) ** 2)))
}
const round = (value, digits = 2) => Number.isFinite(value) ? Number(value.toFixed(digits)) : null
const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))
const indiaDate = (at = Date.now()) => new Date(at + 330 * MINUTE).toISOString().slice(0, 10)
const indiaStamp = (at = Date.now()) => new Date(at + 330 * MINUTE).toISOString().slice(0, 16).replace("T", "-").replace(":", "")

function rows(filename) {
  if (!fs.existsSync(filename)) return []
  return fs.readFileSync(filename, "utf8").split(/\r?\n/).flatMap((line) => {
    if (!line.trim()) return []
    try { return [JSON.parse(line)] } catch { return [] }
  })
}

function cashBook(record) {
  const data = record?.data
  if (!data) return null
  let bids = 0
  let asks = 0
  for (let level = 1; level <= 5; level++) {
    const bid = Number(data[`bid_size${level}`])
    const ask = Number(data[`ask_size${level}`])
    if (![bid, ask].every(Number.isFinite) || bid < 0 || ask < 0) return null
    bids += bid
    asks += ask
  }
  const bestBid = Number(data.bid_price1)
  const bestAsk = Number(data.ask_price1)
  if (!(bestBid > 0 && bestAsk > bestBid && bids + asks > 0)) return null
  return { bidShare: 100 * bids / (bids + asks), mid: (bestBid + bestAsk) / 2 }
}

function cashFeatures(symbol, date, now) {
  const candleFile = path.join(ROOT, "db", "candles", `${symbol}.jsonl`)
  const all = rows(candleFile).filter((row) => Number(row.time) * 1000 <= now &&
    Number(row.open) > 0 && Number(row.high) > 0 && Number(row.low) > 0 && Number(row.close) > 0)
  const candles = all.filter((row) => indiaDate(Number(row.time) * 1000) === date)
  if (candles.length < 15) return null
  const previous = all.filter((row) => indiaDate(Number(row.time) * 1000) < date).at(-1)
  if (!previous) return null
  const gapPct = pct(Number(candles[0].open), Number(previous.close))
  if (!Number.isFinite(gapPct) || Math.abs(gapPct) >= 0.5) return null
  const last15 = candles.slice(-15)
  const last5 = candles.slice(-5)
  const prior5 = candles.slice(-10, -5)
  const returns = last15.slice(1).map((row, index) => pct(Number(row.close), Number(last15[index].close)))
  const return3 = pct(Number(candles.at(-1).close), Number(candles.at(-3).open))
  const return5 = pct(Number(candles.at(-1).close), Number(last5[0].open))
  const return15 = pct(Number(candles.at(-1).close), Number(last15[0].open))
  const realized15 = stdev(returns) * Math.sqrt(15)
  const range15 = 100 * (Math.max(...last15.map((row) => Number(row.high))) -
    Math.min(...last15.map((row) => Number(row.low)))) / Number(candles.at(-1).close)
  const latestRange = 100 * (Math.max(...last5.map((row) => Number(row.high))) -
    Math.min(...last5.map((row) => Number(row.low)))) / Number(candles.at(-1).close)
  const priorRange = 100 * (Math.max(...candles.slice(-15, -5).map((row) => Number(row.high))) -
    Math.min(...candles.slice(-15, -5).map((row) => Number(row.low)))) / Number(candles.at(-1).close)
  const currentVolume = mean(last5.map((row) => Number(row.volume)))
  const priorVolume = mean(prior5.map((row) => Number(row.volume)))
  const volumeRatio = priorVolume > 0 ? currentVolume / priorVolume : 1

  const depthFile = path.join(ROOT, "db", "cash-depth", date, symbol, `${symbol}.jsonl`)
  const samples = rows(depthFile).flatMap((record) => {
    const at = Date.parse(record.receivedAt)
    const book = cashBook(record)
    return Number.isFinite(at) && at >= now - 35 * MINUTE && at <= now && book ? [{ at, ...book }] : []
  })
  if (samples.length < 20 || now - samples.at(-1).at > 90_000) return null
  const buckets = new Map()
  for (const sample of samples) {
    const minute = Math.floor(sample.at / MINUTE) * MINUTE
    const bucket = buckets.get(minute) || { minute, count: 0, bidShare: 0, firstMid: sample.mid, lastMid: sample.mid }
    bucket.count++
    bucket.bidShare += sample.bidShare
    bucket.lastMid = sample.mid
    buckets.set(minute, bucket)
  }
  const minutes = [...buckets.values()].sort((a, b) => a.minute - b.minute)
    .map((row) => ({ ...row, bidShare: row.bidShare / row.count }))
  function window(length) {
    const latest = minutes.at(-1).minute
    const selected = minutes.filter((row) => row.minute > latest - length * MINUTE)
    if (selected.length < Math.ceil(length * 0.6)) return null
    const shares = selected.map((row) => row.bidShare)
    let flips = 0
    for (let i = 1; i < shares.length; i++) if ((shares[i] >= 50) !== (shares[i - 1] >= 50)) flips++
    return { length, minutes: selected.length, bidShare: mean(shares), bidShareStdev: stdev(shares),
      dominantPct: 100 * selected.filter((row) => row.bidShare >= 50).length / selected.length,
      priceReturn: pct(selected.at(-1).lastMid, selected[0].firstMid), flips }
  }
  const depth10 = window(10), depth20 = window(20), depth30 = window(30)
  if (!depth10 || !depth20 || !depth30) return null
  const depthDirection = clamp(0.50 * (depth10.bidShare - 50) / 10 +
    0.30 * depth10.priceReturn / 0.50 + 0.20 * (depth20.bidShare - 50) / 10, -1, 1)
  const candleDirection = clamp(0.45 * return3 / 0.30 + 0.35 * return5 / 0.55 + 0.20 * return15 / 1.0, -1, 1)
  const directionStrength = 100 * Math.abs(0.55 * candleDirection + 0.45 * depthDirection)
  const depthTransition = clamp((depth10.bidShareStdev - 3) / 12 + depth10.flips / 8, 0, 1)
  const rangeExpansion = priorRange > 0 ? latestRange / priorRange : 1
  const cashScore = 100 * (0.30 * clamp(directionStrength / 70) +
    0.20 * clamp((volumeRatio - 0.7) / 1.8) + 0.20 * clamp(realized15 / 0.70) +
    0.15 * depthTransition + 0.15 * clamp((rangeExpansion - 0.6) / 1.4))
  const projectedMove60Pct = clamp(Math.max(range15 * 0.8, realized15 * 1.7,
    Math.abs(return15) * 1.25, 0.6), 0.6, 2.5)
  return { symbol, spot: Number(candles.at(-1).close), gapPct, return3, return5, return15,
    realized15, range15, volumeRatio, rangeExpansion, depth10, depth20, depth30,
    candleDirection, depthDirection, directionStrength, depthTransition, cashScore,
    projectedMove60Pct, candleAt: Number(candles.at(-1).time) * 1000, depthAt: samples.at(-1).at }
}

function normalCdf(value) {
  const sign = value < 0 ? -1 : 1
  const x = Math.abs(value) / Math.sqrt(2)
  const t = 1 / (1 + 0.3275911 * x)
  const erf = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t -
    0.284496736) * t + 0.254829592) * t * Math.exp(-x * x)
  return 0.5 * (1 + sign * erf)
}
const normalPdf = (value) => Math.exp(-value * value / 2) / Math.sqrt(2 * Math.PI)

function optionMetrics(spot, strike, years, volatility, type) {
  const rootT = Math.sqrt(years)
  const d1 = (Math.log(spot / strike) + (RATE + volatility * volatility / 2) * years) / (volatility * rootT)
  const d2 = d1 - volatility * rootT
  const discounted = strike * Math.exp(-RATE * years)
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

function percentile(items, field, higher = true) {
  const valid = items.map((row) => row[field]).filter(Number.isFinite).sort((a, b) => a - b)
  return new Map(items.map((row) => {
    const value = row[field]
    if (!Number.isFinite(value) || !valid.length) return [row, 0]
    let index = 0
    while (index < valid.length && valid[index] <= value) index++
    const score = valid.length === 1 ? 100 : 100 * (index - 1) / (valid.length - 1)
    return [row, higher ? score : 100 - score]
  }))
}

function leg(row, spot, expiry, now) {
  const bid = Number(row.bid), ask = Number(row.ask), strike = Number(row.strike_price)
  const midpoint = bid > 0 && ask >= bid ? (bid + ask) / 2 : Number(row.ltp)
  const years = (expiry - now) / YEAR_MS
  if (!(strike > 0 && bid > 0 && ask >= bid && midpoint > 0 && years > 0)) return null
  const iv = impliedVolatility(midpoint, spot, strike, years, row.option_type)
  if (!Number.isFinite(iv) || iv < 0.03 || iv > 3) return null
  const greeks = optionMetrics(spot, strike, years, iv, row.option_type)
  return { symbol: row.symbol, type: row.option_type, strike, bid, ask, midpoint,
    spreadPct: 100 * (ask - bid) / midpoint, oi: Number(row.oi) || 0,
    oiChange: Number(row.oich) || 0, volume: Number(row.volume) || 0, iv, ...greeks }
}

function scenarioValue(pair, movePct, minutesForward) {
  const years = Math.max(1 / (365.25 * 24 * 60), pair.years - minutesForward / (365.25 * 24 * 60))
  const spot = pair.spot * (1 + movePct / 100)
  return optionMetrics(spot, pair.ce.strike, years, pair.ce.iv, "CE").price +
    optionMetrics(spot, pair.pe.strike, years, pair.pe.iv, "PE").price
}

function optionPairs(response, cash, now) {
  if (response?.s !== "ok" || !Array.isArray(response.data?.optionsChain)) return []
  const underlying = response.data.optionsChain.find((row) => Number(row.strike_price) === -1)
  const spot = Number(underlying?.ltp)
  const expiry = Number(response.data.expiryData?.[0]?.expiry) * 1000
  if (!(spot > 0 && expiry > now)) return []
  const rows = response.data.optionsChain.filter((row) => ["CE", "PE"].includes(row.option_type))
  const legs = rows.map((row) => leg(row, spot, expiry, now)).filter(Boolean)
    .filter((row) => row.oi >= 500 && row.volume >= 100 && row.spreadPct <= 8)
  const strikes = [...new Set(legs.map((row) => row.strike))].sort((a, b) => a - b)
  if (strikes.length < 2) return []
  const step = Math.min(...strikes.slice(1).map((strike, index) => strike - strikes[index]).filter((gap) => gap > 0))
  const near = legs.filter((row) => Math.abs(row.strike - spot) <= Math.max(3 * step, spot * 0.04))
  const calls = near.filter((row) => row.type === "CE")
  const puts = near.filter((row) => row.type === "PE")
  const pairs = []
  for (const ce of calls) for (const pe of puts) {
    const sameStrike = ce.strike === pe.strike
    const symmetricStrangle = ce.strike >= spot && pe.strike <= spot &&
      Math.abs((ce.strike - spot) - (spot - pe.strike)) <= step * 0.55
    if (!sameStrike && !symmetricStrangle) continue
    const combinedAsk = ce.ask + pe.ask
    const combinedMid = ce.midpoint + pe.midpoint
    const netDelta = ce.delta + pe.delta
    if (!(combinedAsk > 0) || Math.abs(netDelta) > 0.22) continue
    const pair = { stock: cash.symbol, structure: sameStrike ? "STRADDLE" : "STRANGLE",
      ce, pe, spot, expiry, years: (expiry - now) / YEAR_MS, step, cash,
      combinedAsk, combinedMid, entryFrictionPct: 100 * (combinedAsk / combinedMid - 1),
      combinedSpreadPct: 100 * ((ce.ask - ce.bid) + (pe.ask - pe.bid)) / combinedMid,
      netDelta, gammaEfficiency: 100 * spot * spot * (ce.gamma + pe.gamma) / combinedAsk,
      thetaCostPctDay: 100 * Math.abs(ce.thetaDay + pe.thetaDay) / combinedAsk,
      averageIvPct: 50 * (ce.iv + pe.iv), minOi: Math.min(ce.oi, pe.oi),
      minVolume: Math.min(ce.volume, pe.volume), liquidity: Math.log1p(Math.min(ce.volume, pe.volume)) +
        0.5 * Math.log1p(Math.min(ce.oi, pe.oi)), costPctSpot: 100 * combinedAsk / spot }
    const move = cash.projectedMove60Pct
    pair.projectedUpReturnPct = 100 * (scenarioValue(pair, move, 60) / combinedAsk - 1)
    pair.projectedDownReturnPct = 100 * (scenarioValue(pair, -move, 60) / combinedAsk - 1)
    pair.move15UpReturnPct = 100 * (scenarioValue(pair, 1.5, 60) / combinedAsk - 1)
    pair.move15DownReturnPct = 100 * (scenarioValue(pair, -1.5, 60) / combinedAsk - 1)
    pair.move20BestReturnPct = Math.max(100 * (scenarioValue(pair, 2, 60) / combinedAsk - 1),
      100 * (scenarioValue(pair, -2, 60) / combinedAsk - 1))
    pair.balancedProjectedReturnPct = Math.min(pair.projectedUpReturnPct, pair.projectedDownReturnPct)
    pairs.push(pair)
  }
  return pairs
}

function fillVwap(levels, quantity) {
  let remaining = quantity, cost = 0
  for (const level of levels) {
    const filled = Math.min(remaining, level.qty)
    cost += filled * level.price
    remaining -= filled
    if (remaining <= 0) break
  }
  return { complete: remaining <= 0, filled: quantity - remaining,
    vwap: quantity - remaining > 0 ? cost / (quantity - remaining) : NaN }
}

async function main() {
  const now = Date.now(), date = indiaDate(now)
  const token = String(getFromStorage("token") || "").trim()
  if (!token) throw new Error("Run AutoLogin before scanning option pairs")
  const client = new apiV3.fyersModel({ enableLogging: false })
  client.setAppId(CONSTANT.appId)
  client.setAccessToken(token)
  const stocks = [...new Set(JSON.parse(fs.readFileSync(path.join(ROOT, "db", "stocks"), "utf8")))]
  const cash = stocks.map((symbol) => cashFeatures(symbol, date, now)).filter(Boolean)
    .sort((a, b) => b.cashScore - a.cashScore).slice(0, 45)
  if (!cash.length) throw new Error("No fresh cash candle/depth candidates available")
  const pairs = [], errors = []
  for (let index = 0; index < cash.length; index++) {
    try {
      const response = await client.getOptionChain({ symbol: `NSE:${cash[index].symbol}-EQ`, strikecount: 8, timestamp: "" })
      pairs.push(...optionPairs(response, cash[index], now))
      if (response?.s !== "ok") errors.push({ symbol: cash[index].symbol, message: response?.message || response?.code })
    } catch (error) { errors.push({ symbol: cash[index].symbol, message: error.message }) }
    if (index + 1 < cash.length) await delay(425)
  }
  if (!pairs.length) throw new Error("No liquid delta-neutral CE+PE pairs were returned")
  const rankFields = {
    cashScore: percentile(pairs, "cashScore"),
    gamma: percentile(pairs, "gammaEfficiency"), neutrality: percentile(pairs, "absoluteDelta", false),
    theta: percentile(pairs, "thetaCostPctDay", false), iv: percentile(pairs, "averageIvPct", false),
    liquidity: percentile(pairs, "liquidity"), spread: percentile(pairs, "combinedSpreadPct", false),
    friction: percentile(pairs, "entryFrictionPct", false), payoff: percentile(pairs, "balancedProjectedReturnPct"),
    bestMove: percentile(pairs, "move20BestReturnPct"),
  }
  for (const pair of pairs) {
    pair.cashScore = pair.cash.cashScore
    pair.absoluteDelta = Math.abs(pair.netDelta)
  }
  // Rebuild maps after derived fields are present.
  rankFields.cashScore = percentile(pairs, "cashScore")
  rankFields.neutrality = percentile(pairs, "absoluteDelta", false)
  for (const pair of pairs) {
    const greekScore = 0.40 * rankFields.gamma.get(pair) + 0.28 * rankFields.neutrality.get(pair) +
      0.16 * rankFields.theta.get(pair) + 0.16 * rankFields.iv.get(pair)
    const executionScore = 0.48 * rankFields.liquidity.get(pair) + 0.32 * rankFields.spread.get(pair) +
      0.20 * rankFields.friction.get(pair)
    const payoffScore = 0.60 * rankFields.payoff.get(pair) + 0.40 * rankFields.bestMove.get(pair)
    pair.greekScore = greekScore
    pair.executionScore = executionScore
    pair.payoffScore = payoffScore
    pair.preliminaryScore = 0.30 * rankFields.cashScore.get(pair) + 0.25 * greekScore +
      0.25 * executionScore + 0.20 * payoffScore
  }
  const shortlist = []
  const perStock = new Set()
  for (const pair of pairs.sort((a, b) => b.preliminaryScore - a.preliminaryScore)) {
    if (perStock.has(pair.stock)) continue
    shortlist.push(pair)
    perStock.add(pair.stock)
    if (shortlist.length === 15) break
  }
  let contracts = new Map()
  try { ({ contracts } = await loadCurrentMetadata({ options: true, now })) } catch (error) {
    errors.push({ symbol: "METADATA", message: error.message })
  }
  for (const pair of shortlist) {
    const lot = contracts.get(pair.ce.symbol)?.lot || contracts.get(pair.pe.symbol)?.lot || 1
    pair.lotSize = lot
    try {
      const response = await client.getMarketDepth({ symbol: [pair.ce.symbol, pair.pe.symbol], ohlcv_flag: 1 })
      const ceBook = restBook(response, pair.ce.symbol), peBook = restBook(response, pair.pe.symbol)
      const ceFill = ceBook ? fillVwap(ceBook.asks, lot) : null
      const peFill = peBook ? fillVwap(peBook.asks, lot) : null
      pair.ceBook = ceBook
      pair.peBook = peBook
      pair.ceFill = ceFill
      pair.peFill = peFill
      pair.bookComplete = Boolean(ceFill?.complete && peFill?.complete)
      pair.executableUnitDebit = pair.bookComplete ? ceFill.vwap + peFill.vwap : pair.combinedAsk
      pair.executableTotalDebit = pair.executableUnitDebit * lot
      pair.bookSlippagePct = 100 * (pair.executableUnitDebit / pair.combinedAsk - 1)
      pair.optionBookScore = pair.bookComplete ? clamp(100 - 15 * Math.max(0, pair.bookSlippagePct) -
        4 * pair.combinedSpreadPct, 0, 100) : 15
    } catch (error) {
      pair.bookComplete = false
      pair.executableUnitDebit = pair.combinedAsk
      pair.executableTotalDebit = pair.combinedAsk * lot
      pair.bookSlippagePct = null
      pair.optionBookScore = 15
      errors.push({ symbol: `${pair.ce.symbol}|${pair.pe.symbol}`, message: error.message })
    }
    pair.finalScore = 0.75 * pair.preliminaryScore + 0.25 * pair.optionBookScore
  }
  shortlist.sort((a, b) => b.finalScore - a.finalScore)
  const top5 = shortlist.slice(0, 5).map((pair, index) => ({
    rank: index + 1, stock: pair.stock, structure: pair.structure, score: round(pair.finalScore),
    expiry: indiaDate(pair.expiry), spot: round(pair.spot), ceSymbol: pair.ce.symbol,
    ceStrike: pair.ce.strike, ceBid: pair.ce.bid, ceAsk: pair.ce.ask, ceIvPct: round(pair.ce.iv * 100),
    peSymbol: pair.pe.symbol, peStrike: pair.pe.strike, peBid: pair.pe.bid, peAsk: pair.pe.ask,
    peIvPct: round(pair.pe.iv * 100), lotSize: pair.lotSize,
    chainCombinedAsk: round(pair.combinedAsk), executableUnitDebit: round(pair.executableUnitDebit),
    executableTotalDebit: round(pair.executableTotalDebit), bookComplete: pair.bookComplete,
    bookSlippagePct: round(pair.bookSlippagePct), netDelta: round(pair.netDelta, 4),
    combinedGamma: round(pair.ce.gamma + pair.pe.gamma, 8), thetaCostPctDay: round(pair.thetaCostPctDay),
    averageIvPct: round(pair.averageIvPct), combinedSpreadPct: round(pair.combinedSpreadPct),
    costPctSpot: round(100 * pair.executableUnitDebit / pair.spot), cashScore: round(pair.cash.cashScore),
    projectedMove60Pct: round(pair.cash.projectedMove60Pct),
    projectedUpReturnPct: round(100 * (scenarioValue(pair, pair.cash.projectedMove60Pct, 60) / pair.executableUnitDebit - 1)),
    projectedDownReturnPct: round(100 * (scenarioValue(pair, -pair.cash.projectedMove60Pct, 60) / pair.executableUnitDebit - 1)),
    move15UpReturnPct: round(100 * (scenarioValue(pair, 1.5, 60) / pair.executableUnitDebit - 1)),
    move15DownReturnPct: round(100 * (scenarioValue(pair, -1.5, 60) / pair.executableUnitDebit - 1)),
    cashReturn5Pct: round(pair.cash.return5), cashReturn15Pct: round(pair.cash.return15),
    cashVolumeRatio: round(pair.cash.volumeRatio), depthBidShare10Pct: round(pair.cash.depth10.bidShare),
    depthReturn10Pct: round(pair.cash.depth10.priceReturn), depthBidShare20Pct: round(pair.cash.depth20.bidShare),
    depthReturn20Pct: round(pair.cash.depth20.priceReturn),
  }))
  const report = { generatedAt: new Date().toISOString(), indiaTime: indiaStamp(), date,
    universeStocks: stocks.length, cashFreshAndGapEligible: cash.length, pairCandidates: pairs.length,
    assumptions: { openingGapAbsMaxPct: 0.5, nearestExpiryOnly: true, maximumAbsoluteNetDelta: 0.22,
      minimumLegOi: 500, minimumLegVolume: 100, maximumLegSpreadPct: 8,
      scenarioHoldingMinutes: 60, executionQuantity: "one exchange lot", transactionCostsIncluded: false },
    methodology: "30% cash candle/depth expansion; 25% gamma/delta/theta/IV; 25% liquidity and executable option-book cost; 20% modeled two-sided payoff. Entry uses five-level ask VWAP for one lot when FYERS depth is valid.",
    top5, errors }
  const output = path.join(ROOT, "csv", `${indiaStamp()}-live-option-buy-pairs.json`)
  fs.writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`)
  console.log(JSON.stringify({ output, ...report }, null, 2))
}

main().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1 })
