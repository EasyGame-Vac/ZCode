import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { stopProcessTree } from "../lib/process.mjs";
import { resolveElectronBinary } from "./lib/electron-path.mjs";

const MAIN_PATH = resolve(import.meta.dirname, "main.mjs");
const REPO_ROOT = resolve(import.meta.dirname, "../../..");

const USAGE = `Usage:
  node scripts/duet/pet/start.mjs [--smoke] [--remote-debugging-port <port>]

  --smoke                  Create the window, verify the UI loaded, then exit.
  --remote-debugging-port  Forward Chromium's remote debugging port.`;

async function main() {
  let values;
  try {
    ({ values } = parseArgs({
      allowPositionals: false,
      options: {
        help: { short: "h", type: "boolean" },
        "remote-debugging-port": { type: "string" },
        smoke: { type: "boolean" },
      },
      strict: true,
    }));
  } catch (error) {
    process.stderr.write(`${USAGE}\n${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }

  if (values.help) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }

  let electronPath;
  try {
    electronPath = resolveElectronBinary();
  } catch (error) {
    process.stderr.write(`[duet-pet] ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }

  const args = [];
  if (values["remote-debugging-port"]) {
    args.push(`--remote-debugging-port=${values["remote-debugging-port"]}`);
  }
  args.push(MAIN_PATH);

  const child = spawn(electronPath, args, {
    cwd: REPO_ROOT,
    env: { ...process.env, DUET_PET_SMOKE: values.smoke ? "1" : "0" },
    stdio: "inherit",
    windowsHide: false,
  });

  let finished = false;
  const timeout = values.smoke
    ? setTimeout(() => {
        if (finished) return;
        console.error("[duet-pet] PET_SMOKE_TIMEOUT");
        void stopProcessTree(child, { timeoutMs: 3000 });
      }, 30000)
    : null;

  const forwardSignal = () => {
    void stopProcessTree(child, { timeoutMs: 3000 });
  };
  process.on("SIGINT", forwardSignal);
  process.on("SIGTERM", forwardSignal);

  child.once("error", (error) => {
    finished = true;
    if (timeout) clearTimeout(timeout);
    process.stderr.write(`[duet-pet] failed to start Electron: ${error.message}\n`);
    process.exitCode = 1;
  });

  child.once("close", (code, signal) => {
    finished = true;
    if (timeout) clearTimeout(timeout);
    process.exitCode = typeof code === "number" ? code : signal ? 1 : 0;
  });

  return null;
}

main()
  .then((code) => {
    if (typeof code === "number") process.exitCode = code;
  })
  .catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  });
