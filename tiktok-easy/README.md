# TikTok Easy

**Import → log in → post.**

TikTok Easy packages the MIT-licensed `0xArtex/tiktok-mcp` browser-session implementation into a ready-to-import MCPB so normal users do not need to clone a repo, run `npm install`, configure API keys, or create a TikTok developer app.

## Setup

1. Import `tiktok-easy-v0.1.2.mcpb` into an MCPB-compatible host.
2. Run `tiktok_login` for the simple default account, or `tiktok_connect` for an explicitly named account.
3. Scan the TikTok QR code and confirm login.
4. Ask the agent to post, schedule, follow, like, manage profile details, or inspect analytics.

There are **no TikTok API keys or developer credentials** in the plugin setup.

## Main tools

- `tiktok_login` — easy default-account QR login
- `tiktok_connect` / `tiktok_connect_status` — advanced/multi-account QR login
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

TikTok Easy adds Helium detection on top of the upstream Chrome/Edge/Brave/Chromium support.

## Attribution

TikTok Easy v0.1.2 packages and adapts **0xArtex/tiktok-mcp** at commit `99ef0359a55ff64b7d4a913369cca5c7bfd2683b`.

The upstream project is MIT licensed. Its original license is preserved in [THIRD_PARTY_LICENSES.md](./THIRD_PARTY_LICENSES.md).

Upstream: https://github.com/0xArtex/tiktok-mcp

## Important

This is an unofficial browser-session integration, not TikTok's official API. TikTok can change its website at any time, which may break browser selectors or flows. Browser automation can also carry account/platform risk. Do not use it for spam, artificial engagement, mass following, or evading TikTok controls.

## Account request protections in v0.1.2

Mutation attempts reserve an account budget **after** acquiring the cross-process browser-profile lock, using the same filesystem-locked state as other accounts. A reservation is recorded before a mutating UI action, including on unsuccessful/ambiguous attempts, so concurrent jobs and process crashes cannot silently reuse its capacity. Reservations use a 30-second inter-action gap and conservative rolling caps of 3 posts/24h, 20 follows/hour and 60 likes/hour. Rejected attempts are not automatically replayed.

HTTP 429/503 responses from TikTok endpoints and observed TikTok API flood-control errors establish persisted account-wide cooldowns across restarts (including Retry-After where available). The browser no longer masks Playwright's automation indicator or blocks TikTok monitoring URLs. These safeguards reduce accidental request bursts but do not guarantee account safety or grant API authorization.

Normal TikTok browser reads and analytics are also blocked during a persisted platform cooldown, before opening the browser; QR login recovery remains available. Media download/upload preparation first checks the current protective budget without reserving it. The actual reservation is made immediately before an external mutation under the profile lock, preventing long uploads from expiring their request spacing before submission.

**Post duplicate protection:** TikTok Easy hashes the input video and normalized caption, privacy, interaction and scheduling options into an account-specific intent ID. Multiple MCP processes submitting the same intent within 24 hours reuse the original background operation ID rather than posting twice. A crashed or ambiguous previous post is reported `UNCERTAIN` and is not automatically retried; verify in TikTok Studio before changing inputs or attempting another post. A known failed pre-submission launch or protective rate-limit admission may be retried. File video identities are hashed incrementally from their contents (not path), and the persistent record stores a digest, not the video or credentials. This local safety window does not prevent manual posts or guarantee perfect idempotency outside the plugin.

Offline checks: `npm --prefix tiktok-easy test` (packaged runtime regression tests) and `node tiktok-easy/scripts/build-v0.1.2.mjs` (deterministic rebuild from immutable v0.1.1 source ZIP; downloads npm dependencies, no TikTok access).

The upstream implementation uses a QR relay service for the shareable login link. The browser session and persistent profile stay local, but QR handoff uses the relay described by the upstream project.

## License

TikTok Easy wrapper/project code is licensed under the **GNU Affero General Public License v3.0 or later (AGPL-3.0-or-later)**. The upstream `0xArtex/tiktok-mcp` code remains under its original MIT license, preserved in [THIRD_PARTY_LICENSES.md](./THIRD_PARTY_LICENSES.md).
