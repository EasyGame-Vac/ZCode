import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { AssistantWorkRow } from "@/v4/conversationTurnFlowItems.js";
import {
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
