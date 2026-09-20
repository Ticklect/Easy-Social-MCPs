import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  assertSupportedNode,
  inspectBundle,
  installBundles,
  normalizeArchivePath,
  parseArguments,
  registrationMatches,
  wrapHostExecutable,
} from "../install-easy-mcp.mjs";

const installerRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const repositoryRoot = path.dirname(installerRoot);

const bundles = [
  path.join(repositoryRoot, "reddit-easy.mcpb"),
  path.join(repositoryRoot, "x-easy", "x-easy-v0.1.0.mcpb"),
  path.join(repositoryRoot, "tiktok-easy", "tiktok-easy-v0.1.0.mcpb"),
  path.join(repositoryRoot, "youtube-easy", "youtube-easy-v0.1.0.mcpb"),
];

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "easy-mcp-installer-test-"));
}

function fakeRunner(existing = new Map()) {
  const calls = [];
  return {
    calls,
    run(command, args) {
      calls.push([command, ...args]);
      const host = path.basename(command).replace(/\.exe$/i, "");
      const verb = args[1];
      const name = verb === "add" && host === "claude" ? args[7] : args[2];
      const key = `${host}:${name}`;
      if (verb === "get") {
        if (!existing.has(key)) return { status: 1, stdout: "", stderr: "not found" };
        const configured = existing.get(key);
        const stdout = host === "codex"
          ? JSON.stringify({ transport: { type: "stdio", command: configured.command, args: configured.args || [] } })
          : `Scope: User\nType: stdio\nCommand: ${configured.command}\nArgs: ${(configured.args || []).join(" ")}\n`;
        return { status: 0, stdout, stderr: "" };
      }
      if (verb === "add") {
        existing.set(key, { command: args.at(-2), args: [args.at(-1)] });
        return { status: 0, stdout: "added", stderr: "" };
      }
      if (verb === "remove") {
        existing.delete(key);
        return { status: 0, stdout: "removed", stderr: "" };
      }
      throw new Error(`Unexpected fake command: ${[command, ...args].join(" ")}`);
    },
  };
}

test("inspects all released Easy MCP bundles without executing them", () => {
  const summaries = bundles.map(inspectBundle);
  assert.deepEqual(summaries.map((item) => item.name), ["reddit-easy", "x-easy", "tiktok-easy", "youtube-easy"]);
  assert.deepEqual(summaries.map((item) => item.entryPoint), ["dist/index.js", "dist/index.js", "app/dist/index.js", "dist/server.js"]);
  assert.equal(summaries.every((item) => item.command === "node"), true);
});

test("rejects absolute and traversal archive paths", () => {
  for (const unsafe of ["../outside", "nested/../../outside", "/absolute", "C:/absolute", "C:\\absolute", "nested\\..\\outside"]) {
    assert.throws(() => normalizeArchivePath(unsafe), /unsafe archive path/i, unsafe);
  }
  assert.equal(normalizeArchivePath("dist/server.js"), "dist/server.js");
});

test("rejects a bundle whose archived bytes fail their ZIP CRC", () => {
  const root = tempRoot();
  const source = fs.readFileSync(bundles[3]);
  const marker = Buffer.from("YouTube Easy", "utf8");
  const index = source.indexOf(marker);
  assert.notEqual(index, -1);
  source[index] ^= 0x01;
  const corrupted = path.join(root, "corrupted.mcpb");
  fs.writeFileSync(corrupted, source);
  assert.throws(() => inspectBundle(corrupted), /CRC mismatch/i);
});

test("installs bundles to a stable per-user root and registers Codex and Claude at user scope", () => {
  const dataRoot = tempRoot();
  const runner = fakeRunner();
  const result = installBundles([bundles[0], bundles[3]], {
    dataRoot,
    hosts: ["codex", "claude"],
    runner: runner.run,
    resolveCommand: (name) => `${name}.exe`,
  });

  assert.deepEqual(result.map((item) => item.name), ["reddit-easy", "youtube-easy"]);
  for (const item of result) {
    assert.equal(fs.statSync(item.entryPath).isFile(), true);
    assert.equal(path.relative(dataRoot, item.entryPath).startsWith(".."), false);
  }

  const codexAdds = runner.calls.filter((call) => call[0] === "codex.exe" && call[2] === "add");
  assert.deepEqual(codexAdds.map((call) => call.slice(1, 5)), [
    ["mcp", "add", "reddit-easy", "--"],
    ["mcp", "add", "youtube-easy", "--"],
  ]);
  const claudeAdds = runner.calls.filter((call) => call[0] === "claude.exe" && call[2] === "add");
  assert.deepEqual(claudeAdds.map((call) => call.slice(1, 8)), [
    ["mcp", "add", "--scope", "user", "--transport", "stdio", "reddit-easy"],
    ["mcp", "add", "--scope", "user", "--transport", "stdio", "youtube-easy"],
  ]);
});

test("every installed bundle completes an MCP initialize and tools/list handshake", () => {
  const dataRoot = tempRoot();
  const runner = fakeRunner();
  const installed = installBundles(bundles, {
    dataRoot,
    hosts: ["codex"],
    runner: runner.run,
    resolveCommand: (name) => name,
  });
  const input = `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "easy-mcp-installer-test", version: "0.1.0" } } })}\n${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} })}\n`;
  for (const item of installed) {
    const run = spawnSync(process.execPath, [item.entryPath], { input, encoding: "utf8", timeout: 15_000 });
    assert.equal(run.status, 0, `${item.name}: ${run.stderr || run.stdout}`);
    const responses = run.stdout.split(/\r?\n/).filter((line) => line.trim().startsWith("{")).map((line) => JSON.parse(line));
    assert.equal(responses.find((response) => response.id === 1)?.result?.serverInfo?.name?.length > 0, true, `${item.name}: initialize\n${run.stdout}\n${run.stderr}`);
    assert.equal(responses.find((response) => response.id === 2)?.result?.tools?.length > 0, true, `${item.name}: tools/list\n${run.stdout}\n${run.stderr}`);
  }
});

test("a repeated managed installation is idempotent", () => {
  const dataRoot = tempRoot();
  const runner = fakeRunner();
  const options = { dataRoot, hosts: ["codex"], runner: runner.run, resolveCommand: (name) => name };
  installBundles([bundles[3]], options);
  const addCount = runner.calls.filter((call) => call[2] === "add").length;
  const result = installBundles([bundles[3]], options);
  assert.equal(runner.calls.filter((call) => call[2] === "add").length, addCount);
  assert.equal(result[0].registrations.codex, "already-installed");
});

test("a managed receipt does not hide host configuration drift", () => {
  const dataRoot = tempRoot();
  const existing = new Map();
  const runner = fakeRunner(existing);
  const options = { dataRoot, hosts: ["codex"], runner: runner.run, resolveCommand: (name) => name };
  installBundles([bundles[3]], options);
  existing.set("codex:youtube-easy", { command: "different-node", args: ["different-server.js"] });
  assert.throws(() => installBundles([bundles[3]], options), /already exists.*--replace/i);
  const replaced = installBundles([bundles[3]], { ...options, replace: true });
  assert.equal(replaced[0].registrations.codex, "installed");
  assert.equal(runner.calls.filter((call) => call[2] === "remove").length, 1);
});

test("an unmanaged existing registration is not overwritten", () => {
  const dataRoot = tempRoot();
  const existing = new Map([["codex:youtube-easy", { command: "something-else" }]]);
  const runner = fakeRunner(existing);
  assert.throws(() => installBundles([bundles[3]], {
    dataRoot,
    hosts: ["codex"],
    runner: runner.run,
    resolveCommand: (name) => name,
  }), /already exists.*--replace/i);
  assert.equal(runner.calls.some((call) => call[2] === "remove"), false);
});

test("a host inspection error is not mistaken for a missing registration", () => {
  const dataRoot = tempRoot();
  const calls = [];
  const runner = (command, args) => {
    calls.push([command, ...args]);
    return { status: 2, stdout: "", stderr: "failed to load configuration" };
  };
  assert.throws(() => installBundles([bundles[3]], {
    dataRoot,
    hosts: ["codex"],
    runner,
    resolveCommand: (name) => name,
  }), /could not inspect.*configuration/i);
  assert.equal(calls.some((call) => call[2] === "add"), false);
});

test("replace removes an existing registration before adding the managed server", () => {
  const dataRoot = tempRoot();
  const existing = new Map([["claude:youtube-easy", { command: "old" }]]);
  const runner = fakeRunner(existing);
  installBundles([bundles[3]], {
    dataRoot,
    hosts: ["claude"],
    replace: true,
    runner: runner.run,
    resolveCommand: (name) => name,
  });
  const actions = runner.calls.filter((call) => call[0] === "claude" && ["remove", "add"].includes(call[2]));
  assert.equal(actions[0][2], "remove");
  assert.equal(actions[1][2], "add");
  assert.deepEqual(actions[0].slice(1), ["mcp", "remove", "youtube-easy", "--scope", "user"]);
});

test("CLI arguments require at least one host and bundle", () => {
  assert.deepEqual(parseArguments(["--host", "both", "one.mcpb"]), {
    bundles: [path.resolve("one.mcpb")], hosts: ["codex", "claude"], replace: false, dataRoot: undefined,
  });
  assert.throws(() => parseArguments([]), /usage/i);
  assert.throws(() => parseArguments(["--host", "other", "one.mcpb"]), /host/i);
});

test("requires Node 22 or newer before installation", () => {
  assert.doesNotThrow(() => assertSupportedNode("22.0.0"));
  assert.doesNotThrow(() => assertSupportedNode("24.18.0"));
  assert.throws(() => assertSupportedNode("21.9.0"), /Node\.js 22 or newer/i);
  assert.throws(() => assertSupportedNode("not-a-version"), /Node\.js 22 or newer/i);
});

test("wraps Windows npm command shims through the native command processor", () => {
  assert.deepEqual(wrapHostExecutable("C:\\tools\\codex.cmd", {
    platform: "win32",
    env: { ComSpec: "C:\\Windows\\System32\\cmd.exe" },
  }), {
    command: "C:\\Windows\\System32\\cmd.exe",
    prefix: ["/d", "/s", "/c", "C:\\tools\\codex.cmd"],
  });
  assert.deepEqual(wrapHostExecutable("C:\\tools\\codex.exe", { platform: "win32", env: {} }), {
    command: "C:\\tools\\codex.exe",
    prefix: [],
  });
});

test("verifies the registered command and entry path instead of trusting a receipt", () => {
  const entry = path.resolve("installed", "server.js");
  const codex = { status: 0, stdout: JSON.stringify({ transport: { type: "stdio", command: process.execPath, args: [entry] } }) };
  assert.equal(registrationMatches("codex", codex, entry), true);
  assert.equal(registrationMatches("codex", { ...codex, stdout: JSON.stringify({ transport: { type: "stdio", command: "wrong", args: [entry] } }) }, entry), false);
  const claude = { status: 0, stdout: `Scope: User\nType: stdio\nCommand: ${process.execPath}\nArgs: ${entry}\n` };
  assert.equal(registrationMatches("claude", claude, entry), true);
  assert.equal(registrationMatches("claude", { ...claude, stdout: "Command: wrong\nArgs: wrong\n" }, entry), false);
});
