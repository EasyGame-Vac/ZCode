# Duet self-iteration prototype

## Terminology

| Term                            | Implementation                 | Responsibility                                                                                |
| ------------------------------- | ------------------------------ | --------------------------------------------------------------------------------------------- |
| 中枢 (Supervisor)               | `scripts/duet/supervisor.mjs`  | stable control plane: lifecycle, admission, verification, activation, rollback, leases, audit |
| 窗口 (Window / Desktop Runtime) | target `w`; `packages/desktop` | full ZCode desktop app; gated activation                                                      |
| 精灵 (Companion Runtime)        | target `k`; `scripts/duet/pet` | desktop companion + headless agent; direct restart                                            |
| 目标 (Target)                   | `w` / `k`                      | a supervised, replaceable runtime instance                                                    |
| 租约 (Lease)                    | `/lease`, `/release`           | task-scoped exclusivity; target busy state                                                    |
| 门禁 (Gate)                     | `scripts/duet/verify.mjs`      | fixed verification pipeline before activation                                                 |

Implementation identifiers are unchanged: target keys `w` and `k`, packages `desktop` and `pet`. UI copy that still uses the older labels is migrated on the next stack restart so the running gate hash stays valid.

## Product rules

- The duet has three processes: the supervisor (中枢; `S` below), the desktop window (窗口; `W` below), and the companion pet (精灵; `K` below).
- `S` is the single launch entry. Starting `S` auto-starts every target with `autoStart` enabled; by default that is `W` and `K`. One command produces all three processes.
- `S` owns process lifecycle and activation. `W` activations are gated; `K` can be restarted directly for development.
- `W` is the existing desktop development app started from the repository. `K` is an independent Electron pet window with a headless CLI brain.
- `K` is deliberately not a child of `W`: restarting or breaking `W` must not take the pet down. `K` is a child of `S`.
- The first version is development-only. It edits the same repository, uses the normal user data directory, and never auto-activates a change.
- A successful `W` activation requires: a clean worktree, `HEAD` equal to the requested commit, a passing independent verification gate, and a healthy restarted `W`.
- A failed `W` restart rolls back to the last good commit and restarts `W`. The rollback target is the commit that was running before the failed activation.
- A target may only be updated when it is not executing a task. `W` and `K` hold target-scoped leases while a turn or brain task runs; `S` rejects activation, restart, stop, or rollback for a busy target. `W` is stopped before the verification steps run, so the window is closed during the swap.
- `W` may modify `K`'s extensions (`.agents/skills/duet-*`) and, in development, `K`'s pet sources. `S` restarts `K` on request; those restarts are not gated in v1 but are rejected while `K` is busy.
- The pet's brain is a headless CLI invocation per message (`-p`), resumed by session id. The pet owns the child process and persists the session id.
- The pet UI only loads local assets. The supervisor token never reaches the renderer; all HTTP calls happen in the Electron main process.

## Ownership and boundaries

- `scripts/duet/**` is tooling, not product runtime. It is outside the managed module roots in `architecture-policy.yaml` and introduces no runtime service dependency.
- `S` owns the HTTP control plane, the activation lock, both target lifecycles (`W` and `K`), the target lease store, the ledger, the gate integrity check, and the rollback decision.
- `K` owns its Electron window, the CLI brain child process, the conversation session id, and the presentation state. It does not own `W` or the gate. It reports a lease around each brain task.
- `W` owns its normal desktop runtime and session state. It is stopped and started only by `S`. A dev-only, env-gated bridge in the desktop main reports a lease while the desktop host has running agent tasks.
- The verification gate is fixed code loaded by `S` at startup. Requests cannot supply commands or paths. The lease endpoints only accept target names and lease metadata.
- Reverse iteration: `W` may modify `.agents/skills/duet-*/**` and `scripts/duet/pet/**`. Extension commits are recorded with `POST /record`; `K` core changes are applied with `POST /restart {target:"k"}`. `W`'s own changes still require `POST /activate` and the user's click.
- The `K` core restart is an intentional development escape hatch. It is not gated, but it is rejected while `K` holds a task lease; `W` remains gated and busy-checked.

## Activation state machine

The following machine applies to gated `W` activations. `K` restarts use a simpler stop → start → wait for `[duet-pet] READY` path and do not run the gate; both paths reject a target with an active lease.

```text
idle
  -> queued
  -> verifying (worktree, commit, gate, protected paths)
  -> stopping (close W)
  -> verifying (configured command steps)
  -> restarting (start W, wait for ready)
  -> succeeded
  -> restoring (start W at HEAD after a failed step, or rollback)
  -> failed
```

- `queued`, `verifying`, `stopping`, `restarting`, `rolling-back`, and `restoring` are non-terminal and exclude a second activation.
- `succeeded`, `failed`, `rolling-back`, and `restoring` outcomes are recorded in the ledger.
- Worktree, commit, protected-path, and config failures happen before `W` is stopped.
- A command-step failure restores `W` at `HEAD` (`restoring`); if that restart fails, `S` rolls back to the last good commit.
- A restart failure after a passing verification rolls back to the last good commit.
- A `K` restart failure marks the `k` target failed; it does not stop `W`. `W` can fix `K` and restart it again.

## HTTP control plane

Local only, default `127.0.0.1:47821`, bearer token from `.duet/token`.

| Method | Path        | Body                                              | Result                                                  |
| ------ | ----------- | ------------------------------------------------- | ------------------------------------------------------- |
| GET    | `/status`   | -                                                 | W/K state, `HEAD`, `lastGoodCommit`, activation, leases |
| POST   | `/start`    | `{target:"w"\|"k"}`                               | start and wait for ready                                |
| POST   | `/stop`     | `{target:"w"\|"k", force?}`                       | stop the target; rejected while busy                    |
| POST   | `/restart`  | `{target:"w"\|"k", force?}`                       | restart without verification; rejected while busy       |
| POST   | `/preview`  | `{target, commit?, base?}`                        | changed files, diff stat, protected check               |
| POST   | `/activate` | `{target:"w", commit?, profile?, actor?, tests?}` | `202` plus `activationId`; rejected while busy          |
| POST   | `/rollback` | `{target:"w", reason?, force?}`                   | checkout `lastGoodCommit`, restart; rejected while busy |
| POST   | `/record`   | `{target:"k-extensions", commit, base?, actor?}`  | record a skill/prompt commit                            |
| POST   | `/lease`    | `{target, leaseId, holder, reason?, ttlMs?}`      | acquire or heartbeat a task lease                       |
| POST   | `/release`  | `{target, leaseId?, holder?}`                     | release one lease, or all leases for a holder           |
| GET    | `/ledger`   | `?limit=<n>`                                      | recent ledger entries                                   |
| GET    | `/health`   | -                                                 | supervisor liveness                                     |

A target is busy while it has any non-expired lease. `/activate`, `/restart`, `/stop`, and `/rollback` return `409 target-busy` unless `force:true`; `/activate` never accepts `force`. Leases use a 5s–10min TTL, are heartbeated by the executor, and are cleared when `S` stops the target.

Starting `S` auto-starts every target whose `autoStart` is not false. Requests can restart `K`; `W` changes use `/activate` so the gate runs.

## Verification gate

- Fixed phases: clean worktree, `HEAD` check, protected-path diff check, configured command steps.
- `fast` profile runs `pnpm typecheck`. `full` adds `pnpm lint` and `pnpm architecture:check --changed`.
- Protected files block any change; existing test files block modification and deletion but allow additions.
- `S` stores SHA-256 hashes of `scripts/duet` gate files in `.duet/gate-hashes.json`. A changed gate file refuses activation. A changed gate on supervisor restart requires `--accept-gate-change`.
- The gate commands come from `scripts/duet/config.json`, which is itself hashed. Requests cannot choose commands.
- `S` stops `W` after the worktree, commit, gate, protected-path, and config checks pass, then runs the command steps. The window is closed while typecheck/lint runs.
- A command-step failure restarts `W` at `HEAD`; if that restart fails, `S` rolls back to the last good commit.

## Desktop pet

- `K` is a supervisor target. `S` starts it with `scripts/duet/pet/start.mjs` and considers it ready after the renderer prints `[duet-pet] READY`.
- Separate Electron process, frameless, transparent, always-on-top, draggable, with a tray entry and a global shortcut.
- States: `offline`, `idle`, `listening`, `thinking`, `working`, `verifying`, `waiting`, `error`.
- The pet shows the last task's changed files before activation and never activates on its own.
- Brain command: the repository `tsx` CLI or a built `zcode.cjs`, invoked with `-p`, `--cwd`, `--output-format stream-json`, `--mode yolo`, and `--resume <sessionId>` after the first message.
- The pet parses NDJSON line by line, ignores unknown event types, streams `part.delta` text when available, and always uses the final `result` line as the answer.
- `K` acquires a lease before spawning the brain and releases it on close/cancel; it heartbeats every 20s. A crash leaves a lease that expires by TTL.
- The desktop main reports a `W` lease while the host running-task count is greater than zero, with the same heartbeat/TTL. The bridge is enabled only when `ZCODE_DUET_TARGET=w` and the supervisor URL/token env are present; production launches never set them.
- The pet treats an active `W` lease as "窗口版正在执行任务" and disables activation/rollback until the lease clears.
- `W` can restart `K` with `POST /restart {target:"k"}` after changing a skill or `scripts/duet/pet/**`. This restart is not gated in v1 but is rejected while `K` is busy.

## Acceptance

1. `node --test scripts/duet/tests/*.test.mjs` passes, including fake-target activation/rollback and lease tests.
2. Starting the supervisor auto-starts both `W` and `K` when their `autoStart` is enabled.
3. A leased target rejects `/activate`, `/restart`, and `/stop` with `409`; releasing the lease allows the operation.
4. A protected-path modification is rejected before `W` is stopped.
5. `W` is stopped before command steps run; a step failure restores it at `HEAD`, or rolls back to the last good commit.
6. A target that fails to become ready after activation triggers rollback to the last good commit.
7. `W` can change a `K` skill or a pet source and restart `K` through `POST /restart {target:"k"}` when `K` is idle.
8. `node scripts/duet/pet/start.mjs --smoke` creates the pet window and exits successfully when a GUI is available. When it is not, the limitation is reported.
9. Root `pnpm lint`, `pnpm typecheck`, and `pnpm architecture:check --changed` pass, or pre-existing failures are reported unchanged.
10. Product runtime changes are limited to the dev-only, env-gated duet lease bridge in `packages/desktop/src/main/index.ts` and `packages/desktop/src/main/desktopHostProcess.ts`; no other product runtime source is modified.

## Recorded validation (2026-10-27)

- `pnpm test:duet`: 22 tests passed. Covers protected paths, lease TTL/release/clear, verifier pass/stop-failure/protected/dirty/commit mismatch, supervisor start/activate/busy rejection/protected rejection/gate tamper/auto-rollback/manual rollback, `k-extensions` record acceptance and rejection, and pet parser/state-machine/client behavior.
- `pnpm lint`: 0 errors; 96 pre-existing warnings outside the duet files. No `scripts/duet` findings.
- `pnpm typecheck`: passed, including the desktop lease bridge.
- `pnpm architecture:check --changed`: 0 violations.
- `oxfmt --check scripts/duet specs/duet-self-iteration.md`: passed.
- `node scripts/duet/pet/start.mjs --smoke`: `PET_SMOKE_OK`; `ready`, `mascot`, `messages`, and `api` were true, the window was 360×520 and always-on-top, and the screenshot was written to `.duet/pet-smoke.png`.
- Auto-start + lease integration: a temporary supervisor config used a fake W and the real pet. Both targets reached running, `[duet-pet] READY` was logged, `/activate` while W held a lease returned `409`, `/restart {target:"k"}` while K held a lease returned `409`, releasing the lease restarted K with a new PID, and stopping K/W/S succeeded.
- Not executed: real desktop `dev:runtime` restart, a real desktop turn lease under a model-driven task, packaged-app duet bootstrap, a real model conversation, tray/global-shortcut interaction, and macOS/Linux GUI behavior.

## Non-goals

- Packaging, signing, release channels, versioned runtime directories, and canary rollout.
- Interactive permission approval in the headless brain.
- Automatic activation, unattended loops, or auto-merge.
- Voice, TTS, 3D/Live2D, OS login auto-start.
- Gated activation and rollback for `K` core changes; `K` restarts are development-only and ungated.
- Packaged-app duet bootstrap; the dev launcher is the only entry.
- Per-subagent lease granularity; the `W` lease is target-level based on the host running-task count.
