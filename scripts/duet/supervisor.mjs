import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { runSupervisorCli } from "./lib/supervisor-cli.mjs";

export { createSupervisor } from "./lib/supervisor-core.mjs";

const isEntrypoint =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isEntrypoint) {
  runSupervisorCli().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  });
}
