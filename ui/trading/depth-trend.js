import { DEFAULT_TREND_CONFIG, entrySession, indiaTime } from "./config.js"

const mean = (xs) => xs.reduce((sum, x) => sum + x, 0) / xs.length
const positive = (x) => Number.isFinite(Number(x)) && Number(x) > 0

export function bookMetrics(data) {
  const bids = [], asks = []
  for (let level = 1; level <= 5; level++) {
    const bp = Number(data[`bid_price${level}`]), bq = Number(data[`bid_size${level}`])
    const ap = Number(data[`ask_price${level}`]), aq = Number(data[`ask_size${level}`])
    if (!positive(bp) || !positive(ap) || !Number.isFinite(bq) || bq < 0 || !Number.isFinite(aq) || aq < 0) return null
    if (level > 1 && (bp > bids.at(-1).price || ap < asks.at(-1).price)) return null
    bids.push({ price: bp, qty: bq })
    asks.push({ price: ap, qty: aq })
  }
  if (bids[0].price >= asks[0].price || !bids[0].qty || !asks[0].qty) return null
  const buy = bids.reduce((s, x) => s + x.qty, 0), sell = asks.reduce((s, x) => s + x.qty, 0)
  const mid = (bids[0].price + asks[0].price) / 2
  return { bids, asks, mid, nearBidQty: bids.slice(0, 2).reduce((s, x) => s + x.qty, 0), spread: (asks[0].price - bids[0].price) / mid, imbalance: (buy - sell) / (buy + sell) }
}

export function continuousDepthMetrics(samples, baselineNearBidQty) {
  let bidUpMoves = 0, bidDownMoves = 0, askUpMoves = 0, upTicks = 0, downTicks = 0
  let askReductionEvents = 0, tradeCorroboratedAskReductions = 0
  for (let i = 1; i < samples.length; i++) {
    const previous = samples[i - 1], current = samples[i]
    if (current.bid > previous.bid) bidUpMoves++
    if (current.bid < previous.bid) bidDownMoves++
    if (current.ask > previous.ask) askUpMoves++
    if (current.price > previous.price) upTicks++
    if (current.price < previous.price) downTicks++
    // Match the same price across snapshots. An order leaving the visible bottom
    // of the book is not treated as a reduction. This is not trade attribution.
    const reduced = previous.asks.some((old) => {
      const next = current.asks.find((x) => Math.abs(x.price - old.price) < 1e-8)
      return next ? next.qty < old.qty : old.price < current.ask
    })
    if (reduced) {
      askReductionEvents++
      if (current.volume > previous.volume && current.price >= previous.ask) tradeCorroboratedAskReductions++
    }
  }
  const first = samples[0], last = samples.at(-1), middle = samples[Math.floor(samples.length / 2)]
  const earlyRate = (middle.volume - first.volume) / Math.max(1, middle.second - first.second)
  const lateRate = (last.volume - middle.volume) / Math.max(1, last.second - middle.second)
  return {
    bidUpMoves, bidDownMoves, askUpMoves, askReductionEvents, tradeCorroboratedAskReductions,
    upTickRatio: upTicks + downTicks ? upTicks / (upTicks + downTicks) : 0,
    nearBidStrength: baselineNearBidQty > 0 ? mean(samples.map((x) => x.nearBidQty)) / baselineNearBidQty : 0,
    volumeAcceleration: earlyRate > 0 ? lateRate / earlyRate : lateRate > 0 ? null : 0,
  }
}

export function baselineMetrics(bars) {
  const high = Math.max(...bars.map((b) => b.high)), low = Math.min(...bars.map((b) => b.low))
  let tr = 0, travel = 0
  bars.forEach((b, i) => {
    const previous = i ? bars[i - 1].close : b.open
    tr += Math.max(b.high - b.low, Math.abs(b.high - previous), Math.abs(b.low - previous))
    travel += Math.abs(b.close - previous)
  })
  return {
    choppiness: high > low && tr > 0 ? 100 * Math.log10(tr / (high - low)) / Math.log10(bars.length) : 100,
    efficiency: travel ? Math.abs(bars.at(-1).close - bars[0].open) / travel : 0,
    volume: mean(bars.map((b) => b.volume)),
    imbalance: mean(bars.map((b) => b.imbalanceSum / b.depthCount)),
    nearBidQty: mean(bars.map((b) => (b.nearBidSum || 0) / b.depthCount)),
  }
}

// Feed this *only* messages as received. No look-ahead, fabricated empty bars,
// carried books across gaps, or claim of exchange-side trade classification.
export function createDepthTrend({ config = {}, hasExposure = () => false, onSignal = () => {} } = {}) {
  const c = { ...DEFAULT_TREND_CONFIG, ...config }
  const states = new Map()
  function reset() { states.clear() }
  function observe(kind, data, now) {
    const symbol = data.symbol
    if (!symbol?.endsWith("-EQ") || !["price", "depth"].includes(kind)) return
    let s = states.get(symbol)
    const day = indiaTime(now).day
    if (!s || s.day !== day || now - s.lastAt > c.maxGapMs) {
      s = { day, lastAt: now, bars: [], current: null, bookData: {}, samples: [], candidate: null, weak: null, cooldown: 0, warmup: "collecting" }
      states.set(symbol, s)
    }
    if (now < s.lastAt) return
    s.lastAt = now
    if (kind === "price") {
      const source = Number(data.exch_feed_time)
      if (positive(source) && (now - source * 1000 > c.staleMs || source * 1000 - now > c.staleMs)) return
      if (!positive(data.ltp) || !Number.isFinite(Number(data.vol_traded_today))) return
      s.price = Number(data.ltp)
      s.priceAt = now
      const total = Number(data.vol_traded_today)
      const delta = s.totalVolume != null && total >= s.totalVolume ? total - s.totalVolume : 0
      if (s.totalVolume != null && total < s.totalVolume) { states.delete(symbol); return }
      s.totalVolume = total
      const bucket = Math.floor(now / 60_000)
      if (!s.current || s.current.minute !== bucket) {
        if (s.current && s.current.minute === bucket - 1 && s.current.depthCount && !s.current.partial) {
          s.bars.push(s.current)
          if (s.bars.length > c.baselineMinutes) s.bars.shift()
        } else if (s.current && s.current.minute !== bucket - 1) s.bars = []
        s.current = { minute: bucket, open: s.price, close: s.price, high: s.price, low: s.price, volume: 0, imbalanceSum: 0, nearBidSum: 0, depthCount: 0, partial: !s.priceSeen }
      }
      s.priceSeen = true
      s.current.close = s.price
      s.current.high = Math.max(s.current.high, s.price)
      s.current.low = Math.min(s.current.low, s.price)
      s.current.volume += delta
      // A volume-delta / quote test is only a pressure proxy, not a footprint.
      const freshBook = s.book && now - s.depthAt <= c.staleMs
      s.pressure = freshBook && delta > 0 ? (s.price >= s.book.asks[0].price ? 1 : s.price <= s.book.bids[0].price ? -1 : 0) : 0
    } else {
      if (s.depthAt && now - s.depthAt > c.staleMs) s.bookData = {}
      Object.assign(s.bookData, data)
      s.book = bookMetrics(s.bookData)
      s.depthAt = now
      if (!s.book) { s.candidate = null; return }
    }
    if (!s.book || !s.price || now - s.priceAt > c.staleMs || now - s.depthAt > c.staleMs) { s.candidate = null; return }
    // One observation per second avoids giving duplicated SDK packets extra weight.
    const second = Math.floor(now / 1000)
    const sample = {
      second, price: s.price, imbalance: s.book.imbalance, pressure: s.pressure || 0,
      bid: s.book.bids[0].price, ask: s.book.asks[0].price,
      asks: s.book.asks, nearBidQty: s.book.nearBidQty, volume: s.totalVolume,
    }
    if (s.samples.at(-1)?.second === second) s.samples[s.samples.length - 1] = sample
    else {
      s.samples.push(sample)
      if (s.current && s.current.minute === Math.floor(now / 60_000)) {
        s.current.imbalanceSum += s.book.imbalance
        s.current.nearBidSum += s.book.nearBidQty
        s.current.depthCount++
      }
    }
    s.samples = s.samples.filter((x) => x.second >= second - c.recentSeconds)
    if (hasExposure(symbol)) {
      const flow = continuousDepthMetrics(s.samples, s.samples[0].nearBidQty)
      const retreat = s.samples.length >= 5 && flow.bidDownMoves >= 3 && flow.bidDownMoves > flow.bidUpMoves &&
        s.samples.at(-1).price <= s.samples[0].price
      if (s.book.imbalance < -0.1 || retreat) s.weak ??= now
      else s.weak = null
      if (s.weak != null && now - s.weak >= c.weakSeconds * 1000) {
        onSignal({ action: "EXIT", symbol, at: now, reason: retreat ? "bid_retreat_and_price_weakness" : "persistent_sell_pressure" })
        s.weak = now
      }
      return
    }
    if (s.bars.length < c.baselineMinutes || !entrySession(now, c) || now < s.cooldown) return
    const bars = s.bars
    if (bars.some((b, i) => i && b.minute !== bars[i - 1].minute + 1)) { s.bars = []; return }
    const baseline = baselineMetrics(bars)
    const elapsed = (now % 60_000) / 1000
    const first = s.samples[0], last = s.samples.at(-1)
    const travel = s.samples.slice(1).reduce((sum, x, i) => sum + Math.abs(x.price - s.samples[i].price), 0)
    const smoothness = travel ? (last.price - first.price) / travel : 0
    const rise = (last.price - first.price) / first.price
    const volumeRatio = elapsed >= 10 && baseline.volume > 0 ? s.current.volume / elapsed * 60 / baseline.volume : 0
    const imbalance = mean(s.samples.map((x) => x.imbalance))
    const continuous = continuousDepthMetrics(s.samples, baseline.nearBidQty)
    s.metrics = { ...baseline, ...continuous, volumeRatio, imbalance, imbalanceShift: imbalance - baseline.imbalance, smoothness, rise, spread: s.book.spread, pressureProxy: mean(s.samples.map((x) => x.pressure)) }
    const valid = s.samples.length >= Math.ceil(c.recentSeconds * 0.8) && last.second - first.second >= c.recentSeconds - 2 &&
      baseline.choppiness <= c.maxChoppiness && baseline.efficiency >= c.minBaselineEfficiency &&
      volumeRatio >= c.minVolumeRatio && volumeRatio <= c.maxVolumeRatio &&
      imbalance >= c.minImbalance && imbalance - baseline.imbalance >= c.minImbalanceShift &&
      continuous.bidUpMoves >= c.minBidUpMoves && continuous.bidUpMoves > continuous.bidDownMoves &&
      continuous.askUpMoves >= c.minAskUpMoves && continuous.upTickRatio >= c.minUpTickRatio &&
      continuous.nearBidStrength >= c.minNearBidStrength && continuous.askReductionEvents >= c.minAskReductionEvents &&
      continuous.volumeAcceleration != null && continuous.volumeAcceleration >= c.minVolumeAcceleration &&
      smoothness >= c.minSmoothness && rise >= c.minRise && rise <= c.maxChase &&
      s.book.spread <= c.maxSpread
    if (!valid) { s.candidate = null; return }
    s.candidate ??= now
    if (now - s.candidate < c.confirmSeconds * 1000) return
    s.candidate = null
    s.cooldown = now + c.cooldownMs
    onSignal({ action: "ENTRY", symbol, at: now, price: s.price, reason: "persistent_depth_shift", metrics: s.metrics })
  }
  function status() {
    return Object.fromEntries([...states].map(([symbol, s]) => [symbol, { completedMinutes: s.bars.length, ready: s.bars.length >= c.baselineMinutes, metrics: s.metrics ?? null }]))
  }
  function rankings(limit = 5) {
    const ranked = [...states].flatMap(([symbol, s]) => {
      if (!s.metrics || !positive(s.price)) return []
      const m = s.metrics
      const directional = clamp((m.rise || 0) * 20_000, -20, 20)
      const flow = clamp((m.imbalance || 0) * 45, -35, 35)
      const ticks = clamp(((m.upTickRatio || 0.5) - 0.5) * 50, -20, 20)
      const bidMotion = clamp(((m.bidUpMoves || 0) - (m.bidDownMoves || 0)) * 3, -15, 15)
      const pressure = clamp((m.pressureProxy || 0) * 10, -10, 10)
      const directionalScore = directional + flow + ticks + bidMotion + pressure
      return [{
        symbol,
        stock: symbol.replace(/^NSE:/, "").replace(/-EQ$/, ""),
        price: s.price,
        ready: s.bars.length >= c.baselineMinutes,
        completedMinutes: s.bars.length,
        buyScore: Math.round(clamp(50 + directionalScore, 0, 100)),
        sellScore: Math.round(clamp(50 - directionalScore, 0, 100)),
        imbalance: m.imbalance,
        rise: m.rise,
        volumeRatio: m.volumeRatio,
      }]
    })
    return {
      buy: ranked.slice().sort((a, b) => b.buyScore - a.buyScore).slice(0, limit),
      sell: ranked.slice().sort((a, b) => b.sellScore - a.sellScore).slice(0, limit),
    }
  }
  return { observe, reset, status, rankings }
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value))
}
