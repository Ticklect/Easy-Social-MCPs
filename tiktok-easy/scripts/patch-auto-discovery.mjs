/** Upgrade immutable v0.1.3 runtime with safe Windows browser auto discovery. */
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

function replaceOnce(source, before, after, label) {
  if (!source.includes(before)) throw new Error("Missing TikTok auto-discovery patch target: " + label);
  return source.replace(before, after);
}

fs.copyFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "browser-discovery.ts"),
  "src/runtime/browser-discovery.ts");

{
  const filename = "src/runtime/store.ts";
  let s = fs.readFileSync(filename, "utf8");
  s = replaceOnce(s, '  last_connected_at?: string;',
    '  last_connected_at?: string;\n  /** Public profile handle used to prevent actions on the wrong browser account. */\n  browser_profile_name?: string;',
    "account profile binding");
  fs.writeFileSync(filename, s);
}

{
  const filename = "src/runtime/social-runtime.ts";
  let s = fs.readFileSync(filename, "utf8");
  s = replaceOnce(s, 'import { profileDir } from "./store.js";',
    'import { getAccount, profileDir } from "./store.js";\nimport { discoverOpenBrowserPort } from "./browser-discovery.js";',
    "discovery and binding imports");
  s = replaceOnce(s,
    'export function existingBrowserConfigured(): boolean {',
    `export async function findUsableExistingBrowserPort(): Promise<number | null> {
  const explicit = existingBrowserPort();
  if (explicit) return explicit;
  return discoverOpenBrowserPort();
}

export async function shouldReuseExistingBrowser(): Promise<boolean> {
  return existingBrowserConfigured() || Boolean(await discoverOpenBrowserPort());
}

export function existingBrowserConfigured(): boolean {`,
    "automatic and explicit browser resolution");
  s = replaceOnce(s,
    'export interface LaunchLocalContextOptions {\n  accountId: string;',
    'export interface LaunchLocalContextOptions {\n  accountId: string;\n  externalBrowserPort?: number;\n  /** Login rebinds the account identity after checking the signed-in profile. */\n  skipAccountIdentityCheck?: boolean;',
    "safe account verification options");
  s = replaceOnce(s,
    '  try { externalPort = existingBrowserPort(); }',
    '  try { externalPort = opts.externalBrowserPort || await findUsableExistingBrowserPort(); }',
    "discover browser on each operation");
  s = replaceOnce(s,
    '  if (!externalPort && existingBrowserConfigured()) {',
    `  if (externalPort && opts.accountId !== "default") {
    release();
    throw new Error('Existing browser mode supports only account_id "default".');
  }
  if (!externalPort && existingBrowserConfigured()) {`,
    "reject external account aliases");
  s = replaceOnce(s,
    '      const originalContext = externalBrowser.contexts()[0];',
    '      if (externalBrowser.contexts().length !== 1) throw new Error("Multiple browser contexts are open; refusing to guess the signed-in account.");\n      const originalContext = externalBrowser.contexts()[0];',
    "reject ambiguous browser contexts");
  s = replaceOnce(s,
    '    await blockHeavyResources(page, opts.loadMedia === true);',
    `    await blockHeavyResources(page, opts.loadMedia === true);
    if (externalBrowser && !opts.skipAccountIdentityCheck) {
      const bound = getAccount(opts.accountId)?.browser_profile_name;
      if (!bound) throw new Error("Existing browser TikTok identity has not been verified. Run tiktok_login to bind the signed-in account first.");
      await page.goto("https://www.tiktok.com/", { waitUntil: "domcontentloaded", timeout: 60_000 });
      const actual = await signedInProfileName(page);
      if (!actual || actual.toLowerCase() !== bound.toLowerCase()) {
        throw new Error("Connected TikTok account differs from the account previously verified. Run tiktok_login again before any action.");
      }
    }`,
    "verify username before every operation");
  s = replaceOnce(s,
    'export interface LaunchLocalContextOptions {',
    `/** Reads only the public profile link from our own TikTok tab. */
export async function signedInProfileName(page: Page): Promise<string | null> {
  const profile = page.locator('a[data-e2e="nav-profile"]').first();
  if (!await profile.isVisible({ timeout: 10_000 }).catch(() => false)) return null;
  const href = await profile.getAttribute("href", { timeout: 5_000 }).catch(() => null);
  if (!href) return null;
  try {
    const url = new URL(href, "https://www.tiktok.com");
    if (url.origin !== "https://www.tiktok.com") return null;
    return /^\\/@([A-Za-z0-9._]{2,24})\\/?$/.exec(url.pathname)?.[1] || null;
  } catch { return null; }
}

export interface LaunchLocalContextOptions {`,
    "public TikTok profile helper");
  fs.writeFileSync(filename, s);
}

{
  const filename = "src/runtime/local-runtime.ts";
  let s = fs.readFileSync(filename, "utf8");
  s = replaceOnce(s, 'import { existingBrowserConfigured, launchLocalContext } from "./social-runtime.js";',
    'import { existingBrowserConfigured, findUsableExistingBrowserPort, launchLocalContext, signedInProfileName } from "./social-runtime.js";',
    "login browser imports");
  s = replaceOnce(s,
    '    if (existingBrowserConfigured()) return this.connectExistingBrowser(input);',
    `    const existingPort = await findUsableExistingBrowserPort();
    if (existingPort || existingBrowserConfigured()) return this.connectExistingBrowser(input, existingPort);`,
    "try detected open sessions before QR");
  s = replaceOnce(s, '  private async connectExistingBrowser(input: ConnectInput) {',
    '  private async connectExistingBrowser(input: ConnectInput, existingPort: number | null) {',
    "carry selected browser port");
  s = replaceOnce(s,
    '        accountId: "default", country: input.country, loadMedia: true,',
    '        accountId: "default", country: input.country, loadMedia: true,\n        externalBrowserPort: existingPort || undefined, skipAccountIdentityCheck: true,',
    "allow login identity binding");
  s = replaceOnce(s,
    `      const profileNavigation = session.page.locator('a[data-e2e="nav-profile"]').first();
      if (!await profileNavigation.isVisible({ timeout: 10_000 }).catch(() => false)) {
        throw new Error("A signed-in TikTok profile link was not found in the connected browser. Sign in in that browser first, or retry after TikTok finishes loading.");
      }`,
    `      const profileName = await signedInProfileName(session.page);
      if (!profileName) throw new Error("A signed-in TikTok profile link was not verified in the connected browser. Sign in there first.");`,
    "verify public profile handle on login");
  s = replaceOnce(s,
    '        status: "active", last_connected_at: now, last_error: undefined,',
    '        status: "active", last_connected_at: now, last_error: undefined,\n        browser_profile_name: profileName,',
    "persist verified profile handle");
  s = replaceOnce(s,
    '      return { token: id, operation_id: id, status: "done", connected: true, account_id: "default", reused_browser: true };',
    '      return { token: id, operation_id: id, status: "done", connected: true, account_id: "default", reused_browser: true, profile_name: profileName };',
    "report public profile");
  fs.writeFileSync(filename, s);
}

{
  const filename = "src/server.ts";
  let s = fs.readFileSync(filename, "utf8");
  s = replaceOnce(s, 'version: "0.1.3" }', 'version: "0.1.4" }', "server version");
  fs.writeFileSync(filename, s);
}
