# Easy Social MCPs — All-in-One

This archive contains the Easy MCP Installer and all four ready-to-use bundles:

- Reddit Easy v0.3.5
- X Easy v0.1.4
- TikTok Easy v0.1.4
- YouTube Easy v0.1.4

It requires Node.js 22 or newer. It does not run `npm install`.

## Use your existing browser login

The `browser-companion` folder in this ZIP allows Reddit, X and YouTube MCPs to use your **already signed-in** Helium, Chrome, Edge, Brave, Vivaldi, Opera or Chromium browser. On Windows, double-click `browser-companion/start-windows.cmd` to start the local bridge, then load `browser-companion/extension` as an unpacked Chromium extension in your existing browser and enter the printed pairing code once. Keep the bridge running during MCP use. This is browser permission/pairing, not a second login to your social accounts. The four MCPB files themselves require no extra dependencies.

Only one browser can be connected at a time for a given bridge. Firefox and Safari need separate support. TikTok Easy requires a browser already exposing a local CDP debugger; its Playwright backend cannot yet use the page-only companion. See `browser-companion/README.md` for the supported versions, browser limitations and security details.

On Windows, Reddit, X, YouTube and TikTok also scan for compatible already-running local Chromium debuggers with existing social tabs. They use a verified matching browser session when available. Only browsers already exposing a local debugger or explicitly paired through the extension can be reused; ordinary unpaired browser tabs remain inaccessible.

## Install everything

Extract the ZIP, open a terminal in the extracted directory, and run one command:

```text
node install-easy-mcp.mjs --host codex reddit-easy-v0.3.5.mcpb x-easy-v0.1.4.mcpb tiktok-easy-v0.1.4.mcpb youtube-easy-v0.1.4.mcpb
node install-easy-mcp.mjs --host claude reddit-easy-v0.3.5.mcpb x-easy-v0.1.4.mcpb tiktok-easy-v0.1.4.mcpb youtube-easy-v0.1.4.mcpb
node install-easy-mcp.mjs --host both reddit-easy-v0.3.5.mcpb x-easy-v0.1.4.mcpb tiktok-easy-v0.1.4.mcpb youtube-easy-v0.1.4.mcpb
```

Use `--host codex`, `--host claude`, or `--host both`. Restart the selected client after installation. Then prompts such as “Start Reddit login” or “Start YouTube login” work in a new chat.

To install only some services, remove the unwanted `.mcpb` filenames from the command. `SHA256SUMS.txt` contains checksums for the installer and all four bundles.

Each included component retains its own license and security documentation inside its MCPB. The all-in-one packaging files are licensed under the repository's `LICENSE`.

All four components now include additional request-safety checks. Their shared and/or local pacing and cooldown limits are deliberately conservative. These browser-session integrations are unofficial; they do not bypass site policies, guarantee uninterrupted access, or prevent account enforcement. In particular, X's automation rules prohibit scripting its website; users seeking authorised automated access should use the official API.

All four MCPs can use a compatible Chromium browser already exposing a loopback CDP port when `EASY_SOCIAL_BROWSER_DEBUG_PORT` is set. Set `EASY_SOCIAL_BROWSER_MODE=existing` to prohibit a dedicated-profile fallback. Ordinary Chromium windows do not expose a debugging port and require the paired companion where supported. Browser permissions cannot be silently bypassed, and no cookies are copied from an existing profile.
