# Reddit Easy

**Read, search and post on Reddit from an MCP host without making a Reddit developer app, copying API keys, or putting your Reddit password into plugin settings.**

Reddit Easy uses a dedicated local Chromium browser profile. Sign in to Reddit normally once and the MCP reuses that local session.

## Easy Social MCPs

This repository includes all four ready-to-use MCPs:

| MCP | Start login | Download this MCP file |
| --- | --- | --- |
| [Reddit Easy](./README.md) | `reddit_login` | [`reddit-easy-v0.3.3.mcpb`](./reddit-easy-v0.3.3.mcpb) |
| [X Easy](./x-easy/README.md) | `x_login` | [`x-easy-v0.1.2.mcpb`](./x-easy/x-easy-v0.1.2.mcpb) |
| [TikTok Easy](./tiktok-easy/README.md) | `tiktok_login` | [`tiktok-easy-v0.1.2.mcpb`](./tiktok-easy/tiktok-easy-v0.1.2.mcpb) |
| [YouTube Easy](./youtube-easy/README.md) | `youtube_login` | [`youtube-easy-v0.1.2.mcpb`](./youtube-easy/youtube-easy-v0.1.2.mcpb) |

### Want all four?

**[Easy Social MCPs All-in-One v0.1.3](./easy-social-mcps/easy-social-mcps-v0.1.3.zip)** contains the installer, all four MCPs, and advanced existing-debugger support for Reddit, X and YouTube. The previous [v0.1.2 build](./easy-social-mcps/easy-social-mcps-v0.1.2.zip) remains available.

### Easiest setup: give this prompt to your coding agent

Copy a `.mcpb` link from the table above, replace `<MCPB LINK>` below, and paste the whole prompt into Codex or Claude Code:

```text
Install this Easy Social MCP into the coding client you are currently running in:
<MCPB LINK>

Use the official Easy MCP Installer from:
https://github.com/Ticklect/Easy-Social-MCPs/releases/download/easy-mcp-installer-v0.1.1/easy-mcp-installer-v0.1.1.zip

Download both files to a temporary folder, verify the release checksums, extract the installer, and run it for this client only: use --host codex when running in Codex or --host claude when running in Claude Code. Do not run npm install and do not ask me to edit MCP configuration manually. Verify that the MCP registration succeeded, tell me whether I need to restart the client, and remove only the temporary installer/download files. Do not start a login, upload, post, delete, or other external action yet.
```

For example, start the prompt with “Install YouTube Easy into my Codex” and use the YouTube `.mcpb` link from the table. After restarting, say “Start YouTube login.”

### Manual installation in Codex or Claude Code

You need **two downloads**: the [Easy MCP Installer ZIP](./easy-mcp-installer/easy-mcp-installer-v0.1.2.zip), plus the `.mcpb` file for each MCP you want from the table above. You do not need the source ZIPs.

Extract the installer ZIP, place the downloaded `.mcpb` files beside `install-easy-mcp.mjs`, then run one command:

```text
node install-easy-mcp.mjs --host codex youtube-easy-v0.1.2.mcpb
node install-easy-mcp.mjs --host claude youtube-easy-v0.1.2.mcpb
node install-easy-mcp.mjs --host both reddit-easy-v0.3.3.mcpb x-easy-v0.1.2.mcpb tiktok-easy-v0.1.2.mcpb youtube-easy-v0.1.2.mcpb
```

Restart Codex or Claude Code afterward. The first command installs only into Codex, the second only into Claude Code, and `--host both` installs into both.

## YouTube Easy

**[YouTube Easy](./youtube-easy/README.md)** brings the same import-and-sign-in approach to YouTube Studio: download the MCPB, import it, run `youtube_login`, and sign in normally in its dedicated browser profile. No YouTube Data API, Google Cloud project, OAuth client, API key, copied cookies, or runtime npm install is required.

It includes fail-closed video/Short upload, metadata editing, thumbnails, scheduling, comments, channel/video/search reads, and transcript extraction when the public page exposes it. Cross-process leases and persisted reconciliation return `UNCERTAIN` instead of risking duplicate writes after an ambiguous crash.

[YouTube Easy v0.1.2 bundle](./youtube-easy/youtube-easy-v0.1.2.mcpb)

> v0.1.1 adds browser-session request pacing and cooldown handling. Offline simulations do not establish successful live uploads or guarantee account safety. YouTube may change Studio at any time. Read the [YouTube Easy security and limitations](./youtube-easy/README.md) before use.

## TikTok Easy

I also added **[TikTok Easy](./tiktok-easy/README.md)** for TikTok. It packages the browser-session TikTok MCP into a ready-to-import bundle with no TikTok developer app or API keys.

**Import → run `tiktok_login` → scan the TikTok QR → done.**

It supports posting and native scheduling, likes, follows, deletion, profile/avatar changes, analytics, saved performance history, and hook analysis.

[TikTok Easy v0.1.2 bundle](./tiktok-easy/tiktok-easy-v0.1.2.mcpb)

> TikTok Easy is an unofficial browser-session integration and carries platform/account risk. Read its [security notes and attribution](./tiktok-easy/README.md) before using it.

## Also available: X Easy

I also built **[X Easy](./x-easy/README.md)** for X/Twitter. It follows the same basic idea: import the MCPB, sign in once in a dedicated browser, then read your timeline, search, mentions, notifications and bookmarks, or explicitly post, reply, like, repost and bookmark without setting up X API credentials.

[X Easy v0.1.2 bundle](./x-easy/x-easy-v0.1.2.mcpb)

> X explicitly prohibits scripting its website as a form of automation, and enforcement can include suspension. Local pacing does not make this approach authorised or guarantee account safety. Review the [X Easy security warnings](./x-easy/README.md) and use X's official API for authorised automation.

## 30-second setup

1. Download `reddit-easy.mcpb` or the versioned v0.3.3 bundle from this repository.
2. Import it into Chat On Steroids or another MCPB-compatible host.
3. Ask the agent to run `reddit_login`.
4. Sign in to Reddit in the dedicated browser window.
5. Run `reddit_status`.
6. Done.

No Reddit developer portal. No client ID. No client secret. No Reddit password field in the plugin.

## What v0.3.x can read

- Your personalized home feed
- Hot / New / Top / Rising / Controversial posts in any subreddit
- Reddit-wide or subreddit-scoped search
- Full post details
- Nested comment threads with reply depth and parent IDs
- Inbox activity, unread items, sent messages, replies and username mentions
- Account notifications, with inbox fallback if Reddit's notification endpoint is unavailable
- Your saved posts and comments
- Public user profiles
- A user's submitted posts, comments or combined overview
- r/popular
- r/all
- Subreddit rules and post flairs

Listing tools return Reddit's `next_after` cursor. Pass that value back as `after` to continue onto the next page instead of being limited to the first batch.

Example prompts:

```text
What is on my Reddit home feed right now?
```

```text
Search Reddit for people talking about MCP browser automation this week.
```

```text
Read this Reddit post and summarize the comment arguments.
```

```text
Show me the newest 50 posts from r/opensource, then keep going with the next page.
```

```text
Show me my mentions and unread inbox items.
```

## Cross-process write safety in v0.3.x

Reddit Easy now coordinates writes across completely separate MCP/Node processes that share the same local Reddit Easy state and browser profile. The first process acquires an account + request fingerprint lease before checking duplicates and holds it through submission and reconciliation. Successful fullname/permalink results are persisted, so a second process can reuse the prior result without sending another Reddit request.

If a process crashes after a write may have been sent, Reddit Easy reconciles the intended post/comment against Reddit before doing anything else. It retries only when it can establish that the original write did not happen; otherwise it returns an explicit **UNCERTAIN** result rather than risk creating a duplicate.

The dedicated browser profile has its own cross-process lease as well, preventing two MCP processes from silently starting/driving/erasing the same profile at once.

## Shared request limits in v0.3.2

Every Reddit JSON request passes through one filesystem-backed limiter shared by MCP processes using the same Reddit Easy profile. Requests are spaced by at least 2.5 seconds; HTTP writes are spaced by at least 12 seconds at dispatch, in addition to duplicate-write protection. When Reddit provides `Retry-After` or `X-Ratelimit-Remaining` / `X-Ratelimit-Reset`, the limiter conservatively honours those signals. HTTP 429, HTTP 503 and Reddit's JSON `RATELIMIT` errors create persisted cooldowns. Calls during a long cooldown return an explanation with an approximate retry time instead of repeatedly contacting Reddit. The limiter never automatically replays writes.

These defaults are intentionally conservative and can slow down large batches. They reduce accidental bursts but **cannot guarantee an account will not be flagged**. Reddit's Data API rules require authorised access and registered OAuth clients; using unofficial browser-session endpoints remains subject to Reddit's rules and account restrictions.

## Writing tools

Reddit Easy still supports:

- Create text and link posts
- Reply to posts and comments
- Edit your own post/comment text
- Delete your own posts/comments

Write operations remain duplicate-protected and rate-limited. Check subreddit rules/flairs before posting when practical.

## Supported browsers

- Helium
- Google Chrome
- Microsoft Edge
- Chromium
- Brave
- Vivaldi
- Opera

Helium support includes common Windows installs under `%LOCALAPPDATA%\imput\Helium\Application\chrome.exe` and `%PROGRAMFILES%\imput\Helium\Application\chrome.exe`.

### Use your signed-in Helium / Chromium browser

The optional [Easy Social Browser Companion](./browser-companion/README.md) connects Reddit, X and YouTube Easy to an existing Helium, Chrome, Edge, Brave, Chromium, Vivaldi or Opera window. Run `npm ci` and `npm start` in `browser-companion`, enable developer mode in your browser's extensions page and load `browser-companion/extension` as an unpacked extension. Paste the local server's pairing code into the extension popup. Once connected, the MCPs automatically use your normal signed-in browser and open only their own social tabs.

The paired browser is never closed or cleared. If two browsers are connected at once, the bridge refuses automated actions until you disconnect one; this avoids using the wrong account. Firefox and Safari require separate extension implementations and are not supported by the Chromium companion. TikTok Easy retains its separate Playwright profile. Actual cross-browser sign-in should be tested on each browser version.

### Attach to an already running debugger (advanced)

Reddit Easy, X Easy and YouTube Easy can connect to a Chromium browser **already listening on a local Chrome DevTools Protocol (CDP) port**. Set `EASY_SOCIAL_BROWSER_DEBUG_PORT` to its port in the MCP environment. The MCP then uses the browser's current cookies and logged-in session, opening a tab in that browser if necessary. It does not launch, close or erase the external browser profile.

Set `EASY_SOCIAL_BROWSER_MODE=existing` to fail with a clear error instead of opening a separate browser when the connection is unavailable. The default remains a dedicated browser when this option is not configured. TikTok Easy still uses a separate Playwright browser.

This direct-debugger option works only if the browser **already exposes CDP**. Ordinary Chrome windows do not. Chrome 136+ prevents remote debugging of its default user-data directory, and adding a debugging flag after Chrome has started does not change the running process. Use the companion extension above to reuse a normal signed-in browser. Do not copy the everyday profile or its cookies into the MCP.

## Authentication

Authentication happens in the real browser window on `reddit.com`. Reddit Easy stores the resulting session only inside its dedicated local browser profile. The MCP config does not accept your Reddit username, password, client ID, client secret or OAuth token.

Use `reddit_forget_session` to close the dedicated browser and erase the local Reddit Easy profile.

## Security

- Browser debugging binds only to `127.0.0.1`.
- The browser chooses an unpredictable ephemeral debugging port.
- Reddit requests are restricted to HTTPS on real `reddit.com` subdomains.
- Lookalike hosts such as `evilreddit.com` are rejected.
- There are no third-party runtime packages; the MCP uses Node.js built-ins only.
- Reddit-returned posts, comments, messages, notifications, rules and flair text are explicitly labeled untrusted.
- Identical successful writes are blocked for 10 minutes.
- Concurrent duplicate writes are blocked.
- All Reddit JSON requests are spaced by at least 2.5 seconds, with a 12-second minimum between write dispatches.
- Server cooldowns persist across MCP process restarts, and throttled calls do not trigger immediate retries.
- Cookies, passwords and session tokens are not intentionally logged.

See [SECURITY.md](./SECURITY.md).

## Downloads and source

- [`reddit-easy.mcpb`](./reddit-easy.mcpb) — current ready-to-import bundle
- [`reddit-easy-v0.3.3.mcpb`](./reddit-easy-v0.3.3.mcpb) — current versioned MCPB
- [Reddit Easy v0.3.1 release](../../releases/tag/reddit-easy-v0.3.1) — previous release, preserved unchanged
- [`reddit-easy.mcpb.sha256`](./reddit-easy.mcpb.sha256) — checksum for the current bundle
- [`manifest.json`](./manifest.json) — MCPB manifest

## Important limitations

Reddit Easy uses Reddit's authenticated web/API surfaces through your local browser session. Reddit can change these at any time. `get_notifications` therefore falls back to inbox activity when Reddit's notification endpoint is unavailable.

Comment pages can contain Reddit `more comments` placeholders. `get_comments` returns the nested comments Reddit supplied in that request and tells you when unloaded `more` blocks were present; it does not silently pretend those omitted comments were fetched.

A home-feed read shows the feed Reddit returns when you call it. It cannot reconstruct exactly what your personalized feed looked like hours earlier unless it was read and saved at that time.

## Requirements

- Node.js 22+
- Helium, Chrome, Edge or Chromium
- A Reddit account
- An MCPB-compatible host

## License

Project-owned code in this repository is licensed under the **GNU Affero General Public License v3.0 or later (AGPL-3.0-or-later)**. See [LICENSE](./LICENSE).

Third-party components remain under their original licenses; see the relevant `THIRD_PARTY_LICENSES.md` files in subprojects.
