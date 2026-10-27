/**
 * Converts one stream-json line into a UI event. Unknown protocol types are
 * ignored on purpose: the CLI documents JSON fields as build-variable, and the
 * pet must keep working when new event types appear.
 */
export function classifyEvent(raw) {
  if (!raw || typeof raw !== "object") return null;
  const type = typeof raw.type === "string" ? raw.type : "";
  const payload = raw.payload && typeof raw.payload === "object" ? raw.payload : {};

  if (type === "result") {
    return {
      kind: "result",
      sessionId: typeof raw.sessionId === "string" ? raw.sessionId : null,
      text: typeof raw.response === "string" ? raw.response : "",
      usage: raw.usage ?? null,
      projection: raw.projection ?? null,
    };
  }

  if (type === "session.created" || type === "session.resumed") {
    return {
      kind: "session",
      sessionId:
        typeof raw.sessionId === "string"
          ? raw.sessionId
          : typeof payload.sessionId === "string"
            ? payload.sessionId
            : null,
    };
  }

  if (type === "part.delta" && typeof payload.delta === "string") {
    if (payload.field === "text") return { kind: "assistant-delta", text: payload.delta };
    if (payload.field === "reasoning") return { kind: "reasoning-delta", text: payload.delta };
    return null;
  }

  if (type === "model.streaming") {
    const kind = typeof payload.kind === "string" ? payload.kind : "";
    if (kind === "tool_call") {
      return {
        kind: "tool",
        phase: "call",
        toolCallId: typeof payload.toolCallId === "string" ? payload.toolCallId : null,
        toolName: typeof payload.toolName === "string" ? payload.toolName : "tool",
      };
    }
    return null;
  }

  if (type === "tool.updated") {
    return {
      kind: "tool",
      phase: typeof payload.kind === "string" ? payload.kind : "update",
      toolCallId: typeof payload.toolCallId === "string" ? payload.toolCallId : null,
      toolName:
        typeof payload.toolName === "string"
          ? payload.toolName
          : typeof payload.toolCallId === "string"
            ? payload.toolCallId
            : "tool",
      description: typeof payload.description === "string" ? payload.description : null,
    };
  }

  if (type === "turn.failed") {
    return {
      kind: "error",
      message: typeof payload.error?.message === "string" ? payload.error.message : "turn failed",
    };
  }

  if (type === "permission.requested") {
    return {
      kind: "activity",
      text: `需要权限：${typeof payload.toolName === "string" ? payload.toolName : "tool"}`,
    };
  }

  if (type === "userInput.requested") {
    return {
      kind: "activity",
      text: `需要输入：${typeof payload.prompt === "string" ? payload.prompt : ""}`,
    };
  }

  return null;
}

export function parseNdjsonLine(line) {
  try {
    const parsed = JSON.parse(line);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Reassembles NDJSON lines from arbitrary stream chunks. A chunk can end in the
 * middle of a line; the remainder stays buffered until the next push/flush.
 */
export function createLineParser(onLine) {
  let buffer = "";

  return {
    push(chunk) {
      buffer += String(chunk);
      let index = buffer.indexOf("\n");
      while (index >= 0) {
        const line = buffer.slice(0, index).replace(/\r$/, "");
        buffer = buffer.slice(index + 1);
        if (line.trim().length > 0) onLine(line);
        index = buffer.indexOf("\n");
      }
    },
    flush() {
      const line = buffer.replace(/\r$/, "");
      buffer = "";
      if (line.trim().length > 0) onLine(line);
    },
  };
}

export function createEventStream({ onEvent, onMalformed } = {}) {
  const parser = createLineParser((line) => {
    const raw = parseNdjsonLine(line);
    if (!raw) {
      onMalformed?.(line);
      return;
    }
    const event = classifyEvent(raw);
    if (event) onEvent?.(event);
  });

  return {
    push(chunk) {
      parser.push(chunk);
    },
    flush() {
      parser.flush();
    },
  };
}
