import { readFile } from "node:fs/promises";

export function normalizeRepoPath(value) {
  return String(value)
    .replaceAll("\\", "/")
    .replace(/^\.\/+/, "");
}

function escapeRegExp(value) {
  return value.replace(/[.+^${}()|[\]\\]/g, "\\$&");
}

/**
 * Converts the small glob subset used by protected-paths.json into a RegExp.
 * Supported: a double star followed by a slash (zero or more directories),
 * a bare double star (anything), a single star (one path segment), and `?`
 * (one non-separator character).
 */
export function globToRegExp(pattern) {
  const normalized = normalizeRepoPath(pattern);
  let source = "";

  for (let index = 0; index < normalized.length; index += 1) {
    const character = normalized[index];

    if (character === "*") {
      if (normalized[index + 1] === "*") {
        while (normalized[index + 1] === "*") index += 1;
        if (normalized[index + 1] === "/") {
          index += 1;
          source += "(?:.*/)?";
        } else {
          source += ".*";
        }
      } else {
        source += "[^/]*";
      }
      continue;
    }

    if (character === "?") {
      source += "[^/]";
      continue;
    }

    source += escapeRegExp(character);
  }

  return new RegExp(`^${source}$`);
}

function asRegExpList(value) {
  return Array.isArray(value) ? value.map((item) => globToRegExp(item)) : [];
}

export function normalizeProtectedPaths(raw) {
  return {
    blockAny: asRegExpList(raw?.blockAny),
    blockModifyOrDelete: asRegExpList(raw?.blockModifyOrDelete),
    allowExtensionPrefixes: Array.isArray(raw?.allowExtensionPrefixes)
      ? raw.allowExtensionPrefixes.map((item) => normalizeRepoPath(item))
      : [],
  };
}

export async function loadProtectedPaths(filePath) {
  const raw = JSON.parse(await readFile(filePath, "utf8"));
  return normalizeProtectedPaths(raw);
}

/**
 * Parses `git diff --name-status` output. Rename/copy records carry the old
 * and new path; every other record carries one path.
 */
export function parseNameStatus(output) {
  const changes = [];

  for (const line of String(output).split(/\r?\n/)) {
    if (!line.trim()) continue;
    const parts = line.split("\t");
    const status = (parts[0] ?? "").trim();
    if (!status) continue;

    if (status.startsWith("R") || status.startsWith("C")) {
      changes.push({
        status: status[0],
        oldPath: parts[1] ?? "",
        path: parts[2] ?? parts[1] ?? "",
      });
      continue;
    }

    changes.push({
      status: status[0],
      path: parts[1] ?? "",
    });
  }

  return changes;
}

function matchingRule(path, rules) {
  return rules.some((rule) => rule.test(path));
}

/**
 * A change is blocked when:
 * - any touched path matches `blockAny`, or
 * - a non-addition touches `blockModifyOrDelete` (existing tests may be added,
 *   but not modified, renamed, or deleted).
 */
export function evaluateChangedPaths(changes, policy) {
  const violations = [];

  for (const change of changes) {
    const paths = [change.path, change.oldPath]
      .filter((value) => typeof value === "string" && value.length > 0)
      .map((value) => normalizeRepoPath(value));

    for (const path of paths) {
      if (matchingRule(path, policy.blockAny)) {
        violations.push({ path, status: change.status, rule: "blockAny" });
        continue;
      }

      if (change.status !== "A" && matchingRule(path, policy.blockModifyOrDelete)) {
        violations.push({ path, status: change.status, rule: "blockModifyOrDelete" });
      }
    }
  }

  return { ok: violations.length === 0, violations };
}

/**
 * Reverse iteration is limited to K extension directories such as
 * `.agents/skills/duet-*`. A record with any path outside those prefixes is
 * rejected.
 */
export function validateExtensionChanges(changes, prefixes) {
  if (changes.length === 0) {
    return {
      ok: false,
      violations: [{ path: "", status: "", rule: "empty-change-set" }],
    };
  }

  const violations = [];

  for (const change of changes) {
    const paths = [change.path, change.oldPath]
      .filter((value) => typeof value === "string" && value.length > 0)
      .map((value) => normalizeRepoPath(value));

    for (const path of paths) {
      if (!prefixes.some((prefix) => path.startsWith(prefix))) {
        violations.push({ path, status: change.status, rule: "extension-prefix" });
      }
    }
  }

  return { ok: violations.length === 0, violations };
}
