import { execFile } from "node:child_process";
import { timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
export const MAX_BODY_BYTES = 256 * 1024;

export class HttpError extends Error {
  constructor(status, message, details) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.details = details;
  }
}

export function now() {
  return new Date().toISOString();
}

export function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

export function tailText(value, maxLines = 40) {
  return String(value ?? "")
    .trim()
    .split(/\r?\n/)
    .slice(-maxLines)
    .join("\n");
}

export async function git(cwd, args) {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    maxBuffer: 16 * 1024 * 1024,
    windowsHide: true,
  });
  return stdout;
}

export function normalizeText(value, maxLength = 200) {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

export function safeEqual(left, right) {
  const leftBuffer = Buffer.from(String(left));
  const rightBuffer = Buffer.from(String(right));
  if (leftBuffer.length !== rightBuffer.length) return false;
  return timingSafeEqual(leftBuffer, rightBuffer);
}

export async function readJsonBody(request) {
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, "request body too large");
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  const text = Buffer.concat(chunks).toString("utf8");
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("body must be a JSON object");
    }
    return parsed;
  } catch (error) {
    throw new HttpError(400, `invalid JSON body: ${errorMessage(error)}`);
  }
}

export function sendJson(response, status, payload) {
  if (response.writableEnded) return;
  const body = `${JSON.stringify(payload)}\n`;
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(body),
    "content-type": "application/json; charset=utf-8",
  });
  response.end(body);
}

export async function loadConfig({ repoRoot, configPath }) {
  const resolvedPath = resolve(configPath);
  const raw = JSON.parse(await readFile(resolvedPath, "utf8"));
  const targets = {};

  for (const [name, target] of Object.entries(raw?.targets ?? {})) {
    if (!target || typeof target !== "object") {
      throw new Error(`target ${name} must be an object`);
    }
    if (typeof target.command !== "string" || target.command.trim().length === 0) {
      throw new Error(`target ${name} has no command`);
    }
    if (target.args !== undefined && !Array.isArray(target.args)) {
      throw new Error(`target ${name} args must be an array`);
    }
    targets[name] = {
      ...target,
      args: target.args ?? [],
      cwd: resolve(repoRoot, target.cwd ?? "."),
      ready: target.ready ?? { type: "delay", ms: 20000 },
    };
  }

  if (Object.keys(targets).length === 0) {
    throw new Error("config.targets must define at least one target");
  }

  return {
    config: { ...raw, targets },
    configPath: resolvedPath,
    repoRoot,
  };
}
