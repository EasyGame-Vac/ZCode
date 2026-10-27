# 本地源码启动流程（个人 fork，Windows）

## 状态与范围

- 本文是当前个人使用环境的**唯一启动契约**，优先级高于临时命令、临时脚本和临时快捷方式。
- 适用范围：Windows 源码 checkout、个人自用；不适用于正式发布、CI、macOS/Linux 或其他人的环境。
- 本流程依赖本机个人 fork 的 `dev-zcode.cmd` 和 `scripts/duet/`；这些是本地约定，不用于上游发布或他人环境。
- 任何新增、替换或绕过日常启动方式的改动，必须先更新本文和 `AGENTS.md`，并得到用户确认；不允许在其他对话里临时造一套 launcher。

## 唯一入口

```text
桌面快捷方式（如存在）
  -> 仓库根 dev-zcode.cmd
     -> 设置 ZCODE_ENV / ZCODE_DATA_BASE_DIR / USERPROFILE / APPDATA 等环境
     -> corepack pnpm duet:start
        -> Duet supervisor（127.0.0.1:47821）
           -> target w: pnpm --filter @zcode/desktop dev:runtime
              -> Vite dev server（5174，renderer HMR）
              -> tsup --watch（main / host / preload）
              -> Electron 源码窗口（userData: ZCode Dev）
              -> CLI: apps/zcode-cli/packages/cli/dist/zcode.cjs
           -> target k: Duet pet（scripts/duet/pet/start.mjs）
```

数据目录由 `dev-zcode.cmd` 中的 `ZCODE_DATA_BASE_DIR` 决定（当前为 `C:\Users\<用户名>\.zcode-dev-home`），同时把 `USERPROFILE` / `APPDATA` 指向该目录。不要在别的脚本里复制、改写或另设一套目录。

权威入口是仓库根的 `dev-zcode.cmd`；桌面快捷方式只是它的入口，不是第二套流程。

## 日常操作

| 场景                     | 操作                                                                                   |
| ------------------------ | -------------------------------------------------------------------------------------- |
| 首次启动（端口空闲）     | 双击桌面 `ZCode Dev (源码)`，或执行仓库根 `dev-zcode.cmd`                              |
| 已在运行（端口被占用）   | 不要再启动第二个实例；切到已有窗口                                                     |
| 查看 supervisor 状态     | `GET http://127.0.0.1:47821/status`                                                    |
| 只重启源码窗口           | `POST /restart`，`target` 为 `w`                                                       |
| 只重启 Duet pet          | `POST /restart`，`target` 为 `k`                                                       |
| 完整停止                 | 在 supervisor 控制台按 `Ctrl+C`；它会停止 `w` / `k`，随后可重新双击快捷方式            |

`dev-zcode.cmd` 启动前会检查 `5174` 和 `47821`。任一端口已监听时，脚本会直接退出并提示已有实例。这是防止双实例的保护，不是启动失败。

## 源码改动如何生效

| 改动位置                                             | 生效方式                                                                 |
| ---------------------------------------------------- | ------------------------------------------------------------------------ |
| `packages/ui`、Web renderer 等前端源码               | Vite HMR；必要时刷新窗口                                                 |
| `packages/desktop` 的 main / host / preload          | tsup watch 重建；`POST /restart` 重启 `target: "w"`                      |
| `apps/zcode-cli` 或 CLI 依赖的源码                   | 先 `node scripts/build-desktop-agent-cli.mjs`，再重启 `target: "w"`      |
| 同时被 renderer 和 CLI 使用的 `packages/shared` 改动 | 先按 CLI 行重建，再按 renderer 行确认 HMR / 刷新                         |
| 只改文档、测试或脚本                                 | 不需要重启应用；按对应检查命令验证                                       |

注意：`duet` 的 `w` target 只运行 `dev:runtime`，**不会**自动重建 `apps/zcode-cli/packages/cli/dist/zcode.cjs`。只改 CLI 源码时，必须先执行上面的构建命令，否则重启后仍是旧 CLI。

## 重启命令

```bash
# 从仓库根执行；token 只在本机使用，不要提交
TOKEN="$(cat .duet/token)"

curl -s -H "Authorization: Bearer $TOKEN" \
  http://127.0.0.1:47821/status

# 只重启源码窗口；有正在执行的任务时，force 会中断它
curl -s -X POST \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"target":"w","force":true}' \
  http://127.0.0.1:47821/restart
```

`force` 只在确认可以中断当前任务时使用；否则去掉，让 supervisor 在目标空闲时再重启。

## 不要做

- 不要新建 `ZCode Preview (Independent)`、额外的 `.vbs` / `.cmd` / `.lnk`，或新的 `ZCODE_DATA_BASE_DIR` 来“独立启动”。
- 不要把已安装的 `ZCode Preview` 当作日常入口。它只用于验证打包产物。
- 不要在 `5174` / `47821` 已监听时再启动一个 dev 实例。
- 不要复制 `dev-zcode.cmd` 的环境变量、凭据或目录设置到其他脚本。
- 不要把 dev home 的数据库、会话或配置复制到安装版/官方版来“修复显示”。
- 不要用 `electron.exe .` 或安装包 exe 直接做快捷方式绕过 supervisor。
- 不要在别的对话里根据一次临时需求新增启动脚本；先改文档并确认。

## 数据与身份边界

| 实例             | 入口                                   | 数据 / 身份                                                                 | 用途                     |
| ---------------- | -------------------------------------- | --------------------------------------------------------------------------- | ------------------------ |
| 源码 dev         | `dev-zcode.cmd` → Duet supervisor      | `ZCODE_DATA_BASE_DIR` 指向的 dev home；userData `ZCode Dev`；CLI 为源码构建 | 日常开发、自用           |
| 安装版 Preview   | 安装器 / 开始菜单                      | app id `dev.zcode.app.preview`，独立安装身份                                | 只验证安装包和打包行为   |
| 官方版           | 官方安装目录                           | 官方身份与官方数据目录                                                      | 对照上游版本，不用于开发 |

这些实例的数据不要混用。需要迁移或清理时单独处理，并先确认目标目录。

## 安装包（仅在明确要求时）

只有用户明确要求“构建/安装/验证安装包”时才走这条链路：

```bash
ZCODE_ENV=production ZCODE_PREVIEW_IDENTITY=1 \
  corepack pnpm bundle:desktop -- -o win -a x64
```

产物在 `packages/desktop/dist/`。安装后只用于验证，不要把桌面快捷方式改指向安装版，也不要再创建 independent launcher。验证完成后，日常仍回到 `ZCode Dev (源码)`。

## 排查

- **HUD 全是 `—`**：先确认当前会话是否有已完成的模型请求。Duet 的 K 会话通常没有，HUD 为空是正常的；切到有历史的任务再观察。
- **快捷方式没反应**：检查 `5174` / `47821` 是否已监听；已有实例时用 `/status`，不要重复启动。
- **桌面快捷方式丢失或失效**：重建一个指向仓库根 `dev-zcode.cmd` 的快捷方式（工作目录设为仓库根），名称沿用 `ZCode Dev (源码)`；不要指向 `electron.exe`、安装包或临时 `.vbs`。
- **CLI 改动没生效**：确认执行过 `node scripts/build-desktop-agent-cli.mjs`，并且 `/restart` 的是 `target: "w"`。
- **数据看起来不对**：确认当前进程的 `ZCODE_DATA_BASE_DIR` / userData；不要通过复制数据库来排查。
- **需要改启动目录或环境**：只改 `dev-zcode.cmd`，同步更新本文和 `AGENTS.md`，不要在别处复制一份。

## 相关文件

- `dev-zcode.cmd`：唯一日常入口（本地文件，已在 `.git/info/exclude` 中排除，不进入提交）。
- `scripts/duet/supervisor.mjs`、`scripts/duet/lib/supervisor-http.mjs`、`scripts/duet/config.json`：supervisor 与 target 定义。
- `scripts/dev-desktop-env.mjs`：上游标准 dev 入口，包含 CLI 构建；不是本 fork 的日常入口。
- `docs/desktop/dev-runtime.md`：macOS 开发副本目录，不描述本文件的 Windows 启动流程。