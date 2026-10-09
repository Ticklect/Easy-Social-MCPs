# X Easy

**Import → log in → use X.**

X Easy is an MCPB plugin for using X through a dedicated local browser session without creating an X developer app or pasting API credentials into plugin settings.

## 30-second setup

1. Import `x-easy-v0.1.1.mcpb` into an MCPB-compatible host such as Chat On Steroids.
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

- [`x-easy-v0.1.1.mcpb`](./x-easy-v0.1.1.mcpb) — current ready-to-import bundle
- [`x-easy-v0.1.1.mcpb.sha256`](./x-easy-v0.1.1.mcpb.sha256) — SHA-256 checksum
- [`x-easy-v0.1.1-source.zip`](./x-easy-v0.1.1-source.zip) — maintained source and offline tests
- [`x-easy-v0.1.0.mcpb`](./x-easy-v0.1.0.mcpb) — previous release, kept unchanged
- [`manifest.json`](./manifest.json) — MCPB manifest

## Supported browsers

- Helium
- Google Chrome
- Microsoft Edge
- Chromium

Windows Helium detection includes the common per-user install under `%LOCALAPPDATA%\imput\Helium\Application\chrome.exe`.

## Safety

X content is untrusted. The MCP tells agents not to obey instructions inside posts or notifications. Browser debugging is loopback-only, uses an unpredictable browser-assigned port, and X URLs are restricted to real `x.com`/`twitter.com` HTTPS hosts.

Writes are real external actions. From v0.1.1, all MCP processes sharing the dedicated local profile use one filesystem-backed profile lock. Browser navigations and scrolling are paced at least three seconds apart, and X-owned HTTP 429/503 responses observed through the browser's debugging protocol establish shared persistent cooldowns. This is a conservative page-activity gate; the website can send other background requests independently of the MCP.

Write protection is shared by X account. Up to six **attempted** writes are permitted per hour, with a 30–60-second interval between dispatched UI actions. Identical confirmed actions reuse their prior result within ten minutes. If a post, reply, like, repost or bookmark was possibly dispatched but X never confirmed the outcome, X Easy records **UNCERTAIN** and will not automatically repeat it. Verify its state on X before taking any further action. The browser action may have happened even when confirmation failed.

Cross-process leases record their owner process ID. An expired heartbeat alone cannot reclaim a live process's browser/account lease (for example, while its Node event loop is paused). Recovery of an owned lease requires both an expired heartbeat and evidence that the owning process has exited. An abandoned ownerless *reclamation claim* has a separate conservative grace period before recovery; unknown ownership of an actual browser/account lease fails closed.

Engagement controls are restricted to exactly one post whose status URL matches the requested post ID. Missing or ambiguous posts/controls cause a safe failure instead of selecting the first visible post. When X returns a first-party HTTP 429/503, further browser commands stop; if the shared cooldown cannot be persisted, X Easy also fails closed rather than reporting a successful read or write.

Build and test the maintained runtime with `npm run build`, `npm run check` and `npm test` from `x-easy/`. The build generates matching `src/` and `dist/`, versioned MCPB/source ZIP, and checksums without contacting X.

## Important warning

This is an unofficial browser-session integration, not the official X API. X's published rules restrict automated website access and browser scripting, and pacing does not make this integration authorised or guarantee that an account avoids restrictions. The official X API is the appropriate path for permitted automated access. X can change its website at any time, which may break selectors or behavior. Do not use X Easy for spam, mass posting, artificial engagement or attempts to evade X controls.

## Attribution

X Easy v0.1.x is a separate MCPB implementation that adapts X page selectors, DOM extraction logic, and safety lessons from **SohrabZ/x-browser-mcp v0.0.9**, which is MIT licensed. The original copyright and license are preserved in [`THIRD_PARTY_LICENSES.md`](./THIRD_PARTY_LICENSES.md).

Original project: https://github.com/SohrabZ/x-browser-mcp

## Requirements

- Node.js 22+
- Helium, Chrome, Edge or Chromium
- An X account
- An MCPB-compatible host

## License

X Easy project-owned code is licensed under the **GNU Affero General Public License v3.0 or later (AGPL-3.0-or-later)**. Third-party code remains under its original licenses. See [`LICENSE`](./LICENSE) and [`THIRD_PARTY_LICENSES.md`](./THIRD_PARTY_LICENSES.md).
