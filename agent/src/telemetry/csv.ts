import { appendFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { SYMBOL } from "../chain/addresses.js";
import type { Observation } from "../scanner/dexArb.js";

const HEADER = [
  "ts",
  "block",
  "base",
  "quote",
  "size",
  "buyVenue",
  "sellVenue",
  "grossBps",
  "grossWei",
  "flashFeeWei",
  "netBeforeGasWei",
  "gasEstimate",
  "gasCostWei",
  "netAfterGasWei",
  "wouldFire",
].join(",");

/**
 * Append-only CSV. This file IS the deliverable of Phase 0 -- after a couple of
 * weeks it answers the only question that matters: does a spread exist on this
 * chain, at these sizes, that survives fees and gas?
 */
export class CsvLog {
  constructor(private path: string) {
    mkdirSync(dirname(path), { recursive: true });
    if (!existsSync(path)) writeFileSync(path, HEADER + "\n");
  }

  write(
    o: Observation,
    extra: { gasEstimate: bigint; gasCostWei: bigint; wouldFire: boolean },
  ): void {
    const netAfterGas = o.netBeforeGasWei - extra.gasCostWei;
    const row = [
      new Date().toISOString(),
      o.blockNumber,
      SYMBOL[o.base] ?? o.base,
      SYMBOL[o.quote] ?? o.quote,
      o.amountIn,
      o.buyVenue,
      o.sellVenue,
      o.grossBps,
      o.grossWei,
      o.flashFeeWei,
      o.netBeforeGasWei,
      extra.gasEstimate,
      extra.gasCostWei,
      netAfterGas,
      extra.wouldFire ? "1" : "0",
    ].join(",");
    appendFileSync(this.path, row + "\n");
  }
}
