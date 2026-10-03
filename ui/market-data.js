import { readFile } from "node:fs/promises"

const NSE_PREFIX = "NSE:"
const EQUITY_SUFFIX = "-EQ"

export async function loadStocks(filePath) {
  const contents = await readFile(filePath, "utf8")
  const stocks = JSON.parse(contents)

  if (!Array.isArray(stocks)) {
    throw new TypeError("db/stocks must contain a JSON array")
  }

  return Array.from(
    new Set(
      stocks
        .filter((stock) => typeof stock === "string")
        .map((stock) => stock.trim().toUpperCase())
        .filter(Boolean),
    ),
  )
}

export function toFyersSymbol(stock) {
  return `${NSE_PREFIX}${stock}${EQUITY_SUFFIX}`
}

export function toStockName(symbol) {
  if (typeof symbol !== "string") return null
  if (!symbol.startsWith(NSE_PREFIX) || !symbol.endsWith(EQUITY_SUFFIX)) {
    return null
  }

  return symbol.slice(NSE_PREFIX.length, -EQUITY_SUFFIX.length)
}

export function normalizeTick(message) {
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    return null
  }

  const symbol = toStockName(message.symbol)
  const price = firstFiniteNumber(
    message.ltp,
    message.close_price,
    message.price,
    message.c,
  )

  if (!symbol || price === null) return null

  return {
    symbol,
    price,
    change: firstFiniteNumber(message.ch, message.change),
    changePercent: firstFiniteNumber(
      message.chp,
      message.change_percentage,
      message.changePercent,
    ),
    updatedAt: normalizeTimestamp(
      message.last_traded_time ??
        message.exch_feed_time ??
        message.timestamp ??
        Date.now(),
    ),
  }
}

function firstFiniteNumber(...values) {
  for (const value of values) {
    if (value === null || value === undefined || value === "") continue
    const number = Number(value)
    if (Number.isFinite(number)) return number
  }

  return null
}

function normalizeTimestamp(value) {
  if (value instanceof Date) return value.toISOString()

  if (typeof value === "string" && !/^\d+(?:\.\d+)?$/.test(value)) {
    const parsed = Date.parse(value)
    return new Date(Number.isNaN(parsed) ? Date.now() : parsed).toISOString()
  }

  const number = Number(value)
  if (!Number.isFinite(number)) return new Date().toISOString()

  const milliseconds = number < 10_000_000_000 ? number * 1000 : number
  return new Date(milliseconds).toISOString()
}
