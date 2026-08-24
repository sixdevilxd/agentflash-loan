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

/**
 * Risk caps are mandatory before trading, but not before deploying. Enforcing
 * them at import time would make it impossible to run deploySponsored, which by
 * definition runs before any of them are known. requireTradingConfig() enforces
 * them at the point where they actually matter.
 */
function optBigint(name: string): bigint {
  const raw = process.env[name];
  if (!raw) return 0n;
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

  /**
   * NOT required at import time -- deploySponsored runs BEFORE this address
   * exists. Requiring it here made deploying impossible: the script that
   * produces the address could not start without the address.
   * Enforced by requireTradingConfig() at the point of use instead.
   */
  executor: process.env.EXECUTOR_ADDRESS
    ? getAddress(process.env.EXECUTOR_ADDRESS)
    : ("0x0000000000000000000000000000000000000000" as Address),

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
    minProfitWei: optBigint("MIN_PROFIT_WEI"),
    /** Hard ceiling per attempt, independent of the contract's own cap. */
    maxLoanWei: optBigint("MAX_LOAN_WEI"),
    /** Abort if estimated gas cost exceeds this share of expected profit. */
    maxGasShareOfProfit: num("MAX_GAS_SHARE_OF_PROFIT", 0.5),
    /** Stop everything after this many consecutive reverts. */
    maxConsecutiveFailures: num("MAX_CONSECUTIVE_FAILURES", 5),
    /** Upper bound on gas price we are willing to pay, in wei. */
    maxFeePerGasWei: optBigint("MAX_FEE_PER_GAS_WEI"),
  },

  scanIntervalMs: num("SCAN_INTERVAL_MS", 2_000),

  /** Dry run: simulate and log, never broadcast. Default ON. */
  dryRun: process.env.DRY_RUN !== "false",
} as const;

if (config.execMode === "sponsored" && !config.zerodev.rpc) {
  throw new Error("EXEC_MODE=sponsored requires ZERODEV_RPC");
}

const ZERO = "0x0000000000000000000000000000000000000000";

/** Call before anything that can move money. Deploy-time code must not. */
export function requireTradingConfig(): void {
  const missing: string[] = [];
  if (config.executor === ZERO) missing.push("EXECUTOR_ADDRESS");
  if (config.risk.minProfitWei === 0n) missing.push("MIN_PROFIT_WEI");
  if (config.risk.maxLoanWei === 0n) missing.push("MAX_LOAN_WEI");
  if (config.risk.maxFeePerGasWei === 0n) missing.push("MAX_FEE_PER_GAS_WEI");
  if (missing.length) {
    throw new Error(
      `Refusing to trade without risk caps. Missing: ${missing.join(", ")}. ` +
        "An unbounded bot is worse than one that will not start.",
    );
  }
}
