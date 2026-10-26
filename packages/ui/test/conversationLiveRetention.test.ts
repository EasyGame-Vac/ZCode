import { describe, expect, it } from "vitest";
import type {
  ConversationDelta,
  ConversationRow,
  ConversationSnapshot,
} from "@zcode/shared/zcode-protocol-v4";
import { rewindsIntoUnloadedHead, trimRowsToRecentTurns } from "@/v4/conversationLiveRetention.js";

function row(rowId: number, turnId: string): ConversationRow {
  return {
    rowId,
    turnId,
    createdAt: 1,
    createdAtSeq: rowId,
    kind: "assistantText",
    text: `row-${rowId}`,
    state: "streaming",
  };
}

function snapshotWithRows(
  rows: readonly ConversationRow[],
  firstRowId: number | null = 1,
): ConversationSnapshot {
  return {
    rows: { window: [...rows], totalCount: rows.length, firstRowId },
  } as ConversationSnapshot;
}

describe("trimRowsToRecentTurns", () => {
  it("只保留最近 K 个产品轮，并报告被裁掉的轮数", () => {
    const rows = [
      row(1, "t1"),
      row(2, "t1"),
      row(3, "t2"),
      row(4, "t2"),
      row(5, "t3"),
      row(6, "t3"),
      row(7, "t4"),
      row(8, "t4"),
      row(9, "t5"),
      row(10, "t5"),
    ];

    const trimmed = trimRowsToRecentTurns(rows, 3);

    expect(trimmed?.window.map((item) => item.rowId)).toEqual([5, 6, 7, 8, 9, 10]);
    expect(trimmed?.removedTurns).toBe(2);
  });

  it("窗口不超过 K 轮时不裁剪", () => {
    expect(trimRowsToRecentTurns([row(1, "t1"), row(2, "t2")], 3)).toBeNull();
  });

  it("K <= 0 或空窗口时不裁剪", () => {
    expect(trimRowsToRecentTurns([row(1, "t1")], 0)).toBeNull();
    expect(trimRowsToRecentTurns([], 3)).toBeNull();
  });

  it("单个超长轮不会被拆开", () => {
    const rows = Array.from({ length: 200 }, (_, index) => row(index + 1, "t1"));
    expect(trimRowsToRecentTurns(rows, 3)).toBeNull();
  });

  it("窗口从轮中间开始时仍按 turnId 边界裁头", () => {
    // 快照尾窗可能从 t2 中间开始；裁到最近 1 轮时只保留 t3 的完整可见部分。
    const rows = [row(10, "t2"), row(11, "t3"), row(12, "t3")];
    const trimmed = trimRowsToRecentTurns(rows, 1);
    expect(trimmed?.window.map((item) => item.rowId)).toEqual([11, 12]);
    expect(trimmed?.removedTurns).toBe(1);
  });
});

describe("rewindsIntoUnloadedHead", () => {
  const rows = [row(5, "t3"), row(6, "t3")];
  const snapshot = snapshotWithRows(rows, 1);

  function removed(fromRowId: number): ConversationDelta {
    return { op: "row.removed", fromRowId };
  }

  it("目标落在 firstRowId 与已加载首行之间时要求 recovery", () => {
    expect(rewindsIntoUnloadedHead(snapshot, [removed(3)])).toBe(true);
    expect(rewindsIntoUnloadedHead(snapshot, [removed(5)])).toBe(true);
  });

  it("目标就是全序首行时本地 apply 可正确清空，不要求 recovery", () => {
    expect(rewindsIntoUnloadedHead(snapshot, [removed(1)])).toBe(false);
  });

  it("目标仍在已加载窗口内时本地 apply 正确", () => {
    expect(rewindsIntoUnloadedHead(snapshot, [removed(6)])).toBe(false);
  });

  it("非 row.removed 帧不触发", () => {
    expect(
      rewindsIntoUnloadedHead(snapshot, [{ op: "row.delta", rowId: 5, path: "text", append: "x" }]),
    ).toBe(false);
  });
});
