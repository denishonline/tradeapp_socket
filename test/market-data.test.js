import assert from "node:assert/strict"
import { describe, it } from "node:test"
import {
  loadStocks,
  normalizeTick,
  toFyersSymbol,
  toStockName,
} from "../ui/market-data.js"

describe("market data helpers", () => {
  it("loads and de-duplicates the stock database", async () => {
    const stocks = await loadStocks(new URL("../db/stocks", import.meta.url))

    assert.equal(stocks.length, 205)
    assert.equal(stocks.filter((stock) => stock === "NYKAA").length, 1)
  })

  it("converts stock names to and from Fyers symbols", () => {
    assert.equal(toFyersSymbol("M&M"), "NSE:M&M-EQ")
    assert.equal(toStockName("NSE:M&M-EQ"), "M&M")
    assert.equal(toStockName("NSE:NIFTY50-INDEX"), null)
  })

  it("normalizes a Fyers lite tick", () => {
    assert.deepEqual(
      normalizeTick({
        symbol: "NSE:SBIN-EQ",
        ltp: 812.45,
        ch: 3.2,
        chp: 0.4,
        exch_feed_time: 1_700_000_000,
      }),
      {
        symbol: "SBIN",
        price: 812.45,
        change: 3.2,
        changePercent: 0.4,
        updatedAt: "2023-11-14T22:13:20.000Z",
      },
    )
  })

  it("ignores socket messages that are not price ticks", () => {
    assert.equal(normalizeTick({ type: "cn", message: "connected" }), null)
  })
})
