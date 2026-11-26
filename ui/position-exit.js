const IST_OFFSET_MS = 330 * 60_000

function finite(value) {
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function istDay(timestamp) {
  return new Date(timestamp + IST_OFFSET_MS).toISOString().slice(0, 10)
}

export function brokerTimestamp(value) {
  if (typeof value === "number" && Number.isFinite(value))
    return value < 10_000_000_000 ? value * 1000 : value
  if (typeof value !== "string" || !value.trim()) return null
  const text = value.trim()
  if (/^\d+$/.test(text)) return brokerTimestamp(Number(text))
  const iso = Date.parse(text)
  if (Number.isFinite(iso) && /(?:Z|[+-]\d\d:?\d\d)$/i.test(text)) return iso
  const match = text.match(/^(\d{1,2})[-/ ]([A-Za-z]{3}|\d{1,2})[-/ ](\d{4})[ ,T]+(\d{1,2}):(\d{2})(?::(\d{2}))?$/)
  if (!match) return null
  const months = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 }
  const month = /^[A-Za-z]/.test(match[2]) ? months[match[2].toLowerCase()] : Number(match[2]) - 1
  if (!Number.isInteger(month) || month < 0 || month > 11) return null
  return Date.UTC(Number(match[3]), month, Number(match[1]), Number(match[4]), Number(match[5]), Number(match[6] || 0)) - IST_OFFSET_MS
}

function orderTime(order) {
  return brokerTimestamp(order?.orderDateTime ?? order?.orderDate ?? order?.tradedTime ?? order?.timestamp ?? order?.createdAt)
}

export function positionStartedAt(position, orders) {
  const symbol = String(position?.symbol || "")
  const product = String(position?.productType || "")
  const targetQuantity = finite(position?.quantity)
  if (!symbol || !targetQuantity || !Array.isArray(orders)) return null
  const fills = orders
    .filter((order) => String(order?.symbol || "") === symbol && (!product || !order?.productType || String(order.productType) === product))
    .map((order) => ({ order, at: orderTime(order), side: finite(order?.side), quantity: finite(order?.filledQty ?? order?.filledQuantity) }))
    .filter((fill) => fill.at !== null && (fill.side === 1 || fill.side === -1) && fill.quantity > 0)
    .sort((left, right) => left.at - right.at)
  let net = 0, startedAt = null
  for (const fill of fills) {
    const prior = net
    net += fill.side * fill.quantity
    if (prior === 0 || Math.sign(prior) !== Math.sign(net)) startedAt = fill.at
  }
  return Math.sign(net) === Math.sign(targetQuantity) ? startedAt : null
}

function ema(rows, period) {
  const alpha = 2 / (period + 1)
  let value = rows[0]?.close
  return rows.map((row, index) => {
    value = index === 0 ? row.close : row.close * alpha + value * (1 - alpha)
    return value
  })
}

export function sellPositionExitStatus({ position, candles, startedAt, now = Date.now() }) {
  const entry = finite(position?.averagePrice)
  const last = finite(position?.lastPrice)
  if (!(entry > 0) || !(last > 0) || !(startedAt > 0)) return { state: "UNAVAILABLE", label: "Exit monitor needs entry time" }
  const stop = entry * 1.007
  if (last >= stop) return { state: "SL_TRIGGERED", label: "SL triggered", stop }
  const day = istDay(startedAt)
  const rows = (Array.isArray(candles) ? candles : [])
    .filter((candle) => Number(candle?.time) > 0 && Number(candle?.close) > 0 && istDay(Number(candle.time) * 1000) === day && Number(candle.time) * 1000 + 60_000 <= now)
    .sort((left, right) => left.time - right.time)
  if (!rows.length) return { state: "ACTIVE", label: "SL active · waiting for candles", stop }
  const ema30 = ema(rows, 30), ema50 = ema(rows, 50)
  let gateIndex = -1
  for (let index = 0; index < rows.length; index++) {
    if (Number(rows[index].time) * 1000 + 60_000 <= startedAt) continue
    if (gateIndex < 0 && Number(rows[index].low) < entry * 0.98) gateIndex = index
    if (gateIndex >= 0 && index > 0 && ema30[index - 1] <= ema50[index - 1] && ema30[index] > ema50[index]) {
      return { state: "EXIT_TRIGGERED", label: "EXIT triggered · EMA30 > EMA50", stop, gateAt: rows[gateIndex].time, exitAt: rows[index].time }
    }
  }
  return gateIndex >= 0
    ? { state: "ACTIVE", label: "SL active · EMA exit armed", stop, gateAt: rows[gateIndex].time }
    : { state: "ACTIVE", label: "SL active · waiting for +2%", stop }
}
