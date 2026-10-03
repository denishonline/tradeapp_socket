import dotenv from "dotenv"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { getFromStorage, isTimeGreaterThen, isTimeLessThen } from "./utils.js"
import { DEFAULT_TREND_CONFIG } from "./ui/trading/config.js"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
// Plain login/scanner commands use production credentials. Set
// NODE_ENV=development (or test) explicitly to load local credentials.
const environment = process.env.NODE_ENV || "production"
const envFile = environment === "production" ? ".env.production" : ".env"
dotenv.config({ path: path.resolve(__dirname, envFile) })

function requiredEnvironmentValue(name) {
  const value = process.env[name]
  if (!value) throw Error(`Missing ${name} in ${envFile}`)
  return value
}

const balance = 10000
const sl = 0.005 // 0.5%  #CASH SL
const optionSL = 0.1 // 1% #OPTION SL

export const CONSTANT = {
  clientId: requiredEnvironmentValue("FYERS_CLIENT_ID"),
  appId: requiredEnvironmentValue("FYERS_APP_ID"),
  secretId: requiredEnvironmentValue("FYERS_SECRET_ID"),
  appType: requiredEnvironmentValue("FYERS_APP_TYPE"),
  pin: requiredEnvironmentValue("FYERS_PIN"),
  balance,
  timeFrame: 1,
  timeFrameExit: 1,
  orderType: "INTRADAY",
  lot: 1,
  sl,
  optionSL,
  maxPositions: 10,
  maxLoss: -5000,
  access_token: getFromStorage("token"),
  isValidTimeForPlaceOrder:
    isTimeGreaterThen(9, 15) && isTimeLessThen(14, 45) ? true : false,
  flgPlaceOptionOrder: false,
  flgPlaceCashOrder: true,
}

export const CASH_STRATEGIES = []

// Research thresholds, not a guarantee of profitable entries. Flags above route
// orders independently; both false selects paper cash orders in db/trend-orders.
export const DEPTH_TREND = {
  ...DEFAULT_TREND_CONFIG,
  capitalPerTrade: 1000,
}

// https://api-t1.fyers.in/api/v3/generate-authcode?client_id=2DUTVT9SZC-200&redirect_uri=https://trade.fyers.in/api-login/redirect-uri/index.html&response_type=code&state=sample_state
// http://127.0.0.1:3000/auth/access-token?auth_code=REAL_CODE
