import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * 通过 `zcode models --json` 读取 provider registry。
 *
 * 模型列表属于 CLI 的事实，精灵不复制一份 provider 配置解析。结果在进程内缓存，
 * 避免每次打开窗口都重新启动 registry；provider 配置变化后重启精灵即可刷新。
 */
export function createModelCatalog({
  resolveCommand,
  timeoutMs = 30_000,
  ttlMs = 5 * 60_000,
} = {}) {
  let cache = null;
  let pending = null;

  async function listModels() {
    if (cache && Date.now() - cache.at < ttlMs) return cache.value;
    if (pending) return pending;

    pending = (async () => {
      const base = resolveCommand();
      const { stdout } = await execFileAsync(
        base.command,
        [...base.args, "models", "--json", "--no-color"],
        {
          cwd: base.cwd,
          env: { ...process.env },
          maxBuffer: 8 * 1024 * 1024,
          timeout: timeoutMs,
          windowsHide: true,
        },
      );
      // CLI 正常只写纯 JSON；万一有额外输出，取第一个完整对象，避免把提示行当成模型列表。
      const text = String(stdout ?? "");
      const start = text.indexOf("{");
      const end = text.lastIndexOf("}");
      if (start < 0 || end <= start) {
        throw new Error("模型列表返回格式不正确。");
      }
      const parsed = JSON.parse(text.slice(start, end + 1));
      const value = {
        current: parsed?.current ?? null,
        models: Array.isArray(parsed?.models) ? parsed.models : [],
      };
      cache = { at: Date.now(), value };
      return value;
    })();

    try {
      return await pending;
    } finally {
      pending = null;
    }
  }

  return { listModels };
}
