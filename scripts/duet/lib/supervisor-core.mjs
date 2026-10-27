import { randomBytes, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { assertGateUnchanged, ensureGateManifest } from "./gate.mjs";
import { createLedger } from "./ledger.mjs";
import { createLeaseStore } from "./leases.mjs";
import { createSupervisorActions } from "./supervisor-actions.mjs";
import { createRequestHandler } from "./supervisor-http.mjs";
import {
  HttpError,
  errorMessage,
  git,
  loadConfig,
  normalizeText,
  now,
  tailText,
} from "./supervisor-support.mjs";
import { createTargetManager } from "./target-manager.mjs";
import {
  DEFAULT_REPO_ROOT,
  getProfileSteps,
  loadVerifyConfiguration,
  runVerification,
} from "../verify.mjs";

const DEFAULT_GATE_PATHS = [
  "scripts/duet/verify.mjs",
  "scripts/duet/supervisor.mjs",
  "scripts/duet/protected-paths.json",
  "scripts/duet/config.json",
  "scripts/duet/lib/gate.mjs",
  "scripts/duet/lib/ledger.mjs",
  "scripts/duet/lib/leases.mjs",
  "scripts/duet/lib/process.mjs",
  "scripts/duet/lib/protected-paths.mjs",
  "scripts/duet/lib/supervisor-core.mjs",
  "scripts/duet/lib/supervisor-support.mjs",
  "scripts/duet/lib/target-manager.mjs",
  "scripts/duet/lib/supervisor-actions.mjs",
  "scripts/duet/lib/supervisor-http.mjs",
  "scripts/duet/lib/supervisor-cli.mjs",
  "scripts/duet/pet",
];
const ACTIVE_STATES = new Set(["queued", "verifying", "restarting", "rolling-back", "restoring"]);

export function createSupervisor(options = {}) {
  const repoRoot = resolve(options.repoRoot ?? DEFAULT_REPO_ROOT);
  const logger = options.logger ?? console;
  const configPath = options.configPath ?? join(repoRoot, "scripts", "duet", "config.json");
  const acceptGateChange = options.acceptGateChange === true;
  const gatePaths = options.gatePaths ?? DEFAULT_GATE_PATHS;
  const requestedAutoStart = options.autoStart;

  let config = null;
  let verifyConfig = null;
  let verifyPolicy = null;
  let stateDir = null;
  let tokenPath = null;
  let token = null;
  let gateHashes = null;
  let ledger = null;
  let server = null;
  let started = false;
  let listenPort = null;
  let listenHost = null;

  const statePath = () => join(stateDir, "state.json");
  const gateManifestPath = () => join(stateDir, "gate-hashes.json");
  const ledgerPath = () => join(stateDir, "ledger.jsonl");
  const logDir = () => join(stateDir, "logs");

  const state = {
    targets: {},
    lastGoodCommit: null,
    activation: null,
  };

  const log = (level, ...args) => {
    const target = logger?.[level];
    if (typeof target === "function") target.call(logger, "[duet]", ...args);
  };

  const leaseStore = createLeaseStore();

  const targetManager = createTargetManager({
    repoRoot,
    state,
    getConfig: () => config,
    getLedger: () => ledger,
    log,
    logDir,
    onTargetStopped: (name) => leaseStore.clearTarget(name),
  });

  const actions = createSupervisorActions({
    repoRoot,
    state,
    getConfig: () => config,
    getVerifyPolicy: () => verifyPolicy,
    getLedger: () => ledger,
    targetManager,
  });

  function assertNoActiveActivation() {
    if (state.activation && ACTIVE_STATES.has(state.activation.status)) {
      throw new HttpError(409, "an activation is already in progress", {
        activationId: state.activation.id,
        status: state.activation.status,
      });
    }
  }

  function getStatus() {
    return {
      ok: true,
      repoRoot,
      now: now(),
      lastGoodCommit: state.lastGoodCommit,
      activation: state.activation,
      targets: Object.fromEntries(
        Object.keys(state.targets).map((name) => [
          name,
          { ...targetManager.status(name), busy: leaseStore.busy(name) },
        ]),
      ),
    };
  }

  function assertTargetIdle(name, { force = false } = {}) {
    targetManager.getTargetConfig(name);
    const busy = leaseStore.busy(name);
    if (busy.active && !force) {
      throw new HttpError(409, `target ${name} is busy executing a task`, {
        target: name,
        busy,
      });
    }
    return busy;
  }

  function acquireLease(body) {
    const target = normalizeText(body.target, 64);
    targetManager.getTargetConfig(target);
    if (
      state.activation &&
      state.activation.target === target &&
      ACTIVE_STATES.has(state.activation.status)
    ) {
      throw new HttpError(409, `target ${target} is being updated`, {
        target,
        activationId: state.activation.id,
        status: state.activation.status,
      });
    }

    try {
      return leaseStore.acquire({
        target,
        leaseId: normalizeText(body.leaseId, 128),
        holder: normalizeText(body.holder, 128),
        reason: normalizeText(body.reason, 200),
        ttlMs: body.ttlMs,
      });
    } catch (error) {
      throw new HttpError(400, errorMessage(error));
    }
  }

  function releaseLease(body) {
    const target = normalizeText(body.target, 64);
    targetManager.getTargetConfig(target);
    try {
      return leaseStore.release({
        target,
        leaseId: normalizeText(body.leaseId, 128),
        holder: normalizeText(body.holder, 128),
      });
    } catch (error) {
      throw new HttpError(400, errorMessage(error));
    }
  }

  async function persistState() {
    await mkdir(stateDir, { recursive: true });
    const temporary = `${statePath()}.tmp`;
    const payload = `${JSON.stringify(
      { lastGoodCommit: state.lastGoodCommit, updatedAt: now() },
      null,
      2,
    )}\n`;
    await writeFile(temporary, payload, "utf8");
    try {
      await rename(temporary, statePath());
    } catch {
      // Some Windows filesystems refuse replacing an existing state file.
      await writeFile(statePath(), payload, "utf8");
    }
  }

  async function loadState() {
    try {
      const parsed = JSON.parse(await readFile(statePath(), "utf8"));
      state.lastGoodCommit =
        typeof parsed?.lastGoodCommit === "string" && parsed.lastGoodCommit.length > 0
          ? parsed.lastGoodCommit
          : null;
    } catch {
      state.lastGoodCommit = null;
    }

    if (state.lastGoodCommit) {
      try {
        await git(repoRoot, ["rev-parse", state.lastGoodCommit]);
      } catch {
        state.lastGoodCommit = null;
      }
    }

    if (!state.lastGoodCommit) {
      try {
        state.lastGoodCommit = (await git(repoRoot, ["rev-parse", "HEAD"])).trim();
      } catch {
        state.lastGoodCommit = null;
      }
      await persistState();
    }
  }

  async function loadOrCreateToken() {
    if (options.token === null) return null;
    if (typeof options.token === "string" && options.token.length > 0) return options.token;

    try {
      const existing = (await readFile(tokenPath, "utf8")).trim();
      if (existing.length > 0) return existing;
    } catch {
      // Create one below.
    }

    const created = randomBytes(32).toString("hex");
    await mkdir(stateDir, { recursive: true });
    await writeFile(tokenPath, `${created}\n`, { encoding: "utf8", mode: 0o600 });
    try {
      await chmod(tokenPath, 0o600);
    } catch {
      // Windows does not use POSIX modes.
    }
    return created;
  }

  function summarizeVerify(result) {
    return {
      ok: result.ok,
      phase: result.phase,
      error: result.error ?? null,
      profile: result.profile ?? null,
      base: result.base ?? null,
      commit: result.commit ?? null,
      changes: result.changes ?? [],
      protected: result.protected ?? { ok: true, violations: [] },
      steps: (result.steps ?? []).map((step) => ({
        id: step.id,
        ok: step.ok,
        exitCode: step.exitCode,
        timedOut: step.timedOut,
        durationMs: step.durationMs,
        logPath: step.logPath,
        stderrTail: tailText(step.stderr),
      })),
    };
  }

  async function recoverStoppedTarget(
    activation,
    repo,
    previous,
    { reason, rollbackFirst = false },
  ) {
    let restored = false;
    let rolledBack = false;

    if (!rollbackFirst) {
      try {
        await targetManager.start(activation.target, { reason });
        restored = true;
      } catch (error) {
        activation.restartError = errorMessage(error);
      }
    }

    if (!restored && previous) {
      try {
        await targetManager.stop(activation.target, { reason: `${reason}-rollback` });
        await git(repo, ["checkout", "--detach", previous]);
        await targetManager.start(activation.target, { reason: `${reason}-rollback` });
        rolledBack = true;
      } catch (error) {
        activation.rollbackError = errorMessage(error);
      }
    }

    activation.restored = restored;
    activation.rolledBack = rolledBack;
    return { restored, rolledBack };
  }

  function failActivation(activation, phase, error, extra = {}) {
    activation.status = "failed";
    activation.phase = phase;
    activation.error = error;
    activation.finishedAt = now();
    void ledger.append({
      event: "activate-failed",
      activationId: activation.id,
      actor: activation.actor,
      target: activation.target,
      phase,
      error,
      ...extra,
    });
  }

  async function runActivation(activation) {
    try {
      const target = targetManager.getTargetConfig(activation.target);
      const repo = target.cwd;
      const head = (await git(repo, ["rev-parse", "HEAD"])).trim();
      const requested = activation.commit || head;
      const resolved = (await git(repo, ["rev-parse", requested])).trim();

      if (resolved !== head) {
        throw new HttpError(
          409,
          `requested commit ${resolved} is not HEAD ${head}; commit or check out it first`,
        );
      }

      const dirty = (await git(repo, ["status", "--porcelain"])).trim();
      if (dirty.length > 0) {
        throw new HttpError(409, "worktree is dirty; commit or stash before activation");
      }

      activation.status = "verifying";
      activation.step = "gate";
      const gateCheck = await assertGateUnchanged({
        repoRoot,
        gatePaths,
        expected: gateHashes,
      });
      if (!gateCheck.ok) {
        activation.details = { changes: gateCheck.changes };
        failActivation(activation, "gate", "gate files changed while the supervisor was running");
        return;
      }

      const previous = state.lastGoodCommit;
      let stoppedForVerification = false;
      activation.step = "protected-paths";
      const verifyResult = await runVerification({
        repoRoot: repo,
        base: previous,
        commit: head,
        profile: activation.profile,
        config: verifyConfig,
        policy: verifyPolicy,
        tests: activation.tests,
        onBeforeSteps: async () => {
          activation.step = "stopping";
          activation.stepStatus = "running";
          stoppedForVerification = true;
          await targetManager.stop(activation.target, { reason: "activation-verify" });
        },
        onStep: (step) => {
          activation.step = step.id;
          activation.stepStatus = step.status;
        },
      });
      activation.verify = summarizeVerify(verifyResult);

      if (!verifyResult.ok) {
        if (!stoppedForVerification) {
          failActivation(
            activation,
            verifyResult.phase,
            verifyResult.error ?? "verification failed",
            { commit: head },
          );
          return;
        }

        activation.status = "restoring";
        activation.step = "restore";
        const recovery = await recoverStoppedTarget(activation, repo, previous, {
          reason: "verify-failed",
        });
        const suffix = recovery.restored
          ? "；窗口版已恢复"
          : recovery.rolledBack
            ? "；已回滚窗口版"
            : "；窗口版未能恢复";
        failActivation(
          activation,
          verifyResult.phase,
          `${verifyResult.error ?? "verification failed"}${suffix}`,
          {
            commit: head,
            restored: recovery.restored,
            rolledBack: recovery.rolledBack,
          },
        );
        return;
      }

      activation.status = "restarting";
      activation.step = "restart";
      if (!stoppedForVerification) {
        await targetManager.stop(activation.target, { reason: "activation" });
      }

      try {
        await targetManager.start(activation.target, { reason: "activation" });
      } catch (restartError) {
        activation.restartError = errorMessage(restartError);
        activation.status = "rolling-back";
        activation.step = "rollback";
        const recovery = await recoverStoppedTarget(activation, repo, previous, {
          reason: "activation-restart-failed",
          rollbackFirst: true,
        });
        const suffix = recovery.rolledBack ? "；已回滚窗口版" : "；回滚失败";
        failActivation(activation, "restart", `${activation.restartError}${suffix}`, {
          rolledBack: recovery.rolledBack,
          previousCommit: previous,
        });
        return;
      }

      state.lastGoodCommit = head;
      await persistState();
      activation.status = "succeeded";
      activation.step = "done";
      activation.previousCommit = previous;
      activation.finishedAt = now();
      void ledger.append({
        event: "activate-succeeded",
        activationId: activation.id,
        actor: activation.actor,
        target: activation.target,
        commit: head,
        previousCommit: previous,
        profile: activation.profile,
      });
    } catch (error) {
      failActivation(activation, activation.phase ?? "activate", errorMessage(error));
      activation.details = error instanceof HttpError ? error.details : undefined;
    }
  }

  function startActivation(body) {
    assertNoActiveActivation();
    const targetName = normalizeText(body.target, 64);
    targetManager.getTargetConfig(targetName);
    assertTargetIdle(targetName);
    const profile = normalizeText(body.profile, 32) || "fast";
    try {
      getProfileSteps(verifyConfig, profile);
    } catch (error) {
      throw new HttpError(400, errorMessage(error));
    }
    const tests = Array.isArray(body.tests)
      ? body.tests
          .map((value) => normalizeText(value, 200))
          .filter(Boolean)
          .slice(0, 20)
      : [];

    const activation = {
      id: randomUUID(),
      target: targetName,
      commit: normalizeText(body.commit, 128) || null,
      profile,
      actor: normalizeText(body.actor, 100) || "unknown",
      tests,
      status: "queued",
      step: "queued",
      startedAt: now(),
      finishedAt: null,
      error: null,
    };
    state.activation = activation;
    void ledger.append({
      event: "activate-requested",
      activationId: activation.id,
      actor: activation.actor,
      target: activation.target,
      commit: activation.commit,
      profile: activation.profile,
    });
    void runActivation(activation);
    return { ok: true, activationId: activation.id, status: activation.status };
  }

  const handleRequest = createRequestHandler({
    getToken: () => token,
    getStatus,
    getLedger: () => ledger,
    getTargetConfig: targetManager.getTargetConfig,
    startTarget: targetManager.start,
    stopTarget: targetManager.stop,
    targetStatus: targetManager.status,
    assertNoActiveActivation,
    assertTargetIdle,
    acquireLease,
    releaseLease,
    startActivation,
    preview: actions.preview,
    record: actions.record,
    rollback: actions.rollback,
    log,
  });

  async function initialize() {
    const loaded = await loadConfig({ repoRoot, configPath });
    config = loaded.config;
    stateDir = resolve(repoRoot, options.stateDir ?? config.stateDir ?? ".duet");
    await mkdir(stateDir, { recursive: true });

    const loadedVerify = await loadVerifyConfiguration({
      repoRoot,
      configPath,
      protectedPathsPath: undefined,
    });
    verifyConfig = loadedVerify.config;
    verifyPolicy = loadedVerify.policy;

    tokenPath = join(stateDir, "token");
    ledger = createLedger(ledgerPath(), { logger });
    await mkdir(logDir(), { recursive: true });

    for (const name of Object.keys(config.targets)) {
      state.targets[name] = {
        status: "stopped",
        pid: null,
        startedAt: null,
        readyAt: null,
        exitCode: null,
        logPath: join(logDir(), `${name}.log`),
      };
    }

    token = await loadOrCreateToken();
    await loadState();

    const gate = await ensureGateManifest({
      repoRoot,
      gatePaths,
      manifestPath: gateManifestPath(),
      acceptChange: acceptGateChange,
    });
    gateHashes = gate.hashes;
    if (gate.created) log("info", "gate manifest created");
    if (gate.changed) log("warn", "gate manifest changed and was accepted");
  }

  async function start() {
    if (started) {
      return { host: listenHost, port: listenPort, tokenPath, stateDir };
    }
    await initialize();

    server = createServer((request, response) => {
      void handleRequest(request, response);
    });
    server.requestTimeout = 0;
    server.headersTimeout = 60_000;
    server.keepAliveTimeout = 5_000;

    const host = normalizeText(options.host ?? config.server?.host, 100) || "127.0.0.1";
    const port = Number.isFinite(options.port) ? options.port : (config.server?.port ?? 47821);

    await new Promise((resolveListen, rejectListen) => {
      server.once("error", rejectListen);
      server.listen(port, host, () => {
        server.removeListener("error", rejectListen);
        resolveListen();
      });
    });

    const address = server.address();
    listenPort = typeof address === "object" && address ? address.port : port;
    listenHost = host;
    started = true;

    // Targets inherit these so the agent runtime can report target-scoped task
    // leases. The values describe this supervisor instance, not the config file.
    process.env.ZCODE_DUET_SUPERVISOR_URL = `http://${listenHost}:${listenPort}`;
    process.env.ZCODE_DUET_TOKEN_PATH = tokenPath;

    if (typeof requestedAutoStart !== "boolean" || requestedAutoStart) {
      for (const [name, target] of Object.entries(config.targets)) {
        const shouldStart =
          typeof requestedAutoStart === "boolean" ? requestedAutoStart : target.autoStart !== false;
        if (!shouldStart) continue;
        void targetManager.start(name, { reason: "auto-start" }).catch((error) => {
          log("error", `auto-start ${name} failed:`, error);
          void ledger.append({
            event: "target-auto-start-failed",
            target: name,
            error: errorMessage(error),
          });
        });
      }
    }

    log("info", `listening on http://${host}:${listenPort}`);
    return { host, port: listenPort, tokenPath, stateDir };
  }

  async function stop() {
    for (const name of Object.keys(state.targets)) {
      try {
        await targetManager.stop(name, { reason: "supervisor-shutdown" });
      } catch (error) {
        log("warn", `stop ${name} failed:`, error);
      }
    }
    if (server) {
      server.closeAllConnections?.();
      await new Promise((resolveClose) => server.close(() => resolveClose()));
      server = null;
    }
    started = false;
  }

  return {
    start,
    stop,
    getStatus,
    startTarget: targetManager.start,
    stopTarget: targetManager.stop,
    activate: startActivation,
    preview: actions.preview,
    record: actions.record,
    rollback: actions.rollback,
    assertTargetIdle,
    acquireLease,
    releaseLease,
    get tokenPath() {
      return tokenPath;
    },
    get stateDir() {
      return stateDir;
    },
    get gateHashes() {
      return gateHashes;
    },
  };
}
