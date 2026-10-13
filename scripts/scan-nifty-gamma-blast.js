import apiV3 from "fyers-api-v3"
import fs from "node:fs"
import path from "node:path"
import { CONSTANT } from "../constant.js"
import { getFromStorage } from "../utils.js"

const ROOT = process.cwd()
const MINUTE = 60_000
const YEAR_MS = 365.25 * 24 * 60 * MINUTE
const RISK_FREE_RATE = 0.065
const SYMBOL = "NSE:NIFTY50-INDEX"
const clamp = (value, low, high) => Math.max(low, Math.min(high, value))
const pct = (value, base) => base > 0 ? (value / base - 1) * 100 : NaN
const mean = (values) => values.length ? values.reduce((total, value) => total + value, 0) / values.length : NaN
const round = (value, digits = 2) => Number.isFinite(value) ? Number(value.toFixed(digits)) : null

function normalCdf(value) {
  const sign = value < 0 ? -1 : 1
  const x = Math.abs(value) / Math.sqrt(2)
  const t = 1 / (1 + 0.3275911 * x)
  const erf = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t -
    0.284496736) * t + 0.254829592) * t * Math.exp(-x * x)
  return 0.5 * (1 + sign * erf)
}

function optionPrice(spot, strike, years, rate, volatility, type) {
  if (!(spot > 0 && strike > 0 && years > 0 && volatility > 0)) return NaN
  const rootT = Math.sqrt(years)
  const d1 = (Math.log(spot / strike) + (rate + volatility * volatility / 2) * years) /
    (volatility * rootT)
  const d2 = d1 - volatility * rootT
  const discountedStrike = strike * Math.exp(-rate * years)
  return type === "CE"
    ? spot * normalCdf(d1) - discountedStrike * normalCdf(d2)
    : discountedStrike * normalCdf(-d2) - spot * normalCdf(-d1)
}

function impliedVolatility(price, spot, strike, years, type) {
  if (!(price > 0 && spot > 0 && strike > 0 && years > 0)) return NaN
  const discountedStrike = strike * Math.exp(-RISK_FREE_RATE * years)
  const lower = type === "CE" ? Math.max(0, spot - discountedStrike) : Math.max(0, discountedStrike - spot)
  const upper = type === "CE" ? spot : discountedStrike
  if (price < lower - 0.5 || price >= upper) return NaN
  let low = 0.005
  let high = 5
  for (let iteration = 0; iteration < 90; iteration++) {
    const middle = (low + high) / 2
    if (optionPrice(spot, strike, years, RISK_FREE_RATE, middle, type) > price) high = middle
    else low = middle
  }
  return (low + high) / 2
}

function gamma(spot, strike, years, volatility) {
  if (!(spot > 0 && strike > 0 && years > 0 && volatility > 0)) return NaN
  const rootT = Math.sqrt(years)
  const d1 = (Math.log(spot / strike) + (RISK_FREE_RATE + volatility * volatility / 2) * years) /
    (volatility * rootT)
  return Math.exp(-d1 * d1 / 2) / Math.sqrt(2 * Math.PI) / (spot * volatility * rootT)
}

function percentileRanks(rows, field) {
  const sorted = rows.map((row) => row[field]).filter(Number.isFinite).sort((left, right) => left - right)
  if (!sorted.length) return new Map()
  return new Map(rows.map((row) => {
    const value = row[field]
    if (!Number.isFinite(value)) return [row, 0]
    let below = 0
    let through = 0
    while (through < sorted.length && sorted[through] <= value) {
      if (sorted[through] < value) below++
      through++
    }
    return [row, sorted.length === 1 ? 100 : 100 * ((below + through - 1) / 2) / (sorted.length - 1)]
  }))
}

function indiaParts(timestamp = Date.now()) {
  const shifted = new Date(timestamp + 330 * MINUTE)
  return {
    date: shifted.toISOString().slice(0, 10),
    time: shifted.toISOString().slice(11, 16).replace(":", ""),
  }
}

function parseJsonLines(filename) {
  if (!fs.existsSync(filename)) return []
  return fs.readFileSync(filename, "utf8").split(/\r?\n/).flatMap((line) => {
    if (!line.trim()) return []
    try { return [JSON.parse(line)] } catch { return [] }
  })
}

function bookMetric(record) {
  const data = record?.data
  if (!data) return null
  let bidSize = 0
  let askSize = 0
  for (let level = 1; level <= 5; level++) {
    const bid = Number(data[`bid_size${level}`])
    const ask = Number(data[`ask_size${level}`])
    if (![bid, ask].every(Number.isFinite) || bid < 0 || ask < 0) return null
    bidSize += bid
    askSize += ask
  }
  const bestBid = Number(data.bid_price1)
  const bestAsk = Number(data.ask_price1)
  if (!(bestBid > 0 && bestAsk > bestBid && bidSize + askSize > 0)) return null
  return { bidShare: 100 * bidSize / (bidSize + askSize), midpoint: (bestBid + bestAsk) / 2 }
}

function cashDepthBreadth(date, now) {
  const directory = path.join(ROOT, "db", "cash-depth", date)
  if (!fs.existsSync(directory)) return null
  const stocks = fs.readdirSync(directory, { withFileTypes: true }).filter((entry) => entry.isDirectory())
  const metrics = []
  for (const entry of stocks) {
    const filename = path.join(directory, entry.name, `${entry.name}.jsonl`)
    const samples = parseJsonLines(filename).flatMap((record) => {
      const at = Date.parse(record.receivedAt)
      const metric = bookMetric(record)
      return Number.isFinite(at) && metric && at >= now - 20 * MINUTE ? [{ at, ...metric }] : []
    })
    if (!samples.length) continue
    const latest = samples.at(-1)
    const start = samples.find((sample) => sample.at >= latest.at - 5 * MINUTE) || samples[0]
    metrics.push({ bidShare: latest.bidShare, return5: pct(latest.midpoint, start.midpoint) })
  }
  return {
    stocks: metrics.length,
    averageBidShare: mean(metrics.map((row) => row.bidShare)),
    bidDominantPct: 100 * metrics.filter((row) => row.bidShare > 50).length / (metrics.length || 1),
    upPricePct: 100 * metrics.filter((row) => row.return5 > 0).length / (metrics.length || 1),
    averageReturn5: mean(metrics.map((row) => row.return5).filter(Number.isFinite)),
  }
}

function cashCandleBreadth(date) {
  const directory = path.join(ROOT, "db", "candles")
  if (!fs.existsSync(directory)) return null
  const returns = []
  for (const filename of fs.readdirSync(directory).filter((name) => name.endsWith(".jsonl"))) {
    const rows = parseJsonLines(path.join(directory, filename)).filter((row) => {
      const at = Number(row.time) * 1000
      return Number.isFinite(at) && indiaParts(at).date === date && Number(row.close) > 0
    })
    if (rows.length < 5) continue
    returns.push(pct(Number(rows.at(-1).close), Number(rows.at(-5).open)))
  }
  return {
    stocks: returns.length,
    upPct: 100 * returns.filter((value) => value > 0).length / (returns.length || 1),
    averageReturn5: mean(returns.filter(Number.isFinite)),
  }
}

function candleMetrics(rows) {
  const last = rows.at(-1)
  const last5 = rows.slice(-5)
  const last15 = rows.slice(-15)
  const sessionDate = indiaParts(last.time * 1000).date
  const today = rows.filter((row) => indiaParts(row.time * 1000).date === sessionDate)
  const volume = today.reduce((total, row) => total + row.volume, 0)
  const vwap = volume ? today.reduce((total, row) =>
    total + row.volume * (row.high + row.low + row.close) / 3, 0) / volume : NaN
  return {
    return5: pct(last.close, last5[0].open),
    return15: pct(last.close, last15[0].open),
    vwapGap: pct(last.close, vwap),
    dayReturn: pct(last.close, today[0].open),
    lastCandleAt: last.time * 1000,
  }
}

function marketBias(nifty, depth, candles) {
  const contributions = {
    niftyReturn5: 25 * clamp(nifty.return5 / 0.25, -1, 1),
    niftyReturn15: 15 * clamp(nifty.return15 / 0.50, -1, 1),
    niftyVwap: 10 * clamp(nifty.vwapGap / 0.25, -1, 1),
    cashCandleBreadth: 15 * clamp(((candles?.upPct ?? 50) - 50) / 20, -1, 1),
    bidShare: 20 * clamp(((depth?.averageBidShare ?? 50) - 50) / 5, -1, 1),
    depthPriceBreadth: 10 * clamp(((depth?.upPricePct ?? 50) - 50) / 20, -1, 1),
    depthReturn: 5 * clamp((depth?.averageReturn5 ?? 0) / 0.20, -1, 1),
  }
  const score = Object.values(contributions).reduce((total, value) => total + value, 0)
  return { score, direction: score >= 8 ? "BULLISH" : score <= -8 ? "BEARISH" : "NEUTRAL", contributions }
}

async function main() {
  const token = getFromStorage("token")
  if (typeof token !== "string" || !token.trim()) throw new Error("Run AutoLogin before scanning gamma")
  const client = new apiV3.fyersModel({ enableLogging: false })
  client.setAppId(CONSTANT.appId)
  client.setAccessToken(token.trim())
  const now = Date.now()
  const from = Math.floor((now - 4 * 24 * 60 * MINUTE) / 1000)
  const to = Math.floor(now / 1000)
  const [chain, history] = await Promise.all([
    client.getOptionChain({ symbol: SYMBOL, strikecount: 25, timestamp: "" }),
    client.getHistory({ symbol: SYMBOL, resolution: "1", date_format: "0",
      range_from: String(from), range_to: String(to), cont_flag: "1" }),
  ])
  if (chain?.s !== "ok" || !Array.isArray(chain.data?.optionsChain)) {
    throw new Error(chain?.message || "FYERS option chain is unavailable")
  }
  if (history?.s !== "ok" || !Array.isArray(history.candles)) {
    throw new Error(history?.message || "FYERS NIFTY candle history is unavailable")
  }
  const underlying = chain.data.optionsChain.find((row) => row.symbol === SYMBOL || row.strike_price === -1)
  const spot = Number(underlying?.ltp)
  const expiry = Number(chain.data.expiryData?.[0]?.expiry) * 1000
  if (!(spot > 0 && expiry > now)) throw new Error("Invalid NIFTY spot or nearest expiry")
  const years = (expiry - now) / YEAR_MS
  const optionRows = chain.data.optionsChain.filter((row) => ["CE", "PE"].includes(row.option_type) &&
    Number(row.strike_price) > 0 && Number(row.oi) >= 0 && Number(row.volume) >= 0)
  const strikes = [...new Set(optionRows.map((row) => Number(row.strike_price)))].sort((a, b) => a - b)
  const gaps = strikes.slice(1).map((strike, index) => strike - strikes[index]).filter((gap) => gap > 0)
  const strikeStep = Math.min(...gaps)
  const legs = optionRows.map((row) => {
    const bid = Number(row.bid)
    const ask = Number(row.ask)
    const ltp = Number(row.ltp)
    const premium = bid > 0 && ask >= bid ? (bid + ask) / 2 : ltp
    const iv = impliedVolatility(premium, spot, Number(row.strike_price), years, row.option_type)
    return {
      symbol: row.symbol, type: row.option_type, strike: Number(row.strike_price), premium, bid, ask,
      spreadPct: premium > 0 && ask >= bid ? 100 * (ask - bid) / premium : NaN,
      oi: Number(row.oi), oiChange: Number(row.oich) || 0, volume: Number(row.volume),
      premiumChangePct: Number(row.ltpchp), iv,
    }
  })
  const validIvs = legs.filter((row) => Number.isFinite(row.iv) && Math.abs(row.strike - spot) <= 8 * strikeStep)
    .map((row) => row.iv).sort((a, b) => a - b)
  const fallbackIv = validIvs.length ? validIvs[Math.floor(validIvs.length / 2)] : 0.20
  for (const leg of legs) {
    if (!Number.isFinite(leg.iv) || leg.iv < 0.03 || leg.iv > 2) leg.iv = fallbackIv
    leg.gamma = gamma(spot, leg.strike, years, leg.iv)
    leg.gammaOi = leg.gamma * leg.oi
    leg.gammaBuild = leg.gamma * Math.max(0, leg.oiChange)
    leg.gammaVolume = leg.gamma * leg.volume
    leg.proximity = Math.exp(-Math.abs(leg.strike - spot) / (2 * strikeStep))
    leg.liquidity = (1 - clamp((leg.spreadPct || 100) / 8, 0, 1)) * Math.log1p(leg.volume)
  }
  const rankFields = ["gammaOi", "gammaBuild", "gammaVolume", "proximity", "liquidity"]
  const ranks = Object.fromEntries(rankFields.map((field) => [field, percentileRanks(legs, field)]))
  const parsedCandles = history.candles.flatMap((row) => Array.isArray(row) && row.length >= 6 ? [{
    time: Number(row[0]), open: Number(row[1]), high: Number(row[2]), low: Number(row[3]),
    close: Number(row[4]), volume: Number(row[5]),
  }] : []).filter((row) => [row.time, row.open, row.high, row.low, row.close, row.volume].every(Number.isFinite))
  const date = indiaParts(now).date
  const nifty = candleMetrics(parsedCandles)
  const depth = cashDepthBreadth(date, now)
  const candleBreadth = cashCandleBreadth(date)
  const bias = marketBias(nifty, depth, candleBreadth)
  for (const leg of legs) {
    const sideAlignment = bias.direction === "NEUTRAL" ? 55 :
      bias.direction === "BULLISH" === (leg.type === "CE") ? 100 : 20
    leg.score = 0.30 * ranks.gammaOi.get(leg) + 0.20 * ranks.gammaBuild.get(leg) +
      0.15 * ranks.gammaVolume.get(leg) + 0.10 * ranks.proximity.get(leg) +
      0.10 * ranks.liquidity.get(leg) + 0.15 * sideAlignment
  }
  const preferred = bias.direction === "BULLISH" ? "CE" : bias.direction === "BEARISH" ? "PE" : null
  const pool = preferred ? legs.filter((row) => row.type === preferred) : legs
  const selected = pool.sort((left, right) => right.score - left.score).slice(0, 5)
  const result = selected.map((row, index) => ({
    rank: index + 1, strike: row.strike, side: row.type, symbol: row.symbol,
    score: round(row.score), premium: round(row.premium), ivPct: round(row.iv * 100),
    gamma: round(row.gamma, 8), oi: row.oi, oiChange: row.oiChange, volume: row.volume,
    spreadPct: round(row.spreadPct), premiumChangePct: round(row.premiumChangePct),
    gammaOi: round(row.gammaOi, 2), gammaBuild: round(row.gammaBuild, 2),
  }))
  const stamp = indiaParts(now)
  const report = {
    generatedAt: new Date(now).toISOString(), indiaTime: `${stamp.date} ${stamp.time.slice(0, 2)}:${stamp.time.slice(2)}`,
    underlying: "NIFTY 50", spot, expiry: chain.data.expiryData[0].date,
    hoursToExpiry: round((expiry - now) / (60 * MINUTE)), strikeStep,
    marketBias: { score: round(bias.score), direction: bias.direction },
    nifty: Object.fromEntries(Object.entries(nifty).map(([key, value]) => [key, key === "lastCandleAt" ? new Date(value).toISOString() : round(value)])),
    cashDepth: depth ? Object.fromEntries(Object.entries(depth).map(([key, value]) => [key, round(value)])) : null,
    cashCandles: candleBreadth ? Object.fromEntries(Object.entries(candleBreadth).map(([key, value]) => [key, round(value)])) : null,
    methodology: "30% gamma*OI, 20% gamma*positive OI change, 15% gamma*volume, 10% strike proximity, 10% liquidity, 15% candle/depth direction alignment",
    top5: result,
  }
  const output = path.join(ROOT, "csv", `${stamp.date}-${stamp.time}-nifty-gamma-blast.json`)
  fs.writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`)
  console.log(JSON.stringify({ output, ...report }, null, 2))
}

main().catch((error) => {
  console.error(error.message)
  process.exitCode = 1
})
