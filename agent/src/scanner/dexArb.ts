import { type Address } from "viem";
import { BASE, DECIMALS, SYMBOL } from "../chain/addresses.js";
import { VENUES, type QuoteClient } from "./venues.js";
import { mapLimit } from "../chain/rpc.js";

export type Observation = {
  blockNumber: bigint;
  base: Address;          // asset we borrow and must repay
  quote: Address;         // intermediate asset
  amountIn: bigint;       // size of the flash loan
  buyVenue: string;       // leg 1: base -> quote
  sellVenue: string;      // leg 2: quote -> base
  midAmount: bigint;      // quote received on leg 1
  amountBack: bigint;     // base received on leg 2
  grossWei: bigint;       // amountBack - amountIn (may be negative)
  grossBps: number;
  flashFeeWei: bigint;
  netBeforeGasWei: bigint;
  spenders: Address[];    // routers that must be allowlisted
};

export type ScanResult = {
  blockNumber: bigint;
  observations: Observation[];
  /** Quotes we could not measure. High values invalidate the tick. */
  rpcErrors: number;
  /** Quotes that genuinely reverted -- real absence of liquidity. */
  noPool: number;
  quotesAttempted: number;
};

export type ScanOptions = {
  base: Address;
  quote: Address;
  sizes: bigint[];
  /** Flash-loan fee in bps. Read on-chain, never hardcode. */
  flashFeeBps: number;
  /** Parallel RPC calls. Keep low: public endpoints throttle on bursts. */
  concurrency?: number;
};

/**
 * Cross-venue round-trip scanner.
 *
 * CORRECTNESS: every quote is pinned to one `blockNumber`. Leg 2 consumes
 * leg 1's output so the two cannot share a multicall, but pinning the block
 * prices both against identical state. Quoting leg 1 at block N and leg 2 at
 * block N+1 manufactures profit that never existed.
 *
 * HONESTY: unmeasurable quotes are counted, not silently dropped. A throttled
 * RPC must never read as an empty market.
 */
export async function observe(client: QuoteClient, opts: ScanOptions): Promise<ScanResult> {
  const blockNumber = await client.getBlockNumber();
  const concurrency = opts.concurrency ?? 2;

  const observations: Observation[] = [];
  let rpcErrors = 0;
  let noPool = 0;
  let quotesAttempted = 0;

  for (const amountIn of opts.sizes) {
    // Leg 1: base -> quote across venues, bounded concurrency, same block.
    const legs1 = await mapLimit(VENUES, concurrency, async (v) => ({
      venue: v,
      res: await v.quote(client, opts.base, opts.quote, amountIn, blockNumber),
    }));
    quotesAttempted += legs1.length;

    for (const { venue: buyVenue, res } of legs1) {
      if (!res.ok) {
        if (res.kind === "rpc") rpcErrors += 1;
        else noPool += 1;
        continue;
      }
      const mid = res.amount;

      // Leg 2: quote -> base on every other venue, same block.
      const others = VENUES.filter((v) => v.id !== buyVenue.id);
      const legs2 = await mapLimit(others, concurrency, async (v) => ({
        venue: v,
        res: await v.quote(client, opts.quote, opts.base, mid, blockNumber),
      }));
      quotesAttempted += legs2.length;

      for (const { venue: sellVenue, res: r2 } of legs2) {
        if (!r2.ok) {
          if (r2.kind === "rpc") rpcErrors += 1;
          else noPool += 1;
          continue;
        }

        const back = r2.amount;
        const gross = back - amountIn;
        const flashFee = (amountIn * BigInt(opts.flashFeeBps)) / 10_000n;

        observations.push({
          blockNumber,
          base: opts.base,
          quote: opts.quote,
          amountIn,
          buyVenue: buyVenue.id,
          sellVenue: sellVenue.id,
          midAmount: mid,
          amountBack: back,
          grossWei: gross,
          grossBps: Number((gross * 10_000n) / amountIn),
          flashFeeWei: flashFee,
          netBeforeGasWei: gross - flashFee,
          spenders: [buyVenue.spender, sellVenue.spender],
        });
      }
    }
  }

  observations.sort((a, b) => (b.netBeforeGasWei > a.netBeforeGasWei ? 1 : -1));
  return { blockNumber, observations, rpcErrors, noPool, quotesAttempted };
}

export function describe(o: Observation): string {
  const d = DECIMALS[o.base] ?? 18;
  const sym = SYMBOL[o.base] ?? "?";
  const fmt = (v: bigint) => {
    const neg = v < 0n;
    const a = neg ? -v : v;
    return `${neg ? "-" : "+"}${(Number(a) / 10 ** d).toFixed(8)}`;
  };
  return (
    `${o.buyVenue} -> ${o.sellVenue}  ` +
    `size=${(Number(o.amountIn) / 10 ** d).toFixed(3)} ${sym}  ` +
    `net=${fmt(o.netBeforeGasWei)} ${sym} (${o.grossBps} bps gross)`
  );
}

export const PAIR_WETH_USDC = {
  base: BASE.tokens.WETH,
  quote: BASE.tokens.USDC,
};
