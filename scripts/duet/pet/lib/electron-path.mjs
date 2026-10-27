import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

/**
 * Resolves the Electron executable from the hoisted root node_modules. The
 * `electron` package exports the binary path when required from Node.
 */
export function resolveElectronBinary() {
  const require = createRequire(import.meta.url);

  try {
    const exported = require("electron");
    if (typeof exported === "string" && existsSync(exported)) return exported;
  } catch {
    // Fall through to the filesystem layout below.
  }

  let packageRoot;
  try {
    packageRoot = dirname(require.resolve("electron/package.json"));
  } catch {
    throw new Error("Electron is not installed. Run `pnpm install` at the repository root.");
  }

  const candidates =
    process.platform === "darwin"
      ? [join(packageRoot, "dist", "Electron.app", "Contents", "MacOS", "Electron")]
      : process.platform === "win32"
        ? [join(packageRoot, "dist", "electron.exe")]
        : [join(packageRoot, "dist", "electron")];

  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) {
    throw new Error(`Electron binary not found under ${packageRoot}. Run \`pnpm install\`.`);
  }
  return found;
}
