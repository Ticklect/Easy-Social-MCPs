# YouTube Easy v0.1.0 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build and release a self-contained YouTube Studio browser-session MCPB with safe uploads, edits, reads, cross-process coordination, and fail-closed verification.

**Architecture:** A dependency-free Node 22 MCP server launches a supported Chromium browser with a dedicated profile and drives Google/YouTube through loopback-only CDP. Mutations pass through an atomic filesystem ledger and centralized Studio UI adapter that must re-read exact state before its final commit click.

**Tech Stack:** Node.js 22 ESM, Node built-in WebSocket/fetch/test runner, Chrome DevTools Protocol, MCP stdio JSON-RPC, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-09-19-youtube-easy-design.md`

## Global Constraints

- No YouTube Data API, Google Cloud project, OAuth client, API key, refresh token, copied cookie, session-token export, or credential environment variable.
- No runtime `npm install`; the MCPB runs from bundled JavaScript with Node 22 built-ins only.
- Use a dedicated local profile and support Helium, Chrome, Edge, and Chromium on Windows, macOS, and Linux.
- CDP discovery and WebSockets are loopback-only and exact-port validated.
- Navigate only to strict HTTPS Google/YouTube hosts required by the spec.
- Acquire filesystem-backed profile and account/fingerprint write leases before duplicate checking.
- Fail closed before publish/schedule/save unless file, title, audience, visibility, scheduling, and all requested fields are re-read and verified.
- Persist video IDs and URLs as early as observable; ambiguous recovery returns `UNCERTAIN` and never retries automatically.
- Never perform a live upload as part of this plan.

## Review Focus

- A lookalike hostname such as `studio.youtube.com.evil.test` must be rejected before navigation.
- Two independent processes racing an identical upload must invoke the external operation once.
- A crash after possible dispatch with ambiguous Studio results must return `UNCERTAIN` on every retry without a second operation.
- A mismatched audience, visibility, selected file, or schedule must leave the final-action adapter uncalled.
- Shorts with unreadable metadata, landscape dimensions, or duration above 180 seconds must stop before publication.

---

### Task 1: Package skeleton, validation, and MCP catalog

**Files:**
- Create: `youtube-easy/package.json`
- Create: `youtube-easy/manifest.json`
- Create: `youtube-easy/src/validation.js`
- Create: `youtube-easy/src/catalog.js`
- Create: `youtube-easy/src/server.js`
- Test: `youtube-easy/test/validation.test.mjs`
- Test: `youtube-easy/test/server-smoke.test.mjs`

**Interfaces:**
- Produces: `parseGoogleYoutubeUrl(value)`, `validateDebuggerWs(value, port)`, `validateUploadInput(args, fsApi)`, `validateShortMetadata(metadata)`, `TOOL_DEFINITIONS`, and `runServer({handlers,input,output})`.
- Consumes: no earlier task interfaces.

- [ ] Write validation and smoke tests asserting strict hosts, explicit schedule offsets, upload field limits, Short constraints, and all seventeen required tool names.
- [ ] Run `node --test youtube-easy/test/validation.test.mjs youtube-easy/test/server-smoke.test.mjs`; expect failures because modules do not exist.
- [ ] Implement the minimal validation, catalog, manifest, package, and JSON-RPC server behavior needed by the tests.
- [ ] Re-run the two tests; expect all assertions to pass.
- [ ] Commit with `git commit -m "feat(youtube): add package skeleton and MCP catalog"`.

### Task 2: Browser discovery and secure CDP profile runtime

**Files:**
- Create: `youtube-easy/src/browser.js`
- Test: `youtube-easy/test/browser.test.mjs`

**Interfaces:**
- Consumes: `parseGoogleYoutubeUrl` and `validateDebuggerWs` from Task 1.
- Produces: `browserCandidates(platform, env, exists)`, `YouTubeBrowser`, `withYouTubePage(fn)`, and `closeDedicatedBrowser()`.

- [ ] Write tests for browser paths on all platforms, loopback-only debugger discovery, exact port matching, dedicated-profile launch arguments, and rejected off-domain target reuse.
- [ ] Run `node --test youtube-easy/test/browser.test.mjs`; expect module-not-found failure.
- [ ] Implement the built-in CDP client, target discovery, navigation, file-input assignment, and browser lifecycle with dependency injection for tests.
- [ ] Re-run the browser tests; expect all assertions to pass.
- [ ] Commit with `git commit -m "feat(youtube): add secure dedicated browser runtime"`.

### Task 3: Cross-process leases, write ledger, and reconciliation states

**Files:**
- Create: `youtube-easy/src/coordination.js`
- Create: `youtube-easy/test/coordination-worker.mjs`
- Test: `youtube-easy/test/coordination.test.mjs`

**Interfaces:**
- Produces: `withLease(options, fn)`, `withProfileLease(root, fn)`, `coordinatedWrite(options)`, `KnownNotAppliedError`, `formatWriteOutcome(outcome)`, and persisted normalized video results.
- Consumes: normalized action/account/fingerprint data supplied by later handlers.

- [ ] Write independent-process tests for duplicate races, profile serialization, stale recovery, persisted result reuse, definite-found reconciliation, definite-miss retry, and ambiguous `UNCERTAIN` reuse.
- [ ] Run `node --test youtube-easy/test/coordination.test.mjs`; expect module-not-found failure.
- [ ] Implement atomic JSON writes, heartbeat leases, stale quarantine, write phases, result persistence, and found/not-found/unknown reconciliation.
- [ ] Re-run the coordination tests; expect all assertions to pass.
- [ ] Commit with `git commit -m "feat(youtube): add cross-process write coordination"`.

### Task 4: Studio semantic adapter and fail-closed verifier

**Files:**
- Create: `youtube-easy/src/studio.js`
- Test: `youtube-easy/test/studio-verification.test.mjs`
- Create: `youtube-easy/test/fixtures/upload-state.json`

**Interfaces:**
- Consumes: `YouTubeBrowser` page operations from Task 2 and normalized upload/edit intents from Task 1.
- Produces: `verifyUploadState(expected, actual)`, `verifyEditState(expected, actual)`, `commitOnlyAfterVerification({readState,expected,commit})`, and `StudioAdapter` methods for login/status, content rows, upload dialog, video details, comments, and deletion.

- [ ] Write simulated DOM/state tests for exact success plus filename, size, title, audience, visibility, schedule, thumbnail, playlist, and tag mismatches; assert the commit spy remains at zero for every failure.
- [ ] Run `node --test youtube-easy/test/studio-verification.test.mjs`; expect module-not-found failure.
- [ ] Implement centralized selectors, conservative semantic fallbacks, structured state readers, comparison diagnostics, and the final-action gate.
- [ ] Re-run the verifier tests; expect all assertions to pass.
- [ ] Commit with `git commit -m "feat(youtube): add fail-closed Studio adapter"`.

### Task 5: Upload, edit, thumbnail, schedule, delete, and comment handlers

**Files:**
- Create: `youtube-easy/src/writes.js`
- Test: `youtube-easy/test/writes.test.mjs`

**Interfaces:**
- Consumes: validators from Task 1, browser/profile access from Task 2, coordination from Task 3, and `StudioAdapter` from Task 4.
- Produces: handlers for `upload_video`, `upload_short`, `update_video`, `set_thumbnail`, `schedule_video`, `delete_video`, and `reply_to_comment`.

- [ ] Write handler tests with a real temporary ledger and a fake Studio boundary, including early video-ID persistence, Short validation, safe retries, reply reconciliation, deletion reconciliation, and no final call after verification failure.
- [ ] Run `node --test youtube-easy/test/writes.test.mjs`; expect module-not-found failure.
- [ ] Implement normalized fingerprints, sampled file hashing, action-specific reconciliation, and the seven write handlers.
- [ ] Re-run the write tests; expect all assertions to pass.
- [ ] Commit with `git commit -m "feat(youtube): add coordinated Studio writes"`.

### Task 6: Status, channel, videos, search, video, comments, and transcript reads

**Files:**
- Create: `youtube-easy/src/reads.js`
- Test: `youtube-easy/test/reads.test.mjs`

**Interfaces:**
- Consumes: browser/profile access and `StudioAdapter`.
- Produces: handlers for `youtube_login`, `youtube_status`, `get_my_videos`, `get_upload_status`, `get_comments`, `get_channel`, `search_youtube`, `get_video`, `get_transcript`, and `youtube_forget_session`.

- [ ] Write fixture-driven tests for bounded extraction, ID parsing, transcript availability/unavailability, untrusted-content warnings, and safe profile deletion behavior.
- [ ] Run `node --test youtube-easy/test/reads.test.mjs`; expect module-not-found failure.
- [ ] Implement the ten read/session handlers and wire all handlers into `src/server.js`.
- [ ] Re-run read tests and the MCP smoke test; expect all assertions to pass.
- [ ] Commit with `git commit -m "feat(youtube): add YouTube read and session tools"`.

### Task 7: Documentation, source/dist parity, and packaging workflow

**Files:**
- Create: `youtube-easy/README.md`
- Create: `youtube-easy/SECURITY.md`
- Create: `youtube-easy/LICENSE`
- Create: `youtube-easy/THIRD_PARTY_LICENSES.md`
- Create: `youtube-easy/scripts/build.mjs`
- Create: `.github/workflows/build-youtube-easy.yml`
- Modify: `README.md`
- Test: `youtube-easy/test/package.test.mjs`

**Interfaces:**
- Consumes: all runtime modules and manifest from Tasks 1-6.
- Produces: reproducible `dist`, MCPB, source ZIP, SHA-256, and release workflow.

- [ ] Write a package test that builds into a temporary directory, opens the MCPB as ZIP, checks required entries/version/tool count, and runs initialize plus tools/list against the packaged server.
- [ ] Run `node --test youtube-easy/test/package.test.mjs`; expect failure because the build script and docs are absent.
- [ ] Implement the dependency-free build script, user/security/attribution docs, root README entry, and GitHub Actions workflow that tests, packages, commits artifacts, and creates tag `youtube-easy-v0.1.0`.
- [ ] Run `npm --prefix youtube-easy run check`, `npm --prefix youtube-easy test`, and `npm --prefix youtube-easy run build`; expect success and the three release artifacts.
- [ ] Commit with `git commit -m "build(youtube): package YouTube Easy v0.1.0"`.

### Task 8: Whole-branch verification, review, integration, and release

**Files:**
- Modify only files required by review findings, with a failing regression test before each fix.

**Interfaces:**
- Consumes: complete branch from Tasks 1-7.
- Produces: reviewed main-branch release and exact release/download URLs.

- [ ] Run fresh syntax, full tests, MCP smoke, package inspection, checksum verification, and `git diff --check`; record exact counts.
- [ ] Dispatch one fresh whole-branch reviewer with the spec, plan, base SHA, and head SHA; fix Critical/Important findings through RED-GREEN tests and defer only true Minor findings.
- [ ] Push the feature branch, create and attach a pull request, merge it to `main`, and verify the merge commit because the user explicitly authorized completing the release.
- [ ] Run or monitor the YouTube Easy workflow until artifacts and GitHub Release `youtube-easy-v0.1.0` are present; verify the release assets and checksum without performing a live upload.
- [ ] Report exact URLs, implemented tools, test/pass counts, unverified live-login items, and browser/UI risks.
