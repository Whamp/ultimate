# Local transport experiment (E1.1)

Optional engineering experiment, **not a product, deployment or supported host**. Nothing outside this directory changes. Uses the installed Ultimate source and dependencies; no new dependencies. Linux and Node 26 are used for the probe.

## Try it

From the repository root, with dependencies installed:

```sh
mise exec node@26.11.1 -- npm exec --yes --package=pnpm@11.8.0 -- pnpm install --frozen-lockfile
mise exec node@26.11.1 -- node .ultimate/prototypes/unified-host/transport/transport-launch.ts
```

The launcher prints JSON with the gateway URL, launcher PID, temporary directory and both child addresses/PIDs. Open that URL on this machine. Two real faux Ultimate child servers run on distinct ephemeral loopback ports, each with its own temporary project, SQLite store, `HOME`, explicit `userHome`, XDG config directory and `PI_CODING_AGENT_DIR`. The child environment is an allowlist, not a copy of the parent environment. No personal config, Pi auth files or credentials are copied. The probe checks the actual child environment through `/proc` (including Node's two IPC variables).

Use **Run Alpha while viewing Beta**. This selects Beta, then submits `phases demo` to Alpha through the gateway. The two cards consume separate real SSE streams; they display the actual project conversation index's busy/idle state and event counts. Switch back to Alpha to inspect its real transcript. The faux script performs real scratch-file reads/edits, but its test/commit steps only **echo** test/commit text. Those lines are not verification or commits.

Both frames remain mounted when switching. The framing works because each app uses its own origin, with its own root assets, API, SSE and direct HMR connection. This is **not evidence that prefix-hosting Ultimate works**. Use the prefix-only link: unchanged real HTML loads, but its root-relative scripts request the gateway's `/@vite/client`, `/src/main.tsx` and `/@react-refresh`. Those are deliberately not routed, return 404, and leave the page empty. No HTML, JavaScript, CSS, redirects or response text is rewritten.

## Routing and trust boundary

The gateway binds **127.0.0.1 only**. Child origins come only from launcher-created runtimes, never from a request. The complete route set is:

| Route                                                             | Method | Purpose                                                      |
| ----------------------------------------------------------------- | ------ | ------------------------------------------------------------ |
| `/`, `/transport-shell.js`, `/transport-boundary.js`, `/projects` | GET    | Local shell, shared JSON decoder and fixed runtime manifest  |
| `/p/{alpha,beta}/`                                                | GET    | Unchanged HTML; intentional failed prefix experiment         |
| `/p/{alpha,beta}/api/events?conversation=N`                       | GET    | Real project-scoped SSE, streamed without response buffering |
| `/p/{alpha,beta}/api/conversations/N/submit`                      | POST   | Real input API; 16 KiB gateway input limit                   |

Other routes, query keys and upstream endpoints are not proxied. Host must exactly match the gateway's loopback authority. Foreign or null Origin, duplicate Host/Origin, cross-site fetch metadata, `Forwarded`, `X-Forwarded-*` and `X-Real-IP` are rejected. Mutations require the gateway Origin. Requests use fresh upstream headers: no caller cookies, Host, Origin or forwarding metadata. Streams close when their clients leave. Non-SSE upstream requests have a 30-second timeout.

This is browser request protection, **not authentication or a sandbox**. A local process can make same-origin requests. Direct child ports remain usable, with Ultimate's existing admission checks. The experiment does not create a credential boundary between mutually untrusted projects, prevent arbitrary filesystem access by tools, or provide safe remote access. Do not bind it externally, put a tunnel in front of it or run non-faux work in it.

## Repeatable evidence

```sh
# Project-wide format/lint/type gate (normal tsconfig excludes the prototype).
mise exec node@26.11.1 -- npm exec --yes --package=pnpm@11.8.0 -- pnpm check
# Explicit strict TS coverage includes launcher, gateway, probe, test AND browser JS (checkJs).
mise exec node@26.11.1 -- npm exec --yes --package=pnpm@11.8.0 -- pnpm exec tsc --noEmit -p .ultimate/prototypes/unified-host/transport/tsconfig.json
# Focused gateway admission/routing test; no child model runtimes needed.
mise exec node@26.11.1 -- node --test .ultimate/prototypes/unified-host/transport/transport-gateway.test.ts
# Replace PORT with the launcher's URL. Requires installed /usr/bin/chromium.
mise exec node@26.11.1 -- node .ultimate/prototypes/unified-host/transport/transport-probe.ts http://127.0.0.1:PORT /tmp/transport-evidence
```

The probe checks the two real children, colliding numeric root IDs, distinct project paths/homes, per-project initial SSE payloads, actual HTTP 202 submission from the shell while Beta is visible, Alpha Working → Idle over SSE, completed Alpha transcript on return, Alpha scratch `after` vs Beta scratch `before`, and no Alpha input/result in Beta's snapshot. It captures `background-alpha.png`, `completed-alpha.png`, `prefix-failure.png` and `observations.json`. The prefix evidence asserts real 404s and an empty browser body, not just a matching HTML string. Playwright is an existing repository dependency, not a new install. Each probe leaves only the intended Alpha conversation/scratch effects; use a fresh launch to reset.

### Contract/evidence map

All risks use explicit examples: two projects and a finite admission table are sufficient here, not a generated domain.

| Contract / plausible counterfeit                  | Independent oracle                                                                        | Evidence                                                     |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| Project routes alias the same runtime             | Distinct temp paths, equal numeric IDs; Alpha's request must not appear in Beta           | Real child API/SSE/browser probe                             |
| Navigation stops or retargets Alpha               | API acceptance while Beta visible, Alpha completion + real scratch effect, unchanged Beta | Real child API/SSE/browser probe                             |
| Gateway becomes an arbitrary/foreign-origin proxy | Fixed route/method/authority table; rejected requests never hit upstream                  | Gateway test, 20 negative cases                              |
| Prefix HTML is mistaken for working UI            | Root-relative asset 404s, no rendered body                                                | Real browser probe + failure screenshot                      |
| Demo loads personal config                        | Exact allowlisted process environment, isolated config paths                              | Launcher + `/proc` assertions (not an OS filesystem sandbox) |

Discrimination: temporarily replacing the forwarding-header check with a nonmatching key made the gateway test fail for `Forwarded: host=foreign.invalid` (200 instead of 403); restoring it passed. The real-runtime probe also rejects the all-projects-to-Alpha counterfeit through Beta's initial SSE project path. That second counterfeit was reasoned about, not injected.

## Stop and remove

Ctrl+C in the launcher, or `kill -TERM LAUNCHER_PID`. It closes gateway connections, terminates both children, waits for them (10-second kill deadline), then removes only its own `ultimate-transport-*` temporary directory. Children also close on parent IPC disconnect; a child exit stops the experiment. Evidence written outside that temporary directory remains. There is no service, global config, trust choice or deployment to undo.

## Initial E1.1 validation

- Pinned `pnpm check`: passed, 358 formatted files and 298 lint/type-checked files.
- Explicit prototype `tsc`: passed; effective config confirms `strict: true`, `checkJs: true` and all five TS/JS files included.
- Focused Node gateway test: passed, including 20 rejected cases and an accepted submission with stripped cookies/Origin.
- Pinned `pnpm test`: 67 files / 509 tests passed. Existing lineage tests emitted two MaxListeners warnings; no test failed. The repository-wide e2e and real-model eval suites were not run for this optional prototype; the real child/browser probe above was run instead for its specific boundary.
- Real-runtime/browser probe: passed. Screenshot tools also inspected the working shell; final shell screenshot had no reported console errors. Prefix failure has four expected 404s and an empty page.
- Lifecycle: with real SSE established, SIGTERM ended the connection (curl 18: interrupted chunked stream), both child PIDs disappeared and the owned temporary directory was removed. A fresh preview was then started for inspection.

Offline quality commands, run from the repository root after inspecting configuration (no scanner config/plugins present), using aislop 0.16.0 and slop-scan 0.3.0:

```sh
mise exec -- env AISLOP_NO_TELEMETRY=1 AISLOP_NO_HISTORY=1 aislop doctor
unshare -Urn mise exec -- env AISLOP_NO_TELEMETRY=1 AISLOP_NO_HISTORY=1 aislop scan --changes --base b4199ebfa410bebb80cc8ca3dd1185db9c49bd52 --json
# Explicit include supplements the change scanner's whole-repo coverage summary.
unshare -Urn mise exec -- env AISLOP_NO_TELEMETRY=1 AISLOP_NO_HISTORY=1 aislop scan --include '.ultimate/prototypes/unified-host/transport/**' --json
# BASE_TREE is a clean detached temporary worktree of the fixed commit above.
unshare -Urn mise exec -- slop-scan delta --base "$BASE_TREE" --head "$PWD" --fail-on added,worsened --json
```

Aislop reported no errors, but retained one heuristic warning: the gateway function is 133 lines versus its suggested 80. This is a maintainability tradeoff in the small, single-purpose experimental gateway, not a demonstrated behavior defect; no rule was suppressed. The explicit include scan confirmed all five TS/JS files covered. **Dependency audit did not complete:** `pnpm audit` timed out after 25 seconds with networking disabled. Thus no dependency-security pass is claimed (dependencies and lockfile are unchanged). Architecture is opt-in and unconfigured. Slop-scan compared 293 base files with 298 candidate files, identical config hashes/no plugins: zero added or worsened findings. Scanner exit zero alone was not used as proof of complete engine coverage.

## E1.5 boundary/error/test repair

`types.ts` owns the readiness, project and preview contracts. The shared browser-safe `transport-boundary.js` decodes HTTP project lists, child readiness files and launcher test receipts from JSON text into those named contracts before any PID/path use. It rejects malformed primitive fields, nonpositive/noninteger IDs, non-loopback origins, relative/NUL paths, missing projects and duplicate project identities. It is not an authentication mechanism. The shell and Node probe use the same decoder; no schema dependency was added.

**Narrow TS-48 exception:** Runtime `typeof` is permitted only inside the JSON type guards `isTransportReady`, `isTransportProject` and `isTransportPreview` in `transport-boundary.js`. The concrete requirement is to reject untrusted primitive JSON fields before conversation IDs, process IDs, URLs or filesystem paths are used; these inputs have no existing runtime schema. Guard parameters hold `unknown` only at this I/O boundary. No application or Node-platform union checks use runtime `typeof`, and no production lint configuration is changed. The TCP address assertions instead carry `SAFETY:` comments grounded in the completed `listen(port, host)` calls.

The matching integration entrypoints are explicit and remain outside the production fast collection (`test/**/*.test.ts`):

```sh
mise exec node@26.11.1 -- node --test --test-concurrency=1 .ultimate/prototypes/unified-host/transport/*.test.ts .ultimate/prototypes/unified-host/recovery/*.test.ts
```

- `transport-launch.test.ts` invokes the actual launcher, checks real child HTTP/process/project identities, sends SIGTERM, then asserts gateway/child ports, PIDs and the owned directory are gone.
- `transport-probe.test.ts` invokes the actual browser-probe command against its own real launcher fixture, checks output, real Alpha/Beta scratch effects and PNG artifacts. It preserves screenshots under the diagnostic's `/tmp/ultimate-transport-browser-evidence-*` directory; its fixture stops only its own runtimes. Parent-owned previews are never used or stopped.
- `transport-boundary.test.ts` checks valid receipts and malformed JSON/IDs/PIDs/paths/origins. Temporarily removing PID checks made the malformed-project assertion fail; the check was restored.
- Recovery's non-Error regression was red before repair (`faulted` instead of `failed`). It now records a meaningful failed result. The deliberate non-Error throw in that fixture has a single-line `only-throw-error` test exception; production catches preserve existing Error values or enrich non-Errors with their original value as `cause` before recording a message.

Both local strict configurations cover the repair, including shared JS via `checkJs`. Final E1.5 validation: pinned `pnpm check` passed (369 formatted files / 307 lint/type-checked files); both local strict checks passed; the focused command above passed all 9 tests, including the two new real integration entrypoints. Captures disable CSS animations and assert that the final Alpha text remains visible after capture, rather than accepting an intermediate frame. No full production suites were run for this bounded optional-prototype repair.

Repair-range quality commands (same offline network namespace and telemetry settings as above):

```sh
unshare -Urn mise exec -- env AISLOP_NO_TELEMETRY=1 AISLOP_NO_HISTORY=1 aislop scan --changes --base 4c24d9d569670b6d19e208af840bd05635160943 --json
unshare -Urn mise exec -- env AISLOP_NO_TELEMETRY=1 AISLOP_NO_HISTORY=1 aislop scan --include '.ultimate/prototypes/unified-host/**' --json
unshare -Urn mise exec -- slop-scan delta --base /tmp/7961-E15-quality-base --head "$PWD" --fail-on added,worsened --json
```

The clean detached base worktree was exactly `4c24d9d569670b6d19e208af840bd05635160943`; no scanner configuration/plugins were present in either tree. Slop-scan 0.3.0 covered 301 → 307 files and reported zero added/worsened findings. Aislop 0.16.0's include scan covered all 14 prototype TS/JS files, with no errors and the existing gateway-length heuristic (now 132 lines). The offline dependency audit again timed out after 25 seconds: this is a concrete security-coverage gap, not a security pass. No dependency, lockfile or production configuration changed.

## Remaining shortcomings

- Separate-origin frames are a navigation sketch, not shared routing, authentication, keyboard focus, browser history, notifications or workspace state. Reload resets selection. Hidden apps still use resources; no suspension/resource policy is explored.
- No gateway WebSocket/HMR proxy, API discovery, full endpoint coverage, SSE replay protocol, reconnect deduplication, multi-machine access, TLS or real inference is tested. Real browser EventSource reconnects using Ultimate's current snapshot behavior; no new resume protocol is claimed.
- `N` is a conversation ID **inside a project**, never globally unique. The shell only submits to each child's initial root. There is no registry migration, lifecycle recovery or persisted gateway identity.
- Default faux apps can show missing optional-secret notices. No secrets are supplied to silence them. No actual project-extension startup or user configuration is changed.
- The strict prototype configuration inherits the repository's `strict: true`; it adds `checkJs`, isolated modules and override checks. A trial with `noUncheckedIndexedAccess` also exposed existing out-of-scope core errors in `server/api.ts`, `server/extensions.ts` and `server/project-setup.ts`; it is not enabled in the repository or this experiment. No core fixes or suppressions are included.
