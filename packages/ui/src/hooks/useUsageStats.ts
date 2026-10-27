import { useCallback, useEffect, useRef, useState } from "react";
import type {
  AppUsageRange,
  AppUsageSnapshot,
  CodingPlanUsageRange,
  CodingPlanUsageSnapshot,
  UsageStatsRange,
  UsageStatsSnapshot,
  ZCodeAccountAccess,
  ZCodeProviderAccountAccess,
} from "@zcode/shared";
import type { V4UsageModelRateParams, V4UsageModelRateResult } from "@zcode/shared/zcode-protocol-v4";
import { logger } from "@/logger.js";
import { useServices } from "@/hooks/useServices.js";
import { useStableAccountAccess } from "@/hooks/useStableAccountAccess.js";
import { USAGE_ENTITLEMENT_ACCESS_REFRESH_MS } from "@/lib/usageEntitlementRefreshPolicy.js";

interface UsageStatsState {
  snapshot: UsageStatsSnapshot | null;
  loading: boolean;
  error: string | null;
}

interface AppUsageStatsState {
  snapshot: AppUsageSnapshot | null;
  loading: boolean;
  error: string | null;
}

interface CodingPlanUsageStatsState {
  snapshot: CodingPlanUsageSnapshot | null;
  loading: boolean;
  error: string | null;
}

interface CodingPlanUsageCacheEntry {
  snapshot: CodingPlanUsageSnapshot | null;
  requestedAt: number | null;
  inFlight?: Promise<CodingPlanUsageSnapshot>;
}

const codingPlanUsageAccessCache = new WeakMap<object, Map<string, CodingPlanUsageCacheEntry>>();

export function shouldRefreshCodingPlanUsageOnAccess(params: {
  lastUpdatedAt: number | null;
  now: number;
}): boolean {
  return (
    params.lastUpdatedAt === null ||
    params.now - params.lastUpdatedAt >= USAGE_ENTITLEMENT_ACCESS_REFRESH_MS
  );
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message || error.name || String(error);
  }
  if (typeof error === "object" && error !== null && "message" in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string" && message.length > 0) {
      return message;
    }
  }
  return String(error);
}

const INITIAL_STATE: UsageStatsState = {
  snapshot: null,
  loading: false,
  error: null,
};

export function useUsageStats(
  range: UsageStatsRange,
  options: {
    dataSource?: "local" | "monitor";
    enabled?: boolean;
    preferredProviderId?: string;
    accountAccess?: ZCodeProviderAccountAccess | ZCodeAccountAccess;
    requirePreferredProvider?: boolean;
    allowEnvApiKey?: boolean;
  } = {},
) {
  const { usageStatsService } = useServices();
  const [state, setState] = useState<UsageStatsState>(INITIAL_STATE);
  const requestVersionRef = useRef(0);
  const dataSource = options.dataSource;
  const enabled = options.enabled ?? true;
  const preferredProviderId = options.preferredProviderId;
  const accountAccess = useStableAccountAccess(options.accountAccess);
  const requirePreferredProvider = options.requirePreferredProvider === true;
  const allowEnvApiKey = options.allowEnvApiKey;
  const requestScope = [
    dataSource ?? "",
    preferredProviderId ?? "",
    JSON.stringify(accountAccess ?? null),
    requirePreferredProvider ? "strict" : "relaxed",
    allowEnvApiKey === false ? "no-env" : "env",
  ].join("|");
  const lastRequestScopeRef = useRef(requestScope);

  const refresh = useCallback(async () => {
    if (!enabled) {
      return;
    }

    const requestVersion = requestVersionRef.current + 1;
    requestVersionRef.current = requestVersion;
    const keepPreviousSnapshot = lastRequestScopeRef.current === requestScope;
    lastRequestScopeRef.current = requestScope;
    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;

    setState((current) => ({
      // App Usage 与 Coding Plan 共用同一个 hook 实例。
      // 切 tab 后如果继续保留旧 snapshot，Coding Plan 请求期间或失败后会显示本地 App Usage 数据。
      snapshot: keepPreviousSnapshot ? current.snapshot : null,
      loading: true,
      error: null,
    }));

    try {
      const snapshot = await usageStatsService.getSnapshot({
        range,
        dataSource,
        preferredProviderId,
        accountAccess,
        requirePreferredProvider,
        allowEnvApiKey,
        timeZone,
      });
      if (requestVersionRef.current !== requestVersion) {
        return;
      }
      setState({
        snapshot,
        loading: false,
        error: null,
      });
    } catch (error) {
      if (requestVersionRef.current !== requestVersion) {
        return;
      }
      const message = getErrorMessage(error);
      logger.warn("[useUsageStats] 读取 usage 统计失败", {
        dataSource,
        range,
        preferredProviderId,
        timeZone,
        error: message,
      });
      setState((current) => ({
        snapshot: lastRequestScopeRef.current === requestScope ? current.snapshot : null,
        loading: false,
        error: message,
      }));
    }
  }, [
    accountAccess,
    allowEnvApiKey,
    dataSource,
    enabled,
    preferredProviderId,
    range,
    requestScope,
    requirePreferredProvider,
    usageStatsService,
  ]);

  useEffect(() => {
    if (!enabled) {
      setState({
        // Coding Plan provider 被移除或禁用后，使用统计查询会被关闭。
        // 这里清空旧快照，避免设置页继续显示上一家账号的用量数据。
        snapshot: null,
        loading: false,
        error: null,
      });
      return;
    }

    void refresh();
  }, [enabled, refresh]);

  return {
    snapshot: state.snapshot,
    loading: state.loading,
    error: state.error,
    refresh,
  };
}

export function useAppUsageStats(range: AppUsageRange) {
  const { usageStatsService } = useServices();
  const [state, setState] = useState<AppUsageStatsState>({
    snapshot: null,
    loading: false,
    error: null,
  });
  const requestVersionRef = useRef(0);

  const refresh = useCallback(async () => {
    const requestVersion = requestVersionRef.current + 1;
    requestVersionRef.current = requestVersion;
    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    setState((current) => ({
      snapshot: current.snapshot,
      loading: true,
      error: null,
    }));
    try {
      const snapshot = await usageStatsService.getAppUsageSnapshot({
        range,
        timeZone,
      });
      if (requestVersionRef.current !== requestVersion) {
        return;
      }
      setState({ snapshot, loading: false, error: null });
    } catch (error) {
      if (requestVersionRef.current !== requestVersion) {
        return;
      }
      const message = getErrorMessage(error);
      logger.warn("[useAppUsageStats] 读取本地使用统计失败", {
        range,
        timeZone,
        error: message,
      });
      setState((current) => ({
        snapshot: current.snapshot,
        loading: false,
        error: message,
      }));
    }
  }, [range, usageStatsService]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { ...state, refresh };
}

export function useCodingPlanUsageStats(
  range: CodingPlanUsageRange,
  options: {
    enabled?: boolean;
    preferredProviderId?: string;
    accountAccess?: ZCodeProviderAccountAccess | ZCodeAccountAccess;
    customStartDate?: string | null;
    customEndDate?: string | null;
  },
) {
  const { usageStatsService } = useServices();
  const requestScopeKey = [
    range,
    options.preferredProviderId ?? "",
    JSON.stringify(options.accountAccess ?? null),
    options.customStartDate?.trim() ?? "",
    options.customEndDate?.trim() ?? "",
  ].join("\0");
  const cachedUsage = codingPlanUsageAccessCache.get(usageStatsService)?.get(requestScopeKey);
  const [state, setState] = useState<CodingPlanUsageStatsState>({
    snapshot: cachedUsage?.snapshot ?? null,
    loading: false,
    error: null,
  });
  const latestSnapshotRef = useRef<CodingPlanUsageSnapshot | null>(cachedUsage?.snapshot ?? null);
  const requestVersionRef = useRef(0);
  const enabled = options.enabled ?? true;
  const preferredProviderId = options.preferredProviderId;
  const accountAccess = useStableAccountAccess(options.accountAccess);
  const customStartDate = options.customStartDate?.trim() || null;
  const customEndDate = options.customEndDate?.trim() || null;
  const requestIdentityKey = [
    preferredProviderId ?? "",
    JSON.stringify(accountAccess ?? null),
  ].join("\0");
  const lastRequestScopeKeyRef = useRef(requestIdentityKey);

  const refresh = useCallback(
    async (refreshOptions: { force?: boolean } = {}) => {
      if (!enabled || !preferredProviderId || !accountAccess) {
        latestSnapshotRef.current = null;
        setState({ snapshot: null, loading: false, error: null });
        return;
      }
      let serviceCache = codingPlanUsageAccessCache.get(usageStatsService);
      if (!serviceCache) {
        serviceCache = new Map();
        codingPlanUsageAccessCache.set(usageStatsService, serviceCache);
      }
      const cached = serviceCache.get(requestScopeKey);
      let request = cached?.inFlight;
      if (
        !request &&
        !refreshOptions.force &&
        cached?.snapshot &&
        !shouldRefreshCodingPlanUsageOnAccess({
          lastUpdatedAt: cached?.requestedAt ?? null,
          now: Date.now(),
        })
      ) {
        latestSnapshotRef.current = cached?.snapshot ?? null;
        setState({
          snapshot: cached?.snapshot ?? null,
          loading: false,
          error: null,
        });
        return;
      }
      const requestVersion = requestVersionRef.current + 1;
      requestVersionRef.current = requestVersion;
      const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
      const keepPreviousSnapshot = lastRequestScopeKeyRef.current === requestIdentityKey;
      lastRequestScopeKeyRef.current = requestIdentityKey;
      if (!request || refreshOptions.force) {
        request = usageStatsService.getCodingPlanUsageSnapshot({
          range,
          customStartDate,
          customEndDate,
          preferredProviderId,
          accountAccess,
          timeZone,
        });
        serviceCache.set(requestScopeKey, {
          // requestedAt 只能表示成功快照的生成时间。用请求开始时间预写空快照会
          // 导致同 scope 的后挂载实例把 pending 当成 fresh，并错过首个请求的成功或失败结果。
          snapshot: cached?.snapshot ?? null,
          requestedAt: cached?.inFlight ? null : (cached?.requestedAt ?? null),
          inFlight: request,
        });
      }
      setState((current) => ({
        // 切换 Z.AI/BigModel 时不能保留上一家 Coding Plan 的 monitor 快照；
        // 但同一 provider 切换 today/7d/30d 时保留旧快照，避免 Quota Remaining 和趋势区域闪空。
        snapshot: keepPreviousSnapshot ? current.snapshot : null,
        loading: true,
        error: null,
      }));
      try {
        const snapshot = await request;
        if (requestVersionRef.current !== requestVersion) {
          return;
        }
        if (serviceCache.get(requestScopeKey)?.inFlight === request) {
          serviceCache.set(requestScopeKey, {
            snapshot,
            requestedAt: Date.now(),
          });
        }
        latestSnapshotRef.current = snapshot;
        setState({ snapshot, loading: false, error: null });
      } catch (error) {
        if (requestVersionRef.current !== requestVersion) {
          return;
        }
        const message = getErrorMessage(error);
        logger.warn("[useCodingPlanUsageStats] 读取 Coding Plan 使用统计失败", {
          range,
          preferredProviderId,
          timeZone,
          error: message,
        });
        // 失败请求不能保留本次 access 预写入的 cache entry。
        // 否则 TTL 内重新打开同一组织会跳过真实请求，展示旧来源快照或静默空掉错误。
        if (serviceCache.get(requestScopeKey)?.inFlight === request) {
          serviceCache.delete(requestScopeKey);
        }
        latestSnapshotRef.current = null;
        setState({ snapshot: null, loading: false, error: message });
      }
    },
    [
      accountAccess,
      customEndDate,
      customStartDate,
      enabled,
      preferredProviderId,
      range,
      requestIdentityKey,
      requestScopeKey,
      usageStatsService,
    ],
  );

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { ...state, refresh };
}

export interface ModelRequestRateState {
  snapshot: V4UsageModelRateResult | null;
  loading: boolean;
  error: string | null;
}

const MODEL_REQUEST_RATE_POLL_INTERVAL_MS = 2_000;

/**
 * 模型级、跨会话的请求吞吐。
 *
 * 窗口由 CLI 时钟计算（只传 windowMs），因此 1m/5m 这类短窗口不会因为当前会话的
 * agent 轮跑得太久而变空。旧 host 没有该方法时返回 null，由 HUD 显示 “—”。
 */
export function useModelRequestRate(options: {
  providerId: string;
  modelId: string;
  windowMs: number;
  enabled?: boolean;
  pollIntervalMs?: number;
}): ModelRequestRateState {
  const { usageStatsService } = useServices();
  const { providerId, modelId, windowMs, enabled = true } = options;
  const pollIntervalMs = Math.max(
    250,
    options.pollIntervalMs ?? MODEL_REQUEST_RATE_POLL_INTERVAL_MS,
  );
  const [state, setState] = useState<ModelRequestRateState>({
    snapshot: null,
    loading: false,
    error: null,
  });
  const requestVersionRef = useRef(0);
  const supported = typeof usageStatsService?.getModelRequestRate === "function";

  const refresh = useCallback(async () => {
    if (!enabled || !supported || !providerId || !modelId) return;
    const requestVersion = ++requestVersionRef.current;
    try {
      const snapshot = await usageStatsService.getModelRequestRate!({
        providerId,
        modelId,
        windowMs,
      } satisfies V4UsageModelRateParams);
      if (requestVersionRef.current !== requestVersion) return;
      setState({ snapshot, loading: false, error: null });
    } catch (error) {
      if (requestVersionRef.current !== requestVersion) return;
      const message = getErrorMessage(error);
      logger.warn("[useModelRequestRate] 读取模型请求速率失败", {
        providerId,
        modelId,
        windowMs,
        error: message,
      });
      // 轮询失败保留上一份成功快照，避免浮层在请求间隙闪烁。
      setState((current) => ({ ...current, loading: false, error: message }));
    }
  }, [enabled, supported, usageStatsService, providerId, modelId, windowMs]);

  useEffect(() => {
    if (!enabled || !supported) {
      requestVersionRef.current += 1;
      setState({ snapshot: null, loading: false, error: null });
      return;
    }
    // 切换窗口时先清掉旧窗口的数字，避免新标签下短暂显示上一窗口的速率。
    requestVersionRef.current += 1;
    setState({ snapshot: null, loading: true, error: null });
    void refresh();
    const timer = window.setInterval(() => void refresh(), pollIntervalMs);
    return () => {
      requestVersionRef.current += 1;
      window.clearInterval(timer);
    };
  }, [enabled, supported, refresh, pollIntervalMs]);

  return state;
}
