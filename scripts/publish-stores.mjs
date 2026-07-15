import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Publishes the packaged VS Code extension to both stores (VS Code Marketplace
 * via vsce, then Open VSX via ovsx) from the already-built .vsix.
 * Run through `pnpm publish:stores` so 1Password injects VSCE_PAT / OVSX_PAT.
 * `--dry-run` prints the commands without executing them.
 */
const manifest = JSON.parse(
  readFileSync(new URL("../vscode-extension/package.json", import.meta.url), "utf8"),
);
const vsixName = `${manifest.name}-${manifest.version}.vsix`;
const vsixAbsolutePath = fileURLToPath(new URL(`../vscode-extension/${vsixName}`, import.meta.url));
const isDryRun = process.argv.includes("--dry-run");

if (!existsSync(vsixAbsolutePath)) {
  throw new Error(`Package ${vsixAbsolutePath} does not exist. Run pnpm run package first.`);
}

if (!isDryRun) {
  for (const variableName of ["VSCE_PAT", "OVSX_PAT"]) {
    if (!process.env[variableName]) {
      throw new Error(`${variableName} is not available. Run through op run --env-file=.env.1password.`);
    }
  }
}

console.log(`Ready to publish ${manifest.publisher}.${manifest.name}@${manifest.version} from ${vsixAbsolutePath}.`);

/** Runs each store publish command, stopping on the first failure so a release cannot look half-complete. */
function run(command, args) {
  console.log(`$ ${[command, ...args].join(" ")}`);

  if (isDryRun) {
    return;
  }

  const result = spawnSync(command, args, {
    stdio: "inherit",
    env: process.env,
  });

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

run("pnpm", ["--filter", "vscode-debug-mcp-bridge", "exec", "vsce", "publish", "--packagePath", vsixName]);
run("pnpm", ["dlx", "ovsx", "publish", vsixAbsolutePath]);
