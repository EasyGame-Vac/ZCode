/**
 * 滚动上下文交接：换新 session 时只把最近消息带入首轮 prompt，更早的直接丢弃。
 * 不做摘要，避免摘要本身继续占用上下文；丢失范围总是久远部分。
 */
export function buildContextHandoff({
  instruction,
  messages,
  task,
  keep = 20,
  maxChars = 16_000,
} = {}) {
  const recent = (Array.isArray(messages) ? messages : [])
    .filter(
      (message) =>
        (message?.role === "user" || message?.role === "assistant") &&
        typeof message.text === "string" &&
        message.text.trim().length > 0,
    )
    .slice(-keep);

  // 当前这条用户消息可能已经被 renderer 持久化，避免在交接里重复一次。
  while (
    recent.length > 0 &&
    recent.at(-1).role === "user" &&
    recent.at(-1).text.trim() === String(task ?? "").trim()
  ) {
    recent.pop();
  }

  const lines = [];
  let budget = Math.max(0, maxChars);
  for (let index = recent.length - 1; index >= 0; index -= 1) {
    const message = recent[index];
    const line = `${message.role === "user" ? "用户" : "K"}：${message.text.trim()}`;
    if (line.length > budget) {
      if (lines.length === 0) lines.unshift(`${line.slice(0, budget)}…`);
      break;
    }
    budget -= line.length + 1;
    lines.unshift(line);
  }

  return [
    instruction,
    "",
    "以下是之前对话的最近部分；更早的上下文已丢弃，请只依据这些最近消息继续。",
    ...(lines.length > 0 ? ["", ...lines] : []),
    "",
    `任务：${task}`,
  ].join("\n");
}
