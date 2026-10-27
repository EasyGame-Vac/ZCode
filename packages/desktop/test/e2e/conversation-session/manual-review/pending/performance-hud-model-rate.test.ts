import { clearAppData, getE2EAppDataPaths } from "../../../helpers/desktop-app.js";
import { seedModelRateE2EFixture } from "../../../helpers/usage-stats-app-usage-fixture.js";
import {
  prepareV4ConversationE2E,
  sendV4Prompt,
  waitForV4TimelineContaining,
} from "../../../helpers/v4-conversation.js";

const HUD_SELECTOR = '[data-zcode-performance-hud="true"]';

describe("Performance HUD 模型窗口速率 E2E", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("1 分钟窗口按 provider+model 聚合请求级吞吐", async function () {
    this.timeout(240_000);

    // HUD 只在有 session snapshot 的 pane 上渲染，因此先建立一个真实会话。
    await prepareV4ConversationE2E();
    const prompt = `PERF_HUD_MODEL_RATE_${Date.now()}`;
    await sendV4Prompt(prompt);
    await waitForV4TimelineContaining(prompt, 90_000);

    const toggle = $('[data-testid="v4-performance-hud-toggle"]');
    await toggle.waitForClickable({ timeout: 30_000 });
    await toggle.click();
    const hud = $(HUD_SELECTOR);
    await hud.waitForDisplayed({ timeout: 15_000 });

    await browser.execute(() => {
      const select = document.querySelector<HTMLSelectElement>(
        '[data-zcode-performance-hud="true"] select',
      );
      if (!select) throw new Error("PERF HUD 窗口选择器不存在");
      select.value = "1m";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });

    // 窗口查询的过滤键就是 HUD 暴露的 provider/model；测试不再另猜有效模型。
    const identity = await browser.execute(() => {
      const root = document.querySelector('[data-zcode-performance-hud="true"]');
      return {
        provider: root?.getAttribute("data-zcode-perf-hud-provider") ?? "",
        model: root?.getAttribute("data-zcode-perf-hud-model") ?? "",
      };
    });
    if (!identity.provider || !identity.model) {
      throw new Error(`PERF HUD 没有暴露有效 provider/model: ${JSON.stringify(identity)}`);
    }

    // 写入 4 条最近一分钟内的请求样本，避免回放夹具的瞬时响应落在 300ms 过滤线下。
    seedModelRateE2EFixture({
      e2eHomeDir: getE2EAppDataPaths().homeDir,
      providerId: identity.provider,
      modelId: identity.model,
    });

    await browser.waitUntil(
      async () =>
        browser.execute(() => {
          const value =
            document
              .querySelector("[data-zcode-perf-hud-window-rate]")
              ?.getAttribute("data-zcode-perf-hud-window-rate") ?? "";
          return value !== "—" && /^\d/.test(value);
        }),
      { timeout: 30_000, timeoutMsg: "1m 窗口没有显示模型级 tok/s" },
    );

    const sampleText = await browser.execute(
      () =>
        document
          .querySelector("[data-zcode-perf-hud-window-samples]")
          ?.getAttribute("data-zcode-perf-hud-window-samples") ?? "",
    );
    if (!/全设备|All sessions/.test(sampleText)) {
      throw new Error(`窗口样本标签缺少模型作用域: ${sampleText}`);
    }
  });
});