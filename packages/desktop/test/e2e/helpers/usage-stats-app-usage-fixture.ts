import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { seedProviderReadinessHistoryFixture } from "./provider-readiness-history-fixture.js";

const DAY_MS = 24 * 60 * 60 * 1000;

export async function seedAppUsageE2EFixture(options: {
  cliEntryPoint: string;
  e2eHomeDir: string;
  workspacePath: string;
}): Promise<void> {
  const now = Date.now();
  await seedHistory(options, "sess_e2e_usage_primary", "E2E App Usage Primary");
  await seedHistory(options, "sess_e2e_usage_secondary", "E2E App Usage Secondary");

  const database = new DatabaseSync(appUsageDatabasePath(options.e2eHomeDir));
  try {
    database.exec("begin immediate");
    insertUsage(database, {
      id: "usage-primary-alpha",
      modelId: "e2e-model-alpha",
      sessionId: "sess_e2e_usage_primary",
      startedAt: now - DAY_MS,
      tokens: 1_200,
      turnId: "turn-primary-alpha",
      durationMs: 60 * 60 * 1000,
    });
    insertUsage(database, {
      id: "usage-primary-beta",
      modelId: "e2e-model-beta",
      sessionId: "sess_e2e_usage_primary",
      startedAt: now - 2 * DAY_MS,
      tokens: 800,
      turnId: "turn-primary-beta",
      durationMs: 30 * 60 * 1000,
    });
    insertUsage(database, {
      id: "usage-secondary-gamma",
      modelId: "e2e-model-gamma",
      sessionId: "sess_e2e_usage_secondary",
      startedAt: now - 10 * DAY_MS,
      tokens: 2_000,
      turnId: "turn-secondary-gamma",
      durationMs: 20 * 60 * 1000,
    });
    insertUsage(database, {
      id: "usage-secondary-old",
      modelId: "e2e-model-old",
      sessionId: "sess_e2e_usage_secondary",
      startedAt: now - 45 * DAY_MS,
      tokens: 5_000,
      turnId: "turn-secondary-old",
      durationMs: 10 * 60 * 1000,
    });
    for (let index = 0; index < 5; index += 1) {
      insertUsage(database, {
        id: `usage-extra-${index}`,
        modelId: `e2e-model-extra-${index}`,
        sessionId: "sess_e2e_usage_secondary",
        startedAt: now - (3 + index) * DAY_MS,
        tokens: 100 + index,
        turnId: `turn-extra-${index}`,
        durationMs: 60_000,
      });
    }
    database.exec("commit");
  } catch (error) {
    database.exec("rollback");
    throw error;
  } finally {
    database.close();
  }
}

export function clearAppUsageE2EFixture(e2eHomeDir: string): void {
  const database = new DatabaseSync(appUsageDatabasePath(e2eHomeDir));
  try {
    database.exec("delete from tool_usage; delete from turn_usage; delete from model_usage;");
  } finally {
    database.close();
  }
}

/**
 * PERF HUD E2E：为当前有效 provider/model 写入最近一分钟内的请求样本。
 *
 * 运行中写入，依赖 WAL + busy_timeout 与 CLI 的读连接共存；session_id 取库里最新的
 * 会话（foreign_keys 打开时也能满足 FK）。样本故意做成 4 条 4000ms/500 tokens，
 * 保证 1m 窗口有稳定的加权速率可断言。
 */
export function seedModelRateE2EFixture(input: {
  e2eHomeDir: string;
  providerId: string;
  modelId: string;
}): void {
  const database = new DatabaseSync(appUsageDatabasePath(input.e2eHomeDir));
  try {
    database.exec("pragma busy_timeout = 4000;");
    const session = database
      .prepare("select id from session order by time_updated desc limit 1")
      .get() as { id?: string } | undefined;
    if (!session?.id) {
      throw new Error("PERF HUD E2E: 数据库里没有可用的 session 行");
    }
    const now = Date.now();
    const insert = database.prepare(
      `insert or replace into model_usage (
        id, logical_request_id, session_id, turn_id, query_source, provider_id, model_id,
        status, started_at, first_token_at, completed_at, duration_ms, time_to_first_token_ms,
        input_tokens, output_tokens, computed_total_tokens
      ) values (?, ?, ?, ?, 'main_turn', ?, ?, 'completed', ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    database.exec("begin immediate");
    for (let index = 0; index < 4; index += 1) {
      const startedAt = now - 20_000 + index * 3_000;
      const firstTokenAt = startedAt + 100;
      const completedAt = firstTokenAt + 4_000;
      const id = `perf-hud-rate-${now}-${index}`;
      insert.run(
        id,
        `request-${id}`,
        session.id,
        `turn-perf-hud-${now}`,
        input.providerId,
        input.modelId,
        startedAt,
        firstTokenAt,
        completedAt,
        4_100,
        100,
        1_000,
        500,
        1_500,
      );
    }
    database.exec("commit");
  } catch (error) {
    try {
      database.exec("rollback");
    } catch {
      /* 事务未开启时 rollback 会抛错，忽略即可。 */
    }
    throw error;
  } finally {
    database.close();
  }
}

async function seedHistory(
  options: { cliEntryPoint: string; e2eHomeDir: string; workspacePath: string },
  sessionId: string,
  title: string,
): Promise<void> {
  await seedProviderReadinessHistoryFixture({
    ...options,
    history: {
      assistantInputTokens: 0,
      assistantOutputTokens: 0,
      assistantText: `${sessionId} assistant history`,
      modelId: "e2e-model-alpha",
      runtimeProviderId: "e2e-usage-provider",
      sessionId,
      taskProviderId: "glm",
      title,
      userText: `${sessionId} user history`,
    },
  });
}

function appUsageDatabasePath(e2eHomeDir: string): string {
  return join(e2eHomeDir, ".zcode", "cli", "db", "db.sqlite");
}

function insertUsage(
  database: DatabaseSync,
  input: {
    durationMs: number;
    id: string;
    modelId: string;
    sessionId: string;
    startedAt: number;
    tokens: number;
    turnId: string;
  },
): void {
  database
    .prepare(
      `insert into model_usage (
        id, logical_request_id, session_id, turn_id, query_source, provider_id, model_id,
        status, started_at, completed_at, duration_ms, input_tokens, output_tokens,
        computed_total_tokens
      ) values (?, ?, ?, ?, 'main_turn', 'e2e-usage-provider', ?, 'completed', ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.id,
      `request-${input.id}`,
      input.sessionId,
      input.turnId,
      input.modelId,
      input.startedAt,
      input.startedAt + input.durationMs,
      input.durationMs,
      Math.floor(input.tokens * 0.8),
      input.tokens - Math.floor(input.tokens * 0.8),
      input.tokens,
    );
  database
    .prepare(
      `insert into turn_usage (
        session_id, turn_id, status, started_at, completed_at, duration_ms,
        model_request_count, input_tokens, output_tokens, computed_total_tokens
      ) values (?, ?, 'completed', ?, ?, ?, 1, ?, ?, ?)`,
    )
    .run(
      input.sessionId,
      input.turnId,
      input.startedAt,
      input.startedAt + input.durationMs,
      input.durationMs,
      Math.floor(input.tokens * 0.8),
      input.tokens - Math.floor(input.tokens * 0.8),
      input.tokens,
    );
}
