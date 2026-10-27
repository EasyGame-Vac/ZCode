import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { AssistantWorkRow } from "@/v4/conversationTurnFlowItems.js";
import {
  derivePerformanceHudMetrics,
  estimateStreamedOutputTokens,
  resolveConversationLiveOutputSpeed,
  type ConversationLiveOutputSpeed,
} from "@/v4/conversationTurnWorkSegments.js";
import { LiveOutputSpeedBadge } from "@/v4/ConversationTurnGroup.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";

function streamingTextRow(
  text: string,
  createdAt: number,
  state: "streaming" | "complete" = "streaming",
): AssistantWorkRow {
  return {
    rowId: createdAt,
    turnId: "turn-1",
    createdAt,
    createdAtSeq: 1,
    kind: "assistantText",
    text,
    state,
  } as AssistantWorkRow;
}

function streamingReasoningRow(
  text: string,
  createdAt: number,
  state: "streaming" | "complete" = "streaming",
): AssistantWorkRow {
  return {
    rowId: createdAt + 1,
    turnId: "turn-1",
    createdAt,
    createdAtSeq: 2,
    kind: "reasoning",
    text,
    state,
  } as AssistantWorkRow;
}

function renderBadge(speed: ConversationLiveOutputSpeed | null, locale = "zh-CN"): string {
  return renderToStaticMarkup(
    createElement(
      ZCodeIntlProvider,
      { initialLocale: locale },
      createElement(LiveOutputSpeedBadge, { speed }),
    ),
  );
}

describe("estimateStreamedOutputTokens", () => {
  it("uses the shared character heuristic", () => {
    expect(estimateStreamedOutputTokens("")).toBe(0);
    expect(estimateStreamedOutputTokens("abcdefghi")).toBe(3);
    expect(estimateStreamedOutputTokens("中文测试")).toBe(3);
    expect(estimateStreamedOutputTokens("abc中文")).toBe(3);
  });
});

describe("resolveConversationLiveOutputSpeed", () => {
  it("returns null when no row is streaming", () => {
    expect(resolveConversationLiveOutputSpeed([], 5_000)).toBeNull();
    expect(
      resolveConversationLiveOutputSpeed([streamingTextRow("done", 1_000, "complete")], 5_000),
    ).toBeNull();
  });

  it("estimates tokens per second from the first streaming row", () => {
    const speed = resolveConversationLiveOutputSpeed(
      [streamingTextRow("a".repeat(120), 1_000)],
      5_000,
    );

    expect(speed).toEqual({
      estimatedTokens: 40,
      elapsedMs: 4_000,
      tokensPerSecond: 10,
    });
  });

  it("hides before the minimum observation window", () => {
    expect(
      resolveConversationLiveOutputSpeed([streamingTextRow("a".repeat(120), 1_000)], 1_999),
    ).toBeNull();
  });

  it("sums streaming text and reasoning and uses the earliest start", () => {
    const speed = resolveConversationLiveOutputSpeed(
      [streamingTextRow("a".repeat(30), 2_000), streamingReasoningRow("a".repeat(15), 1_000)],
      3_000,
    );

    expect(speed).toEqual({
      estimatedTokens: 15,
      elapsedMs: 2_000,
      tokensPerSecond: 7.5,
    });
  });

  it("ignores empty streaming rows", () => {
    expect(resolveConversationLiveOutputSpeed([streamingTextRow("", 1_000)], 5_000)).toBeNull();
  });
});

describe("LiveOutputSpeedBadge", () => {
  const speed = { estimatedTokens: 25, elapsedMs: 2_000, tokensPerSecond: 12.5 };

  it("renders a localized estimated speed with an explanatory tooltip", () => {
    const html = renderBadge(speed);

    expect(html).toContain('data-zcode-live-output-speed="true"');
    expect(html).toContain("约 12.5 tok/s");
    expect(html).toContain("根据流式正文估算");
  });

  it("renders the English label in en-US", () => {
    expect(renderBadge(speed, "en-US")).toContain("~12.5 tok/s");
  });

  it("keeps two decimals for very slow output", () => {
    expect(
      renderBadge({ estimatedTokens: 1, elapsedMs: 60_000, tokensPerSecond: 0.0166 }),
    ).toContain("约 0.02 tok/s");
  });

  it("renders nothing without a speed", () => {
    expect(renderBadge(null)).toBe("");
  });
});

describe("derivePerformanceHudMetrics", () => {
  const usage = {
    contextWindow: {
      usedTokens: 50_000,
      maxTokens: 100_000,
      autoCompactThresholdTokens: null,
    },
    cumulative: {
      inputTokens: 10_000,
      outputTokens: 2_000,
      cacheReadTokens: 9_000,
      cacheWriteTokens: 0,
    },
  };
  const config = { provider: "new-provider-2", model: "deepseek-v4.1-flash" };

  function input(rows: AssistantWorkRow[]) {
    return {
      rows: [
        ...rows,
        {
          rowId: 99,
          turnId: "turn-1",
          createdAt: 900,
          createdAtSeq: 99,
          kind: "turnHeader",
          origin: "userInput",
          state: "completedSuccess",
          startedAt: 900,
          outputTokens: 212,
        },
      ],
      usage,
      config,
    } as unknown as Parameters<typeof derivePerformanceHudMetrics>[0];
  }

  it("derives live speed, context and cache metrics while streaming", () => {
    const metrics = derivePerformanceHudMetrics(
      input([streamingTextRow("a".repeat(120), 1_000)]),
      5_000,
    );

    expect(metrics).toMatchObject({
      liveTokensPerSecond: 10,
      estimatedTokens: 40,
      streaming: true,
      contextUsedTokens: 50_000,
      contextMaxTokens: 100_000,
      contextRatio: 0.5,
      cacheHitRate: 0.9,
      lastTurnOutputTokens: 212,
      provider: "new-provider-2",
      model: "deepseek-v4.1-flash",
    });
  });

  it("does not invent a live speed when idle", () => {
    const metrics = derivePerformanceHudMetrics(input([]), 5_000);

    expect(metrics.liveTokensPerSecond).toBeNull();
    expect(metrics.streaming).toBe(false);
    expect(metrics.lastTurnOutputTokens).toBe(212);
  });

  it("keeps last TTFT and request duration on the same request", () => {
    const now = 10_000_000;
    const header = (
      rowId: number,
      at: number,
      latency: { timeToFirstContentMs?: number; lastRequestDurationMs: number },
    ) =>
      ({
        rowId,
        turnId: `turn-${rowId}`,
        createdAt: at,
        createdAtSeq: rowId,
        kind: "turnHeader",
        origin: "userInput",
        state: "completedSuccess",
        startedAt: at,
        endedAt: at + 1_000,
        ...latency,
      }) as unknown as Parameters<typeof derivePerformanceHudMetrics>[0]["rows"][number];
    const rows = [
      header(1, now - 60_000, { timeToFirstContentMs: 2_000, lastRequestDurationMs: 9_000 }),
      // 最近一次是纯工具调用：有请求耗时，没有首字。
      header(2, now - 10_000, { lastRequestDurationMs: 5_000 }),
    ];
    const metrics = derivePerformanceHudMetrics(
      { rows, usage, config } as unknown as Parameters<typeof derivePerformanceHudMetrics>[0],
      now,
    );

    expect(metrics.lastRequestDurationMs).toBe(5_000);
    // 最近的请求没有首字时显示 “—”，不回退到更早一轮。
    expect(metrics.lastTimeToFirstContentMs).toBeNull();
  });
});
