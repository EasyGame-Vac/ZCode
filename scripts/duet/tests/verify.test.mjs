import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { loadVerifyConfiguration, runVerification } from "../verify.mjs";

const execFileAsync = promisify(execFile);
const cleanGitEnv = { ...process.env };
for (const key of Object.keys(cleanGitEnv)) {
  if (key.startsWith("GIT_")) delete cleanGitEnv[key];
}

async function git(cwd, ...args) {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    env: cleanGitEnv,
    windowsHide: true,
  });
  return stdout;
}

async function initRepo() {
  const root = await mkdtemp(join(tmpdir(), "zcode-duet-verify-"));
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
        fail: [
          {
            id: "fail",
            command: process.execPath,
            args: ["-e", "process.exit(3)"],
            timeoutMs: 10000,
          },
        ],
      },
      testStep: {
        id: "tests",
        command: process.execPath,
        args: ["-e", "process.exit(0)"],
        timeoutMs: 10000,
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
  await git(root, "add", "config.json", "protected.json", ".gitignore");
  await git(root, "commit", "-m", "config");

  return loadVerifyConfiguration({
    repoRoot: root,
    configPath: join(root, "config.json"),
  });
}

async function cleanup(root) {
  await rm(root, { force: true, maxRetries: 10, recursive: true, retryDelay: 100 });
}

test("verify passes a clean commit and reports changed files", async (t) => {
  const root = await initRepo();
  t.after(() => cleanup(root));

  const loaded = await writeConfiguration(root);
  const base = (await git(root, "rev-parse", "HEAD")).trim();

  await writeFile(join(root, "notes.txt"), "hello\n");
  await git(root, "add", ".");
  await git(root, "commit", "-m", "notes");
  const head = (await git(root, "rev-parse", "HEAD")).trim();

  let beforeStepsCalled = false;
  const result = await runVerification({
    repoRoot: root,
    base,
    commit: head,
    profile: "fast",
    config: loaded.config,
    policy: loaded.policy,
    onBeforeSteps: () => {
      beforeStepsCalled = true;
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.phase, "done");
  assert.equal(beforeStepsCalled, true);
  assert.equal(result.changes.length, 1);
  assert.equal(result.changes[0].path, "notes.txt");
  assert.equal(result.steps.length, 1);
  assert.equal(result.steps[0].id, "ok");
  assert.equal(result.steps[0].ok, true);
  assert.match(result.steps[0].logPath ?? "", /verify-ok\.log$/);
});

test("verify reports a stop failure without running steps", async (t) => {
  const root = await initRepo();
  t.after(() => cleanup(root));

  const loaded = await writeConfiguration(root);
  const base = (await git(root, "rev-parse", "HEAD")).trim();
  await writeFile(join(root, "notes.txt"), "hello\n");
  await git(root, "add", ".");
  await git(root, "commit", "-m", "notes");
  const head = (await git(root, "rev-parse", "HEAD")).trim();

  const result = await runVerification({
    repoRoot: root,
    base,
    commit: head,
    profile: "fast",
    config: loaded.config,
    policy: loaded.policy,
    onBeforeSteps: async () => {
      throw new Error("stop failed");
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.phase, "stop");
  assert.match(result.error ?? "", /stop failed/);
  assert.equal(result.steps.length, 0);
});

test("verify rejects a protected path modification", async (t) => {
  const root = await initRepo();
  t.after(() => cleanup(root));

  const loaded = await writeConfiguration(root);
  const base = (await git(root, "rev-parse", "HEAD")).trim();

  await mkdir(join(root, "scripts", "duet"), { recursive: true });
  await writeFile(join(root, "scripts", "duet", "verify.mjs"), "changed\n");
  await git(root, "add", ".");
  await git(root, "commit", "-m", "protected");
  const head = (await git(root, "rev-parse", "HEAD")).trim();

  let beforeStepsCalled = false;
  const result = await runVerification({
    repoRoot: root,
    base,
    commit: head,
    profile: "fast",
    config: loaded.config,
    policy: loaded.policy,
    onBeforeSteps: () => {
      beforeStepsCalled = true;
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.phase, "protected-paths");
  assert.equal(beforeStepsCalled, false);
  assert.equal(result.protected.violations[0].path, "scripts/duet/verify.mjs");
  assert.equal(result.steps.length, 0);
});

test("verify stops at a failing step", async (t) => {
  const root = await initRepo();
  t.after(() => cleanup(root));

  const loaded = await writeConfiguration(root);
  const base = (await git(root, "rev-parse", "HEAD")).trim();
  await writeFile(join(root, "notes.txt"), "hello\n");
  await git(root, "add", ".");
  await git(root, "commit", "-m", "notes");
  const head = (await git(root, "rev-parse", "HEAD")).trim();

  const result = await runVerification({
    repoRoot: root,
    base,
    commit: head,
    profile: "fail",
    config: loaded.config,
    policy: loaded.policy,
  });

  assert.equal(result.ok, false);
  assert.equal(result.phase, "step");
  assert.equal(result.steps.length, 1);
  assert.equal(result.steps[0].exitCode, 3);
  assert.equal(result.steps[0].ok, false);
});

test("verify rejects a dirty worktree and a commit mismatch", async (t) => {
  const root = await initRepo();
  t.after(() => cleanup(root));

  const loaded = await writeConfiguration(root);
  const base = (await git(root, "rev-parse", "HEAD")).trim();

  await writeFile(join(root, "dirty.txt"), "x\n");
  const dirtyResult = await runVerification({
    repoRoot: root,
    base,
    commit: base,
    profile: "fast",
    config: loaded.config,
    policy: loaded.policy,
  });
  assert.equal(dirtyResult.ok, false);
  assert.equal(dirtyResult.phase, "worktree");

  await rm(join(root, "dirty.txt"), { force: true });
  await writeFile(join(root, "notes.txt"), "hello\n");
  await git(root, "add", ".");
  await git(root, "commit", "-m", "notes");

  const mismatchResult = await runVerification({
    repoRoot: root,
    base,
    commit: base,
    profile: "fast",
    config: loaded.config,
    policy: loaded.policy,
  });
  assert.equal(mismatchResult.ok, false);
  assert.equal(mismatchResult.phase, "commit");
});
