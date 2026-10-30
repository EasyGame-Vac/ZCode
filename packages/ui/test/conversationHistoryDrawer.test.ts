// @vitest-environment jsdom
import { createElement } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConversationRow } from "@zcode/shared/zcode-protocol-v4";
import { ConversationHistoryDrawer } from "@/v4/ConversationHistoryDrawer.js";

const mocks = vi.hoisted(() => ({
  loadOlderRows: vi.fn(),
}));

vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({
    intl: {
      formatMessage: ({ id }: { id: string }) => id,
    },
    locale: "zh-CN",
  }),
}));

vi.mock("@/store/StoreProvider.js", () => ({
  useZCodeStore: (selector: (state: unknown) => unknown) =>
    selector({
      theme: "zai-dark",
      codePreviewSettings: {
        darkTheme: "github-dark",
        fontSizePx: 13,
        lightTheme: "github-light",
        wrapLongLines: true,
      },
    }),
}));

vi.mock("@/v4/ConversationShareReadonlyTimeline.js", () => ({
  ConversationShareReadonlyTimeline: ({ rows }: { rows: readonly ConversationRow[] }) =>
    createElement(
      "div",
      { "data-testid": "history-timeline" },
      rows.map((row) => row.rowId).join(","),
    ),
}));

function row(rowId: number): ConversationRow {
  return { rowId } as ConversationRow;
}

function renderDrawer(
  overrides: Partial<Parameters<typeof ConversationHistoryDrawer>[0]> = {},
): ReturnType<typeof render> {
  return render(
    createElement(ConversationHistoryDrawer, {
      open: true,
      sessionId: "s1",
      workspacePath: "/workspace",
      initialRows: [row(10), row(11)],
      initialHasMore: true,
      loadOlderRows: mocks.loadOlderRows,
      onClose: vi.fn(),
      ...overrides,
    }),
  );
}

afterEach(() => {
  cleanup();
  mocks.loadOlderRows.mockReset();
});

describe("ConversationHistoryDrawer", () => {
  it("首次打开以 live 窗口首行为游标加载一页，并按 rowId 前插", async () => {
    mocks.loadOlderRows.mockResolvedValue({ rows: [row(1), row(2)], hasMore: true });

    renderDrawer();

    await waitFor(() => expect(mocks.loadOlderRows).toHaveBeenCalledWith(10, 60));
    await waitFor(() =>
      expect(screen.getByTestId("history-timeline").textContent).toBe("1,2,10,11"),
    );
  });

  it("加载更早使用当前最老 rowId 作为下一页游标", async () => {
    mocks.loadOlderRows
      .mockResolvedValueOnce({ rows: [row(1), row(2)], hasMore: true })
      .mockResolvedValueOnce({ rows: [row(0)], hasMore: false });

    renderDrawer();
    await waitFor(() =>
      expect(screen.getByTestId("history-timeline").textContent).toBe("1,2,10,11"),
    );

    fireEvent.click(screen.getByText("chat.history.loadOlderMessages"));

    await waitFor(() => expect(mocks.loadOlderRows).toHaveBeenLastCalledWith(1, 60));
    await waitFor(() =>
      expect(screen.getByTestId("history-timeline").textContent).toBe("0,1,2,10,11"),
    );
  });

  it("关闭后重新打开会重新取种子并加载，不复用上一次的旧列表", async () => {
    mocks.loadOlderRows.mockResolvedValue({ rows: [row(1), row(2)], hasMore: true });

    const { rerender } = renderDrawer();
    await waitFor(() => expect(mocks.loadOlderRows).toHaveBeenCalledTimes(1));

    mocks.loadOlderRows.mockClear();
    rerender(
      createElement(ConversationHistoryDrawer, {
        open: false,
        sessionId: "s1",
        workspacePath: "/workspace",
        initialRows: [row(10), row(11)],
        initialHasMore: true,
        loadOlderRows: mocks.loadOlderRows,
        onClose: vi.fn(),
      }),
    );
    rerender(
      createElement(ConversationHistoryDrawer, {
        open: true,
        sessionId: "s1",
        workspacePath: "/workspace",
        initialRows: [row(10), row(11)],
        initialHasMore: true,
        loadOlderRows: mocks.loadOlderRows,
        onClose: vi.fn(),
      }),
    );

    await waitFor(() => expect(mocks.loadOlderRows).toHaveBeenCalledWith(10, 60));
  });

  it("打开期间切换 session 会重新取种子", async () => {
    mocks.loadOlderRows.mockResolvedValue({ rows: [row(1)], hasMore: true });
    const { rerender } = renderDrawer();
    await waitFor(() => expect(mocks.loadOlderRows).toHaveBeenCalledWith(10, 60));

    mocks.loadOlderRows.mockClear();
    rerender(
      createElement(ConversationHistoryDrawer, {
        open: true,
        sessionId: "s2",
        workspacePath: "/workspace",
        initialRows: [row(20), row(21)],
        initialHasMore: true,
        loadOlderRows: mocks.loadOlderRows,
        onClose: vi.fn(),
      }),
    );

    await waitFor(() => expect(mocks.loadOlderRows).toHaveBeenCalledWith(20, 60));
    await waitFor(() => expect(screen.getByTestId("history-timeline").textContent).toBe("1,20,21"));
  });
});
