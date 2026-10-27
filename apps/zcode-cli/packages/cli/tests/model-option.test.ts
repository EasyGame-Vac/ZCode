import assert from "node:assert/strict";
import { test } from "node:test";
import type { ZCodeModelOption } from "@zcode/shared";
import { resolveCliModelSelection } from "../src/provider-runtime-env.js";

const model: ZCodeModelOption = {
  ref: { providerId: "provider-a", modelId: "model-a" },
  label: "model-a",
  providerLabel: "Provider A",
  reasoning: {
    levels: [
      { value: "low", label: "low" },
      { value: "high", label: "high" },
    ],
    defaultLevel: "high",
  },
  properties: {
    inputFormat: { supportsText: true },
    outputFormat: { supportsText: true },
  } as ZCodeModelOption["properties"],
};

test("resolveCliModelSelection uses the model default reasoning level", () => {
  assert.deepEqual(resolveCliModelSelection("provider-a/model-a", [model]), {
    providerId: "provider-a",
    modelId: "model-a",
    options: { reasoningLevel: "high" },
  });
});

test("resolveCliModelSelection keeps an explicit reasoning level", () => {
  assert.deepEqual(resolveCliModelSelection("provider-a/model-a$low", [model]), {
    providerId: "provider-a",
    modelId: "model-a",
    options: { reasoningLevel: "low" },
  });
});

test("resolveCliModelSelection rejects unknown models and levels", () => {
  assert.throws(
    () => resolveCliModelSelection("provider-a/missing", [model]),
    /Model is not available/,
  );
  assert.throws(
    () => resolveCliModelSelection("provider-a/model-a$max", [model]),
    /is not supported/,
  );
  assert.throws(() => resolveCliModelSelection("model-a", [model]), /Invalid --model value/);
});

test("resolveCliModelSelection rejects a disabled model", () => {
  assert.throws(
    () =>
      resolveCliModelSelection("provider-a/model-a", [
        { ...model, disabledReason: "account is not entitled" },
      ]),
    /Model is unavailable: account is not entitled/,
  );
});
