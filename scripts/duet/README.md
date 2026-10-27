# Duet 自迭代原型

这是第一版开发态闭环：启动一次，中枢（Supervisor）自动拉起窗口（Desktop Runtime）和精灵（Companion Runtime）。精灵通过无头 CLI 修改仓库、跑检查、提交，用户在精灵窗口里确认验证并重启；窗口也可以修改并重启精灵。

```
┌──────────────────────────────┐
│ 中枢（唯一启动入口）           │
│ 拉起/重启窗口和精灵、验证、回滚      │
└───────┬───────────────┬──────┘
        │ spawn         │ spawn
┌───────▼───────┐ ┌─────▼────────┐
│ 窗口           │ │ 精灵           │
│ pnpm dev:runtime│ │ Electron+CLI  │
└───────────────┘ └──────────────┘
```

- 中枢只做进程管理、固定门禁、激活和回滚，不参与改代码。
- 中枢是启动入口；窗口和精灵都是中枢的 target，精灵不在窗口的进程树里。重启窗口不会杀掉精灵，重启精灵也不会杀掉窗口。
- 精灵的脑子是现有 CLI 的无头调用（`-p --output-format stream-json`），会话用 `--resume` 延续。
- 第一版两个版本共用同一个仓库；中枢用单写者锁、clean worktree 检查和 `HEAD` 校验避免并发。

## 前置条件

- Node 24（以仓库 `mise.toml` 为准）和 pnpm 依赖已安装。
- 模型凭据可用：先在终端跑一次 `zcode`（或 `pnpm --dir apps/zcode-cli dev`）完成登录。
- 启动前不要另外开着一个 `pnpm dev:desktop`，否则 5174 端口冲突。
- 第一次运行会写 `.duet/`（token、日志、ledger、会话 id、门禁哈希），该目录已加入 `.gitignore`。

## 启动

```bash
pnpm duet:start
```

或者直接运行你的开发快捷方式 `dev-zcode.cmd`（它现在也是调用 `duet:start`）。

启动后只有中枢在前台；中枢会自动拉起窗口和精灵：

- 窗口：`pnpm --filter @zcode/desktop dev:runtime`（和旧 `dev-zcode.cmd` 一致，跳过 agent 构建）
- 精灵：`node scripts/duet/pet/start.mjs`

`pnpm duet:all` 是 `duet:start` 的别名。`pnpm duet:pet` 只用于单独调精灵 UI（没有中枢时显示离线状态）。

## 第一次使用

对精灵说：

> 先读 `scripts/duet/k-prompt.md`，然后把设置页的“检查更新”按钮改成显示上次检查时间。

精灵的模型在输入框右侧的模型选择器里切换，列表来自 CLI provider registry（`zcode models --json`）；“默认”跟随 CLI 当前默认模型。选择保存在 `.duet/pet-state.json`，下一条消息通过 `--model` 传给 brain。

精灵会：

1. 改代码；
2. 跑 `pnpm typecheck` 和相关测试；
3. `git commit`；
4. 在回复里给出改动、检查结果和提交 SHA。

精灵随后显示**改动摘要**。你点“验证并重启”，中枢才会：

1. 检查窗口是否空闲；窗口正在执行任务就返回 `409`，不关闭窗口；
2. 检查 worktree 干净、`HEAD` 等于请求 commit、受保护路径和门禁配置；
3. **关闭窗口**，再跑 `typecheck` / `lint` 等固定门禁；
4. 启动新窗口；验证步骤失败会先把窗口恢复到 HEAD，起不来再回滚到上一个可用 commit。

## 中枢 API

只绑定 `127.0.0.1:47821`，token 在 `.duet/token`。

| 方法 | 路径               | 说明                                                                |
| ---- | ------------------ | ------------------------------------------------------------------- |
| GET  | `/status`          | 窗口/精灵状态、pid、`HEAD`、`lastGoodCommit`、激活进度、`busy` 租约 |
| POST | `/start`           | `{target:"w"\|"k"}`，启动并等 ready                                 |
| POST | `/stop`            | `{target:"w"\|"k", force?}`，目标忙时返回 409                       |
| POST | `/restart`         | `{target:"w"\|"k", force?}`，不验证；忙时返回 409                   |
| POST | `/preview`         | `{target:"w"}`，返回改动文件和受保护路径检查                        |
| POST | `/activate`        | `{target:"w", profile?:"fast"\|"full"}`，返回 202；忙时返回 409     |
| POST | `/rollback`        | `{target:"w", force?}`，回到 `lastGoodCommit` 并重启；忙时 409      |
| POST | `/record`          | `{target:"k-extensions", commit}`，记录精灵扩展变更                 |
| POST | `/lease`           | `{target, leaseId, holder, reason?, ttlMs?}`，登记/续约任务租约     |
| POST | `/release`         | `{target, leaseId?, holder?}`，释放一个租约或某个 holder 的全部     |
| GET  | `/ledger?limit=50` | 最近的升级记录                                                      |
| GET  | `/health`          | 中枢存活                                                            |

窗口的修改必须走 `/activate`（有门禁）；精灵可以用 `/restart {target:"k"}` 快速重启，但精灵在跑任务时同样会被 409 拒绝。精灵不会把 token 暴露给 renderer；所有请求都在 Electron 主进程完成。

## 验证门禁

`scripts/duet/config.json` 定义：

- `fast`（默认）：`pnpm typecheck`
- `full`：`pnpm typecheck` + `pnpm lint` + `pnpm architecture:check --changed`
- 可选 `tests`：激活请求里传 `tests: ["path/to.test.ts"]`，会追加一次 `vitest run`。

受保护路径（改任何一条都会拒绝激活）：

- `scripts/duet/**`
- `specs/duet-self-iteration.md`
- `.github/**`
- `architecture-policy.yaml`
- 任何 `package.json`、`pnpm-lock.yaml`、`tsconfig*.json`、`.oxlintrc.json`、`vitest.config.ts`
- `packages/desktop/src/main/autoUpdater.ts`
- `packages/shared/src/version.ts`
- 已有测试只能新增，不能修改/删除/重命名。

窗口在通过 worktree、commit、受保护路径和配置检查之后会被**先关闭**，再跑 `typecheck` / `lint`。这样验证期间不可能有新任务启动；验证步骤失败会先把窗口恢复到 HEAD，起不来再回滚到 `lastGoodCommit`。

## 忙碌租约

- 窗口的桌面主进程在 Host 有 running task 时持有 `w` 租约；精灵在启动 brain 时持有 `k` 租约。两端每 20 秒续约，TTL 60 秒。
- 有租约的 target 会被 `/activate`、`/restart`、`/stop`、`/rollback` 拒绝（409）。`/activate` 不接受 `force`；其它入口可以显式 `force:true` 做紧急操作。
- 中枢停止 target 时会清掉该 target 的所有租约；进程崩溃留下的租约靠 TTL 过期。
- 精灵看到窗口忙会显示“窗口正在执行任务”，并禁用验证按钮。

中枢启动时把门禁文件的 SHA-256 写入 `.duet/gate-hashes.json`。激活前再比一次；文件被改就拒绝。重启中枢时如果门禁变了，必须显式加：

```bash
node scripts/duet/supervisor.mjs --accept-gate-change
```

## 回滚

- 自动：新窗口在 ready 窗口内退出或超时，中枢会 `git checkout --detach <lastGoodCommit>`，重启窗口，并写 ledger。这是日常唯一的回滚路径。
- 手动：精灵 UI 不再提供“回滚”按钮；保留中枢 API 供明确的人工操作：

```bash
TOKEN="$(cat .duet/token)"
curl -X POST http://127.0.0.1:47821/rollback \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"target":"w","reason":"manual"}'
```

回滚会把工作区切到 detached HEAD 的 `lastGoodCommit`；之后继续开发时新建分支或重新提交。

## 反向：窗口改精灵窗口 可以改两类东西：

1. **精灵的扩展**：`.agents/skills/duet-*/**`（技能/提示词）。提交后调 `/record`，中枢检查 diff 只落在 `duet-*` 目录并写 ledger；精灵下个会话生效。
2. **精灵的核心（开发态）**：`scripts/duet/pet/**`。提交后直接调 `/restart {target:"k"}`，中枢停止旧精灵、启动新精灵，并用 `[duet-pet] READY` 等就绪。精灵核心改动没有窗口那样的门禁，属于开发态逃生口；如果改坏，窗口还在，可以继续修，或者看 `.duet/logs/k.log`。

```bash
# 记录精灵扩展
curl -X POST http://127.0.0.1:47821/record \
  -H "Authorization: Bearer $(cat .duet/token)" \
  -H "Content-Type: application/json" \
  -d '{"target":"k-extensions","commit":"<sha>","actor":"w"}'

# 重启精灵（核心或扩展）
curl -X POST http://127.0.0.1:47821/restart \
  -H "Authorization: Bearer $(cat .duet/token)" \
  -H "Content-Type: application/json" \
  -d '{"target":"k"}'
```

窗口自己的修改仍然必须走 `/activate` 和用户点击，不能拿 `/restart w` 绕过门禁。精灵也不要修改 `scripts/duet/lib/**`、`verify.mjs`、`config.json`、`supervisor.mjs`。

窗口的操作说明在 `scripts/duet/w-prompt.md`，让窗口改精灵之前先读它。

## 配置

`scripts/duet/config.json`：

```jsonc
{
  "server": { "host": "127.0.0.1", "port": 47821 },
  "stateDir": ".duet",
  "targets": {
    "w": {
      "cwd": ".",
      "command": "pnpm",
      "args": ["--filter", "@zcode/desktop", "dev:runtime"],
      "autoStart": true,
      "ready": { "type": "delay", "ms": 20000, "stabilityMs": 2000 },
      "stopTimeoutMs": 12000,
      "env": { "ZCODE_DUET_TARGET": "w" },
    },
    "k": {
      "cwd": ".",
      "command": "node",
      "args": ["scripts/duet/pet/start.mjs"],
      "autoStart": true,
      "ready": {
        "type": "marker",
        "pattern": "\\[duet-pet\\] READY",
        "timeoutMs": 30000,
        "stabilityMs": 1000,
      },
      "stopTimeoutMs": 8000,
      "env": { "ZCODE_DUET_TARGET": "k" },
    },
  },
  "pet": {
    "brain": {
      "preferBuilt": false,
      "builtCliPath": "apps/zcode-cli/packages/cli/dist/zcode.cjs",
      "tsxCliPath": "node_modules/tsx/dist/cli.mjs",
      "cliCwd": "apps/zcode-cli/packages/cli",
      "cliEntry": "src/main.ts",
      "cliMode": "yolo",
    },
    "window": { "width": 360, "height": 520, "collapsedWidth": 180, "collapsedHeight": 220 },
    "pollIntervalMs": 4000,
    "shortcut": "CommandOrControl+Shift+Z",
  },
}
```

- `ready.type` 支持 `delay`、`marker`、`http`。窗口目前用 `delay` + 进程存活；精灵用 `[duet-pet] READY` 标记。
- 窗口默认走 `dev:runtime`，使用已有的 bundled agent，跳过 agent 构建；如果 bundled agent 缺失，先跑一次 `pnpm dev:desktop` 或 `pnpm build:desktop-agent-cli`。
- 中枢启动时按 `autoStart` 拉起窗口和精灵；`--no-start` 会同时禁用两者。
- 中枢会把 `ZCODE_DUET_SUPERVISOR_URL` 和 `ZCODE_DUET_TOKEN_PATH` 注入 target 环境；窗口的桌面主进程据此上报 running task 租约，精灵仍直接读 `.duet/token`。
- 改 `config.json` 会改变门禁哈希；重启中枢时要加 `--accept-gate-change`。
- `pet.brain.preferBuilt` 默认 false，直接用仓库源码跑精灵，避免精灵的脑子是旧构建；设成 true 时优先用已构建的 `zcode.cjs`，启动更快。

## 故障排查

**精灵显示“中枢未连接”**
先确认中枢在跑；再看 `.duet/token` 是否存在。中枢只在启动时写 token。

**精灵不自动出现**
看 `/status` 里的 `targets.k` 和 `.duet/logs/k.log`。如果 Electron 没装，先 `pnpm install`；如果精灵被手动退出，`POST /restart {"target":"k"}` 可以拉回。

**窗口启动超时**
窗口走 `dev:runtime`，首次 tsup/vite 启动可能超过 20 秒。调大 `targets.w.ready.ms`，然后带 `--accept-gate-change` 重启中枢。

**5174 端口被占用**
关掉已有的 `pnpm dev:desktop`，再启动中枢。

**47821 端口被占用**
已经有一个中枢在跑；先停掉它，或者改 `server.port` 后带 `--accept-gate-change` 重启。

**改坏精灵后精灵不出现**
窗口还在。读 `.duet/logs/k.log`，修 `scripts/duet/pet/**`，再调 `/restart {"target":"k"}`。

**模型选择器显示“模型列表不可用”**

- 在仓库根跑 `zcode models --json`（或 `pnpm --dir apps/zcode-cli/packages/cli dev models --json`）确认 CLI 本身能读到 provider registry。
- 模型列表只在精灵启动时加载一次；改过 provider 配置后重启精灵（`POST /restart {"target":"k"}`）。
- 列表里的 `disabledReason` 会作为不可选项显示；账号未授权或模型被禁用时先修 provider 配置。

**精灵没有返回**

- 先在终端跑一次 `zcode` 确认登录和模型可用。
- 检查 `node_modules/tsx` 是否存在；没有就 `pnpm install`。
- 如果用了 built CLI，确认 `apps/zcode-cli/packages/cli/dist/zcode.cjs` 存在。
- 精灵的活动流和 `.duet/logs/verify-*.log` 会有错误尾部。

**更新返回 409 / target is busy**
窗口或精灵还在跑任务。等任务结束，或在对应窗口/精灵里先停止任务；租约释放后再更新。`force:true` 只用于明确的紧急操作。

**托盘不显示**
Linux GNOME 可能没有 StatusNotifier host；Windows/macOS 的托盘也有平台差异。托盘失败不影响窗口和快捷键。

**门禁哈希变了**
如果你确实改过 `scripts/duet/**` 或 `config.json`，先审查 diff，再用 `--accept-gate-change` 启动。

注意：`scripts/duet/pet/**` 也在当前门禁哈希范围内，所以精灵自身的改动会让正在运行的中枢拒绝下一次窗口激活。审阅 diff 后重启中枢（会同时重启窗口和精灵）：

```bash
node scripts/duet/supervisor.mjs --accept-gate-change
```

## 手动验收清单

先跑一次窗口冒烟：

```bash
pnpm duet:pet:smoke
```

成功时输出 `PET_SMOKE_OK`，并把截图写到 `.duet/pet-smoke.png`。

当前自动化测试覆盖中枢和精灵逻辑；GUI 需要人工确认：

1. 运行 `pnpm duet:start`（或 `dev-zcode.cmd`），中枢自动拉起窗口和精灵；精灵出现在屏幕右下角。
2. 展开时从面板空白处、收起时从精灵本身拖动，位置都能保存；收起状态拖动后仍能单击展开。
3. 点精灵展开、点面板右上角收起；展开只显示对话面板，收起只显示精灵和一行状态，窗口没有多余空白。
4. 展开后点模型选择器，能看到 `zcode models` 返回的模型；选一个后发消息，重启精灵后选择仍保留。
5. 右键“ZCode 小人”托盘图标，能看到“显示精灵 / 隐藏精灵 / 新会话 / 退出精灵”；隐藏后单击托盘图标或按 `Ctrl+Shift+Z` 能重新显示。
6. 输入一句话，输入框保持单行，多行输入时自动长高到上限；对话进行中“停止”按钮出现后，按钮行仍是单行。
7. 工具活动默认显示为一行摘要，点开才展开；消息区不会因为活动流出现而明显变矮。
8. 精灵完成后改动摘要默认也是一行“改动 N 个文件…”，点开才显示文件列表和“验证并重启”。
9. 点验证：窗口会先关闭，看到“验证：typecheck / 重启窗口”进度；验证期间窗口不可操作。
10. 窗口重启后精灵显示“已更新”，且精灵没有被一起杀掉。
11. 让精灵改一个受保护文件，点验证，看到拒绝原因，窗口保持运行。
12. 精灵 UI 不再显示“回滚”按钮；重启失败时仍能看到中枢自动回滚的结果。
13. 让窗口改精灵的 skill/prompt 或 pet 核心，提交后调 `/restart {"target":"k"}`，精灵重启。
14. 窗口重启期间，精灵仍能显示状态并继续操作。
15. 在窗口跑一个长任务时，精灵禁用验证按钮，直接调 `/activate` 返回 409。
16. 在精灵跑任务时调 `/restart {"target":"k"}` 返回 409；停止任务后可以正常重启。

## 限制

- 只支持开发态、单仓库、单用户。
- 精灵的脑子每次消息启动一个无头 CLI 进程；没有交互式权限审批，使用 `--mode yolo`，但激活必须人工点击。
- 精灵的会话使用正常数据目录，会出现在会话列表里；二期再考虑隔离。
- 不做打包、签名、灰度、版本目录、开机自启、语音/3D。
- 精灵是中枢的 target，窗口可以通过 `/restart {"target":"k"}` 重启精灵；精灵核心改动没有窗口那样的门禁，属于开发态逃生口。
- 窗口的正式修改仍然必须走 `/activate` 和用户点击，不能拿 `/restart w` 绕过门禁。
- 窗口的租约是 target 级的，依据桌面 Host 的 running task count；Host 计数归零后仍在后台运行的子代理不单独持有租约。
- 窗口侧租约桥是桌面主进程里的 dev-only、env-gated 代码；自动化测试覆盖了租约协议和 409，但没有在真实模型长任务下跑完整窗口租约链路。
- 打包版自助启动 duet 不在第一版范围；当前入口是 `pnpm duet:start` / `dev-zcode.cmd`。
- 自动化测试覆盖中枢、验证器、租约和精灵的纯逻辑；真实模型对话和跨平台 GUI 行为需要人工确认。
