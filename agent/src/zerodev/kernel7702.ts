import { createPublicClient, http, type Chain } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  createKernelAccount,
  createKernelAccountClient,
  createZeroDevPaymasterClient,
} from "@zerodev/sdk";
import { getEntryPoint, KERNEL_V3_3 } from "@zerodev/sdk/constants";
import { config } from "../config.js";

/**
 * EIP-7702 Kernel client.
 *
 * 7702 attaches Kernel code to the operator EOA, so the smart account IS the
 * EOA -- same address, no CREATE2, no counterfactual deployment. That is what
 * lets us run the hot path as a raw EOA transaction and the cold path as a
 * sponsored UserOp from one identity.
 *
 * Requires Kernel v3.3 (v3.1 does not support 7702).
 */
export async function getKernel7702(chain: Chain) {
  if (!config.zerodev.rpc) throw new Error("ZERODEV_RPC not set");

  const signer = privateKeyToAccount(config.operatorPk);
  const entryPoint = getEntryPoint("0.7");

  const publicClient = createPublicClient({ chain, transport: http(config.rpcUrl) });

  const account = await createKernelAccount(publicClient, {
    eip7702Account: signer,
    entryPoint,
    kernelVersion: KERNEL_V3_3,
  });

  const bundlerRpc = config.zerodev.useUltraRelay
    ? `${config.zerodev.rpc}?provider=ULTRA_RELAY`
    : config.zerodev.rpc;

  const paymaster = createZeroDevPaymasterClient({
    chain,
    transport: http(config.zerodev.rpc),
  });

  const kernelClient = createKernelAccountClient({
    account,
    chain,
    client: publicClient,
    bundlerTransport: http(bundlerRpc),
    paymaster: {
      /**
       * THE IMPORTANT BIT.
       *
       * ZeroDev fails the UserOp outright once the monthly sponsorship cap is
       * reached. Without this fallback the bot dies silently mid-month. On any
       * paymaster error we return an empty payload, which makes the account pay
       * its own gas and keeps trading.
       */
      getPaymasterData: async (userOperation: unknown) => {
        try {
          return await paymaster.sponsorUserOperation({ userOperation } as never);
        } catch (e) {
          if (!config.zerodev.paymasterFallback) throw e;
          console.warn(
            `[paymaster] sponsorship unavailable (${(e as Error).message}) -- self-funding gas`,
          );
          return {} as never;
        }
      },
    },
  });

  return { account, kernelClient, address: account.address };
}
