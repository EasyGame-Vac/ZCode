import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

function finiteOrNull(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

/** CLI session id + 最近一次 result 报告的上下文占用，用于决定何时滚动到新 session。 */
export function createSessionStore(filePath) {
  async function read() {
    try {
      const parsed = JSON.parse(await readFile(filePath, "utf8"));
      return {
        sessionId:
          typeof parsed?.sessionId === "string" && parsed.sessionId.length > 0
            ? parsed.sessionId
            : null,
        contextUsed: finiteOrNull(parsed?.contextUsed),
        contextWindow: finiteOrNull(parsed?.contextWindow),
      };
    } catch {
      return { sessionId: null, contextUsed: null, contextWindow: null };
    }
  }

  async function update(patch) {
    const current = await read();
    const next = {
      sessionId:
        typeof patch?.sessionId === "string" && patch.sessionId.length > 0
          ? patch.sessionId
          : current.sessionId,
      contextUsed:
        patch?.contextUsed === undefined ? current.contextUsed : finiteOrNull(patch.contextUsed),
      contextWindow:
        patch?.contextWindow === undefined
          ? current.contextWindow
          : finiteOrNull(patch.contextWindow),
    };
    if (!next.sessionId) return;
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(
      filePath,
      `${JSON.stringify(
        {
          sessionId: next.sessionId,
          ...(next.contextUsed === null ? {} : { contextUsed: next.contextUsed }),
          ...(next.contextWindow === null ? {} : { contextWindow: next.contextWindow }),
          updatedAt: new Date().toISOString(),
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
  }

  async function clear() {
    await rm(filePath, { force: true });
  }

  return { read, update, clear };
}
