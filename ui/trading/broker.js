import apiV3 from "fyers-api-v3"
import fs from "node:fs"
import csv from "csv-parser"
import { Readable } from "node:stream"
import { indiaTime } from "./config.js"

export async function loadCurrentMetadata({ options = false, fetcher = fetch, now = Date.now() } = {}) {
  const cashTickSizes = {}, contracts = new Map()
  for (const segment of options ? ["NSE_CM", "NSE_FO"] : ["NSE_CM"]) {
    const response = await fetcher(`https://public.fyers.in/sym_details/${segment}.csv`, { signal: AbortSignal.timeout(15000) })
    if (!response.ok) throw new Error(`Cannot load ${segment} instrument metadata: HTTP ${response.status}`)
    const rows = Readable.fromWeb(response.body).pipe(csv({ headers: false }))
    for await (const row of rows) {
      const symbol = row[9], tick = Number(row[4]), lot = Number(row[3])
      if (!(tick > 0) || !Number.isInteger(lot) || lot < 1 || !symbol?.startsWith("NSE:")) continue
      if (segment === "NSE_CM" && symbol.endsWith("-EQ")) cashTickSizes[symbol] = tick
      if (segment === "NSE_FO" && ["CE", "PE"].includes(row[16]) && Number(row[8]) * 1000 > now) {
        contracts.set(symbol, {
          symbol, tick, lot, underlying: `NSE:${row[13]}-EQ`,
          strike: Number(row[15]), expiry: Number(row[8]) * 1000, optionType: row[16],
        })
      }
    }
  }
  if (!Object.keys(cashTickSizes).length || options && !contracts.size) throw new Error("Instrument master schema empty or incompatible")
  return { cashTickSizes, contracts, metadataDay: indiaTime(now).day }
}

export async function loadContracts(filename) {
  const contracts = new Map()
  const rows = fs.createReadStream(filename).pipe(csv())
  for await (const row of rows) {
    if (row.optionType !== "CE") continue
    const contract = { symbol: row.fullSymbol, underlying: `NSE:${row.underlying}-EQ`, lot: Number(row.lotSize), tick: Number(row.tickSize), strike: Number(row.strikePrice), expiry: Number(row.expiryTimestamp) * 1000 }
    if (contract.lot > 0 && Number.isInteger(contract.lot) && contract.tick > 0 && contract.expiry > 0) contracts.set(contract.symbol, contract)
  }
  return contracts
}

export function createBroker({ appId, token, timeoutMs = 8000 }) {
  const client = new apiV3.fyersModel({ enableLogging: false })
  client.setAppId(appId)
  client.setAccessToken(token)
  let queue = Promise.resolve()
  let starts = []
  async function perform(method, payload, deadline = Infinity) {
    // Single process request budget, including reconciliation and option data.
    const now = Date.now()
    starts = starts.filter((t) => now - t < 60_000)
    const wait = Math.max(0, (starts.at(-1) || 0) + 350 - now, starts.length >= 150 ? starts[0] + 60_000 - now : 0)
    if (wait) await new Promise((resolve) => setTimeout(resolve, wait))
    if (Date.now() > deadline) return { s: "error", code: "LOCAL_STALE_QUOTE" }
    starts = starts.filter((t) => Date.now() - t < 60_000)
    starts.push(Date.now())
    let timer
    try {
      const result = await Promise.race([
        client[method](payload),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${method} timed out; result may be unknown`)), timeoutMs) }),
      ])
      return result
    } finally { clearTimeout(timer) }
  }
  function call(method, payload, deadline) {
    const result = queue.then(() => perform(method, payload, deadline))
    queue = result.catch(() => {})
    return result
  }
  return {
    place: (payload, deadline) => call("place_order", payload, deadline),
    orders: () => call("get_orders"),
    positions: () => call("get_positions"),
    cancel: (id) => call("cancel_order", { id }),
    chain: (symbol) => call("getOptionChain", { symbol, strikecount: 10, timestamp: "" }),
    depth: (symbol) => call("getMarketDepth", { symbol: [symbol], ohlcv_flag: 1 }),
  }
}

export function restBook(response, symbol) {
  if (response?.s !== "ok") return null
  const item = response.d?.[symbol]
  if (!item || !Array.isArray(item.bids) || !Array.isArray(item.ask)) return null
  const bids = item.bids.map((x) => ({ price: Number(x.price), qty: Number(x.volume ?? x.qty) }))
  const asks = item.ask.map((x) => ({ price: Number(x.price), qty: Number(x.volume ?? x.qty) }))
  if (!bids.length || !asks.length || [...bids, ...asks].some((x) => !Number.isFinite(x.price) || x.price <= 0 || !Number.isInteger(x.qty) || x.qty < 0)) return null
  if (bids[0].price >= asks[0].price) return null
  return { bids, asks, spread: (asks[0].price - bids[0].price) / ((asks[0].price + bids[0].price) / 2) }
}

export function selectCall(response, contracts, underlying, spot, now, config) {
  if (response?.s !== "ok" || !Array.isArray(response.data?.optionsChain)) return null
  const candidates = response.data.optionsChain.flatMap((row) => {
    const meta = contracts.get(row.symbol)
    if (!meta || meta.underlying !== underlying || meta.expiry <= now || row.option_type !== "CE") return []
    if (!(Number(row.oi) >= config.minOptionOi) || !(Number(row.volume) >= config.minOptionVolume)) return []
    if (Math.abs(meta.strike - spot) / spot > config.maxOptionMoneyness) return []
    return [{ ...meta, oi: Number(row.oi), volume: Number(row.volume), oiChange: Number.isFinite(Number(row.oich)) ? Number(row.oich) : null }]
  })
  candidates.sort((a, b) => a.expiry - b.expiry || Math.abs(a.strike - spot) - Math.abs(b.strike - spot) || b.volume - a.volume)
  return candidates[0] ?? null
}
