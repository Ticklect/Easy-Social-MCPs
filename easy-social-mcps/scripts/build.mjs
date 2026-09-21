import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const repoRoot = path.dirname(packageDir);
const version = "0.1.0";
const base = `easy-social-mcps-v${version}`;

function crcTable() {
  return Array.from({ length: 256 }, (_, number) => {
    let value = number;
    for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    return value >>> 0;
  });
}

const table = crcTable();
function crc32(data) {
  let value = 0xffffffff;
  for (const byte of data) value = table[(value ^ byte) & 0xff] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

function makeZip(entries) {
  const local = [];
  const central = [];
  let offset = 0;
  const dosDate = (46 << 9) | (1 << 5) | 1;
  for (const entry of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
    const name = Buffer.from(entry.name, "utf8");
    const data = entry.data;
    const crc = crc32(data);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0x0800, 6);
    header.writeUInt16LE(0, 8);
    header.writeUInt16LE(dosDate, 12);
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(data.length, 18);
    header.writeUInt32LE(data.length, 22);
    header.writeUInt16LE(name.length, 26);
    local.push(header, name, data);

    const directory = Buffer.alloc(46);
    directory.writeUInt32LE(0x02014b50, 0);
    directory.writeUInt16LE(0x0314, 4);
    directory.writeUInt16LE(20, 6);
    directory.writeUInt16LE(0x0800, 8);
    directory.writeUInt16LE(0, 10);
    directory.writeUInt16LE(dosDate, 14);
    directory.writeUInt32LE(crc, 16);
    directory.writeUInt32LE(data.length, 20);
    directory.writeUInt32LE(data.length, 24);
    directory.writeUInt16LE(name.length, 28);
    directory.writeUInt32LE((0o100644 << 16) >>> 0, 38);
    directory.writeUInt32LE(offset, 42);
    central.push(directory, name);
    offset += header.length + name.length + data.length;
  }
  const centralBytes = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBytes.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, centralBytes, end]);
}

function sha256(data) {
  return crypto.createHash("sha256").update(data).digest("hex");
}

const sources = [
  ["README.md", path.join(packageDir, "README.md"), true],
  ["LICENSE", path.join(repoRoot, "LICENSE"), true],
  ["install-easy-mcp.mjs", path.join(repoRoot, "easy-mcp-installer", "install-easy-mcp.mjs"), true],
  ["reddit-easy-v0.3.1.mcpb", path.join(repoRoot, "reddit-easy-v0.3.1.mcpb"), false],
  ["x-easy-v0.1.0.mcpb", path.join(repoRoot, "x-easy", "x-easy-v0.1.0.mcpb"), false],
  ["tiktok-easy-v0.1.0.mcpb", path.join(repoRoot, "tiktok-easy", "tiktok-easy-v0.1.0.mcpb"), false],
  ["youtube-easy-v0.1.0.mcpb", path.join(repoRoot, "youtube-easy", "youtube-easy-v0.1.0.mcpb"), false],
];

const entries = sources.map(([name, source, text]) => ({
  name,
  data: text
    ? Buffer.from(fs.readFileSync(source, "utf8").replace(/\r\n?/g, "\n"))
    : fs.readFileSync(source),
}));
const checksummed = entries.filter((entry) => entry.name === "install-easy-mcp.mjs" || entry.name.endsWith(".mcpb"));
entries.push({
  name: "SHA256SUMS.txt",
  data: Buffer.from(checksummed.map((entry) => `${sha256(entry.data)}  ${entry.name}`).sort().join("\n") + "\n"),
});

const outputIndex = process.argv.indexOf("--out");
if (outputIndex >= 0 && !process.argv[outputIndex + 1]) throw new Error("--out requires a directory.");
const output = path.resolve(outputIndex >= 0 ? process.argv[outputIndex + 1] : packageDir);
fs.mkdirSync(output, { recursive: true });
const archivePath = path.join(output, `${base}.zip`);
const archive = makeZip(entries);
fs.writeFileSync(archivePath, archive);
const hash = sha256(archive);
fs.writeFileSync(`${archivePath}.sha256`, `${hash}  ${base}.zip\n`);
console.log(`Built ${archivePath}`);
console.log(`SHA-256 ${hash}`);
