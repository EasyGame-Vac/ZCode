import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const MAX_MESSAGES = 200;

function normalizeMessage(value) {
  if (!value || typeof value !== "object") return null;
  const role = value.role === "user" || value.role === "assistant" ? value.role : null;
  const text = typeof value.text === "string" ? value.text : "";
  if (!role || text.length === 0) return null;
  return {
    ...(typeof value.id === "string" && value.id.length > 0 ? { id: value.id } : {}),
    ...(typeof value.at === "string" && value.at.length > 0 ? { at: value.at } : {}),
    role,
    text,
  };
}

/** 精灵 UI 的历史消息；brain 的 session 由 CLI 自己持久化，这里只保留用户看得到的对话。 */
export function createMessageStore(filePath) {
  async function read() {
    try {
      const parsed = JSON.parse(await readFile(filePath, "utf8"));
      const messages = Array.isArray(parsed?.messages)
        ? parsed.messages
        : Array.isArray(parsed)
          ? parsed
          : [];
      return messages.map(normalizeMessage).filter(Boolean).slice(-MAX_MESSAGES);
    } catch {
      return [];
    }
  }

  async function save(messages) {
    const normalized = (Array.isArray(messages) ? messages : [])
      .map(normalizeMessage)
      .filter(Boolean)
      .slice(-MAX_MESSAGES);
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, `${JSON.stringify({ messages: normalized }, null, 2)}\n`, "utf8");
  }

  async function clear() {
    await rm(filePath, { force: true });
  }

  return { read, save, clear };
}
