# Provider Registry 刷新缓存：订阅/建会话语义

状态：实现记录。日期：2026-10-30。

## 1. 背景

`perf.session_open_timing` 抓到一个冷打开：

```text
subscribeTotalMs=1989
hostPrepareMs=1949
providerRegistrySyncMs=936
cliRequestMs=40
```

`subscribeConversationV4` / `createSession` 每次都会调用
`ensureAccountProviderConfigSynced({ refreshRegistry: true })`。
即使 Account Config revision 已交付且 Registry 已重建，仍会再次发
`providerRefreshRegistry`，造成约 936ms 的重复全量重建。

## 2. 决策

- 新增 per-client `accountConfigRegistryRefreshedRevisionByClient` WeakMap，记录已成功 refresh 的 Account Config revision。
- 只有 `conversation_subscribe` / `session_create` 这两条 Account Config 顺序屏障可以复用：
  - 同一 client、同一 revision 且已成功 refresh → 跳过；
  - revision 变化 → 刷新并更新缓存。
- `v4_command`（模型切换等）**永远刷新**，不读缓存；模型配置变化必须重新建 Registry。
- refresh 失败不写缓存，下一次订阅/建会话会重试。
- 新 client（CLI 进程替换/新 workspace）没有缓存，第一次仍刷新一次。

## 3. 边界

- 缓存只表示“worker 已接收并应用过该 Account revision 的 Registry refresh”，不代表模型选择或其他 provider 配置无需刷新。
- 不改变 `providerUpdateAccountConfig` 的 revision 交付去重。
- 不改变 `v4_command` 的刷新时序。
- 不改变协议、持久化或 registry 内容。

## 4. 验收

- 同一 client、同一 Account revision 连续 `createSession`/conversation subscribe：`providerRefreshRegistry` 只调用一次。
- 模型切换（`v4_command`）即使 Account revision 未变，仍调用 `providerRefreshRegistry`。
- refresh 失败后下一次调用重试。
- 单测：`zcodeAgentService.providerRegistry.test.ts` 20 条通过。
- 运行态：`perf.session_open_timing.providerRegistrySyncMs` 从 936ms 降到 0–10ms；`hostPrepareMs` 从 1949ms 降到 2–3ms（缓存命中时）。

## 5. 非目标

- 不消除新 client / 新 workspace 的第一次 refresh。
- 不缓存 `v4_command` 的模型切换刷新。
- 不调整 provider registry 的内部构建算法。
