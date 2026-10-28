import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { formatBrainActivity } from "../lib/brain-activity.mjs";
import { buildContextHandoff } from "../lib/context-handoff.mjs";
import { createEventStream } from "../lib/event-parser.mjs";
import { readGitHead } from "../lib/git-head.mjs";
import { shouldShowTaskPreview } from "../lib/task-preview.mjs";
import { stopProcessTree } from "../../lib/process.mjs";

const K_INSTRUCTION =
  "你是 K，ZCode 的桌面小人。先阅读 scripts/duet/k-prompt.md，并严格遵守其中的约束。";
const K_LEASE_TTL_MS = 60_000;
const K_LEASE_HEARTBEAT_MS = 20_000;
// 上下文占用超过 75% 时滚动到新 session；只带最近 20 条可见消息，更早的直接丢弃。
const CONTEXT_ROTATE_AT = 0.75;
const CONTEXT_KEEP_MESSAGES = 20;
const CONTEXT_HANDOFF_MAX_CHARS = 16_000;

function tail(value, lines = 40) {
  return String(value ?? "")
    .trim()
    .split(/\r?\n/)
    .slice(-lines)
    .join("\n");
}

/**
 * 负责一轮 brain 的完整生命周期：session 选择/滚动、CLI 进程、流式事件、
 * K lease、preview 和退出。main 只调用 send/cancel，不再持有 brain 细节。
 */
export function createBrainRunner({
  repoRoot,
  getBrainConfig,
  getModel,
  resolveCommand,
  supervisor,
  messages,
  sessions,
  activityConsole,
  emit,
  warn,
}) {
  let brain = null;
  let starting = false;

  async function acquireLease(reason) {
    const leaseId = `k-${process.pid}-${randomUUID()}`;
    const body = { target: "k", leaseId, holder: "pet", reason, ttlMs: K_LEASE_TTL_MS };
    const lease = { leaseId: null, body, timer: null, released: false };
    const heartbeat = () => {
      if (lease.released) return;
      void supervisor
        .lease(body)
        .then(() => {
          lease.leaseId = leaseId;
        })
        .catch(() => {});
    };

    try {
      await supervisor.lease(body);
      lease.leaseId = leaseId;
    } catch (error) {
      if (error && typeof error === "object" && error.status === 0) {
        // Supervisor is offline; retry while the task runs so a later start
        // still registers the lease before any update can target K.
        lease.timer = setInterval(heartbeat, K_LEASE_HEARTBEAT_MS);
        lease.timer.unref?.();
        return lease;
      }
      if (error && typeof error === "object" && error.status === 409) {
        throw new Error("小人正在更新或有任务在跑，暂时不能开始新任务。");
      }
      throw new Error(
        `无法登记小人任务状态：${error instanceof Error ? error.message : String(error)}`,
      );
    }

    lease.timer = setInterval(heartbeat, K_LEASE_HEARTBEAT_MS);
    lease.timer.unref?.();
    return lease;
  }

  function releaseLease(lease) {
    if (!lease || lease.released) return;
    lease.released = true;
    if (lease.timer) clearInterval(lease.timer);
    if (lease.leaseId) {
      void supervisor
        .release({ target: "k", leaseId: lease.leaseId, holder: "pet" })
        .catch(() => {});
    }
  }

  async function finishTask(result, startHead) {
    try {
      // 只有本轮真的产生了新 commit 才比较 preview；否则会把历史提交或用户已有的
      // 未提交改动当成这次任务的结果，随便问一句也弹出几十个文件。
      const endHead = startHead ? await readGitHead(repoRoot) : null;
      if (!startHead || !endHead || endHead === startHead) {
        emit("task-complete", { preview: null, result, noChanges: true });
        return;
      }

      const preview = await supervisor.preview({ target: "w", base: startHead });
      if (
        !shouldShowTaskPreview({
          startHead,
          endHead,
          changes: preview?.changes,
          dirty: preview?.dirty,
        })
      ) {
        emit("task-complete", { preview: null, result, noChanges: true });
        return;
      }
      emit("task-complete", { preview, result });
    } catch (error) {
      emit("task-complete", {
        preview: null,
        result,
        previewError: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async function send(text) {
    if (brain || starting) throw new Error("K 正在处理上一条消息，先等它完成或点停止。");
    const trimmed = String(text ?? "").trim();
    if (trimmed.length === 0) throw new Error("消息为空。");
    const brainConfig = getBrainConfig();
    const maxPromptChars = brainConfig.maxPromptChars ?? 8000;
    if (trimmed.length > maxPromptChars) {
      throw new Error(`消息太长，最多 ${maxPromptChars} 个字符。`);
    }

    starting = true;
    let lease = null;
    let child = null;
    let current = null;
    try {
      const meta = await sessions.read();
      const contextRatio =
        meta.contextUsed !== null && meta.contextWindow ? meta.contextUsed / meta.contextWindow : 0;
      const rotate = Boolean(meta.sessionId) && contextRatio >= CONTEXT_ROTATE_AT;
      const sessionId = rotate ? null : meta.sessionId;
      const prompt = rotate
        ? buildContextHandoff({
            instruction: K_INSTRUCTION,
            messages: await messages.read(),
            task: trimmed,
            keep: CONTEXT_KEEP_MESSAGES,
            maxChars: CONTEXT_HANDOFF_MAX_CHARS,
          })
        : sessionId
          ? trimmed
          : `${K_INSTRUCTION}\n\n任务：${trimmed}`;

      const base = resolveCommand();
      const args = [
        ...base.args,
        "-p",
        prompt,
        "--cwd",
        repoRoot,
        "--output-format",
        "stream-json",
        "--mode",
        brainConfig.cliMode ?? "yolo",
        "--no-color",
      ];
      const model = getModel();
      if (model) args.push("--model", model);
      if (sessionId) args.push("--resume", sessionId);

      const startHead = await readGitHead(repoRoot);
      lease = await acquireLease("brain turn");
      child = spawn(base.command, args, {
        cwd: base.cwd,
        env: { ...process.env },
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });

      current = { cancelled: false, child, lease, startHead };
      brain = current;
      starting = false;
      let result = null;
      let stderr = "";
      if (rotate) {
        emit("context-rotated", { keep: CONTEXT_KEEP_MESSAGES });
        activityConsole.append(`已丢弃较早上下文，保留最近 ${CONTEXT_KEEP_MESSAGES} 条消息。`);
      }
      activityConsole.append("—— 新一轮任务 ——");
      emit("brain-start", { sessionId });

      const stream = createEventStream({
        onEvent: (event) => {
          if (event.kind === "result") {
            result = event;
            if (event.sessionId) {
              void sessions.update({
                sessionId: event.sessionId,
                ...(Number.isFinite(event.projection?.contextUsed)
                  ? { contextUsed: event.projection.contextUsed }
                  : {}),
                ...(Number.isFinite(event.projection?.contextWindow)
                  ? { contextWindow: event.projection.contextWindow }
                  : {}),
              });
            }
          }
          if (event.kind === "session" && event.sessionId) {
            // 滚动到新 session 时清掉旧 session 的上下文占用，避免下一轮再次误判。
            void sessions.update({
              sessionId: event.sessionId,
              ...(rotate ? { contextUsed: null, contextWindow: null } : {}),
            });
          }
          const activity = formatBrainActivity(event);
          if (activity) activityConsole.append(activity);
          emit("brain-event", event);
        },
        onMalformed: (line) => {
          stderr += `${line}\n`;
          if (stderr.length > 16000) stderr = stderr.slice(-16000);
        },
      });

      child.stdout?.on("data", (chunk) => stream.push(chunk));
      child.stderr?.on("data", (chunk) => {
        stderr += String(chunk);
        if (stderr.length > 16000) stderr = stderr.slice(-16000);
      });

      child.once("close", (code, signal) => {
        stream.flush();
        if (brain === current) brain = null;
        releaseLease(current.lease);
        if (current.cancelled) {
          emit("brain-cancelled", {});
          return;
        }
        const exitCode = code ?? (signal ? 1 : 0);
        activityConsole.append(exitCode === 0 ? "brain finished" : "brain exited with error");
        if (exitCode !== 0) {
          // 把 brain 的失败尾部落到 k.log，控制台的“原始日志”才有可排查的内容。
          warn("brain failed", `code=${exitCode}`, tail(stderr, 12));
        }
        emit("brain-exit", {
          code: exitCode,
          signal,
          stderrTail: tail(stderr, 40),
        });
        if (result) void finishTask(result, current.startHead);
      });

      child.once("error", (error) => {
        if (brain === current) brain = null;
        releaseLease(current.lease);
        warn("brain spawn failed", error.message);
        emit("brain-exit", { code: 1, signal: null, stderrTail: error.message });
      });

      return { ok: true, sessionId };
    } catch (error) {
      if (current) current.cancelled = true;
      if (brain === current) brain = null;
      if (child) void stopProcessTree(child, { timeoutMs: 3000 });
      releaseLease(lease);
      starting = false;
      throw error;
    }
  }

  async function cancel() {
    if (!brain) return { ok: false };
    const current = brain;
    current.cancelled = true;
    brain = null;
    releaseLease(current.lease);
    await stopProcessTree(current.child, { timeoutMs: 5000 });
    return { ok: true };
  }

  function dispose() {
    if (!brain) return;
    const current = brain;
    current.cancelled = true;
    brain = null;
    releaseLease(current.lease);
    void stopProcessTree(current.child, { timeoutMs: 3000 });
  }

  return {
    send,
    cancel,
    dispose,
    get busy() {
      return Boolean(brain || starting);
    },
  };
}
