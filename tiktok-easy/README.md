# TikTok Easy

**Import → reuse a signed-in browser (where supported) → post.**

TikTok Easy packages the MIT-licensed `0xArtex/tiktok-mcp` browser-session implementation into a ready-to-import MCPB so normal users do not need to clone a repo, run `npm install`, configure API keys, or create a TikTok developer app.

## Setup

1. Import `tiktok-easy-v0.1.4.mcpb` into an MCPB-compatible host.
2. Run `tiktok_login`. On Windows, TikTok Easy automatically discovers already-open Chromium browsers with a full, reachable local debugger and verifies your signed-in TikTok profile without QR login.
3. Otherwise, scan the TikTok QR code in the dedicated browser session. `tiktok_connect` also supports named accounts for dedicated profiles.
4. Ask the agent to post, schedule, follow, like, manage profile details, or inspect analytics.

There are **no TikTok API keys or developer credentials** in the plugin setup.

## Main tools

- `tiktok_login` — default account, existing-browser session reuse or QR login
- `tiktok_connect` / `tiktok_connect_status` — browser reuse for the default account, dedicated-profile QR login for multiple accounts
- `tiktok_accounts`
- `tiktok_post`
- `tiktok_operation_status`
- `tiktok_follow`
- `tiktok_like`
- `tiktok_delete`
- `tiktok_update_profile`
- `tiktok_update_avatar`
- `tiktok_analytics`
- `tiktok_series`
- `tiktok_hooks`
- `tiktok_niches`
- `tiktok_scheduled`
- `tiktok_cancel_scheduled`

## Browsers

TikTok Easy detects Helium in addition to Chrome, Edge, Brave and Chromium for the dedicated browser profile.

### Reuse the browser where you're already signed in

On Windows, TikTok Easy automatically detects a **previously opened** Helium, Chrome, Edge, Brave, Chromium, Vivaldi or Opera process whose launch flags expose a complete localhost Chrome DevTools Protocol (CDP) debugger. It reads the port from the launch arguments or the browser's own `DevToolsActivePort` file for ephemeral ports, and verifies the endpoint before attaching. You can still explicitly set `EASY_SOCIAL_BROWSER_DEBUG_PORT` to override discovery. No new browser, login, separate profile or cookie copy is needed when a signed-in session is accessible. Operations open a temporary tab, validate the saved public TikTok profile handle and close the tab on completion.

Automatic discovery requires the already-running browser to expose a complete CDP debugger. Merely having Chrome or Helium open and signed in does **not** expose a CDP port. TikTok Easy does not restart browsers, read their cookie stores, or change their flags. If more than one reachable browser debugger is detected, it refuses to guess which account to use. If none is available, ordinary QR login in the dedicated profile remains the fallback (except when existing-browser-only mode or a configured but incompatible companion is present). Discovery currently uses Windows process metadata; other operating systems can use the explicit localhost port.

The shared Easy Social Browser Companion extension currently supports **tab-level** debugging for Reddit, X and YouTube. TikTok's Playwright engine requires browser-level CDP commands, so its companion alone cannot attach to a normal Helium session. If the companion is configured without `EASY_SOCIAL_BROWSER_DEBUG_PORT`, TikTok Easy reports that limitation. `EASY_SOCIAL_BROWSER_MODE=existing` likewise prevents dedicated-profile fallback. An existing debug connection is limited to account ID `default`, because only one signed-in TikTok account can be active in that browser profile. Switching accounts manually in the browser may change which account receives future actions; check the active account before submitting posts.

## Attribution

TikTok Easy v0.1.4 packages and adapts **0xArtex/tiktok-mcp** at commit `99ef0359a55ff64b7d4a913369cca5c7bfd2683b`.

The upstream project is MIT licensed. Its original license is preserved in [THIRD_PARTY_LICENSES.md](./THIRD_PARTY_LICENSES.md).

Upstream: https://github.com/0xArtex/tiktok-mcp

## Important

This is an unofficial browser-session integration, not TikTok's official API. TikTok can change its website at any time, which may break browser selectors or flows. Browser automation can also carry account/platform risk. Do not use it for spam, artificial engagement, mass following, or evading TikTok controls.

## Account request protections in v0.1.2

Mutation attempts reserve an account budget **after** acquiring the cross-process browser-profile lock, using the same filesystem-locked state as other accounts. A reservation is recorded before a mutating UI action, including on unsuccessful/ambiguous attempts, so concurrent jobs and process crashes cannot silently reuse its capacity. Reservations use a 30-second inter-action gap and conservative rolling caps of 3 posts/24h, 20 follows/hour and 60 likes/hour. Rejected attempts are not automatically replayed.

HTTP 429/503 responses from TikTok endpoints and observed TikTok API flood-control errors establish persisted account-wide cooldowns across restarts (including Retry-After where available). The browser no longer masks Playwright's automation indicator or blocks TikTok monitoring URLs. These safeguards reduce accidental request bursts but do not guarantee account safety or grant API authorization.

Normal TikTok browser reads and analytics are also blocked during a persisted platform cooldown, before opening the browser; QR login recovery remains available. Media download/upload preparation first checks the current protective budget without reserving it. The actual reservation is made immediately before an external mutation under the profile lock, preventing long uploads from expiring their request spacing before submission.

**Post duplicate protection:** TikTok Easy hashes the input video and normalized caption, privacy, interaction and scheduling options into an account-specific intent ID. Multiple MCP processes submitting the same intent within 24 hours reuse the original background operation ID rather than posting twice. A crashed or ambiguous previous post is reported `UNCERTAIN` and is not automatically retried; verify in TikTok Studio before changing inputs or attempting another post. A known failed pre-submission launch or protective rate-limit admission may be retried. File video identities are hashed incrementally from their contents (not path), and the persistent record stores a digest, not the video or credentials. This local safety window does not prevent manual posts or guarantee perfect idempotency outside the plugin.

Offline checks: `npm --prefix tiktok-easy test` (packaged runtime regression tests) and `node tiktok-easy/scripts/build-v0.1.4.mjs` (deterministic rebuild from immutable v0.1.3 source ZIP; downloads npm dependencies, no TikTok access).

The upstream implementation uses a QR relay service for the shareable login link. The browser session and persistent profile stay local, but QR handoff uses the relay described by the upstream project.

## License

TikTok Easy wrapper/project code is licensed under the **GNU Affero General Public License v3.0 or later (AGPL-3.0-or-later)**. The upstream `0xArtex/tiktok-mcp` code remains under its original MIT license, preserved in [THIRD_PARTY_LICENSES.md](./THIRD_PARTY_LICENSES.md).
