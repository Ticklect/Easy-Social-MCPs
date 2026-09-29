import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { constants as zlibConstants, deflateRawSync } from "node:zlib";

const FIXED_DOS_TIME = 0;
const FIXED_DOS_DATE = 33; // 1980-01-01
const FIXED_EXTERNAL_ATTRIBUTES = (0o100644 << 16) >>> 0;
const SOURCE_ROOT_FILES = [
  "package.json",
  "package-lock.json",
  "tsconfig.json",
  "README.md",
  "LICENSE",
  "SKILL.md",
  "server.json",
];

function crcTable() {
  return Array.from({ length: 256 }, (_, number) => {
    let value = number;
    for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    return value >>> 0;
  });
}

const CRC_TABLE = crcTable();

function crc32(data) {
  let value = 0xffffffff;
  for (const byte of data) value = CRC_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

function compareNames(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function normalizeName(value) {
  return value.split(path.sep).join("/");
}

function normalizeTextBytes(data) {
  return Buffer.from(data.toString("utf8").replace(/\r\n/g, "\n").replace(/\r/g, "\n"), "utf8");
}

function shouldNormalizePackageText(name) {
  return !name.startsWith("app/node_modules/");
}

function excludedPackagePath(name) {
  return name === "app/node_modules/.bin" || name.startsWith("app/node_modules/.bin/");
}

function collectTree(root, relative = "", options = {}) {
  const directory = relative ? path.join(root, relative) : root;
  const items = fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => compareNames(a.name, b.name));
  const files = [];
  for (const item of items) {
    const childRelative = relative ? path.join(relative, item.name) : item.name;
    const name = normalizeName(childRelative);
    if (options.exclude?.(name)) continue;
    if (item.isSymbolicLink()) {
      throw new Error(`Refusing symbolic link in deterministic archive input: ${name}`);
    }
    if (item.isDirectory()) {
      files.push(...collectTree(root, childRelative, options));
      continue;
    }
    if (!item.isFile()) throw new Error(`Unsupported archive input type: ${name}`);
    let data = fs.readFileSync(path.join(root, childRelative));
    if (options.normalizeText?.(name)) data = normalizeTextBytes(data);
    files.push({ name, data });
  }
  return files;
}

function sourceEntries(sourceRoot) {
  const entries = collectTree(sourceRoot, "src", { normalizeText: () => true });
  for (const name of SOURCE_ROOT_FILES) {
    const file = path.join(sourceRoot, name);
    if (!fs.statSync(file).isFile()) throw new Error(`Expected source file: ${file}`);
    entries.push({ name, data: normalizeTextBytes(fs.readFileSync(file)) });
  }
  return entries.sort((a, b) => compareNames(a.name, b.name));
}

function packageEntries(packageRoot) {
  return collectTree(packageRoot, "", {
    exclude: excludedPackagePath,
    normalizeText: shouldNormalizePackageText,
  }).sort((a, b) => compareNames(a.name, b.name));
}

function makeZip(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const data = entry.data;
    const compressed = deflateRawSync(data, { level: 9, strategy: zlibConstants.Z_FIXED });
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(FIXED_DOS_TIME, 10);
    local.writeUInt16LE(FIXED_DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    localParts.push(local, name, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x0314, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(FIXED_DOS_TIME, 12);
    central.writeUInt16LE(FIXED_DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(FIXED_EXTERNAL_ATTRIBUTES, 38);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, name);

    offset += local.length + name.length + compressed.length;
  }

  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...localParts, centralDirectory, end]);
}

function sha256(data) {
  return crypto.createHash("sha256").update(data).digest("hex");
}

function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined) throw new Error(`Invalid argument near ${key || "(end)"}`);
    values[key.slice(2)] = value;
  }
  for (const required of ["package-root", "source-root", "out-dir", "version"]) {
    if (!values[required]) throw new Error(`Missing --${required}`);
  }
  return values;
}

export function buildRelease({ packageRoot, sourceRoot, outDir, version }) {
  const resolvedPackageRoot = path.resolve(packageRoot);
  const resolvedSourceRoot = path.resolve(sourceRoot);
  const resolvedOutDir = path.resolve(outDir);
  fs.mkdirSync(resolvedOutDir, { recursive: true });

  const mcpbName = `tiktok-easy-v${version}.mcpb`;
  const sourceName = `tiktok-easy-v${version}-source.zip`;
  const mcpb = makeZip(packageEntries(resolvedPackageRoot));
  const source = makeZip(sourceEntries(resolvedSourceRoot));
  const mcpbPath = path.join(resolvedOutDir, mcpbName);
  const sourcePath = path.join(resolvedOutDir, sourceName);
  fs.writeFileSync(mcpbPath, mcpb);
  fs.writeFileSync(sourcePath, source);
  const mcpbHash = sha256(mcpb);
  const sourceHash = sha256(source);
  fs.writeFileSync(`${mcpbPath}.sha256`, `${mcpbHash}  ${mcpbName}\n`);
  return { mcpbPath, sourcePath, mcpbHash, sourceHash };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  const args = parseArgs(process.argv.slice(2));
  const result = buildRelease({
    packageRoot: args["package-root"],
    sourceRoot: args["source-root"],
    outDir: args["out-dir"],
    version: args.version,
  });
  process.stdout.write(`${result.mcpbHash}  ${path.basename(result.mcpbPath)}\n`);
  process.stdout.write(`${result.sourceHash}  ${path.basename(result.sourcePath)}\n`);
}
