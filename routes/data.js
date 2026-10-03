import express from "express"
const router = express.Router()
import apiV3 from "fyers-api-v3"

import { strategy, exit } from "./../strategy.js"
import { CONSTANT } from "../constant.js"
import { addToStorageByKey } from "../utils.js"

import { addToTradesTable } from "../queries.js"

import { placeOrderOption } from "../placeOrder.js"

const appId = CONSTANT.appId
const access_token = CONSTANT.access_token
const timeFrame = CONSTANT.timeFrame
const timeFrameExit = CONSTANT.timeFrameExit
const candleTimeFormatter = new Intl.DateTimeFormat("en-IN", {
  timeZone: "Asia/Kolkata",
  dateStyle: "short",
  timeStyle: "medium",
})

function createFyersClient() {
  const fyersModel = apiV3.fyersModel
  const fyers = new fyersModel({
    enableLogging: false,
  })
  fyers.setAppId(appId)
  fyers.setAccessToken(access_token)
  return fyers
}

async function fetchHistoryCandles(fyers, stock, resolution) {
  const response = await fyers.getHistory(
    prepareParams(stock, resolution, "1", "1"),
  )
  return formatCandlesWithTime(response.candles)
}

async function runStrategyForResolution(
  fyers,
  stock,
  resolution,
  debug,
  spliceCandle,
) {
  const candleData = await fetchHistoryCandles(fyers, stock, resolution)
  return strategy(stock, candleData, debug, spliceCandle)
}

router.get("/debug", async (req, res) => {
  try {
    let stock = `NSE:${req.query.stock}-EQ`
    if (req.query.stock === "NIFTY50") {
      stock = `NSE:NIFTY50-INDEX`
    }

    let debug = req?.query?.debug
    let spliceCandle = req?.query?.spliceCandle
    stock = stock.replace(/_/g, "&")
    const fyers = createFyersClient()
    const data = await runStrategyForResolution(
      fyers,
      stock,
      timeFrame,
      debug,
      spliceCandle,
    )
    console.log("-> data:", data)

    res.status(200).json(data)
  } catch (error) {
    res.status(500).json({ error })
  }
})

export async function getCurrentPrice(stock) {
  const fyers = createFyersClient()
  const candleData = await fetchHistoryCandles(fyers, stock, timeFrame)
  return candleData[candleData.length - 1]
}

export async function getCandles(stock, frame) {
  const fyers = createFyersClient()
  return fetchHistoryCandles(fyers, stock, frame)
}

function formatCandlesWithTime(candleData) {
  return candleData.map((candle) => {
    const epochTime = candle[0]
    const date = new Date(epochTime * 1000) // Multiply by 1000 to convert seconds to milliseconds

    return {
      TIME: candleTimeFormatter.format(date),
      OPEN: candle[1],
      HIGH: candle[2],
      LOW: candle[3],
      CLOSE: candle[4],
      VOL: candle[5],
    }
  })
}

function getFormattedDate(date) {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, "0")
  const day = String(date.getDate()).padStart(2, "0")
  return `${year}-${month}-${day}`
}

function calculateDateRange() {
  const today = new Date()
  const sixDaysAgo = new Date(today)
  sixDaysAgo.setDate(today.getDate() - 7) // total Days data

  const range_to = getFormattedDate(today)
  const range_from = getFormattedDate(sixDaysAgo)

  return { range_from, range_to }
}

function prepareParams(symbol, resolution, date_format, cont_flag) {
  const { range_from, range_to } = calculateDateRange()

  return {
    symbol,
    resolution,
    date_format,
    range_from,
    range_to,
    cont_flag,
  }
}

export async function debugPlaceOrderOption(
  stock,
  debug = true,
  spliceCandle = null,
) {
  try {
    const fyers = createFyersClient()

    try {
      // return await runStrategyForResolution(
      //   fyers,
      //   stock,
      //   timeFrame,
      //   debug,
      //   spliceCandle,
      // )

      const candleData = await fetchHistoryCandles(fyers, stock, "1")

      await placeOrderOption(stock, 1, candleData, "S1", null)
    } catch (error) {
      console.error(`Error initializing Fyers: runStrategy: ${stock} :`, error)
      if (error?.code !== -3008) {
        // addToStorageByKey("skip_stocks", stock)
      }
    }
  } catch (error) {
    console.error(`Error initializing Fyers: runStrategy: ${stock} :`, error)
    // addToStorageByKey("skip_stocks", stock)
  }
}

export default router
