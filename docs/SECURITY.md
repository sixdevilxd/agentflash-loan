# Security notes

## Implemented

| Control | Where | Test |
|---|---|---|
| On-chain profit floor | `_assertProfit` | `test_revertsWhenProfitBelowMinProfit`, `test_revertsWhenOpportunityVanishesMidFlight` |
| Callback caller check | `msg.sender == pool` | `test_directCallbackCallIsRejected` |
| Callback initiator check | `initiator == address(this)` | — |
| Plan-hash binding | `_claim` | `test_poolCannotReplayForeignPlan` |
| Router allowlist | `allowedTarget` | `test_unlistedRouterIsRejected` |
| Per-asset loan cap | `maxLoan` | `test_loanAboveCapIsRejected`, `test_unlistedAssetIsRejected` |
| Role separation | `AccessControl` | `test_operatorCannotWithdraw`, `test_outsiderCannotRun` |
| Emergency pause | `Pausable` + guardian | `test_guardianPauseStopsExecution` |
| Reentrancy guard | `nonReentrant` on `run` | — |
| Approval hygiene | reset to 0 post-call | `test_noStandingAllowanceAfterRun` |
| Off-chain kill switch | `guards.ts` | — |
| Dry-run default | `config.dryRun` | — |
| Paymaster fallback | `kernel7702.ts` | — |

`nonReentrant` sits on `run()` only, never on the callbacks — the flash-loan
callback is a legitimate reentry into this contract during `run()`, so guarding
both would deadlock. The callbacks are protected by the plan-hash binding instead.

## Key handling

Three separate keys. Do not collapse them.

- **Operator** — hot, lives on the box running the agent. `OPERATOR_ROLE` only.
  Assume it will leak eventually and size the damage accordingly: it can waste
  gas, nothing more. Keep minimal native balance on it.
- **Guardian** — can only `pause()`. Keep it somewhere reachable in a hurry.
- **Admin** — config and withdraw. Cold key or multisig. Never on the agent box.

`Deploy.s.sol` refuses to deploy when admin and guardian are the same address.

## Cost realities

**Reverted attempts still cost gas.** Arb hit rates are low; most attempts lose
the race or the edge evaporates. Gas on failures is the dominant operating cost,
which is why `guards.ts` filters aggressively before broadcasting.

**Sponsorship has a premium and a ceiling.** ZeroDev charges a premium on
sponsored gas and caps monthly sponsorship by plan. The premium applies to
reverts too. When the cap is reached ZeroDev fails the UserOp, so
`ZERODEV_PAYMASTER_FALLBACK=true` returns an empty paymaster payload on error and
lets the account self-fund rather than halting.

**Credits are consumed by RPC usage.** Keep the scanner on a separate `RPC_URL`;
a bot polling every two seconds through a metered endpoint burns allowance fast.

## Not done yet

- [ ] CI workflow (needs the `workflow` token scope — see PR description)
- [ ] Fork tests against real Aave/Balancer/Uniswap deployments
- [ ] Slither / Aderyn clean run
- [ ] Transient storage (`tstore`) for `_activePlan` and `_snapshot` to cut gas
- [ ] Multi-asset flash loans (Balancer supports several in one call)
- [ ] Private orderflow submission
- [ ] Per-day loss cap, not just consecutive-failure count
- [ ] Independent audit before meaningful size

## Reporting

Private repo for now. Once public, do not open a public issue for a live
vulnerability — contact the owner directly.
