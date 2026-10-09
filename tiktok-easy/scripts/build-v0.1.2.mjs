/** Rebuilds the versioned TikTok release from the immutable v0.1.1 sources.
 * No upstream network checkout and no TikTok login/API requests are needed.
 * npm ci fetches pinned third-party dependencies if not already cached.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { buildRelease } from "./package-release.mjs";

const tiktokDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const version = "0.1.2";
const baseZip = path.join(tiktokDir, "tiktok-easy-v0.1.1-source.zip");

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, stdio: "inherit", shell: false, windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed (exit ${result.status})`);
}

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "tiktok-easy-build-"));
try {
  const sourceRoot = path.join(scratch, "source");
  const packageRoot = path.join(scratch, "package");
  fs.mkdirSync(sourceRoot, { recursive: true });
  fs.mkdirSync(path.join(packageRoot, "app"), { recursive: true });
  run("tar", ["-xf", baseZip, "-C", sourceRoot], tiktokDir);
  run(process.execPath, [path.join(tiktokDir, "patch-upstream.mjs"), "--rate-only"], sourceRoot);
  const npmCli = process.env.npm_execpath || path.join(path.dirname(process.execPath),
    "node_modules", "npm", "bin", "npm-cli.js");
  if (fs.existsSync(npmCli)) {
    run(process.execPath, [npmCli, "ci", "--ignore-scripts", "--no-audit", "--no-fund"], sourceRoot);
    run(process.execPath, [npmCli, "test"], sourceRoot);
    run(process.execPath, [npmCli, "prune", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"], sourceRoot);
  } else {
    run("npm", ["ci", "--ignore-scripts", "--no-audit", "--no-fund"], sourceRoot);
    run("npm", ["test"], sourceRoot);
    run("npm", ["prune", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"], sourceRoot);
  }
  fs.cpSync(path.join(sourceRoot, "dist"), path.join(packageRoot, "app", "dist"), { recursive: true });
  fs.cpSync(path.join(sourceRoot, "node_modules"), path.join(packageRoot, "app", "node_modules"), { recursive: true });
  fs.copyFileSync(path.join(sourceRoot, "package.json"), path.join(packageRoot, "app", "package.json"));
  for (const item of ["manifest.json", "README.md", "SECURITY.md", "LICENSE", "THIRD_PARTY_LICENSES.md"]) {
    fs.copyFileSync(path.join(tiktokDir, item), path.join(packageRoot, item));
  }
  const artifacts = buildRelease({ packageRoot, sourceRoot, outDir: tiktokDir, version });
  process.stdout.write(`Rebuilt ${path.basename(artifacts.mcpbPath)}\nSHA256 ${artifacts.mcpbHash}\n`);
} finally {
  // Only the uniquely created OS temp directory is removed, never repository data.
  const prefix = path.join(os.tmpdir(), "tiktok-easy-build-");
  if (!path.resolve(scratch).startsWith(path.resolve(prefix))) throw new Error("Unsafe build scratch path");
  fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}
