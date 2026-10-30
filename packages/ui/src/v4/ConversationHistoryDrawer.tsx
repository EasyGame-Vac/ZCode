import { useCallback, useEffect, useRef, useState } from "react";
import { XIcon } from "lucide-react";
import type { ConversationRow } from "@zcode/shared/zcode-protocol-v4";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useZCodeStore } from "@/store/StoreProvider.js";
import { mergeOlderRows } from "@/v4/conversationProjectionStore.js";
import { ConversationShareReadonlyTimeline } from "@/v4/ConversationShareReadonlyTimeline.js";

const HISTORY_PAGE_SIZE = 60;

export interface ConversationHistoryPage {
  rows: readonly ConversationRow[];
  hasMore: boolean;
}

export interface ConversationHistoryDrawerProps {
  open: boolean;
  sessionId: string | null;
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  /** live 窗口作为种子；抽屉只读，不修改 live projection。 */
  initialRows: readonly ConversationRow[];
  initialHasMore: boolean;
  /** 以最老 rowId 为游标取一页更早的行；实现方必须是只读查询。 */
  loadOlderRows: (beforeRowId: number, limit: number) => Promise<ConversationHistoryPage>;
  onClose: () => void;
}

/**
 * 只读历史抽屉：服务端按 rowId 分页，内容复用 ConversationShareReadonlyTimeline，
 * 与主会话/分享页使用同一套 turn/row 排版。抽屉状态独立于 live store。
 */
export function ConversationHistoryDrawer({
  open,
  sessionId,
  workspacePath,
  workspaceIdentity,
  remoteSessionId,
  initialRows,
  initialHasMore,
  loadOlderRows,
  onClose,
}: ConversationHistoryDrawerProps) {
  const { intl, locale } = useZCodeIntl();
  const theme = useZCodeStore((state) => state.theme);
  const codePreviewSettings = useZCodeStore((state) => state.codePreviewSettings);
  const [rows, setRows] = useState<readonly ConversationRow[]>(initialRows);
  const [loading, setLoading] = useState(false);
  const [hasMore, setHasMore] = useState(initialHasMore);
  const [error, setError] = useState<string | null>(null);
  const openSessionRef = useRef<string | null>(null);
  const loadingRef = useRef(false);
  const requestSequence = useRef(0);

  const loadPage = useCallback(
    async (beforeRowId: number) => {
      if (loadingRef.current) return;
      loadingRef.current = true;
      const sequence = ++requestSequence.current;
      setLoading(true);
      setError(null);
      try {
        const page = await loadOlderRows(beforeRowId, HISTORY_PAGE_SIZE);
        if (sequence !== requestSequence.current) return;
        setRows((previous) => mergeOlderRows(previous, page.rows) ?? previous);
        setHasMore(page.hasMore);
      } catch (cause) {
        if (sequence !== requestSequence.current) return;
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        if (sequence === requestSequence.current) {
          loadingRef.current = false;
          setLoading(false);
        }
      }
    },
    [loadOlderRows],
  );

  useEffect(() => {
    if (!open) {
      openSessionRef.current = null;
      requestSequence.current += 1;
      loadingRef.current = false;
      setLoading(false);
      return;
    }
    if (!sessionId || openSessionRef.current === sessionId) return;
    openSessionRef.current = sessionId;
    // 每次打开/切换会话都重新以当前 live 窗口为种子，避免复用上一次的旧缓存。
    const firstRowId = initialRows[0]?.rowId;
    setRows(initialRows);
    setHasMore(initialHasMore);
    setError(null);
    if (initialHasMore && firstRowId !== undefined) void loadPage(firstRowId);
  }, [initialHasMore, initialRows, loadPage, open, sessionId]);

  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose, open]);

  const loadOlder = useCallback(() => {
    const firstRowId = rows[0]?.rowId;
    if (loadingRef.current || !hasMore || firstRowId === undefined) return;
    void loadPage(firstRowId);
  }, [hasMore, loadPage, rows]);

  if (!open) return null;

  return (
    <div
      className="absolute inset-0 z-40 flex justify-end bg-black/20"
      role="presentation"
      onMouseDown={onClose}
    >
      <aside
        role="dialog"
        aria-modal="true"
        aria-label={intl.formatMessage({ id: "chat.history.drawerTitle" })}
        className="flex h-full w-[min(720px,94%)] flex-col border-l border-border bg-background shadow-2xl"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="flex items-center justify-between border-b border-border px-4 py-3">
          <div className="text-sm font-medium">
            {intl.formatMessage({ id: "chat.history.drawerTitle" })}
          </div>
          <button
            type="button"
            className="rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
            aria-label={intl.formatMessage({ id: "chat.history.drawerClose" })}
            onClick={onClose}
          >
            <XIcon className="size-4" />
          </button>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
          {hasMore ? (
            <div className="mb-3 flex justify-center">
              <button
                type="button"
                className="rounded-md border border-border px-3 py-1.5 text-xs text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50"
                disabled={loading}
                onClick={loadOlder}
              >
                {loading
                  ? intl.formatMessage({ id: "chat.history.loadingOlderMessages" })
                  : intl.formatMessage({ id: "chat.history.loadOlderMessages" })}
              </button>
            </div>
          ) : null}
          {error ? (
            <div className="mb-3 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
              <div>{intl.formatMessage({ id: "chat.history.drawerError" })}</div>
              <button type="button" className="mt-1 underline" onClick={loadOlder}>
                {intl.formatMessage({ id: "chat.history.loadOlderMessages" })}
              </button>
            </div>
          ) : null}
          {loading && rows.length === 0 ? (
            <div className="py-6 text-center text-xs text-muted-foreground">
              {intl.formatMessage({ id: "chat.history.loadingOlderMessages" })}
            </div>
          ) : null}
          {!loading && !error && rows.length === 0 ? (
            <div className="py-6 text-center text-xs text-muted-foreground">
              {intl.formatMessage({ id: "chat.history.drawerEmpty" })}
            </div>
          ) : null}
          {rows.length > 0 ? (
            <ConversationShareReadonlyTimeline
              rows={rows}
              locale={locale}
              theme={theme}
              codePreviewSettings={codePreviewSettings}
              workspacePath={workspacePath}
              {...(workspaceIdentity ? { workspaceIdentity } : {})}
              {...(remoteSessionId ? { workspaceRemoteSessionId: remoteSessionId } : {})}
            />
          ) : null}
        </div>
      </aside>
    </div>
  );
}
