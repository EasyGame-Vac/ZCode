import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { classifyEvent, createEventStream, createLineParser } from "../pet/lib/event-parser.mjs";
import { createInitialPetState, reducePetState } from "../pet/lib/state-machine.mjs";
import { createSupervisorClient, SupervisorError } from "../pet/lib/supervisor-client.mjs";

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
