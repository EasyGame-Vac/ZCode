import { readFile } from "node:fs/promises";

export class SupervisorError extends Error {
  constructor(message, { status = 0, body = null } = {}) {
    super(message);
    this.name = "SupervisorError";
    this.status = status;
    this.body = body;
  }
}

export function createSupervisorClient({
  baseUrl = "http://127.0.0.1:47821",
  tokenPath,
  fetchImpl = globalThis.fetch,
  timeoutMs = 15000,
} = {}) {
  let cachedToken = "";

  async function readToken() {
    if (cachedToken) return cachedToken;
    try {
      const token = (await readFile(tokenPath, "utf8")).trim();
      if (token) cachedToken = token;
      return token;
    } catch {
      return "";
    }
  }

  async function request(method, path, body, { requestTimeoutMs = timeoutMs } = {}) {
    const token = await readToken();
    if (!token) {
      throw new SupervisorError("宿管没有启动，或令牌文件还不存在。先运行 supervisor。", {
        status: 0,
      });
    }

    const headers = { authorization: `Bearer ${token}` };
    const init = { headers, method, signal: AbortSignal.timeout(requestTimeoutMs) };
    if (body !== undefined) {
      headers["content-type"] = "application/json";
      init.body = JSON.stringify(body);
    }

    let response;
    try {
      response = await fetchImpl(`${baseUrl}${path}`, init);
    } catch (error) {
      throw new SupervisorError(
        `连不上宿管：${error instanceof Error ? error.message : String(error)}`,
        { status: 0 },
      );
    }

    const text = await response.text();
    let payload = null;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      payload = { raw: text };
    }

    if (!response.ok) {
      throw new SupervisorError(
        typeof payload?.error === "string" ? payload.error : `宿管返回 ${response.status}`,
        { status: response.status, body: payload },
      );
    }

    return payload;
  }

  return {
    getStatus: () => request("GET", "/status"),
    getHealth: () => request("GET", "/health", undefined, { requestTimeoutMs: 3000 }),
    getLedger: (limit = 50) => request("GET", `/ledger?limit=${encodeURIComponent(limit)}`),
    start: (body = {}) => request("POST", "/start", body),
    stop: (body = {}) => request("POST", "/stop", body),
    restart: (body = {}) => request("POST", "/restart", body),
    preview: (body = {}) => request("POST", "/preview", body),
    activate: (body = {}) => request("POST", "/activate", body, { requestTimeoutMs: 30000 }),
    rollback: (body = {}) => request("POST", "/rollback", body, { requestTimeoutMs: 60000 }),
    record: (body = {}) => request("POST", "/record", body),
    lease: (body = {}) => request("POST", "/lease", body, { requestTimeoutMs: 5000 }),
    release: (body = {}) => request("POST", "/release", body, { requestTimeoutMs: 5000 }),
    readToken,
  };
}
