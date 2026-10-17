# Research scope

Unless the user explicitly changes the scope, all current trading research in this
workspace must use only candle and market-depth data from these NSE sessions:

`2026-10-05`, `2026-10-06`, `2026-10-07`, `2026-10-08`, `2026-10-09`, `2026-10-12`,
`2026-10-13`, `2026-10-14`, `2026-10-15`, and `2026-10-16`.

## Research rules

- Timezone: Asia/Kolkata (IST).
- Candle interval: one minute.
- Use `db/candles/<SYMBOL>.jsonl` as the source for individual-stock candles.
- Use `db/candles/NIFTY50.jsonl` for NIFTY 50.
- Use `db/cash-depth/<YYYY-MM-DD>/` for cash market depth.
- Never use candles or depth received after a signal time to create that signal.
- Enter only on the next completed candle unless the user specifies otherwise.
- Report: trade count, win rate, average return, total return, maximum adverse excursion, and worst day.
- Save new research outputs under `reports/` or `csv/`; do not overwrite prior results.
- Reuse existing scripts where possible; create a new script only when needed.
- Keep responses concise: conclusion first, then only essential evidence.
