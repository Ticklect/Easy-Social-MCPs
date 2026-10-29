# Easy Social MCPs — second engineering pass (29 October 2026)

This report supplements `PERFORMANCE-QA-2026-10-29.md`. All benchmarks used
inert local mocks or loopback test servers. No signed-in browser, social
network, post, upload, deployment or release-publishing action was used.

## Baseline reconciliation

Before editing source we independently reran all seven complete test suites
on the actual working tree, with `TEMP` and `TMP` set to a project-owned D:
directory. **214/214 tests passed** (Reddit 27, X 24, YouTube 97,
browser-companion 12, installer 22, combined package 3, TikTok 29).
`easy-social-mcps/easy-social-mcps-v0.1.7.zip` matched its original SHA-256:

`e312b2cf20a2a1dcca8a84f6f12cbe6b88dd9e667a2aada061257be8883f1549`

All original unrelated working-tree edits were preserved. Existing versioned
component artifacts were not overwritten.

## CDP liveness: Reddit and X

The previous `CdpClient` implementations could leave silent commands waiting
indefinitely and leave entries in the pending map. Failed socket handshakes
could receive a late `open` event and reactivate a closed client.

New Reddit v0.3.6 and X v0.1.5 runtime builds use bounded 30-second command
deadlines, reject and clean all outstanding commands when a connection fails,
close failed sockets, prevent late event resurrection and reject future use of
a failed client. No automatic retry follows an uncertain write. Domain-enable
acknowledgements remain required and X HTTP 429/503 cooldown handling remains
active.

In deterministic mock tests with a 10 ms accelerated deadline, silent commands
now reject with the outcome unknown, closed socket and `pending.size === 0`;
previously the same command remained unresolved after 40 ms. The timeout is
30 seconds in the shipped runtime, not 10 ms. Five successful mock read
invocations with 6 ms CDP RTT measured:

| Runtime | Before p50 | After p50 | Interpretation |
| --- | ---: | ---: | --- |
| Reddit | 62.10 ms | 61.78 ms | No measurable normal-path regression |
| X | 62.45 ms | 62.62 ms | No meaningful normal-path regression |

These are recovery and correctness improvements, not a claim of faster
successful end-to-end social writes. New `test/cdp-liveness.test.mjs` covers
silence, mid-flight disconnect, failed send, aborted handshake, late open,
repeated connections and X rate-limit observation.

## Browser companion: retained WebSocket account selection

An existing CDP page WebSocket could previously keep sending commands to the
first browser after a second browser companion connected. New discovery would
refuse to choose an account, but the old connection retained the original
browser reference. A new loopback integration test reproduced this behavior.

`browser-companion/server.mjs` now checks unique browser selection **before
each command** and **again before sending its success acknowledgement**. If a
second browser connects while a command is in flight, the result is marked an
error/uncertain; no later new commands are sent through that stale page
connection while selection remains ambiguous. It does not automatically retry
any action. `test/bridge-account-switch.test.mjs` covers both in-flight and
later commands.

An independent bridge loopback benchmark completed 1,000 concurrent synthetic
CDP commands without unexpected errors. In a separate 200-cycle reconnect
stress test, 800 successful commands and 20 intentionally dropped in-flight
commands left no pending bridge request timers or active client sockets.
The recorded reconnect p50/p95 was 1.809/2.302 ms, and command p50/p95
was 0.315/0.412 ms; process handles remained 2→2. Four alternating
600-serial/640-concurrent comparisons against HEAD and modified server showed
no reliable slowdown from the added selection checks. Bench CPU and RSS
samples vary with JIT and garbage collection and do not prove a memory gain.

## Windows discovery: potential gain with a substantial memory tradeoff

The existing cold PowerShell process scans were remeasured over five runs each,
with p50/p95 Reddit 345.15/375.71 ms, X 375.65/385.83 ms, and YouTube
319.11/344.58 ms. Each queried the machine's existing opted-in debugger
processes and found zero candidates during this baseline run.

`scripts/bench-warm-windows-process-query.ps1` performed 12 **fresh** CIM
snapshots in one warmed PowerShell process, with p50/p95 36.44/170.86 ms and
265.62 ms accumulated child CPU. Its resident memory grew from 87.35 to
93.76 MB. These results demonstrate PowerShell startup/module initialization
cost, but exclude Node-to-PowerShell IPC, process lifecycle management and
the consequence of retaining one helper for each running MCP server. A warm
scanner must not cache candidate results between separate tool calls. Until
recovery, idle shutdown and ambiguity handling are verified, this is an
engineering candidate rather than a runtime optimization.

### Fresh-scan PowerShell IPC prototype: evaluated but deliberately not shipped

A follow-up prototype in `scripts/bench-warm-process-ipc-{client.mjs,worker.ps1,mock.mjs,test.mjs}`
and its benchmark driver demonstrated the potential gain with real Node-to-
PowerShell IPC and **fresh** owner-checked process enumeration every time.
Twenty repeated local scans, with no eligible debugger process present:

| Method | p50 | p95 | Scope |
| --- | ---: | ---: | --- |
| Existing cold process | 379.42 ms | 468.31 ms | Process launch on every scan |
| New IPC worker restarted each scan | 429.52 ms | 477.97 ms | Startup/IPC cost |
| Warm persistent IPC worker | 48.92 ms | 56.63 ms | One resident worker, new CIM snapshot per request |

Warm execution was about **7.8× faster at p50** for this narrowly defined
repeated scan. Cold startup for five fresh workers was 417.70/430.99 ms
p50/p95; the first persistent-worker scan took 491.19 ms. Accumulated CPU
measurements are approximate: cold PowerShell child CPU p50/p95 was
140.63/187.50 ms, versus warm scan 0/15.63 ms under Windows time sampling.
The persistent PowerShell child used **100.5 MB RSS p50 and 119.88 MB p95**
over 20 scans; its RSS rose during the sample. Node RSS change was negligible
in comparison.

The prototype checks individual request IDs, malformed responses, stale
replies, process ownership, up to 32 unique ports, timeouts, child exits,
idle termination and `--remote-debugging-port=0` with safe local profile-file
validation. **8/8 focused tests passed** independently after fixing a
Windows junction-fixture cleanup issue. Test-created junction fixtures were
cleaned without touching their target directories.

**Decision: leave the production discovery code unchanged.** Keeping a
roughly 100–120 MB resident PowerShell process per MCP is costly, particularly
when real tool calls are spaced apart by pacing and the helper would frequently
restart. The prototype's browser-name coverage and symlink/profile semantics
are not yet identical to the existing integrations, and a real browser-positive
multi-account end-to-end workload has not established a safe net benefit.
There is no stale account cache in production; each discovery call still
checks the live candidates and preserves account ambiguity rejection.

## Package and regression validation

New local component archives are `reddit-easy-v0.3.6.mcpb` and
`x-easy/x-easy-v0.1.5.mcpb`; their checksums are respectively:

`95956d2ba448516324e0c2164570222594d43fa717e538155ea17547cf1caf89`

`5a481453d85e24c8aee2cf4d675b2867b4824a9be823949c8d797ae54fb06353`

The new local combined archive is
`easy-social-mcps/easy-social-mcps-v0.1.8.zip` (SHA-256 below), containing
the patched companion server, new integration test, 300-cycle lifecycle
test/benchmark and new Reddit/X MCPBs alongside the unchanged staged TikTok
v0.1.6 and YouTube v0.1.5 MCPBs.

`e40b084e484613a00819fde77ea918317972d4ce8520d02c8a07ddffc549cfab`

The package initially rebuilt byte-for-byte reproducibly and its three
packaging tests passed. All work remains local, uncommitted and unpublished.

### Independently rerun post-change complete test suites

With `TEMP` and `TMP` on D:, all seven suites were rerun after both the
Reddit/X and companion changes: **230/230 passing tests**.

| Suite | Tests passing |
| --- | ---: |
| Reddit | 42/42 |
| X | 24/24 |
| YouTube | 97/97 |
| Browser companion | 13/13 |
| Installer | 22/22 |
| All-in-one v0.1.8 | 3/3 |
| TikTok | 29/29 |

Combined ZIP SHA-256 was independently rechecked, and the previous v0.1.7 ZIP
still matched its original hash. The new component versions were built to new
versioned filenames; no prior versioned ZIP/MCPB was overwritten. Versioned
local build artifacts are uncommitted in the project working tree.

## Reproduce relevant tests

Run from the repository root with a sufficiently large `TEMP`/`TMP` on D:

```powershell
npm test
npm --prefix x-easy test
npm --prefix youtube-easy test
npm --prefix browser-companion test
npm --prefix easy-mcp-installer test
npm --prefix easy-social-mcps test
Push-Location tiktok-easy
node --test --test-concurrency=1 test/*.test.mjs
Pop-Location
node --test test/cdp-liveness.test.mjs
node --test browser-companion/test/bridge-account-switch.test.mjs
powershell.exe -NoProfile -NonInteractive -File scripts/bench-warm-windows-process-query.ps1 -Samples 12
```

The live Chromium handshake, website DOM and operating-system behavior under
production load remain unmeasured. No 100× end-to-end speedup is claimed.
