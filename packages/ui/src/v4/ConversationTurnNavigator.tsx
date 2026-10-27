import { memo, useEffect, useMemo, useState } from "react";
import {
  TID_V4_TURN_NAVIGATOR,
  TID_V4_TURN_NAVIGATOR_ITEM,
  TID_V4_TURN_NAVIGATOR_TOOLTIP,
  testId,
} from "@zcode/shared/test-ids";
import { cn } from "@/components/lib/utils.js";
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from "@/components/ui/hover-card.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  buildConversationTurnNavigatorItems,
  resolveConversationTurnNavigatorActiveUnitIndex,
  resolveConversationTurnNavigatorBarVisualState,
  resolveConversationTurnNavigatorVisibleRange,
  resolveConversationTurnNavigatorVisualFocusItemIndex,
  type ConversationTurnNavigatorVirtualItem,
} from "@/v4/conversationTurnNavigatorHelpers.js";
import type { ConversationTurnRenderUnit } from "@/v4/conversationTurnRenderUnits.js";

export interface ConversationTurnNavigatorProps {
  renderUnits: readonly ConversationTurnRenderUnit[];
  scrollOffsetPx: number;
  viewportHeightPx: number;
  virtualItems: readonly ConversationTurnNavigatorVirtualItem[];
  activeQueryRowId?: number;
  isHydratingDirectory?: boolean;
  onJumpToQuery: (
    target: { unitIndex: number; rowId: number },
    behavior: ScrollBehavior,
  ) => void;
}

function usePrefersReducedMotion() {
  const [prefersReducedMotion, setPrefersReducedMotion] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) {
      return;
    }
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setPrefersReducedMotion(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);

  return prefersReducedMotion;
}

function ConversationTurnNavigatorImpl({
  renderUnits,
  scrollOffsetPx,
  viewportHeightPx,
  virtualItems,
  activeQueryRowId,
  isHydratingDirectory = false,
  onJumpToQuery,
}: ConversationTurnNavigatorProps) {
  const { intl } = useZCodeIntl();
  const prefersReducedMotion = usePrefersReducedMotion();
  const [interactionItemIndex, setInteractionItemIndex] = useState<number | undefined>(
    undefined,
  );
  const items = useMemo(
    () =>
      buildConversationTurnNavigatorItems(renderUnits, {
        assistantEmptyPreview: intl.formatMessage({
          id: "chat.turnNavigator.emptyAssistant",
        }),
        assistantRunningPreview: intl.formatMessage({
          id: "chat.turnNavigator.runningAssistant",
        }),
        userFallbackPreview: intl.formatMessage({
          id: "chat.turnNavigator.userFallback",
        }),
      }),
    [intl, renderUnits],
  );

  const activeUnitIndex = useMemo(
    () =>
      resolveConversationTurnNavigatorActiveUnitIndex({
        items,
        scrollOffsetPx,
        viewportHeightPx,
        virtualItems,
      }),
    [items, scrollOffsetPx, viewportHeightPx, virtualItems],
  );
  const itemIndexes = useMemo(() => {
    const byRowId = new Map<number, number>();
    const firstByUnitIndex = new Map<number, number>();
    items.forEach((item, index) => {
      byRowId.set(item.rowId, index);
      if (!firstByUnitIndex.has(item.unitIndex)) {
        firstByUnitIndex.set(item.unitIndex, index);
      }
    });
    return { byRowId, firstByUnitIndex };
  }, [items]);
  const activeItemIndex =
    (activeQueryRowId === undefined
      ? undefined
      : itemIndexes.byRowId.get(activeQueryRowId)) ??
    (activeUnitIndex === undefined
      ? undefined
      : itemIndexes.firstByUnitIndex.get(activeUnitIndex)) ??
    -1;
  const visualFocusItemIndex = resolveConversationTurnNavigatorVisualFocusItemIndex({
    activeItemIndex,
    interactionItemIndex,
  });
  // 产品规则：导航轨最多同时显示 3 根横条；以当前 query 为中心取连续窗口，
  // 靠近目录两端时回补到 3 条，避免 rail 随会话历史无限增长。
  const visibleRange = useMemo(
    () =>
      resolveConversationTurnNavigatorVisibleRange({
        itemCount: items.length,
        activeItemIndex,
      }),
    [activeItemIndex, items.length],
  );
  const visibleItems = useMemo(
    () => items.slice(visibleRange.start, visibleRange.end),
    [items, visibleRange.end, visibleRange.start],
  );
  // 可见窗口平移后旧 hover 项可能已卸载，避免把 stale 原始索引继续用于山峰计算。
  useEffect(() => {
    setInteractionItemIndex(undefined);
  }, [visibleRange.start]);

  if (items.length < 2) {
    return null;
  }

  return (
    <nav
      aria-label={intl.formatMessage({ id: "chat.turnNavigator.label" })}
      aria-busy={isHydratingDirectory}
      data-testid={TID_V4_TURN_NAVIGATOR}
      data-item-count={items.length}
      data-visible-item-count={visibleItems.length}
      data-visible-start-index={visibleRange.start}
      data-rendered-item-count={visibleItems.length}
      className="pointer-events-none invisible absolute inset-y-0 left-0 z-10 w-12 -translate-x-2 opacity-0 transition-[opacity,transform,visibility] duration-150 ease-out motion-reduce:transition-none @min-[864px]/conversation:visible @min-[864px]/conversation:translate-x-0 @min-[864px]/conversation:opacity-100"
    >
      <div
        // 只声明 overflow-y-auto 时，浏览器会把 overflow-x 计算为 auto；
        // hover 山峰横向放大后便可能触发横向滚动条，因此 rail 必须只开放纵向滚动。
        className="!scrollbar-hide pointer-events-auto absolute left-3 top-1/2 max-h-[calc(100%-6rem)] w-9 -translate-y-1/2 overflow-x-hidden overflow-y-auto py-1"
        onPointerLeave={() => setInteractionItemIndex(undefined)}
      >
        <div className="relative w-9" style={{ height: `${visibleItems.length * 10}px` }}>
          {visibleItems.map((item, displayIndex) => {
            const itemIndex = visibleRange.start + displayIndex;
            const active = itemIndex === activeItemIndex;
            const visualState = resolveConversationTurnNavigatorBarVisualState({
              itemIndex,
              visualFocusItemIndex,
            });
            const showScrollActiveColor =
              visualFocusItemIndex === undefined && active;
            return (
              <div
                key={item.key}
                className="absolute left-0 top-0 h-2.5 w-9"
                style={{ transform: `translateY(${displayIndex * 10}px)` }}
              >
                <HoverCard closeDelay={80} openDelay={120}>
                  <HoverCardTrigger asChild>
                    <button
                      type="button"
                      aria-current={active ? "location" : undefined}
                      aria-label={intl.formatMessage(
                        { id: "chat.turnNavigator.jumpToQuery" },
                        { index: String(itemIndex + 1) },
                      )}
                      aria-posinset={itemIndex + 1}
                      aria-setsize={items.length}
                      data-testid={testId(TID_V4_TURN_NAVIGATOR_ITEM, item.key)}
                      data-item-index={itemIndex}
                      data-unit-index={item.unitIndex}
                      data-turn-id={item.turnId}
                      data-query-row-id={item.rowId}
                      data-active={active ? "true" : "false"}
                      data-running={item.isRunning ? "true" : "false"}
                      data-visual-color-tone={visualState.colorTone}
                      data-visual-scale={String(visualState.scaleX)}
                      data-visual-tone={visualState.tone}
                      onBlur={() => setInteractionItemIndex(undefined)}
                      onClick={() =>
                        onJumpToQuery(
                          { unitIndex: item.unitIndex, rowId: item.rowId },
                          prefersReducedMotion ? "auto" : "smooth",
                        )
                      }
                      onFocus={() => setInteractionItemIndex(itemIndex)}
                      onPointerEnter={() => setInteractionItemIndex(itemIndex)}
                      onPointerLeave={() => setInteractionItemIndex(undefined)}
                      className="flex h-2.5 w-9 items-center justify-start rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-input-border-focused focus-visible:ring-offset-2 focus-visible:ring-offset-background"
                    >
                      <span
                        className={cn(
                          "block h-0.5 w-3 origin-left rounded-full transition-[height,opacity,transform,background-color] duration-150 ease-out motion-reduce:transition-none",
                          visualState.colorTone === "focus" && "bg-foreground",
                          visualState.colorTone === "muted" &&
                            (showScrollActiveColor
                              ? "bg-foreground"
                              : "bg-foreground-subtlest"),
                        )}
                        style={{
                          opacity:
                            showScrollActiveColor
                              ? 0.9
                              : item.isRunning
                                ? Math.max(visualState.opacity, 0.72)
                                : visualState.opacity,
                          transform: `scaleX(${visualState.scaleX})`,
                        }}
                      />
                    </button>
                  </HoverCardTrigger>
                  <HoverCardContent
                    align="start"
                    side="right"
                    sideOffset={8}
                    data-testid={testId(
                      TID_V4_TURN_NAVIGATOR_TOOLTIP,
                      item.key,
                    )}
                    className="w-80 max-w-[calc(100vw-2rem)] border border-popover-border bg-popover p-3 text-popover-foreground shadow-lg"
                  >
                    <div className="space-y-2">
                      <p className="line-clamp-2 whitespace-pre-line text-ui-base font-medium leading-5">
                        {item.userPreview}
                      </p>
                      <p
                        className={cn(
                          "line-clamp-3 whitespace-pre-line text-ui-base leading-5",
                          item.assistantPreviewKind === "text"
                            ? "text-popover-foreground/80"
                            : "text-foreground-subtle",
                        )}
                      >
                        {item.assistantPreview}
                      </p>
                    </div>
                  </HoverCardContent>
                </HoverCard>
              </div>
            );
          })}
        </div>
      </div>
    </nav>
  );
}

export const ConversationTurnNavigator = memo(ConversationTurnNavigatorImpl);
