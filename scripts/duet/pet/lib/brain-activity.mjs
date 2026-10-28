/** 把 brain 的 tool/activity/error 事件转成控制台一行；其他事件返回 null。 */
export function formatBrainActivity(event) {
  if (!event || typeof event.kind !== "string") return null;
  if (event.kind === "tool") {
    const phase = event.phase ? ` (${event.phase})` : "";
    const description = event.description ? ` — ${event.description}` : "";
    return `tool: ${event.toolName ?? event.toolCallId ?? "tool"}${phase}${description}`;
  }
  if (event.kind === "activity") return event.text;
  if (event.kind === "error") return `error: ${event.message}`;
  return null;
}
