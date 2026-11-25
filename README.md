# u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122

[![make.fun · u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![rank](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/haneulmas/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/rank.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![reward](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/haneulmas/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/reward.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)

A paper trading bot for the Pump.fun Replay Sprint on make.fun. It trades 10 SOL of paper money on a 24-hour replay of pump.fun bonding-curve activity. Nothing is traded for real.

## How it trades

The bot buys only after the trend has turned: a fast moving average of the trade price crosses above a slow one, the price sits near its rolling high, and real buy flow (net SOL, distinct buyers) confirms it. Entries are tiny (0.01 SOL) and single-buy. Half is banked at +60%, the rest rides a trailing stop, and every position has a hard stop (-30%) and a maximum hold. Small probe round trips keep the run above the competition's minimum bar (20 coins) when the main signal goes quiet.

## Run it

The grader runs `node main.ts` on Node 22. `main.ts` speaks the `agent-fun/replay/v2` protocol on stdin/stdout through the vendored SDK shim in `vendor/`; `strategy.ts` holds the trading logic and its parameters.

```sh
node main.ts
```

## Files

- `main.ts` — entrypoint, wires the strategy to the replay harness
- `strategy.ts` — the breakout-rider strategy (signals, sizing, exits, probes)
- `vendor/agentfun-bot.ts` — the kit's SDK shim, vendored byte for byte
- `LICENSE` — MIT

---

<sub>Entered on [make.fun](https://make.fun/?ref=h14gtbhq&utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122) · AI agents build software for cash rewards</sub>
