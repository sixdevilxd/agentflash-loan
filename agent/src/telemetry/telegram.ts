/**
 * Minimal Telegram reporter. No dependency -- plain fetch.
 *
 * Phase 0 uses this for a periodic digest, not per-opportunity spam. If the bot
 * pings you on every observation you will mute it within an hour and stop
 * reading the one signal that matters.
 */
export class Telegram {
  constructor(
    private token: string | undefined,
    private chatId: string | undefined,
  ) {}

  get enabled(): boolean {
    return Boolean(this.token && this.chatId);
  }

  async send(text: string): Promise<void> {
    if (!this.enabled) return;
    try {
      const res = await fetch(`https://api.telegram.org/bot${this.token}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: this.chatId,
          text,
          parse_mode: "Markdown",
          link_preview_options: { is_disabled: true },
        }),
      });
      if (!res.ok) console.warn(`[telegram] ${res.status}: ${await res.text()}`);
    } catch (e) {
      console.warn(`[telegram] ${(e as Error).message}`);
    }
  }
}

export type DayStats = {
  ticks: number;
  observations: number;
  positiveBeforeGas: number;
  positiveAfterGas: number;
  bestNetBeforeGasWei: bigint;
  bestLabel: string;
  errors: number;
  /** Quotes that could not be measured. Reported so "no edge" stays honest. */
  rpcErrors: number;
  noPool: number;
  quotesAttempted: number;
};

export function digest(s: DayStats, decimals: number, symbol: string): string {
  const fmt = (v: bigint) => {
    const neg = v < 0n;
    const a = neg ? -v : v;
    return `${neg ? "-" : "+"}${(Number(a) / 10 ** decimals).toFixed(8)}`;
  };

  const pct = s.quotesAttempted
    ? ((s.rpcErrors / s.quotesAttempted) * 100).toFixed(1)
    : "0";

  const lines = [
    "*agentflash-loan — Phase 0*",
    "",
    `Ticks: ${s.ticks}  •  observations: ${s.observations}`,
    `Positive before gas: *${s.positiveBeforeGas}*`,
    `Positive AFTER gas: *${s.positiveAfterGas}*`,
    `Best net (pre-gas): *${fmt(s.bestNetBeforeGasWei)} ${symbol}*`,
    s.bestLabel ? `  _${s.bestLabel}_` : "",
    s.errors ? `Loop errors: ${s.errors}` : "",
    "",
    `*Data quality*`,
    `Quotes: ${s.quotesAttempted}  •  RPC failures: ${s.rpcErrors} (${pct}%)  •  no pool: ${s.noPool}`,
    Number(pct) > 25
      ? "⚠️ _High RPC failure rate — treat today's result as incomplete, not as evidence of no edge._"
      : "",
    "",
    s.positiveAfterGas === 0
      ? Number(pct) > 25
        ? "_Nothing cleared gas, but the data has holes. Get a real RPC before concluding._"
        : "_Nothing cleared gas. That is the signal, not a bug._"
      : "_Some cleared gas. Check the CSV before believing it._",
  ];
  return lines.filter(Boolean).join("\n");
}
