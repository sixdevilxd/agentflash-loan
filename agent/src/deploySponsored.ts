import {
  createPublicClient, http, encodeAbiParameters, encodePacked, keccak256,
  getCreate2Address, concat, type Address, type Hex,
} from "viem";
import { base } from "viem/chains";
import "dotenv/config";

import { BASE } from "./chain/addresses.js";
import { compileFlashExecutor } from "./compile.js";
import { getKernel7702 } from "./zerodev/kernel7702.js";

/**
 * Deploy FlashExecutor through the ZeroDev smart account, gas sponsored.
 *
 * WHY THIS EXISTS
 * ---------------
 * Deploying normally needs a funded EOA. Through a paymaster it needs neither
 * ETH nor a funded key -- a freshly generated signer with a zero balance is
 * enough, because the sponsorship budget pays. Roughly 2.5M gas on Base, about
 * five cents, well inside a monthly cap.
 *
 * It doubles as an end-to-end test of the sponsorship pipeline: 7702
 * delegation, bundler, paymaster policy. If this succeeds, sponsored execution
 * works. If it fails, better to learn it here than mid-trade.
 *
 * ADMIN HANDOVER -- READ THIS
 * ---------------------------
 * The smart account is set as admin so it can configure the contract without a
 * second funded key. That means admin and operator are the SAME key, which
 * defeats the role separation the contract is built around.
 *
 * It is a bootstrap state, not a resting state. Move DEFAULT_ADMIN_ROLE to a
 * cold address before this contract holds anything.
 */

/** Deterministic deployer present on Base and most EVM chains. */
const CREATE2_FACTORY = "0x4e59b44847b379578588920cA78FbF26c0B4956C" as Address;

const SALT = (process.env.DEPLOY_SALT ??
  "0x0000000000000000000000000000000000000000000000000000000000000001") as Hex;

async function main() {
  const publicClient = createPublicClient({
    chain: base,
    transport: http(process.env.RPC_URL || "https://base-rpc.publicnode.com"),
  });

  const { kernelClient, address: smartAccount } = await getKernel7702(base);
  console.log(`smart account : ${smartAccount}`);

  // Admin defaults to the smart account so setup needs no second funded key.
  const admin = (process.env.ADMIN_ADDRESS ?? smartAccount) as Address;
  const guardian = (process.env.GUARDIAN_ADDRESS ?? smartAccount) as Address;

  const { bytecode, runtimeSize } = compileFlashExecutor();
  console.log(`compiled      : runtime ${runtimeSize} bytes (EIP-170 limit 24576)`);

  const initCode = concat([
    bytecode,
    encodeAbiParameters(
      [{ type: "address" }, { type: "address" }, { type: "address" }, { type: "address" }],
      [BASE.flashloan.aaveV3Pool, BASE.flashloan.balancerVault, admin, guardian],
    ),
  ]);

  const predicted = getCreate2Address({
    from: CREATE2_FACTORY,
    salt: SALT,
    bytecodeHash: keccak256(initCode),
  });

  console.log(`admin         : ${admin}${admin === smartAccount ? "  (BOOTSTRAP -- hand over later)" : ""}`);
  console.log(`guardian      : ${guardian}`);
  console.log(`predicted     : ${predicted}`);

  const existing = await publicClient.getCode({ address: predicted });
  if (existing && existing !== "0x") {
    console.log("\nalready deployed at that address -- nothing to do.");
    console.log(`EXECUTOR_ADDRESS=${predicted}`);
    return;
  }

  console.log("\nsending sponsored UserOperation...");
  const userOpHash = await kernelClient.sendUserOperation({
    callData: await kernelClient.account.encodeCalls([
      // The deterministic factory takes salt ++ initCode as raw calldata.
      { to: CREATE2_FACTORY, value: 0n, data: encodePacked(["bytes32", "bytes"], [SALT, initCode]) },
    ]),
  });
  console.log(`userOpHash    : ${userOpHash}`);

  const receipt = await kernelClient.waitForUserOperationReceipt({ hash: userOpHash });
  console.log(`tx            : ${receipt.receipt.transactionHash}`);

  const code = await publicClient.getCode({ address: predicted });
  if (!code || code === "0x") {
    throw new Error("transaction landed but no bytecode at the predicted address");
  }

  console.log(`\ndeployed. runtime size ${(code.length - 2) / 2} bytes`);
  console.log(`\nadd to .env:\n  EXECUTOR_ADDRESS=${predicted}`);
  console.log("\nnext: allowlist routers, set caps, grant OPERATOR_ROLE");
  if (admin === smartAccount) {
    console.log("then:  move DEFAULT_ADMIN_ROLE to a cold address -- do not skip");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
