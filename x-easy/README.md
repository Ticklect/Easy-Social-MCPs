# X Easy

For Codex or Claude Code, the dependency-free [Easy MCP Installer](../easy-mcp-installer/README.md) registers this bundle at user scope. After restarting the client, say “Start X login.” The dedicated browser profile persists across chats, and `x_status` can confirm whether another login is actually needed.

**Import → log in → use X.**

X Easy is an MCPB plugin for using X through a dedicated local browser session without creating an X developer app or pasting API credentials into plugin settings.

## 30-second setup

1. Import `x-easy-v0.1.0.mcpb` into an MCPB-compatible host such as Chat On Steroids.
2. Ask the agent to run `x_login`.
3. Sign into X normally in the dedicated browser window.
4. Run `x_status` once.
5. Done.

After that you can ask things like:

```text
what is on my X timeline this morning?
```

```text
search X for TVDoctor and show me the newest posts
```

```text
show me my mentions and notifications
```

```text
post this to X: I just released ...
```

## What it can do

X Easy can read your home timeline, search, user timelines, threads/replies, mentions, notifications, bookmarks and lists. It can also explicitly post, reply, like, repost, bookmark and remove bookmarks.

## Why this is easier

There is no X developer app setup, no client ID, no client secret, no API token and no password field in the plugin. Your login happens directly on `x.com` in a dedicated local Helium/Chrome/Edge/Chromium profile.

## Download

- [`x-easy-v0.1.0.mcpb`](./x-easy-v0.1.0.mcpb) — ready-to-import bundle
- [`x-easy-v0.1.0.mcpb.sha256`](./x-easy-v0.1.0.mcpb.sha256) — SHA-256 checksum
- [`manifest.json`](./manifest.json) — MCPB manifest

## Supported browsers

- Helium
- Google Chrome
- Microsoft Edge
- Chromium

Windows Helium detection includes the common per-user install under `%LOCALAPPDATA%\imput\Helium\Application\chrome.exe`.

## Safety

X content is untrusted. The MCP tells agents not to obey instructions inside posts or notifications. Browser debugging is loopback-only, uses an unpredictable browser-assigned port, and X URLs are restricted to real `x.com`/`twitter.com` HTTPS hosts.

Writes are real external actions, so X Easy rate-limits them: identical recent writes are blocked and successful writes are capped at six per hour with a delay between actions.

## Important warning

This is an unofficial browser-session integration, not the official X API. X can change its website at any time, which may break selectors or behavior. Browser automation can also carry account/platform risk. Do not use X Easy for spam, mass posting, artificial engagement or attempts to evade X controls. Test with an account you are comfortable using for experimentation before relying on it.

## Attribution

X Easy v0.1.0 is a separate MCPB implementation that adapts X page selectors, DOM extraction logic, and safety lessons from **SohrabZ/x-browser-mcp v0.0.9**, which is MIT licensed. The original copyright and license are preserved in [`THIRD_PARTY_LICENSES.md`](./THIRD_PARTY_LICENSES.md).

Original project: https://github.com/SohrabZ/x-browser-mcp

## Requirements

- Node.js 22+
- Helium, Chrome, Edge or Chromium
- An X account
- An MCPB-compatible host

## License

X Easy is MIT licensed. See [`LICENSE`](./LICENSE) and [`THIRD_PARTY_LICENSES.md`](./THIRD_PARTY_LICENSES.md).
