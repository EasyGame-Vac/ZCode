# Renderer 卡顿追踪：切换首帧、长帧与慢通知

状态：实现记录。日期：2026-10-30。

## 1. 背景

源码 dev 窗口反馈“切换会话卡、运行也卡”。现有日志能记录 acquire/connect/close 生命周期，但缺少用户感知的“点击到首帧”耗时、运行期长帧和 renderer 内 React/store 慢路径。生产 renderer 日志默认禁用，因此追踪只在 dev（logger 开启）生效。

## 2. 事件与阈值

| 事件                            | 级别 | 触发                                            | 关键字段                                                                                                          |
| ------------------------------- | ---- | ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `perf.session_switch`           | info | 每次 lease 切换后首个有内容的 snapshot 完成一帧 | `openKind`、`acquireToSnapshotMs`、`snapshotToFrameMs`、`totalMs`、`rows`、`hiddenTurnCount`、`visibility`        |
| `perf.session_open_timing`      | info | 每次 V4 conversation subscribe                  | `sessionId`、`historyFirst`、`hasBase`、`subscribeTotalMs`、`hostPrepareMs`、`cliRequestMs`、CLI ack `openTiming` |
| `perf.renderer_summary`         | info | 每 10s 有长帧，或每 60s 心跳                    | 长帧数、`max`/`p95`/`blocking`、top scripts/invokers、DOM/webviews/animations、heap、projection 计数、visibility  |
| `perf.renderer_long_frame`      | warn | 单个 LoAF ≥200ms，5s 内最多一条                 | duration、blocking、top 3 scripts、visibility                                                                     |
| `perf.conversation_notify_slow` | info | store listener 通知 ≥32ms，每 store 2s 最多一条 | topic、listeners、rows、durationMs                                                                                |
| `perf.conversation_apply_slow`  | info | delta apply ≥8ms，每 store 2s 最多一条          | topic、deltas、windowRows、durationMs                                                                             |
| `perf.history_rows_slow`        | info | `rows/range` ≥100ms                             | beforeRowId、limit、rows、durationMs                                                                              |
| `perf.visibility_change`        | info | 页面 visibility 变化                            | visibility、timestamp                                                                                             |

## 3. 所有权与边界

- 追踪模块只读 renderer 指标，不改变 store、protocol、持久化或 UI 状态。
- `perf.session_open_timing` 由 services 侧订阅入口记录（每次 subscribe 一条），用 sessionId/topic 与 renderer 的 `perf.session_switch` 对齐。
- `perf.session_switch` 以 lease 的 `startedAt` 为起点，首个可见 snapshot 的下一帧为终点；没有内容（草稿/空会话）不记录。
- 长帧通过 `PerformanceObserver` 的 `long-animation-frame` 获取；不支持时退回 `longtask`。
- 日志通过 `@/logger.js` 的 info/warn 出口；生产构建 renderer 日志禁用的前提下，追踪启动直接 no-op。
- 所有高频事件都按 store/进程限频；日志不包含消息正文、工具输入输出或凭据。

## 4. 验收

- 在 dev 窗口切换两个有内容的会话，主日志各出现一条 `perf.session_switch`，且 `totalMs` 可对应主观等待。
- 连续滚动/流式运行时，每 10s 有长帧则出现 `perf.renderer_summary`；≥200ms 的单帧出现一条 `perf.renderer_long_frame`，不会刷屏。
- 慢 React 通知出现 `perf.conversation_notify_slow`；慢 delta apply 出现 `perf.conversation_apply_slow`。
- 历史抽屉翻页慢请求出现 `perf.history_rows_slow`。
- 无消息正文/工具内容/凭据进入日志。

## 5. 非目标

- 不改协议、持久化或性能 HUD。
- 不常驻开启 CPU profiler/heap snapshot。
- 不尝试自动修复；先收集本地日志证据。
