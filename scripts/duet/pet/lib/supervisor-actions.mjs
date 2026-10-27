/**
 * renderer 只能提交受限的 supervisor 动作；命令、路径和权限都由这里收口。
 * 返回值与 SupervisorError 的 status 原样透传，renderer 只展示错误。
 */
export function createSupervisorActions({ getSupervisor }) {
  function sanitizePayload(action, payload) {
    const source = payload && typeof payload === "object" ? payload : {};
    if (action === "preview") {
      return {
        target: "w",
        commit: typeof source.commit === "string" ? source.commit.slice(0, 128) : undefined,
        base: typeof source.base === "string" ? source.base.slice(0, 128) : undefined,
      };
    }
    if (action === "activate") {
      return {
        target: "w",
        actor: "pet",
        profile: typeof source.profile === "string" ? source.profile.slice(0, 32) : "fast",
        commit: typeof source.commit === "string" ? source.commit.slice(0, 128) : undefined,
        tests: Array.isArray(source.tests)
          ? source.tests
              .filter((value) => typeof value === "string")
              .map((value) => value.slice(0, 200))
              .slice(0, 20)
          : undefined,
      };
    }
    if (action === "rollback") {
      return {
        target: "w",
        actor: "pet",
        reason: typeof source.reason === "string" ? source.reason.slice(0, 200) : "pet",
      };
    }
    if (action === "ledger") {
      return {
        limit: Number.isFinite(source.limit) ? Math.min(Math.max(source.limit, 1), 200) : 20,
      };
    }
    if (action === "restart") return { target: "w" };
    return {};
  }

  async function handle(action, payload) {
    const supervisor = getSupervisor();
    switch (action) {
      case "status":
        return supervisor.getStatus();
      case "preview":
        return supervisor.preview(sanitizePayload("preview", payload));
      case "activate":
        return supervisor.activate(sanitizePayload("activate", payload));
      case "rollback":
        return supervisor.rollback(sanitizePayload("rollback", payload));
      case "restart":
        return supervisor.restart(sanitizePayload("restart", payload));
      case "ledger":
        return supervisor.getLedger(sanitizePayload("ledger", payload).limit);
      default:
        throw new Error(`未知的宿管动作：${action}`);
    }
  }

  return { handle };
}
