import { appendFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { SYMBOL } from "../chain/addresses.js";
import type { Opportunity } from "../profit/engine.js";

const HEADER = [
  "ts",
  "block",
  "tokenIn",
  "tokenOut",
  "size",
  "dexA",
  "dexB",
  "expectedOutput",
  "amountBack",
  "grossProfitWei",
  "flashLoanFeeWei",
  "slippageBps",
  "priceImpactBps",
  "gasEstimate",
  "gasCostWei",
  "sponsorship",
  "netSelfFundedWei",
  "netSponsoredWei",
  "minimumProfitWei",
  "safetyMarginWei",
  "verdict",
  "fireSelfFunded",
  "fireSponsored",
].join(",");

/**
 * Append-only CSV -- the actual deliverable of Phase 0.
 *
 * Both profit lines are recorded on every row: what the trade nets if we pay
 * gas, and what it nets if a paymaster covers it. They diverge most at small
 * sizes, where gas is a large share of a thin spread, so keeping both means the
 * data answers "does sponsorship change the answer?" without a second run.
 */
export class CsvLog {
  constructor(private path: string) {
    mkdirSync(dirname(path), { recursive: true });
    if (!existsSync(path)) writeFileSync(path, HEADER + "\n");
  }

  write(block: bigint, o: Opportunity): void {
    const required = o.minimumProfitWei + o.safetyMarginWei;
    const row = [
      new Date().toISOString(),
      block,
      SYMBOL[o.tokenIn] ?? o.tokenIn,
      SYMBOL[o.tokenOut] ?? o.tokenOut,
      o.flashLoanAmount,
      o.dexA,
      o.dexB,
      o.expectedOutput,
      o.amountBack,
      o.grossProfitWei,
      o.flashLoanFeeWei,
      o.slippageBps,
      o.priceImpactBps,
      o.gas.estimate,
      o.gas.costWei,
      o.gas.status,
      o.netSelfFundedWei,
      o.netSponsoredWei,
      o.minimumProfitWei,
      o.safetyMarginWei,
      o.verdict,
      o.netSelfFundedWei >= required ? "1" : "0",
      o.netSponsoredWei >= required ? "1" : "0",
    ].join(",");
    appendFileSync(this.path, row + "\n");
  }
}
