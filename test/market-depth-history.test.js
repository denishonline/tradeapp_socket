import assert from "node:assert/strict"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { it } from "node:test"
import { createMarketDepthHistory } from "../ui/market-depth-history.js"

it("stores stock and option depth in valid sibling JSON files and appends across writer restarts", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "market-depth-history-"))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const stockFile = path.join(directory, "TCS", "TCS.json")
  const optionFile = path.join(directory, "TCS", "TCS26OCT2060CE.json")
  const stock = { symbol: "NSE:TCS-EQ" }
  const option = { symbol: "NSE:TCS26OCT2060CE", underlying: "NSE:TCS-EQ", optionType: "CE" }
  const first = await createMarketDepthHistory({ directory })
  await first.prepareStocks(["TCS"])
  await first.prepare([option])
  assert.equal(first.record(stock, { type: "dp", symbol: stock.symbol, bid_size1: 20 }), true)
  assert.equal(first.record(option, { type: "dp", symbol: option.symbol, ask_size1: 10 }), true)
  await first.close()

  const second = await createMarketDepthHistory({ directory })
  await second.prepareStocks(["TCS"])
  await second.prepare([option])
  assert.equal(second.record(stock, { type: "dp", symbol: stock.symbol, bid_size1: 25 }), true)
  await second.close()

  const stockHistory = JSON.parse(await readFile(stockFile, "utf8"))
  const optionHistory = JSON.parse(await readFile(optionFile, "utf8"))
  assert.equal(stockHistory.symbol, stock.symbol)
  assert.deepEqual(stockHistory.history.map((item) => item.data.bid_size1), [20, 25])
  assert.deepEqual(optionHistory.history.map((item) => item.data.ask_size1), [10])
})
