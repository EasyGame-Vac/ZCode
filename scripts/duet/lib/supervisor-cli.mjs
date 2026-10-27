import { relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import { DEFAULT_REPO_ROOT } from "../verify.mjs";
import { createSupervisor } from "./supervisor-core.mjs";
import { errorMessage } from "./supervisor-support.mjs";

const USAGE = `Usage:
  node scripts/duet/supervisor.mjs [--cwd <repo>] [--config <path>]
                                   [--port <number>] [--host <host>]
                                   [--no-token] [--no-start] [--accept-gate-change]

The supervisor owns W. Start the pet separately with:
  node scripts/duet/pet/start.mjs`;

async function main() {
  let values;
  try {
    ({ values } = parseArgs({
      allowPositionals: false,
      options: {
        "accept-gate-change": { type: "boolean" },
        config: { type: "string" },
        cwd: { type: "string" },
        help: { short: "h", type: "boolean" },
        host: { type: "string" },
        "no-start": { type: "boolean" },
        "no-token": { type: "boolean" },
        port: { type: "string" },
      },
      strict: true,
    }));
  } catch (error) {
    process.stderr.write(`${USAGE}\n${errorMessage(error)}\n`);
    return 2;
  }

  if (values.help) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }

  const repoRoot = resolve(values.cwd ?? DEFAULT_REPO_ROOT);
  const port = values.port === undefined ? undefined : Number(values.port);
  if (port !== undefined && !Number.isFinite(port)) {
    process.stderr.write(`Invalid --port: ${values.port}\n`);
    return 2;
  }

  const supervisor = createSupervisor({
    acceptGateChange: values["accept-gate-change"] === true,
    autoStart: values["no-start"] === true ? false : undefined,
    configPath: values.config === undefined ? undefined : resolve(values.config),
    host: values.host,
    port,
    repoRoot,
    token: values["no-token"] === true ? null : undefined,
  });

  try {
    const info = await supervisor.start();
    process.stdout.write(
      [
        `[duet] supervisor listening on http://${info.host}:${info.port}`,
        `[duet] state: ${relative(repoRoot, info.stateDir).replaceAll("\\", "/")}`,
        info.tokenPath
          ? `[duet] token: ${relative(repoRoot, info.tokenPath).replaceAll("\\", "/")}`
          : "[duet] auth disabled",
        "[duet] K prompt: scripts/duet/k-prompt.md",
        "[duet] W prompt: scripts/duet/w-prompt.md",
        "[duet] W and K start automatically; the pet window should appear.",
        "",
      ].join("\n"),
    );
  } catch (error) {
    process.stderr.write(`[duet] supervisor failed: ${errorMessage(error)}\n`);
    if (error?.details) process.stderr.write(`${JSON.stringify(error.details, null, 2)}\n`);
    return 1;
  }

  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    process.stdout.write(`[duet] shutting down (${signal})\n`);
    try {
      await supervisor.stop();
    } finally {
      process.exit(0);
    }
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  return null;
}

export async function runSupervisorCli() {
  const code = await main();
  if (typeof code === "number") process.exitCode = code;
}
