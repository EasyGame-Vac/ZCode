import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { createSupervisor } from "../supervisor.mjs";

const execFileAsync = promisify(execFile);
const cleanGitEnv = { ...process.env };
for (const key of Object.keys(cleanGitEnv)) {
  if (key.startsWith("GIT_")) delete cleanGitEnv[key];
}

const FAKE_TARGET_SCRIPT = `
const fs = require("fs");
if (fs.existsSync("break.txt")) {
  console.error("BROKEN");
  process.exit(1);
}
console.log("READY");
setInterval(() => {}, 1000);
`;

async function git(cwd, ...args) {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    env: cleanGitEnv,
    windowsHide: true,
  });
  return stdout;
}

async function initRepo() {
  const root = await mkdtemp(join(tmpdir(), "zcode-duet-supervisor-"));
  await git(root, "init");
  await git(root, "config", "user.name", "Duet Test");
  await git(root, "config", "user.email", "duet@example.invalid");
  await git(root, "config", "commit.gpgsign", "false");
  await git(root, "config", "core.hooksPath", "");
  await writeFile(join(root, ".gitignore"), ".duet/\n");
  await writeFile(join(root, "README.md"), "one\n");
  await git(root, "add", ".");
  await git(root, "commit", "-m", "one");
  return root;
}

async function writeConfiguration(root) {
  const config = {
    server: { host: "127.0.0.1", port: 0 },
    stateDir: ".duet",
    targets: {
      w: {
        cwd: ".",
        command: process.execPath,
        args: ["-e", FAKE_TARGET_SCRIPT],
        autoStart: false,
        ready: {
          type: "marker",
          pattern: "READY",
          timeoutMs: 10000,
          stabilityMs: 100,
        },
        stopTimeoutMs: 1000,
      },
    },
    verify: {
      protectedPathsFile: "protected.json",
      defaultProfile: "fast",
      profiles: {
        fast: [
          {
            id: "ok",
            command: process.execPath,
            args: ["-e", "process.exit(0)"],
            timeoutMs: 10000,
          },
        ],
      },
    },
  };
  const policy = {
    blockAny: ["scripts/duet/**"],
    blockModifyOrDelete: ["**/*.test.ts"],
    allowExtensionPrefixes: [".agents/skills/duet-"],
  };

  await writeFile(join(root, "config.json"), JSON.stringify(config, null, 2));
  await writeFile(join(root, "protected.json"), JSON.stringify(policy, null, 2));
  await writeFile(join(root, "gate.txt"), "gate-v1\n");
  await writeFile(join(root, ".gitignore"), ".duet/\n");
  await git(root, "add", ".");
  await git(root, "commit", "-m", "duet fixture");
  return { configPath: join(root, "config.json") };
}

async function request(baseUrl, method, path, body) {
  const init = {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
  };
  if (body !== undefined) init.body = JSON.stringify(body);
  const response = await fetch(`${baseUrl}${path}`, init);
  const text = await response.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = { raw: text };
  }
  if (!response.ok) {
    throw new Error(`${method} ${path} -> ${response.status}: ${payload?.error ?? text}`);
  }
  return payload;
}

const get = (baseUrl, path) => request(baseUrl, "GET", path);
const post = (baseUrl, path, body) => request(baseUrl, "POST", path, body);

async function waitForActivation(baseUrl, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = await get(baseUrl, "/status");
    if (status.activation && ["succeeded", "failed"].includes(status.activation.status)) {
      return status;
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
  }
  throw new Error("activation did not finish in time");
}

test("supervisor activates, enforces the gate, and rolls back a broken target", async (t) => {
  const root = await initRepo();
  let supervisor = null;

  t.after(async () => {
    if (supervisor) await supervisor.stop();
    await rm(root, { force: true, maxRetries: 10, recursive: true, retryDelay: 100 });
  });

  const { configPath } = await writeConfiguration(root);
  supervisor = createSupervisor({
    repoRoot: root,
    configPath,
    port: 0,
    token: null,
    autoStart: false,
    gatePaths: ["gate.txt"],
    logger: { info() {}, warn() {}, error() {} },
  });

  const info = await supervisor.start();
  const baseUrl = `http://127.0.0.1:${info.port}`;
  const initialHead = (await git(root, "rev-parse", "HEAD")).trim();

  const started = await post(baseUrl, "/start", { target: "w" });
  assert.equal(started.target.status, "running");
  const firstPid = started.target.pid;
  assert.equal(typeof firstPid, "number");

  const restarted = await post(baseUrl, "/restart", { target: "w" });
  assert.equal(restarted.target.status, "running");
  assert.notEqual(restarted.target.pid, firstPid);

  const lease = await post(baseUrl, "/lease", {
    target: "w",
    leaseId: "busy-test",
    holder: "test",
    reason: "busy check",
    ttlMs: 10000,
  });
  assert.equal(lease.busy.active, true);

  const busyStatus = await get(baseUrl, "/status");
  assert.equal(busyStatus.targets.w.busy.active, true);

  await assert.rejects(() => post(baseUrl, "/restart", { target: "w" }), /409/);
  await assert.rejects(() => post(baseUrl, "/stop", { target: "w" }), /409/);
  await assert.rejects(() => post(baseUrl, "/activate", { target: "w" }), /409/);

  await post(baseUrl, "/release", {
    target: "w",
    leaseId: "busy-test",
    holder: "test",
  });
  const releasedStatus = await get(baseUrl, "/status");
  assert.equal(releasedStatus.targets.w.busy.active, false);

  await writeFile(join(root, "notes.txt"), "hello\n");
  await git(root, "add", ".");
  await git(root, "commit", "-m", "notes");
  const goodHead = (await git(root, "rev-parse", "HEAD")).trim();

  const preview = await post(baseUrl, "/preview", { target: "w" });
  assert.equal(preview.protected.ok, true);
  assert.equal(preview.changes[0].path, "notes.txt");

  const activation = await post(baseUrl, "/activate", { target: "w", actor: "test" });
  assert.equal(activation.ok, true);
  const successStatus = await waitForActivation(baseUrl);
  assert.equal(successStatus.activation.status, "succeeded");
  assert.equal(successStatus.lastGoodCommit, goodHead);
  assert.equal(successStatus.targets.w.status, "running");
  assert.equal(successStatus.targets.w.busy.active, false);
  const runningPid = successStatus.targets.w.pid;

  await mkdir(join(root, "scripts", "duet"), { recursive: true });
  await writeFile(join(root, "scripts", "duet", "verify.mjs"), "changed\n");
  await git(root, "add", ".");
  await git(root, "commit", "-m", "protected");
  const protectedHead = (await git(root, "rev-parse", "HEAD")).trim();

  const protectedPreview = await post(baseUrl, "/preview", { target: "w" });
  assert.equal(protectedPreview.protected.ok, false);
  assert.equal(
    protectedPreview.changes.some((change) => change.path === "scripts/duet/verify.mjs"),
    true,
  );

  await post(baseUrl, "/activate", { target: "w", actor: "test" });
  const protectedStatus = await waitForActivation(baseUrl);
  assert.equal(protectedStatus.activation.status, "failed");
  assert.equal(protectedStatus.activation.phase, "protected-paths");
  assert.equal(protectedStatus.lastGoodCommit, goodHead);
  assert.equal(protectedStatus.targets.w.pid, runningPid);
  assert.notEqual(protectedHead, goodHead);

  await git(root, "reset", "--hard", goodHead);
  await writeFile(join(root, "break.txt"), "break\n");
  await git(root, "add", ".");
  await git(root, "commit", "-m", "break target");
  const brokenHead = (await git(root, "rev-parse", "HEAD")).trim();

  await post(baseUrl, "/activate", { target: "w", actor: "test" });
  const rolledBackStatus = await waitForActivation(baseUrl);
  assert.equal(rolledBackStatus.activation.status, "failed");
  assert.equal(rolledBackStatus.activation.phase, "restart");
  assert.equal(rolledBackStatus.activation.rolledBack, true);
  assert.equal(rolledBackStatus.lastGoodCommit, goodHead);
  assert.equal(rolledBackStatus.targets.w.status, "running");
  assert.equal((await git(root, "rev-parse", "HEAD")).trim(), goodHead);
  assert.notEqual(brokenHead, goodHead);

  await writeFile(join(root, "gate.txt"), "gate-v2\n");
  await git(root, "add", "gate.txt");
  await git(root, "commit", "-m", "tamper gate");

  await post(baseUrl, "/activate", { target: "w", actor: "test" });
  const gateStatus = await waitForActivation(baseUrl);
  assert.equal(gateStatus.activation.status, "failed");
  assert.equal(gateStatus.activation.phase, "gate");
  assert.equal(gateStatus.targets.w.status, "running");

  await post(baseUrl, "/rollback", { target: "w", actor: "test" });
  const afterRollback = await get(baseUrl, "/status");
  assert.equal(afterRollback.activation, null);
  assert.equal(afterRollback.lastGoodCommit, goodHead);
  assert.equal(afterRollback.targets.w.status, "running");

  await mkdir(join(root, ".agents", "skills", "duet-test"), { recursive: true });
  await writeFile(join(root, ".agents", "skills", "duet-test", "SKILL.md"), "# Duet test skill\n");
  await git(root, "add", ".");
  await git(root, "commit", "-m", "add duet skill");

  const skillRecord = await post(baseUrl, "/record", {
    target: "k-extensions",
    actor: "test",
  });
  assert.equal(skillRecord.ok, true);
  assert.equal(skillRecord.changes[0].path, ".agents/skills/duet-test/SKILL.md");

  await writeFile(join(root, "README-change.md"), "outside\n");
  await git(root, "add", "README-change.md");
  await git(root, "commit", "-m", "outside extension");
  await assert.rejects(
    () => post(baseUrl, "/record", { target: "k-extensions", actor: "test" }),
    /409/,
  );

  const ledger = await get(baseUrl, "/ledger?limit=100");
  assert.equal(
    ledger.entries.some((entry) => entry.event === "activate-succeeded"),
    true,
  );
  assert.equal(
    ledger.entries.some((entry) => entry.event === "activate-failed"),
    true,
  );

  assert.notEqual(initialHead, goodHead);
});
