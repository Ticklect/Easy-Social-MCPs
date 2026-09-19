import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const version = "0.1.0";
const artifactBase = `youtube-easy-v${version}`;

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

function collect(directory, prefix = "") {
  const output = [];
  for (const item of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const disk = path.join(directory, item.name);
    const name = prefix ? `${prefix}/${item.name}` : item.name;
    if (item.isDirectory()) output.push(...collect(disk, name));
    else if (item.isFile()) output.push({ name, data: fs.readFileSync(disk) });
  }
  return output;
}

function makeZip(entries) {
  const local = [];
  const central = [];
  let offset = 0;
  const dosDate = (46 << 9) | (1 << 5) | 1; // 2026-01-01
  const dosTime = 0;
  for (const entry of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
    const name = Buffer.from(entry.name.replaceAll("\\", "/"), "utf8");
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data);
    const crc = crc32(data);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0x0800, 6);
    header.writeUInt16LE(0, 8);
    header.writeUInt16LE(dosTime, 10);
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
    directory.writeUInt16LE(dosTime, 12);
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

function file(name, archiveName = name) {
  return { name: archiveName, data: fs.readFileSync(path.join(root, name)) };
}

const outIndex = process.argv.indexOf("--out");
const outDir = path.resolve(outIndex >= 0 ? process.argv[outIndex + 1] : root);
if (outIndex >= 0 && !process.argv[outIndex + 1]) throw new Error("--out requires a directory.");
fs.mkdirSync(outDir, { recursive: true });

const runtime = collect(path.join(root, "src"), "dist");
const packageEntries = [
  file("manifest.json"), file("package.json"), file("README.md"), file("SECURITY.md"),
  file("LICENSE"), file("THIRD_PARTY_LICENSES.md"), ...runtime,
];
const sourceEntries = [
  file("manifest.json"), file("package.json"), file("README.md"), file("SECURITY.md"),
  file("LICENSE"), file("THIRD_PARTY_LICENSES.md"), ...collect(path.join(root, "src"), "src"),
  ...collect(path.join(root, "test"), "test"), ...collect(path.join(root, "scripts"), "scripts"),
];

const mcpbPath = path.join(outDir, `${artifactBase}.mcpb`);
const sourcePath = path.join(outDir, `${artifactBase}-source.zip`);
fs.writeFileSync(mcpbPath, makeZip(packageEntries));
fs.writeFileSync(sourcePath, makeZip(sourceEntries));
const hash = crypto.createHash("sha256").update(fs.readFileSync(mcpbPath)).digest("hex");
fs.writeFileSync(path.join(outDir, `${artifactBase}.mcpb.sha256`), `${hash}  ${artifactBase}.mcpb\n`);
console.log(`Built ${path.relative(process.cwd(), mcpbPath) || path.basename(mcpbPath)}`);
console.log(`SHA-256 ${hash}`);
