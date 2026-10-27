import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";

const SKIPPED_DIRECTORIES = new Set([".git", ".duet", "dist", "node_modules"]);

function toRepoPath(repoRoot, filePath) {
  return relative(repoRoot, filePath).replaceAll("\\", "/");
}

export async function hashFile(filePath) {
  const content = await readFile(filePath);
  return createHash("sha256").update(content).digest("hex");
}

export async function listFilesRecursive(root) {
  const result = [];
  const entries = await readdir(root, { withFileTypes: true });

  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (entry.isSymbolicLink()) continue;
    const absolute = join(root, entry.name);
    if (entry.isDirectory()) {
      if (SKIPPED_DIRECTORIES.has(entry.name)) continue;
      result.push(...(await listFilesRecursive(absolute)));
      continue;
    }
    if (entry.isFile()) result.push(absolute);
  }

  return result;
}

/**
 * Hashes a fixed set of gate files and directories. The combined hash is what
 * the supervisor remembers; the per-file hashes are only for diagnostics.
 */
export async function computeGateHashes({ repoRoot, gatePaths }) {
  const files = new Map();

  for (const gatePath of gatePaths) {
    const absolute = resolve(repoRoot, gatePath);
    const info = await stat(absolute).catch(() => null);
    if (!info) {
      files.set(toRepoPath(repoRoot, absolute), "missing");
      continue;
    }

    if (info.isDirectory()) {
      for (const file of await listFilesRecursive(absolute)) {
        files.set(toRepoPath(repoRoot, file), await hashFile(file));
      }
      continue;
    }

    files.set(toRepoPath(repoRoot, absolute), await hashFile(absolute));
  }

  const entries = [...files.entries()].sort(([left], [right]) => left.localeCompare(right));
  const combined = createHash("sha256")
    .update(entries.map(([path, hash]) => `${path}:${hash}`).join("\n"))
    .digest("hex");

  return {
    combined,
    files: Object.fromEntries(entries),
    computedAt: new Date().toISOString(),
  };
}

export async function readGateManifest(manifestPath) {
  try {
    return JSON.parse(await readFile(manifestPath, "utf8"));
  } catch {
    return null;
  }
}

export async function writeGateManifest(manifestPath, manifest) {
  await mkdir(dirname(manifestPath), { recursive: true });
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

export function diffGateFiles(previousFiles = {}, currentFiles = {}) {
  const paths = new Set([...Object.keys(previousFiles), ...Object.keys(currentFiles)]);
  const changes = [];
  for (const path of [...paths].sort()) {
    const previous = previousFiles[path] ?? null;
    const current = currentFiles[path] ?? null;
    if (previous === current) continue;
    changes.push({
      path,
      previous,
      current,
      kind: previous === null ? "added" : current === null ? "removed" : "modified",
    });
  }
  return changes;
}

export class GateChangedError extends Error {
  constructor(message, details) {
    super(message);
    this.name = "GateChangedError";
    this.code = "GATE_CHANGED";
    this.details = details;
  }
}

/**
 * First run creates the manifest. Later runs refuse a changed gate unless the
 * operator explicitly accepts it. This keeps an agent from weakening the
 * verification script and then asking the supervisor to use it.
 */
export async function ensureGateManifest({
  repoRoot,
  gatePaths,
  manifestPath,
  acceptChange = false,
}) {
  const hashes = await computeGateHashes({ repoRoot, gatePaths });
  const previous = await readGateManifest(manifestPath);

  if (!previous) {
    await writeGateManifest(manifestPath, hashes);
    return { hashes, changed: false, created: true };
  }

  if (previous.combined === hashes.combined) {
    return { hashes, changed: false, created: false };
  }

  const changes = diffGateFiles(previous.files, hashes.files);
  if (!acceptChange) {
    throw new GateChangedError(
      "Gate files changed. Restart the supervisor with --accept-gate-change after reviewing the diff.",
      { changes, previousCombined: previous.combined, currentCombined: hashes.combined },
    );
  }

  await writeGateManifest(manifestPath, hashes);
  return { hashes, changed: true, created: false, accepted: true, previous, changes };
}

export async function assertGateUnchanged({ repoRoot, gatePaths, expected }) {
  const current = await computeGateHashes({ repoRoot, gatePaths });
  if (current.combined === expected.combined) {
    return { ok: true, current };
  }

  return {
    ok: false,
    current,
    changes: diffGateFiles(expected.files, current.files),
  };
}
