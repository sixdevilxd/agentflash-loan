import type { Scanner, Opportunity } from "./types.js";

/**
 * Two-venue arbitrage scanner -- STUB.
 *
 * Fill this in with real quoting before going live. The shape to follow:
 *
 *   1. Read reserves/sqrtPriceX96 for the pools you care about, batched through
 *      a single multicall so every leg is priced at the SAME block. Pricing legs
 *      at different blocks is the classic source of phantom profit.
 *   2. Solve for the input size that maximises output, do not hardcode a size.
 *   3. Quote the round trip on-chain (quoter contract), never from a price feed.
 *   4. Subtract the flash-loan fee: read FLASHLOAN_PREMIUM_TOTAL from the Aave
 *      pool rather than assuming 5 bps, and prefer Balancer when it is 0-fee.
 *   5. Build the Plan with approvals + swap calldata and set `minProfit` to the
 *      floor you are willing to accept on-chain.
 *
 * Deliberately NOT an LLM. This runs every couple of seconds and must be
 * deterministic and fast. Reserve the model for offline work: reviewing which
 * pairs are worth watching, tuning thresholds, explaining a run of reverts.
 */
export class DexArbScanner implements Scanner {
  readonly name = "dex-arb";

  async scan(): Promise<Opportunity[]> {
    return [];
  }
}
