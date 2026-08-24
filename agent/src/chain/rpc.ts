/**
 * RPC hygiene.
 *
 * Phase 0's conclusion is only worth anything if a throttled RPC cannot be
 * mistaken for an absent market. Measured on the public Base RPC: firing ~100
 * quotes in parallel returns "RPC Request failed" for most of them, which a
 * naive `catch { return null }` reports as "no pool". That produces a
 * confidently wrong "there is no edge".
 *
 * So: classify errors, bound concurrency, retry transport failures, and count
 * what we could not measure.
 */

export type Failure = "no-pool" | "rpc";

export type QuoteResult =
  | { ok: true; amount: bigint }
  | { ok: false; kind: Failure; detail?: string };

/**
 * A contract revert means the pool genuinely cannot serve the trade.
 * Anything transport-shaped means we failed to measure, which is different.
 */
export function classify(e: unknown): { kind: Failure; detail: string } {
  const err = e as { name?: string; shortMessage?: string; message?: string; details?: string };
  const text = `${err?.name ?? ""} ${err?.shortMessage ?? ""} ${err?.details ?? ""} ${err?.message ?? ""}`;

  const transport =
    /RPC Request failed|HTTP request failed|timed? ?out|fetch failed|ECONN|ENOTFOUND|EAI_AGAIN|socket|rate ?limit|429|502|503|504|Too Many Requests/i.test(
      text,
    );

  if (transport) return { kind: "rpc", detail: (err?.shortMessage ?? err?.message ?? "").slice(0, 120) };

  // ContractFunctionRevertedError / execution reverted -> the pool said no.
  return { kind: "no-pool", detail: (err?.shortMessage ?? "reverted").slice(0, 120) };
}

/** Retry only transport failures, with backoff and jitter. */
export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: { attempts?: number; baseMs?: number } = {},
): Promise<T> {
  const attempts = opts.attempts ?? 3;
  const baseMs = opts.baseMs ?? 400;
  let last: unknown;

  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      if (classify(e).kind !== "rpc") throw e; // a revert will not fix itself
      if (i === attempts - 1) break;
      const wait = baseMs * 2 ** i + Math.random() * baseMs;
      await sleep(wait);
    }
  }
  throw last;
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Bounded-concurrency map. Public RPCs throttle hard on bursts, and a throttled
 * measurement is worse than a slow one.
 */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let cursor = 0;

  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const i = cursor++;
      if (i >= items.length) return;
      out[i] = await fn(items[i] as T, i);
    }
  });

  await Promise.all(workers);
  return out;
}

/**
 * Poll until a predicate holds.
 *
 * Needed because a UserOperation receipt does not guarantee the state it
 * produced is readable yet. Load-balanced RPCs answer from whichever node
 * takes the request, and the bundler's write path is not the node you read
 * from -- so an immediate read after a successful deploy can legitimately
 * return nothing. Treating that as failure reports a working deployment as
 * broken, which is exactly what happened on the first real deploy.
 */
export async function pollUntil<T>(
  read: () => Promise<T>,
  done: (value: T) => boolean,
  opts: { attempts?: number; delayMs?: number } = {},
): Promise<{ ok: boolean; value: T }> {
  const attempts = opts.attempts ?? 6;
  const delayMs = opts.delayMs ?? 2_000;

  let value = await read();
  for (let i = 0; i < attempts && !done(value); i++) {
    await sleep(delayMs);
    value = await read();
  }
  return { ok: done(value), value };
}
