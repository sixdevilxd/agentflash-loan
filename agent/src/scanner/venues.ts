import { type Address } from "viem";
import { BASE } from "../chain/addresses.js";
import { quoterV2Abi, aerodromeRouterAbi } from "../chain/abi.js";
import { classify, withRetry, type QuoteResult } from "../chain/rpc.js";

/**
 * Narrow structural type instead of viem's `PublicClient`.
 *
 * Base is an OP Stack chain and carries extra transaction types (`deposit`),
 * so its concrete client does not unify with the generic `PublicClient`.
 * We only need three methods, so we ask for exactly those.
 */
export type QuoteClient = {
  getBlockNumber(): Promise<bigint>;
  readContract(args: never): Promise<unknown>;
  simulateContract(args: never): Promise<{ result: unknown }>;
};

/**
 * A venue answers "how much tokenOut for amountIn of tokenIn".
 *
 * It returns a discriminated result, never a bare null: "the pool reverted" and
 * "we could not reach the RPC" must stay distinguishable, or a throttled
 * endpoint silently reads as an empty market.
 */
export type Venue = {
  id: string;
  /** Contract the executor must allowlist and approve. */
  spender: Address;
  quote(
    client: QuoteClient,
    tokenIn: Address,
    tokenOut: Address,
    amountIn: bigint,
    blockNumber: bigint,
  ): Promise<QuoteResult>;
};

/** Uniswap V3, one venue per fee tier. */
function uniV3(fee: number): Venue {
  return {
    id: `univ3-${fee}`,
    spender: BASE.uniV3.router02,
    async quote(client, tokenIn, tokenOut, amountIn, blockNumber) {
      try {
        const { result } = await withRetry(() =>
          client.simulateContract({
            address: BASE.uniV3.quoterV2,
            abi: quoterV2Abi,
            functionName: "quoteExactInputSingle",
            args: [{ tokenIn, tokenOut, amountIn, fee, sqrtPriceLimitX96: 0n }],
            blockNumber,
          } as never),
        );
        const amount = (result as readonly bigint[])[0];
        if (amount === undefined || amount === 0n) return { ok: false, kind: "no-pool" };
        return { ok: true, amount };
      } catch (e) {
        const { kind, detail } = classify(e);
        return { ok: false, kind, detail };
      }
    },
  };
}

/** Aerodrome (Solidly fork). `stable` selects the curve. */
function aerodrome(stable: boolean): Venue {
  return {
    id: `aerodrome-${stable ? "stable" : "volatile"}`,
    spender: BASE.aerodrome.router,
    async quote(client, tokenIn, tokenOut, amountIn, blockNumber) {
      try {
        const amounts = (await withRetry(() =>
          client.readContract({
            address: BASE.aerodrome.router,
            abi: aerodromeRouterAbi,
            functionName: "getAmountsOut",
            args: [
              amountIn,
              [{ from: tokenIn, to: tokenOut, stable, factory: BASE.aerodrome.factory }],
            ],
            blockNumber,
          } as never),
        )) as readonly bigint[];
        const amount = amounts[amounts.length - 1];
        if (amount === undefined || amount === 0n) return { ok: false, kind: "no-pool" };
        return { ok: true, amount };
      } catch (e) {
        const { kind, detail } = classify(e);
        return { ok: false, kind, detail };
      }
    },
  };
}

export const VENUES: Venue[] = [
  ...BASE.uniV3.feeTiers.map((f) => uniV3(f)),
  aerodrome(false),
  aerodrome(true),
];
