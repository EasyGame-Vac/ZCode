# Keep-warm store 降载：后台帧合并与延后 apply

状态：实现记录。日期：2026-10-30。

## 1. 背景

`perf.renderer_summary` 显示运行期 `projection.stores` 经常为 2–6，`MessagePort.onmessage` 每 10 秒占用 0.8–2.8 秒。原因是 `SessionDataLayer` keep-warm 的 store 在 refCount 为 0 后仍逐个消费 delta 帧：每帧 apply、构造 snapshot、走通知路径，即使没有任何 React/插件消费者。

main 会话的 3 轮裁剪和通知合帧只减少渲染，不减少后台 store 的 apply/派生成本。

## 2. 决策

1. `SessionDataLayer` 是 keep-warm 的唯一 owner：
   - acquire（新 store 或复用）时调用 `store.setKeepWarm(false)`；
   - refCount 归零时调用 `store.setKeepWarm(true)`。
2. `ConversationProjectionStore` 在 `keepWarm && 无任何消费者` 时不再逐帧 apply，而是把帧放入有界队列：
   - 消费者包括 React `listeners`、`liveDeltaListeners`、`modelTransitionListeners`；
   - 队列按到达顺序保存帧和 delivery；
   - 相邻且同 subscription、seq 连续的 online delta 帧合并成一个 delta 帧；
   - snapshot/recovery/非连续帧保持独立顺序处理。
3. 队列在以下时机同步 flush：
   - `setKeepWarm(false)`（重新 acquire）；
   - 新 listener 注册（`subscribe` / `onLiveDeltas` / `onOnlineModelTransition`）；
   - 队列达到上限（120 帧）；
   - 每 1 秒的定时 drain。
4. flush 时设置 `processingBackgroundFrames`，避免 `handleFrame` 再次入队。
5. 活跃 lease（refCount > 0）的 store 行为完全不变：仍然逐帧 apply/notify。

## 3. 所有权与边界

- `SessionDataLayer`：决定 store 是否处于 keep-warm；只增删 `refCount`，不复制帧。
- `ConversationProjectionStore`：队列、合并、定时器和 flush 的唯一 owner；不改变 wire schema、持久化、恢复规则。
- 队列有上限；溢出立即 flush，不无限缓存。
- `close()` 清空队列和定时器；evict/keep-warm 过期走同一 close 路径。
- 不改变活跃 store 的 apply 顺序、seq 水位、recovery 判定和通知语义。

## 4. 验收

- keep-warm 期间收到 delta，state 不立即变化；重新 acquire 后同步 flush，`getState()` 已包含这些帧。
- 连续 online delta 合并后只做一次 `applyConversationDeltas`，seq 推进到最后帧 `toSeq`。
- 活跃 lease 期间 emit 后仍立即更新 state（现有测试保持通过）。
- 队列超过 120 帧立即 flush，不无限增长。
- `close()` 后不再有后台定时器或帧处理。

## 5. 非目标

- 不批量化 transport/MessagePort 的解码和校验（后续独立优化）。
- 不改 publisher 的 30ms/150ms 打帧。
- 不改变 keep-warm 时长或 8 个 store 上限。
