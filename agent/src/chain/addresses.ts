import type { Address } from "viem";

/**
 * Base mainnet (8453).
 *
 * Every address below was verified on-chain before being committed:
 *   - eth_getCode returned non-empty bytecode
 *   - the contract answered the call we actually use
 *
 * Verified 2026-08-24 against https://mainnet.base.org.
 * Re-verify with `npm run verify:addresses` before trusting these with money.
 */
export const BASE = {
  chainId: 8453,

  tokens: {
    WETH: "0x4200000000000000000000000000000000000006" as Address, // 18 dp
    USDC: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as Address, // 6 dp
  },

  uniV3: {
    factory: "0x33128a8fC17869897dcE68Ed026d694621f6FDfD" as Address,
    quoterV2: "0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a" as Address,
    router02: "0x2626664c2603336E57B271c5C0b26F421741e481" as Address,
    /** Verified live: 100/500/3000 all have WETH-USDC liquidity. */
    feeTiers: [100, 500, 3000] as const,
  },

  aerodrome: {
    router: "0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43" as Address,
    factory: "0x420DD381b31aEf6683db6B902084cB0FFECe40Da" as Address,
  },

  flashloan: {
    /** FLASHLOAN_PREMIUM_TOTAL read live = 5 bps. Read it again at runtime. */
    aaveV3Pool: "0xA238Dd80C259a72e81d7e4664a9801593F98d1c5" as Address,
    /** getFlashLoanFeePercentage read live = 0. Prefer this venue. */
    balancerVault: "0xBA12222222228d8Ba445958a75a0704d566BF2C8" as Address,
  },

  multicall3: "0xcA11bde05977b3631167028862bE2a173976CA11" as Address,
} as const;

export const DECIMALS: Record<Address, number> = {
  [BASE.tokens.WETH]: 18,
  [BASE.tokens.USDC]: 6,
};

export const SYMBOL: Record<Address, string> = {
  [BASE.tokens.WETH]: "WETH",
  [BASE.tokens.USDC]: "USDC",
};
