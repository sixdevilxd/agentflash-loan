import {
  createWalletClient,
  http,
  encodeFunctionData,
  type Address,
  type Chain,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { config } from "../config.js";
import { flashExecutorAbi, type Plan } from "../abi/flashExecutor.js";

/**
 * HOT PATH -- plain EOA transaction straight to the executor.
 *
 * No bundler, no alt-mempool, no paymaster. This is the lowest-latency route
 * and the one to use when you are racing other searchers. Gas is paid from the
 * operator EOA's own balance.
 *
 * When the EOA has been upgraded via EIP-7702, this is the SAME address that
 * `sponsored.ts` sends UserOps from -- so switching modes needs no migration.
 */
export async function sendDirect(args: {
  chain: Chain;
  plan: Plan;
  gasLimit: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
}): Promise<Hex> {
  const account = privateKeyToAccount(config.operatorPk);
  const wallet = createWalletClient({
    account,
    chain: args.chain,
    transport: http(config.rpcUrl),
  });

  const data = encodeFunctionData({
    abi: flashExecutorAbi,
    functionName: "run",
    args: [args.plan],
  });

  return wallet.sendTransaction({
    to: config.executor as Address,
    data,
    gas: args.gasLimit,
    maxFeePerGas: args.maxFeePerGas,
    maxPriorityFeePerGas: args.maxPriorityFeePerGas,
  });
}

export function operatorAddress(): Address {
  return privateKeyToAccount(config.operatorPk).address;
}
