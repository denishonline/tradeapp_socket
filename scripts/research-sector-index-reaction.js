import fs from 'node:fs'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
const day = process.argv[2] || '2026-10-16'
if (day !== '2026-10-16') throw new Error('This exploratory scan is scoped to 2026-10-16')
const buckets = JSON.parse(fs.readFileSync(path.join(root, 'db/stocks_sector_wise'), 'utf8'))
const indices = JSON.parse(fs.readFileSync(path.join(root, 'db/sector_indices'), 'utf8'))
  .filter(x => !['NIFTYPRIVBANK', 'NIFTYPSUBANK'].includes(x.name))
  .filter(x => fs.existsSync(path.join(root, 'db/candles', `${x.name}.jsonl`)))
const universe = JSON.parse(fs.readFileSync(path.join(root, 'db/stocks'), 'utf8'))
indices.push({ name: 'NIFTY50', bucket: 'MARKET_WIDE' })
const t0 = Date.parse(`${day}T03:45:00Z`) / 1000
const tEnd = Date.parse(`${day}T10:00:00Z`) / 1000
const round = (x, digits = 4) => Number(x.toFixed(digits))
const pct = (x, base) => (x / base - 1) * 100
const time = (t) => new Date((t + 330 * 60) * 1000).toISOString().slice(11, 16)
const unique = (stem, ext) => {
  let file = path.join(root, 'reports', `${stem}.${ext}`), revision = 2
  while (fs.existsSync(file)) file = path.join(root, 'reports', `${stem}-${revision++}.${ext}`)
  return file
}
const cache = new Map()
function rows(symbol) {
  if (!cache.has(symbol)) {
    const file = path.join(root, 'db/candles', `${symbol}.jsonl`)
    const dayRows = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean)
      .map(JSON.parse).filter(x => x.time >= t0 && x.time < tEnd) : []
    cache.set(symbol, new Map(dayRows.map(x => [x.time, x])))
  }
  return cache.get(symbol)
}
function at(symbol, t) { return rows(symbol).get(t) }
function depthAtReaction(symbol, start, cutoff) {
  const file = path.join(root, 'db/cash-depth', day, symbol, `${symbol}.jsonl`)
  if (!fs.existsSync(file)) return null
  const fields = {}, perMinute = new Map()
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!line) continue
    const event = JSON.parse(line), atMs = Date.parse(event.receivedAt)
    if (atMs >= cutoff * 1000) break
    if (event.data) Object.assign(fields, event.data)
    if (atMs < start * 1000) continue
    let bid = 0, ask = 0
    for (let level = 1; level <= 5; level++) {
      bid += Number(fields[`bid_size${level}`]) || 0
      ask += Number(fields[`ask_size${level}`]) || 0
    }
    if (bid + ask <= 0) continue
    const minute = Math.floor(atMs / 60000)
    const bucket = perMinute.get(minute) || { sum: 0, count: 0 }
    bucket.sum += (bid - ask) / (bid + ask)
    bucket.count++
    perMinute.set(minute, bucket)
  }
  const means = [...perMinute.values()].map(x => x.sum / x.count)
  return means.length ? { minutes: means.length,
    averageFiveLevelImbalance: round(means.reduce((a, x) => a + x, 0) / means.length),
    positiveMinutes: means.filter(x => x > 0).length } : null
}

const setup = {
  earliestIndexMinute: 9 * 60 + 25, latestIndexMinute: 13 * 60 + 30,
  indexMinMovePct: 0.18, indexMinBodyPct: 0.10,
  stockQuietMinutes: 5, stockMaxPriorRangePct: 0.45,
  stockMaxImpulseMovePct: 0.12, stockConfirmMinutes: 2,
  stockMinBreakPct: 0.04, stockMinReactionMovePct: 0.12,
}
const impulses = [], candidates = [], confirmed = []
const mapped = new Map()
for (const index of indices) {
  const symbols = (index.name === 'NIFTY50' ? universe : buckets[index.bucket] || [])
    .filter(s => rows(s).size > 0)
  mapped.set(index.name, symbols)
  const ix = rows(index.name)
  for (const [t, candle] of ix) {
    const minute = Number(time(t).slice(0, 2)) * 60 + Number(time(t).slice(3))
    if (minute < setup.earliestIndexMinute || minute > setup.latestIndexMinute) continue
    const previous = ix.get(t - 60)
    const prior = Array.from({ length: 5 }, (_, n) => ix.get(t - (n + 1) * 60))
    if (!previous || prior.some(x => !x)) continue
    const move = pct(candle.close, previous.close), body = pct(candle.close, candle.open)
    for (const side of ['BUY', 'SELL']) {
      const sign = side === 'BUY' ? 1 : -1
      if (sign * move < setup.indexMinMovePct || sign * body < setup.indexMinBodyPct) continue
      const edge = side === 'BUY' ? Math.max(...prior.map(x => x.high)) : Math.min(...prior.map(x => x.low))
      if (sign * (candle.close - edge) <= 0) continue
      const impulse = { index: index.name, sector: index.bucket, side, indexMinute: time(t),
        indexMovePct: round(move), indexBodyPct: round(body), indexBreakPct: round(pct(candle.close, edge)),
        eligibleQuietStocks: 0, confirmedStocks: 0 }
      impulses.push(impulse)
      for (const symbol of symbols) {
        const priorStock = Array.from({ length: setup.stockQuietMinutes }, (_, n) => at(symbol, t - (n + 1) * 60))
        const stockAtImpulse = at(symbol, t)
        if (!stockAtImpulse || priorStock.some(x => !x)) continue
        const high = Math.max(...priorStock.map(x => x.high)), low = Math.min(...priorStock.map(x => x.low))
        const rangePct = pct(high, low)
        const moveAtImpulse = pct(stockAtImpulse.close, priorStock[0].close)
        if (rangePct > setup.stockMaxPriorRangePct || sign * moveAtImpulse > setup.stockMaxImpulseMovePct) continue
        impulse.eligibleQuietStocks++
        const candidate = { ...impulse, symbol, stockPriorRangePct: round(rangePct),
          stockMoveAtIndexPct: round(moveAtImpulse), rangeHigh: high, rangeLow: low,
          confirmed: false }
        candidates.push(candidate)
        for (let delay = 1; delay <= setup.stockConfirmMinutes; delay++) {
          const ct = t + delay * 60, confirm = at(symbol, ct), entry = at(symbol, ct + 60)
          if (!confirm || !entry) continue
          const barrier = side === 'BUY' ? high * (1 + setup.stockMinBreakPct / 100)
            : low * (1 - setup.stockMinBreakPct / 100)
          if (sign * (confirm.close - barrier) <= 0 ||
              sign * pct(confirm.close, stockAtImpulse.close) < setup.stockMinReactionMovePct) continue
          const after = Array.from(rows(symbol)).filter(([ts]) => ts > ct + 60).map(([, x]) => x)
          if (!after.length) continue
          const eod = after.at(-1), next15 = after.filter(x => x.time <= ct + 16 * 60)
          const next30 = after.filter(x => x.time <= ct + 31 * 60)
          const adverse = side === 'BUY' ? Math.min(entry.low, ...next30.map(x => x.low))
            : Math.max(entry.high, ...next30.map(x => x.high))
          const result = { ...candidate, confirmed: true, confirmationTime: time(ct + 60),
            delayMinutes: delay, entryTime: time(ct + 120), entryPrice: entry.close,
            confirmationMovePct: round(sign * pct(confirm.close, stockAtImpulse.close)),
            return15Pct: round(sign * pct(next15.at(-1).close, entry.close)),
            return30Pct: round(sign * pct(next30.at(-1).close, entry.close)),
            returnEodPct: round(sign * pct(eod.close, entry.close)),
            mae30Pct: round(sign * pct(adverse, entry.close)),
            depthThroughConfirmation: depthAtReaction(symbol, t, ct + 60),
          }
          confirmed.push(result)
          impulse.confirmedStocks++
          Object.assign(candidate, result)
          break
        }
      }
    }
  }
}

// A stock can be exposed to overlapping index impulses. Attribute its first
// confirmed reaction per index and side to the earliest event for clear counting.
confirmed.sort((a, b) => a.entryTime.localeCompare(b.entryTime) || a.indexMinute.localeCompare(b.indexMinute))
const first = [], seen = new Set()
for (const row of confirmed) {
  const key = `${row.index}:${row.symbol}:${row.side}`
  if (!seen.has(key)) { first.push(row); seen.add(key) }
}
const stats = xs => ({ count: xs.length, wins15: xs.filter(x => x.return15Pct > 0).length,
  losses15: xs.filter(x => x.return15Pct < 0).length,
  winRate15Pct: xs.length ? round(100 * xs.filter(x => x.return15Pct > 0).length / xs.length, 2) : 0,
  average15Pct: xs.length ? round(xs.reduce((a, x) => a + x.return15Pct, 0) / xs.length) : 0,
  total15Pct: round(xs.reduce((a, x) => a + x.return15Pct, 0)),
  worstMae30Pct: xs.length ? round(Math.min(...xs.map(x => x.mae30Pct))) : 0,
  average30Pct: xs.length ? round(xs.reduce((a, x) => a + x.return30Pct, 0) / xs.length) : 0,
  averageEodPct: xs.length ? round(xs.reduce((a, x) => a + x.returnEodPct, 0) / xs.length) : 0 })
const result = { date: day, setup, definitions: {
  indexImpulse: 'Index close breaks the preceding five-minute high/low on a directional candle.',
  quietStock: 'Prior five-minute high-low range at most 0.45%; stock has not already moved more than 0.12% in the index-breakout direction during that same minute.',
  confirmation: 'One of the next two completed stock candles closes 0.04% beyond the old stock range and at least 0.12% past its close during the index impulse.',
  entry: 'Close of the next completed one-minute stock candle after confirmation; results are uncosted marks after 15/30 minutes and at EOD.',
  interpretation: 'Temporal lead on one-minute bars, not proof of causal index-to-stock influence; some stocks are index constituents.' },
  coverage: { indexCount: indices.length, mappedStocks: new Set([...mapped.values()].flat()).size,
    indexImpulseCount: impulses.length, quietCandidateCount: candidates.length,
    rawConfirmationCount: confirmed.length, firstPerIndexStockSideCount: first.length },
  stats: stats(first), statsBySide: Object.fromEntries(['BUY', 'SELL'].map(s => [s, stats(first.filter(x => x.side === s))])),
  statsByIndex: Object.fromEntries(indices.map(x => [x.name, stats(first.filter(r => r.index === x.name))])),
  impulses, firstConfirmations: first, allConfirmations: confirmed,
  quietCandidates: candidates,
}
const stem = `${day}-sector-index-lead-quiet-stock-reaction`
const json = unique(stem, 'json'), markdown = unique(stem, 'md')
fs.writeFileSync(json, JSON.stringify(result, null, 2))
const top = first.slice().sort((a, b) => b.return15Pct - a.return15Pct).slice(0, 20)
fs.writeFileSync(markdown, [
  '# Sector index lead and quiet stock reaction — 16 Oct 2026', '',
  'Exploratory one-day replay. All detection uses completed one-minute bars available before each entry. See the JSON for every impulse, quiet candidate, confirmed signal, and failed candidate.', '',
  `Index impulses: ${impulses.length}; quiet stock candidates: ${candidates.length}; raw confirmations: ${confirmed.length}; first confirmation per index/stock/side: ${first.length}.`,
  `First-confirmation 15-minute outcome: ${result.stats.wins15} winners, ${result.stats.losses15} losers; win rate ${result.stats.winRate15Pct}%; average ${result.stats.average15Pct}%; summed gross ${result.stats.total15Pct}%; worst 30-minute MAE ${result.stats.worstMae30Pct}%.`,
  'Worst day: 16 Oct (only day examined). Values exclude transaction costs and slippage. Same-minute index and constituent stock moves can share a cause.', '',
  '| Stock | Sector index | Side | Index impulse | Confirm | Entry | 15m % | 30m % | EOD % |',
  '| --- | --- | --- | --- | --- | --- | ---: | ---: | ---: |',
  ...top.map(x => `| ${x.symbol} | ${x.index} | ${x.side} | ${x.indexMinute} | ${x.confirmationTime} | ${x.entryTime} | ${x.return15Pct} | ${x.return30Pct} | ${x.returnEodPct} |`),
  '', 'Candidate logic and full false-positive ledger are in the paired JSON file.', ''
].join('\n'))
console.log(JSON.stringify({ json, markdown, coverage: result.coverage, stats: result.stats,
  bySide: result.statsBySide, top: top.slice(0, 10).map(x => ({symbol:x.symbol,index:x.index,side:x.side,indexAt:x.indexMinute,confirmation:x.confirmationTime,entry:x.entryTime,return15Pct:x.return15Pct})) }, null, 2))
