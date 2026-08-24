# Phase 0 — find out whether an edge exists

**Cost: nothing. Risk: nothing. Sends nothing, signs nothing, needs no key.**

Phase 0 exists because of an uncomfortable fact: most flash-loan arb bots lose
money not to bugs but to the absence of an edge. Before optimising latency,
renting a server, or deploying a contract, answer the cheap question first.

> On this chain, at these sizes, does any cross-venue spread survive the
> flash-loan fee and gas?

Latency is irrelevant when you are not executing, which is why a phone on mobile
data is perfectly adequate for this phase.

## Run it

```bash
cd agent
npm install
npm run verify:addresses     # confirm every address still has code
npm run observe              # or: bash ../scripts/termux-observe.sh
```

No `.env` is required — it defaults to the public Base RPC. Optional:

```
RPC_URL=                 # your own read RPC (strongly recommended)
SIZES_ETH=0.1,1,5,20     # flash-loan sizes to test
SCAN_INTERVAL_MS=10000
RPC_CONCURRENCY=2        # raise only with a real RPC
CSV_PATH=./data/observations.csv
TELEGRAM_BOT_TOKEN=      # optional digest
TELEGRAM_CHAT_ID=
REPORT_EVERY_MS=21600000 # 6h
```

`RPC_URL` must be a normal read RPC. The ZeroDev project RPC will **not** work
here — it only serves ERC-4337 bundler and paymaster methods
(`eth_sendUserOperation`, `eth_estimateUserOperationGas`, `pm_*`, `zd_*`). It has
no `eth_call`, so it cannot quote a pool. Keep the two endpoints separate.

## Why the RPC matters more than you would expect

Measured while building this: firing all quotes in parallel at the public Base
RPC made **55–67% of them fail** with `RPC Request failed`. The first version of
the scanner caught every error and returned `null`, which the caller read as
"no pool".

That is the worst possible bug here. It does not crash — it quietly produces
"there is no edge" from data that was never collected.

So quotes are now classified:

| Outcome | Meaning |
|---|---|
| revert | the pool genuinely cannot serve this trade |
| transport failure | **we failed to measure** — retried, then counted |

The console prints `rpcErr=N/M` every tick and shouts when the failure rate is
above 25%. The Telegram digest carries the same number. If that figure is high,
your run is not evidence of anything.

## What gets recorded

Every candidate, every tick, to CSV:

```
ts, block, base, quote, size, buyVenue, sellVenue,
grossBps, grossWei, flashFeeWei, netBeforeGasWei,
gasEstimate, gasCostWei, netAfterGasWei, wouldFire
```

Both legs of every round trip are quoted **pinned to the same block number**.
Leg 2 consumes leg 1's output so the two cannot share a multicall, but pinning
the block prices both against identical state. Quoting leg 1 at block N and
leg 2 at block N+1 manufactures profit that does not exist — the single most
common way a backtest lies.

## Reading the result

```bash
# how many candidates ever cleared gas?
awk -F, 'NR>1 && $15==1' data/observations.csv | wc -l

# best net-after-gas seen (wei)
awk -F, 'NR>1 {print $14}' data/observations.csv | sort -n | tail -1

# which venue pairs dominate the positives
awk -F, 'NR>1 && $15==1 {print $6"->"$7}' data/observations.csv | sort | uniq -c | sort -rn
```

**If `wouldFire` is 0 across the whole window** — and your RPC failure rate was
low — there is no edge for you at these sizes on these venues. That is a real
answer, not a failure. Options: different pairs (long-tail, newly listed), a
different strategy (liquidations have a far longer window and tolerate latency
much better), or stop. Do not rent a server to race for something that is not
there.

**If some cleared gas** — note *which* pairs, *what* size, *what* time of day.
Then decide whether a server with a fast RPC is worth it, backed by your own
data rather than hope.

## Baseline measured on Base, 2026-08-24

Round trips within Uniswap V3 fee tiers, 1 WETH:

| Round trip | Result |
|---|---|
| 100 → 500 | −12.86 bps |
| 500 → 100 | −19.32 bps |
| 100 → 3000 | −49.32 bps |
| 3000 → 500 | −31.53 bps |

All negative. Fee-tier differences are not inefficiencies, they are costs.

Cross-venue was tighter: 1 WETH quoted **2519.31 USDC** on UniV3-500 versus
**2515.17** on Aerodrome — roughly 16 bps nominal, which a two-leg round trip
largely consumes in fees. Marginal, not free money.

The Aerodrome *stable* pool quoted 1973 USDC for 1 WETH — the wrong curve for a
volatile pair. It shows up in the CSV at around −2290 bps, which is exactly the
point: the scanner measures real round trips, so a bad curve reads as a bad
trade rather than a fake opportunity.

Fees read on-chain the same day: **Aave v3 = 5 bps, Balancer = 0**. Prefer
Balancer on Base, and read both at runtime rather than hardcoding.

Gas for a 450k-gas transaction was about **0.0000032 ETH (~$0.008)**. Gas is not
the binding constraint on Base — latency and competition are.

## Then what

Phase 1 is only worth starting if Phase 0 says there is something to catch.
`contracts/FlashExecutor.sol` is already built and tested for it, and its
`Provider` + `Call[]` shape works for liquidations as readily as for swaps —
only the calldata changes.
