// @vitest-environment jsdom

import { createElement, type ReactNode } from "react";
import { renderHook, waitFor } from "@testing-library/react";
import type { CodingPlanUsageSnapshot, ZCodeAccountAccess } from "@zcode/shared";
import type { IServiceAccessor } from "@zcode/services";
import { describe, expect, it, vi } from "vitest";
import { ServiceProvider } from "@/hooks/useServices.js";
import {
  shouldRefreshCodingPlanUsageOnAccess,
  useCodingPlanUsageStats,
  useModelRequestRate,
} from "@/hooks/useUsageStats.js";

const accountAccessByScope = new Map<string, ZCodeAccountAccess>();

function createAccountAccess(organizationId?: string, projectId?: string): ZCodeAccountAccess {
  const key = `${organizationId ?? ""}:${projectId ?? ""}`;
  const existing = accountAccessByScope.get(key);
  if (existing) return existing;
  const access: ZCodeAccountAccess =
    organizationId && projectId
      ? {
          type: "zhipu-account",
          family: "bigmodel",
          planKind: "team-coding-plan",
          productId: "product-team",
          organizationId,
          projectId,
        }
      : {
          type: "zhipu-account",
          family: "bigmodel",
          planKind: "individual-coding-plan",
        };
  accountAccessByScope.set(key, access);
  return access;
}

describe("Coding Plan Usage access refresh", () => {
  it("首次打开刷新，一分钟内复用缓存，到期后再刷新", () => {
    expect(shouldRefreshCodingPlanUsageOnAccess({ lastUpdatedAt: null, now: 1_000 })).toBe(true);
    expect(
      shouldRefreshCodingPlanUsageOnAccess({
        lastUpdatedAt: 1_000,
        now: 60_999,
      }),
    ).toBe(false);
    expect(
      shouldRefreshCodingPlanUsageOnAccess({
        lastUpdatedAt: 1_000,
        now: 61_000,
      }),
    ).toBe(true);
  });

  it("切换到组织来源失败后不会把上一来源快照缓存到该组织", async () => {
    const personalSnapshot = createCodingPlanUsageSnapshot("personal", 123);
    const usageStatsService = {
      getCodingPlanUsageSnapshot: vi
        .fn()
        .mockResolvedValueOnce(personalSnapshot)
        .mockRejectedValue(new Error("team query denied")),
    };
    const services = { usageStatsService } as unknown as IServiceAccessor;
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(ServiceProvider, { services }, children);

    const hook = renderHook(
      ({ organizationId, projectId }: { organizationId?: string; projectId?: string }) =>
        useCodingPlanUsageStats("7d", {
          preferredProviderId: "account:bigmodel-individual-coding-plan",
          accountAccess: createAccountAccess(organizationId, projectId),
        }),
      { initialProps: {}, wrapper },
    );

    await waitFor(() => {
      expect(hook.result.current.snapshot?.sourceProvider.name).toBe("personal");
    });
    hook.rerender({ organizationId: "org-team", projectId: "proj-team" });

    await waitFor(() => {
      expect(hook.result.current.error).toBe("team query denied");
    });
    expect(hook.result.current.snapshot).toBeNull();
    hook.unmount();

    const remountedTeamHook = renderHook(
      () =>
        useCodingPlanUsageStats("7d", {
          preferredProviderId: "account:bigmodel-individual-coding-plan",
          accountAccess: createAccountAccess("org-team", "proj-team"),
        }),
      { wrapper },
    );

    expect(remountedTeamHook.result.current.snapshot).toBeNull();
    await waitFor(() => {
      expect(remountedTeamHook.result.current.error).toBe("team query denied");
    });
    expect(remountedTeamHook.result.current.snapshot).toBeNull();
    expect(usageStatsService.getCodingPlanUsageSnapshot).toHaveBeenCalledTimes(3);
  });

  it("相同 scope 并发挂载时复用请求并同步成功结果", async () => {
    const request = createDeferred<CodingPlanUsageSnapshot>();
    const snapshot = createCodingPlanUsageSnapshot("shared", 456);
    const usageStatsService = {
      getCodingPlanUsageSnapshot: vi.fn(() => request.promise),
    };
    const services = { usageStatsService } as unknown as IServiceAccessor;
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(ServiceProvider, { services }, children);
    const renderUsageHook = () =>
      renderHook(
        () =>
          useCodingPlanUsageStats("7d", {
            preferredProviderId: "account:bigmodel-individual-coding-plan",
            accountAccess: createAccountAccess(),
          }),
        { wrapper },
      );

    const first = renderUsageHook();
    const second = renderUsageHook();

    expect(usageStatsService.getCodingPlanUsageSnapshot).toHaveBeenCalledTimes(1);
    request.resolve(snapshot);
    await waitFor(() => {
      expect(first.result.current.snapshot).toBe(snapshot);
      expect(second.result.current.snapshot).toBe(snapshot);
    });
    expect(first.result.current.error).toBeNull();
    expect(second.result.current.error).toBeNull();
  });

  it("相同 scope 并发挂载时复用请求并同步失败结果", async () => {
    const request = createDeferred<CodingPlanUsageSnapshot>();
    const usageStatsService = {
      getCodingPlanUsageSnapshot: vi.fn(() => request.promise),
    };
    const services = { usageStatsService } as unknown as IServiceAccessor;
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(ServiceProvider, { services }, children);
    const renderUsageHook = () =>
      renderHook(
        () =>
          useCodingPlanUsageStats("7d", {
            preferredProviderId: "account:bigmodel-individual-coding-plan",
            accountAccess: createAccountAccess(),
          }),
        { wrapper },
      );

    const first = renderUsageHook();
    const second = renderUsageHook();

    expect(usageStatsService.getCodingPlanUsageSnapshot).toHaveBeenCalledTimes(1);
    request.reject(new Error("shared query denied"));
    await waitFor(() => {
      expect(first.result.current.error).toBe("shared query denied");
      expect(second.result.current.error).toBe("shared query denied");
    });
    expect(first.result.current.snapshot).toBeNull();
    expect(second.result.current.snapshot).toBeNull();
  });
});

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function createCodingPlanUsageSnapshot(
  providerName: string,
  totalTokens: number,
): CodingPlanUsageSnapshot {
  return {
    range: "7d",
    rangeStartDate: "2026-08-09",
    rangeEndDate: "2026-08-15",
    generatedAt: 1786800000000,
    sourceProvider: {
      id: "account:bigmodel-individual-coding-plan",
      name: providerName,
    },
    quota: null,
    activity: {
      summary: {
        totalTokens,
        peakDailyTokens: totalTokens,
        peakDailyTokensDate: "2026-08-15",
        totalUsageDurationMs: 0,
        currentStreakDays: 1,
        longestStreakDays: 1,
        favoriteModelName: null,
      },
      heatmap: {
        weeks: [],
        peakTokens: totalTokens,
      },
    },
    detail: {
      model: createDetailSummary(),
      tool: createDetailSummary(),
    },
    modelUsage: {
      xTime: [],
      granularity: "day",
      totalModelCallCount: 0,
      totalTokensUsage: totalTokens,
      modelDataList: [],
      modelSummaryList: [],
    },
    toolUsage: {
      xTime: [],
      granularity: "day",
      toolDataList: [],
      toolSummaryList: [],
    },
    health: {
      xTime: [],
      proMaxDecodeSpeed: [],
      liteDecodeSpeed: [],
    },
  };
}

function createDetailSummary() {
  return {
    cacheHitRate: null,
    cacheHitRateTrend: null,
    totalCredits: 0,
    totalCreditsTrend: null,
    averageDailyCredits: 0,
    averageDailyCreditsTrend: null,
  };
}

describe("useModelRequestRate", () => {
  type ModelRateResult = NonNullable<
    Awaited<ReturnType<NonNullable<IServiceAccessor["usageStatsService"]["getModelRequestRate"]>>>
  >;

  function createModelRateSnapshot(overrides: Partial<ModelRateResult> = {}): ModelRateResult {
    return {
      providerId: "new-provider",
      modelId: "deepseek-v4.1-flash",
      windowMs: 300_000,
      windowStart: 1_000,
      windowEnd: 301_000,
      sampleCount: 4,
      outputTokens: 1_200,
      outputDurationMs: 20_000,
      tokensPerSecond: 60,
      ttftP50Ms: 800,
      ttftP90Ms: 1_400,
      requestDurationP50Ms: 5_000,
      requestDurationP90Ms: 9_000,
      cacheHitRate: 0.95,
      ...overrides,
    };
  }

  function wrapperFor(usageStatsService: object) {
    const services = { usageStatsService } as unknown as IServiceAccessor;
    return ({ children }: { children: ReactNode }) =>
      createElement(ServiceProvider, { services }, children);
  }

  it("按 provider/model/windowMs 拉取模型速率", async () => {
    const snapshot = createModelRateSnapshot();
    const getModelRequestRate = vi.fn(async () => snapshot);
    const hook = renderHook(
      () =>
        useModelRequestRate({
          providerId: "new-provider",
          modelId: "deepseek-v4.1-flash",
          windowMs: 300_000,
          pollIntervalMs: 60_000,
        }),
      { wrapper: wrapperFor({ getModelRequestRate }) },
    );

    await waitFor(() => {
      expect(hook.result.current.snapshot).toBe(snapshot);
    });
    expect(getModelRequestRate).toHaveBeenCalledWith({
      providerId: "new-provider",
      modelId: "deepseek-v4.1-flash",
      windowMs: 300_000,
    });
    expect(hook.result.current.error).toBeNull();
    hook.unmount();
  });

  it("enabled=false 或 host 不支持该方法时不发请求", async () => {
    const disabled = vi.fn();
    const disabledHook = renderHook(
      () =>
        useModelRequestRate({
          providerId: "p",
          modelId: "m",
          windowMs: 60_000,
          enabled: false,
        }),
      { wrapper: wrapperFor({ getModelRequestRate: disabled }) },
    );
    expect(disabled).not.toHaveBeenCalled();
    expect(disabledHook.result.current.snapshot).toBeNull();
    disabledHook.unmount();

    const unsupportedHook = renderHook(
      () => useModelRequestRate({ providerId: "p", modelId: "m", windowMs: 60_000 }),
      { wrapper: wrapperFor({}) },
    );
    expect(unsupportedHook.result.current.snapshot).toBeNull();
    expect(unsupportedHook.result.current.error).toBeNull();
    unsupportedHook.unmount();
  });

  it("切换窗口后旧窗口的迟到响应不会覆盖新结果", async () => {
    const first = createDeferred<ModelRateResult>();
    const second = createDeferred<ModelRateResult>();
    const getModelRequestRate = vi
      .fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);

    const hook = renderHook(
      ({ windowMs }: { windowMs: number }) =>
        useModelRequestRate({
          providerId: "p",
          modelId: "m",
          windowMs,
          pollIntervalMs: 60_000,
        }),
      {
        initialProps: { windowMs: 60_000 },
        wrapper: wrapperFor({ getModelRequestRate }),
      },
    );

    hook.rerender({ windowMs: 300_000 });
    second.resolve(createModelRateSnapshot({ windowMs: 300_000, tokensPerSecond: 80 }));
    await waitFor(() => {
      expect(hook.result.current.snapshot?.tokensPerSecond).toBe(80);
    });

    first.resolve(createModelRateSnapshot({ windowMs: 60_000, tokensPerSecond: 10 }));
    await Promise.resolve();
    expect(hook.result.current.snapshot?.tokensPerSecond).toBe(80);
    hook.unmount();
  });

  it("轮询间隔到达后刷新，卸载后停止", async () => {
    const getModelRequestRate = vi.fn(async () => createModelRateSnapshot());
    const hook = renderHook(
      () =>
        useModelRequestRate({
          providerId: "p",
          modelId: "m",
          windowMs: 60_000,
          pollIntervalMs: 250,
        }),
      { wrapper: wrapperFor({ getModelRequestRate }) },
    );

    await waitFor(() => {
      expect(getModelRequestRate.mock.calls.length).toBeGreaterThanOrEqual(2);
    });
    hook.unmount();
    const callsAfterUnmount = getModelRequestRate.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(getModelRequestRate.mock.calls.length).toBe(callsAfterUnmount);
  });
});
