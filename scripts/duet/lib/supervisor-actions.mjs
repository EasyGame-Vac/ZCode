import {
  evaluateChangedPaths,
  parseNameStatus,
  validateExtensionChanges,
} from "./protected-paths.mjs";
import { HttpError, git, normalizeText } from "./supervisor-support.mjs";

export function createSupervisorActions({
  repoRoot,
  state,
  getConfig,
  getVerifyPolicy,
  getLedger,
  targetManager,
}) {
  function getTargetConfig(name) {
    const target = getConfig()?.targets?.[name];
    if (!target) throw new HttpError(400, `unknown target: ${name || "<empty>"}`);
    return target;
  }

  function appendLedger(event) {
    const ledger = getLedger();
    if (ledger) void ledger.append(event);
  }

  async function preview(body) {
    const targetName = normalizeText(body.target, 64);
    const target = getTargetConfig(targetName);
    const repo = target.cwd;
    const head = (await git(repo, ["rev-parse", "HEAD"])).trim();
    const resolved = (
      await git(repo, ["rev-parse", normalizeText(body.commit, 128) || head])
    ).trim();
    let base = normalizeText(body.base, 128) || state.lastGoodCommit;
    if (!base) {
      try {
        base = (await git(repo, ["rev-parse", `${resolved}~1`])).trim();
      } catch {
        base = null;
      }
    }
    const dirty = (await git(repo, ["status", "--porcelain"])).trim();
    const diff = base ? await git(repo, ["diff", "--name-status", `${base}..${resolved}`]) : "";
    const changes = parseNameStatus(diff);
    const protectedResult = evaluateChangedPaths(changes, getVerifyPolicy());
    const stat = base ? (await git(repo, ["diff", "--stat", `${base}..${resolved}`])).trim() : "";

    return {
      ok: true,
      target: targetName,
      head,
      commit: resolved,
      base,
      stat,
      changes,
      protected: protectedResult,
      dirty: dirty.length > 0,
      worktreeClean: dirty.length === 0,
    };
  }

  async function record(body) {
    if (normalizeText(body.target, 64) !== "k-extensions") {
      throw new HttpError(400, 'record target must be "k-extensions"');
    }
    const head = (await git(repoRoot, ["rev-parse", "HEAD"])).trim();
    const resolved = (
      await git(repoRoot, ["rev-parse", normalizeText(body.commit, 128) || head])
    ).trim();
    let base = normalizeText(body.base, 128);
    if (!base) {
      try {
        base = (await git(repoRoot, ["rev-parse", `${resolved}~1`])).trim();
      } catch {
        base = resolved;
      }
    }
    const changes = parseNameStatus(
      await git(repoRoot, ["diff", "--name-status", `${base}..${resolved}`]),
    );
    const validation = validateExtensionChanges(
      changes,
      getVerifyPolicy().allowExtensionPrefixes ?? [],
    );
    if (!validation.ok) {
      throw new HttpError(409, "recorded changes must stay under .agents/skills/duet-*", {
        violations: validation.violations,
        changes,
      });
    }
    const actor = normalizeText(body.actor, 100) || "unknown";
    appendLedger({
      event: "k-extensions-recorded",
      actor,
      commit: resolved,
      base,
      changes,
    });
    return { ok: true, commit: resolved, base, changes };
  }

  async function rollback(body) {
    const targetName = normalizeText(body.target, 64);
    const target = getTargetConfig(targetName);
    if (!state.lastGoodCommit) throw new HttpError(409, "no lastGoodCommit is recorded");
    const dirty = (await git(target.cwd, ["status", "--porcelain"])).trim();
    if (dirty.length > 0) {
      throw new HttpError(409, "worktree is dirty; commit or stash before rollback");
    }

    await targetManager.stop(targetName, { reason: "manual-rollback" });
    await git(target.cwd, ["checkout", "--detach", state.lastGoodCommit]);
    await targetManager.start(targetName, { reason: "manual-rollback" });
    // 手动回滚完成后清掉上一次失败的激活状态，精灵不应继续显示旧的失败原因。
    state.activation = null;
    appendLedger({
      event: "rollback-completed",
      actor: normalizeText(body.actor, 100) || "unknown",
      target: targetName,
      commit: state.lastGoodCommit,
      reason: normalizeText(body.reason, 200) || null,
    });
    return {
      ok: true,
      target: targetName,
      commit: state.lastGoodCommit,
      status: targetManager.status(targetName),
    };
  }

  return { preview, record, rollback };
}
