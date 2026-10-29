/** Add bounded discovery probes and remove redundant initial-post discovery. */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
fs.copyFileSync(path.join(root, "scripts", "browser-discovery-v0.1.6.ts"),
  "src/runtime/browser-discovery.ts");

const filename = "src/server.ts";
let source = fs.readFileSync(filename, "utf8");
const before = 'version: "0.1.5" }';
if (!source.includes(before)) throw new Error("Missing TikTok 0.1.5 server version target");
source = source.replace(before, 'version: "0.1.6" }');

// connect({existing_browser_only:true}) itself performs fresh discovery and
// rejects missing/ambiguous sessions before the QR relay is even considered.
// A preflight probe immediately before it queried the same OS processes again,
// adding latency without making the eventual connection safer.
const importBefore = 'import { shouldReuseExistingBrowser } from "./runtime/social-runtime.js";\n';
if (!source.includes(importBefore)) throw new Error("Missing TikTok 0.1.5 preflight import");
source = source.replace(importBefore, "");
const preflight = `        if (!await shouldReuseExistingBrowser()) {
          throw new Error("TikTok Easy cannot find an accessible existing signed-in browser debugger. No QR login or separate profile was opened. Use a Chromium browser already exposing full local CDP, or explicitly run tiktok_login if you want QR login in a dedicated profile.");
        }
`;
if (!source.includes(preflight)) throw new Error("Missing TikTok 0.1.5 redundant preflight");
source = source.replace(preflight, "");
fs.writeFileSync(filename, source);
