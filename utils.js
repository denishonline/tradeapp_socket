import { LocalStorage } from "node-localstorage"
const localStorageInstance = new LocalStorage("./db")
import crypto from "crypto"
import moment from "moment"

export const getFromStorage = (key) => {
  return JSON.parse(localStorageInstance.getItem(key)) || []
}

export const setInStorage = (key, value) => {
  localStorageInstance.setItem(key, JSON.stringify(value))
}

export const delFromStorage = (key) => {
  localStorageInstance.removeItem(key)
}

export const addToStorageByKey = (key, stock) => {
  const existingBuyPositions = getFromStorage(key)
  const uniqueStocks = Array.from(new Set([stock, ...existingBuyPositions]))
  setInStorage(key, uniqueStocks)
}

export const delFromStorageByKey = (key, stock) => {
  const existingStocks = getFromStorage(key)

  if (existingStocks.includes(stock)) {
    const newStocks = existingStocks.filter((item) => stock !== item)

    setInStorage(key, newStocks)
  }
}

export const getExistingPositions = () => {
  const live_data = getFromStorage("live_data")

  const allPositions = [
    ...(live_data?.buy_positions || []),
    ...(live_data?.sell_positions || []),
  ]

  // Count only cash positions
  const totalPositions = allPositions?.filter((item) =>
    item.endsWith("-EQ"),
  )?.length

  return {
    totalPositions,
  }
}

export const isValidTimeForPlaceOrder = () => {
  const flg = isTimeGreaterThen(9, 15) && isTimeLessThen(14, 30) ? true : false

  return flg
}

export const isValidTimeForExitAll = () => {
  const flg = isTimeGreaterThen(9, 15) && isTimeLessThen(14, 25) ? true : false

  return flg
}

export function sha256Hash(appId, appType, appSecret) {
  const message = `${appId}-${appType}:${appSecret}`
  return crypto.createHash("sha256").update(message).digest("hex") // kept static hash
}

export function extractStockName(str) {
  // First, split by ":" to isolate the part after "NSE:"
  const parts = str.split(":")
  if (parts.length < 2) return null

  // Next, split the second part by "-" to remove the "-EQ"
  const stockParts = parts[1].split("26")

  // Return the first part, which is the stock name
  return stockParts[0]
}

export function extractNamesFromArray(symbols) {
  return symbols.map((symbol) => extractStockName(symbol))
}

export function isTimeGreaterThen(hour = 0, minute = 0) {
  const currentTime = moment()
  const myTime = moment().set({ hour, minute, second: 0, millisecond: 0 })
  let flag = false
  if (currentTime.isAfter(myTime)) {
    flag = true
  }

  // console.log("->  currentTime1:", currentTime)
  // console.log("->  myTime1:", myTime)
  // console.log("->  flag:", flag)

  return flag
}

export function isTimeLessThen(hour = 0, minute = 0) {
  const currentTime = moment()
  const myTime = moment().set({ hour, minute, second: 0, millisecond: 0 })

  let flag = false
  if (currentTime.isBefore(myTime)) {
    flag = true
  }

  // console.log("->  currentTime2:", currentTime)
  // console.log("->  myTime2:", myTime)
  // console.log("->  flag:", flag)

  return flag
}

export function getCandlesTillTime(candles, tillTime) {
  if (!Array.isArray(candles) || candles.length === 0) return []
  if (tillTime === null || tillTime === undefined || tillTime === "") {
    return candles
  }

  const numericTillTime = Number(tillTime)
  if (Number.isFinite(numericTillTime) && numericTillTime > 0) {
    return candles.slice(0, Math.max(0, candles.length - numericTillTime))
  }

  const targetTs =
    tillTime instanceof Date
      ? tillTime.getTime()
      : parseCandleTimeToTimestamp(tillTime)

  if (Number.isNaN(targetTs)) {
    return candles
  }

  const index = candles.findIndex(
    (c) => parseCandleTimeToTimestamp(c.TIME) > targetTs,
  )

  return index === -1 ? candles : candles.slice(0, index)
}

function parseCandleTimeToTimestamp(timeStr) {
  if (!timeStr) return NaN

  // Expected format examples:
  // "9/12/2025, 10:54:00 am"
  // "21/4/26, 8:39:00 pm"
  const [datePart, timePart] = timeStr.trim().split(", ")
  if (!datePart || !timePart) return NaN

  let [day, month, year] = datePart.split("/").map((v) => Number(v))
  if (
    !Number.isFinite(day) ||
    !Number.isFinite(month) ||
    !Number.isFinite(year)
  ) {
    return NaN
  }
  if (year < 100) year += 2000

  let [time, meridian] = timePart.trim().split(" ")
  if (!time || !meridian) return NaN
  let [hour, minute, second] = time.split(":").map(Number)

  meridian = meridian.toLowerCase()

  if (meridian === "pm" && hour !== 12) hour += 12
  if (meridian === "am" && hour === 12) hour = 0

  return new Date(year, month - 1, day, hour, minute, second).getTime()
}
