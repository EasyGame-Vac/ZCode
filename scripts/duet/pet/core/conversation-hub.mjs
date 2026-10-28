/**
 * 主进程持有的对话快照。主窗口是 UI 状态的生产者，阅读窗口只订阅，
 * 避免每个窗口各自维护一份 messages 导致分叉。
 */
export function createConversationHub({ messages }) {
  let state = {
    messages: [],
    stream: { streaming: "", busy: false, mode: "offline", status: "" },
    synced: false,
  };
  const listeners = new Set();

  function publish(payload) {
    for (const listener of listeners) listener(payload);
  }

  function setMessages(nextMessages) {
    state = {
      ...state,
      messages: Array.isArray(nextMessages) ? nextMessages : [],
      synced: true,
    };
    publish({ type: "messages", messages: state.messages });
  }

  function setStream(nextStream) {
    const source = nextStream && typeof nextStream === "object" ? nextStream : {};
    state = {
      ...state,
      stream: {
        streaming: typeof source.streaming === "string" ? source.streaming : "",
        busy: source.busy === true,
        mode: typeof source.mode === "string" ? source.mode : "offline",
        status: typeof source.status === "string" ? source.status : "",
      },
    };
    publish({ type: "stream", stream: state.stream });
  }

  async function snapshot() {
    return {
      messages: state.synced ? state.messages : await messages.read(),
      stream: state.stream,
    };
  }

  function subscribe(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  return { setMessages, setStream, snapshot, subscribe };
}
