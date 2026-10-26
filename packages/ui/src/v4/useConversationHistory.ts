import { useCallback, useEffect, useRef, useState } from "react";
import type { ZCodeMessageWithParts } from "@zcode/shared";
import { useServices } from "@/hooks/useServices.js";
import { logger } from "@/logger.js";

const HISTORY_PAGE_SIZE = 30;

export interface ConversationHistoryState {
  messages: readonly ZCodeMessageWithParts[];
  loading: boolean;
  hasMore: boolean;
  error: string | null;
  loadOlder: () => void;
  retry: () => void;
}

/**
 * 只读历史分页。数据走 legacy session/messages 的 beforeMessageId 向后分页，
 * 不进入 ConversationProjectionStore，也不改变 live 窗口和流式订阅。
 */
export function useConversationHistory(
  sessionId: string | null,
  workspacePath: string,
  workspaceIdentity: string | undefined,
  remoteSessionId: string | undefined,
  open: boolean,
): ConversationHistoryState {
  const { zcodeSessionService } = useServices();
  const [messages, setMessages] = useState<readonly ZCodeMessageWithParts[]>([]);
  const [loading, setLoading] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestSequence = useRef(0);
  const loadingRef = useRef(false);
  const beforeMessageIdRef = useRef<string | null>(null);
  const loadedSessionRef = useRef<string | null>(null);

  const load = useCallback(
    async (beforeMessageId: string | null) => {
      if (!sessionId || loadingRef.current) return;
      loadingRef.current = true;
      const sequence = ++requestSequence.current;
      setLoading(true);
      setError(null);
      try {
        const page = await zcodeSessionService.readSessionMessages({
          sessionId,
          workspacePath,
          ...(workspaceIdentity ? { workspaceIdentity } : {}),
          ...(remoteSessionId ? { remoteSessionId } : {}),
          ...(beforeMessageId ? { beforeMessageId } : {}),
          limit: HISTORY_PAGE_SIZE,
        });
        if (sequence !== requestSequence.current) return;
        setMessages((previous) => (beforeMessageId ? [...page, ...previous] : page));
        setHasMore(page.length >= HISTORY_PAGE_SIZE);
        const first = page[0];
        beforeMessageIdRef.current = first ? String(first.info.messageId) : null;
        if (page.length === 0) setHasMore(false);
      } catch (cause) {
        if (sequence !== requestSequence.current) return;
        const message = cause instanceof Error ? cause.message : String(cause);
        setError(message);
        logger.warn(`[v4-history] 加载历史失败 session=${sessionId}: ${message}`);
      } finally {
        if (sequence === requestSequence.current) {
          loadingRef.current = false;
          setLoading(false);
        }
      }
    },
    [sessionId, workspaceIdentity, workspacePath, zcodeSessionService, remoteSessionId],
  );

  useEffect(() => {
    if (!open || !sessionId) return;
    if (loadedSessionRef.current === sessionId) return;
    loadedSessionRef.current = sessionId;
    requestSequence.current += 1;
    beforeMessageIdRef.current = null;
    loadingRef.current = false;
    setMessages([]);
    setHasMore(false);
    setError(null);
    void load(null);
  }, [load, open, sessionId]);

  const loadOlder = useCallback(() => {
    if (!open || loadingRef.current || !hasMore) return;
    const beforeMessageId = beforeMessageIdRef.current;
    if (!beforeMessageId) return;
    void load(beforeMessageId);
  }, [hasMore, load, open]);

  const retry = useCallback(() => {
    if (!open || loadingRef.current || !sessionId) return;
    loadedSessionRef.current = sessionId;
    void load(beforeMessageIdRef.current);
  }, [load, open, sessionId]);

  return { messages, loading, hasMore, error, loadOlder, retry };
}
