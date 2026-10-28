# 会话切换延迟：加载分层与优化选项

状态：诊断与提案，未实现。本文不是已批准的实现合同；进入代码改动前，按 `AGENTS.md` 先补对应 spec。

日期：2026-10-28

## 1. 结论

- 切换会话时的可感知等待，主要来自 renderer 重新建立会话数据层并等待首个 snapshot；不是“渲染了太多轮对话”。
- 界面只显示最近 3 个产品轮，这是**显示保留**，不是加载量，也不影响模型上下文。
- 当前分层是：显示 3 轮、首帧传输 60 行、Host 投影保留完整 active branch、模型上下文由 CLI runtime 单独维护。
- 可以优化，建议按风险从低到高：先扩大 renderer keep-warm 并加 LRU 上限；再根据 Host 计时决定是否消除冷打开时的重复投影重建；分页化 Host 投影属于架构级改动，暂不进入本轮。

## 2. 三层加载量与模型上下文

| 层         | 实际量                           | 代码依据                                                                                                                                                                                                                                                            |
| ---------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 界面显示   | 最近 **3 个产品轮**              | `DEFAULT_LIVE_TURN_LIMIT = 3`（`packages/ui/src/v4/conversationLiveRetention.ts:17`），主会话在 `SessionPane.tsx:748-753` 设置                                                                                                                                      |
| 首帧传输   | 最后 **60 行**                   | `PROTOCOL_V4_LIMITS.snapshotTailWindowRows`（`packages/shared/src/zcode-protocol-v4/core.ts:75`），publisher 在下发边界截断（`apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/conversation-topic-publisher.ts:352-375`）                                    |
| Host 投影  | **完整 active branch**           | `loadPersistedConversationMaterialization` 读全部 message/part 后按 revert/target 选分支（`apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/cold-event-merge.ts:56-121`）；投影内部保持全量，注释见 `conversation-topic-publisher.ts:346-350`                |
| 模型上下文 | **compact 后的 runtime history** | resume 时 `hydrateMessageHistoryFromSession` 灌入 runtime（`apps/zcode-cli/packages/core/src/runtime/methods/resume.ts:157-166`），`activeSessionMessages` 按 compact boundary 截断（`apps/zcode-cli/packages/core/src/agent/session-history-hydrator.ts:251-306`） |

因此：

- 3 轮裁剪只改 renderer 的 `rows.window`，更早的历史仍在 Host/SQLite，上滚时按 60 行/页经 `rows/range` 拉回（`conversationProjectionStore.ts:1232`）。
- 模型请求由 runtime 的 `MessageHistory` 构建（`apps/zcode-cli/packages/core/src/runtime/helpers/provider-request-messages.ts:50`），不读取 renderer 投影，所以界面只保留 3 轮不会影响上下文。
- 模型上下文的收缩由 compact 策略控制（默认 200K 窗口、32K output reserve、13K buffer，`apps/zcode-cli/packages/core/src/compact/policy.ts:6-14`），与界面显示几轮无关。
- 若要让模型上下文变小，应调整 compact 策略，而不是改 UI 显示轮数。

一个边界：snapshot 到达时会立即按 3 轮裁剪；后续 delta 只在视口跟随底部时继续裁剪。用户向上阅读期间窗口可以临时超过 3 轮，回到/接近底部后再收敛（`conversationProjectionStore.ts:451-457`、`913-917`）。

## 3. 切换时序

```text
点击任务
  |
  v
SessionPane 取 lease
  |
  v
SessionDataLayer.acquire
  |-- cold: 新建 ConversationProjectionStore + connect()
  `-- warm / keep_warm: 复用已有 store（已有 snapshot）
          |
          v
   conversation/subscribe
          |
          v
   Host: 会话 runtime 是否 live?
     |-- live: 复用已 hydrate 的 publisher
     `-- cold: cold resume + 全量投影 hydration
                （historyFirst 路径会先 hydrate 一次给历史，
                  runtime ready 后再 force rebuild 一次）
          |
          v
   首帧 snapshot（最多 60 行）
          |
          v
   renderer 裁到最近 3 个产品轮 -> 渲染
```

`SessionPane` 在新 lease 的 `snapshot.sessionId` 匹配前不会把旧投影交给 timeline（`SessionPane.tsx:4738-4744`，注释说明旧 lease 的滚动记忆不能串到新会话）。所以冷切换会先出现空白区，再等首帧到达后渲染；这段时间不是 React 渲染历史造成的。

## 4. 实测（2026-10-28）

数据源：`~/.zcode/v2/logs/2026-10-28.log` 的 renderer 生命周期日志。

- `v4.session_data.acquire`：不同 `openKind` 的 lease 数量。
- `v4.conversation.store.connect.completed.durationMs`：renderer 等待 subscribe ACK 的时间；与同 topic 的 cold acquire 配对。
- `v4.workspace_connection.created/reused`：workspace 连接是否复用。
- `v4.conversation.store.close.completed.durationMs`：store 关闭耗时。

| 指标                                                | 结果                                                       |
| --------------------------------------------------- | ---------------------------------------------------------- |
| acquire 总数                                        | 144                                                        |
| cold / warm / keep_warm                             | 108 / 9 / 27                                               |
| 涉及不同会话                                        | 17                                                         |
| cold 订阅 ACK 等待                                  | p50 217ms / p75 350ms / p90 535ms / p95 616ms / max 1082ms |
| 超过 200ms / 500ms                                  | 60/108 / 15/108                                            |
| 同会话相邻两次 acquire 间隔                         | n=127，p50 132s / p75 261s / p90 540s                      |
| 间隔 ≤ 30s                                          | 11/127（约 8.7%）                                          |
| workspace 连接 created / reused / keep_warm expired | 87 / 32 / 87                                               |
| store close                                         | p50 2ms / p90 14ms / max 124ms                             |

解读：

- 30 秒 keep-warm 只覆盖很小一部分重开；按间隔分布，大多数切换都会重新走 cold acquire。
- store 关闭只要几毫秒，不是瓶颈。
- 3 轮显示 + 60 行首帧意味着 renderer 的渲染量很小，等待发生在首帧到达之前。
- `connect.completed` 覆盖 transport、Host 等待与 ACK，不是纯 hydration 耗时；Host hydration 只有 `onDebug` 文本，没有落盘计时。
- 这些是单机、单日诊断数据，不是跨机器 SLA。

## 5. 根因分解

### 已确认

1. **keep-warm 窗口与使用节奏不匹配**：`SESSION_DATA_LAYER_KEEP_WARM_MS = 30_000`（`packages/ui/src/v4/sessionDataLayer.ts:31`），而实测同会话重开间隔中位数 132 秒、p75 261 秒，绝大多数重开都超出窗口。
2. **冷切换期间 timeline 为空**：`timelineSnapshot` 要求 `snapshot.sessionId === sessionId`，旧内容不能提前渲染（`SessionPane.tsx:4738-4744`），所以用户看到的是“点击 → 空白 → 新内容”。
3. **不是渲染量问题**：3 轮裁剪与 60 行首帧已经把 renderer 的派生和挂载量压得很小；store 关闭也只有毫秒级。
4. **冷打开存在两次全量投影重建**：`ensureHistoryReadyPublisher` 在 resume 前调用一次 `hydratePublisher(..., true)`，runtime ready 后再调用一次 `hydratePublisher(..., true)`（`apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/v4-gateway.ts:3111-3148`），两次都是 `forceRebuild = true`。

### 待验证

1. **每次 cold acquire 是否都会触发 Host 全量 hydration**：如果会话 runtime 仍 resident 且 publisher 已 hydrate，`hydratePublisher` 会直接复用（`v4-gateway.ts:3244`）；只有 runtime 被回收、进程重启或强制重建时才重跑。renderer 日志分不清这两种情况。
2. **两次 hydrate 的输入是否真的不同**：resume 在 `reusePersistedMessages` 路径下会复用第一次读取的 messages 数组，只有 `persistedMessagesReloadRequired`（compact 修补）时才重新读取（`apps/zcode-cli/packages/bootstrap/src/zcode-protocol/server-operations.ts:1561-1570`）。常见路径下第二次 hydrate 的输入与第一次相同，但中间新增的 runtime 事件（如 `SessionResumed`、mode 变化）可能需要以增量方式补进来，不能直接跳过。
3. **217ms 的构成**：目前 `openTiming` 已有 `hostPrepareMs / providerRegistrySyncMs / taskMetaReadMs / cliRequestMs / cliBootstrapMs / cliSessionRestoreMs / initialFrameEncodeMs`（`packages/services/src/zcode-agent/zcodeAgentService.ts:6117-6126`），但只在 ARMS 上报，本地日志看不到。需要先落一份低频聚合日志，才能判断是 Host hydration、runtime resume 还是 transport 占主导。

## 6. 优化选项

### 选项 A：扩大 renderer keep-warm，并加 LRU 上限（建议先做）

- 改动：`SESSION_DATA_LAYER_KEEP_WARM_MS` 从 30s 提到 5–10 分钟；`SessionDataLayer` 增加活跃 store 上限（例如 8 个），超出按最近使用淘汰。
- 收益：窗口内的切换直接复用已有 store 和 snapshot，不再 cold acquire，也不会出现空白等待。按当前间隔分布，5 分钟覆盖约 75%，10 分钟约 90%。
- 成本：最多 N 个后台订阅和 store；`ConversationRowPool` 已跨 store 共享行对象，但每个 store 仍持有自己的窗口和 UI 状态。需要测量 renderer 内存与后台帧处理 CPU。
- 风险：低。E2E 已有独立的 1 秒 keep-warm 常量（`sessionDataLayer.ts:32`），测试路径不受影响。
- 测试：新增 `SessionDataLayer` 单测，覆盖 keep-warm 命中、LRU 淘汰、refCount 归零后延迟关闭、E2E 常量覆盖。

### 选项 B：消除冷打开的重复投影重建

- 改动方向：resume 返回的 messages 与第一次 hydrate 的输入相同、且没有 `persistedMessagesReloadRequired` 时，不再 `forceRebuild` 整个投影；只把 resume 期间新增的事件按现有 raw sequence 机制增量 ingest 进来。
- 收益：每次冷打开少一次全量 replay。现有 cold hydration 文档记录大 fixture 的 `rehydrate` 约 0.26–0.38s；普通会话更小，但仍是纯 CPU 重复工作。
- 风险：中。必须证明 runtime initialization、`SessionResumed`、mode/config 种子和 live buffer 的最终 snapshot、row actions、rowId/seq/revision 与两次重建完全等价；compact 修补路径仍需完整重建。
- 前置：先完成选项 A 的观测，确认冷打开在用户实际路径中的占比和 Host 阶段耗时，再决定是否值得改。

### 选项 C：减少 session runtime 回收

- 现状：resident 池默认 target 8 / high-water 16 / idle 10 分钟（`apps/zcode-cli/packages/bootstrap/src/zcode-protocol/session-resident-pool.ts:7-9`）。如果 CLI 日志显示用户常用会话被频繁 deactivate，保持 resident 可以让 subscribe 直接复用 publisher（`v4-gateway.ts:3244`）。
- 收益：跳过 cold resume 与投影重建。
- 成本：内存和后台进程数；需要以 CLI `resident_deactivated` 日志和进程 RSS 为依据，不能只凭推测调大。

### 选项 D：保留旧 timeline + loading 叠层

- 思路：冷切换时先保留上一个会话的可见内容，用 loading 叠层提示正在切换，首帧到达后替换。
- 风险：高。滚动锚点、turn 身份和旧 lease 记忆串扰正是 `SessionPane.tsx:4738-4744` 当前要避免的问题，需要单独设计，不建议在 A/B 之前做。

### 选项 E：分页化 Host 投影

- 现状：publisher 的完整投影同时是 `rows/range` 数据源和 rowId/action 锚点来源（`conversation-topic-publisher.ts:346-350`），不能简单只加载 3 轮。
- 若要支持真正的按页投影，需要新的分页投影/索引设计和迁移；现有 cold hydration 文档已把 projection checkpoint / lazy rows 标为后续架构阶段（V4HYD-07）。
- 即使完成，模型 resume 仍要读取完整 active branch，省不掉上下文恢复成本。本轮不建议进入。

## 7. 不影响上下文的边界

- 本文所有优化都只改 renderer 的视图保留与订阅生命周期，不改 wire schema、不改持久化、不改 delivery profile、不改 runtime `MessageHistory`。
- 选项 A 只影响“界面多久复用已有投影”；选项 B 只影响“Host 投影重建几次”；两者都不改变模型实际收到的消息。
- 会改变上下文的行为是：裁剪 `activeSessionMessages` 返回的 runtime history、修改 compact boundary/策略、或在 runtime 侧丢弃历史。这些都不在本提案范围内。

## 8. 观测与验收

### 观测

1. **Host hydration 生命周期日志**：按现有 cold hydration 合同，只新增一条聚合事件（不要逐 event 打 info），至少包含 `messages/parts` 数、`mergeMs`、`rehydrateMs`、`hydrateCount`（1 或 2）、`snapshotRows`、`initialFrameBytes`。
2. **renderer 侧**：keep-warm 命中率、cold ACK p50/p90、从 lease 到首个可见 row 的时间。现有 `openTiming` 已能提供 Host/CLI 子阶段，只需在本地诊断开关下落盘。
3. **资源**：keep-warm 数量、renderer heap、后台帧处理 CPU。

### 验收

- 选项 A：代表性使用日内 keep-warm 命中率明显上升，cold ACK 次数下降；store 数量不超过上限；切换后首帧内容、3 轮窗口和滚动行为无回归。
- 选项 B：严格快照 deep-equal（rows、actions、command targets、seq/revision），compact 修补路径仍走完整重建，live 事件不丢不重。
- 任何选项都不得改变 `rows/range` 分页、rowId 锚点、分享选择、rewind 预览和 turn navigator 的现有语义。

## 9. 建议切片

1. **切片 1（低风险）**：keep-warm 5–10 分钟 + LRU 上限；补单测；用同一份日志对比 cold 比例与 p90。
2. **切片 2（观测）**：补 Host hydration 聚合计时，确认 217ms 里 hydration 的真实占比。
3. **切片 3（视数据决定）**：如果冷打开仍占主导且第二次 hydrate 输入相同，做选项 B 的增量重建；否则优先看 resident 策略。
4. 选项 D/E 单独立项，不与前三个切片混做。

## 10. 未决问题

- keep-warm 上限取多少：固定 8 个，还是按窗口/内存动态调整？
- 窗口隐藏或系统休眠时是否继续保留订阅？后台订阅会持续接收 delta。
- running 中的会话是否应无条件保留，避免用户切回时中断观感？
- 选项 B 需要确认 resume 期间新增事件的增量路径是否已经覆盖所有 runtime initialization 语义。
- 现有 `v4-conversation-cold-hydration.md` 已详细记录 Host 投影算法与历史性能数据，本文只补充“会话切换 / keep-warm / 重复重建”这一层，不重复其测量。
