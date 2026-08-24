import "dotenv/config";
import { getAddress, type Address } from "viem";

/**
 * Fail-closed config. Every guard has a default that REFUSES to trade rather
 * than one that trades unbounded. Missing safety vars are a startup error, not
 * a warning -- a bot that silently runs without caps is worse than one that
 * will not boot.
 */

function req(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

function reqAddress(name: string): Address {
  return getAddress(req(name));
}

function reqBigint(name: string): bigint {
  const raw = req(name);
  if (!/^\d+$/.test(raw)) throw new Error(`${name} must be an integer (wei/base units), got "${raw}"`);
  return BigInt(raw);
}

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const v = Number(raw);
  if (!Number.isFinite(v)) throw new Error(`${name} is not a number: "${raw}"`);
  return v;
}

export type ExecMode = "direct" | "sponsored";

const execMode = (process.env.EXEC_MODE ?? "direct") as ExecMode;
if (execMode !== "direct" && execMode !== "sponsored") {
  throw new Error(`EXEC_MODE must be "direct" or "sponsored", got "${execMode}"`);
}

export const config = {
  chainId: num("CHAIN_ID", 8453), // Base

  // Scanner/simulation RPC. Deliberately separate from the ZeroDev RPC so
  // polling does not eat the ZeroDev credit allowance.
  rpcUrl: req("RPC_URL"),

  executor: reqAddress("EXECUTOR_ADDRESS"),

  /**
   * Hot path = "direct": a plain EOA transaction, no bundler hop.
   * Cold/experimental = "sponsored": ZeroDev UserOp, optionally via UltraRelay.
   * Same address either way when the EOA is upgraded via EIP-7702.
   */
  execMode,

  operatorPk: req("OPERATOR_PRIVATE_KEY") as `0x${string}`,

  zerodev: {
    rpc: process.env.ZERODEV_RPC ?? "",
    // UltraRelay is a combined bundler+paymaster: ~30% less gas, ~20% lower
    // latency, available on Base. Worth measuring before trusting it in the
    // hot path.
    useUltraRelay: process.env.ZERODEV_ULTRA_RELAY === "true",
    /**
     * If the monthly sponsorship cap is hit, ZeroDev fails the UserOp outright.
     * With this on, we fall back to self-funded gas so the bot keeps running
     * instead of dying silently mid-month.
     */
    paymasterFallback: process.env.ZERODEV_PAYMASTER_FALLBACK !== "false",
  },

  risk: {
    /** Enforced on-chain too. This is the off-chain pre-filter. */
    minProfitWei: reqBigint("MIN_PROFIT_WEI"),
    /** Hard ceiling per attempt, independent of the contract's own cap. */
    maxLoanWei: reqBigint("MAX_LOAN_WEI"),
    /** Abort if estimated gas cost exceeds this share of expected profit. */
    maxGasShareOfProfit: num("MAX_GAS_SHARE_OF_PROFIT", 0.5),
    /** Stop everything after this many consecutive reverts. */
    maxConsecutiveFailures: num("MAX_CONSECUTIVE_FAILURES", 5),
    /** Upper bound on gas price we are willing to pay, in wei. */
    maxFeePerGasWei: reqBigint("MAX_FEE_PER_GAS_WEI"),
  },

  scanIntervalMs: num("SCAN_INTERVAL_MS", 2_000),

  /** Dry run: simulate and log, never broadcast. Default ON. */
  dryRun: process.env.DRY_RUN !== "false",
} as const;

if (config.execMode === "sponsored" && !config.zerodev.rpc) {
  throw new Error('EXEC_MODE=sponsored requires ZERODEV_RPC');
}
