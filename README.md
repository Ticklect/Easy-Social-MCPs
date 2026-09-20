# Reddit Easy

**Read, search and post on Reddit from an MCP host without making a Reddit developer app, copying API keys, or putting your Reddit password into plugin settings.**

Reddit Easy uses a dedicated local Chromium browser profile. Sign in to Reddit normally once and the MCP reuses that local session.

## Easy Social MCPs

This repository includes all four ready-to-use MCPs:

| MCP | Start login | Download this MCP file |
| --- | --- | --- |
| [Reddit Easy](./README.md) | `reddit_login` | [`reddit-easy-v0.3.1.mcpb`](https://github.com/Ticklect/Easy-Social-MCPs/releases/download/reddit-easy-v0.3.1/reddit-easy-v0.3.1.mcpb) |
| [X Easy](./x-easy/README.md) | `x_login` | [`x-easy-v0.1.0.mcpb`](https://github.com/Ticklect/Easy-Social-MCPs/releases/download/x-easy-v0.1.0/x-easy-v0.1.0.mcpb) |
| [TikTok Easy](./tiktok-easy/README.md) | `tiktok_login` | [`tiktok-easy-v0.1.0.mcpb`](https://github.com/Ticklect/Easy-Social-MCPs/releases/download/tiktok-easy-v0.1.0/tiktok-easy-v0.1.0.mcpb) |
| [YouTube Easy](./youtube-easy/README.md) | `youtube_login` | [`youtube-easy-v0.1.0.mcpb`](https://github.com/Ticklect/Easy-Social-MCPs/releases/download/youtube-easy-v0.1.0/youtube-easy-v0.1.0.mcpb) |

### Installing in Codex or Claude Code

You need **two downloads**: the [Easy MCP Installer ZIP](https://github.com/Ticklect/Easy-Social-MCPs/releases/download/easy-mcp-installer-v0.1.0/easy-mcp-installer-v0.1.0.zip), plus the `.mcpb` file for each MCP you want from the table above. You do not need the source ZIPs.

Extract the installer ZIP, place the downloaded `.mcpb` files beside `install-easy-mcp.mjs`, then run one command:

```text
node install-easy-mcp.mjs --host codex youtube-easy-v0.1.0.mcpb
node install-easy-mcp.mjs --host claude youtube-easy-v0.1.0.mcpb
node install-easy-mcp.mjs --host both reddit-easy-v0.3.1.mcpb x-easy-v0.1.0.mcpb tiktok-easy-v0.1.0.mcpb youtube-easy-v0.1.0.mcpb
```

Restart Codex or Claude Code afterward. The first command installs only into Codex, the second only into Claude Code, and `--host both` installs into both.

## YouTube Easy

**[YouTube Easy](./youtube-easy/README.md)** brings the same import-and-sign-in approach to YouTube Studio: download the MCPB, import it, run `youtube_login`, and sign in normally in its dedicated browser profile. No YouTube Data API, Google Cloud project, OAuth client, API key, copied cookies, or runtime npm install is required.

It includes fail-closed video/Short upload, metadata editing, thumbnails, scheduling, comments, channel/video/search reads, and transcript extraction when the public page exposes it. Cross-process leases and persisted reconciliation return `UNCERTAIN` instead of risking duplicate writes after an ambiguous crash.

[Download YouTube Easy v0.1.0](../../releases/tag/youtube-easy-v0.1.0)

> v0.1.0 is offline-tested against simulated Studio DOM states; it does not claim a live upload was verified. YouTube web automation may break when Studio changes. Read the [YouTube Easy security and limitations](./youtube-easy/README.md) before use.

## TikTok Easy

I also added **[TikTok Easy](./tiktok-easy/README.md)** for TikTok. It packages the browser-session TikTok MCP into a ready-to-import bundle with no TikTok developer app or API keys.

**Import → run `tiktok_login` → scan the TikTok QR → done.**

It supports posting and native scheduling, likes, follows, deletion, profile/avatar changes, analytics, saved performance history, and hook analysis.

[Download TikTok Easy v0.1.0](../../releases/tag/tiktok-easy-v0.1.0)

> TikTok Easy is an unofficial browser-session integration and carries platform/account risk. Read its [security notes and attribution](./tiktok-easy/README.md) before using it.

## Also available: X Easy

I also built **[X Easy](./x-easy/README.md)** for X/Twitter. It follows the same basic idea: import the MCPB, sign in once in a dedicated browser, then read your timeline, search, mentions, notifications and bookmarks, or explicitly post, reply, like, repost and bookmark without setting up X API credentials.

[Download X Easy v0.1.0](./x-easy/x-easy-v0.1.0.mcpb)

> X Easy is an unofficial browser-session integration and carries platform/account risk. Read its [warning and attribution](./x-easy/README.md) before using it.

## 30-second setup

1. Download `reddit-easy.mcpb` or the versioned v0.3.0 bundle from Releases.
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

## Cross-process write safety in v0.3.1

Reddit Easy now coordinates writes across completely separate MCP/Node processes that share the same local Reddit Easy state and browser profile. The first process acquires an account + request fingerprint lease before checking duplicates and holds it through submission and reconciliation. Successful fullname/permalink results are persisted, so a second process can reuse the prior result without sending another Reddit request.

If a process crashes after a write may have been sent, Reddit Easy reconciles the intended post/comment against Reddit before doing anything else. It retries only when it can establish that the original write did not happen; otherwise it returns an explicit **UNCERTAIN** result rather than risk creating a duplicate.

The dedicated browser profile has its own cross-process lease as well, preventing two MCP processes from silently starting/driving/erasing the same profile at once.

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

Helium support includes common Windows installs under `%LOCALAPPDATA%\imput\Helium\Application\chrome.exe` and `%PROGRAMFILES%\imput\Helium\Application\chrome.exe`.

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
- Writes are spaced by at least 3.5 seconds.
- Cookies, passwords and session tokens are not intentionally logged.

See [SECURITY.md](./SECURITY.md).

## Downloads and source

- [`reddit-easy.mcpb`](./reddit-easy.mcpb) — current ready-to-import bundle
- [Reddit Easy v0.3.1 release](../../releases/tag/reddit-easy-v0.3.1) — versioned MCPB, source ZIP and checksum
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
