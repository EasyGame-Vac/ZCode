# 流式渲染预算：切片 1–2a（分享派生、插件 UI 目录、Markdown 提交节奏、通知合帧）

状态：切片 1、2a 实现记录。日期：2026-10-28。

本文只覆盖 renderer 的派生与提交流程，不改变 wire schema、持久化、模型上下文或会话状态所有权。

## 1. 背景与证据

源码 dev 窗口在 4 个会话同时流式时出现明显卡顿，实测：

- 主 renderer 活动时单核 CPU 超过 100%，rAF p95 100ms、最大 333ms。
- 内存不是主因：`projection.rows` 只有 94–349，`projection.stores` 1–4；安装版生产 renderer 的堆（约 686MB）反而高于 dev（约 528MB）。
- publisher 已经按 desktop 30ms / replayable 150ms 打帧，store notify 已经按 rAF 合帧，Markdown 提交已经有 50ms 节流，因此继续加节流不是正确方向。
- 每帧仍有以下无效工作：
  - `SessionPane` 在分享面板关闭时仍构建分享用的 turn render units 和 share items（`packages/ui/src/v4/SessionPane.tsx:826-848`）。
  - 插件 UI 目录每帧用 `turnOrder.includes` 去重，复杂度 O(rows×turns)（`packages/ui/src/plugin-ui/domain/pluginUiInstancePolicy.ts:60-63`）。
  - 流式 Markdown 固定 50ms 提交全文；预处理与 lex 是 O(text length)，长回答累计 O(L²)（`packages/ui/src/components/ai-elements/message.tsx:1315-1349`）。
- 切片 1 后对 dev renderer 做 8 秒 CPU profile：主线程热点不是 Markdown，而是每帧的 rAF flush（25–91ms，其中 29–66ms 是强制样式/布局），以及一帧内多条 `MessagePort.onmessage`（每条 12–46ms）。后者说明非主视图 store 仍在消息回调里同步通知 React。

## 2. 目标

1. 分享 UI 关闭时，不构建分享专用派生数据；打开分享面板后首帧仍能拿到完整数据。
2. 插件 UI 目录去重从 O(rows×turns) 降为 O(rows)，保持首次出现顺序、最近 N 回合 autoExpand 语义不变。
3. 流式 Markdown 提交间隔随正文长度自适应；完成态仍立即提交最终全文。
4. 所有 UI conversation store 在 `SessionDataLayer` 统一开启通知合帧；消息回调内不直接触发 React 渲染。

## 3. 非目标

- 不改 publisher 的 30ms/150ms 帧窗口；不改 store 的状态读写语义，只合帧 listener 通知。
- 不改 Streamdown 的 streaming/static 模式选择。
- 不做隐藏 pane 降载、keep-warm 零 listener 早退、webview 回收、全量历史目录、可变 apply；这些属于后续切片。

## 4. 不变量与所有权

- `SessionPane` 本地 memo 仍是分享派生数据的唯一 owner；store、protocol 和 Host 不新增状态。
- `deriveLogicalUiInstances` 仍是纯函数，继续遵守 domain 不使用 Map/Set 的模块约束；用普通对象做 O(1) 去重。
- `useStreamingMarkdownCommit` 仍是 renderer 本地节流；最终提交的文本必须与输入完全一致，完成态不延迟。
- store 状态读写仍同步；合帧只延迟 listener 通知，不延迟 `getState()`。`close()` 必须取消未触发的通知。

## 5. 验收场景

- 分享关闭：滚动/流式更新时不调用 `buildConversationShareItems`；打开分享面板首帧能看到完整条目，选择/预检行为不变。
- 插件 UI 目录：同一 turn 的多行只产生一个 turnOrder 条目；顺序与优化前逐项一致；最近 N 回合的 autoExpand 结果不变。
- 流式 Markdown：正文 <16k 字符保持 50ms 提交；16k–48k 为 100ms；≥48k 为 150ms；流式结束立即提交全文。
- 通知合帧：一个 store 在同一个消息回调里多次 `setState` 只通知一次；close 后不再收到通知；`getState()` 立即可读。

## 6. 验证

- 单测：`resolveStreamingMarkdownCommitIntervalMs` 边界；`deriveLogicalUiInstances` 顺序/去重/autoExpand；`SessionDataLayer` 通知合帧（消息回调内不同步通知、下一帧只通知一次、状态同步可读）；现有 `conversationShareItems` 测试保持通过。
- 性能：dev 窗口 9229 CDP 固定场景（宽屏 + 长回答 + 2–4 个会话并发），对比 rAF p95、`TaskDuration`、`LayoutCount`；同时读 `projection.stores/rows` 与 renderer heap。
- 回归：`corepack pnpm typecheck`、`corepack pnpm lint`、`corepack pnpm architecture:check --changed`。

## 7. 后续切片

1. keep-warm/零 listener store 只记 seq 水位；隐藏 pane 降载；SessionPane 高频订阅下沉。
2. webview 回收与 live-guest 预算；隐藏 MCP 页 capture 泵降频/停止。
3. turn navigator 轻量目录、可变 apply、publisher 增量字节记账。

## 8. 切片 2a 实测（2026-10-28）

同一台机器、同一个 dev 窗口，2 个会话持续流式时：

- renderer 单核 CPU 从约 27% 降到约 7%，app-server 从约 21% 降到约 8%。
- 页面内新建 `long-animation-frame` observer 连续采样 8 秒，记录到 0 个 >50ms 长帧。
- 改动前同一窗口 8.7 秒内记录到 12 个 54–175ms 长帧，热点是 `MessagePort.onmessage`（12–46ms/条）和 `conversationProjectionStore.flush`（25–91ms，其中 29–66ms 强制样式/布局）。

注意：两次采样的并发会话数与后台负载不完全相同，因此这是方向一致的观测，不是严格受控的 A/B 基准。
