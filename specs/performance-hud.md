# 性能浮层（PERF HUD）统计口径

- 状态：Draft
- 日期：2026-10-27
- 范围：`packages/ui` PerformanceHud、`packages/services` usage-stats、`apps/zcode-cli` usage query
- 关联文档：
  - `specs/conversation-live-planes.md`
  - `docs/desktop/local-dev-launch.md`

## 1. 背景

Performance HUD 的窗口吞吐原先从当前会话 projection 的 `rows.window` 派生：遍历 `turnHeader`，用
`endedAt ?? startedAt` 判断整轮是否落在窗口内，再把整轮累计的 `outputTokens` 和
`modelOutputDurationMs` 相加。它有两个结构性问题：

1. 锚点是「整轮的结束/开始时刻」，而一个 agent 轮包含几十次模型请求和工具等待，常持续十几分钟。
   正在运行的轮只能退化为 `startedAt`，于是一个 11 分钟前开始、仍在生成的轮不会进入 1m/5m 窗口；
   上一轮又常常在 5 分钟前就已结束。结果是短窗口长期为空，只有 15m 以上才偶尔命中整轮。
2. 粒度是整轮累计。即使命中窗口，分子分母也包含窗口之外生成的 token 和时长，窗口标签与实际覆盖时段不一致。

同时，`rows.window` 只保留最近 3 个产品轮（`DEFAULT_LIVE_TURN_LIMIT = 3`），1h/3h 等长窗口也不可能看到
更早的历史。吞吐是模型/供应商的属性，不是单个会话的属性；按会话聚合既缺样本又不可比。

## 2. 产品规则

### 2.1 归属

- 吞吐与延迟按 `provider_id + model_id` 聚合，覆盖当前 CLI 数据目录内**所有会话**。
- v1 不按 `variant`（推理档位）、agent、mode 拆分；`query_source` 只取 `main_turn`，子代理请求不计入。
- 会话只负责解释「当前这一轮」的事实：流式实时估算、上下文水位、本会话累计缓存命中、上次输出、
  最近一次请求的首字/请求耗时。

### 2.2 窗口

- 可选窗口：`1m / 5m / 15m / 30m / 1h / 3h / 24h`；移除「本会话」。
- 窗口成员：`started_at ∈ (windowEnd - windowMs, windowEnd]` 的已完成模型请求。
- `windowEnd` 由 CLI 时钟在查询时确定；Renderer 只传 `windowMs`，不得用本地时钟与协议时间戳相减。
- 窗口查询上限 24h，走现有 `model_usage_started_model_idx (started_at, provider_id, model_id)`，
  不新增表、索引或迁移。

### 2.3 样本

一条请求只有在全部满足时才算速率样本：

- `query_source = 'main_turn'`
- `status = 'completed'`
- `first_token_at` 非空，且 `completed_at > first_token_at`
- `output_tokens > 0`
- 生成时长 `completed_at - first_token_at >= 300ms`
- 单请求 TPS `output_tokens * 1000 / generationMs <= 20000`

错误、取消、无首 token、以及过短或明显异常的请求不参与加权速率与百分位，但它们的 input/cache
token 仍计入窗口缓存命中。

### 2.4 指标

| 指标 | 公式 |
| --- | --- |
| 加权 TPS | `Σ output_tokens * 1000 ÷ Σ(completed_at - first_token_at)` |
| 首字 P50/P90 | 单请求 `coalesce(time_to_first_token_ms, first_token_at - started_at)` 的线性插值百分位 |
| 请求 P50/P90 | 单请求 `duration_ms` 的线性插值百分位 |
| 缓存命中 | `Σ cache_read_input_tokens ÷ Σ input_tokens`（窗口内全部 completed 主轮请求） |

百分位使用与 `packages/ui/src/v4/conversationTurnWorkSegments.ts` 现有 `percentileOf` 相同的线性插值口径。

### 2.5 显示

- 窗口块与窗口 P50/P90 使用模型级请求样本；副标题必须写明作用域（「全设备 · N 次请求 · X tokens」），
  避免被误读为当前会话。
- 顶部大数字：生成中仍是流式估算；空闲时仍是当前会话最近一次请求的精确速率。
- 「首字 / 请求」两行仍是当前会话最近一次请求的精确值。
- 无样本时窗口速率与百分位显示 `—`，副标题沿用「等待首个完成请求」。

## 3. 所有权与数据流

```text
PerformanceHud (packages/ui/src/v4/SessionPane.tsx)
  │  provider/model + windowMs + enabled
  ▼
useModelRequestRate (packages/ui/src/hooks/useUsageStats.ts)
  │  2s 轮询，旧响应按 requestVersion 丢弃
  ▼
IUsageStatsService.getModelRequestRate (packages/services/src/usage-stats)
  ▼
IZCodeAgentService.getModelRequestRate (packages/services/src/zcode-agent)
  │  取一个可复用的 active workspace client
  ▼
v4/usage/model-rate  (packages/shared/src/zcode-protocol-v4/transport.ts)
  ▼
ZCodeProtocolAgentServer dispatch (apps/zcode-cli/packages/bootstrap)
  ▼
UsageStorePort.queryModelRequestRate (apps/zcode-cli/packages/adapters)
  ▼
model_usage 表（CLI 时钟，跨会话）
```

唯一事实源是 CLI 的 `model_usage` 表。Renderer 不缓存样本，不把请求样本写进 conversation snapshot，
也不改变 `rows.window` 的 3 轮裁剪策略。

## 4. 不变量

- 协议只传时长（`windowMs`），不传客户端时间戳；`windowStart`/`windowEnd` 只用于回显与诊断。
- `getModelRequestRate` 是 `IUsageStatsService` 的可选方法：旧 host 或测试 double 缺该方法时，
  HUD 显示 `—`，不得抛错或回退到「按会话整轮」的旧口径。
- 查询失败保留上一份成功快照，避免浮层在轮询间隙闪烁；首次查询失败显示 `—`。
- `query_source = 'main_turn'` 是硬过滤，子代理与后台请求不得污染模型速率。
- HUD 仍只在 `sessionId && snapshot && !readOnly && !compactForRemoteControl` 时挂载。

## 5. 验收场景

1. **长轮中短窗口有数**：一个 agent 轮已运行 11 分钟、期间完成数十次请求时，切到 1m/5m 应基于最近
   一分钟内完成的请求显示加权速率与样本数，不再显示「等待首个完成请求」。
2. **跨会话聚合**：同一 provider/model 在另一会话完成请求后，当前会话的 1m 窗口速率随之更新。
3. **过滤**：子代理、错误、取消、无首 token、生成时长 < 300ms 的请求不影响加权速率；缓存命中仍统计
   其 input/cache token。
4. **窗口切换**：1m/5m/15m/30m/1h/3h/24h 分别按 `windowMs` 查询；移除「本会话」选项。
5. **降级**：host 侧没有 `getModelRequestRate` 时窗口块显示 `—` 且无错误抛出；查询失败保留上次值。
6. **会话事实不变**：上下文、缓存命中、上次输出、上次请求的首字/耗时仍来自当前会话 projection。

## 6. 验证

```bash
pnpm exec vitest run packages/shared/test/zcodeProtocolV4Usage.test.ts
pnpm exec vitest run packages/ui/test/conversationLiveOutputSpeed.test.ts packages/ui/test/usageStatsAccessRefresh.test.ts
pnpm --filter @zcode/adapters exec vitest run tests/usage-query.test.ts
pnpm --filter @zcode/bootstrap exec vitest run tests/zcode-protocol.test.ts
pnpm --filter @zcode/core exec vitest run tests/runtime-persistence.test.ts
pnpm exec vitest run packages/services/test/usageStatsService.test.ts
pnpm typecheck
pnpm lint
pnpm architecture:check --changed
```

手工验收：重建 CLI（`node scripts/build-desktop-agent-cli.mjs`）并重启源码窗口后，打开 HUD 切到 1m/5m
应立即出数；可用 token-speed 插件的 tokrate 以 `--session all --since 5m --provider <id> --model <id>`
对照加权速率。