import apiV3 from "fyers-api-v3"
import fs from "node:fs"
import path from "node:path"
import { CONSTANT } from "../constant.js"
import { getFromStorage } from "../utils.js"

const ROOT = process.cwd()
const MINUTE = 60_000
const YEAR_MS = 365.25 * 24 * 60 * MINUTE
const RATE = 0.065
const clamp = (value, low, high) => Math.max(low, Math.min(high, value))
const pct = (value, base) => base > 0 ? (value / base - 1) * 100 : NaN
const mean = (values) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : NaN
const round = (value, digits = 2) => Number.isFinite(value) ? Number(value.toFixed(digits)) : null
const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))

function indiaDate(at = Date.now()) {
  return new Date(at + 330 * MINUTE).toISOString().slice(0, 10)
}

function indiaStamp(at = Date.now()) {
  return new Date(at + 330 * MINUTE).toISOString().slice(0, 16).replace("T", "-").replace(":", "")
}

function rows(filename) {
  if (!fs.existsSync(filename)) return []
  return fs.readFileSync(filename, "utf8").split(/\r?\n/).flatMap((line) => {
    if (!line.trim()) return []
    try { return [JSON.parse(line)] } catch { return [] }
  })
}

function book(record) {
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
  return { bidShare: 100 * bids / (bids + asks), price: (bestBid + bestAsk) / 2 }
}

function cashFeatures(symbol, date, now) {
  const candleFile = path.join(ROOT, "db", "candles", `${symbol}.jsonl`)
  const allCandles = rows(candleFile).filter((row) => {
    const at = Number(row.time) * 1000
    return Number.isFinite(at) && Number(row.open) > 0 && Number(row.close) > 0
  })
  const candles = allCandles.filter((row) => indiaDate(Number(row.time) * 1000) === date)
  if (candles.length < 15) return null
  const previous = allCandles.filter((row) => indiaDate(Number(row.time) * 1000) < date).at(-1)
  if (!previous) return null
  const gapPct = pct(Number(candles[0].open), Number(previous.close))
  if (!Number.isFinite(gapPct) || Math.abs(gapPct) >= 0.5) return null
  const last = candles.at(-1)
  const last5 = candles.slice(-5)
  const previous5 = candles.slice(-10, -5)
  const return3 = pct(Number(last.close), Number(candles.at(-3).open))
  const return5 = pct(Number(last.close), Number(last5[0].open))
  const return15 = pct(Number(last.close), Number(candles.at(-15).open))
  const return30 = allCandles.length >= 30
    ? pct(Number(last.close), Number(allCandles.at(-30).open)) : NaN
  const return60 = allCandles.length >= 60
    ? pct(Number(last.close), Number(allCandles.at(-60).open)) : NaN
  const return120 = allCandles.length >= 120
    ? pct(Number(last.close), Number(allCandles.at(-120).open)) : NaN
  const previousDate = indiaDate(Number(previous.time) * 1000)
  const previousSession = allCandles.filter((row) => indiaDate(Number(row.time) * 1000) === previousDate)
  const previousDayReturn = previousSession.length
    ? pct(Number(previousSession.at(-1).close), Number(previousSession[0].open)) : NaN
  const currentVolume = mean(last5.map((row) => Number(row.volume)).filter(Number.isFinite))
  const priorVolume = mean(previous5.map((row) => Number(row.volume)).filter(Number.isFinite))
  const volumeRatio = priorVolume > 0 ? currentVolume / priorVolume : 1

  const depthFile = path.join(ROOT, "db", "cash-depth", date, symbol, `${symbol}.jsonl`)
  const samples = rows(depthFile).flatMap((record) => {
    const at = Date.parse(record.receivedAt)
    const metric = book(record)
    return Number.isFinite(at) && at >= now - 35 * MINUTE && metric ? [{ at, ...metric }] : []
  })
  if (samples.length < 5) return null
  const latestAt = samples.at(-1).at
  const minuteBuckets = new Map()
  for (const sample of samples) {
    const minute = Math.floor(sample.at / MINUTE) * MINUTE
    const bucket = minuteBuckets.get(minute) || {
      minute, count: 0, bidShare: 0, firstPrice: sample.price, lastPrice: sample.price,
    }
    bucket.count++
    bucket.bidShare += sample.bidShare
    bucket.lastPrice = sample.price
    minuteBuckets.set(minute, bucket)
  }
  const depthMinutes = [...minuteBuckets.values()].sort((left, right) => left.minute - right.minute)
    .map((bucket) => ({ ...bucket, averageBidShare: bucket.bidShare / bucket.count }))
  function depthWindow(length) {
    const latestMinute = depthMinutes.at(-1).minute
    const window = depthMinutes.filter((row) => row.minute > latestMinute - length * MINUTE)
    if (window.length < Math.ceil(length * 0.60)) return null
    return {
      minutes: window.length,
      averageBidShare: mean(window.map((row) => row.averageBidShare)),
      bidDominantPct: 100 * window.filter((row) => row.averageBidShare > 50).length / window.length,
      priceReturn: pct(window.at(-1).lastPrice, window[0].firstPrice),
    }
  }
  const depth10 = depthWindow(10)
  const depth20 = depthWindow(20)
  const depth30 = depthWindow(30)
  if (!depth10 || !depth20 || !depth30) return null
  const depthDirectionFor = (metric, returnScale) => clamp(
    0.55 * (metric.averageBidShare - 50) / 7 +
    0.25 * (metric.bidDominantPct - 50) / 25 +
    0.20 * metric.priceReturn / returnScale, -1, 1)
  const depthDirection10 = depthDirectionFor(depth10, 0.45)
  const depthDirection20 = depthDirectionFor(depth20, 0.70)
  const depthDirection30 = depthDirectionFor(depth30, 1.00)
  const depthDirection = clamp(0.45 * depthDirection10 + 0.35 * depthDirection20 +
    0.20 * depthDirection30, -1, 1)
  const averageBidShare = 0.45 * depth10.averageBidShare + 0.35 * depth20.averageBidShare +
    0.20 * depth30.averageBidShare
  const bidDominantPct = 0.45 * depth10.bidDominantPct + 0.35 * depth20.bidDominantPct +
    0.20 * depth30.bidDominantPct
  const candleDirection = clamp(0.45 * return3 / 0.30 + 0.35 * return5 / 0.55 +
    0.20 * return15 / 1.0, -1, 1)
  const directionScore = 100 * (0.60 * candleDirection + 0.40 * depthDirection)
  const historicalTrend = clamp(
    0.35 * (Number.isFinite(return30) ? return30 / 0.80 : 0) +
    0.30 * (Number.isFinite(return60) ? return60 / 1.25 : 0) +
    0.20 * (Number.isFinite(return120) ? return120 / 2.00 : 0) +
    0.15 * (Number.isFinite(previousDayReturn) ? previousDayReturn / 1.50 : 0), -1, 1)
  const direction = directionScore >= 0 ? "BUY" : "SELL"
  const historyTrendAlignment = clamp(50 + 50 * historicalTrend * (direction === "BUY" ? 1 : -1), 0, 100)
  const alignment = Math.sign(candleDirection) === Math.sign(depthDirection) ? 1 : 0.55
  const volumeStrength = clamp((volumeRatio - 0.8) / 1.7, 0, 1)
  const readiness = clamp(Math.abs(directionScore) * alignment * (0.75 + 0.25 * volumeStrength), 0, 100)
  return { symbol, gapPct, return3, return5, return15, return30, return60, return120,
    previousDayReturn, historicalTrend, historyTrendAlignment, volumeRatio,
    depth10, depth20, depth30, depthDirection10, depthDirection20, depthDirection30,
    averageBidShare, bidDominantPct, directionScore, direction,
    readiness, candleAt: Number(last.time) * 1000, depthAt: latestAt }
}

function normalCdf(value) {
  const sign = value < 0 ? -1 : 1
  const x = Math.abs(value) / Math.sqrt(2)
  const t = 1 / (1 + 0.3275911 * x)
  const erf = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t -
    0.284496736) * t + 0.254829592) * t * Math.exp(-x * x)
  return 0.5 * (1 + sign * erf)
}

function blackScholes(spot, strike, years, volatility, type) {
  const rootT = Math.sqrt(years)
  const d1 = (Math.log(spot / strike) + (RATE + volatility * volatility / 2) * years) /
    (volatility * rootT)
  const d2 = d1 - volatility * rootT
  const discounted = strike * Math.exp(-RATE * years)
  return type === "CE" ? spot * normalCdf(d1) - discounted * normalCdf(d2)
    : discounted * normalCdf(-d2) - spot * normalCdf(-d1)
}

function impliedVolatility(price, spot, strike, years, type) {
  if (!(price > 0 && spot > 0 && strike > 0 && years > 0)) return NaN
  const discounted = strike * Math.exp(-RATE * years)
  const lower = type === "CE" ? Math.max(0, spot - discounted) : Math.max(0, discounted - spot)
  const upper = type === "CE" ? spot : discounted
  if (price < lower - Math.max(0.05, spot * 0.00005) || price >= upper) return NaN
  let low = 0.005
  let high = 5
  for (let index = 0; index < 80; index++) {
    const middle = (low + high) / 2
    if (blackScholes(spot, strike, years, middle, type) > price) high = middle
    else low = middle
  }
  return (low + high) / 2
}

function optionGamma(spot, strike, years, volatility) {
  const rootT = Math.sqrt(years)
  const d1 = (Math.log(spot / strike) + (RATE + volatility * volatility / 2) * years) /
    (volatility * rootT)
  return Math.exp(-d1 * d1 / 2) / Math.sqrt(2 * Math.PI) / (spot * volatility * rootT)
}

function rankMap(items, field) {
  const sorted = items.map((item) => item[field]).filter(Number.isFinite).sort((a, b) => a - b)
  return new Map(items.map((item) => {
    const value = item[field]
    if (!Number.isFinite(value) || !sorted.length) return [item, 0]
    let below = 0
    let through = 0
    while (through < sorted.length && sorted[through] <= value) {
      if (sorted[through] < value) below++
      through++
    }
    return [item, sorted.length === 1 ? 100 : 100 * ((below + through - 1) / 2) / (sorted.length - 1)]
  }))
}

function optionCandidates(response, cash, now) {
  if (response?.s !== "ok" || !Array.isArray(response.data?.optionsChain)) return []
  const bullishCashTrigger = cash.direction === "BUY" && cash.return5 > 0 &&
    cash.depth10.priceReturn > 0 && cash.depth20.priceReturn >= 0 && cash.averageBidShare >= 52
  const bearishCashTrigger = cash.direction === "SELL" && cash.return5 < 0 &&
    cash.depth10.priceReturn < 0 && cash.depth20.priceReturn <= 0 && cash.averageBidShare <= 48
  if (!bullishCashTrigger && !bearishCashTrigger) return []
  const underlying = response.data.optionsChain.find((row) => Number(row.strike_price) === -1)
  const spot = Number(underlying?.ltp)
  const expiry = Number(response.data.expiryData?.[0]?.expiry) * 1000
  if (!(spot > 0 && expiry > now)) return []
  const type = cash.direction === "BUY" ? "CE" : "PE"
  const optionRows = response.data.optionsChain.filter((row) => row.option_type === type &&
    Number(row.strike_price) > 0 && Number(row.oi) > 0 && Number(row.volume) > 0)
  const strikes = optionRows.map((row) => Number(row.strike_price)).sort((a, b) => a - b)
  const gaps = strikes.slice(1).map((strike, index) => strike - strikes[index]).filter((gap) => gap > 0)
  const step = gaps.length ? Math.min(...gaps) : spot * 0.01
  const years = (expiry - now) / YEAR_MS
  const raw = optionRows.flatMap((row) => {
    const strike = Number(row.strike_price)
    if (Math.abs(strike - spot) > Math.max(6 * step, spot * 0.08)) return []
    const bid = Number(row.bid)
    const ask = Number(row.ask)
    const premium = bid > 0 && ask >= bid ? (bid + ask) / 2 : Number(row.ltp)
    const spreadPct = premium > 0 && ask >= bid ? 100 * (ask - bid) / premium : NaN
    const oi = Number(row.oi)
    const oiChange = Number(row.oich) || 0
    const volume = Number(row.volume)
    const premiumChangePct = Number(row.ltpchp)
    if (!Number.isFinite(premiumChangePct) || premiumChangePct < -5 || premiumChangePct > 20 ||
        !Number.isFinite(spreadPct) || spreadPct > 2.5 || oiChange <= 0 || volume / oi < 0.10) return []
    const iv = impliedVolatility(premium, spot, strike, years, type)
    return [{ stock: cash.symbol, symbol: row.symbol, type, strike, spot, expiry,
      premium, bid, ask, spreadPct, oi, oiChange, volume, premiumChangePct, iv, step, cash }]
  })
  const ivs = raw.map((row) => row.iv).filter((iv) => Number.isFinite(iv) && iv >= 0.03 && iv <= 2)
    .sort((a, b) => a - b)
  const fallback = ivs.length ? ivs[Math.floor(ivs.length / 2)] : 0.35
  for (const item of raw) {
    if (!Number.isFinite(item.iv) || item.iv < 0.03 || item.iv > 2) item.iv = fallback
    item.gamma = optionGamma(item.spot, item.strike, years, item.iv)
    const scale = item.spot * item.spot * 0.01
    item.gammaExposure = item.gamma * item.oi * scale
    item.gammaBuild = item.gamma * Math.max(0, item.oiChange) * scale
    item.gammaVolume = item.gamma * item.volume * scale
    item.proximity = Math.exp(-Math.abs(item.strike - item.spot) / (2 * item.step))
    item.liquidity = (1 - clamp((item.spreadPct || 100) / 8, 0, 1)) * Math.log1p(item.volume)
    item.cashReadiness = item.cash.readiness
    item.cashHistoryTrend = item.cash.historyTrendAlignment
  }
  return raw
}

async function main() {
  const now = Date.now()
  const date = indiaDate(now)
  const stocks = [...new Set(JSON.parse(fs.readFileSync(path.join(ROOT, "db", "stocks"), "utf8")))]
  const cash = stocks.map((symbol) => cashFeatures(symbol, date, now)).filter(Boolean)
  const token = getFromStorage("token")
  if (typeof token !== "string" || !token.trim()) throw new Error("Run AutoLogin before scanning gamma")
  const client = new apiV3.fyersModel({ enableLogging: false })
  client.setAppId(CONSTANT.appId)
  client.setAccessToken(token.trim())
  const candidates = []
  const errors = []
  const starts = []
  for (let index = 0; index < cash.length; index++) {
    while (starts.length && Date.now() - starts[0] >= 60_000) starts.shift()
    if (starts.length >= 140) await delay(Math.max(0, starts[0] + 60_050 - Date.now()))
    const lastStart = starts.at(-1) || 0
    if (Date.now() - lastStart < 420) await delay(420 - (Date.now() - lastStart))
    starts.push(Date.now())
    try {
      const response = await client.getOptionChain({
        symbol: `NSE:${cash[index].symbol}-EQ`, strikecount: 12, timestamp: "",
      })
      candidates.push(...optionCandidates(response, cash[index], now))
      if (response?.s !== "ok") errors.push({ symbol: cash[index].symbol, message: response?.message || response?.code })
    } catch (error) { errors.push({ symbol: cash[index].symbol, message: error.message }) }
    if ((index + 1) % 20 === 0 || index + 1 === cash.length) {
      console.error(`Option chains ${index + 1}/${cash.length}; candidates ${candidates.length}`)
    }
  }
  if (!candidates.length) throw new Error("No eligible option-chain candidates returned")
  const fields = ["gammaExposure", "gammaBuild", "gammaVolume", "proximity", "liquidity",
    "cashReadiness", "cashHistoryTrend"]
  const ranks = Object.fromEntries(fields.map((field) => [field, rankMap(candidates, field)]))
  for (const candidate of candidates) {
    candidate.score = 0.20 * ranks.gammaExposure.get(candidate) + 0.15 * ranks.gammaBuild.get(candidate) +
      0.10 * ranks.gammaVolume.get(candidate) + 0.10 * ranks.proximity.get(candidate) +
      0.10 * ranks.liquidity.get(candidate) + 0.20 * ranks.cashReadiness.get(candidate) +
      0.15 * ranks.cashHistoryTrend.get(candidate)
  }
  const selected = []
  const perStock = new Map()
  for (const candidate of candidates.sort((a, b) => b.score - a.score)) {
    if ((perStock.get(candidate.stock) || 0) >= 1) continue
    selected.push(candidate)
    perStock.set(candidate.stock, (perStock.get(candidate.stock) || 0) + 1)
    if (selected.length === 5) break
  }
  const top5 = selected.map((item, index) => ({
    rank: index + 1, stock: item.stock, strike: item.strike, side: item.type, symbol: item.symbol,
    score: round(item.score), spot: round(item.spot), premium: round(item.premium),
    expiry: indiaDate(item.expiry), ivPct: round(item.iv * 100), gamma: round(item.gamma, 8),
    oi: item.oi, oiChange: item.oiChange, volume: item.volume, spreadPct: round(item.spreadPct),
    premiumChangePct: round(item.premiumChangePct), gammaExposure: round(item.gammaExposure),
    cashDirectionScore: round(item.cash.directionScore), cashReadiness: round(item.cash.readiness),
    candleHistoryTrendScore: round(item.cash.historyTrendAlignment),
    openingGapPct: round(item.cash.gapPct), candleReturn5Pct: round(item.cash.return5),
    candleReturn30Pct: round(item.cash.return30), candleReturn60Pct: round(item.cash.return60),
    candleReturn120Pct: round(item.cash.return120), previousDayReturnPct: round(item.cash.previousDayReturn),
    volumeRatio5: round(item.cash.volumeRatio),
    averageBidSharePct: round(item.cash.averageBidShare),
    depthBidShare10Pct: round(item.cash.depth10.averageBidShare),
    depthBidShare20Pct: round(item.cash.depth20.averageBidShare),
    depthBidShare30Pct: round(item.cash.depth30.averageBidShare),
    depthReturn10Pct: round(item.cash.depth10.priceReturn),
    depthReturn20Pct: round(item.cash.depth20.priceReturn),
    depthReturn30Pct: round(item.cash.depth30.priceReturn),
  }))
  const report = {
    generatedAt: new Date().toISOString(), indiaTime: indiaStamp(), date,
    universeStocks: stocks.length, cashEligible: cash.length,
    openingGapFilter: "absolute opening gap < 0.50% versus previous-session close",
    preBlastFilters: "aligned 5-minute candle plus 10/20-minute depth-price direction; bid share confirms side; option day change -5% to +20%; positive OI change; volume/OI >= 10%; spread <= 2.5%; one strike per stock",
    chainsWithCandidates: new Set(candidates.map((row) => row.stock)).size,
    optionLegsRanked: candidates.length, chainErrors: errors.length,
    methodology: "20% gamma exposure, 15% gamma-weighted positive OI change, 10% gamma-weighted volume, 10% ATM proximity, 10% liquidity, 20% live cash candle/depth readiness using minute-normalized 10/20/30-minute depth windows weighted 45/35/20, 15% aligned 30/60/120-minute and previous-day cash candle trend",
    top5,
    errors,
  }
  const output = path.join(ROOT, "csv", `${indiaStamp()}-market-gamma-blast.json`)
  fs.writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`)
  console.log(JSON.stringify({ output, ...report }, null, 2))
}

main().catch((error) => {
  console.error(error.message)
  process.exitCode = 1
})
