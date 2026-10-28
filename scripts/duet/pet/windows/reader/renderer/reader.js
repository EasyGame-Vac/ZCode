import { createConversationView } from "../../../shared/renderer/conversation-view.mjs";
import { createStickyScroll } from "../../../shared/renderer/sticky-scroll.mjs";

const api = window.petReader;
const body = document.body;
const messagesEl = document.querySelector("#messages");
const scrollButton = document.querySelector("#scroll-bottom");
const statusText = document.querySelector("#status-text");
const focusPet = document.querySelector("#focus-pet");

const view = createConversationView({ container: messagesEl });
const sticky = createStickyScroll({ container: messagesEl, button: scrollButton });

let messages = [];
let stream = { streaming: "", busy: false, mode: "offline", status: "" };

function modeLabel(mode) {
  switch (mode) {
    case "idle":
      return "窗口版运行中";
    case "thinking":
      return "思考中…";
    case "working":
      return "正在处理…";
    case "verifying":
      return "处理中…";
    case "waiting":
      return "等你确认";
    case "error":
      return "出错了";
    default:
      return "未连接";
  }
}

function render() {
  const previousScrollTop = messagesEl.scrollTop;
  view.render({
    messages,
    streaming: stream.streaming,
    busy: stream.busy,
  });
  sticky.afterRender(previousScrollTop);
  body.dataset.state = stream.mode;
  statusText.textContent = stream.status || modeLabel(stream.mode);
}

function applyMessages(nextMessages) {
  messages = Array.isArray(nextMessages) ? nextMessages : [];
  render();
}

function applyStream(nextStream) {
  const source = nextStream && typeof nextStream === "object" ? nextStream : {};
  stream = {
    streaming: typeof source.streaming === "string" ? source.streaming : "",
    busy: source.busy === true,
    mode: typeof source.mode === "string" ? source.mode : "offline",
    status: typeof source.status === "string" ? source.status : "",
  };
  render();
}

api.onInit((state) => {
  applyMessages(state?.messages);
  applyStream(state?.stream);
});

api.onEvent((event) => {
  if (!event || typeof event.type !== "string") return;
  if (event.type === "messages") applyMessages(event.messages);
  if (event.type === "stream") applyStream(event.stream);
});

focusPet.addEventListener("click", () => {
  void api.focusPet();
});
