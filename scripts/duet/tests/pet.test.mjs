import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { classifyEvent, createEventStream, createLineParser } from "../pet/lib/event-parser.mjs";
import { createMessageStore } from "../pet/lib/message-store.mjs";
import { createModelCatalog } from "../pet/lib/model-catalog.mjs";
import { createInitialPetState, reducePetState } from "../pet/lib/state-machine.mjs";
import { createSupervisorActions } from "../pet/lib/supervisor-actions.mjs";
import { createSupervisorClient, SupervisorError } from "../pet/lib/supervisor-client.mjs";
import { shouldShowTaskPreview } from "../pet/lib/task-preview.mjs";
import { createWindowDrag } from "../pet/lib/window-drag.mjs";
import { roundedWindowShape } from "../pet/lib/window-shape.mjs";

test("classifyEvent maps text, tools and the final result", () => {
  assert.deepEqual(
    classifyEvent({
      type: "part.delta",
      payload: { field: "text", delta: "hello" },
    }),
    { kind: "assistant-delta", text: "hello" },
  );
  assert.deepEqual(
    classifyEvent({
      type: "part.delta",
      payload: { field: "reasoning", delta: "thinking" },
    }),
    { kind: "reasoning-delta", text: "thinking" },
  );
  assert.deepEqual(
    classifyEvent({
      type: "tool.updated",
      payload: { kind: "started", toolCallId: "t1", toolName: "bash" },
    }),
    { kind: "tool", phase: "started", toolCallId: "t1", toolName: "bash", description: null },
  );
  assert.deepEqual(
    classifyEvent({
      type: "result",
      sessionId: "s1",
      response: "done",
      usage: { inputTokens: 1 },
    }),
    { kind: "result", sessionId: "s1", text: "done", usage: { inputTokens: 1 }, projection: null },
  );
  assert.equal(classifyEvent({ type: "unknown.event", payload: {} }), null);
  assert.equal(
    classifyEvent({ type: "part.delta", payload: { field: "output", delta: "x" } }),
    null,
  );
});

test("line parser reassembles NDJSON split across chunks", () => {
  const lines = [];
  const parser = createLineParser((line) => lines.push(line));
  parser.push('{"a":1}\n{"b":');
  parser.push('2}\r\n{"c":3}');
  parser.flush();
  assert.deepEqual(lines, ['{"a":1}', '{"b":2}', '{"c":3}']);
});

test("event stream ignores malformed lines and emits known events", () => {
  const events = [];
  const malformed = [];
  const stream = createEventStream({
    onEvent: (event) => events.push(event),
    onMalformed: (line) => malformed.push(line),
  });

  stream.push('not-json\n{"type":"part.delta","payload":{"field":"text","delta":"he"}}\n');
  stream.push('{"type":"part.delta","payload":{"field":"text","delta":"llo"}}\n');
  stream.push('{"type":"result","sessionId":"s1","response":"hello"}\n');
  stream.flush();

  assert.deepEqual(malformed, ["not-json"]);
  assert.deepEqual(
    events.map((event) => event.kind),
    ["assistant-delta", "assistant-delta", "result"],
  );
  assert.equal(events[0].text, "he");
  assert.equal(events[1].text, "llo");
  assert.equal(events[2].text, "hello");
});

test("pet state machine follows a task and announces success once", () => {
  let state = createInitialPetState();
  state = reducePetState(state, {
    type: "init",
    status: { targets: { w: { status: "running" } }, activation: null },
  });
  assert.equal(state.mode, "idle");
  assert.equal(state.lastWStatus, "running");

  state = reducePetState(state, { type: "user-message", text: "改个按钮" });
  assert.equal(state.mode, "thinking");
  assert.equal(state.messages.at(-1).text, "改个按钮");

  state = reducePetState(state, { type: "brain-start" });
  state = reducePetState(state, { type: "assistant-delta", text: "正在" });
  state = reducePetState(state, { type: "assistant-delta", text: "修改" });
  state = reducePetState(state, {
    type: "tool",
    toolName: "bash",
    phase: "started",
    toolCallId: "t1",
  });
  assert.equal(state.mode, "working");
  assert.equal(state.activity.at(-1).text.includes("bash"), true);

  state = reducePetState(state, { type: "result", text: "改好了", sessionId: "s1" });
  assert.equal(state.mode, "waiting");
  assert.equal(state.busy, false);
  assert.equal(state.messages.at(-1).text, "改好了");
  assert.equal(state.sessionId, "s1");

  const succeeded = {
    id: "a1",
    status: "succeeded",
    commit: "abcdef1234567890",
    error: null,
  };
  state = reducePetState(state, {
    type: "supervisor-status",
    status: { targets: { w: { status: "running" } }, activation: succeeded },
  });
  const messageCount = state.messages.length;
  assert.equal(state.mode, "waiting");
  assert.equal(state.messages.at(-1).text.includes("已更新到"), true);

  state = reducePetState(state, {
    type: "supervisor-status",
    status: { targets: { w: { status: "running" } }, activation: succeeded },
  });
  assert.equal(state.messages.length, messageCount);

  state = reducePetState(state, {
    type: "preview",
    preview: { changes: [{ status: "M", path: "a.ts" }], protected: { ok: true } },
  });
  state = reducePetState(state, {
    type: "supervisor-status",
    status: { targets: { w: { status: "running" } }, activation: succeeded },
  });
  assert.equal(state.mode, "waiting");
  assert.notEqual(state.preview, null);
});

test("pet state machine restores persisted messages on init", () => {
  const state = reducePetState(createInitialPetState(), {
    type: "init",
    status: null,
    messages: [{ id: "m1", role: "user", text: "之前的对话" }],
  });
  assert.deepEqual(
    state.messages.map((message) => message.text),
    ["之前的对话"],
  );
});

test("pet state machine reports a brain failure and a window crash once", () => {
  let state = createInitialPetState();
  state = reducePetState(state, { type: "user-message", text: "hi" });
  state = reducePetState(state, { type: "brain-start" });
  state = reducePetState(state, { type: "brain-exit", code: 1, stderrTail: "boom" });
  assert.equal(state.mode, "error");
  assert.equal(state.busy, false);
  assert.equal(state.messages.at(-1).text.includes("boom"), true);

  let crashed = createInitialPetState();
  crashed = reducePetState(crashed, {
    type: "init",
    status: { targets: { w: { status: "running" } }, activation: null },
  });
  crashed = reducePetState(crashed, {
    type: "supervisor-status",
    status: { targets: { w: { status: "stopped" } }, activation: null },
  });
  assert.equal(crashed.mode, "error");
  assert.equal(
    crashed.messages.some((message) => message.text.includes("窗口版好像挂了")),
    true,
  );
  const crashMessageCount = crashed.messages.length;

  crashed = reducePetState(crashed, {
    type: "supervisor-status",
    status: { targets: { w: { status: "stopped" } }, activation: null },
  });
  assert.equal(crashed.messages.length, crashMessageCount);
});

test("brain failure keeps one readable stderr line instead of the raw JSON dump", () => {
  let state = createInitialPetState();
  state = reducePetState(state, { type: "user-message", text: "hi" });
  state = reducePetState(state, { type: "brain-start" });
  state = reducePetState(state, {
    type: "brain-exit",
    code: 1,
    stderrTail: [
      '{\n  "name": "AI_APICallError",',
      '  "isRetryable": false',
      "}",
      "Error: Turn execution failed (traceId: abc)",
      "brain exited with an error",
    ].join("\n"),
  });

  assert.equal(state.mode, "error");
  assert.equal(
    state.messages.at(-1).text,
    "小人运行失败：Error: Turn execution failed (traceId: abc)",
  );
});

test("model catalog reads the CLI JSON, tolerates log noise and caches the result", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zcode-duet-models-"));
  try {
    const script = join(directory, "models.mjs");
    await writeFile(
      script,
      [
        'console.log("refreshing providers…");',
        "console.log(JSON.stringify({",
        "  ok: true,",
        '  current: { providerId: "p", modelId: "m" },',
        '  models: [{ ref: { providerId: "p", modelId: "m" } }]',
        "}));",
      ].join("\n"),
    );
    let runs = 0;
    const catalog = createModelCatalog({
      resolveCommand: () => {
        runs += 1;
        return { command: process.execPath, args: [script], cwd: directory };
      },
      ttlMs: 60_000,
    });

    const first = await catalog.listModels();
    assert.deepEqual(first.current, { providerId: "p", modelId: "m" });
    assert.equal(first.models.length, 1);
    const second = await catalog.listModels();
    assert.equal(second, first);
    assert.equal(runs, 1);
  } finally {
    await rm(directory, { force: true, maxRetries: 10, recursive: true, retryDelay: 100 });
  }
});

test("window drag follows the cursor delta and saves once on stop", async () => {
  let cursor = { x: 100, y: 200 };
  const positions = [];
  let ended = 0;
  const window = {
    getBounds: () => ({ x: 10, y: 20, width: 180, height: 220 }),
    isDestroyed: () => false,
    setPosition: (x, y) => positions.push([x, y]),
  };
  const drag = createWindowDrag({
    getWindow: () => window,
    screen: { getCursorScreenPoint: () => cursor },
    pollMs: 10,
    timeoutMs: 1_000,
    onEnd: () => {
      ended += 1;
    },
  });

  drag.start();
  cursor = { x: 160, y: 240 };
  await new Promise((resolve) => setTimeout(resolve, 50));
  drag.stop();
  drag.stop();

  assert.ok(
    positions.some(([x, y]) => x === 70 && y === 60),
    JSON.stringify(positions),
  );
  assert.equal(ended, 1);
});

test("rounded window shape insets the top and bottom corners and keeps a full middle band", () => {
  const rects = roundedWindowShape(360, 520, 20);
  assert.equal(rects.length, 41);
  assert.deepEqual(
    rects.find((rect) => rect.y === 20),
    { x: 0, y: 20, width: 360, height: 480 },
  );
  const top = rects.find((rect) => rect.y === 0);
  const bottom = rects.find((rect) => rect.y === 519);
  assert.ok(top.x > 0 && top.width < 360, JSON.stringify(top));
  assert.ok(bottom.x > 0 && bottom.width < 360, JSON.stringify(bottom));
});

test("message store round-trips visible messages and ignores invalid roles", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zcode-duet-messages-"));
  try {
    const store = createMessageStore(join(directory, "pet-messages.json"));
    assert.deepEqual(await store.read(), []);

    await store.save([
      { role: "user", text: "改窗口" },
      { role: "assistant", text: "好" },
      { role: "system", text: "不应保存" },
      { role: "assistant", text: "" },
    ]);
    const read = await store.read();
    assert.deepEqual(
      read.map((message) => [message.role, message.text]),
      [
        ["user", "改窗口"],
        ["assistant", "好"],
      ],
    );

    await store.clear();
    assert.deepEqual(await store.read(), []);
  } finally {
    await rm(directory, { force: true, maxRetries: 10, recursive: true, retryDelay: 100 });
  }
});

test("task preview only appears for commits created by this task", () => {
  const changes = [{ status: "M", path: "a.ts" }];
  assert.equal(
    shouldShowTaskPreview({ startHead: "a", endHead: "a", changes, dirty: false }),
    false,
  );
  assert.equal(
    shouldShowTaskPreview({ startHead: "a", endHead: "b", changes, dirty: false }),
    true,
  );
  assert.equal(
    shouldShowTaskPreview({ startHead: "a", endHead: "b", changes: [], dirty: true }),
    true,
  );
  assert.equal(
    shouldShowTaskPreview({ startHead: "a", endHead: "b", changes: [], dirty: false }),
    false,
  );
  assert.equal(
    shouldShowTaskPreview({ startHead: undefined, endHead: "b", changes, dirty: false }),
    false,
  );
});

test("supervisor actions clamp renderer payloads and reject unknown actions", async () => {
  const calls = [];
  const actions = createSupervisorActions({
    getSupervisor: () => ({
      activate: async (body) => {
        calls.push(["activate", body]);
        return { ok: true };
      },
      getLedger: async (limit) => {
        calls.push(["ledger", limit]);
        return { ok: true };
      },
      getStatus: async () => ({ ok: true }),
      preview: async (body) => {
        calls.push(["preview", body]);
        return { ok: true };
      },
      restart: async (body) => {
        calls.push(["restart", body]);
        return { ok: true };
      },
      rollback: async (body) => {
        calls.push(["rollback", body]);
        return { ok: true };
      },
    }),
  });

  await actions.handle("activate", {
    commit: "c".repeat(300),
    profile: "x".repeat(100),
    target: "k",
    tests: ["a", 3, "b"],
  });
  assert.deepEqual(calls.at(-1), [
    "activate",
    {
      actor: "pet",
      commit: "c".repeat(128),
      profile: "x".repeat(32),
      target: "w",
      tests: ["a", "b"],
    },
  ]);

  await actions.handle("ledger", { limit: 999 });
  assert.deepEqual(calls.at(-1), ["ledger", 200]);

  await assert.rejects(() => actions.handle("delete-everything"), /未知的宿管动作/);
});

async function withServer(handler, run) {
  const server = createServer(handler);
  await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  try {
    return await run(baseUrl);
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolveClose) => server.close(resolveClose));
  }
}

test("supervisor client sends the token and rejects an unauthorized response", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zcode-duet-pet-"));
  try {
    const tokenPath = join(directory, "token");
    await writeFile(tokenPath, "test-token\n");

    const seen = [];
    await withServer(
      async (request, response) => {
        const chunks = [];
        for await (const chunk of request) chunks.push(chunk);
        const body = chunks.length > 0 ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : null;
        seen.push({ authorization: request.headers.authorization, body, url: request.url });

        if (request.headers.authorization !== "Bearer test-token") {
          response.writeHead(401, { "content-type": "application/json" });
          response.end(JSON.stringify({ ok: false, error: "unauthorized" }));
          return;
        }
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({ ok: true, authorization: request.headers.authorization, body }),
        );
      },
      async (baseUrl) => {
        const client = createSupervisorClient({ baseUrl, tokenPath });
        const status = await client.getStatus();
        assert.equal(status.authorization, "Bearer test-token");

        const preview = await client.preview({ target: "w" });
        assert.deepEqual(preview.body, { target: "w" });

        const lease = await client.lease({
          target: "k",
          leaseId: "lease-1",
          holder: "pet",
        });
        assert.deepEqual(lease.body, { target: "k", leaseId: "lease-1", holder: "pet" });

        const release = await client.release({
          target: "k",
          leaseId: "lease-1",
          holder: "pet",
        });
        assert.deepEqual(release.body, { target: "k", leaseId: "lease-1", holder: "pet" });

        const wrongTokenPath = join(directory, "wrong-token");
        await writeFile(wrongTokenPath, "wrong\n");
        const denied = createSupervisorClient({ baseUrl, tokenPath: wrongTokenPath });
        await assert.rejects(
          () => denied.getStatus(),
          (error) => error instanceof SupervisorError && error.status === 401,
        );

        const missingTokenPath = join(directory, "missing-token");
        const missing = createSupervisorClient({ baseUrl, tokenPath: missingTokenPath });
        await assert.rejects(
          () => missing.getStatus(),
          (error) => error instanceof SupervisorError && error.status === 0,
        );
        await writeFile(missingTokenPath, "test-token\n");
        const recovered = await missing.getStatus();
        assert.equal(recovered.ok, true);
      },
    );

    assert.equal(seen.length >= 3, true);
  } finally {
    await rm(directory, { force: true, maxRetries: 10, recursive: true, retryDelay: 100 });
  }
});
