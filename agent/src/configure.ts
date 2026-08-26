import { createPublicClient, http, encodeFunctionData, formatEther, type Address } from "viem";
import { base } from "viem/chains";
import "dotenv/config";

import { BASE } from "./chain/addresses.js";
import { flashExecutorAbi } from "./abi/flashExecutor.js";
import { getKernel7702 } from "./zerodev/kernel7702.js";
import { pollUntil } from "./chain/rpc.js";

/**
 * Configure a freshly deployed FlashExecutor, gas sponsored.
 *
 * Everything goes out as ONE batched UserOperation. Four separate transactions
 * would be four sponsorship charges and four chances to stop halfway, leaving
 * the contract in a state where routers are allowed but no cap is set. Batching
 * makes the whole configuration atomic.
 *
 * Requires the caller to hold DEFAULT_ADMIN_ROLE, which right after
 * `npm run deploy` is the smart account itself.
 */

const EXECUTOR = process.env.EXECUTOR_ADDRESS as Address | undefined;

/** Per-asset borrow ceiling. 0 would mean "not borrowable", so it must be set. */
const MAX_LOAN_WETH = BigInt(process.env.MAX_LOAN_WETH ?? "50000000000000000000"); // 50 WETH
const MAX_LOAN_USDC = BigInt(process.env.MAX_LOAN_USDC ?? "200000000000"); // 200,000 USDC

async function main() {
  if (!EXECUTOR) {
    throw new Error("EXECUTOR_ADDRESS not set. Run `npm run deploy` first and copy the address it prints.");
  }

  const publicClient = createPublicClient({
    chain: base,
    transport: http(process.env.RPC_URL || "https://base-rpc.publicnode.com"),
  });

  const code = await publicClient.getCode({ address: EXECUTOR });
  if (!code || code === "0x") throw new Error(`no contract at ${EXECUTOR}`);

  const { kernelClient, address: smartAccount } = await getKernel7702(base);

  const [operatorRole, adminRole] = await Promise.all([
    publicClient.readContract({ address: EXECUTOR, abi: flashExecutorAbi, functionName: "OPERATOR_ROLE" }),
    publicClient.readContract({ address: EXECUTOR, abi: flashExecutorAbi, functionName: "DEFAULT_ADMIN_ROLE" }),
  ]);

  const isAdmin = await publicClient.readContract({
    address: EXECUTOR, abi: flashExecutorAbi, functionName: "hasRole",
    args: [adminRole as `0x${string}`, smartAccount],
  });
  if (!isAdmin) {
    throw new Error(
      `smart account ${smartAccount} does not hold DEFAULT_ADMIN_ROLE on ${EXECUTOR}. ` +
        "Configuration must be sent from the admin key.",
    );
  }

  // Routers the executor may call and approve. Token addresses must NEVER
  // appear here -- that allowlist is what stops a compromised operator from
  // encoding a plain ERC-20 transfer out.
  const routers: Address[] = [BASE.uniV3.router02, BASE.aerodrome.router];

  const calls = [
    {
      to: EXECUTOR, value: 0n,
      data: encodeFunctionData({
        abi: flashExecutorAbi, functionName: "setMaxLoan",
        args: [BASE.tokens.WETH, MAX_LOAN_WETH],
      }),
    },
          {
        to: EXECUTOR, value: 0n,
        data: encodeFunctionData({
          abi: flashExecutorAbi, functionName: "setMaxLoan",
          args: [BASE.tokens.USDC, MAX_LOAN_USDC],
        }),
      },
      ...routers.map((r) => ({
      to: EXECUTOR, value: 0n,
      data: encodeFunctionData({ abi: flashExecutorAbi, functionName: "setTarget", args: [r, true] }),
    })),
    {
      to: EXECUTOR, value: 0n,
      data: encodeFunctionData({
        abi: flashExecutorAbi, functionName: "grantRole",
        args: [operatorRole as `0x${string}`, smartAccount],
      }),
    },
  ];

  console.log(`executor      : ${EXECUTOR}`);
  console.log(`admin (caller): ${smartAccount}`);
  console.log(`max loan WETH : ${formatEther(MAX_LOAN_WETH)} WETH`);
console.log(`max loan USDC : ${Number(MAX_LOAN_USDC) / 1e6} USDC`);
  console.log(`routers       : ${routers.join(", ")}`);
  console.log(`operator      : ${smartAccount}`);
  console.log(`\nsending ${calls.length} calls as one sponsored UserOperation...`);

  const hash = await kernelClient.sendUserOperation({
    callData: await kernelClient.account.encodeCalls(calls),
  });
  const receipt = await kernelClient.waitForUserOperationReceipt({ hash });
  console.log(`tx            : ${receipt.receipt.transactionHash}`);

  // Read the state back. A landed transaction is not proof the state is right --
  // but it is also not proof it is wrong, since the read may hit a lagging node.
  // So poll rather than judging on the first answer.
  const readAll = async () =>
    Promise.all([
      publicClient.readContract({ address: EXECUTOR, abi: flashExecutorAbi, functionName: "maxLoan", args: [BASE.tokens.WETH] }),
      publicClient.readContract({ address: EXECUTOR, abi: flashExecutorAbi, functionName: "maxLoan", args: [BASE.tokens.USDC] }),
      publicClient.readContract({ address: EXECUTOR, abi: flashExecutorAbi, functionName: "allowedTarget", args: [routers[0] as Address] }),
      publicClient.readContract({ address: EXECUTOR, abi: flashExecutorAbi, functionName: "allowedTarget", args: [routers[1] as Address] }),
      publicClient.readContract({ address: EXECUTOR, abi: flashExecutorAbi, functionName: "hasRole", args: [operatorRole as `0x${string}`, smartAccount] }),
    ]);

  const { ok, value } = await pollUntil(
    readAll,
    ([cap, r0, r1, isOp]) => Boolean(cap && r0 && r1 && isOp),
  );
  const [capWeth, capUsdc, r0, r1, isOperator] = value;

  console.log("\nverified on-chain:");
  console.log(`  maxLoan(WETH)        ${formatEther(capWeth as bigint)} WETH`);
console.log(`  maxLoan(USDC)        ${Number(capUsdc as bigint) / 1e6} USDC`);
  console.log(`  allowed uniV3 router ${r0}`);
  console.log(`  allowed aerodrome    ${r1}`);
  console.log(`  operator granted     ${isOperator}`);

  if (!ok) {
    console.warn(
      "\nnot everything reads back as applied yet. The transaction landed, so check\n" +
        `before assuming failure: https://basescan.org/tx/${receipt.receipt.transactionHash}`,
    );
    return;
  }
  console.log("\nconfigured. next: npm run handover  (move admin to a cold key)");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
