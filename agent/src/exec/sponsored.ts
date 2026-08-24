import { encodeFunctionData, type Chain, type Hex } from "viem";
import { getKernel7702 } from "../zerodev/kernel7702.js";
import { config } from "../config.js";
import { flashExecutorAbi, type Plan } from "../abi/flashExecutor.js";

/**
 * COLD PATH -- ZeroDev UserOp with gas sponsorship.
 *
 * Best fit for operations where latency does not decide the outcome: sweeping
 * profit to treasury, rotating config, pausing, topping up. This is where a
 * $250/month sponsorship allowance actually earns its keep.
 *
 * You CAN point this at the hot path too (UltraRelay claims ~20% lower latency
 * than a standard bundler, and Base is supported) -- but measure it against
 * `sendDirect` on real opportunities before trusting it. Two costs to weigh:
 * the 8% sponsorship premium applies to every attempt including reverts, and a
 * UserOp is visible in the bundler's alt-mempool before inclusion.
 */
export async function sendSponsored(args: { chain: Chain; plan: Plan }): Promise<Hex> {
  const { kernelClient } = await getKernel7702(args.chain);

  const data = encodeFunctionData({
    abi: flashExecutorAbi,
    functionName: "run",
    args: [args.plan],
  });

  const userOpHash = await kernelClient.sendUserOperation({
    callData: await kernelClient.account.encodeCalls([
      { to: config.executor, value: 0n, data },
    ]),
  });

  const receipt = await kernelClient.waitForUserOperationReceipt({ hash: userOpHash });
  return receipt.receipt.transactionHash as Hex;
}
