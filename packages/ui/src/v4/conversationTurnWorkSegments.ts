import type {
  AssistantTextRow,
  ConversationRow,
  ConversationSnapshot,
  TurnHeaderRow,
  UserInputRow,
} from "@zcode/shared/zcode-protocol-v4";
import { ESTIMATED_TOKEN_CHAR_DIVISOR } from "@zcode/shared";
import {
  ENABLE_CUA_TOOL_CALL_GROUPING,
  prepareCuaGroupFlowItems,
} from "@/v4/conversationCuaGroups.js";
// Bugfix：必须直接引用纯函数模块，不能走 `@/plugin-ui/index.js` 桶文件。本文件在分享只读
// 时间线闭包里，桶文件会把 plugin-ui 全量组件 → V4ConversationContext → @zcode/services →
// @zcode/provider 拖进 web-share 构建，导致 `@zcode/shared/mcp-apps` 等子路径无法解析、构建失败。
import {
  isPluginUiPinnedToolRow,
  type PluginUiRowPinResolver,
} from "@/plugin-ui/domain/pluginUiRowPolicy.js";
import { buildConversationFlowItems } from "@/v4/conversationTurnFlowItems.js";
import type { AssistantWorkRow, ConversationTurnFlowItem } from "@/v4/conversationTurnFlowItems.js";

export interface ConversationTurnWorkStatus {
  state: "running" | "completed" | "interrupted";
  durationMs?: number;
}

/** SessionPane 内置 Performance HUD 的开关事件；detail.sessionId 用于只切换当前 pane。 */
export const PERFORMANCE_HUD_TOGGLE_EVENT = "zcode:performance-hud:toggle";

export interface ConversationTurnWorkSegment {
  key: string;
  triggerRow?: UserInputRow;
  flowItems: ConversationTurnFlowItem[];
  assistantWorkRows: AssistantWorkRow[];
  assistantHistoryRows: AssistantWorkRow[];
  assistantFollowingRows: AssistantWorkRow[];
  assistantHistoryDefaultOpen: boolean;
  workStatus?: ConversationTurnWorkStatus;
}

export function resolveConversationTurnWorkStatus(
  header: TurnHeaderRow | undefined,
  workRows: readonly AssistantWorkRow[],
  isRunning: boolean,
  durationMs: number | undefined,
  isInterrupted = false,
): ConversationTurnWorkStatus | undefined {
  if (header?.executionKind === "controlOnly") return undefined;
  const hasWork =
    isRunning ||
    workRows.length > 0 ||
    (header?.executionKind === "agent" ? durationMs !== undefined : (durationMs ?? 0) > 0);
  if (!hasWork) return undefined;
  return {
    state: isRunning ? "running" : isInterrupted ? "interrupted" : "completed",
    ...(durationMs !== undefined ? { durationMs } : {}),
  };
}

export function resolveConversationTurnWorkDurationMs(
  header: TurnHeaderRow | undefined,
  options: { nowMs?: number },
  isRunning: boolean,
): number | undefined {
  if (!header) return undefined;
  if (header.activeMs !== undefined) return header.activeMs;
  if (header.endedAt !== undefined) return Math.max(header.endedAt - header.startedAt, 0);
  // UI 每秒传入 nowMs 只用于运行中“工作中 N 秒”；完成态缺少
  // activeMs/endedAt 时不能继续吃当前时钟，否则历史“已工作”会随时间增长。
  if (isRunning && options.nowMs !== undefined) {
    return Math.max(options.nowMs - header.startedAt, 0);
  }
  return undefined;
}

interface DraftVisualWorkSegment {
  orderedRows: ConversationRow[];
  triggerRow?: UserInputRow;
}

function isUserInputRow(row: ConversationRow): row is UserInputRow {
  return row.kind === "userInput";
}

function isAssistantTextRow(row: ConversationRow): row is AssistantTextRow {
  return row.kind === "assistantText";
}

function isAssistantWorkRow(row: ConversationRow): row is AssistantWorkRow {
  return row.kind !== "turnHeader" && row.kind !== "userInput";
}

function splitVisualWorkSegments(rows: readonly ConversationRow[]): DraftVisualWorkSegment[] {
  const segments: DraftVisualWorkSegment[] = [];
  let current: DraftVisualWorkSegment = { orderedRows: [] };
  for (const row of rows) {
    if (isUserInputRow(row) && row.guided === true && current.orderedRows.length > 0) {
      segments.push(current);
      current = { orderedRows: [], triggerRow: row };
    }
    current.orderedRows.push(row);
  }
  if (current.orderedRows.length > 0) segments.push(current);
  return segments;
}

function resolveSegmentDurationMs(options: {
  header?: TurnHeaderRow;
  segmentIndex: number;
  triggerRow?: UserInputRow;
  nextTriggerRow?: UserInputRow;
  segmentRunning: boolean;
  segmentCount: number;
  nowMs?: number;
}): number | undefined {
  const fact =
    (options.triggerRow?.entityId
      ? options.header?.workSegments?.find(
          (candidate) => candidate.triggerEntityId === options.triggerRow?.entityId,
        )
      : undefined) ?? options.header?.workSegments?.[options.segmentIndex];
  if (fact?.activeMs !== undefined) return fact.activeMs;
  if (fact?.endedAt !== undefined) return Math.max(0, fact.endedAt - fact.startedAt);
  if (fact && options.segmentRunning && options.nowMs !== undefined) {
    return Math.max(0, options.nowMs - fact.startedAt);
  }
  if (options.segmentCount === 1) {
    return resolveConversationTurnWorkDurationMs(
      options.header,
      { nowMs: options.nowMs },
      options.segmentRunning,
    );
  }
  // 兼容旧 guide snapshot：新 CLI 会下发 workSegments；仅旧数据缺事实时才按
  // guided row 的稳定时间边界恢复，避免刷新后又退回整个 turn 的单一工时。
  const startedAt = options.triggerRow?.createdAt ?? options.header?.startedAt;
  const endedAt = options.nextTriggerRow?.createdAt ?? options.header?.endedAt;
  if (startedAt !== undefined && endedAt !== undefined) return Math.max(0, endedAt - startedAt);
  if (startedAt !== undefined && options.segmentRunning && options.nowMs !== undefined) {
    return Math.max(0, options.nowMs - startedAt);
  }
  return undefined;
}

export function buildConversationTurnWorkSegments(options: {
  key: string;
  header?: TurnHeaderRow;
  orderedRows: readonly ConversationRow[];
  assistantTailRows: readonly AssistantWorkRow[];
  latestAssistantTextRow?: AssistantTextRow;
  isRunning: boolean;
  isLastTurn: boolean;
  isInterrupted: boolean;
  forceOpenHistory: boolean;
  timelineOnly: boolean;
  nowMs?: number;
  /** 插件卡片进不进折叠区的裁决；缺省沿用"全部常驻"。 */
  pluginUiPinResolver?: PluginUiRowPinResolver;
}): ConversationTurnWorkSegment[] {
  const visualDrafts = splitVisualWorkSegments(options.orderedRows);
  const tailRowIds = new Set(options.assistantTailRows.map((row) => row.rowId));
  return visualDrafts.map((segment, segmentIndex) => {
    const segmentAssistantRows = segment.orderedRows.filter(isAssistantWorkRow);
    const segmentTailRows = segmentAssistantRows.filter((row) => tailRowIds.has(row.rowId));
    const segmentFlowRows = segmentAssistantRows.filter((row) => !tailRowIds.has(row.rowId));
    const lastSegmentFlowRow = segmentFlowRows.at(-1);
    const segmentCompleted = segmentIndex < visualDrafts.length - 1 || !options.isRunning;
    const productLatestAssistantTextRow = options.latestAssistantTextRow
      ? segmentFlowRows.find((row) => row.rowId === options.latestAssistantTextRow?.rowId)
      : undefined;
    const visibleAssistantTextRow =
      productLatestAssistantTextRow && isAssistantTextRow(productLatestAssistantTextRow)
        ? productLatestAssistantTextRow
        : segmentCompleted && lastSegmentFlowRow && isAssistantTextRow(lastSegmentFlowRow)
          ? lastSegmentFlowRow
          : undefined;
    const visibleAssistantIndex = visibleAssistantTextRow
      ? segmentFlowRows.findIndex((row) => row.rowId === visibleAssistantTextRow.rowId)
      : -1;
    // 插件 UI 工具行留在折叠区外（与 assistantText 同级），过程行照常折叠；见 isPluginUiPinnedToolRow。
    const segmentHistoryRows = (
      options.timelineOnly
        ? []
        : visibleAssistantIndex < 0
          ? segmentFlowRows
          : segmentFlowRows.slice(0, visibleAssistantIndex)
    ).filter((row) => !isPluginUiPinnedToolRow(row, options.pluginUiPinResolver));
    const segmentFollowingRows =
      visibleAssistantIndex < 0 ? [] : segmentFlowRows.slice(visibleAssistantIndex + 1);
    const segmentRunning = segmentIndex === visualDrafts.length - 1 && options.isRunning;
    const segmentDurationMs = resolveSegmentDurationMs({
      header: options.header,
      segmentIndex,
      triggerRow: segment.triggerRow,
      nextTriggerRow: visualDrafts[segmentIndex + 1]?.triggerRow,
      segmentRunning,
      segmentCount: visualDrafts.length,
      nowMs: options.nowMs,
    });
    const segmentWorkStatus = resolveConversationTurnWorkStatus(
      options.header,
      segmentFlowRows,
      segmentRunning,
      segmentDurationMs,
      options.isInterrupted && segmentIndex === visualDrafts.length - 1,
    );
    const segmentKey =
      segmentIndex === 0
        ? options.key
        : `${options.key}:guide:${segment.triggerRow?.entityId ?? segment.triggerRow?.rowId ?? segmentIndex}`;
    const flowItems = buildConversationFlowItems({
      orderedRows: segment.orderedRows,
      assistantHistoryRows: segmentHistoryRows,
      assistantFollowingRows: segmentFollowingRows,
      assistantTailRows: segmentTailRows,
      ...(visibleAssistantTextRow ? { visibleAssistantTextRow } : {}),
      ...(options.latestAssistantTextRow
        ? { latestAssistantTextRow: options.latestAssistantTextRow }
        : {}),
      timelineOnly: options.timelineOnly,
    });
    return {
      key: segmentKey,
      ...(segment.triggerRow ? { triggerRow: segment.triggerRow } : {}),
      flowItems: prepareCuaGroupFlowItems(flowItems, {
        enabled: ENABLE_CUA_TOOL_CALL_GROUPING,
        stageTailIsRunning: segmentRunning,
      }),
      assistantWorkRows: segmentAssistantRows,
      assistantHistoryRows: segmentHistoryRows,
      assistantFollowingRows: segmentFollowingRows,
      assistantHistoryDefaultOpen:
        !options.timelineOnly &&
        (options.forceOpenHistory ||
          (options.isLastTurn && segmentWorkStatus?.state === "running") ||
          (visualDrafts.length === 1 &&
            visibleAssistantTextRow === undefined &&
            segmentFlowRows.length > 0)),
      ...(segmentWorkStatus ? { workStatus: segmentWorkStatus } : {}),
    };
  });
}

/** 首段流式输出不足 1 秒时，样本太小，瞬时值没有参考意义。 */
export const MIN_LIVE_OUTPUT_SPEED_ELAPSED_MS = 1_000;

export interface ConversationLiveOutputSpeed {
  estimatedTokens: number;
  elapsedMs: number;
  tokensPerSecond: number;
}

/**
 * 与 CLI 的 estimateTokens 保持同一口径。
 * 这里只服务运行中的临时展示，provider usage 才是请求结束后的权威值。
 */
export function estimateStreamedOutputTokens(text: string): number {
  if (text.length === 0) return 0;
  const chineseChars = (text.match(/[\u4e00-\u9fff]/g) ?? []).length;
  const otherChars = text.length - chineseChars;
  return Math.ceil((chineseChars * 2 + otherChars) / ESTIMATED_TOKEN_CHAR_DIVISOR);
}

/**
 * 从当前 turn 的流式正文/思考行估算输出速度。
 *
 * 纯派生值：不写入 projection/store，也不代表 provider 的最终 usage。
 * 工具调用参数生成和等待工具执行期间没有流式正文行，因此自然不展示。
 */
export function resolveConversationLiveOutputSpeed(
  rows: readonly AssistantWorkRow[],
  nowMs: number,
  options: { minimumElapsedMs?: number } = {},
): ConversationLiveOutputSpeed | null {
  let earliestStartedAt: number | undefined;
  let estimatedTokens = 0;

  for (const row of rows) {
    const streamingText =
      row.kind === "assistantText" && row.state === "streaming"
        ? row.text
        : row.kind === "reasoning" && row.state === "streaming"
          ? row.text
          : undefined;
    if (streamingText === undefined || streamingText.length === 0) continue;

    estimatedTokens += estimateStreamedOutputTokens(streamingText);
    earliestStartedAt =
      earliestStartedAt === undefined ? row.createdAt : Math.min(earliestStartedAt, row.createdAt);
  }

  if (estimatedTokens <= 0 || earliestStartedAt === undefined) return null;

  const elapsedMs = nowMs - earliestStartedAt;
  if (
    !Number.isFinite(elapsedMs) ||
    elapsedMs < (options.minimumElapsedMs ?? MIN_LIVE_OUTPUT_SPEED_ELAPSED_MS)
  ) {
    return null;
  }

  const tokensPerSecond = (estimatedTokens * 1_000) / elapsedMs;
  if (!Number.isFinite(tokensPerSecond) || tokensPerSecond <= 0) return null;

  return { estimatedTokens, elapsedMs, tokensPerSecond };
}

export interface PerformanceHudMetrics {
  liveTokensPerSecond: number | null;
  estimatedTokens: number;
  streaming: boolean;
  contextUsedTokens: number | null;
  contextMaxTokens: number | null;
  contextRatio: number | null;
  cacheHitRate: number | null;
  lastTurnOutputTokens: number | null;
  lastCompletedTokensPerSecond: number | null;
  completedSampleCount: number;
  lastRequestDurationMs: number | null;
  lastTimeToFirstContentMs: number | null;
  provider: string;
  model: string;
}

/**
 * 自用浮层的会话级派生指标。生成中读 streaming rows 估算速度；空闲时只展示最近一轮的
 * 精确 outputTokens、上下文水位和累计缓存命中，不伪造一个“空闲 TPS”。
 *
 * 窗口吞吐、请求级 P50/P90 属于模型属性（跨会话），改由 v4/usage/model-rate 提供；
 * 本函数只保留解释当前会话/当前轮的事实。本模块在 web-share 只读时间线闭包里，
 * 不能引入 hooks 或 @zcode/services。
 */
export function derivePerformanceHudMetrics(
  input: {
    rows: readonly ConversationRow[];
    usage: ConversationSnapshot["usage"];
    config: ConversationSnapshot["config"];
  },
  nowMs: number,
): PerformanceHudMetrics {
  const workRows = input.rows.filter(
    (row) => row.kind !== "turnHeader" && row.kind !== "userInput",
  ) as AssistantWorkRow[];
  const live = resolveConversationLiveOutputSpeed(workRows, nowMs);
  const streaming = workRows.some(
    (row) =>
      (row.kind === "assistantText" || row.kind === "reasoning") && row.state === "streaming",
  );

  let lastTurnOutputTokens: number | null = null;
  const completedRates: number[] = [];
  let lastCompletedTokensPerSecond: number | null = null;
  let lastRequestDurationMs: number | null = null;
  let lastTimeToFirstContentMs: number | null = null;
  let lastTimingRowFound = false;
  for (let index = input.rows.length - 1; index >= 0; index -= 1) {
    const row = input.rows[index];
    if (row?.kind !== "turnHeader") continue;
    if (
      typeof row.outputTokensPerSecond === "number" &&
      Number.isFinite(row.outputTokensPerSecond) &&
      row.outputTokensPerSecond > 0
    ) {
      completedRates.push(row.outputTokensPerSecond);
      lastCompletedTokensPerSecond ??= row.outputTokensPerSecond;
    }
    if (lastTurnOutputTokens === null && row.outputTokens !== undefined) {
      lastTurnOutputTokens = row.outputTokens;
    }
    // 首字与请求耗时必须来自同一条最近请求；若最近请求没有首字（纯工具调用），
    // 显示 “—” 而不是回退到更早一轮的旧首字。
    if (
      !lastTimingRowFound &&
      typeof row.lastRequestDurationMs === "number" &&
      row.lastRequestDurationMs >= 0
    ) {
      lastRequestDurationMs = row.lastRequestDurationMs;
      lastTimeToFirstContentMs =
        typeof row.timeToFirstContentMs === "number" && row.timeToFirstContentMs >= 0
          ? row.timeToFirstContentMs
          : null;
      lastTimingRowFound = true;
    }
  }
  const completedSampleCount = Math.min(completedRates.length, 30);

  const contextWindow = input.usage.contextWindow;
  const contextUsedTokens = contextWindow?.usedTokens ?? null;
  const contextMaxTokens = contextWindow?.maxTokens ?? null;
  const contextRatio =
    contextUsedTokens !== null && contextMaxTokens !== null && contextMaxTokens > 0
      ? Math.min(1, contextUsedTokens / contextMaxTokens)
      : null;
  const cumulative = input.usage.cumulative;
  const cacheHitRate =
    cumulative.inputTokens > 0 ? cumulative.cacheReadTokens / cumulative.inputTokens : null;

  return {
    liveTokensPerSecond: live?.tokensPerSecond ?? null,
    estimatedTokens: live?.estimatedTokens ?? 0,
    streaming,
    contextUsedTokens,
    contextMaxTokens,
    contextRatio,
    cacheHitRate,
    lastTurnOutputTokens,
    lastCompletedTokensPerSecond,
    completedSampleCount,
    lastRequestDurationMs,
    lastTimeToFirstContentMs,
    provider: input.config.provider,
    model: input.config.model,
  };
}
