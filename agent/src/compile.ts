import { readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require_ = createRequire(import.meta.url);
const HERE = dirname(fileURLToPath(import.meta.url));
const CONTRACTS = resolve(HERE, "../../contracts");

/**
 * Compile FlashExecutor from source with solc-js.
 *
 * The alternative was committing a hex blob of the creation bytecode. That is
 * how you end up deploying something nobody can check -- and a truncated or
 * stale blob fails in the least obvious way possible.
 *
 * Compiling from source means what you deploy is what is in contracts/src,
 * readable in the same repo, on any machine that can run Node. No Foundry
 * required, which matters when the deploy happens from a phone.
 *
 * Settings mirror contracts/foundry.toml exactly, so the output matches
 * `forge build` byte for byte apart from the trailing metadata hash.
 */

type SolcOutput = {
  errors?: Array<{ severity: string; formattedMessage: string }>;
  contracts?: Record<string, Record<string, { evm: { bytecode: { object: string } } }>>;
};

/**
 * Maps import paths the way foundry.toml remappings do.
 *
 * OpenZeppelin resolves from node_modules first: contracts/lib/ is gitignored,
 * so a fresh clone has no Foundry libs. npm is the only dependency source that
 * survives `git clone` on a machine without Foundry.
 */
function resolveImport(path: string): string | null {
  if (path.startsWith("@openzeppelin/")) {
    try {
      // @openzeppelin/contracts/token/... -> resolve the package, then the file
      const pkg = dirname(require_.resolve("@openzeppelin/contracts/package.json"));
      const rel = path.replace("@openzeppelin/contracts/", "");
      const viaNpm = join(pkg, rel);
      if (existsSync(viaNpm)) return viaNpm;
    } catch {
      /* fall through to the Foundry lib layout */
    }
    return join(CONTRACTS, "lib/openzeppelin-contracts", path.replace("@openzeppelin/", ""));
  }
  if (path.startsWith("./") || path.startsWith("../")) {
    return join(CONTRACTS, "src", path);
  }
  const direct = join(CONTRACTS, "src", path);
  return existsSync(direct) ? direct : null;
}

export function compileFlashExecutor(): { bytecode: `0x${string}`; runtimeSize: number } {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const solc = require_("solc");

  const entry = "FlashExecutor.sol";
  const input = {
    language: "Solidity",
    sources: { [entry]: { content: readFileSync(join(CONTRACTS, "src", entry), "utf8") } },
    settings: {
      optimizer: { enabled: true, runs: 1_000_000 },
      evmVersion: "cancun",
      outputSelection: { "*": { "*": ["evm.bytecode.object", "evm.deployedBytecode.object"] } },
    },
  };

  const out: SolcOutput = JSON.parse(
    solc.compile(JSON.stringify(input), {
      import: (path: string) => {
        const file = resolveImport(path);
        if (!file || !existsSync(file)) return { error: `not found: ${path}` };
        return { contents: readFileSync(file, "utf8") };
      },
    }),
  );

  const fatal = (out.errors ?? []).filter((e) => e.severity === "error");
  if (fatal.length) {
    throw new Error("solc failed:\n" + fatal.map((e) => e.formattedMessage).join("\n"));
  }

  const artifact = out.contracts?.[entry]?.["FlashExecutor"];
  if (!artifact) throw new Error("FlashExecutor not found in solc output");

  const bytecode = ("0x" + artifact.evm.bytecode.object) as `0x${string}`;
  const runtime = (out.contracts?.[entry]?.["FlashExecutor"] as unknown as {
    evm: { deployedBytecode: { object: string } };
  }).evm.deployedBytecode.object;

  const runtimeSize = runtime.length / 2;
  if (runtimeSize > 24_576) {
    throw new Error(`runtime ${runtimeSize} bytes exceeds the EIP-170 limit of 24576`);
  }

  return { bytecode, runtimeSize };
}
