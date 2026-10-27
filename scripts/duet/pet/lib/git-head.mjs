import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** 只读取 HEAD；失败时返回 null，让 preview 退回 supervisor 的 lastGoodCommit。 */
export async function readGitHead(cwd) {
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], {
      cwd,
      timeout: 5_000,
      windowsHide: true,
    });
    const head = String(stdout ?? "").trim();
    return head.length > 0 ? head : null;
  } catch {
    return null;
  }
}
