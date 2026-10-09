import fs from "node:fs";
import path from "node:path";
import { inflateRawSync } from "node:zlib";

/** Minimal, dependency-free ZIP reader for the fixed MCPB test fixtures. */
function entries(archivePath) {
  const archive = fs.readFileSync(archivePath);
  const eocd = archive.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd < 0 || eocd + 22 > archive.length) throw new Error("Invalid ZIP end record");
  const count = archive.readUInt16LE(eocd + 10);
  let offset = archive.readUInt32LE(eocd + 16);
  const items = [];
  for (let i = 0; i < count; i++) {
    if (archive.readUInt32LE(offset) !== 0x02014b50) throw new Error("Invalid ZIP directory entry");
    const method = archive.readUInt16LE(offset + 10);
    const compressedLength = archive.readUInt32LE(offset + 20);
    const uncompressedLength = archive.readUInt32LE(offset + 24);
    const nameLength = archive.readUInt16LE(offset + 28);
    const extraLength = archive.readUInt16LE(offset + 30);
    const commentLength = archive.readUInt16LE(offset + 32);
    const localOffset = archive.readUInt32LE(offset + 42);
    const name = archive.toString("utf8", offset + 46, offset + 46 + nameLength);
    if (archive.readUInt32LE(localOffset) !== 0x04034b50) throw new Error("Invalid ZIP file record");
    const start = localOffset + 30 + archive.readUInt16LE(localOffset + 26) + archive.readUInt16LE(localOffset + 28);
    if (start + compressedLength > archive.length) throw new Error("Truncated ZIP entry");
    items.push({ name, method, uncompressedLength, data: archive.subarray(start, start + compressedLength) });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return items;
}

function unpack(item) {
  const output = item.method === 0 ? item.data : item.method === 8 ? inflateRawSync(item.data) : null;
  if (!output || output.length !== item.uncompressedLength) throw new Error(`Invalid ZIP compression/size: ${item.name}`);
  return output;
}

export function readZipEntry(archivePath, name) {
  const item = entries(archivePath).find((entry) => entry.name === name);
  if (!item) throw new Error(`Missing ZIP entry: ${name}`);
  return unpack(item);
}

export function extractZip(archivePath, destination) {
  const base = path.resolve(destination);
  for (const item of entries(archivePath)) {
    const segments = item.name.replace(/\\/g, "/").split("/").filter(Boolean);
    if (!segments.length || segments.some((segment) => segment === "." || segment === "..") || item.name.startsWith("/")) {
      throw new Error(`Unsafe ZIP path: ${item.name}`);
    }
    const target = path.resolve(base, ...segments);
    if (!target.startsWith(base + path.sep)) throw new Error(`ZIP traversal: ${item.name}`);
    if (item.name.endsWith("/")) { fs.mkdirSync(target, { recursive: true }); continue; }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, unpack(item));
  }
}
