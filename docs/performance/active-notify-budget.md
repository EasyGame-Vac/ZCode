# Active 会话通知预算：最小 rAF 间隔

状态：实现记录。日期：2026-10-30。

## 1. 背景

`perf.renderer_summary` 显示 active store 的 `conversationProjectionStore.flush` 仍是最大热点：单段 10 秒窗口可达 2.66 秒，其中 1.47 秒是强制样式/布局。desktop publisher 每 30ms 一帧，store 用 rAF 合帧，实际仍接近 33fps 地触发 React 提交；而流式 Markdown 的提交间隔已经是 50–150ms，很多渲染帧没有可见文本变化。

## 2. 决策

- 只有主会话 `SessionPane` 设置 `setNotificationMinIntervalMs(48)`；其他 store 保持现状。
- `ConversationProjectionStore` 在 rAF flush 时检查距上次 flush 的时间：
  - 首次 flush 不等；
  - 小于最小间隔时跳过本次 React 通知，继续预约下一帧；
  - 达到间隔后 flush，并记录本帧结束后的时间。
- `apply` 仍然每帧执行，不改变数据/seq；只降低 React listener 通知频率。
- `setNotificationCoalescing(false)`/`close()` 仍走立即 flush/cancel 路径，不受最小间隔影响。
- 没有 rAF 的环境退回 timer 等待剩余间隔，避免饿死。

## 3. 边界

- 最小间隔只影响 active 主视图的 listener 通知，不影响 keep-warm 队列、协议、持久化或 Host。
- 拖拽/滚动等高频交互仍由本地 UI 状态驱动；会话控制状态最多延迟 48ms。
- 最后一次状态一定会在间隔到达后的下一帧送达，不会丢终态。

## 4. 验收

- 主会话流式时，通知频率从每帧约 33fps 降到约 20fps；`flush` 总耗时和长帧数下降。
- 首次通知不延迟；连续帧不会把最终状态丢掉。
- 关闭合帧/关闭 store 时立即取消或 flush。
- `shouldDeferConversationNotify` 边界单测：首次、未到间隔、恰好到间隔、间隔为 0。

## 5. 非目标

- 不拆分 SessionPane 订阅。
- 不改变 publisher 帧率、store apply 或 Markdown 提交节奏。
- 不做滚动/布局专项优化；如果 flush 仍高，下一轮再处理强制布局。
