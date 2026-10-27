import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { relative } from "node:path";
import { stopProcessTree, spawnCommand } from "./process.mjs";
import { HttpError, now } from "./supervisor-support.mjs";

/**
 * Owns the lifecycle of configured targets. The supervisor core owns
 * activation and verification; this module only starts, stops and reports
 * processes.
 */
export function createTargetManager({
  repoRoot,
  state,
  getConfig,
  getLedger,
  log,
  logDir,
  onTargetStopped,
}) {
  const runtimes = new Map();
  const locks = new Map();

  function appendLedger(event) {
    const ledger = getLedger();
    if (ledger) void ledger.append(event);
  }

  function serialize(key, task) {
    const previous = locks.get(key) ?? Promise.resolve();
    const run = previous.then(task, task);
    locks.set(
      key,
      run.catch(() => {}),
    );
    return run;
  }

  function getTargetConfig(name) {
    const target = getConfig()?.targets?.[name];
    if (!target) throw new HttpError(400, `unknown target: ${name || "<empty>"}`);
    return target;
  }

  function status(name) {
    const target = state.targets[name];
    if (!target) return null;
    const runtime = runtimes.get(name);
    return {
      status: target.status,
      pid: target.pid,
      startedAt: target.startedAt,
      readyAt: target.readyAt,
      exitCode: target.exitCode,
      logPath: relative(repoRoot, target.logPath).replaceAll("\\", "/"),
      logTail: runtime?.lines.slice(-20) ?? [],
    };
  }

  function markReady(name, runtime, reason) {
    if (runtime.readySettled) return;
    runtime.readySettled = true;
    clearTimeout(runtime.readyTimer);
    state.targets[name].status = "running";
    state.targets[name].readyAt = now();
    log("info", `target ${name} ready (${reason})`);
    runtime.readyResolve({ ok: true, reason });
    appendLedger({ event: "target-ready", target: name, reason });
  }

  function failReady(name, runtime, message) {
    if (runtime.readySettled) return;
    runtime.readySettled = true;
    runtime.failure = message;
    clearTimeout(runtime.readyTimer);
    state.targets[name].status = "failed";
    const detail = `${message}\n${runtime.lines.slice(-20).join("\n")}`.trim();
    log("error", `target ${name} failed to become ready: ${message}`);
    runtime.readyReject(new Error(detail));
    void stopProcessTree(runtime.child, { timeoutMs: 3000 });
    appendLedger({ event: "target-ready-failed", target: name, message });
  }

  async function startUnlocked(name, reason) {
    const target = getTargetConfig(name);
    const existing = runtimes.get(name);

    if (existing?.child && existing.child.exitCode === null) {
      if (state.targets[name].status === "starting" && existing.readyPromise) {
        await existing.readyPromise;
        return status(name);
      }
      return status(name);
    }

    if (existing) runtimes.delete(name);

    await mkdir(logDir(), { recursive: true });
    const logPath = state.targets[name].logPath;
    const logStream = createWriteStream(logPath, { flags: "a" });
    logStream.on("error", (error) => log("warn", `log stream ${name} failed:`, error));
    logStream.write(`\n--- ${name} start ${now()} reason=${reason} ---\n`);

    const child = spawnCommand(target.command, target.args, {
      cwd: target.cwd,
      detached: process.platform !== "win32",
      env: { ...process.env, ...target.env },
      stdio: ["ignore", "pipe", "pipe"],
    });

    const runtime = {
      child,
      logStream,
      lines: [],
      readySettled: false,
      readyResolve: null,
      readyReject: null,
      readyPromise: null,
      readyTimer: null,
      readyCandidate: false,
      failure: null,
    };
    runtimes.set(name, runtime);

    state.targets[name] = {
      ...state.targets[name],
      status: "starting",
      pid: child.pid ?? null,
      startedAt: now(),
      readyAt: null,
      exitCode: null,
    };

    runtime.readyPromise = new Promise((resolveReady, rejectReady) => {
      runtime.readyResolve = resolveReady;
      runtime.readyReject = rejectReady;
    });
    runtime.readyPromise.catch(() => {});

    const ready = target.ready ?? { type: "delay", ms: 20000 };
    const stabilityMs = Number.isFinite(ready.stabilityMs) ? ready.stabilityMs : 0;

    const commitReady = () => {
      if (runtime.readySettled) return;
      if (child.exitCode !== null) {
        failReady(name, runtime, "target exited during the readiness window");
        return;
      }
      markReady(name, runtime, runtime.readyReason ?? "ready");
    };

    const beginReady = (readyReason) => {
      if (runtime.readySettled || runtime.readyCandidate) return;
      runtime.readyCandidate = true;
      runtime.readyReason = readyReason;
      clearTimeout(runtime.readyTimer);
      if (stabilityMs > 0) {
        runtime.readyTimer = setTimeout(commitReady, stabilityMs);
      } else {
        commitReady();
      }
    };

    const onChunk = (chunk) => {
      logStream.write(chunk);
      const text = String(chunk);
      const lines = text.split(/\r?\n/).filter((line) => line.length > 0);
      if (lines.length > 0) {
        runtime.lines.push(...lines);
        if (runtime.lines.length > 200) {
          runtime.lines.splice(0, runtime.lines.length - 200);
        }
      }
      if (ready.type === "marker" && typeof ready.pattern === "string") {
        try {
          if (new RegExp(ready.pattern).test(text)) beginReady("marker");
        } catch {
          // An invalid marker is a config error; the timeout reports it.
        }
      }
    };

    child.stdout?.on("data", onChunk);
    child.stderr?.on("data", onChunk);

    child.once("exit", (code, signal) => {
      clearTimeout(runtime.readyTimer);
      const isCurrent = runtimes.get(name) === runtime;
      if (!runtime.readySettled) {
        runtime.readySettled = true;
        if (isCurrent) {
          state.targets[name].status = "failed";
          state.targets[name].pid = null;
          state.targets[name].exitCode = code;
        }
        runtime.readyReject(
          new Error(
            `Target ${name} exited before ready (code=${code}, signal=${signal}).\n${runtime.lines
              .slice(-20)
              .join("\n")}`,
          ),
        );
      } else if (isCurrent) {
        state.targets[name].status = runtime.failure ? "failed" : "stopped";
        state.targets[name].pid = null;
        state.targets[name].exitCode = code;
      }
      logStream.end();
      appendLedger({ event: "target-exit", target: name, code, signal });
      onTargetStopped?.(name);
    });

    child.once("error", (error) => {
      runtime.lines.push(`[spawn error] ${error.message}`);
      if (runtimes.get(name) !== runtime) return;
      if (!runtime.readySettled) {
        clearTimeout(runtime.readyTimer);
        runtime.readySettled = true;
        runtime.failure = error.message;
        state.targets[name].status = "failed";
        state.targets[name].pid = null;
        runtime.readyReject(new Error(`Cannot start ${name}: ${error.message}`));
      }
    });

    if (ready.type === "delay") {
      const delay = Number.isFinite(ready.ms) ? ready.ms : 20000;
      runtime.readyTimer = setTimeout(() => beginReady("delay"), delay);
    } else if (ready.type === "marker") {
      const timeoutMs = Number.isFinite(ready.timeoutMs) ? ready.timeoutMs : 90000;
      runtime.readyTimer = setTimeout(() => {
        if (!runtime.readyCandidate) failReady(name, runtime, "ready marker timeout");
      }, timeoutMs);
    } else if (ready.type === "http" && typeof ready.url === "string") {
      const deadline = Date.now() + (Number.isFinite(ready.timeoutMs) ? ready.timeoutMs : 90000);
      const poll = async () => {
        if (runtime.readySettled || runtime.readyCandidate || child.exitCode !== null) return;
        try {
          const response = await fetch(ready.url, { signal: AbortSignal.timeout(1500) });
          if (response.ok) {
            beginReady("http");
            return;
          }
        } catch {
          // Keep polling until the deadline.
        }
        if (Date.now() > deadline) {
          failReady(name, runtime, `ready URL did not respond: ${ready.url}`);
          return;
        }
        runtime.readyTimer = setTimeout(poll, 500);
      };
      runtime.readyTimer = setTimeout(poll, 500);
    } else {
      beginReady("no-ready-policy");
    }

    log("info", `target ${name} starting pid=${child.pid ?? "unknown"} reason=${reason}`);
    await runtime.readyPromise;
    appendLedger({ event: "target-started", target: name, pid: child.pid ?? null, reason });
    return status(name);
  }

  function start(name, { reason = "manual" } = {}) {
    return serialize(`target:${name}`, () => startUnlocked(name, reason));
  }

  function stop(name, { reason = "manual" } = {}) {
    return serialize(`target:${name}`, async () => {
      getTargetConfig(name);
      const runtime = runtimes.get(name);

      if (!runtime?.child || runtime.child.exitCode !== null) {
        state.targets[name].status = "stopped";
        state.targets[name].pid = null;
        onTargetStopped?.(name);
        return status(name);
      }

      state.targets[name].status = "stopping";
      clearTimeout(runtime.readyTimer);
      if (!runtime.readySettled) {
        runtime.readySettled = true;
        runtime.readyReject(new Error(`Target ${name} stopped before ready`));
      }

      await stopProcessTree(runtime.child, {
        timeoutMs: getTargetConfig(name).stopTimeoutMs ?? 12000,
      });

      state.targets[name].status = "stopped";
      state.targets[name].pid = null;
      runtime.logStream.end();
      runtimes.delete(name);
      appendLedger({ event: "target-stopped", target: name, reason });
      onTargetStopped?.(name);
      return status(name);
    });
  }

  async function restart(name, { reason = "manual" } = {}) {
    await stop(name, { reason });
    return start(name, { reason });
  }

  return { start, stop, restart, status, getTargetConfig };
}
