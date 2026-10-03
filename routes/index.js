import express from "express"
import authRoutes from "./auth.js"
import dataRoutes from "./data.js"
import storeRoutes from "./store.js"

const router = express.Router()

router.use("/auth", authRoutes)
router.use("/data", dataRoutes)
router.use("/store", storeRoutes)

export default router
