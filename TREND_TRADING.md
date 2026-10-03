# Depth trend trading

`npm start` starts only the local dashboard and recorder. The detector, FYERS streams,
and execution manager start only after the dashboard's **Start Server** button is
used. Read the flag settings in `constant.js` first: the existing cash flag is
**true**, so that button can enable real cash orders. No separate activation flag
overrides these settings.

The same button becomes **Stop Server** while the engine is active. Stop disconnects
both streams, closes the execution runtime, clears rankings, and discards the current
unfinished candle. For safety it is refused while a live strategy position, live
pending order, or active execution cycle still needs management.

| Cash flag | Option flag | New entry behaviour |
|---|---|---|
| false | false | Simulated long cash entry and exit, recorded to disk |
| true | false | Real long cash orders |
| false | true | Real long call-option orders |
| true | true | Independent cash and call orders, subject to shared capital/position limits |

Positions retain their original paper/live mode. Changing flags prevents the
corresponding new entries after restart; it does not abandon existing live positions.
Short-selling and puts are not included in this upward-trend strategy.

## Signal rules

`DEPTH_TREND` in `constant.js` overrides defaults in `ui/trading/config.js`.
Defaults require 100 **completed, contiguous, observed** one-minute bars with
price, volume and depth observations. The partial first minute is discarded.
Warmup takes at least 101 minutes from startup and restarts after disconnections,
day changes, or long gaps. Recorded history is not automatically used to trigger
live orders on restart. Stale exchange feed times and invalid books are rejected.

The detector requires all of the following:

- Baseline Choppiness Index at most 45 and directional efficiency at least 0.2.
- Current minute's elapsed-time-adjusted volume 1.2–4 times baseline mean volume
  (at least 10 seconds of that minute must have elapsed).
- Average five-level bid/ask quantity imbalance at least 0.2 and a shift of at least
  0.15 above the baseline. Imbalance is `(bid quantity - ask quantity) / total`.
- A recent 20-second rise of 0.03%–0.4%, directional efficiency at least 0.6,
  sufficient observations, and spread no larger than 0.15%.
- At least 3 best-bid upward steps (more upward than downward), 2 best-ask upward
  steps, and 60% of non-flat LTP steps upward in the recent window.
- Near-market bid quantity (top 2 levels) at least 1.1 times its 100-minute baseline,
  at least one ask reduction/removal, and recent volume rate not decelerating.
- Conditions maintained for at least 8 seconds; a 5-minute candidate cooldown.

All five levels are observed continuously. For signal weighting, one snapshot per
second is retained, so repeated identical SDK messages do not manufacture confidence.
Ask reductions are matched by price, not merely array index. A disappearance cannot
be proved to be consumption; `tradeCorroboratedAskReductions` is recorded separately
when volume increased and LTP reached the prior ask, but is still only supporting
evidence. For calls the underlying stock's fresh midpoint must still be at least
the signal price, within the chase bound, before entry.

These are configurable hypotheses. A low Choppiness Index indicates directional
movement, not necessarily a quiet/range-bound market. Volume is compared with the
stock's own baseline, not an absolute cross-stock definition of moderate volume.
The detector does not promise the first/last tick of a trend or eliminate false starts.

Minute summaries and recent observations are bounded in memory. Full delivered
ticks continue to be recorded independently. A quote/volume-delta pressure proxy is
included in signal metrics; it is **not a true footprint** and is not required for
entry, because the retail feed cannot establish every trade's aggressor side.

## Execution and exits

Sizing uses `DEPTH_TREND.capitalPerTrade` (initially INR 1,000), `CONSTANT.balance`
(shared total allocated notional), `maxPositions`, and `lot` (number of option lots).
No margin/leverage is assumed. One option lot that exceeds the allocated budget is
skipped rather than reduced below a valid lot. Increase the budget explicitly if
desired; a small default budget will skip many option contracts.

Instrument metadata is downloaded at startup from FYERS' public NSE_CM/NSE_FO symbol
masters for tick sizes and option lot sizes. Live entries require metadata loaded
for the current India date. Download/schema failure blocks new live entries while
recording continues; `strategy.metadataError` explains why. Restart daily to refresh.
The strategy does not infer cash tick sizes or live lot sizes from LTP.

Cash fills use current WebSocket depth. Calls are selected from the current option
chain: unexpired, nearest expiry, closest strike within 3% of underlying price,
positive OI and traded volume, and known contract metadata. OI is a liquidity filter,
not an assumed bullish/bearish signal. Chain results are cached for up to 3 minutes
per underlying. Option execution uses fresh REST depth, with a maximum 2% entry
spread. Both kinds require displayed depth for the whole proposed entry quantity.

Live orders are marketable **IOC limit orders**, with valid tick rounding and a
price bound based on displayed liquidity. Broker acceptance is not a fill. The
manager polls order status, handles rejection/cancellation/partial fills, and exits
only the strategy-owned quantity after checking the broker position. Existing
account positions in the same instrument prevent new entries.

Entry hours are 09:15–14:45 IST on weekdays, evaluated at decision time. Orders still
require fresh market data. Stops use `CONSTANT.sl` for cash and `optionSL` for calls.
Trailing exits default to 0.3% cash and 5% option, measured from the highest observed
depth-based exit estimate. Other exits: 5 seconds of selling imbalance or repeated
bid retreats with weakening price, strategy
daily estimated loss reaching `maxLoss`, and session exit from 15:10 IST.
Exit attempts use available depth in valid quantities, and partial remainders retry.

These are **application-managed exits**, not broker-hosted protective stops. They
require the process, fresh quotes, connectivity and successful broker execution.
IOC limits can remain unfilled; stopping the server does not square off positions.
Do not treat session-exit time as a guarantee of completed liquidation.

Paper fills assume immediate execution against observed depth and are marked
`assumed: true`; they are optimistic simulations, not broker results. Estimated
P&L deducts a configurable 0.1% per-side cost allowance, not an exact tax/brokerage
calculation. The daily loss limit covers this strategy's estimated P&L only.

## Persistence, diagnostics and recovery

`db/trend-orders/orders.jsonl` is an append-only, fsynced event/state journal for
both paper and live orders. It includes signals, skipped entries, intents, broker
IDs, fills, positions and estimated P&L. A process lock prevents two execution
managers using this directory. Never run independent copies with separate journals
against the same account and assume their limits coordinate.

Check `/health` -> `strategy` for flags, baseline progress, metrics, positions,
pending orders, available allocated capital, and faults. Recording failures disable
new entry signals; positions continue to be managed where data permits.

An interrupted/ambiguous submission is never automatically resubmitted. Known broker
IDs are reconciled after restart. Unidentified live intents, inconsistent quantities,
corrupt journals and persistence failures block new entries. A persisted fault must
be resolved by comparing broker orders/trades/positions with the journal before
operator repair; do not delete the journal to bypass reconciliation. Existing known
positions still receive exit management where it is safe to do so. Back up the
journal before any manual repair.

The broker wrapper serializes requests and budgets at most 150 requests/minute with
350 ms spacing; other applications on the same account are not included. A queued
order whose quote deadline expires is rejected locally. Read/API failures are
surfaced in health rather than inventing a successful order or fill.

## Verification

`npm test` runs offline detector, routing, journal, recorder and broker-response
simulations. It never imports the server or submits live orders.

`npm run replay:trend -- db/market-history/YYYY-MM-DD` prints entry candidates from
recorded messages without credentials or execution code. Session boundaries reset
warmup; malformed/out-of-order data stops replay. This utility is not a full fill
backtester and does not establish profitability. Evaluate later unseen sessions
and paper results before relying on the thresholds.

Official reference: [FYERS API documentation](https://myapi.fyers.in/docsv3).
