import type { Chain, Hex } from "viem";
import { config } from "../config.js";
import type { Plan } from "../abi/flashExecutor.js";
import { sendDirect } from "./direct.js";
import { sendSponsored } from "./sponsored.js";

export type ExecArgs = {
  chain: Chain;
  plan: Plan;
  gasLimit: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
};

/**
 * Single switch between the two routes. Because EIP-7702 keeps one address for
 * both, flipping EXEC_MODE needs no redeploy and no fund migration -- which is
 * exactly what makes an honest latency comparison cheap to run.
 */
export async function execute(args: ExecArgs): Promise<Hex> {
  if (config.dryRun) {
    throw new Error("DRY_RUN is enabled -- refusing to broadcast. Set DRY_RUN=false to go live.");
  }
  return config.execMode === "sponsored"
    ? sendSponsored({ chain: args.chain, plan: args.plan })
    : sendDirect(args);
}
