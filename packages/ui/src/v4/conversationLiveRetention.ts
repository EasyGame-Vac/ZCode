// 会话 live 视图的有界保留策略（纯函数，无 React/DOM 依赖）。
//
// 背景：conversation projection 的 rows.window 会随 row.appended / loadOlder 单调增长，
// 长会话里每帧的全量派生工作随之线性上涨。产品规则是主视图只保留最近 K 个产品轮，
// 历史仍留在 SQLite / Host 投影里，需要时再分页读取。
//
// 裁头只改变 window：firstRowId 仍是 active branch 第一行，totalCount 仍是 branch 总行数，
// 因此 hasOlderRows / rowsRange 游标语义不变。对已裁掉行的 row.delta / row.upserted
// 在 apply.ts 中本来就是 no-op。
import type {
  ConversationDelta,
  ConversationRow,
  ConversationSnapshot,
} from "@zcode/shared/zcode-protocol-v4";

/** 主视图默认保留的产品轮数；可用 setLiveTurnLimit 覆盖，null 表示不裁剪。 */
export const DEFAULT_LIVE_TURN_LIMIT = 3;

export interface LiveRetentionTrim {
  /** 裁剪后的窗口；调用方负责放入新 snapshot。 */
  window: ConversationRow[];
  /** 被裁掉的完整产品轮数，用于“更早的 N 轮”提示。 */
  removedTurns: number;
}

/**
 * 从窗口头部裁掉较早的产品轮，只保留最近 turnLimit 个**产品轮**。
 *
 * 一个 turnId 不一定是产品轮：background result、subagent 汇总、workflow 通知、
 * compaction marker 等可以各自形成 timeline-only / controlOnly 轮。它们不占 K，
 * 但只要位于最老保留产品轮之后，就随窗口一起保留，避免把当前工作的控制项裁掉。
 *
 * 返回 null 表示无需裁剪。rows 必须按时间顺序排列（projection window 的既有约束）。
 * 没有任何产品轮（例如纯后台/子智能体会话）时退化为按 turnId 计数的旧规则，保证有界。
 */
export function trimRowsToRecentTurns(
  rows: readonly ConversationRow[],
  turnLimit: number,
): LiveRetentionTrim | null {
  if (turnLimit <= 0 || rows.length === 0) return null;

  interface TurnGroup {
    turnId: string;
    start: number;
    /** turnHeader 的裁决：true=产品轮，false=控制轮，null=该轮没有 turnHeader。 */
    headerProduct: boolean | null;
    hasRealUser: boolean;
  }

  const groups: TurnGroup[] = [];
  let current: TurnGroup | null = null;
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index]!;
    if (current === null || current.turnId !== row.turnId) {
      current = {
        turnId: row.turnId,
        start: index,
        headerProduct: null,
        hasRealUser: false,
      };
      groups.push(current);
    }
    if (row.kind === "turnHeader") {
      // 控制轮不占 K：workflow 直接启动、background result 和显式 controlOnly
      // 都不是用户眼里的产品轮。
      current.headerProduct =
        row.executionKind !== "controlOnly" &&
        row.origin !== "backgroundResult" &&
        row.origin !== "workflowLaunch";
    } else if (row.kind === "userInput" && row.origin === "realUser") {
      current.hasRealUser = true;
    }
  }

  const isProductGroup = (group: TurnGroup): boolean =>
    group.headerProduct ?? group.hasRealUser;
  const productGroups = groups.filter(isProductGroup);
  if (productGroups.length === 0) {
    // 没有产品轮时不能无限保留控制轮；沿用 turnId 计数保证窗口有界。
    return trimRowsByTurnId(rows, turnLimit);
  }
  if (productGroups.length <= turnLimit) return null;

  const firstKeptProduct = productGroups[productGroups.length - turnLimit]!;
  const cutIndex = firstKeptProduct.start;
  if (cutIndex === 0) return null;
  return {
    window: rows.slice(cutIndex),
    // “更早的 N 轮”按产品轮计数；控制轮不参与提示数字。
    removedTurns: productGroups.length - turnLimit,
  };
}

/** 旧规则：按 turnId 计数。仅用于没有产品轮的控制型窗口。 */
function trimRowsByTurnId(
  rows: readonly ConversationRow[],
  turnLimit: number,
): LiveRetentionTrim | null {
  let seenTurns = 0;
  let lastTurnId: string | null = null;
  let cutIndex = 0;
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const turnId = rows[index]!.turnId;
    if (turnId !== lastTurnId) {
      seenTurns += 1;
      lastTurnId = turnId;
      if (seenTurns > turnLimit) {
        cutIndex = index + 1;
        break;
      }
    }
  }
  if (cutIndex === 0) return null;

  let removedTurns = 0;
  let removedTurnId: string | null = null;
  for (let index = 0; index < cutIndex; index += 1) {
    const turnId = rows[index]!.turnId;
    if (turnId !== removedTurnId) {
      removedTurns += 1;
      removedTurnId = turnId;
    }
  }
  return { window: rows.slice(cutIndex), removedTurns };
}

/**
 * rewind 目标落在“已裁掉/未加载的头部”时，客户端无法从当前窗口算出新的 window 和
 * totalCount：所有已加载行都会被 row.removed 删掉，但真正应保留的早期行不在手里。
 * 这种情况必须请求 snapshot recovery，而不是本地应用 delta。
 *
 * 边界：fromRowId <= firstRowId 表示整条 active branch 都被截断，本地 apply 可正确清空；
 * fromRowId > 已加载首行时目标仍在窗口内，本地 apply 也正确。
 */
export function rewindsIntoUnloadedHead(
  snapshot: ConversationSnapshot,
  deltas: readonly ConversationDelta[],
): boolean {
  const firstRowId = snapshot.rows.firstRowId;
  const headRowId = snapshot.rows.window[0]?.rowId;
  if (firstRowId === null || headRowId === undefined) return false;
  return deltas.some(
    (delta) =>
      delta.op === "row.removed" && delta.fromRowId > firstRowId && delta.fromRowId <= headRowId,
  );
}
