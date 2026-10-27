import assert from "node:assert/strict";
import test from "node:test";
import { createLeaseStore } from "../lib/leases.mjs";

test("acquire, heartbeat and release mark a target busy", () => {
  let current = 1_000;
  const store = createLeaseStore({ now: () => current });

  const acquired = store.acquire({
    target: "w",
    leaseId: "lease-1",
    holder: "desktop",
    reason: "turn",
    ttlMs: 60_000,
  });
  assert.equal(acquired.ok, true);
  assert.equal(store.busy("w").active, true);
  assert.equal(store.busy("w").leases[0].leaseId, "lease-1");

  current += 30_000;
  store.acquire({
    target: "w",
    leaseId: "lease-1",
    holder: "desktop",
    reason: "turn",
    ttlMs: 60_000,
  });
  assert.equal(store.busy("w").leases[0].expiresAt, current + 60_000);

  const released = store.release({ target: "w", leaseId: "lease-1" });
  assert.equal(released.released, 1);
  assert.equal(store.busy("w").active, false);
});

test("expired leases prune and stop blocking updates", () => {
  let current = 0;
  const store = createLeaseStore({ now: () => current });
  store.acquire({ target: "k", leaseId: "lease-1", holder: "pet", ttlMs: 5_000 });

  current = 5_001;
  assert.equal(store.busy("k").active, false);
  assert.deepEqual(store.busy("k").leases, []);
});

test("release by holder clears only that holder's leases", () => {
  const store = createLeaseStore();
  store.acquire({ target: "w", leaseId: "desktop-1", holder: "desktop" });
  store.acquire({ target: "w", leaseId: "other-1", holder: "other" });

  const result = store.release({ target: "w", holder: "desktop" });
  assert.equal(result.released, 1);
  assert.deepEqual(
    store.busy("w").leases.map((lease) => lease.leaseId),
    ["other-1"],
  );
});

test("clearTarget removes all leases for one target only", () => {
  const store = createLeaseStore();
  store.acquire({ target: "w", leaseId: "w-1", holder: "desktop" });
  store.acquire({ target: "k", leaseId: "k-1", holder: "pet" });

  store.clearTarget("w");
  assert.equal(store.busy("w").active, false);
  assert.equal(store.busy("k").active, true);
});

test("lease validation requires ids and clamps ttl", () => {
  const store = createLeaseStore();
  assert.throws(() => store.acquire({ target: "w" }), /leaseId/);
  assert.throws(() => store.acquire({ leaseId: "x" }), /target/);
  assert.throws(() => store.release({ target: "w" }), /leaseId or holder/);

  const tiny = store.acquire({ target: "w", leaseId: "tiny", ttlMs: 1 });
  assert.equal(tiny.lease.expiresAt - tiny.lease.createdAt, 5_000);

  const huge = store.acquire({ target: "w", leaseId: "huge", ttlMs: 99_999_999 });
  assert.equal(huge.lease.expiresAt - huge.lease.createdAt, 600_000);
});
