import {
  createPublicClient,
  http,
  encodeFunctionData,
  decodeErrorResult,
  type Address,
  type PublicClient,
} from "viem";
import { config } from "../config.js";
import { flashExecutorAbi, type Plan } from "../abi/flashExecutor.js";

export type Preflight =
  | { ok: true; gasEstimate: bigint }
  | { ok: false; revert: string };

export function makeClient(): PublicClient {
  return createPublicClient({ transport: http(config.rpcUrl) }) as PublicClient;
}

/**
 * Simulate against the latest state before spending gas.
 *
 * IMPORTANT: passing preflight does NOT mean the trade will be profitable at
 * inclusion time. State moves, and someone may land ahead of us. The contract's
 * minProfit check is what actually protects the money -- this only filters out
 * attempts that are already dead, so we do not pay gas to learn that.
 */
export async function preflight(
  client: any,
  plan: Plan,
  operator: Address,
): Promise<Preflight> {
  const data = encodeFunctionData({
    abi: flashExecutorAbi,
    functionName: "run",
    args: [plan],
  });

  try {
    const gasEstimate = await client.estimateGas({
      account: operator,
      to: config.executor,
      data,
    });
    // Head-room for state drift between estimate and inclusion.
    return { ok: true, gasEstimate: (gasEstimate * 120n) / 100n };
  } catch (e: unknown) {
    return { ok: false, revert: explainRevert(e) };
  }
}

/** Turn a raw revert into something readable in the logs. */
export function explainRevert(e: unknown): string {
  const err = e as { cause?: { data?: `0x${string}` }; shortMessage?: string; message?: string };
  const data = err?.cause?.data;
  if (data && data !== "0x") {
    try {
      const decoded = decodeErrorResult({ abi: flashExecutorAbi, data });
      return `${decoded.errorName}(${(decoded.args ?? []).map(String).join(", ")})`;
    } catch {
      /* not one of ours */
    }
  }
  return err?.shortMessage ?? err?.message ?? String(e);
}
