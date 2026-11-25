# DipBounce — Second-Leg Pump Trader

[![make.fun](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
[![rank](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/Kroco365/pumpfun-sharpe-sprint/rank.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
[![reward](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/Kroco365/pumpfun-sharpe-sprint/reward.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)

Entry for [Pump.fun Sharpe Sprint — Cleanest Paper Bot Wins](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532): a paper-trading bot for a 6-hour pump.fun replay, ranked by hourly Sharpe ratio.

## Strategy

Most fresh pump.fun coins pump in their first few slots and then bleed back to near their create price. Chasing the first pump is buying the top: the 2-slot fill latency plus the 1%-of-real-reserve size cap mean an entry decided at +5% fills near +35%. DipBounce does not chase it. It waits for the pump-and-dip cycle to finish and buys the recovery instead:

- **Entry (one per coin, 0.02 SOL, max 5 open):** the coin falls 15% off its running peak since creation, then climbs 5% off that dip low with fresh buying (at least 2 of its last 3 trades buys), inside the first ~12 minutes after creation, with enough real SOL reserve that the size cap allows a full 0.01+ SOL round trip.
- **Exit (whichever comes first):** +40% take-profit, −12% stop-loss (both measured from the filled buy price, in exact BigInt reserve ratios), an immediate exit if the creator sells, or a flatten after 1,200 slots (~8 minutes).

Every round trip closes fast and no single coin can dominate the result: many small, diversified, quick round trips with tight exits — the steady, low-variance shape a Sharpe ranking rewards, not a moonshot sniper.

## Running

`main.ts` runs on Node 22 as-is (`node main.ts`), no dependencies outside the repo. The harness protocol shim is vendored at `vendor/makefun-bot.ts` (a byte-identical copy of the kit SDK). All math is exact BigInt on lamports and reserve ratios; the bot reads no clock, no randomness, no network, and no files, so its two grading executions produce byte-identical action logs.

## Dev-window numbers

Measured on the kit's 24-hour dev window (1,222 coins) before submission; the figures below are the local grader's, not a forecast for the 6-hour final window.

- Net PnL: **−0.156 SOL** (−1.56% on 10 SOL paper capital) — below holding cash, so this entry is **not prize-eligible** on the dev window; it is ranked by Sharpe only.
- Hourly Sharpe: **−0.453** (Sortino −0.463)
- Round trips: **247** over **247 distinct mints** (guardrail: ≥ 20), 494 fills, 0 rejected, 8 failed txs
- Win rate: **23.5%**; max drawdown: **1.75%** (guardrail: ≤ 50%)
- Fees: 0.122 SOL curve + 0.053 SOL tx — the strategy is roughly breakeven on price before fees; fees are the whole net loss.
- Stress (20 rebuilt copies of the dev window): median **−0.271 SOL**, p10 −0.339, p90 −0.169; **all 20 copies lost money**, and the dev score (−0.156) sits above 90% of them (dev rank 18/20). Honest read: the dev window was a favorable draw — the typical rebuilt window loses about −0.27 SOL, and no copy came out positive. The entry is a ranking shot on Sharpe, not a positive-expectation trade.
- Concentration: the top 3 coins made 13.8% of the gains; without them net PnL would be −0.195 SOL — the result does not lean on a few lucky coins.

## Tuning notes

The entry filter was chosen by sweeping the dev data, then confirmed with the real local grader (not just the offline sweep, whose Sharpe runs optimistic):

- Chasing the first pump loses: an entry decided at +5% fills near +35% after the 2-slot latency, and the coin then retraces. The dip-recovery entry was worth ~+0.4 SOL vs the early-momentum shape.
- Requiring buy SOL ≥ 3× sell SOL over the last 10 trades (real demand, not a bounce) cut losing trades by a third: net −0.262 → −0.156 SOL, win rate 20.5% → 23.5%.
- A deeper dip (20%) and stronger dominance (4×) were both tried and reverted: the real grader scored them worse than 15% / 3×, so the shipped values are 15% dip, 5% recovery, 3× dominance, +40% take-profit, −12% stop-loss.
