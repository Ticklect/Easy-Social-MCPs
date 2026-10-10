# Easy Social MCPs — All-in-One

This archive contains the Easy MCP Installer and all four ready-to-use bundles:

- Reddit Easy v0.3.3
- X Easy v0.1.2
- TikTok Easy v0.1.2
- YouTube Easy v0.1.2

It requires Node.js 22 or newer. It does not run `npm install`.

## Use your existing browser login

The optional `browser-companion` folder is included in this ZIP. It allows Reddit, X and YouTube MCPs to open tabs inside your **already signed-in** Helium, Chrome, Edge, Brave, Vivaldi, Opera or Chromium browser. From that folder run `npm ci` and `npm start`, load `browser-companion/extension` as an unpacked Chromium extension in your browser, then enter the printed pairing code in the extension popup. Keep the local companion process running during MCP use. The four MCPB files themselves still require no extra dependencies.

Only one browser can be paired and connected at a time for a given bridge. Firefox and Safari need separate support; TikTok Easy retains its own browser profile. See `browser-companion/README.md` for the supported versions, browser limitations and security details.

## Install everything

Extract the ZIP, open a terminal in the extracted directory, and run one command:

```text
node install-easy-mcp.mjs --host codex reddit-easy-v0.3.3.mcpb x-easy-v0.1.2.mcpb tiktok-easy-v0.1.2.mcpb youtube-easy-v0.1.2.mcpb
node install-easy-mcp.mjs --host claude reddit-easy-v0.3.3.mcpb x-easy-v0.1.2.mcpb tiktok-easy-v0.1.2.mcpb youtube-easy-v0.1.2.mcpb
node install-easy-mcp.mjs --host both reddit-easy-v0.3.3.mcpb x-easy-v0.1.2.mcpb tiktok-easy-v0.1.2.mcpb youtube-easy-v0.1.2.mcpb
```

Use `--host codex`, `--host claude`, or `--host both`. Restart the selected client after installation. Then prompts such as “Start Reddit login” or “Start YouTube login” work in a new chat.

To install only some services, remove the unwanted `.mcpb` filenames from the command. `SHA256SUMS.txt` contains checksums for the installer and all four bundles.

Each included component retains its own license and security documentation inside its MCPB. The all-in-one packaging files are licensed under the repository's `LICENSE`.

All four components now include additional request-safety checks. Their shared and/or local pacing and cooldown limits are deliberately conservative. These browser-session integrations are unofficial; they do not bypass site policies, guarantee uninterrupted access, or prevent account enforcement. In particular, X's automation rules prohibit scripting its website; users seeking authorised automated access should use the official API.

Reddit, X and YouTube can attach to an already running Chromium browser with an existing loopback CDP port. Set `EASY_SOCIAL_BROWSER_DEBUG_PORT` on their MCP processes, and optionally `EASY_SOCIAL_BROWSER_MODE=existing` to prohibit fallback. Ordinary Chrome windows do not expose a debugging port; this build cannot automatically connect to the default signed-in Chrome profile. TikTok still uses a separate browser profile.
