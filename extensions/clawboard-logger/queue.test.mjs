import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";

import { SqliteQueue } from "./queue.js";

async function cleanupSqliteArtifacts(filePath) {
  for (const candidate of [filePath, `${filePath}-shm`, `${filePath}-wal`]) {
    await fs.rm(candidate, { force: true }).catch(() => {});
  }
}

test("SqliteQueue lazily migrates legacy queue schema with lease columns", async () => {
  const filePath = path.join(os.tmpdir(), `clawboard-logger-legacy-queue-${process.pid}-${Date.now()}.sqlite`);
  await cleanupSqliteArtifacts(filePath);

  const legacyDb = new DatabaseSync(filePath);
  legacyDb.exec(`
    CREATE TABLE clawboard_queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at_ms INTEGER NOT NULL,
      next_attempt_at_ms INTEGER NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      idempotency_key TEXT NOT NULL UNIQUE,
      payload_json TEXT NOT NULL,
      last_error TEXT
    );
  `);
  legacyDb.close();

  const queue = new SqliteQueue(filePath, () => 1_000);
  queue.db.close();

  const inspectDb = new DatabaseSync(filePath);
  const columns = inspectDb
    .prepare("SELECT name FROM pragma_table_info('clawboard_queue')")
    .all()
    .map((row) => String(row.name || ""));
  inspectDb.close();

  assert.ok(columns.includes("lease_owner"));
  assert.ok(columns.includes("lease_expires_at_ms"));

  await cleanupSqliteArtifacts(filePath);
});

test("SqliteQueue claimDue leases rows across connections and recovers expired leases", async () => {
  const filePath = path.join(os.tmpdir(), `clawboard-logger-lease-queue-${process.pid}-${Date.now()}.sqlite`);
  await cleanupSqliteArtifacts(filePath);

  let now = 10_000;
  const nowMs = () => now;
  const ownerA = "owner-a";
  const ownerB = "owner-b";

  const queueA = new SqliteQueue(filePath, nowMs);
  const queueB = new SqliteQueue(filePath, nowMs);

  queueA.enqueue("idem-1", { hello: "world" }, "initial failure");

  const claimedByA = queueA.claimDue(10, ownerA, 1_000);
  assert.equal(claimedByA.length, 1);
  assert.equal(claimedByA[0].idempotencyKey, "idem-1");

  const claimedByBWhileLeased = queueB.claimDue(10, ownerB, 1_000);
  assert.equal(claimedByBWhileLeased.length, 0);

  now += 1_500;
  const claimedByBAfterExpiry = queueB.claimDue(10, ownerB, 1_000);
  assert.equal(claimedByBAfterExpiry.length, 1);
  assert.equal(claimedByBAfterExpiry[0].idempotencyKey, "idem-1");

  queueB.markSent(claimedByBAfterExpiry[0].id, ownerB);
  const claimedAfterDelete = queueA.claimDue(10, ownerA, 1_000);
  assert.equal(claimedAfterDelete.length, 0);

  queueA.db.close();
  queueB.db.close();
  await cleanupSqliteArtifacts(filePath);
});
