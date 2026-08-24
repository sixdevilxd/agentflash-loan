import { createPublicClient, http, formatEther } from "viem";
import { base } from "viem/chains";
import "dotenv/config";

import { BASE } from "./chain/addresses.js";
import { aaveV3PoolAbi, balancerVaultAbi, feeCollectorAbi } from "./chain/abi.js";
import { observe, describe, PAIR_WETH_USDC, type Observation } from "./scanner/dexArb.js";
import { evaluate, priceImpactBps, type GasView, type Opportunity } from "./profit/engine.js";
import { sponsorshipFromEnv } from "./profit/sponsorship.js";
import { CsvLog } from "./telemetry/csv.js";
import { Telegram, digest, type DayStats } from "./telemetry/telegram.js";

/**
 * PHASE 0 -- OBSERVE ONLY.
 *
 * Sends nothing. Signs nothing. Needs no private key and no gas.
 *
 * Answers one question: on this chain, at these sizes, does any cross-venue
 * spread survive the flash-loan fee, slippage and gas? Latency is irrelevant
 * when nothing is broadcast, which is why a phone is adequate here.
 *
 * Every row records BOTH profit lines -- self-funded gas and sponsored gas --
 * because under a paymaster a reverted attempt costs the account nothing, and
 * that changes which opportunities are worth taking.
 */

const RPC = process.env.RPC_URL || "https://mainnet.base.org";
const INTERVAL_MS = Number(process.env.SCAN_INTERVAL_MS ?? 10_000);
const CSV_PATH = process.env.CSV_PATH ?? "./data/observations.csv";
const REPORT_EVERY_MS = Number(process.env.REPORT_EVERY_MS ?? 6 * 60 * 60 * 1000);
const CONCURRENCY = Number(process.env.RPC_CONCURRENCY ?? 2);

/** Ascending. The smallest doubles as the price-impact reference. */
const SIZES = (process.env.SIZES_ETH ?? "0.1,1,5,20")
  .split(",")
  .map((s) => BigInt(Math.round(Number(s.trim()) * 1e18)))
  .sort((a, b) => (a < b ? -1 : 1));

const GAS_ESTIMATE = BigInt(process.env.GAS_ESTIMATE ?? "450000");
const SLIPPAGE_BPS = Number(process.env.SLIPPAGE_BPS ?? 30);
const MIN_PROFIT_WEI = BigInt(process.env.MIN_PROFIT_WEI ?? "0");
const SAFETY_MARGIN_WEI = BigInt(process.env.SAFETY_MARGIN_WEI ?? "0");

async function readFlashFees(client: { readContract(args: unknown): Promise<unknown> }) {
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

  return { aaveBps: Number(aaveBps), balancerBps: Number(balRaw / 100_000_000_000_000n) };
}

/** Smallest observed size per venue pair, used as the price-impact reference. */
function referenceRates(obs: Observation[]): Map<string, { in: bigint; out: bigint }> {
  const ref = new Map<string, { in: bigint; out: bigint }>();
  for (const o of obs) {
    const key = `${o.buyVenue}|${o.sellVenue}`;
    const cur = ref.get(key);
    if (!cur || o.amountIn < cur.in) ref.set(key, { in: o.amountIn, out: o.amountBack });
  }
  return ref;
}

async function main() {
  const client = createPublicClient({ chain: base, transport: http(RPC) });
  const csv = new CsvLog(CSV_PATH);
  const tg = new Telegram(process.env.TELEGRAM_BOT_TOKEN, process.env.TELEGRAM_CHAT_ID);

  const fees = await readFlashFees(client);
  const flashFeeBps = Math.min(fees.aaveBps, fees.balancerBps);
  const provider = fees.balancerBps <= fees.aaveBps ? "Balancer" : "Aave v3";
  const sponsorship = sponsorshipFromEnv(process.env);
  const sponsored = sponsorship === "sponsored";

  console.log("agentflash-loan — PHASE 0 (observe only, nothing is sent)");
  console.log(`  rpc         : ${RPC}`);
  console.log(`  sizes       : ${SIZES.map((s) => formatEther(s)).join(", ")} WETH`);
  console.log(`  flash fee   : Aave ${fees.aaveBps}bps | Balancer ${fees.balancerBps}bps -> ${provider} (${flashFeeBps}bps)`);
  console.log(`  slippage    : ${SLIPPAGE_BPS} bps assumed`);
  console.log(`  gas model   : ${sponsorship}${sponsored ? " (gas NOT charged to account)" : ""}`);
  console.log(`  min profit  : ${MIN_PROFIT_WEI} + margin ${SAFETY_MARGIN_WEI}`);
  console.log(`  csv         : ${CSV_PATH}`);
  console.log(`  telegram    : ${tg.enabled ? "on" : "off"}`);
  if (RPC.includes("mainnet.base.org")) {
    console.log("\n  NOTE: public Base RPC throttles. Throttled quotes are counted as");
    console.log("        rpcErr, never as 'no edge'. Set RPC_URL for clean data.");
  }
  console.log("");

  const stats: DayStats = {
    ticks: 0, observations: 0, positiveBeforeGas: 0, positiveAfterGas: 0,
    bestNetBeforeGasWei: -(2n ** 255n), bestLabel: "", errors: 0,
    rpcErrors: 0, noPool: 0, quotesAttempted: 0,
  };
  let lastReport = Date.now();

  await tg.send("*Phase 0 started* — observing WETH/USDC on Base. Nothing will be sent.");

  for (;;) {
    try {
      const feeData = await client.estimateFeesPerGas();
      const gasPrice = feeData.maxFeePerGas ?? 0n;
      const gas: GasView = {
        estimate: GAS_ESTIMATE,
        pricePerGasWei: gasPrice,
        costWei: GAS_ESTIMATE * gasPrice,
        status: sponsorship,
        sponsored,
      };

      const scan = await observe(client, {
        ...PAIR_WETH_USDC, sizes: SIZES, flashFeeBps, concurrency: CONCURRENCY,
      });

      stats.ticks += 1;
      stats.observations += scan.observations.length;
      stats.rpcErrors += scan.rpcErrors;
      stats.noPool += scan.noPool;
      stats.quotesAttempted += scan.quotesAttempted;

      const refs = referenceRates(scan.observations);
      const opps: Opportunity[] = [];

      for (const o of scan.observations) {
        const ref = refs.get(`${o.buyVenue}|${o.sellVenue}`);
        const impact = ref ? priceImpactBps(ref.in, ref.out, o.amountIn, o.amountBack) : 0;

        const opp = evaluate({
          chainId: BASE.chainId,
          tokenIn: o.base,
          tokenOut: o.quote,
          dexA: o.buyVenue,
          dexB: o.sellVenue,
          flashLoanAmount: o.amountIn,
          expectedOutput: o.midAmount,
          amountBack: o.amountBack,
          flashLoanFeeBps: flashFeeBps,
          slippageBps: SLIPPAGE_BPS,
          priceImpactBps: impact,
          gas,
          minimumProfitWei: MIN_PROFIT_WEI,
          safetyMarginWei: SAFETY_MARGIN_WEI,
        });

        opps.push(opp);
        csv.write(scan.blockNumber, opp);

        if (opp.netSponsoredWei > 0n) stats.positiveBeforeGas += 1;
        if (opp.netSelfFundedWei > 0n) stats.positiveAfterGas += 1;
        if (opp.netSponsoredWei > stats.bestNetBeforeGasWei) {
          stats.bestNetBeforeGasWei = opp.netSponsoredWei;
          stats.bestLabel = describe(o);
        }
      }

      const fireable = opps.filter((o) => o.verdict === "execute").length;
      const errRate = scan.quotesAttempted ? (scan.rpcErrors / scan.quotesAttempted) * 100 : 0;
      const best = opps.reduce<Opportunity | null>(
        (a, b) => (a === null || b.netSponsoredWei > a.netSponsoredWei ? b : a), null,
      );

      console.log(
        `[${new Date().toISOString().slice(11, 19)}] block=${scan.blockNumber} ` +
          `obs=${scan.observations.length} rpcErr=${scan.rpcErrors}/${scan.quotesAttempted} ` +
          `fire=${fireable}` +
          (best
            ? `  best ${best.dexA}->${best.dexB} ` +
              `sponsored=${formatEther(best.netSponsoredWei)} ` +
              `selfFunded=${formatEther(best.netSelfFundedWei)} ` +
              `impact=${best.priceImpactBps}bps`
            : ""),
      );
      if (errRate > 25) {
        console.warn(
          `  !! ${errRate.toFixed(0)}% of quotes failed at the RPC. NOT evidence of ` +
            `"no edge" -- missing data. Set RPC_URL.`,
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
