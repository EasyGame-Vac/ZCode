# 历史抽屉：服务端分页 + 正文同款排版

状态：实现记录。日期：2026-10-28。

## 1. 背景

“更早的 N 轮”当前打开独立的历史抽屉，但数据走 legacy `session/messages`：

- renderer 首次打开读取最后 30 条；Host 每次先 `sessionStore.messages()` 读出整段会话再切片（`server-operations.ts:2008-2027`）。
- 本地读很快时看不到 loading；dev 日志实测 11.8ms / 26.8ms。
- 同一挂载期内再次打开不会重新请求（原 `useConversationHistory.ts:75-86` 的 `loadedSessionRef`，该 hook 已删除），可能看到旧内容。
- 抽屉用 `<details>` + JSON 展示工具，和主会话的行排版不一致。

## 2. 决策

1. 历史抽屉改用 V4 `rows/range` 分页：以当前 live 窗口首行的 `rowId` 为游标，每次向 Host 请求一页（60 行）`ConversationRow`。
2. `ConversationProjectionStore` 增加只读 `queryRowsPage({ beforeRowId, limit })`，校验 `atLogEpoch`，不修改 live snapshot、不新增订阅。
3. 抽屉只持有自己的行列表；首次打开用 live 窗口作为种子，再加载一页更早的行；“加载更早消息”继续按最老 `rowId` 取下一页。
4. 抽屉内容直接渲染 `ConversationShareReadonlyTimeline`，复用主会话/分享页的 turn 分组、Markdown、tool presentation 和 artifacts 排版。
5. 不再从抽屉调用 `readSessionMessages`；renderer 的 `useConversationHistory` 已删除，`session/messages` 协议保留给其他消费者。

## 3. 所有权与边界

- `ConversationProjectionStore`：transport、`logEpoch`、live snapshot 的唯一 owner；`queryRowsPage` 只读。
- `ConversationHistoryDrawer`：分页列表、loading/error/hasMore 的本地 owner；不写 store，不影响 live retention。
- 行顺序按 `rowId` 升序；分页结果按 `rowId` 去重后前插。
- 事件顺序：打开抽屉 → 用 live 窗口首行作游标 → `rowsRange` → 合并渲染；关闭抽屉不改变主时间线。

## 4. 验收

- 打开抽屉只发 `rows/range`，不再发 `session/messages`。
- 首次打开能看到 live 窗口 + 一页更早历史；`hasMore` 正确。
- 加载更早时只前插新行，不重复、不丢行；滚动位置保持可读。
- 抽屉使用与正文相同的 turn/row 组件；不再出现工具 JSON 的 `<details>` 原始展示。
- 关闭后重新打开会重新取当前 live 窗口作为种子，不展示旧缓存。

## 5. 非目标

- 不改 live timeline 的 3 轮保留、订阅或流式渲染。
- 不改 `session/messages` 协议和其他消费者。
- 不引入抽屉虚拟滚动；单页 60 行，按需加载。

## 6. 验证

- 单测：`queryRowsPage` 请求参数、`logEpoch` 不匹配、返回 `hasMore`；分页合并去重。
- UI/手工：长会话打开抽屉、连续加载 2–3 页、关闭重开；确认排版与正文一致。
- 回归：`pnpm typecheck`、`pnpm lint`、`pnpm architecture:check --changed`。
