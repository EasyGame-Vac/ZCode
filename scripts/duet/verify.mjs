import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs, promisify } from "node:util";
import { killProcessTree, spawnCommand, waitForExit } from "./lib/process.mjs";
import {
  evaluateChangedPaths,
  loadProtectedPaths,
  parseNameStatus,
  validateExtensionChanges,
} from "./lib/protected-paths.mjs";

const execFileAsync = promisify(execFile);

export const SCRIPT_DIR = import.meta.dirname;
export const DEFAULT_REPO_ROOT = resolve(SCRIPT_DIR, "../..");
export const DEFAULT_CONFIG_PATH = join(SCRIPT_DIR, "config.json");
export const DEFAULT_PROTECTED_PATHS_PATH = join(SCRIPT_DIR, "protected-paths.json");
export const DEFAULT_STEP_TIMEOUT_MS = 15 * 60 * 1000;
const MAX_CAPTURE_CHARS = 2 * 1024 * 1024;

class TailBuffer {
  constructor(maxChars = MAX_CAPTURE_CHARS) {
    this.maxChars = maxChars;
    this.chunks = [];
    this.length = 0;
    this.truncated = false;
  }

  push(chunk) {
    const text = String(chunk);
    this.chunks.push(text);
    this.length += text.length;

    while (this.length > this.maxChars && this.chunks.length > 1) {
      const removed = this.chunks.shift() ?? "";
      this.length -= removed.length;
      this.truncated = true;
    }

    if (this.chunks.length === 1 && (this.chunks[0]?.length ?? 0) > this.maxChars) {
      this.chunks[0] = this.chunks[0].slice(-this.maxChars);
      this.length = this.maxChars;
      this.truncated = true;
    }
  }

  text() {
    return this.chunks.join("");
  }
}

async function git(cwd, args) {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    maxBuffer: 16 * 1024 * 1024,
    windowsHide: true,
  });
  return stdout;
}

function validateStep(step, profile) {
  if (!step || typeof step !== "object") {
    throw new Error(`verify profile ${profile} contains a non-object step`);
  }
  if (typeof step.id !== "string" || step.id.trim().length === 0) {
    throw new Error(`verify profile ${profile} contains a step without id`);
  }
  if (typeof step.command !== "string" || step.command.trim().length === 0) {
    throw new Error(`verify step ${step.id} has no command`);
  }
  if (step.args !== undefined && !Array.isArray(step.args)) {
    throw new Error(`verify step ${step.id} args must be an array`);
  }
  if (step.timeoutMs !== undefined && !Number.isFinite(step.timeoutMs)) {
    throw new Error(`verify step ${step.id} timeoutMs must be a number`);
  }
}

export function getProfileSteps(config, profile) {
  const steps = config?.verify?.profiles?.[profile];
  if (!Array.isArray(steps) || steps.length === 0) {
    throw new Error(`Unknown or empty verify profile: ${profile}`);
  }
  for (const step of steps) validateStep(step, profile);
  return steps;
}

export async function loadVerifyConfiguration({ repoRoot, configPath, protectedPathsPath } = {}) {
  const resolvedRoot = resolve(repoRoot ?? DEFAULT_REPO_ROOT);
  const resolvedConfigPath = resolve(configPath ?? DEFAULT_CONFIG_PATH);
  const config = JSON.parse(await readFile(resolvedConfigPath, "utf8"));
  const configuredProtectedPaths = config?.verify?.protectedPathsFile;
  const resolvedProtectedPathsPath = resolve(
    protectedPathsPath ??
      (typeof configuredProtectedPaths === "string" && configuredProtectedPaths.length > 0
        ? resolve(dirname(resolvedConfigPath), configuredProtectedPaths)
        : DEFAULT_PROTECTED_PATHS_PATH),
  );

  for (const profile of Object.keys(config?.verify?.profiles ?? {})) {
    getProfileSteps(config, profile);
  }

  const policy = await loadProtectedPaths(resolvedProtectedPathsPath);
  return {
    config,
    policy,
    repoRoot: resolvedRoot,
    configPath: resolvedConfigPath,
    protectedPathsPath: resolvedProtectedPathsPath,
  };
}

function safeFileSegment(value) {
  return value.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "step";
}

async function runStep(step, { cwd }) {
  const startedAt = Date.now();
  const stdout = new TailBuffer();
  const stderr = new TailBuffer();
  const child = spawnCommand(step.command, step.args ?? [], {
    cwd,
    detached: process.platform !== "win32",
    env: { ...process.env, ...step.env },
    stdio: ["ignore", "pipe", "pipe"],
  });

  child.stdout?.on("data", (chunk) => stdout.push(chunk));
  child.stderr?.on("data", (chunk) => stderr.push(chunk));

  const timeoutMs = Number.isFinite(step.timeoutMs) ? step.timeoutMs : DEFAULT_STEP_TIMEOUT_MS;
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    void killProcessTree(child, { force: true });
  }, timeoutMs);

  const outcome = await new Promise((resolveOutcome) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolveOutcome(value);
    };
    child.once("error", (error) => finish({ code: null, signal: null, spawnError: error.message }));
    child.once("close", (code, signal) => finish({ code, signal, spawnError: null }));
  });

  clearTimeout(timeout);
  await waitForExit(child, 1500);

  const logDir = join(cwd, ".duet", "logs");
  const logPath = join(logDir, `verify-${safeFileSegment(step.id)}.log`);
  let wroteLog = false;
  try {
    await mkdir(logDir, { recursive: true });
    await writeFile(
      logPath,
      [
        `$ ${step.command} ${(step.args ?? []).join(" ")}`,
        `cwd: ${cwd}`,
        `exit: ${outcome.code ?? "null"} signal: ${outcome.signal ?? "null"} timedOut: ${timedOut}`,
        "",
        "--- stdout ---",
        stdout.text(),
        "",
        "--- stderr ---",
        stderr.text(),
        "",
      ].join("\n"),
      "utf8",
    );
    wroteLog = true;
  } catch {
    // A missing log must not hide the real step result.
  }

  return {
    id: step.id,
    command: step.command,
    args: step.args ?? [],
    ok: !timedOut && outcome.code === 0,
    exitCode: outcome.code,
    signal: outcome.signal,
    timedOut,
    spawnError: outcome.spawnError,
    durationMs: Date.now() - startedAt,
    stdout: stdout.text(),
    stderr: stderr.text(),
    stdoutTruncated: stdout.truncated,
    stderrTruncated: stderr.truncated,
    logPath: wroteLog ? logPath : null,
  };
}

function failure(phase, error, extra = {}) {
  return {
    ok: false,
    phase,
    error,
    steps: [],
    changes: [],
    protected: { ok: true, violations: [] },
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    ...extra,
  };
}

/**
 * Runs the fixed verification gate. The caller supplies the already-loaded
 * config and protected policy so an agent cannot swap them mid-flight.
 */
export async function runVerification({
  repoRoot = DEFAULT_REPO_ROOT,
  base,
  commit,
  profile = "fast",
  config,
  policy,
  tests,
  onStep,
  onBeforeSteps,
} = {}) {
  const startedAt = new Date().toISOString();
  const root = resolve(repoRoot);

  let head;
  let targetCommit;
  try {
    head = (await git(root, ["rev-parse", "HEAD"])).trim();
    targetCommit = (await git(root, ["rev-parse", commit ?? head])).trim();
  } catch (error) {
    return failure("git", error instanceof Error ? error.message : String(error), { startedAt });
  }

  const dirty = (await git(root, ["status", "--porcelain"])).trim();
  if (dirty.length > 0) {
    return failure("worktree", "Worktree is dirty. Commit or stash changes before activation.", {
      head,
      commit: targetCommit,
      startedAt,
      dirty,
    });
  }

  if (targetCommit !== head) {
    return failure(
      "commit",
      `HEAD is ${head}, requested commit is ${targetCommit}. Commit or check out the requested commit first.`,
      { head, commit: targetCommit, startedAt },
    );
  }

  let baseCommit = null;
  if (base) {
    try {
      baseCommit = (await git(root, ["rev-parse", base])).trim();
    } catch {
      return failure("base", `Cannot resolve base commit: ${base}`, {
        head,
        commit: targetCommit,
        startedAt,
      });
    }
  } else {
    try {
      baseCommit = (await git(root, ["rev-parse", `${targetCommit}~1`])).trim();
    } catch {
      baseCommit = null;
    }
  }

  let changes = [];
  let stat = "";
  if (baseCommit) {
    const diff = await git(root, ["diff", "--name-status", `${baseCommit}..${targetCommit}`]);
    changes = parseNameStatus(diff);
    stat = (await git(root, ["diff", "--stat", `${baseCommit}..${targetCommit}`])).trim();
  }

  const protectedResult = evaluateChangedPaths(changes, policy);
  if (!protectedResult.ok) {
    return {
      ok: false,
      phase: "protected-paths",
      error: "Protected paths were modified.",
      head,
      base: baseCommit,
      commit: targetCommit,
      profile,
      worktreeClean: true,
      changes,
      stat,
      protected: protectedResult,
      steps: [],
      startedAt,
      finishedAt: new Date().toISOString(),
    };
  }

  let steps;
  try {
    steps = [...getProfileSteps(config, profile)];
  } catch (error) {
    return failure("config", error instanceof Error ? error.message : String(error), {
      head,
      base: baseCommit,
      commit: targetCommit,
      startedAt,
      changes,
      stat,
      protected: protectedResult,
    });
  }

  const requestedTests = (Array.isArray(tests) ? tests : tests ? [tests] : [])
    .map((value) => String(value).trim())
    .filter(Boolean);
  if (requestedTests.length > 0) {
    const testStep = config?.verify?.testStep;
    if (!testStep || typeof testStep !== "object") {
      return failure("config", "verify.testStep is required to run --tests", {
        head,
        base: baseCommit,
        commit: targetCommit,
        startedAt,
        changes,
        stat,
        protected: protectedResult,
      });
    }
    steps.push({ ...testStep, args: [...(testStep.args ?? []), ...requestedTests] });
  }

  // The target is closed only after the cheap checks and configuration
  // validation pass. A protected-path or config failure leaves it running.
  if (onBeforeSteps) {
    try {
      await onBeforeSteps();
    } catch (error) {
      return {
        ok: false,
        phase: "stop",
        error: error instanceof Error ? error.message : String(error),
        head,
        base: baseCommit,
        commit: targetCommit,
        profile,
        worktreeClean: true,
        changes,
        stat,
        protected: protectedResult,
        steps: [],
        startedAt,
        finishedAt: new Date().toISOString(),
      };
    }
  }

  const results = [];
  for (const step of steps) {
    onStep?.({ id: step.id, status: "running" });
    const result = await runStep(step, { cwd: root });
    results.push(result);
    onStep?.({
      id: step.id,
      status: result.ok ? "passed" : "failed",
      durationMs: result.durationMs,
    });
    if (!result.ok) break;
  }

  const ok = results.every((result) => result.ok);
  return {
    ok,
    phase: ok ? "done" : "step",
    error: ok
      ? null
      : `Verification step failed: ${results.find((result) => !result.ok)?.id ?? "unknown"}`,
    head,
    base: baseCommit,
    commit: targetCommit,
    profile,
    worktreeClean: true,
    changes,
    stat,
    protected: protectedResult,
    steps: results,
    startedAt,
    finishedAt: new Date().toISOString(),
  };
}

export function formatHumanVerification(result) {
  const lines = [];
  lines.push(`Verify: ${result.ok ? "PASS" : "FAIL"} (${result.phase})`);
  if (result.head) lines.push(`HEAD: ${result.head}`);
  if (result.base) lines.push(`Base: ${result.base}`);
  if (result.profile) lines.push(`Profile: ${result.profile}`);
  if (result.changes?.length) {
    lines.push(`Changes: ${result.changes.length}`);
    for (const change of result.changes) {
      lines.push(
        `  ${change.status} ${change.oldPath ? `${change.oldPath} -> ` : ""}${change.path}`,
      );
    }
  }
  if (result.protected?.violations?.length) {
    lines.push("Protected path violations:");
    for (const violation of result.protected.violations) {
      lines.push(`  ${violation.status} ${violation.path} (${violation.rule})`);
    }
  }
  if (result.error) lines.push(`Error: ${result.error}`);
  for (const step of result.steps ?? []) {
    lines.push(
      `${step.ok ? "PASS" : "FAIL"} ${step.id} (${Math.round(step.durationMs / 100) / 10}s${step.timedOut ? ", timed out" : ""})`,
    );
    if (!step.ok) {
      const tail = (step.stderr || step.stdout || "").trim().split(/\r?\n/).slice(-25).join("\n");
      if (tail) lines.push(`  ${tail.replaceAll("\n", "\n  ")}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

const USAGE = `Usage:
  node scripts/duet/verify.mjs [--cwd <repo>] [--base <commit>] [--commit <commit>]
                               [--profile fast|full] [--config <path>]
                               [--protected-paths <path>] [--tests <pattern>] [--json]

The supervisor passes --base <last-good-commit> so the protected-path check covers
every change since the last activation.`;

async function main() {
  let values;
  try {
    ({ values } = parseArgs({
      allowPositionals: false,
      options: {
        base: { type: "string" },
        commit: { type: "string" },
        config: { type: "string" },
        cwd: { type: "string" },
        help: { short: "h", type: "boolean" },
        json: { type: "boolean" },
        profile: { type: "string" },
        "protected-paths": { type: "string" },
        tests: { multiple: true, type: "string" },
      },
      strict: true,
    }));
  } catch (error) {
    process.stderr.write(`${USAGE}\n${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }

  if (values.help) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }

  try {
    const repoRoot = resolve(values.cwd ?? DEFAULT_REPO_ROOT);
    const loaded = await loadVerifyConfiguration({
      repoRoot,
      configPath: values.config,
      protectedPathsPath: values["protected-paths"],
    });
    const result = await runVerification({
      repoRoot,
      base: values.base,
      commit: values.commit,
      profile: values.profile ?? loaded.config?.verify?.defaultProfile ?? "fast",
      config: loaded.config,
      policy: loaded.policy,
      tests: values.tests,
    });

    if (values.json) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } else {
      process.stdout.write(formatHumanVerification(result));
    }
    return result.ok ? 0 : 1;
  } catch (error) {
    process.stderr.write(
      `verify failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
    );
    return 2;
  }
}

const isEntrypoint =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isEntrypoint) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
      process.exitCode = 2;
    });
}

export { validateExtensionChanges };
