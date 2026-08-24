import type { Plan } from "../abi/flashExecutor.js";

/**
 * An opportunity is a fully-formed Plan plus the profit the scanner believes it
 * will realise. Keep this deterministic: no LLM in this path.
 */
export type Opportunity = {
  label: string;
  plan: Plan;
  expectedProfitWei: bigint;
};

export interface Scanner {
  readonly name: string;
  /** Return every candidate found this tick, best first. */
  scan(): Promise<Opportunity[]>;
}
