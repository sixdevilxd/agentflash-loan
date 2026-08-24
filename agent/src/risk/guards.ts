import { config } from "../config.js";
import type { Plan } from "../abi/flashExecutor.js";

export type Verdict = { ok: true } | { ok: false; reason: string };

/**
 * Off-chain guards. These decide WHETHER TO TRY.
 *
 * They are not the safety net -- FlashExecutor's on-chain minProfit check is.
 * Their job is to avoid burning gas on attempts that are already known-bad,
 * which is the dominant cost of running an arb bot.
 */
export function screen(args: {
  plan: Plan;
  expectedProfitWei: bigint;
  gasEstimate: bigint;
  maxFeePerGas: bigint;
  consecutiveFailures: number;
}): Verdict {
  const { plan, expectedProfitWei, gasEstimate, maxFeePerGas, consecutiveFailures } = args;

  if (consecutiveFailures >= config.risk.maxConsecutiveFailures) {
    return { ok: false, reason: `kill switch: ${consecutiveFailures} consecutive failures` };
  }

  if (maxFeePerGas > config.risk.maxFeePerGasWei) {
    return { ok: false, reason: `gas price ${maxFeePerGas} above cap ${config.risk.maxFeePerGasWei}` };
  }

  if (plan.amount > config.risk.maxLoanWei) {
    return { ok: false, reason: `loan ${plan.amount} above cap ${config.risk.maxLoanWei}` };
  }

  if (expectedProfitWei < config.risk.minProfitWei) {
    return { ok: false, reason: `profit ${expectedProfitWei} below floor ${config.risk.minProfitWei}` };
  }

  // Gross profit means nothing if gas eats it. This is the check most naive
  // bots skip, and it is why they lose money on "profitable" trades.
  const gasCost = gasEstimate * maxFeePerGas;
  if (gasCost >= expectedProfitWei) {
    return { ok: false, reason: `gas ${gasCost} >= profit ${expectedProfitWei}` };
  }

  const share = Number(gasCost) / Number(expectedProfitWei);
  if (share > config.risk.maxGasShareOfProfit) {
    return {
      ok: false,
      reason: `gas is ${(share * 100).toFixed(1)}% of profit, cap ${config.risk.maxGasShareOfProfit * 100}%`,
    };
  }

  if (plan.minProfit === 0n) {
    return { ok: false, reason: "plan.minProfit is 0 -- refusing to send an unprotected tx" };
  }

  return { ok: true };
}
