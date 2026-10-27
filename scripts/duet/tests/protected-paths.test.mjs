import assert from "node:assert/strict";
import test from "node:test";
import {
  evaluateChangedPaths,
  globToRegExp,
  normalizeProtectedPaths,
  normalizeRepoPath,
  parseNameStatus,
  validateExtensionChanges,
} from "../lib/protected-paths.mjs";

test("normalizeRepoPath converts separators and leading dot segments", () => {
  assert.equal(normalizeRepoPath("scripts\\duet\\verify.mjs"), "scripts/duet/verify.mjs");
  assert.equal(normalizeRepoPath("./scripts/duet/verify.mjs"), "scripts/duet/verify.mjs");
});

test("globToRegExp supports **, * and ?", () => {
  assert.equal(globToRegExp("scripts/duet/**").test("scripts/duet/verify.mjs"), true);
  assert.equal(globToRegExp("scripts/duet/**").test("scripts/duetx/verify.mjs"), false);
  assert.equal(globToRegExp("**/*.test.ts").test("c.test.ts"), true);
  assert.equal(globToRegExp("**/*.test.ts").test("a/b/c.test.ts"), true);
  assert.equal(globToRegExp("**/*.test.ts").test("c.test.tsx"), false);
  assert.equal(globToRegExp("**/tsconfig*.json").test("packages/x/tsconfig.main.json"), true);
  assert.equal(globToRegExp("a?c").test("abc"), true);
  assert.equal(globToRegExp("a?c").test("a/c"), false);
});

test("parseNameStatus handles add, modify and rename records", () => {
  const changes = parseNameStatus(
    ["M\tscripts/duet/verify.mjs", "A\tnotes.txt", "R100\told.ts\tnew.ts", ""].join("\n"),
  );

  assert.deepEqual(changes, [
    { status: "M", path: "scripts/duet/verify.mjs" },
    { status: "A", path: "notes.txt" },
    { status: "R", oldPath: "old.ts", path: "new.ts" },
  ]);
});

test("evaluateChangedPaths blocks protected changes but allows new tests", () => {
  const policy = normalizeProtectedPaths({
    blockAny: ["scripts/duet/**", "**/package.json"],
    blockModifyOrDelete: ["**/*.test.ts"],
    allowExtensionPrefixes: [".agents/skills/duet-"],
  });

  assert.equal(
    evaluateChangedPaths([{ status: "M", path: "scripts/duet/verify.mjs" }], policy).ok,
    false,
  );
  assert.equal(
    evaluateChangedPaths([{ status: "M", path: "apps/x/package.json" }], policy).ok,
    false,
  );
  assert.equal(evaluateChangedPaths([{ status: "A", path: "a/b.test.ts" }], policy).ok, true);
  assert.equal(evaluateChangedPaths([{ status: "M", path: "a/b.test.ts" }], policy).ok, false);
  assert.equal(evaluateChangedPaths([{ status: "D", path: "a/b.test.ts" }], policy).ok, false);
  assert.equal(evaluateChangedPaths([{ status: "A", path: "notes.txt" }], policy).ok, true);

  const violations = evaluateChangedPaths(
    [{ status: "M", path: "scripts/duet/verify.mjs" }],
    policy,
  ).violations;
  assert.equal(violations[0]?.rule, "blockAny");
});

test("validateExtensionChanges keeps reverse iteration under duet skills", () => {
  const prefixes = [".agents/skills/duet-"];

  assert.equal(
    validateExtensionChanges(
      [{ status: "A", path: ".agents/skills/duet-crash-logs/SKILL.md" }],
      prefixes,
    ).ok,
    true,
  );
  assert.equal(validateExtensionChanges([{ status: "M", path: "README.md" }], prefixes).ok, false);
  assert.equal(validateExtensionChanges([], prefixes).ok, false);
});
