const DEFAULT_TTL_MS = 60_000;
const MIN_TTL_MS = 5_000;
const MAX_TTL_MS = 10 * 60_000;

function requiredText(value, name) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) throw new Error(`${name} is required`);
  return text;
}

function optionalText(value, maxLength) {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

/**
 * Target-scoped task leases. A target is busy while at least one non-expired
 * lease exists. Leases are owned by the executor (the agent turn or the pet
 * brain), not by the updater.
 */
export function createLeaseStore({ now = () => Date.now() } = {}) {
  const leasesByTarget = new Map();

  function targetLeases(target) {
    let leases = leasesByTarget.get(target);
    if (!leases) {
      leases = new Map();
      leasesByTarget.set(target, leases);
    }
    return leases;
  }

  function prune(target) {
    const leases = leasesByTarget.get(target);
    if (!leases) return null;
    const current = now();
    for (const [leaseId, lease] of leases) {
      if (lease.expiresAt <= current) leases.delete(leaseId);
    }
    if (leases.size === 0) {
      leasesByTarget.delete(target);
      return null;
    }
    return leases;
  }

  function list(target) {
    const leases = prune(target);
    return leases ? [...leases.values()] : [];
  }

  function busy(target) {
    const leases = list(target);
    return { active: leases.length > 0, leases };
  }

  function acquire(input) {
    const target = requiredText(input?.target, "lease target");
    const leaseId = requiredText(input?.leaseId, "leaseId");
    const ttlMs = Number.isFinite(input?.ttlMs)
      ? Math.min(Math.max(Math.trunc(input.ttlMs), MIN_TTL_MS), MAX_TTL_MS)
      : DEFAULT_TTL_MS;
    const current = now();
    const lease = {
      leaseId,
      holder: optionalText(input?.holder, 128) || "unknown",
      reason: optionalText(input?.reason, 200),
      createdAt: current,
      updatedAt: current,
      expiresAt: current + ttlMs,
    };

    targetLeases(target).set(leaseId, lease);
    return {
      ok: true,
      target,
      lease: { ...lease },
      busy: busy(target),
    };
  }

  function release(input) {
    const target = requiredText(input?.target, "lease target");
    const leaseId = optionalText(input?.leaseId, 128);
    const holder = optionalText(input?.holder, 128);
    if (!leaseId && !holder) throw new Error("leaseId or holder is required");

    const leases = prune(target);
    let released = 0;
    if (leases) {
      if (leaseId) {
        if (leases.delete(leaseId)) released = 1;
      } else {
        for (const [key, lease] of leases) {
          if (lease.holder === holder) {
            leases.delete(key);
            released += 1;
          }
        }
      }
      if (leases.size === 0) leasesByTarget.delete(target);
    }

    return {
      ok: true,
      target,
      released,
      busy: busy(target),
    };
  }

  function clearTarget(target) {
    leasesByTarget.delete(String(target ?? ""));
  }

  return { acquire, release, busy, list, clearTarget };
}
