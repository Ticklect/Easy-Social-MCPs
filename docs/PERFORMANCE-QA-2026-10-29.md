# Easy Social MCPs performance and QA — 29 October 2026

## Scope

Four browser-session MCPs (Reddit, X, TikTok, YouTube) plus their local Chromium
companion were profiled and optimized with deterministic mocks. Existing local
working-tree edits were preserved. The sessions were never used for live posts,
uploads, account actions or access to signed-in social accounts. No deployment
or release upload occurred.

## Before and after

All latencies are milliseconds; p50/p95 denote the 50th/95th sampled
percentile. These are **specific synthetic hot paths**, not entire user tasks.

| Hot path | Baseline p50 / p95 | Optimized p50 / p95 | p50 speedup | Workload and limits |
| --- | ---: | ---: | ---: | --- |
| Reddit CDP domain enable | 63.52 / 90.11 | 31.21 / 45.13 | 2.03x | Mock 30 ms per CDP domain; both acknowledgments required |
| X CDP domain enable | 108.10 / 128.93 | 31.45 / 45.26 | 3.44x | Mock 30 ms/domain; all three acknowledgments required |
| Companion command burst | 251.88 / 483.86 | 13.24 / 14.88 | 19.02x | 384 commands, 32 concurrent; mock extension/WebSocket and 2 ms Chrome attach queue |
| TikTok debugger discovery | 187.81 / 189.93 | 31.13 / 32.09 | 6.03x | Six validly formatted process candidates, 25 ms mock probe, 31 trials |
| TikTok first direct-post browser discovery | 93.54 / 95.00 | 47.02 / 48.01 | 1.99x | Real staged MCP server; 31 offline trials with mocked 35-ms debugger scan; two scans reduced to one |
| YouTube immediate duplicate Studio navigation | 141.71 / 142.70 | 94.08 / 96.30 | 1.51x | 24 trials; mocked CDP response 4 ms, navigation 40 ms |
| YouTube Studio selector readiness | 326.98 / 621.80 | 187.79 / 611.43 | 1.74x | 24 delayed DOM transitions of 40/130/270/540 ms; six-ms mock CDP RTT; bounded MutationObserver |

For the companion workload, the prior implementation made 448 attachment calls
(including warmup); the optimized implementation made 14, with zero failed
mock commands in either measured batch. Total benchmark-process CPU time fell
from 422 ms to 265 ms. RSS growth measured +6720 KiB vs +6320 KiB; this
single-process measurement is too noisy to assert a memory improvement.

## Safety guarantees exercised

- Every CDP domain acknowledgement must arrive before tools can navigate or
  operate; failures close the connection.
- TikTok enumerates every candidate and rejects ambiguous multiple-browser
  identities, even when their responses complete out of order. Up to eight
  candidates are probed concurrently without bypassing strict loopback and
  browser-identity checks.
- First direct TikTok post now selects the browser once, within the actual
  `existing_browser_only` connection. Missing or ambiguous sessions fail
  without automatically opening QR login or switching profile; no cached
  identity crosses separate tool calls.
- The companion's concurrent first commands share an in-flight debugger attach,
  revalidate the tab URL, and revoke access on tab removal, cross-site
  navigation, external detach, disconnect and stale connection replies.
- YouTube can skip just one immediately redundant Studio navigation after
  confirming live URL, document readiness and cooldown state. Subsequent
  explicit same-URL reloads still navigate.
- YouTube Studio upload selector waits now use one in-document observer capped at
  250 ms per evaluation and coalesce DOM mutations into 25-ms checks. The
  observer unsubscribes on success/timeout; CDP disconnects and mid-flight
  cooldowns still fail closed. No upload action or state verification is skipped.
- Website request pacing, rate limits, cooldowns, idempotency/uncertain-write
  handling and explicit user-session permissions remain enforced.

## Tests and local build

| Package | Complete suite |
| --- | ---: |
| Reddit | 27/27 pass |
| X | 24/24 pass |
| TikTok | 29/29 pass |
| YouTube | 97/97 pass |
| Browser companion | 12/12 pass |
| MCP installer | 22/22 pass |
| All-in-one candidate | 3/3 pass |

The locally staged all-in-one candidate is
`easy-social-mcps/easy-social-mcps-v0.1.7.zip` with checksum
`e312b2cf20a2a1dcca8a84f6f12cbe6b88dd9e667a2aada061257be8883f1549`
after integrating the final YouTube and TikTok components. The previous v0.1.6 archive was preserved. TikTok's optimized
component was built locally as v0.1.6; prior v0.1.5 files were untouched.
Nothing here has been published, installed to a live account, or deployed.

## Bottlenecks intentionally retained

Actual Windows process enumeration launched from Node has median cost of about
350–430 ms for Reddit, X and YouTube under a five-sample read-only run on this
PC. Retaining cached browser candidates could hide a newly opened second
signed-in browser and defeat the unique-account selection rule, so no
long-lived process-discovery cache was introduced.

The Reddit/X MCP stdio control plane is already fast once running: typical
warm ping p50 was 0.17 ms, while YouTube's warm tools/list p50 was 0.30 ms.
Optimizing those messages would not substantially change browser tool latency.

Follow-up deterministic profiling of X's actual 20-post read path yielded
p50/p95 1172.20/1194.40 ms with eight mocked 30 ms CDP round trips and an
intentional 900 ms hydration wait; the separate three-second read pacing was
excluded. Representative DOM extraction for 20 posts with 50 spans/images
each took only 0.262/0.485 ms p50/p95. Selector and JSON-normalization work
was also below 2 ms p95. Optimizing one redundant read round trip would save
about 30 ms (2.6% of the mocked read) and does not justify weakening safety
or hydration checks. The profiling script is `scripts/bench-social-read-hotspots.mjs`.

One TikTok full-test attempt failed because C: had only about 202 MiB free and
the test creates a media fixture exceeding 100 MiB; the complete suite passed
after routing TEMP/TMP to a project-owned directory on D:. Do not delete other
projects' temporary directories to make room. Real browser latency and account
behavior remain unmeasured.

Independent Chrome companion lifecycle stress (`scripts/bench-lifecycle.mjs`)
ran 320 deterministic reconnect/invalidate/attach cycles using mocked Chrome
and WebSocket APIs. It created 321 mock sockets and performed 320 attaches and
320 detaches. The test finished with **zero** live sockets, intervals, timers,
debuggers, pending requests, watched tabs or in-progress attachments. The
eight registered Chrome lifecycle listeners remained constant; max one
heartbeat interval was active. Mock cycle latency p50/p95 was
0.042/0.104 ms with 47 ms accumulated CPU; forced-GC Node heap changed by
+427 KiB and RSS by +1704 KiB. The latter allocations do not establish a
steady-state memory leak, and this mock cannot prove Chrome's native API
has no leaks. A 300-cycle version also passed in the complete companion suite.
A separate 1600-cycle stress run had p50/p95 0.066/0.141 ms, CPU 124 ms,
forced-GC heap +545 KiB and RSS +4708 KiB. All active resource counters were
again zero at the end, and the Node active handle count stayed at one.

## Reproduce offline

Run commands from the repository root unless indicated otherwise:

```powershell
node scripts/bench-windows-browser-discovery.mjs --samples=5
node scripts/bench-mcp-handshake.mjs --samples=6
node scripts/bench-social-read-hotspots.mjs
node --test test/cdp-bootstrap.test.mjs
node youtube-easy/scripts/bench-browser-latency.mjs --samples=24 --delay=4
node youtube-easy/scripts/bench-studio-polling.mjs --samples=24
node tiktok-easy/scripts/bench-browser-discovery.mjs
node tiktok-easy/scripts/bench-first-post-discovery.mjs
node tiktok-easy/scripts/bench-profile-identity.mjs
Push-Location browser-companion
node scripts/bench-command-burst.mjs
Pop-Location
Push-Location browser-companion
node --expose-gc scripts/bench-lifecycle.mjs
Pop-Location
```

The companion benchmark accepts `BENCH_BASELINE=1` to run the checked-in HEAD
extension logic against the exact same local fixture. The TikTok media stress
suite should be run with TEMP and TMP on a disk with sufficient free space.
