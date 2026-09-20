# YouTube Easy v0.1.0 Design

## Purpose

YouTube Easy is a ready-to-import MCPB that lets a channel owner sign in through a dedicated local Chromium profile and operate YouTube and YouTube Studio without the YouTube Data API, Google Cloud, OAuth client credentials, API keys, copied browser credentials, or a runtime package installation.

The setup contract is:

`download .mcpb -> import -> youtube_login -> sign in on Google/YouTube -> done`

Authentication happens only in the visible Google/YouTube browser pages. The MCP never accepts or returns a Google password, cookie, session token, OAuth credential, or API key.

## Runtime and packaging

The runtime targets Node.js 22 or newer and uses only Node built-ins. It controls an installed Helium, Google Chrome, Microsoft Edge, or Chromium browser through Chrome DevTools Protocol (CDP). The package contains source-independent runtime JavaScript, documentation, license files, and its manifest; users do not run `npm install` or edit MCP JSON.

YouTube Easy stores state below the platform application-data directory in a `YouTubeEasy` directory. A dedicated `browser-profile` directory contains the authenticated browser state. Coordination records live beside the profile and are private to the current OS user where permissions support it.

## Security boundaries

- Browser discovery supports Helium, Chrome, Edge, and Chromium on Windows, macOS, and Linux.
- The browser launches with an unpredictable Chrome-assigned debugging port and `--remote-debugging-address=127.0.0.1`.
- Debugger discovery accepts only loopback HTTP and WebSocket endpoints whose ports exactly match `DevToolsActivePort`.
- Web navigation accepts HTTPS URLs only on exact Google and YouTube hosts or their real subdomains: `youtube.com`, `youtu.be`, `google.com`, `googleusercontent.com`, and `gstatic.com`. Hostname suffix checks include the dot boundary so lookalikes are rejected.
- Google/YouTube page text, titles, descriptions, comments, transcripts, and Studio labels are untrusted external content. They may be returned as data but never interpreted as instructions to access files, secrets, credentials, or unrelated tools.
- Local file access is limited to explicit video and thumbnail paths supplied to the relevant tool. Paths must resolve to regular files before the browser is opened.
- CDP responses, cookies, request headers, session tokens, and page credential fields are never emitted in tool output or intentional logs.

## MCP tools

The server exposes these tools:

- `youtube_login`: open Studio in the dedicated profile for normal sign-in.
- `youtube_status`: report browser availability, login status, channel name, channel ID, and Studio URL when verified.
- `upload_video`: upload a regular video with file path, title, description, visibility, audience, optional schedule, thumbnail, playlist, and tags.
- `upload_short`: use the upload flow only after the selected file proves square/vertical and no longer than 180 seconds.
- `get_my_videos`: read the signed-in channel's Studio content list.
- `get_upload_status`: read Studio upload/processing status for a verified video ID.
- `update_video`: edit supported metadata and verify every requested field before save.
- `set_thumbnail`: upload a thumbnail, verify the selected thumbnail state, then save.
- `schedule_video`: set an existing video to private-until-public at an ISO-8601 instant with an explicit UTC offset.
- `delete_video`: delete a verified owned video and reconcile absence after confirmation.
- `get_comments`: read published Studio comments, optionally filtered by video.
- `reply_to_comment`: submit a reply to a specific Studio comment and reconcile by exact text under that comment.
- `get_channel`: read a public channel page or the current signed-in channel.
- `search_youtube`: search public YouTube and return bounded structured results.
- `get_video`: read a public watch page and return bounded metadata.
- `get_transcript`: use the public watch-page transcript UI when captions expose a transcript; otherwise return an explicit unavailable result.
- `youtube_forget_session`: close the dedicated browser and erase only YouTube Easy's local profile.

All returned external strings are bounded in size and accompanied by an untrusted-content warning.

## Upload and edit safety

`visibility` is required for uploads and is one of `private`, `unlisted`, or `public`. `made_for_kids` is required and boolean. `publish_at`, when present, must be ISO-8601 with an explicit `Z` or numeric UTC offset and is valid only for an eventually public scheduled upload. Tags and playlist are optional and applied only when Studio exposes the corresponding controls.

Before the final publish, schedule, or save action, YouTube Easy re-reads the current Studio state and compares it with the request. Required upload verification covers:

- selected filename and byte size;
- exact title;
- exact description when provided;
- made-for-kids selection;
- visibility or scheduled-public mode;
- schedule date, time, and time zone;
- requested thumbnail;
- requested playlist;
- requested tags when Studio exposes tags.

The final action is not clicked if a requested field is absent, ambiguous, unreadable, or mismatched. The runtime leaves the item in Studio's existing draft/private state and returns a clear unsupported or verification error. It never silently degrades a requested field and never silently publishes.

The browser-side Short validator obtains duration and dimensions from the selected input `File` through an object URL. Failure to read metadata, duration over 180 seconds, or landscape dimensions stops before publication.

## Cross-process coordination

Filesystem-backed leases use atomic directory creation, owner IDs, heartbeat files, and stale-lock quarantine/recovery. Separate Node/MCP processes coordinate through the same state directory.

The dedicated browser profile has a single cross-process lease. Each mutating request also has an account-plus-request-fingerprint lease acquired before duplicate lookup. Account identity is the verified YouTube channel ID. Fingerprints are SHA-256 hashes over the action and normalized significant arguments; upload fingerprints additionally include the canonical file path, size, modification time, and sampled content hash.

The write ledger is atomically persisted before the first potentially mutating UI action and after each important phase. Successful results retain the video ID, Studio URL, public URL, channel ID, and verified fields where available.

## Crash recovery and uncertainty

After a prior process may have acted, a new process reconciles before retrying:

- uploads first use a persisted video ID, then a bounded Studio search using channel, title, upload time, and file fingerprint evidence;
- metadata, thumbnail, and schedule writes compare the current Studio state with the intended state;
- comment replies search replies beneath the target comment for exact text by the signed-in channel;
- deletion verifies whether the owned video still exists.

If the action definitely happened, the persisted or reconstructed result is returned without another write. If it definitely did not happen, one safe retry is allowed. If neither conclusion is supportable, the ledger records `uncertain` and the tool returns a result beginning with `UNCERTAIN`; no automatic retry occurs.

## DOM automation

Studio automation uses semantic labels, roles, stable component IDs where available, and exact state readback. Page helpers return structured snapshots from within the page rather than exposing arbitrary script execution as an MCP tool. The runtime waits on observable conditions rather than fixed sleeps wherever possible.

Selectors are centralized and have conservative fallbacks. Multiple matching final-action buttons, unknown dialog steps, changed labels, missing fields, or contradictory values are ambiguity and stop the workflow.

## Testing

Node's built-in test runner covers:

- syntax and manifest checks;
- MCP `initialize` plus `tools/list` smoke behavior;
- browser detection across supported platforms;
- strict Google/YouTube URL and loopback debugger validation;
- file and scheduling validation;
- Short duration/aspect validation;
- simulated Studio DOM state extraction and exact verification;
- proof that a verification failure never calls the final publish/save adapter;
- cross-process profile serialization;
- two-process duplicate write races;
- stale-lock recovery;
- persisted result reuse;
- crash-after-dispatch reconciliation;
- explicit uncertain outcomes without retry.

Live Google sign-in, live Studio selectors, and a real private/unlisted upload are intentionally outside automated CI. Release documentation must say that live upload was not verified unless the user separately authorizes and completes that test.

## Release

The repository contains `youtube-easy/README.md`, `SECURITY.md`, `LICENSE`, `THIRD_PARTY_LICENSES.md`, `manifest.json`, source, tests, and a GitHub Actions build/test/release workflow. The workflow produces:

- `youtube-easy/youtube-easy-v0.1.0.mcpb`
- `youtube-easy/youtube-easy-v0.1.0-source.zip`
- `youtube-easy/youtube-easy-v0.1.0.mcpb.sha256`
- GitHub Release tag `youtube-easy-v0.1.0`

The root README links YouTube Easy beside Reddit Easy, X Easy, and TikTok Easy.
