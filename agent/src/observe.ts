import { createPublicClient, http, formatEther } from "viem";
import { base } from "viem/chains";
import "dotenv/config";

import { BASE } from "./chain/addresses.js";
import { aaveV3PoolAbi, balancerVaultAbi, feeCollectorAbi } from "./chain/abi.js";
import { observe, describe, PAIR_WETH_USDC } from "./scanner/dexArb.js";
import { CsvLog } from "./telemetry/csv.js";
import { Telegram, digest, type DayStats } from "./telemetry/telegram.js";

/**
 * PHASE 0 -- OBSERVE ONLY.
 *
 * Sends nothing. Signs nothing. Needs no private key and no gas.
 *
 * It answers one question: on this chain, at these sizes, does any cross-venue
 * spread survive the flash-loan fee and gas? Run it for a couple of weeks and
 * read the CSV. If the answer is no, no amount of engineering changes that, and
 * you have saved yourself the subscription and the disappointment.
 *
 * Latency does not matter here, which is exactly why a phone is fine for it.
 */

const RPC = process.env.RPC_URL || "https://mainnet.base.org";
const INTERVAL_MS = Number(process.env.SCAN_INTERVAL_MS ?? 10_000);
const CSV_PATH = process.env.CSV_PATH ?? "./data/observations.csv";
const REPORT_EVERY_MS = Number(process.env.REPORT_EVERY_MS ?? 6 * 60 * 60 * 1000);

/** Flash-loan sizes in WETH. Small sizes have worse ratios; large ones move price. */
const SIZES = (process.env.SIZES_ETH ?? "0.1,1,5,20")
  .split(",")
  .map((s) => BigInt(Math.round(Number(s.trim()) * 1e18)));

/** Assumed gas for a flash-loan arb userop/tx. Refined once you fork-test. */
const GAS_ESTIMATE = BigInt(process.env.GAS_ESTIMATE ?? "450000");

/**
 * Parallel RPC calls. Deliberately low: the public Base RPC returns
 * "RPC Request failed" when ~100 quotes are fired at once, and a throttled
 * quote is indistinguishable from an empty market unless you count it.
 */
const CONCURRENCY = Number(process.env.RPC_CONCURRENCY ?? 2);

async function readFlashFees(client: {
  readContract(args: unknown): Promise<unknown>;
}) {
  const aaveBps = (await client.readContract({
    address: BASE.flashloan.aaveV3Pool,
    abi: aaveV3PoolAbi,
    functionName: "FLASHLOAN_PREMIUM_TOTAL",
  })) as bigint;

  const collector = (await client.readContract({
    address: BASE.flashloan.balancerVault,
    abi: balancerVaultAbi,
    functionName: "getProtocolFeesCollector",
  })) as `0x${string}`;
  const balRaw = (await client.readContract({
    address: collector,
    abi: feeCollectorAbi,
    functionName: "getFlashLoanFeePercentage",
  })) as bigint;
  // 1e18 == 100%, so bps = raw / 1e14
  const balancerBps = Number(balRaw / 100_000_000_000_000n);

  return { aaveBps: Number(aaveBps), balancerBps };
}

async function main() {
  const client = createPublicClient({ chain: base, transport: http(RPC) });
  const csv = new CsvLog(CSV_PATH);
  const tg = new Telegram(process.env.TELEGRAM_BOT_TOKEN, process.env.TELEGRAM_CHAT_ID);

  const fees = await readFlashFees(client);
  // Cheapest provider wins; Balancer is 0 bps on Base.
  const flashFeeBps = Math.min(fees.aaveBps, fees.balancerBps);
  const provider = fees.balancerBps <= fees.aaveBps ? "Balancer" : "Aave v3";

  console.log("agentflash-loan — PHASE 0 (observe only, nothing is sent)");
  console.log(`  rpc        : ${RPC}`);
  console.log(`  pair       : WETH/USDC`);
  console.log(`  sizes      : ${SIZES.map((s) => formatEther(s)).join(", ")} WETH`);
  console.log(`  flash fee  : Aave ${fees.aaveBps}bps | Balancer ${fees.balancerBps}bps -> using ${provider} (${flashFeeBps}bps)`);
  console.log(`  csv        : ${CSV_PATH}`);
  console.log(`  telegram   : ${tg.enabled ? "on" : "off"}`);
  console.log(`  concurrency: ${CONCURRENCY}`);
  if (RPC.includes("mainnet.base.org")) {
    console.log("");
    console.log("  NOTE: using the public Base RPC. It throttles under load, and");
    console.log("        throttled quotes are recorded as rpcErr, not as 'no edge'.");
    console.log("        Set RPC_URL to your own endpoint for trustworthy data.");
  }
  console.log("");

  const stats: DayStats = {
    ticks: 0,
    observations: 0,
    positiveBeforeGas: 0,
    positiveAfterGas: 0,
    bestNetBeforeGasWei: -(2n ** 255n),
    bestLabel: "",
    errors: 0,
    rpcErrors: 0,
    noPool: 0,
    quotesAttempted: 0,
  };
  let lastReport = Date.now();

  await tg.send("*Phase 0 started* — observing WETH/USDC on Base. Nothing will be sent.");

  for (;;) {
    try {
      const fee = await client.estimateFeesPerGas();
      const gasPrice = fee.maxFeePerGas ?? 0n;
      const gasCostWei = GAS_ESTIMATE * gasPrice;

      const scan = await observe(client, {
        ...PAIR_WETH_USDC,
        sizes: SIZES,
        flashFeeBps,
        concurrency: CONCURRENCY,
      });
      const results = scan.observations;
      stats.ticks += 1;
      stats.observations += results.length;
      stats.rpcErrors += scan.rpcErrors;
      stats.noPool += scan.noPool;
      stats.quotesAttempted += scan.quotesAttempted;

      for (const o of results) {
        const netAfterGas = o.netBeforeGasWei - gasCostWei;
        const wouldFire = netAfterGas > 0n;

        if (o.netBeforeGasWei > 0n) stats.positiveBeforeGas += 1;
        if (wouldFire) stats.positiveAfterGas += 1;
        if (o.netBeforeGasWei > stats.bestNetBeforeGasWei) {
          stats.bestNetBeforeGasWei = o.netBeforeGasWei;
          stats.bestLabel = describe(o);
        }

        csv.write(o, { gasEstimate: GAS_ESTIMATE, gasCostWei, wouldFire });
      }

      const best = results[0];
      const tag = best && best.netBeforeGasWei - gasCostWei > 0n ? "CLEARS GAS" : "no";
      const errRate = scan.quotesAttempted
        ? (scan.rpcErrors / scan.quotesAttempted) * 100
        : 0;
      console.log(
        `[${new Date().toISOString().slice(11, 19)}] block=${scan.blockNumber} ` +
          `obs=${results.length} rpcErr=${scan.rpcErrors}/${scan.quotesAttempted} ` +
          `gas=${formatEther(gasCostWei)}  ${tag}` +
          (best ? `  best: ${describe(best)}` : ""),
      );
      if (errRate > 25) {
        console.warn(
          `  !! ${errRate.toFixed(0)}% of quotes failed at the RPC. This tick is NOT ` +
            `evidence of "no edge" -- it is missing data. Use your own RPC_URL.`,
        );
      }
    } catch (e) {
      stats.errors += 1;
      console.error(`[err] ${(e as Error).message}`);
    }

    if (Date.now() - lastReport >= REPORT_EVERY_MS) {
      await tg.send(digest(stats, 18, "WETH"));
      lastReport = Date.now();
    }

    await new Promise((r) => setTimeout(r, INTERVAL_MS));
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
