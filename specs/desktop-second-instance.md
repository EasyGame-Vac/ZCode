# 桌面应用第二实例（single-instance）行为契约

## 背景与状态

- 适用范围：`packages/desktop` 主进程启动流程（`src/main/index.ts`）。
- 桌面应用通过 `app.requestSingleInstanceLock()` 保证同一 userData（dev 为
  `ZCode Dev`）下只有一个完整运行的主实例；后续实例只承担"数据转交"职责。
- 2026-10-31 修复：第二实例在未获得锁时必须**终止进程**，不得继续初始化。

## 产品规则

1. 第二实例的唯一职责：把 `createDeepLinkSingleInstanceData(process.argv)`
   （含 `zcode://` deep link、workspace 路径等）转交给持锁实例。
2. `requestSingleInstanceLock` 返回 `false` 时，附加数据已经投递给持锁实例
   （锁握手内同步完成），第二实例没有其他待办工作。
3. 第二实例**不得**创建任何窗口、host、CLI 子进程或托盘图标；对用户必须不可见。
4. 持锁实例通过 `second-instance` 事件消费转交数据（OAuth 回调、打开工作区等）。
5. dev（未打包）实例**不注册** `zcode://` 协议，并在启动时清理本 checkout 的历史注册：
   - dev 用 `USERPROFILE` / `APPDATA` 重定向数据目录，Electron 的 appData/userData
     与单实例锁作用域随之按进程环境拆分；浏览器 OAuth 回调拉起的实例拿到的永远是自己
     作用域的锁，会以完整实例运行并残留白屏窗口。
   - dev 登录不依赖协议回调：`oauthService.pollPendingOAuth` 轮询通道即可完成。
   - 打包版/官方版启动时会重新注册自己的协议处理器，此决策不影响正式产品。

## 状态所有者

- 锁与转交：Electron `requestSingleInstanceLock` / `second-instance`。
- 退出决策：`src/main/index.ts` 启动引导（bootstrap）代码，属于唯一所有者；
  不允许在其他模块重复实现第二实例退出逻辑。

## 验收场景

| 场景 | 期望 |
| ---- | ---- |
| 主实例运行中，同环境拉起第二个实例（任意参数） | 第二实例转交数据后进程在数秒内退出；不出现新窗口 |
| dev 下 OAuth 登录 | 浏览器完成认证后**不**拉起第二个 electron 实例；登录经轮询通道完成 |
| dev 下外部 `zcode://` 链接 | 无处理器响应（注册已清理），不产生窗口 |
| 无主实例时拉起 | 第二实例获得锁，按正常启动流程成为主实例 |

## 缺陷记录（修复依据）

- 缺陷：`if (!gotTheLock) app.quit()` 中 `app.quit()` 只发起异步退出流程，
  模块继续执行到 `whenReady` 并创建主窗口；在 `closeToTrayOnWindows=true`
  的退出拦截下，OAuth 回调第二实例残留为永不退出的最大化白窗
  （渲染层未加载、标题为默认应用名）。
- 实测证据（2026-10-31，dev 源码实例）：`zcode://oauth/callback` 第二实例
  pid 32396 自 13:39 残留至手动终止；期间主实例登录成功（authCode 已转交）。
- 修复机制：`app.quit()` 之后立即 `process.exit(0)`，阻断后续初始化；
  数据已在锁握手内转交，提前退出进程不影响持锁实例处理。
