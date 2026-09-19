import path from "node:path";

const ALLOWED_ROOTS = [
  "youtube.com",
  "youtu.be",
  "google.com",
  "googleusercontent.com",
  "gstatic.com",
];

function onAllowedHost(hostname) {
  const host = String(hostname || "").toLowerCase().replace(/\.$/, "");
  return ALLOWED_ROOTS.some((root) => host === root || host.endsWith(`.${root}`));
}

export function parseGoogleYoutubeUrl(value) {
  let url;
  try { url = new URL(String(value)); }
  catch { throw new Error("Expected a valid HTTPS Google/YouTube URL."); }
  if (url.protocol !== "https:" || !onAllowedHost(url.hostname)) {
    throw new Error("Expected a valid HTTPS Google/YouTube URL on an approved host.");
  }
  return url;
}

function isLoopback(hostname) {
  const host = String(hostname || "").toLowerCase();
  return host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "[::1]";
}

export function validateDebuggerWs(value, expectedPort) {
  let url;
  try { url = new URL(String(value)); }
  catch { throw new Error("Browser returned an invalid debugger WebSocket URL."); }
  if (url.protocol !== "ws:" && url.protocol !== "wss:") {
    throw new Error("Browser debugger URL must be a WebSocket URL.");
  }
  if (!isLoopback(url.hostname)) throw new Error("Refusing a non-local browser debugger connection.");
  if (!Number.isInteger(Number(expectedPort)) || Number(url.port) !== Number(expectedPort)) {
    throw new Error("Browser debugger port did not match the dedicated profile port.");
  }
  return url.href;
}

function objectArg(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Tool arguments must be an object.");
  return value;
}

function requiredString(args, name, max) {
  const value = args[name];
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} is required and cannot be blank.`);
  if (Array.from(value).length > max) throw new Error(`${name} cannot exceed ${max.toLocaleString("en-US")} characters.`);
  return value;
}

function optionalString(args, name, max) {
  const value = args[name];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new Error(`${name} must be a string.`);
  if (Array.from(value).length > max) throw new Error(`${name} cannot exceed ${max.toLocaleString("en-US")} characters.`);
  return value;
}

function regularFile(fsApi, value, label) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} is required.`);
  let canonical;
  let stat;
  try {
    canonical = fsApi.realpathSync(path.resolve(value));
    stat = fsApi.statSync(canonical);
  } catch {
    throw new Error(`${label} does not exist or cannot be read.`);
  }
  if (!stat.isFile()) throw new Error(`${label} must resolve to a regular file.`);
  return { path: canonical, size: Number(stat.size), mtimeMs: Number(stat.mtimeMs || 0) };
}

function validatePublishAt(value) {
  if (typeof value !== "string" || !value.trim()) throw new Error("publish_at must be an ISO-8601 timestamp.");
  if (!/(?:Z|[+-]\d{2}:\d{2})$/i.test(value)) throw new Error("publish_at must include an explicit UTC offset or Z.");
  if (!Number.isFinite(Date.parse(value))) throw new Error("publish_at must be a valid ISO-8601 timestamp.");
  return value;
}

export function validateUploadInput(value, fsApi) {
  const args = objectArg(value);
  if (!fsApi?.realpathSync || !fsApi?.statSync) throw new Error("A filesystem implementation is required.");
  const file = regularFile(fsApi, args.file_path, "file_path");
  const title = requiredString(args, "title", 100);
  const description = optionalString(args, "description", 5_000) ?? "";
  if (!["private", "unlisted", "public"].includes(args.visibility)) {
    throw new Error("visibility must be private, unlisted, or public.");
  }
  if (typeof args.made_for_kids !== "boolean") throw new Error("made_for_kids must be explicitly true or false.");

  let publishAt;
  if (args.publish_at !== undefined) {
    publishAt = validatePublishAt(args.publish_at);
    if (args.visibility !== "public") throw new Error("A scheduled upload must have visibility public; it remains private until publication.");
  }

  let thumbnail;
  if (args.thumbnail_path !== undefined) thumbnail = regularFile(fsApi, args.thumbnail_path, "thumbnail_path");
  const playlist = optionalString(args, "playlist", 150);
  let tags = [];
  if (args.tags !== undefined) {
    if (!Array.isArray(args.tags) || args.tags.some((tag) => typeof tag !== "string" || !tag.trim())) {
      throw new Error("tags must be an array of non-blank strings.");
    }
    tags = args.tags.map((tag) => tag.trim());
    if (tags.join(",").length > 500) throw new Error("tags cannot exceed 500 total characters.");
  }

  return {
    filePath: file.path,
    fileSize: file.size,
    fileMtimeMs: file.mtimeMs,
    title,
    description,
    visibility: args.visibility,
    madeForKids: args.made_for_kids,
    ...(publishAt ? { publishAt } : {}),
    ...(thumbnail ? { thumbnailPath: thumbnail.path, thumbnailSize: thumbnail.size } : {}),
    ...(playlist !== undefined ? { playlist } : {}),
    tags,
  };
}

export function validateShortMetadata(value) {
  const metadata = objectArg(value);
  const duration = Number(metadata.duration);
  const width = Number(metadata.width);
  const height = Number(metadata.height);
  if (!(duration > 0) || !(width > 0) || !(height > 0)) {
    throw new Error("Short media metadata could not be verified.");
  }
  if (duration > 180) throw new Error("A YouTube Short cannot exceed 180 seconds.");
  if (width > height) throw new Error("A YouTube Short must be square or vertical.");
  return { duration, width, height };
}

export { onAllowedHost as isApprovedGoogleYoutubeHost };
