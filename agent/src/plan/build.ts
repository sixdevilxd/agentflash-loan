import { encodeFunctionData, type Address, type Hex } from "viem";
import { BASE } from "../chain/addresses.js";
import { Provider, type Approval, type Call, type Plan } from "../abi/flashExecutor.js";
import type { Observation } from "../scanner/dexArb.js";

/**
 * Turn an Observation into calldata FlashExecutor.run() will accept.
 *
 * Every encoding here is proven against live Base pools in
 * contracts/test/ForkArb.t.sol. That test takes a real Balancer flash loan,
 * runs both swaps through the real routers, and asserts the only thing that
 * stops it is the profit guard. Two bugs surfaced there that would otherwise
 * have burned gas in production:
 *
 *   1. QuoterV2.quoteExactInputSingle is NOT view -- it swaps and catches the
 *      revert to read the result. Quoting via staticcall silently returns 0.
 *   2. Leg 2 must be sized BELOW leg 1's quote. It spends what leg 1 actually
 *      produced, so a leg sized at exactly the quote reverts the moment the
 *      realised output comes in a single wei short.
 */

/**
 * How far below the quote to size leg 2, in bps.
 *
 * Covers the gap between the quoted and realised output of leg 1. Too small
 * and the trade reverts on rounding; too large and profit is left as dust.
 */
const LEG2_HAIRCUT_BPS = 10n;

const uniV3RouterAbi = [
  {
    type: "function",
    name: "exactInputSingle",
    stateMutability: "payable",
    inputs: [
      {
        name: "params",
        type: "tuple",
        components: [
          { name: "tokenIn", type: "address" },
          { name: "tokenOut", type: "address" },
          { name: "fee", type: "uint24" },
          { name: "recipient", type: "address" },
          { name: "amountIn", type: "uint256" },
          { name: "amountOutMinimum", type: "uint256" },
          { name: "sqrtPriceLimitX96", type: "uint160" },
        ],
      },
    ],
    outputs: [{ name: "amountOut", type: "uint256" }],
  },
] as const;

const pancakeV3RouterAbi = [
  {
    type: "function",
    name: "exactInputSingle",
    stateMutability: "payable",
    inputs: [
      {
        name: "params",
        type: "tuple",
        components: [
          { name: "tokenIn", type: "address" },
          { name: "tokenOut", type: "address" },
          { name: "fee", type: "uint24" },
          { name: "recipient", type: "address" },
          { name: "deadline", type: "uint256" },
          { name: "amountIn", type: "uint256" },
          { name: "amountOutMinimum", type: "uint256" },
          { name: "sqrtPriceLimitX96", type: "uint160" },
        ],
      },
    ],
    outputs: [{ name: "amountOut", type: "uint256" }],
  },
] as const;

const aerodromeRouterAbi = [
  {
    type: "function",
    name: "swapExactTokensForTokens",
    stateMutability: "nonpayable",
    inputs: [
      { name: "amountIn", type: "uint256" },
      { name: "amountOutMin", type: "uint256" },
      {
        name: "routes",
        type: "tuple[]",
        components: [
          { name: "from", type: "address" },
          { name: "to", type: "address" },
          { name: "stable", type: "bool" },
          { name: "factory", type: "address" },
        ],
      },
      { name: "to", type: "address" },
      { name: "deadline", type: "uint256" },
    ],
    outputs: [{ name: "amounts", type: "uint256[]" }],
  },
] as const;

export type VenueLeg = { spender: Address; call: Call };

/** Encode one swap leg for a venue id produced by the scanner. */
export function encodeLeg(args: {
  venueId: string;
  tokenIn: Address;
  tokenOut: Address;
  amountIn: bigint;
  recipient: Address;
  deadline: bigint;
}): VenueLeg {
  const { venueId, tokenIn, tokenOut, amountIn, recipient, deadline } = args;

  const uni = /^univ3-(\d+)$/.exec(venueId);
  if (uni) {
    return {
      spender: BASE.uniV3.router02,
      call: {
        target: BASE.uniV3.router02,
        value: 0n,
        data: encodeFunctionData({
          abi: uniV3RouterAbi,
          functionName: "exactInputSingle",
          args: [
            {
              tokenIn,
              tokenOut,
              fee: Number(uni[1]),
              recipient,
              amountIn,
              // 0 on purpose: FlashExecutor's on-chain minProfit is the real
              // protection. A per-leg minimum only obscures the failure mode.
              amountOutMinimum: 0n,
              sqrtPriceLimitX96: 0n,
            },
          ],
        }) as Hex,
      },
    };
  }

  const pancake = /^pancakeV3-(\d+)$/.exec(venueId);
  if (pancake) {
    return {
      spender: BASE.pancakeV3.router,
      call: {
        target: BASE.pancakeV3.router,
        value: 0n,
        data: encodeFunctionData({
          abi: pancakeV3RouterAbi,
          functionName: "exactInputSingle",
          args: [
            {
              tokenIn,
              tokenOut,
              fee: Number(pancake[1]),
              recipient,
              deadline,
              amountIn,
              amountOutMinimum: 0n,
              sqrtPriceLimitX96: 0n,
            },
          ],
        }) as Hex,
      },
    };
  }

  const aero = /^aerodrome-(stable|volatile)$/.exec(venueId);
  if (aero) {
    return {
      spender: BASE.aerodrome.router,
      call: {
        target: BASE.aerodrome.router,
        value: 0n,
        data: encodeFunctionData({
          abi: aerodromeRouterAbi,
          functionName: "swapExactTokensForTokens",
          args: [
            amountIn,
            0n,
            [{ from: tokenIn, to: tokenOut, stable: aero[1] === "stable", factory: BASE.aerodrome.factory }],
            recipient,
            deadline,
          ],
        }) as Hex,
      },
    };
  }

  throw new Error(`no encoder for venue "${venueId}"`);
}

/**
 * Build the full two-leg plan.
 *
 * `executor` is both the recipient of every swap and the account whose balance
 * the on-chain profit check measures.
 */
export function buildArbPlan(args: {
  observation: Observation;
  executor: Address;
  minProfitWei: bigint;
  deadlineSec?: number;
}): Plan {
  const { observation: o, executor, minProfitWei } = args;
  const deadline = BigInt(Math.floor(Date.now() / 1000) + (args.deadlineSec ?? 300));

  const leg1 = encodeLeg({
    venueId: o.buyVenue,
    tokenIn: o.base,
    tokenOut: o.quote,
    amountIn: o.amountIn,
    recipient: executor,
    deadline,
  });

  // See LEG2_HAIRCUT_BPS -- leg 2 spends what leg 1 really produced.
  const leg2Amount = (o.midAmount * (10_000n - LEG2_HAIRCUT_BPS)) / 10_000n;

  const leg2 = encodeLeg({
    venueId: o.sellVenue,
    tokenIn: o.quote,
    tokenOut: o.base,
    amountIn: leg2Amount,
    recipient: executor,
    deadline,
  });

  const approvals: Approval[] = [
    { token: o.base, spender: leg1.spender, amount: o.amountIn },
    { token: o.quote, spender: leg2.spender, amount: leg2Amount },
  ];

  return {
    // Balancer is 0-fee on Base; the caller should confirm at runtime.
    provider: Provider.BALANCER_V2,
    asset: o.base,
    amount: o.amountIn,
    minProfit: minProfitWei,
    approvals,
    calls: [leg1.call, leg2.call],
  };
}
