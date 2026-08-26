import type { Address } from "viem";

export const BASE = {
  chainId: 8453,

  tokens: {
    WETH: "0x4200000000000000000000000000000000000006" as Address,
    USDC: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as Address,
  },

  uniV3: {
    factory: "0x33128a8fC17869897dcE68Ed026d694621f6FDfD" as Address,
    quoterV2: "0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a" as Address,
    router02: "0x2626664c2603336E57B271c5C0b26F421741e481" as Address,
    feeTiers: [100, 500, 3000] as const,
  },

  aerodrome: {
    router: "0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43" as Address,
    factory: "0x420DD381b31aEf6683db6B902084cB0FFECe40Da" as Address,
  },

  pancakeV3: {
    factory: "0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865" as Address,
    quoterV2: "0xB048Bbc1Ee6b733FFfCFb9e9CeF7375518e25997" as Address,
    router: "0x1b81D678ffb9C0263b24A97847620C99d213eB14" as Address,
    feeTiers: [100, 500, 2500, 10000] as const,
  },

  sushiV3: {
    factory: "0xc35DADB65012eC5796536bD9864eD8773aBc74C4" as Address,
    quoterV2: "0xb1E835Dc2785b52265711e17fCCb0fd018226a6e" as Address,
    router: "0xFB7eF66a7e61224DD6FcD0D7d9C3be5C8B049b9f" as Address,
    enabled: false,
  },

  flashloan: {
    aaveV3Pool: "0xA238Dd80C259a72e81d7e4664a9801593F98d1c5" as Address,
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
