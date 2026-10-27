import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";

export function createLedger(filePath, { logger = console } = {}) {
  let queue = Promise.resolve();

  const append = (event) => {
    const line = `${JSON.stringify({ ts: new Date().toISOString(), ...event })}\n`;
    queue = queue
      .catch(() => {})
      .then(async () => {
        await mkdir(dirname(filePath), { recursive: true });
        await appendFile(filePath, line, "utf8");
      })
      .catch((error) => {
        logger.error?.("[duet] ledger write failed:", error);
      });
    return queue;
  };

  const read = async (limit = 50) => {
    const safeLimit = Number.isFinite(limit) ? Math.min(Math.max(Math.trunc(limit), 1), 500) : 50;
    let content = "";
    try {
      content = await readFile(filePath, "utf8");
    } catch {
      return [];
    }

    return content
      .split(/\r?\n/)
      .filter((line) => line.trim().length > 0)
      .slice(-safeLimit)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return { raw: line, parseError: true };
        }
      });
  };

  return { append, read, filePath };
}
