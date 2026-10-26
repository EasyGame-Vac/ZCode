import { useEffect } from "react";
import { XIcon } from "lucide-react";
import type { ZCodeMessageWithParts } from "@zcode/shared";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useConversationHistory } from "@/v4/useConversationHistory.js";

export interface ConversationHistoryDrawerProps {
  open: boolean;
  sessionId: string | null;
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  onClose: () => void;
}

function HistoryMessage({ message }: { message: ZCodeMessageWithParts }) {
  const { intl } = useZCodeIntl();
  const role = message.info.role;
  const text = message.parts
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n")
    .trim();
  const reasoning = message.parts
    .filter((part) => part.type === "reasoning")
    .map((part) => part.text)
    .join("\n")
    .trim();
  const tools = message.parts.filter((part) => part.type === "tool");
  return (
    <article className="rounded-lg border border-border/60 bg-card/40 px-3 py-2">
      <div className="mb-1 text-[11px] font-medium text-muted-foreground">
        {role === "user"
          ? intl.formatMessage({ id: "chat.history.drawerUser" })
          : intl.formatMessage({ id: "chat.history.drawerAssistant" })}
      </div>
      {reasoning ? (
        <details className="mb-2 rounded-md border border-border/50 bg-muted/20 px-2 py-1">
          <summary className="cursor-pointer text-[11px] text-muted-foreground">
            {intl.formatMessage({ id: "chat.history.drawerReasoning" })}
          </summary>
          <div className="mt-1 whitespace-pre-wrap break-words text-xs leading-5 text-muted-foreground">
            {reasoning}
          </div>
        </details>
      ) : null}
      {text ? (
        <div className="whitespace-pre-wrap break-words text-sm leading-6 text-foreground">
          {text}
        </div>
      ) : null}
      {tools.map((part) => (
        <details
          key={part.partId}
          className="mt-2 rounded-md border border-border/50 bg-muted/20 px-2 py-1"
        >
          <summary className="cursor-pointer text-[11px] text-muted-foreground">
            {part.tool} · {part.state.status}
          </summary>
          <pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap break-words text-[11px] leading-5 text-muted-foreground">
            {JSON.stringify(part.state, null, 2).slice(0, 4_000)}
          </pre>
        </details>
      ))}
    </article>
  );
}

/** 只读历史抽屉：独立分页，不进入 live projection，也不参与流式渲染。 */
export function ConversationHistoryDrawer({
  open,
  sessionId,
  workspacePath,
  workspaceIdentity,
  remoteSessionId,
  onClose,
}: ConversationHistoryDrawerProps) {
  const { intl } = useZCodeIntl();
  const { messages, loading, hasMore, error, loadOlder, retry } = useConversationHistory(
    sessionId,
    workspacePath,
    workspaceIdentity,
    remoteSessionId,
    open,
  );

  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose, open]);

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
        className="flex h-full w-[min(560px,92%)] flex-col border-l border-border bg-background shadow-2xl"
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
          {error ? (
            <div className="mb-3 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
              <div>{intl.formatMessage({ id: "chat.history.drawerError" })}</div>
              <button type="button" className="mt-1 underline" onClick={retry}>
                {intl.formatMessage({ id: "chat.history.loadOlderMessages" })}
              </button>
            </div>
          ) : null}
          {loading && messages.length === 0 ? (
            <div className="py-6 text-center text-xs text-muted-foreground">
              {intl.formatMessage({ id: "chat.history.loadingOlderMessages" })}
            </div>
          ) : null}
          {!loading && !error && messages.length === 0 ? (
            <div className="py-6 text-center text-xs text-muted-foreground">
              {intl.formatMessage({ id: "chat.history.drawerEmpty" })}
            </div>
          ) : null}
          <div className="flex flex-col gap-3">
            {messages.map((message) => (
              <HistoryMessage key={String(message.info.messageId)} message={message} />
            ))}
          </div>
          {hasMore ? (
            <div className="mt-3 flex justify-center">
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
        </div>
      </aside>
    </div>
  );
}
