# Survivor Breakout — Pump.fun Paper Sprint

[![make.fun](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![rank](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/BrianChen33/pump-fun-paper-sprint-boothlord/rank.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![reward](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/BrianChen33/pump-fun-paper-sprint-boothlord/reward.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)

A paper-trading bot for the [Pump.fun Paper Sprint: Any Bot Can Win](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b) on make.fun. Places are ranked by **net PnL** on a fresh 6-hour pump.fun replay, winner takes all, so this bot is built to catch the few real runners — not to grind small wins on every launch.

## Idea

Most new pump.fun coins die within minutes, and a round trip costs ~3% of the stake in curve + transaction fees. Early momentum-chasing loses on this tape (the kit's pilot momentum bot nets −9.45 SOL on the 24 h dev window). The only trades worth sizing up are the ones where the tape has already proved sustained demand, so the bot waits instead of sniping the launch:

1. **Watch** every coin from its `CreateEvent` for 90–240 seconds.
2. **Confirm** before buying: price still at least +50% above creation (a survivor of the first shakeout, not a coin that already topped), net SOL inflow positive over the last two ~15 s windows, at least 5 distinct non-creator buyers, no substantive unabsorbed creator sell, and real SOL reserves of at least 12 SOL (so a 0.15 SOL position is at most ~1% of reserves and can be sold without moving the curve).
3. **Trade with two tiers**: standard trades are 0.15 SOL, one full exit per trade — take-profit +43%, stop-loss −13% against the fill price (widened from the simulator's +40%/−10% because fills land ~3% above decision price on 2-slot latency), 10-minute max hold, plus exits on stale trading. Buy slippage is capped at 200 bps so bad fills are rejected and retried while the entry window is still open.

## The mint-floor problem, and the filler tier

The guardrail needs round trips of ≥ 0.01 SOL on at least 20 distinct mints in a 6-hour window, but the strict filter only converts ~11 coins per 24 h on the dev window. So the bot has a second tier: when the completed-round-trip pace lags the 20-mint target (30 per 6 h, measured in slots), it tops up with minimum-size 0.015 SOL trades on looser filters (≥ 5 buyers, ≥ 6 SOL reserves, positive recent flow, ≥ +10% run-up), with the same exit discipline. Each filler is a real trade; it exists only to keep the bot above the guardrail while the strict tier does the earning. Fillers cost ~0.001 SOL each on average, far less than the strict tier earns.

## What the data showed

Dev-window forensics (kit `grade-local`, process driver, 24 h frozen window): buys at 0.10–0.15 SOL won 55% (avg +0.022 SOL each), while reserve-capped 0.05 SOL buys on thin-reserve mints won only 22% — a +50% run-up on a tiny reserve means small money moved the price a lot, and those mints dump hardest. That split is why the standard tier requires ≥ 12 SOL of real reserves and the filler tier stays tiny.

## Dev-window results (kit `grade-local`, process driver, 24 h)

Net PnL **+0.146 SOL**, 89 round trips over 89 distinct mints, win rate 25.8%, max drawdown 1.19%, guardrails met; the two executions reproduced byte for byte. At 2× fees the same run still nets +0.058 SOL. Honest caveats: the edge is thin and concentrated — the 11 strict-tier trades earned +0.244 SOL while the 78 filler trades cost −0.098 SOL — and the per-6-hour chunks of the dev window were mixed (+0.26/−0.04/+0.13/−0.04 in the simulator), so a weak final window could still end flat or slightly negative. This entry is a disciplined survivor bet, not a favourite.

## Layout

- `main.ts` — entrypoint, run by the grader as `node /bot/main.ts`.
- `vendor/makefun-bot.ts` — the kit's protocol shim, copied unchanged.

## Run it

```sh
node main.ts
```

(The grader runs it against the pumpfun-replay/v2 harness; it reads batches on stdin and writes one reply per batch on stdout. It takes no arguments, reads no clock, no randomness, and no network.)

## License

MIT — see [LICENSE](LICENSE).
