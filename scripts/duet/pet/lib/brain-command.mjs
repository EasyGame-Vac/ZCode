import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

/** 选择精灵 brain 的 CLI 入口：优先已构建产物，否则用仓库里的 tsx 源码。 */
export function resolveBrainCommand({ repoRoot, brain = {} }) {
  const preferBuilt = brain.preferBuilt === true;
  const builtPath = brain.builtCliPath ? resolve(repoRoot, brain.builtCliPath) : null;

  if (preferBuilt && builtPath && existsSync(builtPath)) {
    return { command: "node", args: [builtPath], cwd: repoRoot };
  }

  const tsxPath = resolve(repoRoot, brain.tsxCliPath ?? "node_modules/tsx/dist/cli.mjs");
  const cliCwd = resolve(repoRoot, brain.cliCwd ?? "apps/zcode-cli/packages/cli");
  const cliEntry = brain.cliEntry ?? "src/main.ts";

  if (!existsSync(tsxPath)) {
    throw new Error(`找不到 tsx：${tsxPath}。先在仓库根目录运行 pnpm install。`);
  }
  if (!existsSync(join(cliCwd, cliEntry))) {
    throw new Error(`找不到 CLI 入口：${join(cliCwd, cliEntry)}`);
  }

  return { command: "node", args: [tsxPath, cliEntry], cwd: cliCwd };
}
