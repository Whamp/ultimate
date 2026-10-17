# E1.2 — Pi Durable registration and crash recovery probe

Optional engineering experiment, **not a production project manager**. Nothing here is
loaded by Ultimate. No core, host, deployment, settings, or dependency changes.

## Run

From the repository root with its pinned dependencies installed:

```sh
mise exec node@26.11.1 -- npm exec --yes --package=pnpm@11.8.0 -- pnpm exec node --test --test-timeout=30000 .ultimate/prototypes/unified-host/recovery/recovery-catalogue.test.ts
mise exec node@26.11.1 -- npm exec --yes --package=pnpm@11.8.0 -- pnpm exec tsc -p .ultimate/prototypes/unified-host/recovery/tsconfig.json
mise exec node@26.11.1 -- npm exec --yes --package=pnpm@11.8.0 -- pnpm exec vp lint .ultimate/prototypes/unified-host/recovery
mise exec node@26.11.1 -- npm exec --yes --package=pnpm@11.8.0 -- pnpm check
```

The standalone Node integration probe is deliberately outside `test/` and the fast
`pnpm test` collection: it forks two real children and kills them with SIGKILL.
All database files, project fixtures, symlinks, and filesystem effects are created
under fresh `mkdtemp()` directories and removed after the probe. The worker receives
only its temporary paths and mode, has a temporary cwd/HOME/TMPDIR, and does not
inherit the user's environment. It has a 15-second broken-worker guard; the actual
crash is triggered by IPC, not by elapsed time. The Node test deadline is 30 seconds.

`createModels()` has no providers. Its installed implementation defaults to in-memory
credential and model stores. The probe neither submits conversation input nor calls
model, auth, settings, discovery, or configuration APIs. It needs no credentials,
network, existing project homes, or inference. The catalogue opener is a test seam,
not a safe general-purpose API for opening arbitrary user homes.

## Real installed APIs

Uses the installed, pinned `@earendil-works/pi-durable` **1.2.0**, including this
repository's existing patch, and Node's real SQLite backend:

- `Harness.open(openNodeSqliteStorage(file), { models, registry }, context)`
- `defineDoc()` with session scope; `tx.doc()` and `harness.snapshot()`
- `defineTask()`, registered through `defineExtension()` / `createRegistry()`
- `tx.createTask()`, `runtime.commit()`, `harness.getTask()`, `resume()`, `waitForTask()`

The installed README's Storage section and `dist/types.d.ts`,
`dist/harness/types.d.ts`, `dist/storage/sqlite/node.d.ts` are the API references.
There is no replacement journal or simulated recovery engine. Checkpoints,
registration decisions, task IDs, document edits, outcomes, and reopen all use Pi's
actual harness and SQLite. `JsonRepresentation<ProjectRecord>` makes the document
payload structurally JSON-compatible without discarding its branded task ID type.

## Mechanism and evidence

Registration resolves the existing project directory with `realpath()`. One serialized
Pi commit reads the catalogue, returns its existing task ID, or appends one project
record and creates its provisioning task atomically. Canonical paths, not request
IDs or process-local maps, identify projects. This is concurrent calls through **one
storage owner**, not cross-process registration arbitration.

The task's filesystem effect is a directory at a deterministic SHA-256 path under
the temporary home. `mkdir()` plus validation of an existing directory makes this
specific operation idempotent. After the effect returns, a hook sends IPC and blocks
before `runtime.commit()`. The parent waits for that message, issues SIGKILL, and
asserts a signal exit (not a graceful close). Only after the child exits does the
parent open the same database. It observes the saved `provision` checkpoint and a
`provisioning` document, then resumes. One atomic commit changes the record to
`ready` and settles its task. A real file at the expected directory path instead
produces a committed `failed` record and task outcome.

All contract cards use explicit examples at the real SQLite/filesystem/process seam;
there is no adjacent production behavior to preserve:

| Contract / risk                           | Observation and independent oracle                                                                                                                                                                          | Counterfeit rejected                                                        |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Duplicate aliases must converge           | 32 concurrent requests through real and symlink paths; one document record, one task ID, one effect                                                                                                         | Allocating a new record/task for each request                               |
| Crash must resume the unfinished task     | Child's 16 duplicate requests, IPC-before-checkpoint, SIGKILL exit; reopen shows pending `provision` and one provisioning record; 16 more requests return the saved ID; resume invokes the effect hook once | Graceful shutdown, checkpoint-before-kill, or recovery that skips the phase |
| Safe replay must not duplicate the effect | One directory before/after recovery; directory names and inode remain unchanged; one completed receipt and one ready record                                                                                 | Recreating or duplicating the directory                                     |
| Completed retry must be stable            | Same task ID and completed receipt, one ready record and unchanged effects, including a second reopen                                                                                                       | Creating new work after completion                                          |
| Distinct projects must stay distinct      | Second real directory yields another task ID, record and effect                                                                                                                                             | Merging unrelated project paths                                             |
| Failure must be visible, not ready        | Real file/directory collision gives a failed task and nonempty failed document diagnostic; retry keeps its failed task ID                                                                                   | Marking a failed effect ready or hiding its result                          |
| Arbitrary effects are not exactly once    | Separate fresh database, same kill/reopen path, but `mkdtemp()` allocates a unique directory each attempt; **two effects despite one ready record**                                                         | Claiming that Pi's checkpoint alone deduplicates filesystem effects         |

The counterfeit calls the **same one-effect assertion**, which must throw an
`AssertionError` with actual `2` and expected `1`. The probe captures that expected
red result and fails if it disappears. It also requires one effect before the crash,
two after replay, and a completed task, so a worker/setup failure cannot satisfy it.
The deliberately wrong dependency exists only in this isolated negative-control case.
No implementation mutation or expected defect is left enabled for the safe case.

## Verification and coverage

Measured on Node **26.11.1** with pnpm **11.8.0**: three standalone cases pass in
approximately **0.7 seconds**, including both SIGKILL cases. No skipped tests.
The expected-red diagnostic reports two counterfeit effects. Strict local TypeScript,
focused project lint, and the pinned repository `pnpm check` pass.

The repository TypeScript `include` list does not cover prototypes. The local
`tsconfig.json` explicitly includes all three `.ts` files, including the executable
worker and the standalone tests. It enables strict mode, unchecked-index checking,
unused checks, isolated modules, and verbatim module syntax. Explicit `vp lint`
also covers this otherwise excluded prototype.

Quality scans use fixed base `b4199ebfa410bebb80cc8ca3dd1185db9c49bd52`. Both run
inside a Linux user/network namespace (`unshare --user --map-root-user --net`) to
prevent network access, with telemetry disabled. No scan configuration, suppressions,
or global settings are added. For example, after making a temporary detached base
worktree at that commit (replace `$BASE_WORKTREE` below with its absolute path):

```sh
unshare --user --map-root-user --net env AISLOP_NO_TELEMETRY=1 AISLOP_NO_UPDATE_NOTIFIER=1 DO_NOT_TRACK=1 mise exec -- aislop doctor
unshare --user --map-root-user --net env AISLOP_NO_TELEMETRY=1 AISLOP_NO_UPDATE_NOTIFIER=1 DO_NOT_TRACK=1 mise exec -- aislop scan --changes --base b4199ebfa410bebb80cc8ca3dd1185db9c49bd52 --json
unshare --user --map-root-user --net env AISLOP_NO_TELEMETRY=1 AISLOP_NO_UPDATE_NOTIFIER=1 DO_NOT_TRACK=1 mise exec -- aislop scan --changes --base b4199ebfa410bebb80cc8ca3dd1185db9c49bd52 --include '.ultimate/prototypes/unified-host/recovery/**' --json
unshare --user --map-root-user --net env DO_NOT_TRACK=1 mise exec -- slop-scan delta --base "$BASE_WORKTREE" --head "$PWD" --fail-on added,worsened --json
```

Aislop **0.16.0**: focused scan covers all three TypeScript files, no diagnostics.
Slop-scan **0.3.0**: exact base/candidate comparison, zero added/worsened findings;
the candidate contains three more scanned files. The initial function-length warning
was resolved by separating the task definition from catalogue opening.
There are no dependency changes; the offline scans do **not** certify a fresh online
dependency vulnerability audit. Architecture rules are unconfigured in Aislop.
These scanner results supplement, not replace, explicit lint/types and behavior checks.

## What remains unproved

- **Runtime launch ownership and full lifecycle:** no actual Ultimate project runtime,
  listener, supervisor, Vite process, launch lease, fencing, PID recovery, shutdown,
  upgrade, or stale owner resolution is tested. A persisted ready record does not
  prove that any project runtime is alive or uniquely owned.
- **Arbitrary filesystem effects:** Pi's SQLite commit cannot atomically include a
  directory creation, file copy, Git checkout, process launch, or remote API call.
  Recovery reruns unfinished task phases. This probe gets one effect from its narrow
  idempotent operation, **not** from an exactly-once guarantee by Pi. The counterfeit
  demonstrates the failure of that broader claim. External mutation, symlink attacks,
  partial multi-file writes, and conflicting payloads need another design.
- **Multiple storage owners:** Pi's installed README explicitly requires one process
  per storage; it supplies no cross-process locking. This probe waits for SIGKILL
  exit before reopening. It proves no admission lock or distributed uniqueness.
- **Power loss and other crash windows:** SQLite uses WAL with `synchronous=NORMAL`.
  Process-kill recovery is not a host-crash/fsync/power-loss guarantee. This is one
  controlled boundary, not exhaustive crash-window exploration or migration testing.
- **Identity policy:** existing real paths and a symlink alias are covered; nonexistent
  projects, rename/move policy, hard links, case-insensitive paths and production
  project-identity rules are not.
- **Failure policy:** the probe records a filesystem failure and returns the same
  failed task on retry; it does not implement remediation, automatic retries, or
  production reconciliation. Assertion/hook/programming failures can fault a task
  without changing its catalogue record; task inspection is then required.

No browser/UI verification, fast production suite, supervisor E2E suite, or real-model
eval is claimed. This standalone experiment does not change those surfaces.
