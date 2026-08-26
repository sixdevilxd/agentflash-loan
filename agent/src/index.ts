import { createPublicClient, http } from "viem";
import { base } from "viem/chains";
import { config, requireTradingConfig } from "./config.js";
import { observe, describe } from "./scanner/dexArb.js";
import { screen } from "./risk/guards.js";
import { operatorAddress } from "./exec/direct.js";
import { BASE } from "./chain/addresses.js";
import { buildArbPlan } from "./plan/build.js";
import { Provider } from "./abi/flashExecutor.js";
import { preflight } from "./sim/preflight.js";
import { execute } from "./exec/index.js";

async function main() {
  requireTradingConfig();

  const client = createPublicClient({
    chain: base,
    transport: http(config.rpcUrl),
  });

  const operator = operatorAddress();

  console.log("agentflash-loan — PHASE 1");
  console.log(`  operator  : ${operator}`);
  console.log(`  executor  : ${config.executor}`);
  console.log(`  exec mode : ${config.execMode}`);
  console.log(`  dry run   : ${config.dryRun}`);

  const fees = await client.estimateFeesPerGas();
  const maxFeePerGas = fees.maxFeePerGas ?? 0n;
  const maxPriorityFeePerGas = fees.maxPriorityFeePerGas ?? 0n;

  // USDC -> WETH -> USDC
  const scan = await observe(client, {
    base: BASE.tokens.USDC,
    quote: BASE.tokens.WETH,
    sizes: [10_000_000_000n], // 10,000 USDC
    flashFeeBps: 5,
  });

  console.log(
    `  quotes    : ${scan.quotesAttempted} (rpc errors: ${scan.rpcErrors})`,
  );

  for (const o of scan.observations.slice(0, 3)) {
    console.log(`\n[OPPORTUNITY] ${describe(o)}`);

    const plan = buildArbPlan({
      observation: o,
      executor: config.executor,
      minProfitWei: 1n,
    });

    // Keep the requested USDC flash-loan route.
    plan.provider = Provider.AAVE_V3;
    plan.asset = BASE.tokens.USDC;
    plan.amount = o.amountIn;

    const verdict = screen({
      plan,
      expectedProfitWei: o.netBeforeGasWei > 0n ? o.netBeforeGasWei : 0n,
      gasEstimate: 450_000n,
      maxFeePerGas,
      consecutiveFailures: 0,
    });

    if (!verdict.ok) {
      console.log(`[skip] ${verdict.reason}`);
      continue;
    }

    console.log("[would try] risk checks passed");

    const pf = await preflight(client, plan, operator);

    if (!pf.ok) {
      console.log(`[preflight FAIL] ${pf.revert}`);
      continue;
    }

    console.log(`[preflight OK] gas=${pf.gasEstimate}`);

    if (config.dryRun) {
      console.log("[DRY RUN] TX NOT BROADCAST");
      continue;
    }

    const txHash = await execute({
      chain: base,
      plan,
      gasLimit: pf.gasEstimate,
      maxFeePerGas,
      maxPriorityFeePerGas,
    });

    console.log(`[TX SENT] ${txHash}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
