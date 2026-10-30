import { describe, expect, it } from "vitest";
import {
  summarizeLagFrames,
  type LagFrameSample,
  type LagScriptSample,
} from "@/lib/memoryDiagnostics.js";

function script(
  functionName: string,
  durationMs: number,
  invoker = "FrameRequestCallback",
): LagScriptSample {
  return {
    url: "http://localhost:5174/src/example.tsx",
    functionName,
    durationMs,
    forcedStyleLayoutMs: 0,
    invoker,
  };
}

function frame(durationMs: number, scripts: LagScriptSample[] = []): LagFrameSample {
  return {
    startTime: 100,
    durationMs,
    blockingMs: 0,
    scripts,
  };
}

describe("summarizeLagFrames", () => {
  it("empty buffer produces an empty summary", () => {
    expect(summarizeLagFrames([])).toEqual({
      longFrames: 0,
      maxMs: 0,
      p95Ms: 0,
      totalMs: 0,
      blockingMs: 0,
      topScripts: [],
      topInvokers: [],
    });
  });

  it("computes max/p95/blocking and aggregates top scripts", () => {
    const summary = summarizeLagFrames([
      frame(60, [script("React reconcile", 100), script("markdown", 30, "MessagePort.onmessage")]),
      frame(120, [script("React reconcile", 50)]),
      frame(240, [script("markdown", 40, "MessagePort.onmessage")]),
    ]);

    expect(summary.longFrames).toBe(3);
    expect(summary.maxMs).toBe(240);
    expect(summary.p95Ms).toBe(240);
    expect(summary.totalMs).toBe(420);
    expect(summary.topScripts[0]).toMatchObject({
      key: "React reconcile @ http://localhost:5174/src/example.tsx",
      durationMs: 150,
    });
    expect(summary.topScripts[1]).toMatchObject({
      key: expect.stringContaining("markdown"),
      durationMs: 70,
    });
    expect(summary.topInvokers[0]).toEqual({
      invoker: "FrameRequestCallback",
      durationMs: 150,
    });
    expect(summary.topInvokers[1]).toEqual({
      invoker: "MessagePort.onmessage",
      durationMs: 70,
    });
  });
});
