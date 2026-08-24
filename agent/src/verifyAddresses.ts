import { createPublicClient, http } from "viem";
import { base } from "viem/chains";
import "dotenv/config";
import { BASE } from "./chain/addresses.js";
import { aaveV3PoolAbi, balancerVaultAbi, feeCollectorAbi } from "./chain/abi.js";
import { VENUES } from "./scanner/venues.js";

/**
 * Re-verify every hardcoded address before trusting it with money.
 * Addresses rot: contracts get redeployed, docs go stale, memory is unreliable.
 */
async function main() {
  const client = createPublicClient({
    chain: base,
    transport: http(process.env.RPC_URL || "https://mainnet.base.org"),
  });

  const entries: Array<[string, `0x${string}`]> = [
    ["WETH", BASE.tokens.WETH],
    ["USDC", BASE.tokens.USDC],
    ["uniV3.factory", BASE.uniV3.factory],
    ["uniV3.quoterV2", BASE.uniV3.quoterV2],
    ["uniV3.router02", BASE.uniV3.router02],
    ["aerodrome.router", BASE.aerodrome.router],
    ["aerodrome.factory", BASE.aerodrome.factory],
    ["aaveV3Pool", BASE.flashloan.aaveV3Pool],
    ["balancerVault", BASE.flashloan.balancerVault],
    ["multicall3", BASE.multicall3],
  ];

  let bad = 0;
  console.log("bytecode check:");
  for (const [name, addr] of entries) {
    const code = await client.getCode({ address: addr });
    const ok = Boolean(code && code !== "0x");
    if (!ok) bad += 1;
    console.log(`  ${ok ? "ok  " : "FAIL"}  ${name.padEnd(18)} ${addr}`);
  }

  console.log("\nflash loan fees:");
  const aave = (await client.readContract({
    address: BASE.flashloan.aaveV3Pool,
    abi: aaveV3PoolAbi,
    functionName: "FLASHLOAN_PREMIUM_TOTAL",
  })) as bigint;
  const collector = (await client.readContract({
    address: BASE.flashloan.balancerVault,
    abi: balancerVaultAbi,
    functionName: "getProtocolFeesCollector",
  })) as `0x${string}`;
  const bal = (await client.readContract({
    address: collector,
    abi: feeCollectorAbi,
    functionName: "getFlashLoanFeePercentage",
  })) as bigint;
  console.log(`  aave premium      ${aave} bps`);
  console.log(`  balancer fee      ${bal} (1e18 = 100%)`);

  console.log("\nlive quote, 1 WETH -> USDC:");
  const blockNumber = await client.getBlockNumber();
  for (const v of VENUES) {
    const r = await v.quote(client, BASE.tokens.WETH, BASE.tokens.USDC, 10n ** 18n, blockNumber);
    console.log(
      `  ${v.id.padEnd(20)} ${
        r.ok ? (Number(r.amount) / 1e6).toFixed(6) + " USDC" : `${r.kind}${r.detail ? ": " + r.detail : ""}`
      }`,
    );
  }

  if (bad) {
    console.error(`\n${bad} address(es) have no bytecode — DO NOT USE.`);
    process.exit(1);
  }
  console.log("\nall addresses verified.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
