/**
 * 对话消息的最小 DOM 渲染器，主窗口和独立阅读窗口共用。
 * 只有消息列表真的变化时才重建节点；流式文本原地更新，避免每个 delta 重排整页。
 */
export function createConversationView({ container }) {
  let messageSignature = "";
  let streamingEl = null;

  function signature(messages) {
    const last = messages.at(-1);
    return `${messages.length}:${last?.id ?? ""}:${last?.text?.length ?? 0}`;
  }

  function renderMessage(message) {
    const element = document.createElement("div");
    element.className = `message ${message.role}`;
    element.textContent = message.text;
    return element;
  }

  function render({ messages = [], streaming = "", busy = false } = {}) {
    const nextSignature = signature(messages);
    if (nextSignature !== messageSignature) {
      messageSignature = nextSignature;
      container.replaceChildren();
      for (const message of messages) container.append(renderMessage(message));
      streamingEl = null;
    }

    if (streaming && busy) {
      if (!streamingEl) {
        streamingEl = document.createElement("div");
        streamingEl.className = "message assistant streaming";
        container.append(streamingEl);
      }
      if (streamingEl.textContent !== streaming) streamingEl.textContent = streaming;
    } else if (streamingEl) {
      streamingEl.remove();
      streamingEl = null;
    }
  }

  function reset() {
    messageSignature = "";
    streamingEl = null;
  }

  return { render, reset };
}
