import type { SponsorshipStatus } from "./engine.js";

/**
 * Is the ZeroDev paymaster able to sponsor right now?
 *
 * "Gas sponsorship unavailable" is an abort condition, not a warning:
 * sponsorship silently disappearing is exactly how a sponsored bot dies
 * mid-month once the monthly cap is reached.
 *
 * Phase 0 has no key and sends nothing, so it declares intent instead of
 * probing: ASSUME_GAS_SPONSORED lets the observer record what the numbers WOULD
 * look like under sponsorship, so the CSV answers both questions at once.
 */
export function sponsorshipFromEnv(env: NodeJS.ProcessEnv): SponsorshipStatus {
  if (env.ASSUME_GAS_SPONSORED === "true") return "sponsored";
  if (!env.ZERODEV_RPC) return "not-configured";
  return "self-funded";
}

/**
 * Live probe for Phase 1. Asks the paymaster for stub data; a refusal here is
 * the same signal the real send would give, just cheaper to discover.
 */
export async function probeSponsorship(
  zerodevRpc: string,
  entryPoint: string,
  chainId: number,
): Promise<SponsorshipStatus> {
  if (!zerodevRpc) return "not-configured";
  try {
    const res = await fetch(zerodevRpc, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "pm_getPaymasterStubData",
        params: [
          { sender: "0x" + "00".repeat(20), nonce: "0x0", callData: "0x" },
          entryPoint,
          `0x${chainId.toString(16)}`,
          {},
        ],
      }),
    });
    const body = (await res.json()) as { result?: unknown; error?: { message?: string } };
    if (body.error) {
      const m = body.error.message ?? "";
      // A malformed-userop complaint still proves the paymaster is reachable
      // and willing to talk; a cap/policy rejection is a real refusal.
      if (/limit|quota|policy|exceed|balance|sponsor/i.test(m)) return "unavailable";
      return "sponsored";
    }
    return body.result ? "sponsored" : "unavailable";
  } catch {
    return "unavailable";
  }
}
