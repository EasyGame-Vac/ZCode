# 对话中的实时 Token 速度

> **状态：当前实现规范。** 用于描述运行中助手轮次底部展示的输出 token 速度指示器。

## 目标

生成过程中让用户看到当前模型输出的粗略速度（tokens/s），用于判断响应是否在正常推进，而不是只有旋转 loading。

## 非目标

- 不替代开发者工具里的精确 TPS。后者读取 CLI 持久化的 `model_request_completed`，只在请求结束后可用。
- 不新增协议字段，不修改 CLI 的 usage 事实源，不持久化速度值。
- 不把估算值展示成计费或最终用量；最终用量仍以 provider 在请求结束时返回的 usage 为准。

## 展示规则

- 位置：运行中轮次底部的 loading slot，紧挨 `ChatLoading` 旋转图标。
- 文案：中文 `约 {tps} tok/s`，英文 `~{tps} tok/s`；`tps ≥ 1` 时最多保留 1 位小数，`tps < 1` 时保留 2 位。
- 悬停说明：明确“根据流式正文估算；最终用量以请求结束后的服务端统计为准”。
- 仅在满足以下全部条件时展示：
  - 当前轮次仍在运行；
  - loading slot 本身可见（未被权限确认、AskUserQuestion、compact 或 goal verifier 等阻塞）；
  - 存在 `state === "streaming"` 的 assistant 正文或 reasoning 行；
  - 已累计至少 1 个估算 token，且从最早流式行开始已过去至少 1 秒。
- 模型在生成工具调用参数、等待工具执行、等待用户输入时不展示；轮次结束后不展示。
- 刷新节奏跟随 `ConversationTimeline` 的共享 UI 时钟，每 1 秒更新一次。

## 数据口径

- 数据源：当前 turn 的 `assistantWorkRows` 中仍在流式的 `assistantText` / `reasoning` 行。
- 估算公式与 CLI 的 `estimateTokens` 保持一致：
  - 中文字符（`[\u4e00-\u9fff]`）按 2 个估算字符计；
  - 其他字符按 1 个估算字符计；
  - 总估算字符数 ÷ `ESTIMATED_TOKEN_CHAR_DIVISOR`（共享常量，当前为 3），向上取整。
- 分母：`nowMs - 最早流式行的 createdAt`，即从首个流式片段到当前 UI 时钟的墙钟时间。
- 多行同时流式时累加 token，并取最早的 `createdAt` 作为起点。

## 状态所有权

这是 UI 的临时派生视图，不构成第二份权威状态：

```text
CLI ProductProjection rows (authoritative)
  -> ConversationTimeline render units
  -> resolveConversationLiveOutputSpeed(rows, nowMs)   // 纯函数，每次渲染重新计算
  -> LiveOutputSpeedBadge                              // 只读展示
```

- 不写入 store、snapshot、session 或任何持久化层。
- 不根据速度反推 turn 状态、usage 或 retry 行为。
- CLI 仍是 output usage 的唯一所有者；provider usage 只在请求结束时返回。

## 验收场景

1. 运行中的助手正文持续增长时，底部 loading slot 出现 `约 42 tok/s`（中文）并每秒更新。
2. 首个流式片段不足 1 秒时不出现，避免刚开头出现异常高的瞬时值。
3. 模型开始生成工具调用、正文行进入 complete 后，指示器消失。
4. 轮次结束或 loading slot 被权限/问答阻塞时，指示器不出现。
5. 历史已完成轮次不出现指示器；刷新或冷恢复后也不会凭空出现。
6. 英文界面显示 `~42 tok/s`，悬停说明为英文。

## 测试

- `packages/ui/test/conversationLiveOutputSpeed.test.ts`：估算公式、流式行筛选、1 秒门槛、多行累加、徽标静态渲染。
- 组件级锚点：`data-zcode-live-output-speed="true"`，供后续桌面 E2E 断言。

## 后续可选

若产品需要与开发者工具一致的精确值，可在 `ModelComplete` 上补充 `timeToFirstContentMs` / `durationMs`，由 CLI 投影出每个模型步骤的精确 TPS；当前版本刻意不引入该协议改动。
