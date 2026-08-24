import { createPublicClient, http, encodeFunctionData, getAddress, type Address } from "viem";
import { base } from "viem/chains";
import "dotenv/config";

import { flashExecutorAbi } from "./abi/flashExecutor.js";
import { getKernel7702 } from "./zerodev/kernel7702.js";

/**
 * Move DEFAULT_ADMIN_ROLE off the hot key.
 *
 * Deploy leaves the smart account as admin so setup needs no second funded
 * key. That is convenient and temporary: while it holds, one leaked key can
 * both trigger trades AND withdraw funds, which is precisely the separation
 * FlashExecutor is built around.
 *
 * Grant then renounce, batched into one UserOperation. Doing it as two
 * transactions risks renouncing first and locking the contract permanently
 * with no admin at all.
 */

const EXECUTOR = process.env.EXECUTOR_ADDRESS as Address | undefined;
const COLD = process.env.ADMIN_ADDRESS;

async function main() {
  if (!EXECUTOR) throw new Error("EXECUTOR_ADDRESS not set");
  if (!COLD) {
    throw new Error(
      "ADMIN_ADDRESS not set. This must be an address you control from a DIFFERENT " +
        "device than the one running the bot -- otherwise the handover achieves nothing.",
    );
  }

  const cold = getAddress(COLD);
  const publicClient = createPublicClient({
    chain: base,
    transport: http(process.env.RPC_URL || "https://base-rpc.publicnode.com"),
  });

  const { kernelClient, address: smartAccount } = await getKernel7702(base);

  if (cold.toLowerCase() === smartAccount.toLowerCase()) {
    throw new Error("ADMIN_ADDRESS equals the smart account -- that is not a handover");
  }

  const adminRole = (await publicClient.readContract({
    address: EXECUTOR, abi: flashExecutorAbi, functionName: "DEFAULT_ADMIN_ROLE",
  })) as `0x${string}`;

  const isAdmin = await publicClient.readContract({
    address: EXECUTOR, abi: flashExecutorAbi, functionName: "hasRole", args: [adminRole, smartAccount],
  });
  if (!isAdmin) throw new Error("smart account is not admin -- nothing to hand over");

  console.log(`executor : ${EXECUTOR}`);
  console.log(`from     : ${smartAccount}  (hot)`);
  console.log(`to       : ${cold}  (cold)`);
  console.log("\ngrant + renounce in one batch...");

  const hash = await kernelClient.sendUserOperation({
    callData: await kernelClient.account.encodeCalls([
      {
        to: EXECUTOR, value: 0n,
        data: encodeFunctionData({ abi: flashExecutorAbi, functionName: "grantRole", args: [adminRole, cold] }),
      },
      {
        to: EXECUTOR, value: 0n,
        data: encodeFunctionData({ abi: flashExecutorAbi, functionName: "renounceRole", args: [adminRole, smartAccount] }),
      },
    ]),
  });
  const receipt = await kernelClient.waitForUserOperationReceipt({ hash });
  console.log(`tx       : ${receipt.receipt.transactionHash}`);

  const [coldIsAdmin, hotIsAdmin] = await Promise.all([
    publicClient.readContract({ address: EXECUTOR, abi: flashExecutorAbi, functionName: "hasRole", args: [adminRole, cold] }),
    publicClient.readContract({ address: EXECUTOR, abi: flashExecutorAbi, functionName: "hasRole", args: [adminRole, smartAccount] }),
  ]);

  console.log("\nverified on-chain:");
  console.log(`  cold is admin : ${coldIsAdmin}`);
  console.log(`  hot is admin  : ${hotIsAdmin}   (must be false)`);

  if (!coldIsAdmin || hotIsAdmin) throw new Error("handover did not apply cleanly");
  console.log("\ndone. the hot key can now only trigger run(), never withdraw.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
