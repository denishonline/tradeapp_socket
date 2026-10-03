# Market history recording

Run `npm start`, open `http://127.0.0.1:3000`, and use the three dashboard controls:

1. **AutoLogin** obtains and stores the FYERS session.
2. **Fetch Pre Candles** fetches the preceding 30 calendar days of one-minute candles.
3. **Start Server / Stop Server** toggles Full SymbolUpdate, separate five-level
   DepthUpdate capture, the depth-trend strategy, and order management. Stop is
   refused while a live strategy order/position still requires management.

Starting the market stream also requests today's completed one-minute candles from
09:15 IST up to the start time. This fills gaps when the stream starts after the
market opens; it runs in the background while live WebSocket capture continues.
Only absent timestamps are added, so this request cannot replace stored candles.

Starting the HTTP dashboard does not start the broker stream. The dashboard visibly
reports `Market stream is stopped` until the third action is used. By default the
control server binds only to `127.0.0.1`; set `HOST` explicitly if remote access is
required and secure that deployment separately. Order routing uses
`flgPlaceCashOrder` and `flgPlaceOptionOrder` in `constant.js`.

The dashboard service can be started at any time. Outside weekdays **09:15 through
15:29 IST**, Start Server leaves the dashboard service running but marks live market
depth and candle capture as unavailable due to invalid market time; it does not open
the FYERS market WebSocket. Start it during market hours to capture live data.
Historical candle downloads remain available outside that window.

The two subscription types share one active channel because SDK 1.3.4 pauses
other channels when switching channels during subscription.

## Files and format

Completed live one-minute candles are stored separately in
`db/candles/<SYMBOL>.jsonl`. REST pre-candles only fill missing timestamps: an
existing valid candle is never overwritten or removed by a history fetch. Storage
is canonicalized by timestamp so duplicate lines cannot accumulate. The dashboard
reads the most recent 360 candles and overlays the current incomplete minute in real
time.

Only weekday candles in the NSE interval **09:15:00 through 15:29:59 IST** are
accepted; the 15:30 timestamp is outside the final one-minute interval. Startup
backfill excludes the currently forming minute. OHLC prices,
integer non-negative volume, exact minute alignment, symbol, and exchange source
time are validated. A WebSocket candle requires cumulative traded volume to increase.
The first partial minute after start/reconnect, missing minutes, unchanged-quantity
quotes, stale/out-of-order ticks, and unfinished candles on Stop Server are never
written. No flat or synthetic gap candles are generated.

Default location: `db/market-history/YYYY-MM-DD/<session UUID>-<part>.jsonl`.
Override with `MARKET_HISTORY_DIR` in your environment. Relative paths are resolved
against the project root. Keep any custom output location outside source control
and outside the public web directory.

Each line is one JSON object containing:

- `schemaVersion`: currently 1.
- `sessionId`: unique per server process.
- `sequence`: increasing local receipt order within that session.
- `receivedAt`: UTC time when this process received the SDK message.
- `receivedMonotonicNs`: monotonic local timestamp for ordering/elapsed-time analysis.
- `kind`: `depth`, `price`, `recorder_start`, `session_start`, `feed_status`, or `session_end`.
- `data`: original SDK market payload, or lifecycle metadata. Credentials are not recorded.

Depth payloads retain `symbol`, `type`, and whatever `bid_price1..5`, `ask_price1..5`,
`bid_size1..5`, `ask_size1..5`, `bid_order1..5`, `ask_order1..5` fields the SDK supplied.
Price payloads retain LTP, volume, day statistics and source timestamps when supplied.
Valid partial depth updates are preserved as sent, but updates that repeat the current
values of all supplied depth fields are skipped. Depth capture is limited to weekdays
from 09:15:00 through 15:14:59.999 IST. Do not assume a partial depth payload is a
complete snapshot or fill missing levels with zeros. Do not carry book state across
disconnects without a fresh snapshot.
Source timestamps are preserved inside `data`; depth receipt time is not represented
as an exchange timestamp when none was supplied. This is SDK-delivered history,
not a guarantee of every exchange event or a full exchange order book.

Files rotate at India midnight and approximately 64 MiB, without deleting older
files. A single record stays intact even if larger than the size threshold. Writes
are batched every 250 ms with a 16 MiB pending buffer. Shutdown via SIGINT/SIGTERM
drains pending writes (15-second deadline). Forced termination/power loss can lose
recent records or leave an incomplete final line; no per-record fsync is performed.
Disk usage must be monitored and old files archived as needed; retention is unlimited.

## Verify capture

Visit `http://localhost:3000/health` (or your configured port).

- `recording.writtenRecords` should grow while updates arrive.
- `recording.state` reports writer health, not broker connectivity.
- `feed.received.price` and `feed.received.depth` count each stream separately.
- `feed.optionDepth.received` counts option depth updates; `feed.optionDepth.selectedSymbols`
  reports the currently selected contracts. `depthHistory.writtenRecords` and `symbols`
  show file-writer progress and how many stock/contract files were opened.
- `feed.lastReceived` gives per-stock receipt times; compare these with the current
  time and market activity, especially after reconnects. Counts are cumulative for
  the process and do not prove a subscription is currently delivering data.
- `feed.state` reports connection/subscription status. The SDK accepting subscription
  calls alone does not prove depth is arriving; verify depth counters and timestamps.

A disk error or buffer overflow stops recording, logs an error, and returns HTTP
503 from `/health`. The live dashboard can continue updating, but history is incomplete.
`acceptedRecords - writtenRecords` includes records not confirmed written; a failed
append may have written partially. Fix storage and restart to begin a new session.
The recorder does not retry ambiguous writes or claim to backfill disconnected periods.
HTTP 200 here indicates the server/writer are functioning, not that markets are open
or that either broker stream is fresh.

## Research scope

The WebSocket feed also selects option contracts for every configured stock that has
listed options. It uses
the nearest unexpired expiry, the listed strike closest to the stock's live price, and
one listed strike on either side. Both CE and PE are subscribed at each strike (up to
six contracts per stock). When the underlying moves to a different ATM strike, the
feed subscribes the new set and unsubscribes the old set; older contract files remain.
Selection is based on the instrument master loaded when Start Server is clicked.

Stock and option depth are stored together under `db/option-depth/<STOCK>/`. For
example, `db/option-depth/TCS/TCS.json` contains the underlying stock depth and
`db/option-depth/TCS/TCS26OCT2060CE.json` contains that option contract's depth. Each
file is a valid JSON object with `schemaVersion`, `stock`, `symbol`, and a `history`
array. Every array entry contains the local `receivedAt` time and the original SDK
depth payload. Valid partial updates are preserved; missing book levels are not filled
in, and repeated no-change updates are skipped. Depth capture uses receipt time in India and accepts weekdays from
09:15:00 inclusive to 15:15:00 exclusive. A depth payload must identify a configured
stock or currently selected option and include at least one valid bid/ask depth field;
negative, non-finite, and fractional quantity/order values are rejected. Duplicate
state is reset after reconnects and at the start of a new India date. These files are
git-ignored. The depth writer batches updates every 250 ms and flushes when the market
stream is stopped or the process shuts down. Forced termination can leave the last
file update incomplete. Depth changes alone cannot distinguish trades from
cancellations.

The strategy may additionally record option-chain/OI responses on candidate entries
and REST option-depth responses for selection and open positions in the general market
history stream. These remain separate from the tick-by-tick option WebSocket files.

For the proposed 100-minute baseline strategy, collect price/volume alongside depth,
then replay chronologically. Measure baseline direction, volatility, spread and depth;
test persistent changes in bid/ask pressure against actual price progress. Keep
connection gaps out of valid windows. Compare with a price/volume-only baseline on
unseen days, including bid/ask fills, available quantities, costs, latency and unfilled
orders. The initial strategy thresholds are research defaults, not established
profitable entry/exit thresholds. Read-only entry-candidate replay is available with
`npm run replay:trend -- db/market-history/YYYY-MM-DD`.

Run `npm test` for offline recording and feed integration tests. Tests use fake
broker messages and temporary storage; they do not authenticate or place trades.
