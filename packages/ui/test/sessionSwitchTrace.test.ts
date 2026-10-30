// @vitest-environment jsdom
import { renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConversationSnapshot } from "@zcode/shared/zcode-protocol-v4";
import type { SessionLease } from "@/v4/sessionDataLayer.js";
import { useSessionSwitchTrace } from "@/v4/useConversationProjection.js";

const mocks = vi.hoisted(() => ({ info: vi.fn() }));

vi.mock("@/logger.js", () => ({
  logger: { info: mocks.info },
}));

function lease(overrides: Partial<SessionLease> = {}): SessionLease {
  return {
    sessionId: "s1",
    openKind: "cold",
    startedAt: performance.now() - 100,
    ...overrides,
  } as SessionLease;
}

function snapshot(overrides: Partial<ConversationSnapshot> = {}): ConversationSnapshot {
  return {
    sessionId: "s1",
    rows: { window: [{ rowId: 1 }] },
    ...overrides,
  } as unknown as ConversationSnapshot;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("useSessionSwitchTrace", () => {
  it("logs one switch with acquire-to-snapshot and snapshot-to-frame durations", () => {
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(performance.now());
      return 1;
    });
    vi.stubGlobal("cancelAnimationFrame", vi.fn());

    renderHook(() => useSessionSwitchTrace(lease(), snapshot(), 2));

    expect(mocks.info).toHaveBeenCalledTimes(1);
    expect(mocks.info).toHaveBeenCalledWith(
      "session switch first frame",
      expect.objectContaining({
        event: "perf.session_switch",
        sessionId: "s1",
        openKind: "cold",
        rows: 1,
        hiddenTurnCount: 2,
        visibility: "visible",
      }),
    );
  });

  it("does not log when the snapshot belongs to another session", () => {
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(performance.now());
      return 1;
    });
    vi.stubGlobal("cancelAnimationFrame", vi.fn());

    renderHook(() => useSessionSwitchTrace(lease(), snapshot({ sessionId: "s2" }), 2));

    expect(mocks.info).not.toHaveBeenCalled();
  });
});
