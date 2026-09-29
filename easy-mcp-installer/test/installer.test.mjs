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
  path.join(repositoryRoot, "tiktok-easy", "tiktok-easy-v0.1.1.mcpb"),
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
    // macOS exposes os.tmpdir() through /var while Node canonicalizes it to /private/var.
    // Launch the canonical path so servers with an import.meta entry-point guard self-start.
    const run = spawnSync(process.execPath, [fs.realpathSync(item.entryPath)], { input, encoding: "utf8", timeout: 15_000 });
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

test("replace restores the prior registration when adding the managed server fails", () => {
  const dataRoot = tempRoot();
  const calls = [];
  let registration = { command: "old-node", args: ["old-server.js", "--legacy"] };
  const runner = (command, args) => {
    calls.push([command, ...args]);
    const verb = args[1];
    if (verb === "get") {
      return { status: 0, stdout: JSON.stringify({ transport: { type: "stdio", ...registration } }), stderr: "" };
    }
    if (verb === "remove") {
      registration = null;
      return { status: 0, stdout: "removed", stderr: "" };
    }
    if (verb === "add") {
      const separator = args.indexOf("--");
      const commandLine = args.slice(separator + 1);
      if (commandLine[0] === process.execPath) return { status: 1, stdout: "", stderr: "add failed" };
      registration = { command: commandLine[0], args: commandLine.slice(1) };
      return { status: 0, stdout: "restored", stderr: "" };
    }
    throw new Error(`Unexpected fake command: ${[command, ...args].join(" ")}`);
  };

  assert.throws(() => installBundles([bundles[3]], {
    dataRoot,
    hosts: ["codex"],
    replace: true,
    runner,
    resolveCommand: (name) => name,
  }), /could not register.*add failed/i);

  assert.deepEqual(registration, { command: "old-node", args: ["old-server.js", "--legacy"] });
  assert.deepEqual(calls.filter((call) => ["remove", "add"].includes(call[2])).map((call) => call.slice(1)), [
    ["mcp", "remove", "youtube-easy"],
    ["mcp", "add", "youtube-easy", "--", process.execPath, path.join(dataRoot, "servers", "youtube-easy", "0.1.0", "dist", "server.js")],
    ["mcp", "add", "youtube-easy", "--", "old-node", "old-server.js", "--legacy"],
  ]);
});

test("Codex rollback preserves environment variables when replacement add fails", () => {
  const dataRoot = tempRoot();
  const calls = [];
  let registration = {
    command: "old-node",
    args: ["old-server.js", "--legacy"],
    env: { API_TOKEN: "token-value", MODE: "legacy" },
  };
  const runner = (command, args) => {
    calls.push([command, ...args]);
    const verb = args[1];
    if (verb === "get") {
      return {
        status: 0,
        stdout: JSON.stringify({
          name: "youtube-easy",
          enabled: true,
          disabled_reason: null,
          transport: { type: "stdio", ...registration, env_vars: [], cwd: null },
          enabled_tools: null,
          disabled_tools: null,
          startup_timeout_sec: null,
          tool_timeout_sec: null,
        }),
        stderr: "",
      };
    }
    if (verb === "remove") {
      registration = null;
      return { status: 0, stdout: "removed", stderr: "" };
    }
    if (verb === "add") {
      const separator = args.indexOf("--");
      const commandLine = args.slice(separator + 1);
      if (commandLine[0] === process.execPath) return { status: 1, stdout: "", stderr: "add failed" };
      const env = {};
      for (let index = 2; index < separator; index++) {
        if (args[index] !== "--env") continue;
        const [key, ...value] = args[++index].split("=");
        env[key] = value.join("=");
      }
      registration = { command: commandLine[0], args: commandLine.slice(1), env };
      return { status: 0, stdout: "restored", stderr: "" };
    }
    throw new Error(`Unexpected fake command: ${[command, ...args].join(" ")}`);
  };

  assert.throws(() => installBundles([bundles[3]], {
    dataRoot,
    hosts: ["codex"],
    replace: true,
    runner,
    resolveCommand: (name) => name,
  }), /could not register.*add failed/i);

  assert.deepEqual(registration, {
    command: "old-node",
    args: ["old-server.js", "--legacy"],
    env: { API_TOKEN: "token-value", MODE: "legacy" },
  });
});

test("Codex replacement refuses unsupported registration metadata before removal", () => {
  const dataRoot = tempRoot();
  const calls = [];
  const runner = (command, args) => {
    calls.push([command, ...args]);
    if (args[1] === "get") {
      return {
        status: 0,
        stdout: JSON.stringify({
          name: "youtube-easy",
          enabled: true,
          disabled_reason: null,
          transport: {
            type: "stdio",
            command: "old-node",
            args: ["old-server.js"],
            env: { API_TOKEN: "token-value" },
            env_vars: [],
            cwd: "C:\\legacy-workdir",
          },
          enabled_tools: null,
          disabled_tools: null,
          startup_timeout_sec: 12,
          tool_timeout_sec: null,
        }),
        stderr: "",
      };
    }
    return { status: 0, stdout: "ok", stderr: "" };
  };

  assert.throws(() => installBundles([bundles[3]], {
    dataRoot,
    hosts: ["codex"],
    replace: true,
    runner,
    resolveCommand: (name) => name,
  }), /could not safely replace.*could not be preserved/i);
  assert.equal(calls.some((call) => call[2] === "remove"), false);
});

test("Claude replacement refuses environment or unknown metadata before removal", () => {
  for (const extra of [
    "Environment:\n  API_TOKEN: ***\n",
    "Working Directory: C:\\legacy-workdir\n",
  ]) {
    const dataRoot = tempRoot();
    const calls = [];
    const runner = (command, args) => {
      calls.push([command, ...args]);
      if (args[1] === "get") {
        return {
          status: 0,
          stdout: `youtube-easy:\nScope: User\nStatus: connected\nType: stdio\nCommand: old-node\nArgs: old-server.js\n${extra}`,
          stderr: "",
        };
      }
      return { status: 0, stdout: "ok", stderr: "" };
    };

    assert.throws(() => installBundles([bundles[3]], {
      dataRoot,
      hosts: ["claude"],
      replace: true,
      runner,
      resolveCommand: (name) => name,
    }), /could not safely replace.*could not be preserved/i);
    assert.equal(calls.some((call) => call[2] === "remove"), false, extra);
  }
});

test("Claude replacement accepts real user-config output with an empty Environment section", () => {
  const dataRoot = tempRoot();
  const calls = [];
  const runner = (command, args) => {
    calls.push([command, ...args]);
    if (args[1] === "get") {
      return {
        status: 0,
        stdout: [
          "youtube-easy:",
          "  Scope: User config (available in all your projects)",
          "  Status: connected",
          "  Type: stdio",
          "  Command: old-node",
          "  Args: old-server.js --legacy",
          "  Environment:",
          "",
        ].join("\n"),
        stderr: "",
      };
    }
    return { status: 0, stdout: "ok", stderr: "" };
  };

  const result = installBundles([bundles[3]], {
    dataRoot,
    hosts: ["claude"],
    replace: true,
    runner,
    resolveCommand: (name) => name,
  });

  assert.equal(result[0].registrations.claude, "installed");
  assert.equal(calls.some((call) => call[2] === "remove"), true);
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
  const wrapped = wrapHostExecutable("C:\\tools\\codex.cmd", {
    platform: "win32",
    env: { ComSpec: "C:\\Windows\\System32\\cmd.exe" },
  });
  assert.equal(wrapped.command, "C:\\Windows\\System32\\cmd.exe");
  assert.deepEqual(wrapped.prefix, ["/d", "/v:off", "/s", "/c"]);
  assert.equal(typeof wrapped.buildArgs, "function");
  assert.deepEqual(wrapHostExecutable("C:\\tools\\codex.exe", { platform: "win32", env: {} }), {
    command: "C:\\tools\\codex.exe",
    prefix: [],
  });
});

test("Windows cmd and bat host shims with spaces execute correctly", { skip: process.platform !== "win32" }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "easy mcp shim "));
  const dump = path.join(root, "dump-args.mjs");
  fs.writeFileSync(dump, "console.log(JSON.stringify(process.argv.slice(2)));\n");
  const cases = [
    ["space value", "a&b", "100%PATH%", "caret^value", "a|b", "a<b", "a>b", "(paren)"],
    ["", 'quote"value', "trail\\", "semi;colon", "comma,value", "star*question?"],
  ];
  for (const extension of [".cmd", ".bat"]) {
    const executable = path.join(root, `codex host${extension}`);
    for (const expected of cases) {
      const forwarded = expected.map((_, index) => `"%~${index + 1}"`).join(" ");
      fs.writeFileSync(executable, `@echo off\r\n"${process.execPath}" "${dump}" ${forwarded}\r\n`);
      const wrapped = wrapHostExecutable(executable, { platform: "win32", env: process.env });
      const run = spawnSync(wrapped.command, wrapped.buildArgs(expected), { encoding: "utf8", windowsHide: true, ...wrapped.spawnOptions });
      assert.equal(run.status, 0, `${extension}: ${run.stderr || run.stdout}`);
      assert.deepEqual(JSON.parse(run.stdout.trim()), expected, `${extension}: ${JSON.stringify(expected)}`);
    }
  }
});

test("verifies the registered command and entry path instead of trusting a receipt", () => {
  const entry = path.resolve("installed", "server.js");
  const codex = { status: 0, stdout: JSON.stringify({ transport: { type: "stdio", command: process.execPath, args: [entry] } }) };
  assert.equal(registrationMatches("codex", codex, entry), true);
  assert.equal(registrationMatches("codex", { ...codex, stdout: JSON.stringify({ transport: { type: "stdio", command: "wrong", args: [entry] } }) }, entry), false);
  const claude = { status: 0, stdout: `Scope: User\nType: stdio\nCommand: ${process.execPath}\nArgs: ${entry}\n` };
  assert.equal(registrationMatches("claude", claude, entry), true);
  assert.equal(registrationMatches("claude", { ...claude, stdout: "Command: wrong\nArgs: wrong\n" }, entry), false);
  assert.equal(registrationMatches("claude", { ...claude, stdout: `Command: ${process.execPath}\nArgs: ${entry}.backup\n` }, entry), false);
});
