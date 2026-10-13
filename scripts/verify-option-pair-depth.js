import apiV3 from "fyers-api-v3"
import fs from "node:fs"
import path from "node:path"
import { CONSTANT } from "../constant.js"
import { getFromStorage } from "../utils.js"
import { restBook } from "../ui/trading/broker.js"

const ROOT = process.cwd()
const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))
const round = (value, digits = 2) => Number.isFinite(value) ? Number(value.toFixed(digits)) : null
const clamp = (value, low = 0, high = 100) => Math.max(low, Math.min(high, value))
const input = process.argv[2] || fs.readdirSync(path.join(ROOT, "csv"))
  .filter((name) => name.endsWith("-live-option-buy-pairs.json")).sort().at(-1)
const filename = path.isAbsolute(input) ? input : path.join(ROOT, "csv", input)
const report = JSON.parse(fs.readFileSync(filename, "utf8"))

function fillVwap(levels, quantity) {
  let remaining = quantity, cost = 0
  for (const level of levels) {
    const filled = Math.min(remaining, level.qty)
    cost += filled * level.price
    remaining -= filled
    if (remaining <= 0) break
  }
  return { complete: remaining <= 0, available: quantity - remaining,
    vwap: quantity - remaining > 0 ? cost / (quantity - remaining) : NaN }
}

const token = String(getFromStorage("token") || "").trim()
if (!token) throw new Error("Run AutoLogin before verifying option depth")
const client = new apiV3.fyersModel({ enableLogging: false })
client.setAppId(CONSTANT.appId)
client.setAccessToken(token)
const errors = []

for (const pair of report.top5) {
  const books = {}
  for (const [side, symbol] of [["ce", pair.ceSymbol], ["pe", pair.peSymbol]]) {
    try {
      const response = await client.getMarketDepth({ symbol: [symbol], ohlcv_flag: 1 })
      const book = restBook(response, symbol)
      if (!book) throw new Error(response?.message || "invalid five-level book")
      books[side] = book
    } catch (error) { errors.push({ symbol, message: error.message }) }
    await delay(650)
  }
  const ceFill = books.ce ? fillVwap(books.ce.asks, pair.lotSize) : null
  const peFill = books.pe ? fillVwap(books.pe.asks, pair.lotSize) : null
  pair.bookComplete = Boolean(ceFill?.complete && peFill?.complete)
  pair.ceBookSpreadPct = books.ce ? 100 * books.ce.spread : null
  pair.peBookSpreadPct = books.pe ? 100 * books.pe.spread : null
  pair.ceAvailableAskQty = ceFill?.available ?? 0
  pair.peAvailableAskQty = peFill?.available ?? 0
  pair.ceExecutablePrice = ceFill?.vwap ?? pair.ceAsk
  pair.peExecutablePrice = peFill?.vwap ?? pair.peAsk
  pair.executableUnitDebit = pair.ceExecutablePrice + pair.peExecutablePrice
  pair.executableTotalDebit = pair.executableUnitDebit * pair.lotSize
  pair.bookSlippagePct = 100 * (pair.executableUnitDebit / pair.chainCombinedAsk - 1)
  const bookSpread = (pair.ceBookSpreadPct ?? 10) + (pair.peBookSpreadPct ?? 10)
  pair.optionBookScore = pair.bookComplete ? clamp(100 - 15 * Math.max(0, pair.bookSlippagePct) - 2 * bookSpread) : 0
  const preliminaryScore = (pair.score - 0.25 * 15) / 0.75
  pair.score = 0.75 * preliminaryScore + 0.25 * pair.optionBookScore
  for (const field of ["projectedUpReturnPct", "projectedDownReturnPct", "move15UpReturnPct", "move15DownReturnPct"]) {
    if (!Number.isFinite(pair[field])) continue
    const modeledValue = pair.chainCombinedAsk * (1 + pair[field] / 100)
    pair[field] = 100 * (modeledValue / pair.executableUnitDebit - 1)
  }
  pair.costPctSpot = 100 * pair.executableUnitDebit / pair.spot
}

report.top5.sort((a, b) => b.score - a.score)
report.top5.forEach((row, index) => {
  row.rank = index + 1
  for (const field of ["score", "ceBookSpreadPct", "peBookSpreadPct", "ceExecutablePrice",
    "peExecutablePrice", "executableUnitDebit", "executableTotalDebit", "bookSlippagePct",
    "optionBookScore", "projectedUpReturnPct", "projectedDownReturnPct", "move15UpReturnPct",
    "move15DownReturnPct", "costPctSpot"]) row[field] = round(Number(row[field]))
})
report.depthVerifiedAt = new Date().toISOString()
report.depthVerificationErrors = errors
const output = filename.replace(/\.json$/, "-depth-verified.json")
fs.writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`)
console.log(JSON.stringify({ output, top5: report.top5, errors }, null, 2))
