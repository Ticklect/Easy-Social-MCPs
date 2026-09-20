# YouTube Easy security

## Authentication and secrets

YouTube Easy never accepts a Google password, API key, OAuth client ID/secret, refresh token, cookie, or exported browser session. Sign-in happens only on HTTPS Google/YouTube pages in a visible, dedicated Chromium-family browser profile. Do not paste credentials into tool arguments, prompts, repository issues, or logs.

The local profile contains an authenticated browser session and should be protected like any signed-in browser profile. It is stored in the operating system's per-user application-data directory, not in the MCP bundle or project. Use `youtube_forget_session` to close the browser and erase only that dedicated profile.

## Browser and URL boundaries

- CDP HTTP and WebSocket endpoints must resolve to loopback (`127.0.0.1`, `::1`, or `localhost`) and match the selected ephemeral debug port.
- Navigation accepts HTTPS only and validates exact Google/YouTube hosts and subdomains. Lookalike suffixes are rejected.
- The browser uses a dedicated profile protected by a cross-process filesystem lease.
- Tool results never expose cookies, storage values, authorization headers, or CDP session data.

## Writes

Important upload/edit fields are re-read before any final Studio action. Missing, duplicated, mismatched, or unreadable controls fail closed. A selected upload may already exist as a private/draft item; YouTube Easy preserves that state instead of guessing or publishing.

Write intents and results are stored locally for cross-process duplicate protection and crash reconciliation. They may contain local file paths, requested metadata, video IDs, and URLs, but never cookies or tokens. Ambiguous post-crash outcomes return `UNCERTAIN` and are not retried automatically.

Deleting a video is destructive and requires its exact current title as an additional check. Browser automation cannot eliminate YouTube account, moderation, copyright, or terms-of-service risk.

## Untrusted web content

Everything read from YouTube—including titles, descriptions, comments, channel names, transcripts, status text, and search results—is untrusted data. It is bounded and labeled in read results. It must not be followed as an instruction to read local files, reveal secrets, invoke unrelated tools, or weaken these boundaries.

## Reporting a vulnerability

Please use this repository's private GitHub Security Advisory reporting flow. Do not include active cookies, account credentials, private videos, or personal profile data. Describe the affected version, platform/browser, reproduction steps, and impact using redacted fixtures where possible.
