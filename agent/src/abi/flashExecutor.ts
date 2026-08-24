/** Minimal ABI for the pieces the agent actually calls. */
export const flashExecutorAbi = [
  {
    type: "function",
    name: "run",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "plan",
        type: "tuple",
        components: [
          { name: "provider", type: "uint8" },
          { name: "asset", type: "address" },
          { name: "amount", type: "uint256" },
          { name: "minProfit", type: "uint256" },
          {
            name: "approvals",
            type: "tuple[]",
            components: [
              { name: "token", type: "address" },
              { name: "spender", type: "address" },
              { name: "amount", type: "uint256" },
            ],
          },
          {
            name: "calls",
            type: "tuple[]",
            components: [
              { name: "target", type: "address" },
              { name: "value", type: "uint256" },
              { name: "data", type: "bytes" },
            ],
          },
        ],
      },
    ],
    outputs: [],
  },
  { type: "function", name: "paused", stateMutability: "view", inputs: [], outputs: [{ type: "bool" }] },
  {
    type: "function",
    name: "maxLoan",
    stateMutability: "view",
    inputs: [{ type: "address" }],
    outputs: [{ type: "uint256" }],
  },
  // --- admin surface ---
  { type: "function", name: "setTarget", stateMutability: "nonpayable", inputs: [{ name: "target", type: "address" }, { name: "allowed", type: "bool" }], outputs: [] },
  { type: "function", name: "setMaxLoan", stateMutability: "nonpayable", inputs: [{ name: "asset", type: "address" }, { name: "cap", type: "uint256" }], outputs: [] },
  { type: "function", name: "grantRole", stateMutability: "nonpayable", inputs: [{ name: "role", type: "bytes32" }, { name: "account", type: "address" }], outputs: [] },
  { type: "function", name: "renounceRole", stateMutability: "nonpayable", inputs: [{ name: "role", type: "bytes32" }, { name: "account", type: "address" }], outputs: [] },
  { type: "function", name: "hasRole", stateMutability: "view", inputs: [{ name: "role", type: "bytes32" }, { name: "account", type: "address" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "allowedTarget", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "OPERATOR_ROLE", stateMutability: "view", inputs: [], outputs: [{ type: "bytes32" }] },
  { type: "function", name: "GUARDIAN_ROLE", stateMutability: "view", inputs: [], outputs: [{ type: "bytes32" }] },
  { type: "function", name: "DEFAULT_ADMIN_ROLE", stateMutability: "view", inputs: [], outputs: [{ type: "bytes32" }] },

  { type: "error", name: "ProfitBelowMin", inputs: [{ name: "have", type: "uint256" }, { name: "need", type: "uint256" }] },
  { type: "error", name: "TargetNotAllowed", inputs: [{ name: "target", type: "address" }] },
  { type: "error", name: "LoanExceedsCap", inputs: [{ name: "asset", type: "address" }, { name: "amount", type: "uint256" }, { name: "cap", type: "uint256" }] },
  { type: "error", name: "CallFailed", inputs: [{ name: "index", type: "uint256" }, { name: "reason", type: "bytes" }] },
] as const;

export enum Provider {
  AAVE_V3 = 0,
  BALANCER_V2 = 1,
}

export type Approval = { token: `0x${string}`; spender: `0x${string}`; amount: bigint };
export type Call = { target: `0x${string}`; value: bigint; data: `0x${string}` };

export type Plan = {
  provider: Provider;
  asset: `0x${string}`;
  amount: bigint;
  minProfit: bigint;
  approvals: readonly Approval[];
  calls: readonly Call[];
};
