let messageSequence = 0;

function nextId(prefix) {
  messageSequence += 1;
  return `${prefix}-${Date.now().toString(36)}-${messageSequence.toString(36)}`;
}

function trimList(list, limit) {
  return list.length > limit ? list.slice(list.length - limit) : list;
}

function modeFromSupervisor(status) {
  if (!status) return "offline";
  const activation = status.activation;
  if (activation) {
    if (
      ["queued", "verifying", "restarting", "rolling-back", "restoring"].includes(activation.status)
    ) {
      return "verifying";
    }
    if (activation.status === "failed") return "error";
    if (activation.status === "succeeded") return "waiting";
  }

  const windowStatus = status.targets?.w?.status;
  if (windowStatus === "running") return "idle";
  if (windowStatus === "starting" || windowStatus === "stopping") return "verifying";
  if (windowStatus === "failed") return "error";
  return "offline";
}

function withMessage(state, role, text, extra = {}) {
  const message = {
    id: nextId(role),
    role,
    text,
    at: new Date().toISOString(),
    ...extra,
  };
  return { ...state, messages: trimList([...state.messages, message], 100) };
}

function withActivity(state, text, extra = {}) {
  const activity = {
    id: nextId("activity"),
    text,
    at: new Date().toISOString(),
    ...extra,
  };
  return { ...state, activity: trimList([...state.activity, activity], 200) };
}

export function createInitialPetState() {
  return {
    mode: "offline",
    messages: [],
    activity: [],
    streaming: "",
    sessionId: null,
    supervisor: null,
    activation: null,
    preview: null,
    lastWStatus: null,
    crashNotified: false,
    busy: false,
    sawResult: false,
    acknowledgedActivationId: null,
    error: null,
  };
}

export function reducePetState(state, action) {
  if (!action || typeof action.type !== "string") return state;

  switch (action.type) {
    case "init": {
      const supervisor = action.status ?? null;
      const next = {
        ...state,
        supervisor,
        sessionId: action.sessionId ?? state.sessionId,
        activation: supervisor?.activation ?? state.activation,
        lastWStatus: supervisor?.targets?.w?.status ?? null,
      };
      return { ...next, mode: modeFromSupervisor(supervisor) };
    }

    case "user-message": {
      const text = typeof action.text === "string" ? action.text.trim() : "";
      if (!text) return state;
      return {
        ...withMessage(state, "user", text),
        mode: "thinking",
        streaming: "",
        sawResult: false,
        preview: null,
        error: null,
      };
    }

    case "brain-start":
      return {
        ...state,
        busy: true,
        mode: "thinking",
        streaming: "",
        sawResult: false,
        error: null,
      };

    case "assistant-delta": {
      if (typeof action.text !== "string" || action.text.length === 0) return state;
      return {
        ...state,
        streaming: state.streaming + action.text,
        mode: state.mode === "working" ? "working" : "thinking",
      };
    }

    case "reasoning-delta":
      return state;

    case "tool": {
      const label = action.description || action.toolName || "tool";
      const phase = action.phase ? ` (${action.phase})` : "";
      return {
        ...withActivity(state, `${label}${phase}`, {
          toolName: action.toolName,
          toolCallId: action.toolCallId,
          phase: action.phase,
        }),
        mode: "working",
      };
    }

    case "activity":
      return action.text ? withActivity(state, action.text) : state;

    case "session":
      return action.sessionId ? { ...state, sessionId: action.sessionId } : state;

    case "result": {
      const text = typeof action.text === "string" ? action.text.trim() : "";
      const finalText = text.length > 0 ? text : state.streaming.trim();
      let next = { ...state, busy: false, sawResult: true, streaming: "", mode: "waiting" };
      if (finalText.length > 0) next = withMessage(next, "assistant", finalText);
      if (action.sessionId) next = { ...next, sessionId: action.sessionId };
      return next;
    }

    case "brain-exit": {
      const code = typeof action.code === "number" ? action.code : 0;
      if (code === 0) {
        if (state.sawResult) return { ...state, busy: false };
        const streamed = state.streaming.trim();
        let next = { ...state, busy: false, streaming: "", mode: "waiting" };
        if (streamed.length > 0) {
          next = withMessage(next, "assistant", streamed);
        } else {
          next = withMessage(next, "assistant", "完成，但没有返回文本。");
        }
        return next;
      }

      const tail = typeof action.stderrTail === "string" ? action.stderrTail.trim() : "";
      const detail = tail.length > 0 ? tail : `退出码 ${code}`;
      let next = withMessage(state, "assistant", `小人运行失败：\n${detail}`);
      next = withActivity(next, "brain exited with an error", { code });
      return { ...next, busy: false, mode: "error", streaming: "", error: detail };
    }

    case "assistant-error": {
      const text = typeof action.text === "string" ? action.text.trim() : "出错了";
      return { ...withMessage(state, "assistant", text), busy: false, mode: "error", error: text };
    }

    case "assistant-message": {
      const text = typeof action.text === "string" ? action.text.trim() : "";
      return text ? withMessage(state, "assistant", text) : state;
    }

    case "cancelled":
      return {
        ...withMessage(state, "assistant", "已停止。"),
        busy: false,
        streaming: "",
        mode: modeFromSupervisor(state.supervisor),
      };

    case "supervisor-status": {
      const supervisor = action.status ?? null;
      const nextWStatus = supervisor?.targets?.w?.status ?? null;
      const activation = supervisor?.activation ?? null;
      const previousActivation = state.activation;
      const sameActivation = Boolean(activation && previousActivation?.id === activation.id);
      const activationJustSucceeded =
        activation?.status === "succeeded" &&
        !(sameActivation && previousActivation?.status === "succeeded");

      let next = {
        ...state,
        supervisor,
        activation,
        lastWStatus: nextWStatus,
      };

      // A succeeded activation is a terminal fact. Once announced, later polls
      // must not clear a preview produced by the user's next task.
      if (activation?.status === "succeeded" && activation.id === state.acknowledgedActivationId) {
        const cleanedSupervisor = supervisor ? { ...supervisor, activation: null } : null;
        const idleMode =
          state.preview && !state.busy ? "waiting" : modeFromSupervisor(cleanedSupervisor);
        return {
          ...next,
          activation: null,
          supervisor: cleanedSupervisor,
          mode: state.busy ? state.mode : idleMode,
        };
      }

      if (nextWStatus === "running") next = { ...next, crashNotified: false };

      const windowCrashed =
        state.lastWStatus === "running" &&
        (nextWStatus === "failed" || nextWStatus === "stopped") &&
        !activation &&
        !state.crashNotified &&
        !state.busy;

      if (windowCrashed) {
        next = withMessage(next, "assistant", "窗口版好像挂了。你可以点回滚，或者让我看看日志。");
        next = withActivity(next, "window target stopped unexpectedly");
        return {
          ...next,
          crashNotified: true,
          mode: "error",
          error: "窗口版好像挂了",
        };
      }

      if (
        activation &&
        ["queued", "verifying", "restarting", "rolling-back", "restoring"].includes(
          activation.status,
        )
      ) {
        return { ...next, mode: "verifying" };
      }
      if (activation?.status === "failed") {
        return {
          ...next,
          mode: "error",
          error: activation.error ?? "activation failed",
        };
      }
      if (activation?.status === "succeeded") {
        if (state.busy) return next;
        let final = { ...next, mode: "waiting", preview: null };
        if (activationJustSucceeded) {
          final = { ...final, acknowledgedActivationId: activation.id };
          if (activation.commit) {
            final = withMessage(
              final,
              "assistant",
              `窗口版已更新到 ${activation.commit.slice(0, 8)}，正在运行。`,
            );
          }
        }
        return final;
      }

      if (state.busy) return next;
      return { ...next, mode: modeFromSupervisor(supervisor) };
    }

    case "preview":
      return { ...state, preview: action.preview ?? null };

    case "activation-requested":
      return { ...state, mode: "verifying", error: null };

    case "reset":
      return {
        ...createInitialPetState(),
        supervisor: state.supervisor,
        lastWStatus: state.lastWStatus,
        mode: modeFromSupervisor(state.supervisor),
      };

    default:
      return state;
  }
}
