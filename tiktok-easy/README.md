# TikTok Easy

**Import → log in → post.**

TikTok Easy packages the MIT-licensed `0xArtex/tiktok-mcp` browser-session implementation into a ready-to-import MCPB so normal users do not need to clone a repo, run `npm install`, configure API keys, or create a TikTok developer app.

## Setup

1. Import `tiktok-easy-v0.1.0.mcpb` into an MCPB-compatible host.
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

TikTok Easy v0.1.0 packages and lightly adapts **0xArtex/tiktok-mcp** at commit `99ef0359a55ff64b7d4a913369cca5c7bfd2683b`.

The upstream project is MIT licensed. Its original license is preserved in [THIRD_PARTY_LICENSES.md](./THIRD_PARTY_LICENSES.md).

Upstream: https://github.com/0xArtex/tiktok-mcp

## Important

This is an unofficial browser-session integration, not TikTok's official API. TikTok can change its website at any time, which may break browser selectors or flows. Browser automation can also carry account/platform risk. Do not use it for spam, artificial engagement, mass following, or evading TikTok controls.

The upstream implementation uses a QR relay service for the shareable login link. The browser session and persistent profile stay local, but QR handoff uses the relay described by the upstream project.

## License

TikTok Easy wrapper/project code is licensed under the **GNU Affero General Public License v3.0 or later (AGPL-3.0-or-later)**. The upstream `0xArtex/tiktok-mcp` code remains under its original MIT license, preserved in [THIRD_PARTY_LICENSES.md](./THIRD_PARTY_LICENSES.md).
