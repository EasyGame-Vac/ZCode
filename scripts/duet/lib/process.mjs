import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { quoteArgsForWindowsShell, resolveSpawnRuntimeOptions } from "../../spawn-command.mjs";

const execFileAsync = promisify(execFile);

/**
 * Spawns a command with the repository's Windows pnpm/npm handling. On POSIX
 * callers should pass `detached: true` when they intend to stop the whole
 * process group.
 */
export function spawnCommand(command, args, options = {}) {
  const runtimeOptions = resolveSpawnRuntimeOptions(command);
  const spawnArgs = runtimeOptions.shell ? quoteArgsForWindowsShell(args) : args;
  return spawn(command, spawnArgs, {
    windowsHide: true,
    ...options,
    ...runtimeOptions,
  });
}

export async function killProcessTree(child, { force = false } = {}) {
  if (!child || child.exitCode !== null || child.signalCode !== null || !child.pid) {
    return;
  }

  if (process.platform === "win32") {
    const args = ["/PID", String(child.pid), "/T"];
    if (force) args.push("/F");
    try {
      await execFileAsync("taskkill", args, { windowsHide: true });
    } catch {
      // taskkill returns non-zero when the process already exited.
    }
    return;
  }

  const signal = force ? "SIGKILL" : "SIGTERM";
  try {
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // The process already exited.
    }
  }
}

export function waitForExit(child, timeoutMs = 5000) {
  if (!child) return Promise.resolve(null);
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve(child.exitCode ?? child.signalCode ?? null);
  }

  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.removeListener("exit", onExit);
      child.removeListener("close", onExit);
      resolve(value);
    };
    const onExit = (code, signal) => finish(code ?? signal ?? null);
    const timer = setTimeout(() => finish(null), Math.max(0, timeoutMs));
    child.once("exit", onExit);
    child.once("close", onExit);
  });
}

export async function stopProcessTree(child, { timeoutMs = 8000 } = {}) {
  if (!child || child.exitCode !== null || child.signalCode !== null) {
    return;
  }

  if (process.platform === "win32") {
    await killProcessTree(child, { force: false });
    const exited = await waitForExit(child, Math.min(timeoutMs, 2500));
    if (exited === null && child.exitCode === null && child.signalCode === null) {
      await killProcessTree(child, { force: true });
      await waitForExit(child, 3000);
    }
    return;
  }

  await killProcessTree(child, { force: false });
  const exited = await waitForExit(child, timeoutMs);
  if (exited === null && child.exitCode === null && child.signalCode === null) {
    await killProcessTree(child, { force: true });
    await waitForExit(child, 1500);
  }
}
