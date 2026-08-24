import { createPublicClient, http } from "viem";
import { base } from "viem/chains";
import { config } from "./config.js";
import { observe, describe, PAIR_WETH_USDC } from "./scanner/dexArb.js";
import { screen } from "./risk/guards.js";
import { operatorAddress } from "./exec/direct.js";

/**
 * PHASE 1 -- LIVE EXECUTION. NOT READY.
 *
 * Everything needed to *decide* is here. What is deliberately missing is the
 * plan builder: turning an Observation into the exact approvals + swap calldata
 * for FlashExecutor.run().
 *
 * That is left unwritten on purpose. It is the one piece that moves real money
 * through untested calldata, and it must be fork-tested against live Uniswap /
 * Aerodrome pools before it exists -- not written from memory and hoped over.
 *
 * Run `npm run observe` (Phase 0) first. If the CSV shows nothing ever clears
 * gas, this file should never be finished.
 */

function buildPlan(): never {
  throw new Error(
    "Plan builder not implemented.\n" +
      "Phase 1 needs fork-tested swap calldata for each venue before it can send " +
      "a transaction. Run `npm run observe` and read docs/PHASE0.md first.",
  );
}

async function main() {
  const client = createPublicClient({ chain: base, transport: http(config.rpcUrl) });
  const operator = operatorAddress();

  console.log("agentflash-loan — PHASE 1 (live)");
  console.log(`  operator  : ${operator}`);
  console.log(`  executor  : ${config.executor}`);
  console.log(`  exec mode : ${config.execMode}`);
  console.log(`  dry run   : ${config.dryRun}`);

  const fees = await client.estimateFeesPerGas();
  const maxFeePerGas = fees.maxFeePerGas ?? 0n;

  const scan = await observe(client, {
    ...PAIR_WETH_USDC,
    sizes: [10n ** 18n],
    flashFeeBps: 0,
  });
  console.log(`  quotes    : ${scan.quotesAttempted} (rpc errors: ${scan.rpcErrors})`);

  for (const o of scan.observations.slice(0, 3)) {
    const verdict = screen({
      plan: { provider: 1, asset: o.base, amount: o.amountIn, minProfit: 1n, approvals: [], calls: [] },
      expectedProfitWei: o.netBeforeGasWei > 0n ? o.netBeforeGasWei : 0n,
      gasEstimate: 450_000n,
      maxFeePerGas,
      consecutiveFailures: 0,
    });
    console.log(`${verdict.ok ? "[would try]" : "[skip]"} ${describe(o)}` + (verdict.ok ? "" : ` — ${verdict.reason}`));
    if (verdict.ok) buildPlan();
  }
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
