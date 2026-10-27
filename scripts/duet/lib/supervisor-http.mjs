import {
  HttpError,
  errorMessage,
  normalizeText,
  readJsonBody,
  safeEqual,
  sendJson,
} from "./supervisor-support.mjs";

export function createRequestHandler(deps) {
  const {
    getToken,
    getStatus,
    getLedger,
    getTargetConfig,
    startTarget,
    stopTarget,
    targetStatus,
    assertNoActiveActivation,
    assertTargetIdle,
    acquireLease,
    releaseLease,
    startActivation,
    preview,
    record,
    rollback,
    log,
  } = deps;

  function authorized(request) {
    const token = getToken();
    if (token === null) return true;
    const authorization = request.headers.authorization;
    const headerToken =
      typeof authorization === "string" && authorization.startsWith("Bearer ")
        ? authorization.slice("Bearer ".length)
        : request.headers["x-duet-token"];
    if (typeof headerToken !== "string" || headerToken.length === 0) return false;
    return safeEqual(headerToken.trim(), token);
  }

  return async function handleRequest(request, response) {
    try {
      if (!authorized(request)) throw new HttpError(401, "unauthorized");
      const url = new URL(request.url ?? "/", "http://localhost");

      if (request.method === "GET" && url.pathname === "/health") {
        sendJson(response, 200, { ok: true });
        return;
      }
      if (request.method === "GET" && url.pathname === "/status") {
        sendJson(response, 200, getStatus());
        return;
      }
      if (request.method === "GET" && url.pathname === "/ledger") {
        const limit = Number(url.searchParams.get("limit") ?? 50);
        const entries = (await getLedger()?.read(limit)) ?? [];
        sendJson(response, 200, { ok: true, entries });
        return;
      }
      if (request.method !== "POST") throw new HttpError(405, "method not allowed");

      const body = await readJsonBody(request);

      if (url.pathname === "/lease") {
        sendJson(response, 200, acquireLease(body));
        return;
      }
      if (url.pathname === "/release") {
        sendJson(response, 200, releaseLease(body));
        return;
      }

      if (url.pathname === "/start" || url.pathname === "/stop" || url.pathname === "/restart") {
        assertNoActiveActivation();
        const targetName = normalizeText(body.target, 64);
        getTargetConfig(targetName);
        if (url.pathname === "/start") {
          await startTarget(targetName, { reason: "api" });
          sendJson(response, 200, { ok: true, target: targetStatus(targetName) });
          return;
        }
        assertTargetIdle(targetName, { force: body.force === true });
        if (url.pathname === "/stop") {
          await stopTarget(targetName, { reason: "api" });
          sendJson(response, 200, { ok: true, target: targetStatus(targetName) });
          return;
        }
        await stopTarget(targetName, { reason: "api-restart" });
        await startTarget(targetName, { reason: "api-restart" });
        sendJson(response, 200, { ok: true, target: targetStatus(targetName) });
        return;
      }

      if (url.pathname === "/preview") {
        sendJson(response, 200, await preview(body));
        return;
      }
      if (url.pathname === "/activate") {
        sendJson(response, 202, startActivation(body));
        return;
      }
      if (url.pathname === "/rollback") {
        assertNoActiveActivation();
        assertTargetIdle(normalizeText(body.target, 64), { force: body.force === true });
        sendJson(response, 200, await rollback(body));
        return;
      }
      if (url.pathname === "/record") {
        sendJson(response, 200, await record(body));
        return;
      }

      throw new HttpError(404, "not found");
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500;
      if (status >= 500) log("error", "request failed:", error);
      sendJson(response, status, {
        ok: false,
        error: errorMessage(error),
        ...(error instanceof HttpError && error.details ? { details: error.details } : {}),
      });
    }
  };
}
