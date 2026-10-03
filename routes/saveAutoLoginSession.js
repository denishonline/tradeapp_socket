export function saveAutoLoginSession(tokenData, save) {
  if (
    tokenData?.s === "error" ||
    typeof tokenData?.access_token !== "string" ||
    !tokenData.access_token.trim()
  ) {
    throw new Error("Cannot save an unsuccessful Fyers login")
  }

  save("token", tokenData.access_token)
  if (tokenData.refresh_token) save("refreshToken", tokenData.refresh_token)

  save("BEARISH_STOCKS", [])
  save("BULLISH_STOCKS", [])
  save("EXIT_STOCKS", [])
}
