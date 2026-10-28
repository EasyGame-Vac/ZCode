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
- Separate Electron process, frameless, transparent, always-on-top, with a tray entry and a global shortcut.
- Expanded and collapsed are two content states, not two copies of the same UI. Expanded shows the chat panel only; collapsed shows the mascot plus a one-line status in a window sized around them. The mascot remains clickable (expand) and draggable (move).
- The expanded panel fills the window edge-to-edge. Transparent padding around the panel is only allowed in the collapsed mascot state; in expanded, it would read as a dark frame when the pet sits over a dark window.
- On Windows, the expanded window itself is clipped to a 20px rounded rectangle with `win.setShape`; CSS `border-radius` alone only clips the page background, leaving the native window rectangular. The shape generator must inset both the top and bottom rows, and the shape is reset to a full rectangle while collapsed.
- The panel body is a native drag region; interactive regions (messages, activity, preview, actions, composer) opt out with `no-drag`. The collapsed mascot uses a pointer-driven drag because a native drag region would swallow the click.
- States: `offline`, `idle`, `listening`, `thinking`, `working`, `verifying`, `waiting`, `error`.
- The pet shows the last task's changed files before activation and never activates on its own.
- The task preview diffs only from the `HEAD` captured when the task starts. A task that creates no new commit shows no preview, so earlier unactivated commits and the user's pre-existing dirty worktree are not attributed to that turn.
- Visible user/assistant messages are persisted in `.duet/pet-messages.json` and restored on `pet:init`; the CLI brain session remains the context source. `新会话` clears both the session id and the visible transcript.
- K conversations are unbounded. The CLI auto-compacts near the model context window; in addition, K rotates to a fresh CLI session when the last reported context usage reaches 75% of the model window. The new session's first prompt carries the last 20 visible messages (capped at 16k chars) and states that older context was dropped. Recent messages stay verbatim; only distant context is lost.
- Tool activity and system messages do not enter the chat panel. A separate console window (opened from the tray as `打开控制台`) shows them live and persists them to `.duet/logs/k-activity.log`; the console's `打开原始日志` button opens `k.log`. The chat panel only carries user/assistant messages.
- The changed-file preview is a collapsed one-line summary by default; the user expands it on demand. Long protected-path warnings scroll inside a capped warning area.
- The composer auto-grows from one row up to the configured max height; the action row wraps into a single line because buttons never shrink and the model selector absorbs the shrink.
- The pet exposes a model selector backed by the CLI provider registry (`zcode models --json`). The selection is persisted in `.duet/pet-state.json` and passed to the brain as `--model <provider/model>`; the "default" choice leaves the flag off.
- The pet header has a reader button. It opens a separate, resizable, read-only conversation window fed by the main-process conversation hub; `回到精灵` focuses the pet. Input stays in the pet main window so there is only one writer.
- Code is split by window/domain: brain turns live in `core/brain-runner.mjs`, conversation snapshots in `core/conversation-hub.mjs`, the console in `windows/console`, the reader in `windows/reader`, and shared message/scroll rendering in `shared/renderer`. `main.mjs` is the composition root and still owns the pet window/tray in this pass.
- The pet tray uses the mascot icon (`assets/mascot-tray.png`) and explicitly exposes `显示精灵（<shortcut>）`, `隐藏精灵`, `新会话`, `打开控制台`, and `退出精灵`; the tooltip includes the shortcut. The window has no log button; tool activity and the raw-log entry live in the separate console because they are not used often. The desktop app does not own a separate companion entry in v1.
- Brain command: the repository `tsx` CLI or a built `zcode.cjs`, invoked with `-p`, `--cwd`, `--output-format stream-json`, `--mode yolo`, optionally `--model`, and `--resume <sessionId>` after the first message.
- The pet parses NDJSON line by line, ignores unknown event types, streams `part.delta` text when available, and always uses the final `result` line as the answer.
- `K` acquires a lease before spawning the brain and releases it on close/cancel; it heartbeats every 20s. A crash leaves a lease that expires by TTL.
- The desktop main reports a `W` lease while the host running-task count is greater than zero, with the same heartbeat/TTL. The bridge is enabled only when `ZCODE_DUET_TARGET=w` and the supervisor URL/token env are present; production launches never set them.
- The pet treats an active `W` lease as "窗口版正在执行任务" and disables activation until the lease clears.
- The pet does not expose a manual rollback control. `S` still rolls back automatically when a restarted `W` cannot become ready; the `/rollback` API remains available for an explicit operator request.
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
9. The pet model selector lists the CLI provider registry models, persists a choice across restarts, and passes it as `--model`; choosing "default" omits the flag.
10. Expanded and collapsed windows fit their content. The collapsed mascot can be dragged without losing click-to-expand, and the expanded panel can be dragged from its background.
11. The pet UI has no manual rollback button; automatic rollback after a failed `W` restart remains unchanged.
12. Root `pnpm lint`, `pnpm typecheck`, and `pnpm architecture:check --changed` pass, or pre-existing failures are reported unchanged.
13. Product runtime changes are limited to the dev-only, env-gated duet lease bridge in `packages/desktop/src/main/index.ts` and `packages/desktop/src/main/desktopHostProcess.ts`, plus the CLI `--model` / `models` surface the pet needs; no other product runtime source is modified.

## Recorded validation (2026-10-27)

- `pnpm test:duet`: 34 tests passed. Covers protected paths, lease TTL/release/clear, verifier pass/stop-failure/protected/dirty/commit mismatch, supervisor start/activate/busy rejection/protected rejection/gate tamper/auto-rollback/manual rollback, `k-extensions` record acceptance and rejection, pet parser/state-machine/client behavior, model-catalog JSON/cache behavior, window-drag cursor math, rounded-window shape insets, visible-message persistence, context-handoff trimming, session-store context usage, conversation-hub snapshots, a fake-CLI brain-runner turn, per-task preview gating, and supervisor renderer payload sanitization.
- `pnpm lint`: 0 errors; 96 pre-existing warnings outside the duet files. No `scripts/duet` findings.
- `pnpm typecheck`: passed, including the desktop lease bridge.
- `turbo run typecheck --filter @zcode/cli`: 11 tasks passed, including the new `--model` / `models` surface.
- `pnpm architecture:check --changed`: 0 violations.
- `oxfmt --check scripts/duet specs/duet-self-iteration.md`: passed.
- `node scripts/duet/pet/start.mjs --smoke`: `PET_SMOKE_OK` in both expanded (360×520) and collapsed (180×220) states. The renderer reported 5 model-selector options (`zcode models --json` returned 4 selectable models), `rollback:false`, and the screenshots were written to `.duet/pet-smoke.png`. After adding `transparent: true`, the collapsed screenshot no longer shows the opaque window rectangle; only the mascot and status pill are visible.
- History/persistence smoke: seeded six visible user/assistant messages from the current CLI session into `.duet/pet-messages.json`; the next smoke reported `messageCount:6` after `pet:init`, and the live pet restored the same transcript. The task preview now requires `HEAD` to change during the turn, so a no-op question does not render the earlier 79-file diff or the user's pre-existing dirty worktree.
- Rolling-context unit coverage: the handoff keeps the most recent messages, drops the current task duplicate, respects the character cap, and the session store persists/clears the session id plus context usage. A real 75% rotation was not executed because the selected model reports a 1M context window and reaching the threshold would require an expensive long session; the CLI auto-compact path was also not exercised end-to-end.
- Console-window render check: `createActivityConsole` opened the separate window, rendered the header, `打开原始日志`/`清空` buttons, and two activity lines in a 544×321 capture. The pet smoke still reported `messageCount:8`; tool activity is no longer part of the chat DOM. The tray click that opens the console was not automated; the controller's `open()` path was exercised directly.
- Reader integration: the live pet was driven over CDP, `window.duetPet.openChat()` opened `windows/reader/renderer/reader.html`; the reader reported 8 messages, the current status (`窗口版运行中`), a 744×721 viewport, and the same last message as the pet. The controller buffers hub events until `did-finish-load`, then sends the snapshot and replays them; closing the reader leaves the pet running.
- P0 scroll behavior now lives in `shared/renderer/sticky-scroll.mjs` and message rendering in `shared/renderer/conversation-view.mjs`; both the pet and reader use them. Automated DOM scrolling is not covered; the behavior was verified in the live windows.
- `zcode models --json`: returned `new-provider-2/deepseek-v4.1-flash`, `new-provider-2/gpt-5.6-terra`, `new-provider-2/gpt-5.6-sol`, and `new-provider/deepseek-v4.1-flash`; `current` was `null` (default follows the CLI registry fallback).
- CDP interaction test (manual pet with `--remote-debugging-port=9222`): the collapsed window showed 5 model options and no rollback button; a no-movement click expanded the panel; a pointer drag entered the `dragging` state and did not expand on release; `setModel(provider/model)` persisted to `.duet/pet-state.json` and reset back to `null`. CDP cannot move the real OS cursor, so the final window translation was covered by the `window-drag` unit test rather than this run.
- CDP layout test (360×520, five transcript messages): transcript height was 370 with no auxiliary blocks, 342 with the activity summary collapsed, 301 with activity and preview summaries collapsed, and 161 only when the user expanded both. The composer was 88px with a 34px one-row input and grew to 146px/92px for six lines. The composer action row measured `scrollWidth = clientWidth = 314`, all four buttons were 27px high, and the send button was 43px wide rather than collapsing into a circle.
- OS-level capture (PowerShell screen grab around the live window): the reported “black border” was the 10px transparent `#app` padding showing a dark window behind the panel, not the CSS border. Expanded padding is now 0 and the panel background is opaque; sampled pixels on the panel edge are `231,231,232` over a white panel, with no dark band.
- Window-shape test: `roundedWindowShape(360, 520, 20)` returns 41 rectangles, a full-width middle band, and inset rows at both the top and bottom. The first implementation only inset the top rows, leaving the bottom corners rectangular; the OS-level corner zooms now show a rounded bottom-left and bottom-right arc matching the two top corners.
- Auto-start + lease integration: a temporary supervisor config used a fake W and the real pet. Both targets reached running, `[duet-pet] READY` was logged, `/activate` while W held a lease returned `409`, `/restart {target:"k"}` while K held a lease returned `409`, releasing the lease restarted K with a new PID, and stopping K/W/S succeeded.
- Not executed: real desktop `dev:runtime` restart, a real desktop turn lease under a model-driven task, packaged-app duet bootstrap, a real model conversation with `--model`, manual drag/click interaction, tray/global-shortcut interaction, and macOS/Linux GUI behavior.
- Known operational consequence: `scripts/duet/pet/**` is still part of the supervisor's gate hash, so the pet changes above make the running supervisor reject the next `W` activation until the supervisor is restarted with `--accept-gate-change`.

## Non-goals

- Packaging, signing, release channels, versioned runtime directories, and canary rollout.
- Interactive permission approval in the headless brain.
- Automatic activation, unattended loops, or auto-merge.
- Voice, TTS, 3D/Live2D, OS login auto-start.
- Gated activation and rollback for `K` core changes; `K` restarts are development-only and ungated.
- Packaged-app duet bootstrap; the dev launcher is the only entry.
- Per-subagent lease granularity; the `W` lease is target-level based on the host running-task count.
