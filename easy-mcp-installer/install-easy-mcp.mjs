#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import zlib from "node:zlib";
import { pathToFileURL } from "node:url";

const MAX_ENTRIES = 20_000;
const MAX_UNPACKED_BYTES = 512 * 1024 * 1024;
const HOSTS = new Set(["codex", "claude"]);

const CRC_TABLE = Array.from({ length: 256 }, (_, number) => {
  let value = number;
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});

function crc32(data) {
  let value = 0xffffffff;
  for (const byte of data) value = CRC_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

export function assertSupportedNode(version = process.versions.node) {
  const major = Number.parseInt(String(version).split(".", 1)[0], 10);
  if (!Number.isInteger(major) || major < 22) throw new Error("Easy MCP Installer requires Node.js 22 or newer.");
}

export function normalizeArchivePath(name) {
  if (typeof name !== "string" || !name || name.includes("\0")) throw new Error("Unsafe archive path.");
  const portable = name.replaceAll("\\", "/");
  if (portable.startsWith("/") || /^[A-Za-z]:\//.test(portable)) throw new Error(`Unsafe archive path: ${name}`);
  if (portable.split("/").includes("..")) throw new Error(`Unsafe archive path: ${name}`);
  const normalized = path.posix.normalize(portable);
  if (normalized === ".." || normalized.startsWith("../") || normalized.split("/").includes("..")) {
    throw new Error(`Unsafe archive path: ${name}`);
  }
  return normalized.replace(/^\.\//, "");
}

function zipEntries(buffer) {
  const signature = Buffer.from([0x50, 0x4b, 0x05, 0x06]);
  const end = buffer.lastIndexOf(signature);
  if (end < 0 || end + 22 > buffer.length) throw new Error("Invalid MCPB ZIP: end record not found.");
  const count = buffer.readUInt16LE(end + 10);
  if (count > MAX_ENTRIES) throw new Error(`MCPB contains too many entries (${count}).`);
  let offset = buffer.readUInt32LE(end + 16);
  let total = 0;
  const entries = new Map();
  for (let index = 0; index < count; index++) {
    if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== 0x02014b50) throw new Error("Invalid MCPB ZIP central directory.");
    const flags = buffer.readUInt16LE(offset + 8);
    const method = buffer.readUInt16LE(offset + 10);
    const expectedCrc = buffer.readUInt32LE(offset + 16);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const uncompressedSize = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const externalAttributes = buffer.readUInt32LE(offset + 38);
    const localOffset = buffer.readUInt32LE(offset + 42);
    if (flags & 0x1) throw new Error("Encrypted MCPB entries are not supported.");
    if (![0, 8].includes(method)) throw new Error(`Unsupported MCPB ZIP compression method ${method}.`);
    const nameEnd = offset + 46 + nameLength;
    if (nameEnd > buffer.length) throw new Error("Invalid MCPB ZIP entry name.");
    const originalName = buffer.subarray(offset + 46, nameEnd).toString("utf8");
    const name = normalizeArchivePath(originalName);
    const isDirectory = originalName.endsWith("/");
    const unixMode = externalAttributes >>> 16;
    if (!isDirectory && (unixMode & 0o170000) === 0o120000) throw new Error(`MCPB symlinks are not allowed: ${name}`);
    if (localOffset + 30 > buffer.length || buffer.readUInt32LE(localOffset) !== 0x04034b50) throw new Error("Invalid MCPB ZIP local entry.");
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const start = localOffset + 30 + localNameLength + localExtraLength;
    const finish = start + compressedSize;
    if (finish > buffer.length) throw new Error(`Invalid MCPB ZIP data for ${name}.`);
    total += uncompressedSize;
    if (total > MAX_UNPACKED_BYTES) throw new Error("MCPB expands beyond the 512 MiB safety limit.");
    if (!isDirectory) {
      const compressed = buffer.subarray(start, finish);
      const data = method === 0 ? Buffer.from(compressed) : zlib.inflateRawSync(compressed, { maxOutputLength: uncompressedSize });
      if (data.length !== uncompressedSize) throw new Error(`MCPB size mismatch for ${name}.`);
      if (crc32(data) !== expectedCrc) throw new Error(`MCPB CRC mismatch for ${name}.`);
      if (entries.has(name)) throw new Error(`MCPB contains duplicate path: ${name}`);
      entries.set(name, data);
    }
    offset = nameEnd + extraLength + commentLength;
  }
  return entries;
}

function validateManifest(manifest, entries, bundlePath) {
  if (!manifest || typeof manifest !== "object") throw new Error(`${bundlePath}: manifest.json must contain an object.`);
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(manifest.name || "")) throw new Error(`${bundlePath}: invalid MCP server name.`);
  if (!/^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$/.test(manifest.version || "")) throw new Error(`${bundlePath}: invalid version.`);
  if (manifest.server?.type !== "node" || manifest.server?.mcp_config?.command !== "node") {
    throw new Error(`${bundlePath}: only bundled Node MCP servers are supported.`);
  }
  const entryPoint = normalizeArchivePath(manifest.server?.entry_point || "");
  if (!entries.has(entryPoint)) throw new Error(`${bundlePath}: entry point ${entryPoint} is missing.`);
  return { name: manifest.name, displayName: manifest.display_name || manifest.name, version: manifest.version, entryPoint, command: "node" };
}

export function inspectBundle(bundlePath) {
  const absolute = path.resolve(bundlePath);
  const buffer = fs.readFileSync(absolute);
  const entries = zipEntries(buffer);
  const manifestBytes = entries.get("manifest.json");
  if (!manifestBytes) throw new Error(`${absolute}: manifest.json is missing.`);
  let manifest;
  try { manifest = JSON.parse(manifestBytes.toString("utf8")); }
  catch { throw new Error(`${absolute}: manifest.json is invalid JSON.`); }
  return {
    ...validateManifest(manifest, entries, absolute),
    bundlePath: absolute,
    sha256: crypto.createHash("sha256").update(buffer).digest("hex"),
    entries,
  };
}

function defaultDataRoot(platform = process.platform, env = process.env) {
  if (platform === "win32") return path.join(env.LOCALAPPDATA || env.APPDATA || os.homedir(), "EasyMCP");
  if (platform === "darwin") return path.join(os.homedir(), "Library", "Application Support", "EasyMCP");
  return path.join(env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share"), "easy-mcp");
}

function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, file);
}

function extractBundle(bundle, dataRoot) {
  const target = path.join(dataRoot, "servers", bundle.name, bundle.version);
  const marker = path.join(target, ".easy-mcp-install.json");
  if (fs.existsSync(target)) {
    let installed;
    try { installed = JSON.parse(fs.readFileSync(marker, "utf8")); } catch {}
    if (installed?.sha256 !== bundle.sha256) {
      throw new Error(`${target} already exists but is not the same managed bundle. Refusing to overwrite it.`);
    }
    return { target, entryPath: path.join(target, ...bundle.entryPoint.split("/")) };
  }
  const parent = path.dirname(target);
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  const temporary = path.join(parent, `.${bundle.version}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`);
  fs.mkdirSync(temporary, { mode: 0o700 });
  try {
    for (const [name, bytes] of bundle.entries) {
      const destination = path.resolve(temporary, ...name.split("/"));
      const relative = path.relative(temporary, destination);
      if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error(`Unsafe archive path: ${name}`);
      fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
      fs.writeFileSync(destination, bytes, { mode: 0o600 });
    }
    writeJsonAtomic(path.join(temporary, ".easy-mcp-install.json"), {
      name: bundle.name,
      version: bundle.version,
      sha256: bundle.sha256,
      source: path.basename(bundle.bundlePath),
    });
    fs.renameSync(temporary, target);
  } catch (error) {
    fs.rmSync(temporary, { recursive: true, force: true });
    throw error;
  }
  return { target, entryPath: path.join(target, ...bundle.entryPoint.split("/")) };
}

function defaultRunner(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8", windowsHide: true });
  if (result.error?.code === "ENOENT") return { status: 127, stdout: "", stderr: `${command} was not found.` };
  if (result.error) throw result.error;
  return { status: result.status ?? 1, stdout: result.stdout || "", stderr: result.stderr || "" };
}

export function wrapHostExecutable(executable, { platform = process.platform, env = process.env } = {}) {
  const extension = path.extname(executable).toLowerCase();
  if (platform === "win32" && extension === ".ps1") {
    const powershell = env.SystemRoot
      ? path.win32.join(env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
      : "powershell.exe";
    return { command: powershell, prefix: ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", executable] };
  }
  if (platform === "win32" && [".cmd", ".bat"].includes(extension)) {
    return { command: env.ComSpec || "cmd.exe", prefix: ["/d", "/s", "/c", executable] };
  }
  return { command: executable, prefix: [] };
}

function findHostExecutable(name, { platform = process.platform, env = process.env, exists = fs.existsSync } = {}) {
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  const delimiter = platform === "win32" ? ";" : ":";
  const suffixes = platform === "win32" ? [".exe", ".com", ".ps1", ".cmd", ".bat"] : [""];
  for (const directory of String(env.PATH || env.Path || "").split(delimiter).filter(Boolean)) {
    for (const suffix of suffixes) {
      const candidate = pathApi.join(directory.replace(/^"|"$/g, ""), `${name}${suffix}`);
      if (exists(candidate)) return candidate;
    }
  }
  return null;
}

function defaultResolveCommand(name) {
  const executable = findHostExecutable(name);
  if (!executable) throw new Error(`${name} is not installed or is not on PATH.`);
  const wrapped = wrapHostExecutable(executable);
  const probe = defaultRunner(wrapped.command, [...wrapped.prefix, "--version"]);
  if (probe.status !== 0) throw new Error(`${name} was found but could not run: ${probe.stderr || probe.stdout}`);
  return wrapped;
}

function runResolved(runner, resolved, args) {
  if (typeof resolved === "string") return runner(resolved, args);
  return runner(resolved.command, [...(resolved.prefix || []), ...args]);
}

function registrationArgs(host, action, name, entryPath) {
  if (action === "get") return host === "codex" ? ["mcp", "get", name, "--json"] : ["mcp", "get", name];
  if (action === "remove") return host === "claude" ? ["mcp", "remove", name, "--scope", "user"] : ["mcp", "remove", name];
  if (host === "claude") return ["mcp", "add", "--scope", "user", "--transport", "stdio", name, "--", process.execPath, entryPath];
  return ["mcp", "add", name, "--", process.execPath, entryPath];
}

function comparablePath(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  const cleaned = value.trim().replace(/^['"]|['"]$/g, "");
  const resolved = path.resolve(cleaned);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

export function registrationMatches(host, result, entryPath) {
  if (result?.status !== 0) return false;
  const expectedCommand = comparablePath(process.execPath);
  const expectedEntry = comparablePath(entryPath);
  if (host === "codex") {
    try {
      const configured = JSON.parse(result.stdout);
      const transport = configured?.transport;
      return transport?.type === "stdio"
        && comparablePath(transport.command) === expectedCommand
        && Array.isArray(transport.args)
        && transport.args.length === 1
        && comparablePath(transport.args[0]) === expectedEntry;
    } catch {
      return false;
    }
  }
  const command = result.stdout.match(/^\s*Command:\s*(.+?)\s*$/im)?.[1];
  const args = result.stdout.match(/^\s*Args:\s*(.+?)\s*$/im)?.[1];
  if (comparablePath(command) !== expectedCommand || !args) return false;
  const normalizedArgs = process.platform === "win32" ? args.toLowerCase() : args;
  return normalizedArgs.includes(expectedEntry);
}

function missingRegistration(result) {
  if (result?.status === 0) return false;
  return /not found|does not exist|no MCP server|not configured|unknown server/i.test(`${result?.stderr || ""}\n${result?.stdout || ""}`);
}

function registerHost(bundle, entryPath, { dataRoot, host, replace, runner, resolveCommand }) {
  const executable = resolveCommand(host);
  const receipt = path.join(dataRoot, "registrations", host, `${bundle.name}.json`);
  let managed;
  try { managed = JSON.parse(fs.readFileSync(receipt, "utf8")); } catch {}
  const desired = { name: bundle.name, version: bundle.version, sha256: bundle.sha256, entryPath };
  const get = runResolved(runner, executable, registrationArgs(host, "get", bundle.name));
  if (get.status === 0) {
    const sameReceipt = managed?.sha256 === desired.sha256 && comparablePath(managed.entryPath) === comparablePath(entryPath);
    if (!replace && sameReceipt && registrationMatches(host, get, entryPath)) return "already-installed";
    if (!replace) throw new Error(`${bundle.name} already exists in ${host}. Re-run with --replace to replace that registration.`);
    const removed = runResolved(runner, executable, registrationArgs(host, "remove", bundle.name));
    if (removed.status !== 0) throw new Error(`Could not remove existing ${bundle.name} registration from ${host}: ${removed.stderr || removed.stdout}`);
  } else if (missingRegistration(get)) {
    // The host no longer has the entry, so the stale receipt is safe to repair.
    managed = undefined;
  } else {
    throw new Error(`Could not inspect ${bundle.name} in ${host}: ${get.stderr || get.stdout || `exit ${get.status}`}`);
  }
  const added = runResolved(runner, executable, registrationArgs(host, "add", bundle.name, entryPath));
  if (added.status !== 0) throw new Error(`Could not register ${bundle.name} with ${host}: ${added.stderr || added.stdout}`);
  writeJsonAtomic(receipt, { ...desired, host, installedAt: new Date().toISOString() });
  return "installed";
}

export function installBundles(bundlePaths, {
  dataRoot = defaultDataRoot(),
  hosts,
  replace = false,
  runner = defaultRunner,
  resolveCommand = defaultResolveCommand,
} = {}) {
  assertSupportedNode();
  if (!Array.isArray(bundlePaths) || !bundlePaths.length) throw new Error("At least one .mcpb bundle is required.");
  if (!Array.isArray(hosts) || !hosts.length || hosts.some((host) => !HOSTS.has(host))) throw new Error("Choose codex, claude, or both hosts.");
  const absoluteRoot = path.resolve(dataRoot);
  fs.mkdirSync(absoluteRoot, { recursive: true, mode: 0o700 });
  const seen = new Set();
  const results = [];
  for (const bundlePath of bundlePaths) {
    const bundle = inspectBundle(bundlePath);
    if (seen.has(bundle.name)) throw new Error(`Duplicate bundle name in one install: ${bundle.name}`);
    seen.add(bundle.name);
    const extracted = extractBundle(bundle, absoluteRoot);
    const registrations = {};
    for (const host of hosts) registrations[host] = registerHost(bundle, extracted.entryPath, { dataRoot: absoluteRoot, host, replace, runner, resolveCommand });
    results.push({ name: bundle.name, version: bundle.version, installDir: extracted.target, entryPath: extracted.entryPath, registrations });
  }
  return results;
}

export function parseArguments(argv) {
  const bundles = [];
  let hosts;
  let replace = false;
  let dataRoot;
  for (let index = 0; index < argv.length; index++) {
    const value = argv[index];
    if (value === "--host") {
      const host = argv[++index];
      if (host === "both") hosts = ["codex", "claude"];
      else if (HOSTS.has(host)) hosts = [host];
      else throw new Error("--host must be codex, claude, or both.");
    } else if (value === "--replace") replace = true;
    else if (value === "--data-root") {
      if (!argv[index + 1]) throw new Error("--data-root requires a path.");
      dataRoot = path.resolve(argv[++index]);
    } else if (value === "--help" || value === "-h") throw new Error("usage");
    else if (value.startsWith("-")) throw new Error(`Unknown option: ${value}`);
    else bundles.push(path.resolve(value));
  }
  if (!hosts || !bundles.length) throw new Error("Usage: node install-easy-mcp.mjs --host codex|claude|both [--replace] bundle.mcpb [...]");
  return { bundles, hosts, replace, dataRoot };
}

function printUsage() {
  console.error("Usage: node install-easy-mcp.mjs --host codex|claude|both [--replace] bundle.mcpb [...]");
}

const isEntry = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isEntry) {
  try {
    const options = parseArguments(process.argv.slice(2));
    const results = installBundles(options.bundles, options);
    for (const result of results) {
      const states = Object.entries(result.registrations).map(([host, state]) => `${host}: ${state}`).join(", ");
      console.log(`${result.name} ${result.version} (${states})`);
    }
    console.log("Restart Codex/Claude Code, then ask it to check the service status or start login.");
  } catch (error) {
    if (error.message === "usage") printUsage();
    else console.error(`Easy MCP install failed: ${error.message}`);
    process.exitCode = 1;
  }
}
