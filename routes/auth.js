import express from "express"
import axios from "axios"
import { CONSTANT } from "../constant.js"
import { setInStorage, sha256Hash } from "../utils.js"

export function createAuthRouter({
  post = axios.post,
  save = setInStorage,
} = {}) {
  const router = express.Router()

  router.get("/access-token", async (req, res) => {
    res.set("Cache-Control", "no-store")
    const authCode = req.query.auth_code
    if (typeof authCode !== "string" || !authCode.trim()) {
      return res
        .status(400)
        .json({ error: "A non-empty auth_code is required." })
    }

    try {
      const { data } = await post(
        "https://api-t1.fyers.in/api/v3/validate-authcode",
        {
          grant_type: "authorization_code",
          appIdHash: sha256Hash(
            CONSTANT.appId,
            CONSTANT.appType,
            CONSTANT.secretId,
          ),
          code: authCode.trim(),
        },
        { timeout: 15000 },
      )

      if (
        data?.s === "error" ||
        typeof data?.access_token !== "string" ||
        !data.access_token
      ) {
        return res.status(502).json({
          error:
            "Fyers did not return an access token. Generate a new authorization code and try again.",
        })
      }

      save("token", data.access_token)
      if (typeof data.refresh_token === "string" && data.refresh_token) {
        save("refreshToken", data.refresh_token)
      }
      CONSTANT.access_token = data.access_token
      return res.json({
        success: true,
        message: "Access token saved successfully.",
      })
    } catch {
      return res.status(502).json({
        error:
          "Unable to exchange or save the authorization code. Please try again.",
      })
    }
  })

  return router
}

export default createAuthRouter()
