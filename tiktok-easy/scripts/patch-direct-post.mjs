/** Add direct, existing-session posting to the pinned TikTok v0.1.4 runtime. */
import fs from "node:fs";

function replaceOnce(source, before, after, label) {
  if (!source.includes(before)) throw new Error(`Missing TikTok v0.1.5 patch target: ${label}`);
  return source.replace(before, after);
}

{
  const filename = "src/server.ts";
  let source = fs.readFileSync(filename, "utf8");
  source = replaceOnce(source,
    'import { LocalTikTokRuntime } from "./runtime/local-runtime.js";',
    'import { LocalTikTokRuntime } from "./runtime/local-runtime.js";\nimport { shouldReuseExistingBrowser } from "./runtime/social-runtime.js";',
    "browser discovery import");
  source = replaceOnce(source,
    'version: "0.1.4" }',
    'version: "0.1.5" }',
    "server version");
  source = replaceOnce(source,
    'description: "Publish a local video through the connected browser profile, or use TikTok\'s native scheduler.",\n    inputSchema: {\n      account_id: ACCOUNT_ID,',
    'description: "Post a video directly using the currently signed-in TikTok account on an accessible existing browser debugger. On the first post the account is verified automatically, with no tiktok_login step and no automatic QR login. TikTok\'s native scheduler is also supported.",\n    inputSchema: {\n      account_id: ACCOUNT_ID.default("default"),',
    "direct post tool schema");
  const postHandler = /}, \(args\) => \{\r?\n\s+requireOne\(args, \["video_path", "video_url", "video_base64"\]\);\r?\n\s+return runtime\.post\(args\);/;
  if (!postHandler.test(source)) throw new Error("Missing TikTok v0.1.5 patch target: direct posting handler");
  source = source.replace(postHandler,
    `}, async (args) => {
      requireOne(args, ["video_path", "video_url", "video_base64"]);
      if (args.account_id === "default" &&
          !runtime.accounts().accounts.some((account) => account.id === "default" && account.status === "active")) {
        if (!await shouldReuseExistingBrowser()) {
          throw new Error("TikTok Easy cannot find an accessible existing signed-in browser debugger. No QR login or separate profile was opened. Use a Chromium browser already exposing full local CDP, or explicitly run tiktok_login if you want QR login in a dedicated profile.");
        }
        const verified = await runtime.connect({ account_id: "default", existing_browser_only: true });
        if (verified.status !== "done" || !("reused_browser" in verified) || !verified.reused_browser) {
          throw new Error("The TikTok browser account could not be verified; no post was submitted.");
        }
      }
      return runtime.post(args);`);
  fs.writeFileSync(filename, source);
}

{
  const filename = "src/runtime/local-runtime.ts";
  let source = fs.readFileSync(filename, "utf8");
  source = replaceOnce(source,
    "  async connect(input: ConnectInput) {",
    "  async connect(input: ConnectInput & { existing_browser_only?: boolean }) {",
    "only approved sessions for auto post");
  source = replaceOnce(source,
    "    const relay = await this.qrRelay.create();",
    `    if (input.existing_browser_only) {
      throw new Error("No accessible signed-in TikTok browser debugger was found. QR login was not started.");
    }
    const relay = await this.qrRelay.create();`,
    "never automatically open QR relay if browser disappears");
  fs.writeFileSync(filename, source);
}
