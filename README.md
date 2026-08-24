# agentflash-loan

Atomic flash-loan agent: an on-chain executor that cannot lose money, driven by
an off-chain scanner that decides when to try.

Built on Aave v3 / Balancer v2 flash loans, OpenZeppelin safety primitives, and
ZeroDev EIP-7702 smart accounts.

> **Status:** scaffold. Contracts are tested against mocks; the scanner is a
> stub. `DRY_RUN` defaults to `true` and nothing broadcasts until you turn it off.

---

## The one idea

> Off-chain decides **when to try**. The contract **guarantees we do not lose**.

A simulation at block N tells you nothing about block N+1. State moves, and
someone may land ahead of you. So profit is enforced **on-chain**: if the
realised balance delta comes in below `minProfit`, the whole transaction
reverts and you pay gas only.

Every off-chain check exists to avoid *wasting gas*, not to protect the money.
The contract protects the money.

## Layout

```
contracts/          Foundry
  src/FlashExecutor.sol       borrow -> strategy -> profit check -> repay
  src/interfaces/             Aave v3 + Balancer v2, swappable providers
  test/                       14 tests, guard-focused
  script/Deploy.s.sol         enforces admin != guardian

agent/              TypeScript
  src/scanner/                deterministic opportunity search (no LLM)
  src/sim/preflight.ts        estimateGas before spending gas
  src/risk/guards.ts          profit floor, gas share, loan cap, kill switch
  src/exec/direct.ts          HOT path  -- raw EOA tx, no bundler
  src/exec/sponsored.ts       COLD path -- ZeroDev UserOp + sponsorship
  src/zerodev/kernel7702.ts   EIP-7702 Kernel v3.3 + paymaster fallback
```

## Two execution routes, one address

EIP-7702 attaches Kernel code to the operator EOA, so the smart account **is**
the EOA. Same address, no CREATE2, no counterfactual deploy. That means you can
pick a route per operation without migrating funds:

| Operation | Route | Why |
|---|---|---|
| Fire an arb | `direct` -- raw EOA tx | No bundler hop. Not sitting in a public alt-mempool. |
| Sweep profit, pause, reconfigure | `sponsored` -- UserOp | Latency is irrelevant; gas sponsorship and session keys pay off here. |

Flip `EXEC_MODE` to compare them on real opportunities. `ZERODEV_ULTRA_RELAY=true`
enables ZeroDev's combined bundler+paymaster (~30% less gas, ~20% lower latency,
Base supported) if you want sponsorship in the hot path too.

Two costs to weigh before doing that: the sponsorship premium applies to
**every attempt including reverts**, and a UserOp is visible in the bundler's
alt-mempool before it lands.

## Trust model

| Role | Can | Cannot |
|---|---|---|
| `OPERATOR_ROLE` | call `run()` | withdraw, reconfigure, add routers |
| `GUARDIAN_ROLE` | `pause()` | move funds |
| `DEFAULT_ADMIN_ROLE` | config, withdraw, unpause | — |

The operator is the agent's hot key. A leaked operator key can waste gas. It
cannot drain the contract. Keep admin on a cold key or multisig, and guardian on
a third key you can reach from your phone.

Arbitrary calls are restricted to an allowlist of **routers only** — never token
addresses — so a compromised operator cannot encode a plain ERC-20 transfer out.

## Quick start

```bash
# contracts
cd contracts
forge install foundry-rs/forge-std
forge install OpenZeppelin/openzeppelin-contracts@v5.1.0
forge test -vv

# agent
cd ../agent
npm install
cp ../.env.example ../.env      # then fill it in
npm run typecheck
npm start                        # DRY_RUN=true by default
```

## Before you go live

- [ ] Replace the `DexArbScanner` stub with real multicall quoting (all legs priced at the same block)
- [ ] Fork-test against real pools, not just the mocks
- [ ] `setMaxLoan` per asset, `setTarget` per router
- [ ] Grant `OPERATOR_ROLE` to the hot key; keep admin separate
- [ ] Read `FLASHLOAN_PREMIUM_TOTAL` on-chain rather than assuming 5 bps
- [ ] Confirm what counts as a ZeroDev credit before letting the scanner poll their RPC
- [ ] Run with `DRY_RUN=true` for a while and read the skip reasons
- [ ] Set `DRY_RUN=false` last

See [docs/SECURITY.md](docs/SECURITY.md) and [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Honest expectations

Flash loans do not create profit. Opportunity, liquidity, fees, slippage, gas,
and MEV competition decide whether a trade nets anything. Naive two-venue arb on
a major chain with public mempool submission is heavily farmed by professional
searchers. The realistic edges are private orderflow, less contested niches, or
liquidations — not being faster at the same thing everyone else does.

What this repo gives you is the part that is fully in your control: an executor
that will not lose money on a bad fill.

## License

MIT
