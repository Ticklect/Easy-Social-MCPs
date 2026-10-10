/** Apply the existing signed-in browser support to the immutable v0.1.2 sources. */
import fs from "node:fs";

function replaceOnce(source, oldText, newText, label) {
  if (!source.includes(oldText)) throw new Error("Missing TikTok patch target: " + label);
  return source.replace(oldText, newText);
}

{
  const file = "src/runtime/social-runtime.ts";
  let source = fs.readFileSync(file, "utf8");
  source = replaceOnce(source,
    'import { join } from "node:path";',
    'import { join } from "node:path";\nimport { homedir } from "node:os";',
    "browser companion data-root import");

  const discovery = `
/** The shared extension bridge currently proxies tab-level CDP only. Playwright
 * requires browser Target.* commands, so connect only to a complete local
 * Chromium debugger rather than incorrectly treating that bridge as a browser.
 */
function companionKeyFile(): string {
  const base = process.platform === "win32"
    ? process.env.LOCALAPPDATA || process.env.APPDATA || homedir()
    : process.platform === "darwin"
      ? join(homedir(), "Library", "Application Support")
      : process.env.XDG_DATA_HOME || join(homedir(), ".local", "share");
  return join(base, "ChatOnSteroids", "EasySocialBrowserBridge", "pairing-key");
}

export function existingBrowserConfigured(): boolean {
  return Boolean(process.env.EASY_SOCIAL_BROWSER_DEBUG_PORT) ||
    existsSync(companionKeyFile()) ||
    process.env.EASY_SOCIAL_BROWSER_MODE === "existing";
}

function existingBrowserPort(): number | null {
  const raw = process.env.EASY_SOCIAL_BROWSER_DEBUG_PORT;
  if (raw === undefined || raw === "") return null;
  if (!/^[1-9][0-9]{0,4}$/.test(raw) || Number(raw) > 65535) {
    throw new Error("EASY_SOCIAL_BROWSER_DEBUG_PORT must be a localhost port (1-65535).");
  }
  return Number(raw);
}

async function debuggerWebSocket(port: number): Promise<string> {
  const response = await fetch("http://127.0.0.1:" + port + "/json/version", {
    signal: AbortSignal.timeout(3000),
  });
  if (!response.ok) throw new Error("The selected browser debugger is unavailable.");
  const details = await response.json() as { webSocketDebuggerUrl?: unknown };
  if (typeof details.webSocketDebuggerUrl !== "string") {
    throw new Error("The selected browser did not expose a Chromium debugger.");
  }
  const ws = new URL(details.webSocketDebuggerUrl);
  if (ws.protocol !== "ws:" || ws.hostname !== "127.0.0.1" || ws.port !== String(port) ||
      ws.username || ws.password || ws.search || ws.hash ||
      !ws.pathname.startsWith("/devtools/browser/") ||
      !/^[a-zA-Z0-9-]+$/.test(ws.pathname.slice("/devtools/browser/".length))) {
    throw new Error("The selected debugger returned an unsafe browser endpoint.");
  }
  return ws.toString();
}
`;
  source = replaceOnce(source,
    'export interface LaunchLocalContextOptions {',
    discovery + '\nexport interface LaunchLocalContextOptions {',
    "safe localhost debugger discovery");

  source = replaceOnce(source,
    '  const profile = profileForCountry(opts.country);\n  const headless = opts.headless ?? defaultHeadless();',
    `  let externalPort: number | null;
  try { externalPort = existingBrowserPort(); }
  catch (error) { release(); throw error; }
  if (!externalPort && existingBrowserConfigured()) {
    release();
    throw new Error("TikTok Easy cannot attach Playwright to the tab-only Easy Social browser companion. Reuse your signed-in Chromium or Helium window with an existing local CDP debugger through EASY_SOCIAL_BROWSER_DEBUG_PORT; no browser or profile was launched.");
  }
  const profile = profileForCountry(opts.country);
  const headless = opts.headless ?? defaultHeadless();`,
    "external session selection");
  source = replaceOnce(source,
    '  if (!headless && process.platform === "linux" && !process.env.DISPLAY) {',
    '  if (!externalPort && !headless && process.platform === "linux" && !process.env.DISPLAY) {',
    "skip virtual display when attaching");
  source = replaceOnce(source,
    '  let ctx: BrowserContext;\n  try {\n    ctx = await chromium.launchPersistentContext(profileDir(opts.accountId), launchOptions);',
    `  let ctx: BrowserContext;
  let externalBrowser: Browser | undefined;
  try {
    if (externalPort) {
      const ws = await debuggerWebSocket(externalPort);
      externalBrowser = await chromium.connectOverCDP(ws, { timeout: 10_000 });
      const originalContext = externalBrowser.contexts()[0];
      if (!originalContext) throw new Error("Connected browser has no persistent signed-in context.");
      ctx = originalContext;
    } else {
      ctx = await chromium.launchPersistentContext(profileDir(opts.accountId), launchOptions);
    }`,
    "reuse existing browser context");
  source = replaceOnce(source,
    '  } catch (error) {\n    virtualDisplay?.process.kill();\n    release();\n    const message = error instanceof Error ? error.message : String(error);',
    '  } catch (error) {\n    await externalBrowser?.close().catch(() => {});\n    virtualDisplay?.process.kill();\n    release();\n    const message = error instanceof Error ? error.message : String(error);',
    "release failed external browser");
  source = replaceOnce(source,
    '${message}\\nInstall Chromium with \\"npx playwright install chromium\\", or set TIKTOK_BROWSER_PATH to Helium/Chrome/Edge/Brave.',
    '${message}${externalPort ? " (Existing browser CDP connection failed; a separate profile was not opened.)" : \'\\nInstall Chromium with "npx playwright install chromium", or set TIKTOK_BROWSER_PATH to Helium/Chrome/Edge/Brave.\'}',
    "accurate debugger failure");
  source = replaceOnce(source,
    '    if (opts.cookies?.length) {',
    '    if (externalBrowser && opts.cookies?.length) throw new Error("Cannot inject saved cookies into your existing browser.");\n    if (opts.cookies?.length) {',
    "protect browser cookies");
  source = replaceOnce(source,
    '    const page = pages[0] || await ctx.newPage();',
    '    const page = externalBrowser ? await ctx.newPage() : pages[0] || await ctx.newPage();',
    "never take over an existing tab");
  source = replaceOnce(source,
    '        try { await ctx.close(); } finally {',
    '        try { if (externalBrowser) { await page.close(); await externalBrowser.close(); } else await ctx.close(); } finally {',
    "close only the owned tab and debugger connection");
  source = replaceOnce(source,
    '    await ctx.close().catch(() => {});\n    virtualDisplay?.process.kill();',
    '    if (externalBrowser) await externalBrowser.close().catch(() => {});\n    else await ctx.close().catch(() => {});\n    virtualDisplay?.process.kill();',
    "external cleanup after initialization error");
  fs.writeFileSync(file, source);
}

{
  const file = "src/runtime/local-runtime.ts";
  let source = fs.readFileSync(file, "utf8");
  source = replaceOnce(source,
    'import { launchLocalContext } from "./social-runtime.js";',
    'import { existingBrowserConfigured, launchLocalContext } from "./social-runtime.js";',
    "reuse discovery import");
  source = replaceOnce(source,
    '  async connect(input: ConnectInput) {\n    const relay = await this.qrRelay.create();',
    `  async connect(input: ConnectInput) {
    if (existingBrowserConfigured()) return this.connectExistingBrowser(input);
    const relay = await this.qrRelay.create();`,
    "reuse signed-in browser before generating a QR");
  source = replaceOnce(source,
    '  private async runConnect(',
    `  private async connectExistingBrowser(input: ConnectInput) {
    if (input.account_id !== "default") {
      throw new Error('Existing-browser TikTok mode supports account_id "default" only, since browser tabs share one active signed-in account.');
    }
    // Check authenticated navigation in the browser itself without querying,
    // copying or serializing browser cookies or other account secrets.
    let session;
    try {
      session = await launchLocalContext({
        accountId: "default", country: input.country, loadMedia: true,
      });
      await session.page.goto("https://www.tiktok.com/", { waitUntil: "domcontentloaded", timeout: 60_000 });
      const profileNavigation = session.page.locator('a[data-e2e="nav-profile"]').first();
      if (!await profileNavigation.isVisible({ timeout: 10_000 }).catch(() => false)) {
        throw new Error("A signed-in TikTok profile link was not found in the connected browser. Sign in in that browser first, or retry after TikTok finishes loading.");
      }
      const now = new Date().toISOString();
      const id = randomUUID();
      upsertAccount({
        id: "default", country: input.country, tag: input.tag,
        status: "active", last_connected_at: now, last_error: undefined,
      });
      putOperation({
        id, name: "connect", account_id: "default", status: "done",
        input: safeInput(input), result: { connected: true, account_id: "default", reused_browser: true },
        created_at: now, updated_at: now,
      });
      return { token: id, operation_id: id, status: "done", connected: true, account_id: "default", reused_browser: true };
    } catch (error) {
      upsertAccount({
        id: "default", country: input.country, tag: input.tag, status: "logged_out",
        last_error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    } finally {
      await session?.close();
    }
  }

  private async runConnect(`,
    "validate existing logged-in account without QR");
  source = replaceOnce(source,
    '  private common(accountId: string): TikTokOpRequest {\n    const account = getAccount(accountId);',
    `  private common(accountId: string): TikTokOpRequest {
    if (existingBrowserConfigured() && accountId !== "default") {
      throw new Error('Existing-browser TikTok mode supports account_id "default" only.');
    }
    const account = getAccount(accountId);`,
    "prevent multiple account aliases using one live profile");
  fs.writeFileSync(file, source);
}

{
  const file = "src/server.ts";
  let source = fs.readFileSync(file, "utf8");
  source = source.replaceAll(
    "Create a shareable TikTok QR login link. Send connect_url to the human and poll tiktok_connect_status while they scan it.",
    "Reuse the signed-in existing Chromium browser when configured, or start QR login in the dedicated TikTok profile."
  );
  source = source.replaceAll(
    "Easy default-account QR login. No TikTok API keys are required.",
    "Use the signed-in existing browser when configured, or QR login in the dedicated profile."
  );
  source = replaceOnce(source,
    'version: "0.1.2" }',
    'version: "0.1.3" }',
    "server version");
  fs.writeFileSync(file, source);
}
