import {
  createMemoryDiagnosticsRegistry,
  createMemorySampleWriteGate,
  formatMemorySampleLine,
  MEMORY_SAMPLE_INTERVAL_MS,
  type MemoryDiagnosticsRegistry,
  type MemorySample,
  type RendererHeapSample,
} from "@zcode/shared";
import { isLoggerLevelEnabled, logger, logMemoryDiagnostics } from "@/logger.js";

/**
 * renderer 内存诊断计数器注册表。
 * 各缓存/store 模块在模块加载时注册纯读取 provider；`startMemoryDiagnosticsLogger` 每 60 秒
 * 采样一次，经门控后通过 `logger.logMemoryDiagnostics` 写桌面主日志。
 */
export const uiMemoryDiagnosticsRegistry: MemoryDiagnosticsRegistry =
  createMemoryDiagnosticsRegistry();

interface RendererHeapSnapshot {
  usedJSHeapSize?: number;
  totalJSHeapSize?: number;
}

/** Chromium 专有的 `performance.memory`；Web 端浏览器缺失时返回 undefined。 */
export function readRendererHeapSnapshot(): RendererHeapSnapshot | undefined {
  if (typeof performance === "undefined") {
    return undefined;
  }
  const memory = (performance as Performance & { memory?: RendererHeapSnapshot }).memory;
  if (!memory || typeof memory.usedJSHeapSize !== "number") {
    return undefined;
  }
  return memory;
}

interface StartMemoryDiagnosticsLoggerOptions {
  intervalMs?: number;
  now?: () => number;
  readHeap?: () => RendererHeapSnapshot | undefined;
  write?: (line: string) => void;
  registry?: MemoryDiagnosticsRegistry;
  /**
   * 资源遥测出口：同一次读数除写本地
   * 诊断日志外，还经 preload 桥送 main 的 `renderer_main` 角色事件。由 App 注入
   * `platform.reportRendererHeapSample`；Web 端与手机远控没有桥，不注入即 no-op。
   */
  reportHeapSample?: (sample: RendererHeapSample) => void;
}

export interface MemoryDiagnosticsLoggerHandle {
  sampleNow(): boolean;
  stop(): void;
}

export function startMemoryDiagnosticsLogger(
  options: StartMemoryDiagnosticsLoggerOptions = {},
): MemoryDiagnosticsLoggerHandle {
  const now = options.now ?? (() => Date.now());
  const readHeap = options.readHeap ?? readRendererHeapSnapshot;
  const write = options.write ?? logMemoryDiagnostics;
  const registry = options.registry ?? uiMemoryDiagnosticsRegistry;
  const reportHeapSample = options.reportHeapSample;
  const gate = createMemorySampleWriteGate();

  const sampleNow = (): boolean => {
    try {
      const heap = readHeap();
      const heapUsedKb = heap ? Math.round(heap.usedJSHeapSize! / 1024) : undefined;
      // 读到就先交给资源遥测：ARMS 要的是完整的 60 秒序列，而本地日志只在有变化时才写，
      // 两个出口不能共用同一个门控结论；计数器采集与格式化也不该拖走这条 heap 样本。
      if (heapUsedKb !== undefined) {
        try {
          reportHeapSample?.({ heapUsedKb });
        } catch {
          // 桥失败只丢这条遥测样本，本地诊断日志与渲染都不受影响。
        }
      }
      const sample: MemorySample = {
        role: "renderer",
        counters: registry.collect(),
      };
      if (heap) {
        sample.heapUsedKb = heapUsedKb;
        if (typeof heap.totalJSHeapSize === "number") {
          sample.heapTotalKb = Math.round(heap.totalJSHeapSize / 1024);
        }
      }
      const reason = gate.evaluate(sample, now());
      if (!reason) {
        return false;
      }
      write(formatMemorySampleLine(sample, reason));
      return true;
    } catch {
      // 诊断采样失败只丢当前样本，不能影响渲染。
      return false;
    }
  };

  let handle: ReturnType<typeof setInterval> | undefined = setInterval(
    sampleNow,
    options.intervalMs ?? MEMORY_SAMPLE_INTERVAL_MS,
  );

  return {
    sampleNow,
    stop() {
      if (handle === undefined) {
        return;
      }
      clearInterval(handle);
      handle = undefined;
    },
  };
}

// ── Renderer 卡顿追踪（长动画帧 / visibility） ──

const LAG_SUMMARY_INTERVAL_MS = 10_000;
const LAG_HEARTBEAT_INTERVAL_MS = 60_000;
const LONG_FRAME_WARN_MS = 200;
const LONG_FRAME_WARN_MIN_INTERVAL_MS = 5_000;
const MAX_BUFFERED_LAG_ENTRIES = 200;

export interface LagScriptSample {
  url: string;
  functionName: string;
  durationMs: number;
  forcedStyleLayoutMs: number;
  invoker: string;
}

export interface LagFrameSample {
  startTime: number;
  durationMs: number;
  blockingMs: number;
  scripts: LagScriptSample[];
}

export interface LagSummary {
  longFrames: number;
  maxMs: number;
  p95Ms: number;
  totalMs: number;
  blockingMs: number;
  topScripts: Array<{ key: string; durationMs: number; forcedStyleLayoutMs: number }>;
  topInvokers: Array<{ invoker: string; durationMs: number }>;
}

interface LongAnimationFrameTimingLike {
  startTime: number;
  duration: number;
  blockingDuration?: number;
  scripts?: Array<{
    sourceURL?: string;
    sourceFunctionName?: string;
    duration?: number;
    forcedStyleAndLayoutDuration?: number;
    invoker?: string;
  }>;
}

interface LongTaskTimingLike {
  startTime: number;
  duration: number;
}

export function summarizeLagFrames(entries: readonly LagFrameSample[]): LagSummary {
  if (entries.length === 0) {
    return {
      longFrames: 0,
      maxMs: 0,
      p95Ms: 0,
      totalMs: 0,
      blockingMs: 0,
      topScripts: [],
      topInvokers: [],
    };
  }
  const durations = entries.map((entry) => entry.durationMs).sort((a, b) => a - b);
  const p95Index = Math.min(
    durations.length - 1,
    Math.max(0, Math.ceil(durations.length * 0.95) - 1),
  );
  const scriptDurations = new Map<string, { durationMs: number; forcedStyleLayoutMs: number }>();
  const invokerDurations = new Map<string, number>();
  for (const entry of entries) {
    for (const script of entry.scripts) {
      const key = `${script.functionName || "(anonymous)"} @ ${script.url || "(native)"}`;
      const current = scriptDurations.get(key) ?? { durationMs: 0, forcedStyleLayoutMs: 0 };
      current.durationMs += script.durationMs;
      current.forcedStyleLayoutMs += script.forcedStyleLayoutMs;
      scriptDurations.set(key, current);
      if (script.invoker) {
        invokerDurations.set(
          script.invoker,
          (invokerDurations.get(script.invoker) ?? 0) + script.durationMs,
        );
      }
    }
  }
  return {
    longFrames: entries.length,
    maxMs: durations[durations.length - 1] ?? 0,
    p95Ms: durations[p95Index] ?? 0,
    totalMs: entries.reduce((sum, entry) => sum + entry.durationMs, 0),
    blockingMs: entries.reduce((sum, entry) => sum + entry.blockingMs, 0),
    topScripts: [...scriptDurations.entries()]
      .map(([key, value]) => ({ key, ...value }))
      .sort((a, b) => b.durationMs - a.durationMs)
      .slice(0, 5),
    topInvokers: [...invokerDurations.entries()]
      .map(([invoker, durationMs]) => ({ invoker, durationMs }))
      .sort((a, b) => b.durationMs - a.durationMs)
      .slice(0, 5),
  };
}

function toLagFrameSample(
  entry: LongAnimationFrameTimingLike | LongTaskTimingLike,
): LagFrameSample {
  const scripts = "scripts" in entry && Array.isArray(entry.scripts) ? entry.scripts : [];
  return {
    startTime: entry.startTime,
    durationMs: Math.round(entry.duration),
    blockingMs: Math.round(
      "blockingDuration" in entry && typeof entry.blockingDuration === "number"
        ? entry.blockingDuration
        : 0,
    ),
    scripts: scripts.map((script) => ({
      url: script.sourceURL ?? "",
      functionName: script.sourceFunctionName ?? "",
      durationMs: Math.round(script.duration ?? 0),
      forcedStyleLayoutMs: Math.round(script.forcedStyleAndLayoutDuration ?? 0),
      invoker: script.invoker ?? "",
    })),
  };
}

function collectLagCounters(): Record<string, number> {
  const all = uiMemoryDiagnosticsRegistry.collect();
  const prefixes = ["projection.", "sessionStore.", "taskSnapshotCache."];
  return Object.fromEntries(
    Object.entries(all).filter(([key]) => prefixes.some((prefix) => key.startsWith(prefix))),
  );
}

function readLagHeapMB(): number | null {
  const memory = (performance as Performance & { memory?: { usedJSHeapSize?: number } }).memory;
  return typeof memory?.usedJSHeapSize === "number"
    ? Math.round(memory.usedJSHeapSize / 1048576)
    : null;
}

export interface RendererLagDiagnosticsHandle {
  stop(): void;
  sampleNow(): void;
}

let activeLagDiagnosticsHandle: RendererLagDiagnosticsHandle | null = null;

/**
 * Renderer 侧低频卡顿追踪：long-animation-frame 摘要 + 慢帧 + visibility。
 * 生产 renderer 日志禁用时直接 no-op，不安装 observer。
 */
export function startRendererLagDiagnostics(
  options: { intervalMs?: number; heartbeatMs?: number } = {},
): RendererLagDiagnosticsHandle {
  if (activeLagDiagnosticsHandle) return activeLagDiagnosticsHandle;
  if (!isLoggerLevelEnabled("info") || typeof PerformanceObserver === "undefined") {
    const inert = { stop() {}, sampleNow() {} };
    activeLagDiagnosticsHandle = inert;
    return inert;
  }

  const intervalMs = options.intervalMs ?? LAG_SUMMARY_INTERVAL_MS;
  const heartbeatMs = options.heartbeatMs ?? LAG_HEARTBEAT_INTERVAL_MS;
  let buffered: LagFrameSample[] = [];
  let lastHeartbeatAt = Date.now();
  let lastLongFrameWarnAt = 0;

  const maybeWarnLongFrame = (sample: LagFrameSample) => {
    if (sample.durationMs < LONG_FRAME_WARN_MS) return;
    const now = Date.now();
    if (now - lastLongFrameWarnAt < LONG_FRAME_WARN_MIN_INTERVAL_MS) return;
    lastLongFrameWarnAt = now;
    logger.warn("renderer long frame", {
      event: "perf.renderer_long_frame",
      module: "ui.lib.renderer_lag_diagnostics",
      durationMs: sample.durationMs,
      blockingMs: sample.blockingMs,
      startTime: Math.round(sample.startTime),
      visibility: typeof document === "undefined" ? "unknown" : document.visibilityState,
      scripts: sample.scripts
        .slice()
        .sort((a, b) => b.durationMs - a.durationMs)
        .slice(0, 3),
    });
  };

  const onEntries = (list: PerformanceObserverEntryList) => {
    for (const entry of list.getEntries()) {
      const sample = toLagFrameSample(entry as LongAnimationFrameTimingLike | LongTaskTimingLike);
      buffered.push(sample);
      if (buffered.length > MAX_BUFFERED_LAG_ENTRIES) buffered.shift();
      maybeWarnLongFrame(sample);
    }
  };

  let observer: PerformanceObserver | null = null;
  try {
    observer = new PerformanceObserver(onEntries);
    observer.observe({ type: "long-animation-frame", buffered: true });
  } catch {
    try {
      observer = new PerformanceObserver(onEntries);
      observer.observe({ type: "longtask", buffered: true });
    } catch {
      observer = null;
    }
  }

  const flush = () => {
    const entries = buffered;
    buffered = [];
    const now = Date.now();
    if (entries.length === 0 && now - lastHeartbeatAt < heartbeatMs) return;
    lastHeartbeatAt = now;
    const summary = summarizeLagFrames(entries);
    const documentElementCount =
      typeof document === "undefined" ? null : document.querySelectorAll("*").length;
    const webviewCount =
      typeof document === "undefined" ? 0 : document.querySelectorAll("webview").length;
    const runningAnimations =
      typeof document === "undefined" || typeof document.getAnimations !== "function"
        ? null
        : document.getAnimations().filter((animation) => animation.playState === "running").length;
    logger.info("renderer lag summary", {
      event: "perf.renderer_summary",
      module: "ui.lib.renderer_lag_diagnostics",
      intervalMs,
      visibility: typeof document === "undefined" ? "unknown" : document.visibilityState,
      ...summary,
      topScripts: summary.topScripts.slice(0, 3),
      topInvokers: summary.topInvokers.slice(0, 3),
      counters: collectLagCounters(),
      heapMB: readLagHeapMB(),
      documentElements: documentElementCount,
      webviews: webviewCount,
      runningAnimations,
    });
  };

  const timer = setInterval(flush, intervalMs);
  const onVisibilityChange =
    typeof document === "undefined"
      ? null
      : () => {
          logger.info("renderer visibility changed", {
            event: "perf.visibility_change",
            module: "ui.lib.renderer_lag_diagnostics",
            visibility: document.visibilityState,
          });
        };
  if (onVisibilityChange) document.addEventListener("visibilitychange", onVisibilityChange);

  const handle: RendererLagDiagnosticsHandle = {
    stop() {
      clearInterval(timer);
      observer?.disconnect();
      if (onVisibilityChange) document.removeEventListener("visibilitychange", onVisibilityChange);
      if (activeLagDiagnosticsHandle === handle) activeLagDiagnosticsHandle = null;
    },
    sampleNow: flush,
  };
  activeLagDiagnosticsHandle = handle;
  return handle;
}
