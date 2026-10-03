import axios from "axios"
import * as otplib from "otplib"
import readline from "readline/promises"
import { URL } from "url"
import { pathToFileURL } from "node:url"
import { CONSTANT } from "./constant.js"
import { setInStorage, sha256Hash } from "./utils.js"
import { saveAutoLoginSession } from "./routes/saveAutoLoginSession.js"

const REDIRECT_URI = "https://trade.fyers.in/api-login/redirect-uri/index.html"
const TOTP_SECRET_KEY = "AQZHQVFKIVJ2MPFO2KCTJMJ6XFLX67M2"

const FYERS_LOGIN_BASE_URL = "https://api-t2.fyers.in/vagator/v2"
const FYERS_API_BASE_URL = "https://api-t1.fyers.in/api/v3"

const http = axios.create({ timeout: 15000 })
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const encodeBase64 = (value) => Buffer.from(value, "utf8").toString("base64")

function requiredConfig(name, value) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${name} is missing in constant.js`)
  }
  return value.trim()
}

function extractAuthCode(redirectUrl) {
  if (!redirectUrl.includes("://")) return redirectUrl.trim()

  const url = new URL(redirectUrl)
  const authCode = url.searchParams.get("auth_code")
  if (!authCode) throw new Error("Fyers did not return auth_code")
  return authCode
}

function buildManualAuthUrl() {
  const url = new URL(`${FYERS_API_BASE_URL}/generate-authcode`)
  url.searchParams.set(
    "client_id",
    `${requiredConfig("appId", CONSTANT.appId)}-${requiredConfig("appType", CONSTANT.appType)}`,
  )
  url.searchParams.set("redirect_uri", REDIRECT_URI)
  url.searchParams.set("response_type", "code")
  url.searchParams.set("state", "sample_state")
  return url.toString()
}

async function readAuthCodeFromUser() {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  })

  try {
    console.log("")
    console.log("Automatic Fyers login was rejected at the first step.")
    console.log(
      "Open this URL, complete Fyers login, then paste auth_code here:",
    )
    console.log(buildManualAuthUrl())
    console.log("")
    const answer = await rl.question("auth_code or full redirect URL: ")
    const authCode = extractAuthCode(answer.trim())
    if (!authCode) throw new Error("No auth_code entered")
    return authCode
  } finally {
    rl.close()
  }
}

function getRetryDelay(error, fallbackMs) {
  const retryAfter = error.response?.headers?.["retry-after"]
  const seconds = Number(retryAfter)
  if (Number.isFinite(seconds) && seconds > 0) return seconds * 1000
  return fallbackMs
}

function formatFyersError(error) {
  if (!error.response) return error.message

  const status = error.response.status
  const data = error.response.data
  if (typeof data === "string") return `HTTP ${status}: ${data}`

  const message =
    data?.message ||
    data?.msg ||
    data?.error ||
    data?.data?.message ||
    data?.data?.msg

  if (message) return `HTTP ${status}: ${message}`

  return `HTTP ${status}: ${JSON.stringify(data)}`
}

async function requestWithRateLimitRetry(label, request, retries = 2) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await request()
    } catch (error) {
      if (error.response?.status !== 429 || attempt === retries) throw error

      const delayMs = getRetryDelay(error, 30000 * (attempt + 1))
      console.log(
        `${label} rate limited by Fyers. Retrying in ${Math.ceil(delayMs / 1000)}s`,
      )
      await sleep(delayMs)
    }
  }
}

async function sendLoginOtp(clientId) {
  const { data } = await requestWithRateLimitRetry("send_login_otp", () =>
    http.post(`${FYERS_LOGIN_BASE_URL}/send_login_otp_v2`, {
      fy_id: encodeBase64(clientId),
      app_id: "2",
    }),
  )

  if (!data?.request_key) {
    throw new Error("Fyers did not return request_key from send_login_otp")
  }
  return data.request_key
}

async function verifyTotp(requestKey, totpSecret) {
  if (new Date().getSeconds() > 27) await sleep(3000)
  const otp = otplib.authenticator.generate(totpSecret)
  const { data } = await http.post(
    `${FYERS_LOGIN_BASE_URL}/verify_otp`,
    { request_key: requestKey, otp },
    { headers: { "Content-Type": "application/json" } },
  )

  if (!data?.request_key) {
    throw new Error("Fyers did not return request_key from verify_otp")
  }
  return data.request_key
}

async function verifyPin(requestKey, pin) {
  const { data } = await http.post(`${FYERS_LOGIN_BASE_URL}/verify_pin_v2`, {
    request_key: requestKey,
    identity_type: "pin",
    identifier: encodeBase64(pin),
  })

  if (!data?.data?.access_token) {
    throw new Error("Fyers did not return login access token from verify_pin")
  }
  return data.data.access_token
}

async function generateAuthCode(loginAccessToken) {
  const { data, headers } = await http.post(
    `${FYERS_API_BASE_URL}/token`,
    {
      fyers_id: requiredConfig("clientId", CONSTANT.clientId),
      app_id: requiredConfig("appId", CONSTANT.appId),
      redirect_uri: REDIRECT_URI,
      appType: requiredConfig("appType", CONSTANT.appType),
      code_challenge: "",
      state: "sample_state",
      scope: "",
      nonce: "",
      response_type: "code",
      create_cookie: true,
    },
    {
      headers: { Authorization: `Bearer ${loginAccessToken}` },
      maxRedirects: 0,
      validateStatus: (status) => status === 308 || status === 200,
    },
  )

  const redirectUrl =
    headers.location ||
    data?.Url ||
    data?.url ||
    data?.data?.Url ||
    data?.data?.url

  if (!redirectUrl) {
    throw new Error("Fyers did not return redirect URL with auth_code")
  }

  return extractAuthCode(redirectUrl)
}

async function validateAuthCode(authCode) {
  const { data } = await http.post(`${FYERS_API_BASE_URL}/validate-authcode`, {
    grant_type: "authorization_code",
    appIdHash: sha256Hash(
      requiredConfig("appId", CONSTANT.appId),
      requiredConfig("appType", CONSTANT.appType),
      requiredConfig("secretId", CONSTANT.secretId),
    ),
    code: authCode,
  })

  if (data?.s === "error" || !data?.access_token) {
    throw new Error(data?.message || "Fyers did not return access_token")
  }

  return data
}

export async function autoLogin({ nonInteractive = false, onProgress = () => {} } = {}) {
  const clientId = requiredConfig("clientId", CONSTANT.clientId)
  const pin = requiredConfig("pin", CONSTANT.pin)

  const progress = (step, message) => {
    onProgress({ step, total: 5, message })
    console.log(`${step}/5 ${message}`)
  }

  let authCode
  try {
    progress(1, "Sending Fyers login OTP request")
    const loginRequestKey = await sendLoginOtp(clientId)

    progress(2, "Verifying TOTP")
    const pinRequestKey = await verifyTotp(loginRequestKey, process.env.FYERS_TOTP_SECRET || TOTP_SECRET_KEY)

    progress(3, "Verifying PIN")
    const loginAccessToken = await verifyPin(pinRequestKey, pin)

    progress(4, "Generating auth code")
    authCode = await generateAuthCode(loginAccessToken)
  } catch (error) {
    if (nonInteractive) throw error
    if (error.response?.status !== 400) throw error
    authCode = await readAuthCodeFromUser()
  }

  progress(5, "Exchanging auth code for access token")
  const tokenData = await validateAuthCode(authCode)

  saveAutoLoginSession(tokenData, setInStorage)
  CONSTANT.access_token = tokenData.access_token

  console.log("Access token saved to db/token")
  console.log("BEARISH_STOCKS, BULLISH_STOCKS and EXIT_STOCKS reset to []")
  console.log("!DONE!")
  return { ok: true, message: "Fyers login complete. Access token saved." }
}

function handleLoginError(error) {
  if (error.response?.status === 429) {
    const waitSeconds = Math.ceil(getRetryDelay(error, 60000) / 1000)
    return `Fyers rate limit is active. Wait about ${waitSeconds}s and try again.`
  }

  return formatFyersError(error)
}

export function formatAutoLoginError(error) {
  return handleLoginError(error)
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (invokedDirectly) {
  autoLogin({ nonInteractive: process.argv.includes("--non-interactive") }).catch((error) => {
    console.error(`Login failed: ${handleLoginError(error)}`)
    process.exitCode = 1
  })
}
