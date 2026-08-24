# Architecture

```
                    ┌──────────────────┐
                    │  Scanner (det.)  │  multicall, one block, no LLM
                    └────────┬─────────┘
                             │ Opportunity { plan, expectedProfit }
                    ┌────────▼─────────┐
                    │  Preflight sim   │  estimateGas -- filters dead attempts
                    └────────┬─────────┘
                    ┌────────▼─────────┐
                    │  Risk guards     │  profit floor, gas share, cap, kill switch
                    └────────┬─────────┘
                             │
              ┌──────────────┴──────────────┐
              ▼                             ▼
      EXEC_MODE=direct              EXEC_MODE=sponsored
      raw EOA tx                    ZeroDev UserOp (7702)
      no bundler                    + paymaster & fallback
              └──────────────┬──────────────┘
                             ▼
                  ┌─────────────────────┐
                  │   FlashExecutor     │
                  │  snapshot balance   │
                  │  borrow             │  Aave v3 | Balancer v2
                  │  run allowlisted    │
                  │    calls            │
                  │  ASSERT minProfit   │  <-- reverts here if short
                  │  repay              │
                  └─────────────────────┘
                             ▼
                    profit stays in executor
                    admin sweeps via withdraw()
```

## Why the profit check is on-chain

Off-chain simulation runs against block N. The transaction lands at block N+1 or
later. In between: pools move, another searcher lands first, a large swap shifts
the curve. An off-chain-only check means a "profitable" trade can execute at a
loss.

`_assertProfit` measures the real balance delta inside the same transaction:

```
have = balanceOf(asset)
need = snapshotBeforeBorrow + owed + minProfit
if (have < need) revert
```

`snapshot` is captured before the borrow, so the borrowed principal is excluded
from what counts as profit. If the trade came in short, the transaction reverts
and the only loss is gas.

## Why callbacks are bound to a plan hash

`executeOperation` and `receiveFlashLoan` are `external`. Anyone can call the
selector. Three checks close that:

1. `msg.sender` must be the pool/vault.
2. Aave's `initiator` must be this contract.
3. `keccak256(params)` must equal the plan hash `run()` recorded.

Check 3 matters even if the pool itself misbehaves: a plan we never started
cannot be injected, and a stale plan cannot be replayed.

## Why routers are allowlisted

`Call.target` is arbitrary calldata. Without an allowlist, whoever holds
`OPERATOR_ROLE` could encode `USDC.transfer(attacker, balance)`. The allowlist
holds **routers only** — never token contracts — so the worst a compromised
operator can do is route swaps and waste gas.

Approvals are set immediately before the calls and reset to `0` immediately
after, in the same transaction. No standing allowances survive a run, which is
covered by `test_noStandingAllowanceAfterRun`.

## Provider abstraction

`Provider` selects Aave v3 or Balancer v2. The repayment mechanics differ and
both are implemented:

| Provider | Fee | Repayment |
|---|---|---|
| Aave v3 | `FLASHLOAN_PREMIUM_TOTAL` bps, read on-chain | pool pulls via allowance |
| Balancer v2 | historically 0 | recipient must push a transfer |

Arb margins are thin enough that the fee difference frequently decides whether a
trade is worth attempting. Read the Aave premium on-chain; do not hardcode it.

## Where an LLM belongs

Not in the execution path. The scanner runs every couple of seconds and must be
deterministic and fast.

Useful offline: reviewing which pairs are worth watching, tuning thresholds,
explaining a run of reverts, drafting new venue adapters, alerting on anomalies.
