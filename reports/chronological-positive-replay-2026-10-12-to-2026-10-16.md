# Chronological Positive Filter Replay

## Method

- Rules were frozen from the 16 October calibration.
- Every signal uses only completed candle and depth information available before its timestamp.
- Future candles are used only to resolve the exit and calculate return.
- One signal per stock per session.
- Initial stop: 0.7%; breakeven after +0.5%; trailing begins after +1% at 0.4% below the high-water mark; maximum hold: 120 minutes.
- A **winner** means realized strategy return strictly above 1%. A positive return at or below 1% is labelled **below target**, not a monetary loss.

## Daily summary

| Date | Signals | Winners >1% | Below target | Return sum |
|---|---:|---:|---:|---:|
| 12 Oct | 5 | 0 | 5 | -2.80% |
| 13 Oct | 3 | 0 | 3 | -0.10% |
| 14 Oct | 6 | 0 | 6 | -1.29% |
| 15 Oct | 3 | 0 | 3 | +2.13% |
| 16 Oct | 11 | 11 | 0 | +15.18% |
| **All dates** | **28** | **11** | **17** | **+13.12%** |
| **Out-of-sample 12-15 Oct** | **17** | **0** | **17** | **-2.06%** |

Return sums assume equal notional allocation to every signal and exclude fees, taxes, spread and slippage.

## Signals

| Date | Time | Stock | Branch | Exit | Return | Classification |
|---|---:|---|---|---|---:|---|
| 12 Oct | 09:33 | INOXWIND | Opening impulse | Stop | -0.70% | Below target |
| 12 Oct | 10:01 | HAVELLS | Confirmed momentum | Breakeven stop | 0.00% | Below target |
| 12 Oct | 10:01 | OBEROIRLTY | Confirmed momentum | Stop | -0.70% | Below target |
| 12 Oct | 10:02 | HDFCLIFE | Confirmed momentum | Stop | -0.70% | Below target |
| 12 Oct | 10:02 | LICI | Confirmed momentum | Stop | -0.70% | Below target |
| 13 Oct | 09:47 | KAYNES | Confirmed momentum | Trail | +0.60% | Below target |
| 13 Oct | 09:56 | IRCTC | Confirmed momentum | Stop | -0.70% | Below target |
| 13 Oct | 10:01 | PPLPHARMA | Confirmed momentum | Time | 0.00% | Below target |
| 14 Oct | 09:23 | ABCAPITAL | Early reversal | Time | -0.43% | Below target |
| 14 Oct | 09:23 | DELHIVERY | Early reversal | Time | -0.11% | Below target |
| 14 Oct | 09:30 | BANDHANBNK | Opening impulse | Stop | -0.70% | Below target |
| 14 Oct | 09:47 | RVNL | Confirmed momentum | Breakeven stop | 0.00% | Below target |
| 14 Oct | 09:53 | ADANIENSOL | Confirmed momentum | Stop | -0.70% | Below target |
| 14 Oct | 09:54 | RECLTD | Confirmed momentum | Trail | +0.65% | Below target |
| 15 Oct | 09:45 | MUTHOOTFIN | Confirmed momentum | Trail | +0.66% | Below target |
| 15 Oct | 09:54 | BAJAJ-AUTO | Confirmed momentum | Time | +0.76% | Below target |
| 15 Oct | 10:08 | YESBANK | Confirmed momentum | Time | +0.71% | Below target |
| 16 Oct | 09:22 | TVSMOTOR | Early reversal | Trail | +1.30% | Winner |
| 16 Oct | 09:23 | M&M | Early reversal | Trail | +1.46% | Winner |
| 16 Oct | 09:23 | WIPRO | Leader pullback | Trail | +1.14% | Winner |
| 16 Oct | 09:28 | TECHM | Opening impulse | Trail | +1.70% | Winner |
| 16 Oct | 09:32 | GODREJPROP | Early reversal | Trail | +1.09% | Winner |
| 16 Oct | 09:37 | KPITTECH | Leader pullback | Trail | +2.63% | Winner |
| 16 Oct | 09:46 | JSWENERGY | Confirmed momentum | Trail | +1.28% | Winner |
| 16 Oct | 09:47 | ADANIENSOL | Confirmed momentum | Trail | +1.11% | Winner |
| 16 Oct | 10:00 | MFSL | Confirmed momentum | Trail | +1.05% | Winner |
| 16 Oct | 10:01 | ABB | Confirmed momentum | Trail | +1.40% | Winner |
| 16 Oct | 10:08 | SBILIFE | Confirmed momentum | Trail | +1.02% | Winner |

## Conclusion

The 16 October calibration result does not generalize to the four earlier dates. The frozen strategy's out-of-sample precision for returns above 1% is 0/17, and its equal-notional return sum is -2.06% before trading costs. It should remain experimental and should not be treated as a validated live trading strategy.
