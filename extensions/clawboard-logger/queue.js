import { DatabaseSync } from "node:sqlite";
export class SqliteQueue {
    db;
    insertStmt;
    selectClaimCandidatesStmt;
    selectClaimedRowStmt;
    claimStmt;
    releaseExpiredLeasesStmt;
    deleteSentStmt;
    failStmt;
    scopeInsertStmt;
    scopeSelectByAgentStmt;
    nowMs;
    constructor(filePath, nowMs = Date.now) {
        this.nowMs = nowMs;
        this.db = new DatabaseSync(filePath);
        // Reasonable durability without being too slow.
        this.db.exec("PRAGMA journal_mode=WAL;");
        this.db.exec("PRAGMA synchronous=NORMAL;");
        this.db.exec(`
      CREATE TABLE IF NOT EXISTS clawboard_queue (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at_ms INTEGER NOT NULL,
        next_attempt_at_ms INTEGER NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        idempotency_key TEXT NOT NULL UNIQUE,
        payload_json TEXT NOT NULL,
        last_error TEXT
      );
    `);
        this.ensureQueueLeaseColumns();
        this.db.exec("CREATE INDEX IF NOT EXISTS idx_clawboard_queue_next_attempt ON clawboard_queue(next_attempt_at_ms);");
        this.db.exec("CREATE INDEX IF NOT EXISTS idx_clawboard_queue_lease_expires ON clawboard_queue(lease_expires_at_ms);");
        this.insertStmt = this.db.prepare(`
      INSERT OR IGNORE INTO clawboard_queue
        (created_at_ms, next_attempt_at_ms, attempts, idempotency_key, payload_json, last_error)
      VALUES
        (?1, ?2, ?3, ?4, ?5, ?6);
    `);
        this.selectClaimCandidatesStmt = this.db.prepare(`
      SELECT id
      FROM clawboard_queue
      WHERE next_attempt_at_ms <= ?1
        AND (lease_owner IS NULL OR lease_expires_at_ms IS NULL OR lease_expires_at_ms <= ?1)
      ORDER BY id ASC
      LIMIT ?2;
    `);
        this.selectClaimedRowStmt = this.db.prepare(`
      SELECT id,
             idempotency_key AS idempotencyKey,
             payload_json AS payloadJson,
             attempts,
             lease_owner AS leaseOwner,
             lease_expires_at_ms AS leaseExpiresAtMs
      FROM clawboard_queue
      WHERE id = ?1 AND lease_owner = ?2;
    `);
        this.claimStmt = this.db.prepare(`
      UPDATE clawboard_queue
      SET lease_owner = ?2,
          lease_expires_at_ms = ?3
      WHERE id = ?1
        AND next_attempt_at_ms <= ?4
        AND (lease_owner IS NULL OR lease_expires_at_ms IS NULL OR lease_expires_at_ms <= ?4);
    `);
        this.releaseExpiredLeasesStmt = this.db.prepare(`
      UPDATE clawboard_queue
      SET lease_owner = NULL,
          lease_expires_at_ms = NULL
      WHERE lease_expires_at_ms IS NOT NULL AND lease_expires_at_ms <= ?1;
    `);
        this.deleteSentStmt = this.db.prepare("DELETE FROM clawboard_queue WHERE id = ?1 AND lease_owner = ?2;");
        this.failStmt = this.db.prepare(`
      UPDATE clawboard_queue
      SET attempts = ?2,
          next_attempt_at_ms = ?3,
          last_error = ?4,
          lease_owner = NULL,
          lease_expires_at_ms = NULL
      WHERE id = ?1 AND lease_owner = ?5;
    `);
        this.db.exec(`
      CREATE TABLE IF NOT EXISTS board_scope_cache (
        agent_id TEXT PRIMARY KEY,
        topic_id TEXT NOT NULL,
        task_id TEXT,
        kind TEXT NOT NULL,
        session_key TEXT,
        updated_at_ms INTEGER NOT NULL
      );
    `);
        this.scopeInsertStmt = this.db.prepare(`
      INSERT OR REPLACE INTO board_scope_cache (agent_id, topic_id, task_id, kind, session_key, updated_at_ms)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6);
    `);
        this.scopeSelectByAgentStmt = this.db.prepare(`
      SELECT topic_id as topicId, task_id as taskId, kind, session_key as sessionKey, updated_at_ms as updatedAt
      FROM board_scope_cache
      WHERE agent_id = ?1 AND updated_at_ms >= ?2
      ORDER BY updated_at_ms DESC
      LIMIT 1;
    `);
    }
    ensureQueueLeaseColumns() {
        const rows = this.db.prepare("SELECT name FROM pragma_table_info('clawboard_queue')").all();
        const columns = new Set(rows.map((row) => String(row.name ?? "")));
        if (!columns.has("lease_owner")) {
            this.db.exec("ALTER TABLE clawboard_queue ADD COLUMN lease_owner TEXT;");
        }
        if (!columns.has("lease_expires_at_ms")) {
            this.db.exec("ALTER TABLE clawboard_queue ADD COLUMN lease_expires_at_ms INTEGER;");
        }
    }
    enqueue(idempotencyKey, payload, error) {
        const ts = this.nowMs();
        this.insertStmt.run(ts, ts, 0, idempotencyKey, JSON.stringify(payload), error.slice(0, 1200));
    }
    claimDue(limit, leaseOwner, leaseDurationMs) {
        const now = this.nowMs();
        const leaseExpiresAtMs = now + Math.max(1_000, Math.floor(leaseDurationMs));
        const cappedLimit = Math.max(1, Math.min(200, limit));
        this.db.exec("BEGIN IMMEDIATE;");
        try {
            this.releaseExpiredLeasesStmt.run(now);
            const candidates = this.selectClaimCandidatesStmt.all(now, cappedLimit);
            const claimed = [];
            for (const candidate of candidates) {
                const id = Number(candidate.id ?? 0);
                if (!Number.isFinite(id) || id <= 0)
                    continue;
                const result = this.claimStmt.run(id, leaseOwner, leaseExpiresAtMs, now);
                if (Number(result?.changes ?? 0) < 1)
                    continue;
                const row = this.selectClaimedRowStmt.all(id, leaseOwner)[0];
                if (!row)
                    continue;
                claimed.push({
                    id: row.id,
                    idempotencyKey: row.idempotencyKey,
                    payloadJson: row.payloadJson,
                    attempts: row.attempts,
                });
            }
            this.db.exec("COMMIT;");
            return claimed;
        }
        catch (err) {
            try {
                this.db.exec("ROLLBACK;");
            }
            catch {
                // Ignore rollback failures if the transaction has already been unwound.
            }
            throw err;
        }
    }
    markSent(id, leaseOwner) {
        this.deleteSentStmt.run(id, leaseOwner);
    }
    markFailed(id, attempts, nextAttemptAtMs, error, leaseOwner) {
        this.failStmt.run(id, attempts, nextAttemptAtMs, error.slice(0, 1200), leaseOwner);
    }
    saveBoardScope(agentId, scope) {
        this.scopeInsertStmt.run(agentId, scope.topicId, scope.kind === "task" ? scope.taskId : null, scope.kind, scope.sessionKey ?? null, scope.updatedAt);
    }
    saveBoardScopeForSession(sessionKey, scope, normalizeId) {
        const key = normalizeId(sessionKey);
        if (!key)
            return;
        this.saveBoardScope(`session:${key}`, scope);
    }
    getFreshBoardScopeForAgent(agentId, cutoffMs, normalizeId) {
        const key = normalizeId(agentId);
        if (!key)
            return undefined;
        const rows = this.scopeSelectByAgentStmt.all(key, cutoffMs);
        const row = rows?.[0];
        if (!row)
            return undefined;
        if (row.kind === "task" && row.taskId) {
            return {
                topicId: row.topicId,
                taskId: row.taskId,
                kind: "task",
                sessionKey: row.sessionKey ?? "",
                inherited: true,
                updatedAt: row.updatedAt,
            };
        }
        return {
            topicId: row.topicId,
            kind: "topic",
            sessionKey: row.sessionKey ?? "",
            inherited: true,
            updatedAt: row.updatedAt,
        };
    }
    getFreshBoardScopeForSession(sessionKey, cutoffMs, normalizeId) {
        const key = normalizeId(sessionKey);
        if (!key)
            return undefined;
        return this.getFreshBoardScopeForAgent(`session:${key}`, cutoffMs, normalizeId);
    }
}
export function createDurableQueueRuntime(options) {
    const nowMs = options.nowMs ?? Date.now;
    let queueDb;
    let queueDbPromise;
    let flushing = false;
    let flushTimer;
    async function getQueueDb() {
        if (queueDb)
            return queueDb;
        if (queueDbPromise)
            return queueDbPromise;
        queueDbPromise = (async () => {
            await options.ensureDir(options.queuePath);
            const db = new SqliteQueue(options.queuePath, nowMs);
            queueDb = db;
            return db;
        })().catch((err) => {
            queueDbPromise = undefined;
            throw err;
        });
        return queueDbPromise;
    }
    async function flushQueueOnce(limit = 25) {
        const db = await getQueueDb();
        const rows = db.claimDue(limit, options.leaseOwner, options.leaseDurationMs);
        if (rows.length === 0)
            return;
        for (const row of rows) {
            let payload;
            try {
                payload = JSON.parse(row.payloadJson);
            }
            catch (err) {
                db.markFailed(row.id, row.attempts + 1, nowMs() + 60_000, `json parse failed: ${String(err)}`, options.leaseOwner);
                continue;
            }
            payload.idempotencyKey = row.idempotencyKey;
            const ok = await options.postLog(payload);
            if (ok) {
                db.markSent(row.id, options.leaseOwner);
                continue;
            }
            const attempts = row.attempts + 1;
            const backoff = options.computeBackoffMs(attempts, 300_000);
            db.markFailed(row.id, attempts, nowMs() + backoff, "send failed", options.leaseOwner);
        }
    }
    async function flushQueue() {
        if (flushing)
            return;
        // In-process throttle only. Cross-process correctness comes from row leases.
        flushing = true;
        try {
            await flushQueueOnce(50);
        }
        finally {
            flushing = false;
        }
    }
    function ensureFlushLoop() {
        if (flushTimer)
            return;
        flushTimer = setInterval(() => {
            flushQueue().catch(() => undefined);
        }, 2000);
        flushTimer?.unref?.();
    }
    async function enqueueDurable(payload, error) {
        const db = await getQueueDb();
        const idempotencyKey = options.ensureIdempotencyKey(payload);
        db.enqueue(idempotencyKey, payload, error);
        ensureFlushLoop();
    }
    return {
        getQueueDb,
        flushQueue,
        flushQueueOnce,
        ensureFlushLoop,
        enqueueDurable,
    };
}
