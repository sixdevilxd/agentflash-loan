import type { Address } from "viem";

/**
 * PROFIT ENGINE
 *
 * Implements the cost stack explicitly:
 *
 *   gross            = amountBack - flashLoanAmount
 *   after slippage   = gross adjusted for the tolerance we would accept
 *   after flash fee  = minus the provider premium
 *   after gas        = minus gas, ONLY when we pay it ourselves
 *   verdict          = net >= (minimumProfit + safetyMargin)
 *
 * THE GAS DISTINCTION MATTERS.
 *
 * Under an ERC-4337 paymaster, a UserOp that reverts during execution is still
 * included and still paid for -- but paid by the sponsorship budget, not by the
 * account. So from the account's side a failed attempt costs nothing.
 *
 * That inverts the usual arb economics. Self-funded, gas on failures is the
 * dominant operating cost and you must filter hard. Sponsored, failures are
 * free to you and a low hit rate becomes affordable, which is exactly the
 * trade-off worth having when latency is against you.
 *
 * So we compute BOTH and never conflate them.
 */

export type SponsorshipStatus =
  | "sponsored"        // paymaster will cover this transaction
  | "self-funded"      // we pay gas from the account
  | "unavailable"      // paymaster refused (cap reached, policy miss)
  | "not-configured";  // no paymaster wired up

export type GasView = {
  estimate: bigint;
  pricePerGasWei: bigint;
  costWei: bigint;
  status: SponsorshipStatus;
  /** True only when the cost does not fall on the account. */
  sponsored: boolean;
};

/** The Opportunity Object, as a type. */
export type Opportunity = {
  // identity
  chainId: number;
  tokenIn: Address;
  tokenOut: Address;
  dexA: string;
  dexB: string;

  // sizing
  flashLoanAmount: bigint;
  expectedOutput: bigint;   // leg 1 output (tokenOut)
  amountBack: bigint;       // leg 2 output (tokenIn)

  // costs
  flashLoanFeeWei: bigint;
  slippageBps: number;
  priceImpactBps: number;

  // gas
  gas: GasView;

  // profit
  grossProfitWei: bigint;
  netSelfFundedWei: bigint;
  netSponsoredWei: bigint;
  minimumProfitWei: bigint;
  safetyMarginWei: bigint;

  // decision
  verdict: "execute" | "abort";
  reason: string;
};

export type EngineInput = {
  chainId: number;
  tokenIn: Address;
  tokenOut: Address;
  dexA: string;
  dexB: string;
  flashLoanAmount: bigint;
  expectedOutput: bigint;
  amountBack: bigint;
  flashLoanFeeBps: number;
  slippageBps: number;
  priceImpactBps: number;
  gas: GasView;
  minimumProfitWei: bigint;
  safetyMarginWei: bigint;
};

export function evaluate(i: EngineInput): Opportunity {
  const flashLoanFeeWei = (i.flashLoanAmount * BigInt(i.flashLoanFeeBps)) / 10_000n;

  // Slippage is a tolerance we would have to accept, so it reduces the output
  // we can count on -- not the output the quoter happened to return.
  const bps = BigInt(Math.max(0, Math.min(i.slippageBps, 10_000)));
  const worstCaseBack = (i.amountBack * (10_000n - bps)) / 10_000n;

  const grossProfitWei = worstCaseBack - i.flashLoanAmount;
  const afterFee = grossProfitWei - flashLoanFeeWei;

  const netSponsoredWei = afterFee;                      // gas not ours to pay
  const netSelfFundedWei = afterFee - i.gas.costWei;     // gas is ours

  const net = i.gas.sponsored ? netSponsoredWei : netSelfFundedWei;
  const required = i.minimumProfitWei + i.safetyMarginWei;

  let verdict: "execute" | "abort" = "abort";
  let reason: string;

  if (i.gas.status === "unavailable") {
    reason = "paymaster refused sponsorship -- abort";
  } else if (net < required) {
    reason = `net ${net} below required ${required} (min ${i.minimumProfitWei} + margin ${i.safetyMarginWei})`;
  } else {
    verdict = "execute";
    reason = `net ${net} clears required ${required}`;
  }

  return {
    chainId: i.chainId,
    tokenIn: i.tokenIn,
    tokenOut: i.tokenOut,
    dexA: i.dexA,
    dexB: i.dexB,
    flashLoanAmount: i.flashLoanAmount,
    expectedOutput: i.expectedOutput,
    amountBack: i.amountBack,
    flashLoanFeeWei,
    slippageBps: i.slippageBps,
    priceImpactBps: i.priceImpactBps,
    gas: i.gas,
    grossProfitWei,
    netSelfFundedWei,
    netSponsoredWei,
    minimumProfitWei: i.minimumProfitWei,
    safetyMarginWei: i.safetyMarginWei,
    verdict,
    reason,
  };
}

/**
 * Price impact without extra RPC calls.
 *
 * The scanner already quotes several sizes. The smallest acts as the reference
 * rate; larger sizes are compared against it. Reusing quotes we already paid
 * for matters on a metered endpoint.
 */
export function priceImpactBps(
  refIn: bigint,
  refOut: bigint,
  sizeIn: bigint,
  sizeOut: bigint,
): number {
  if (refIn === 0n || refOut === 0n || sizeIn === 0n) return 0;
  const refRate = (refOut * 1_000_000n) / refIn;
  const sizeRate = (sizeOut * 1_000_000n) / sizeIn;
  if (refRate === 0n) return 0;
  const impact = ((refRate - sizeRate) * 10_000n) / refRate;
  return Number(impact);
}
