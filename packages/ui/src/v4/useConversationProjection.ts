import { useEffect, useRef, useSyncExternalStore } from "react";
import type { ConversationSnapshot } from "@zcode/shared/zcode-protocol-v4";
import type { ConversationStoreState } from "@/v4/conversationProjectionStore.js";
import type { SessionLease } from "@/v4/sessionDataLayer.js";
import { logger } from "@/logger.js";

const CLOSED_STATE: ConversationStoreState = {
  status: "closed",
  snapshot: null,
  subscriptionId: null,
  lastError: null,
  optimisticCommands: [],
  loadingOlder: false,
  hiddenTurnCount: 0,
  workflowRowsRevision: 0,
  sessionPlans: [],
  planDirectoryRevision: 0,
  plansLoading: false,
  turnNavigatorDirectoryRevision: 0,
};

/** 订阅 per-session projection store（useSyncExternalStore，row 级 selector 在组件内再做）。 */
export function useConversationProjection(lease: SessionLease | null): ConversationStoreState {
  const store = lease?.store ?? null;
  return useSyncExternalStore(
    (listener) => store?.subscribe(listener) ?? (() => {}),
    () => store?.getState() ?? CLOSED_STATE,
    () => CLOSED_STATE,
  );
}

interface SessionSwitchTrace {
  sessionId: string;
  openKind: SessionLease["openKind"];
  startedAt: number;
  snapshotAt: number | null;
  frame: number | null;
  reported: boolean;
}

function monotonicNow(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

function scheduleFrame(callback: () => void): number {
  if (typeof requestAnimationFrame === "function") {
    return requestAnimationFrame(() => callback());
  }
  return setTimeout(callback, 0) as unknown as number;
}

function cancelFrame(frame: number): void {
  if (typeof cancelAnimationFrame === "function") {
    cancelAnimationFrame(frame);
    return;
  }
  clearTimeout(frame as unknown as ReturnType<typeof setTimeout>);
}

/**
 * 记录一次会话切换的用户感知耗时：lease acquire → 首个有内容的 snapshot → 下一帧。
 * 只读诊断，不参与渲染或状态机；同一次 lease 只上报一次。
 */
export function useSessionSwitchTrace(
  lease: SessionLease | null,
  snapshot: ConversationSnapshot | null,
  hiddenTurnCount: number,
): void {
  const traceRef = useRef<SessionSwitchTrace | null>(null);

  useEffect(() => {
    if (!lease) {
      traceRef.current = null;
      return;
    }
    const trace: SessionSwitchTrace = {
      sessionId: lease.sessionId,
      openKind: lease.openKind,
      startedAt: lease.startedAt,
      snapshotAt: null,
      frame: null,
      reported: false,
    };
    traceRef.current = trace;
    return () => {
      if (trace.frame !== null) cancelFrame(trace.frame);
      trace.frame = null;
      if (traceRef.current === trace) traceRef.current = null;
    };
  }, [lease]);

  useEffect(() => {
    const trace = traceRef.current;
    if (!trace || trace.reported) return;
    if (!snapshot || snapshot.sessionId !== trace.sessionId) return;
    if (snapshot.rows.window.length === 0) return;
    if (trace.snapshotAt === null) trace.snapshotAt = monotonicNow();
    if (trace.frame !== null) return;

    const visibility = typeof document === "undefined" ? "unknown" : document.visibilityState;
    const snapshotAt = trace.snapshotAt;
    const report = (frameAt: number | null) => {
      if (trace.reported) return;
      trace.reported = true;
      const endAt = frameAt ?? snapshotAt;
      logger.info("session switch first frame", {
        event: "perf.session_switch",
        module: "ui.v4.session_switch_trace",
        sessionId: trace.sessionId,
        openKind: trace.openKind,
        acquireToSnapshotMs: Math.max(0, Math.round(snapshotAt - trace.startedAt)),
        snapshotToFrameMs: frameAt === null ? null : Math.round(frameAt - snapshotAt),
        totalMs: Math.max(0, Math.round(endAt - trace.startedAt)),
        rows: snapshot.rows.window.length,
        hiddenTurnCount,
        visibility,
      });
    };

    // 窗口不可见时 rAF 会被节流，不能把后台等待算进首帧；只记录到 snapshot。
    if (visibility === "hidden") {
      report(null);
      return;
    }

    trace.frame = scheduleFrame(() => {
      trace.frame = null;
      report(monotonicNow());
    });
  }, [hiddenTurnCount, lease, snapshot]);
}
