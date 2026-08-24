import { base } from "viem/chains";
import { config } from "./config.js";
import { makeClient, preflight, explainRevert } from "./sim/preflight.js";
import { screen } from "./risk/guards.js";
import { execute } from "./exec/index.js";
import { operatorAddress } from "./exec/direct.js";
import { DexArbScanner } from "./scanner/dexArb.js";
import type { Scanner } from "./scanner/types.js";

const chain = base;

async function main() {
  const client = makeClient();
  const operator = operatorAddress();
  const scanners: Scanner[] = [new DexArbScanner()];

  console.log("agentflash-loan");
  console.log(`  chain     : ${chain.name} (${config.chainId})`);
  console.log(`  executor  : ${config.executor}`);
  console.log(`  operator  : ${operator}`);
  console.log(`  exec mode : ${config.execMode}${config.zerodev.useUltraRelay ? " (UltraRelay)" : ""}`);
  console.log(`  dry run   : ${config.dryRun ? "ON -- nothing will be broadcast" : "OFF -- LIVE"}`);
  console.log(`  min profit: ${config.risk.minProfitWei}`);
  console.log(`  max loan  : ${config.risk.maxLoanWei}`);

  let consecutiveFailures = 0;

  for (;;) {
    try {
      const fees = await client.estimateFeesPerGas();
      const maxFeePerGas = fees.maxFeePerGas ?? 0n;
      const maxPriorityFeePerGas = fees.maxPriorityFeePerGas ?? 0n;

      for (const scanner of scanners) {
        for (const opp of await scanner.scan()) {
          const sim = await preflight(client, opp.plan, operator);
          if (!sim.ok) {
            console.log(`[skip] ${opp.label}: preflight reverted -- ${sim.revert}`);
            continue;
          }

          const verdict = screen({
            plan: opp.plan,
            expectedProfitWei: opp.expectedProfitWei,
            gasEstimate: sim.gasEstimate,
            maxFeePerGas,
            consecutiveFailures,
          });
          if (!verdict.ok) {
            console.log(`[skip] ${opp.label}: ${verdict.reason}`);
            continue;
          }

          try {
            const hash = await execute({
              chain,
              plan: opp.plan,
              gasLimit: sim.gasEstimate,
              maxFeePerGas,
              maxPriorityFeePerGas,
            });
            consecutiveFailures = 0;
            console.log(`[sent] ${opp.label} -> ${hash}`);
          } catch (e) {
            consecutiveFailures += 1;
            console.error(`[fail] ${opp.label}: ${explainRevert(e)}`);
          }
        }
      }
    } catch (e) {
      console.error("[loop]", (e as Error).message);
    }

    await new Promise((r) => setTimeout(r, config.scanIntervalMs));
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
