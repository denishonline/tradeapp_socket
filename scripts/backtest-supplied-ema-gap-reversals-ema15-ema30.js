import fs from 'node:fs'
import path from 'node:path'

// Backtests only the user-supplied EMA-gap signals.  A reversal is detected
// strictly from information available at its signal candle; trades enter at the
// following completed one-minute candle and exit on the configured fast EMA/EMA30 cross.
const root = process.cwd()
const IST = 330 * 60_000
const dates = ['2026-10-15', '2026-10-16', '2026-10-19', '2026-10-21', '2026-10-22', '2026-10-23']
const supplied = {
  '2026-10-15': `CASTROLIND 09:15 BUY\nTATATECH 09:16 BUY\nTCS 09:26 BUY\nNIFTYIT 09:27 BUY\nKPITTECH 09:28 BUY\nWIPRO 09:29 BUY\nHCLTECH 09:45 BUY\nBHARTIARTL 09:46 BUY\nHDFCAMC 09:46 BUY\nCAMS 09:47 BUY\nHEROMOTOCO 09:47 BUY\nAPOLLOHOSP 09:52 BUY\nAXISBANK 09:54 BUY\nSBICARD 09:54 BUY\nLUPIN 09:56 BUY\nIIFL 09:15 SELL\nNATIONALUM 09:17 SELL\nCYIENTDLM 09:19 SELL\nCUMMINSIND 09:21 SELL\nHINDALCO 09:21 SELL\nHINDZINC 09:21 SELL\nPOWERINDIA 09:21 SELL\nCANBK 09:22 SELL\nCGPOWER 09:22 SELL\nKALYANKJIL 09:23 SELL\nABB 09:27 SELL\nBANKINDIA 09:27 SELL\nSIEMENS 09:28 SELL\nTIINDIA 09:29 SELL\nCOCHINSHIP 09:30 SELL\nPNBHOUSING 09:31 SELL\nOFSS 09:33 SELL\nUNIONBANK 09:36 SELL\nNIFTYPSUBANK 09:37 SELL\nPNB 09:37 SELL\nINOXWIND 09:38 SELL\nOBEROIRLTY 09:43 SELL`,
  '2026-10-16': `ANGELONE 09:15 BUY\nETERNAL 09:25 BUY\nINFY 09:25 BUY\nTCS 09:25 BUY\nWIPRO 09:25 BUY\nOFSS 09:28 BUY\nNIFTYIT 09:31 BUY\nKPITTECH 09:43 BUY\nNATIONALUM 09:44 BUY\nTATAELXSI 09:46 BUY\nMPHASIS 09:48 BUY\nBHARTIARTL 09:51 BUY\nLTF 09:16 SELL\nASIANPAINT 09:18 SELL\nJIOFIN 09:19 SELL\nTIINDIA 09:20 SELL\nICICIPRULI 09:22 SELL\nSHRIRAMFIN 09:22 SELL\nHDFCLIFE 09:23 SELL\nGODREJCP 09:24 SELL\nGODREJPROP 09:24 SELL\nNIFTYFMCG 09:24 SELL\nDABUR 09:27 SELL\nHINDUNILVR 09:27 SELL\nABB 09:32 SELL\nIRCTC 09:33 SELL\nLT 09:34 SELL\nBAJAJFINSV 09:36 SELL\nCDSL 09:36 SELL\nGRASIM 09:36 SELL\nIDEA 09:36 SELL\nMCX 09:39 SELL\nVOLTAS 09:43 SELL\nCOALINDIA 09:44 SELL\nONGC 09:44 SELL\nBLUESTARCO 09:48 SELL\nAUBANK 09:50 SELL\nMANKIND 09:50 SELL\nLUPIN 09:51 SELL\nTORNTPHARM 09:53 SELL`,
  '2026-10-19': `PERSISTENT 09:16 BUY\nNCC 09:17 BUY\nNIFTYPSUBANK 09:24 BUY\nBANKBARODA 09:26 BUY\nCANBK 09:26 BUY\nBANKINDIA 09:27 BUY\nUNIONBANK 09:27 BUY\nDIVISLAB 09:30 BUY\nSBIN 09:31 BUY\nMANKIND 09:35 BUY\nEICHERMOT 09:36 BUY\nPREMIERENE 09:41 BUY\nULTRACEMCO 09:51 BUY\nSHREECEM 09:53 BUY\nINOXWIND 09:18 SELL\nAXISBANK 09:21 SELL\nKFINTECH 09:26 SELL\nHAVELLS 09:27 SELL\nNHPC 09:27 SELL\nLTF 09:28 SELL\nPOLICYBZR 09:28 SELL\nBDL 09:29 SELL\nSRF 09:29 SELL\nCAMS 09:30 SELL\nCYIENTDLM 09:30 SELL\nHDFCBANK 09:30 SELL\nPGEL 09:30 SELL\nSAMMAANCAP 09:30 SELL\nPOLYCAB 09:31 SELL\n360ONE 09:36 SELL\nOBEROIRLTY 09:36 SELL\nIEX 09:42 SELL\nCOLPAL 09:44 SELL\nMFSL 09:57 SELL\nICICIPRULI 09:58 SELL\nMOTILALOFS 09:58 SELL`,
  '2026-10-21': `TCS 09:23 BUY\nHCLTECH 09:24 BUY\nINFY 09:24 BUY\nTECHM 09:24 BUY\nWIPRO 09:24 BUY\nKALYANKJIL 09:27 BUY\nNHPC 09:30 BUY\nPETRONET 09:33 BUY\nICICIBANK 09:34 BUY\nJSWSTEEL 09:34 BUY\nMPHASIS 09:34 BUY\nKPITTECH 09:36 BUY\nRELIANCE 09:36 BUY\nINDIANB 09:38 BUY\nPNB 09:38 BUY\nBHARTIARTL 09:42 BUY\nSUZLON 09:15 SELL\nMANAPPURAM 09:18 SELL\nPREMIERENE 09:19 SELL\nGLAND 09:21 SELL\nABB 09:24 SELL\nNCC 09:31 SELL\nWAAREEENER 09:37 SELL\nBHEL 09:39 SELL\nSOLARINDS 09:46 SELL\nSIEMENS 09:50 SELL\nCGPOWER 09:51 SELL\nFORCEMOT 09:51 SELL\nAPLAPOLLO 09:52 SELL\nCUMMINSIND 09:56 SELL`,
  '2026-10-22': `INDHOTEL 09:24 BUY\nWIPRO 09:32 BUY\nBAJAJHLDNG 09:45 BUY\nUNOMINDA 09:48 BUY\nBHARTIARTL 09:50 BUY\nKAYNES 09:50 BUY\nKALYANKJIL 09:18 SELL\nSAIL 09:21 SELL\nCAMS 09:22 SELL\nPETRONET 09:24 SELL\nPOWERINDIA 09:24 SELL\nSHREECEM 09:24 SELL\nSONACOMS 09:25 SELL\nLUPIN 09:26 SELL\nMOTHERSON 09:26 SELL\nALKEM 09:27 SELL\nMARICO 09:27 SELL\nAMBUJACEM 09:30 SELL\nSBILIFE 09:30 SELL\nBLUESTARCO 09:31 SELL\nMUTHOOTFIN 09:31 SELL\nPFC 09:32 SELL\nBDL 09:34 SELL\nDRREDDY 09:35 SELL\nRELIANCE 09:35 SELL`,
  '2026-10-23': `HCLTECH 09:17 BUY\nTCS 09:18 BUY\nINFY 09:20 BUY\nWIPRO 09:20 BUY\nTECHM 09:25 BUY\nADANIENSOL 09:15 SELL\nNAM-INDIA 09:15 SELL\nMUTHOOTFIN 09:16 SELL\nSAMMAANCAP 09:16 SELL\nSIEMENS 09:18 SELL\nABB 09:20 SELL\nCHOLAFIN 09:20 SELL\nKEI 09:20 SELL\nADANIPOWER 09:22 SELL\nBANDHANBNK 09:23 SELL\nCONCOR 09:23 SELL\nHINDZINC 09:23 SELL\nNATIONALUM 09:23 SELL\nAMBUJACEM 09:24 SELL\nCGPOWER 09:24 SELL\nHINDALCO 09:24 SELL\nIRFC 09:24 SELL\nLTF 09:24 SELL\nMANAPPURAM 09:24 SELL\nVEDL 09:24 SELL\nCUMMINSIND 09:25 SELL\nDELHIVERY 09:28 SELL\nMOTHERSON 09:28 SELL\nUNOMINDA 09:30 SELL\nINOXWIND 09:31 SELL\nMOTILALOFS 09:31 SELL\nVOLTAS 09:31 SELL\nIDEA 09:32 SELL\nICICIGI 09:33 SELL\nLODHA 09:33 SELL\nNBCC 09:33 SELL\nSAIL 09:33 SELL\nSUZLON 09:33 SELL\nADANIENT 09:34 SELL\nADANIGREEN 09:34 SELL\nCDSL 09:34 SELL\nRBLBANK 09:34 SELL\nHINDPETRO 09:35 SELL\n360ONE 09:36 SELL\nBANKINDIA 09:36 SELL\nNMDC 09:36 SELL\nIEX 09:37 SELL\nBLUESTARCO 09:38 SELL\nKFINTECH 09:38 SELL\nSOLARINDS 09:38 SELL`,
}
const presets = [
  { name: 'strict_previous', two: 0.35, depth: 50, midpoint: 0.15, depthStrict: true, volumeCap: 1.3 },
  { name: 'modestly_looser', two: 0.20, depth: 50, midpoint: 0.05, depthStrict: true, volumeCap: Infinity },
  { name: 'radar_loose', two: 0.15, depth: 50, midpoint: 0.02, depthStrict: false, volumeCap: Infinity },
  { name: 'upside_reversal_refined', side: 'BUY', two: 0.30, depth: 50, midpoint: 0.16, depthStrict: true, volumeCap: Infinity },
  { name: 'recommended_upside_reversal_ema15', side: 'BUY', two: 0.30, depth: 50, midpoint: 0.16, depthStrict: true, volumeCap: 1.5, exitFast: 15 },
  { name: 'recommended_upside_reversal_ema12', side: 'BUY', two: 0.30, depth: 50, midpoint: 0.16, depthStrict: true, volumeCap: 1.5, exitFast: 12 },
  { name: 'recommended_downside_reversal_ema15', side: 'SELL', two: 0.30, depth: 50, midpoint: 0.16, depthStrict: true, volumeCap: 1.5, exitFast: 15 },
]
const minute = time => Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5))
const stamp = seconds => new Date(seconds * 1000 + IST).toISOString().slice(0, 16).replace('T', ' ')
const dayOf = seconds => stamp(seconds).slice(0, 10)
const timeOf = seconds => stamp(seconds).slice(11)
const round = (n, d = 4) => Number.isFinite(n) ? +n.toFixed(d) : null
const pct = (value, base) => 100 * (value / base - 1)
const outputTime = m => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`
const parseSignals = (date, text) => text.split('\n').map(line => { const [symbol, time, side] = line.split(/\s+/); return { date, symbol, time, side } })
const symbols = [...new Set(Object.values(supplied).flatMap(text => parseSignals('', text).map(x => x.symbol)))]
const candleCache = new Map(), depthCache = new Map()

function candles(symbol) {
  if (candleCache.has(symbol)) return candleCache.get(symbol)
  const file = path.join(root, 'db', 'candles', `${symbol}.jsonl`)
  const rows = !fs.existsSync(file) ? [] : fs.readFileSync(file, 'utf8').split(/\r?\n/).flatMap(line => {
    try {
      const raw = JSON.parse(line), day = dayOf(raw.time), m = minute(timeOf(raw.time))
      if (day > dates.at(-1) || m < 555 || m >= 930 || ![raw.open, raw.high, raw.low, raw.close, raw.volume].every(Number.isFinite)) return []
      return [{ time: stamp(raw.time), day, minute: m, open: +raw.open, high: +raw.high, low: +raw.low, close: +raw.close, volume: +raw.volume }]
    } catch { return [] }
  }).sort((a, b) => a.time.localeCompare(b.time))
  let ema5, ema12, ema15, ema30
  for (const row of rows) {
    ema5 = ema5 == null ? row.close : row.close * 2 / 6 + ema5 * 4 / 6
    ema12 = ema12 == null ? row.close : row.close * 2 / 13 + ema12 * 11 / 13
    ema15 = ema15 == null ? row.close : row.close * 2 / 16 + ema15 * 14 / 16
    ema30 = ema30 == null ? row.close : row.close * 2 / 31 + ema30 * 29 / 31
    Object.assign(row, { ema5, ema12, ema15, ema30 })
  }
  candleCache.set(symbol, rows)
  return rows
}

function depth(symbol, date) {
  const cacheKey = `${date}|${symbol}`
  if (depthCache.has(cacheKey)) return depthCache.get(cacheKey)
  const file = path.join(root, 'db', 'cash-depth', date, symbol, `${symbol}.jsonl`), state = {}, out = new Map()
  if (fs.existsSync(file)) for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue
    try {
      const event = JSON.parse(line), received = stamp(Date.parse(event.receivedAt) / 1000), m = minute(received.slice(11))
      if (received.slice(0, 10) !== date || m < 555 || m >= 930) continue
      if (event.kind === 'checkpoint') for (const key of Object.keys(state)) delete state[key]
      Object.assign(state, event.data ?? {})
      let bid = 0, ask = 0, valid = true
      for (let n = 1; n <= 5; n++) {
        const bp = +state[`bid_price${n}`], ap = +state[`ask_price${n}`], bs = +state[`bid_size${n}`], as = +state[`ask_size${n}`]
        if (![bp, ap, bs, as].every(Number.isFinite) || bp <= 0 || ap <= bp) { valid = false; break }
        bid += bs; ask += as
      }
      if (valid) out.set(received, { bidShare: 100 * bid / (bid + ask || 1), midpoint: (+state.bid_price1 + +state.ask_price1) / 2 })
    } catch { /* malformed depth event */ }
  }
  depthCache.set(cacheKey, out)
  return out
}

function firstReversal(signal, preset) {
  const rows = candles(signal.symbol), book = depth(signal.symbol, signal.date), originalMinute = minute(signal.time)
  const direction = signal.side === 'SELL' ? 1 : -1, reversalSide = direction === 1 ? 'BUY' : 'SELL'
  if (preset.side && preset.side !== reversalSide) return null
  for (let i = 1; i < rows.length; i++) {
    const left = rows[i - 1], right = rows[i]
    if (right.day !== signal.date || right.minute <= originalMinute || right.minute >= 600) continue
    const leftDepth = book.get(left.time), rightDepth = book.get(right.time)
    if (!leftDepth || !rightDepth) continue
    const session = rows.filter(row => row.day === signal.date && row.minute >= 555 && row.minute <= right.minute)
    const lastFive = session.slice(-5)
    if (lastFive.length !== 5) continue
    const lastAverage = lastFive.reduce((sum, row) => sum + row.volume, 0) / 5
    const sessionAverage = session.reduce((sum, row) => sum + row.volume, 0) / session.length
    const volumeRatio = lastAverage / sessionAverage
    const directionalShare = direction === 1 ? (leftDepth.bidShare + rightDepth.bidShare) / 2 : ((100 - leftDepth.bidShare) + (100 - rightDepth.bidShare)) / 2
    const midpointMove = direction * pct(rightDepth.midpoint, leftDepth.midpoint)
    const twoMove = direction * pct(right.close, left.open)
    const colourCount = lastFive.filter(row => direction === 1 ? row.close > row.open : row.close < row.open).length
    const depthPass = preset.depthStrict ? directionalShare > preset.depth : directionalShare >= preset.depth
    if (twoMove < preset.two || direction * (right.ema5 - left.ema5) <= 0 || direction * (right.close - right.ema5) <= 0 || !depthPass || midpointMove <= preset.midpoint || colourCount < 3 || volumeRatio <= 1 || volumeRatio >= preset.volumeCap) continue
    const entryIndex = i + 1, entry = rows[entryIndex]
    if (!entry || entry.day !== signal.date) continue
    return { signal, reversalSide, signalIndex: i, entryIndex, reversalTime: right.time, entryTime: entry.time, twoMove, directionalShare, midpointMove, volumeRatio, colourCount }
  }
  return null
}

function evaluate(reversal) {
  const rows = candles(reversal.signal.symbol), direction = reversal.reversalSide === 'BUY' ? 1 : -1
  const entry = rows[reversal.entryIndex]
  const fast = `ema${reversal.preset.exitFast ?? 15}`
  const crossed = (row, index) => index > reversal.entryIndex && row.day === entry.day && ((direction === 1 && rows[index - 1][fast] >= rows[index - 1].ema30 && row[fast] < row.ema30) || (direction === -1 && rows[index - 1][fast] <= rows[index - 1].ema30 && row[fast] > row.ema30))
  let exitIndex = rows.findIndex(crossed)
  if (exitIndex < 0) { for (let i = rows.length - 1; i > reversal.entryIndex; i--) if (rows[i].day === entry.day) { exitIndex = i; break } }
  if (exitIndex < 0) return null
  const exit = rows[exitIndex], held = rows.slice(reversal.entryIndex, exitIndex + 1), adverse = direction === 1 ? Math.min(...held.map(row => pct(row.low, entry.close))) : Math.min(...held.map(row => -pct(row.high, entry.close)))
  return { ...reversal, entryPrice: entry.close, exitTime: exit.time, exitPrice: exit.close, exitReason: crossed(exit, exitIndex) ? `EMA${reversal.preset.exitFast ?? 15} crossed EMA30` : 'session close', returnPct: direction * pct(exit.close, entry.close), maePct: adverse }
}

function summary(trades) {
  const dayReturns = new Map()
  for (const trade of trades) dayReturns.set(trade.signal.date, (dayReturns.get(trade.signal.date) ?? 0) + trade.returnPct)
  return { trades: trades.length, wins: trades.filter(t => t.returnPct > 0).length, winRatePct: round(100 * trades.filter(t => t.returnPct > 0).length / (trades.length || 1), 2), averageReturnPct: round(trades.reduce((s, t) => s + t.returnPct, 0) / (trades.length || 1), 3), totalReturnPct: round(trades.reduce((s, t) => s + t.returnPct, 0), 3), maximumAdverseExcursionPct: round(Math.min(0, ...trades.map(t => t.maePct)), 3), worstDay: [...dayReturns].sort((a, b) => a[1] - b[1])[0] ? { date: [...dayReturns].sort((a, b) => a[1] - b[1])[0][0], totalReturnPct: round([...dayReturns].sort((a, b) => a[1] - b[1])[0][1], 3) } : null }
}

const signals = dates.flatMap(date => parseSignals(date, supplied[date]))
const report = { method: 'User-supplied EMA-gap signals only. Reversal confirmation uses no candles or depth after its signal time. Entry is next completed 1m candle close. Exit is the first completed configured fast-EMA/EMA30 cross against the reversal side, else 15:29 close.', presets: {} }
for (const preset of presets) {
  const trades = signals.map(signal => firstReversal(signal, preset)).filter(Boolean).map(reversal => evaluate({ ...reversal, preset })).filter(Boolean)
  report.presets[preset.name] = { rules: preset, summary: summary(trades), profitableOnlySummary: summary(trades.filter(t => t.returnPct > 0)), trades: trades.map(t => ({ date: t.signal.date, stock: t.signal.symbol, originalSide: t.signal.side, reversalSide: t.reversalSide, originalTime: t.signal.time, reversalTime: t.reversalTime.slice(11), entryTime: t.entryTime.slice(11), exitTime: t.exitTime.slice(11), exitReason: t.exitReason, returnPct: round(t.returnPct, 3), maePct: round(t.maePct, 3), twoMinuteMovePct: round(t.twoMove, 3), depthSharePct: round(t.directionalShare, 2), midpointMovePct: round(t.midpointMove, 3), volumeRatio: round(t.volumeRatio, 3), reverseColourCandles: t.colourCount })) }
}
let out = path.join(root, 'reports', '2026-10-19-to-23-supplied-ema-gap-reversals-ema15-ema30-backtest.json'), suffix = 2
while (fs.existsSync(out)) out = path.join(root, 'reports', `2026-10-19-to-23-supplied-ema-gap-reversals-ema15-ema30-backtest-${suffix++}.json`)
fs.writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`)
for (const [name, result] of Object.entries(report.presets)) console.log(`${name}: ${result.summary.trades} trades | ${result.summary.wins} wins | win ${result.summary.winRatePct}% | avg ${result.summary.averageReturnPct}% | total ${result.summary.totalReturnPct}% | MAE ${result.summary.maximumAdverseExcursionPct}% | worst ${result.summary.worstDay?.date ?? '-'} ${result.summary.worstDay?.totalReturnPct ?? '-'}% | profitable-only ${result.profitableOnlySummary.trades}`)
console.log(out)
