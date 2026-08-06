import { randomUUID } from "node:crypto";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { gzipSync } from "node:zlib";
import postgres from "postgres";
import { createClient } from "redis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DatabaseClient } from "../src/db/client.js";
import { createRuntimeLogger, type RuntimeLogSink } from "../src/logger.js";
import { createRedisCoordinator } from "../src/redis/coordination.js";
import {
  ensureStorageVnextTimePartitions
} from "../src/storage-vnext/retention/postgres-partitions.js";
import {
  runStorageVnextRetentionSlice,
  STORAGE_VNEXT_RESULT_MAX_BYTES,
  STORAGE_VNEXT_SECURITY_AUDIT_MAX_BYTES
} from "../src/storage-vnext/retention/postgres-retention.js";

const databaseUrl = process.env.FOCOWIKI_STORAGE_VNEXT_TEST_DATABASE_URL;
const redisUrl = process.env.FOCOWIKI_STORAGE_VNEXT_TEST_REDIS_URL;
const runOwner = process.env.FOCOWIKI_STORAGE_VNEXT_TEST_RUN_OWNER;
const hasOwnedTargets = Boolean(
  databaseUrl
  && redisUrl
  && runOwner
  && /^svnext-[a-z0-9]{8,16}$/u.test(runOwner)
);
const describeOwnedTargets = hasOwnedTargets ? describe : describe.skip;

const REDIS_MAX_BYTES = 10 * 1024 * 1024;
const RESULT_MAX_BYTES = STORAGE_VNEXT_RESULT_MAX_BYTES;
const SECURITY_AUDIT_MAX_BYTES = STORAGE_VNEXT_SECURITY_AUDIT_MAX_BYTES;
const LOG_MAX_TOTAL_BYTES = 1_024;
const LOG_MAX_FILES = 3;
const IDLE_CPU_MAX_PERCENT = 5;

describeOwnedTargets("storage vNext measured runtime budgets", () => {
  const connectionUrl = databaseUrl
    ?? "postgres://unused:unused@127.0.0.1:5432/unused";
  const ownerToken = (runOwner ?? "invalid").replaceAll("-", "_");
  const databaseName = "focowiki_vnext_budget_" + ownerToken + "_"
    + randomUUID().replaceAll("-", "").slice(0, 10);
  const keyPrefix = "focowiki:test:" + ownerToken + ":"
    + randomUUID().replaceAll("-", "");
  const admin = postgres(databaseConnectionUrl(connectionUrl, "postgres"), { max: 1 });
  const sql = postgres(databaseConnectionUrl(connectionUrl, databaseName), { max: 3 });
  const database = sql as unknown as DatabaseClient;
  const client = createBudgetRedisClient(redisUrl ?? "redis://127.0.0.1:6379/0");
  let databaseCreated = false;

  beforeAll(async () => {
    await admin.unsafe("CREATE DATABASE " + quoteIdentifier(databaseName));
    databaseCreated = true;
    await sql.unsafe(readFileSync(
      resolve(import.meta.dirname, "../migrations/001_storage_vnext.sql"),
      "utf8"
    ));
    await client.connect();
  }, 120_000);

  afterAll(async () => {
    if (client.isOpen) {
      for await (const entry of client.scanIterator({
        MATCH: keyPrefix + ":*",
        COUNT: 100
      })) {
        const keys = Array.isArray(entry) ? entry : [entry];
        for (const key of keys) await client.del(key);
      }
      await client.quit();
    }
    await sql.end({ timeout: 5 });
    if (databaseCreated) {
      await admin.unsafe(
        "DROP DATABASE IF EXISTS " + quoteIdentifier(databaseName) + " WITH (FORCE)"
      );
    }
    await admin.end({ timeout: 5 });
  }, 120_000);

  it("measures Redis, PostgreSQL, log-disk, idle-resource, and age convergence", async () => {
    const now = new Date();
    const old = new Date(now.getTime() - 40 * 86_400_000);
    await ensureStorageVnextTimePartitions(database, old);
    await seedPostgres(sql, now, old);
    const postgresBefore = await readPostgresBytes(sql);

    expect(postgresBefore.resultLogicalBytes).toBeLessThanOrEqual(RESULT_MAX_BYTES);
    expect(postgresBefore.resultRelationBytes).toBeLessThanOrEqual(RESULT_MAX_BYTES);
    expect(postgresBefore.auditLogicalBytes).toBeLessThanOrEqual(
      SECURITY_AUDIT_MAX_BYTES
    );
    expect(postgresBefore.auditRelationBytes).toBeLessThanOrEqual(
      SECURITY_AUDIT_MAX_BYTES
    );

    const redis = createRedisCoordinator(client, { keyPrefix });
    await redis.setRuntimeSettingsVersion("version-one");
    await redis.setSession("session-one", { actorId: "admin-one" }, 1);
    await redis.setPaginationCursor("files", "cursor-one", { offset: 10 }, 1);
    await redis.setPageCache("files", "page-one", { count: 10 }, 1);
    await redis.markPaginationInvalid("files", "catalog_changed", 1);
    await redis.setPublicOpenApiKeyCache("hash-one", { id: "key-one" }, 1);
    await redis.markPublicOpenApiKeyUsed("key-one", 1);
    await redis.acquireLock("workflow", "operation-one", "owner-one", 1);
    await redis.hitRateLimit("public", "client-one", { max: 2, windowSeconds: 1 });

    const redisBefore = await readRedisMetrics(client, keyPrefix);
    expect(redisBefore.usedMemoryBytes).toBeLessThanOrEqual(REDIS_MAX_BYTES);
    expect(redisBefore.keyBytes).toBeLessThanOrEqual(REDIS_MAX_BYTES);
    expect(redisBefore.ttlMinimumSeconds).toBeGreaterThan(0);

    const retention = await runStorageVnextRetentionSlice(database, {
      now,
      batchSize: 100,
      securityAuditRetentionDays: 30
    });
    const postgresAfter = await readPostgresCounts(sql);
    expect(retention.operationResults.deletedRows).toBe(10);
    expect(postgresAfter).toEqual({ results: 10, audits: 10 });

    const logDirectory = mkdtempSync(join(tmpdir(), "focowiki-vnext-budget-log-"));
    try {
      const resourcesBeforeLogging = process.getActiveResourcesInfo().length;
      const logger = createRuntimeLogger({
        logging: {
          level: "info",
          file: {
            directory: logDirectory,
            maxBytes: 512,
            maxFiles: LOG_MAX_FILES,
            maxTotalBytes: LOG_MAX_TOTAL_BYTES,
            retentionDays: 1
          }
        }
      }, silentSink(), { streamName: "budget" });
      for (let index = 0; index < 80; index += 1) {
        logger.info("budget.rotation_sample", {
          sequence: index,
          message: randomUUID() + "-" + "x".repeat(80)
        });
      }
      const oldLog = join(logDirectory, "focowiki-budget.2.log.gz");
      writeFileSync(oldLog, gzipSync("{\"event\":\"expired\"}\n"));
      const expiredTime = new Date(now.getTime() - 2 * 86_400_000);
      utimesSync(oldLog, expiredTime, expiredTime);
      logger.info("budget.retention_sample", { sequence: 81 });

      const logMetrics = readLogMetrics(logDirectory);
      expect(logMetrics.files).toBeLessThanOrEqual(LOG_MAX_FILES);
      expect(logMetrics.totalBytes).toBeLessThanOrEqual(LOG_MAX_TOTAL_BYTES);
      expect(logMetrics.compressedFiles).toBeGreaterThan(0);
      expect(logMetrics.oldestAgeDays).toBeLessThan(1);
      const resourcesAfterLogging = process.getActiveResourcesInfo().length;
      expect(resourcesAfterLogging).toBeLessThanOrEqual(resourcesBeforeLogging + 1);

      const idleResourcesBefore = process.getActiveResourcesInfo().length;
      const idleCpuStart = process.cpuUsage();
      const idleStartedAt = performance.now();
      await delay(1_200);
      const idleElapsedMs = performance.now() - idleStartedAt;
      const idleCpu = process.cpuUsage(idleCpuStart);
      const idleCpuMicros = idleCpu.user + idleCpu.system;
      const idleCpuPercent = idleCpuMicros / (idleElapsedMs * 1_000) * 100;
      const idleResourcesAfter = process.getActiveResourcesInfo().length;
      expect(idleCpuPercent).toBeLessThan(IDLE_CPU_MAX_PERCENT);
      expect(idleResourcesAfter).toBeLessThanOrEqual(idleResourcesBefore + 1);

      const redisAfter = await readRedisMetrics(client, keyPrefix);
      expect(redisAfter.keys).toBe(1);
      expect(redisAfter.ttlMinimumSeconds).toBeGreaterThan(0);

      console.info("STORAGE_VNEXT_RUNTIME_BUDGET_EVIDENCE " + JSON.stringify({
        redis: {
          keysBefore: redisBefore.keys,
          keyBytes: redisBefore.keyBytes,
          usedMemoryBytes: redisBefore.usedMemoryBytes,
          ttlMinimumSeconds: redisBefore.ttlMinimumSeconds,
          ttlMaximumSeconds: redisBefore.ttlMaximumSeconds,
          keysAfterAgeWindow: redisAfter.keys
        },
        postgres: {
          resultRowsBefore: postgresBefore.resultRows,
          resultLogicalBytes: postgresBefore.resultLogicalBytes,
          resultRelationBytes: postgresBefore.resultRelationBytes,
          auditRowsBefore: postgresBefore.auditRows,
          auditLogicalBytes: postgresBefore.auditLogicalBytes,
          auditRelationBytes: postgresBefore.auditRelationBytes,
          resultRowsAfter: postgresAfter.results,
          auditRowsAfter: postgresAfter.audits
        },
        logs: logMetrics,
        idle: {
          observationMs: Math.round(idleElapsedMs),
          cpuMicros: idleCpuMicros,
          cpuPercent: Math.round(idleCpuPercent * 1_000) / 1_000,
          resourcesBefore: idleResourcesBefore,
          resourcesAfter: idleResourcesAfter
        }
      }));
    } finally {
      rmSync(logDirectory, { recursive: true, force: true });
    }
  }, 120_000);
});

async function seedPostgres(
  sql: ReturnType<typeof postgres>,
  now: Date,
  old: Date
): Promise<void> {
  const currentCompleted = new Date(now.getTime() - 3_600_000).toISOString();
  const currentExpiry = new Date(now.getTime() + 86_400_000).toISOString();
  const oldCompleted = old.toISOString();
  const oldExpiry = new Date(old.getTime() + 86_400_000).toISOString();
  await sql.unsafe(
    "INSERT INTO focowiki.knowledge_bases (public_id, name, revision) "
    + "VALUES ('kb-budget', 'Budget knowledge base', 1)"
  );
  await sql.unsafe(
    "INSERT INTO focowiki.operations "
    + "(public_id, knowledge_base_id, operation_kind, state, completed_at) "
    + "SELECT 'operation-current-' || value, 'kb-budget', 'source', 'completed', '"
    + currentCompleted + "'::timestamptz FROM generate_series(1, 10) AS value"
  );
  await sql.unsafe(
    "INSERT INTO focowiki.operations "
    + "(public_id, knowledge_base_id, operation_kind, state, completed_at) "
    + "SELECT 'operation-old-' || value, 'kb-budget', 'source', 'completed', '"
    + oldCompleted + "'::timestamptz FROM generate_series(1, 10) AS value"
  );
  await sql.unsafe(
    "INSERT INTO focowiki.operation_results "
    + "(public_id, knowledge_base_id, operation_kind, terminal_state, result_code, "
    + "result_summary, completed_at, expires_at) "
    + "SELECT 'operation-current-' || value, 'kb-budget', 'source', 'completed', "
    + "'OK', jsonb_build_object('files', value), '" + currentCompleted
    + "'::timestamptz, '" + currentExpiry
    + "'::timestamptz FROM generate_series(1, 10) AS value"
  );
  await sql.unsafe(
    "INSERT INTO focowiki.operation_results "
    + "(public_id, knowledge_base_id, operation_kind, terminal_state, result_code, "
    + "result_summary, completed_at, expires_at) "
    + "SELECT 'operation-old-' || value, 'kb-budget', 'source', 'completed', "
    + "'OK', jsonb_build_object('files', value), '" + oldCompleted
    + "'::timestamptz, '" + oldExpiry
    + "'::timestamptz FROM generate_series(1, 10) AS value"
  );
  await sql.unsafe(
    "INSERT INTO focowiki.security_audit_events "
    + "(public_id, knowledge_base_id, event_type, result, metadata, created_at, expires_at) "
    + "SELECT 'audit-current-' || value, 'kb-budget', 'session.login', 'success', "
    + "jsonb_build_object('attempt', value), '" + currentCompleted
    + "'::timestamptz, '" + currentExpiry
    + "'::timestamptz FROM generate_series(1, 10) AS value"
  );
  await sql.unsafe(
    "INSERT INTO focowiki.security_audit_events "
    + "(public_id, knowledge_base_id, event_type, result, metadata, created_at, expires_at) "
    + "SELECT 'audit-old-' || value, 'kb-budget', 'session.login', 'success', "
    + "jsonb_build_object('attempt', value), '" + oldCompleted
    + "'::timestamptz, '" + oldExpiry
    + "'::timestamptz FROM generate_series(1, 10) AS value"
  );
}

async function readPostgresBytes(sql: ReturnType<typeof postgres>): Promise<{
  resultRows: number;
  resultLogicalBytes: number;
  resultRelationBytes: number;
  auditRows: number;
  auditLogicalBytes: number;
  auditRelationBytes: number;
}> {
  const rows = await sql.unsafe<Array<Record<string, number | string>>>(
    "SELECT "
    + "(SELECT count(*) FROM focowiki.operation_results) AS result_rows, "
    + "(SELECT coalesce(sum(pg_column_size(result)), 0) "
    + " FROM focowiki.operation_results AS result) AS result_logical_bytes, "
    + "pg_total_relation_size('focowiki.operation_results') AS result_relation_bytes, "
    + "(SELECT count(*) FROM focowiki.security_audit_events) AS audit_rows, "
    + "(SELECT coalesce(sum(pg_column_size(event)), 0) "
    + " FROM focowiki.security_audit_events AS event) AS audit_logical_bytes, "
    + "(SELECT coalesce(sum(pg_total_relation_size(relid)), 0) "
    + " FROM pg_partition_tree('focowiki.security_audit_events') WHERE isleaf) "
    + "AS audit_relation_bytes"
  );
  const row = rows[0] ?? {};
  return {
    resultRows: safeNumber(row.result_rows),
    resultLogicalBytes: safeNumber(row.result_logical_bytes),
    resultRelationBytes: safeNumber(row.result_relation_bytes),
    auditRows: safeNumber(row.audit_rows),
    auditLogicalBytes: safeNumber(row.audit_logical_bytes),
    auditRelationBytes: safeNumber(row.audit_relation_bytes)
  };
}

async function readPostgresCounts(
  sql: ReturnType<typeof postgres>
): Promise<{ results: number; audits: number }> {
  const rows = await sql.unsafe<Array<{ results: number | string; audits: number | string }>>(
    "SELECT "
    + "(SELECT count(*) FROM focowiki.operation_results) AS results, "
    + "(SELECT count(*) FROM focowiki.security_audit_events) AS audits"
  );
  return {
    results: safeNumber(rows[0]?.results),
    audits: safeNumber(rows[0]?.audits)
  };
}

async function readRedisMetrics(
  client: ReturnType<typeof createBudgetRedisClient>,
  keyPrefix: string
): Promise<{
  keys: number;
  keyBytes: number;
  usedMemoryBytes: number;
  ttlMinimumSeconds: number;
  ttlMaximumSeconds: number;
}> {
  const keys: string[] = [];
  for await (const entry of client.scanIterator({
    MATCH: keyPrefix + ":*",
    COUNT: 100
  })) {
    keys.push(...(Array.isArray(entry) ? entry : [entry]));
  }
  const ttls: number[] = [];
  let keyBytes = 0;
  for (const key of keys) {
    ttls.push(await client.ttl(key));
    keyBytes += safeNumber(await client.sendCommand(["MEMORY", "USAGE", key]));
  }
  const memoryInfo = await client.info("memory");
  const usedMemory = /^used_memory:(\d+)\r?$/mu.exec(memoryInfo)?.[1];
  return {
    keys: keys.length,
    keyBytes,
    usedMemoryBytes: safeNumber(usedMemory),
    ttlMinimumSeconds: ttls.length > 0 ? Math.min(...ttls) : 0,
    ttlMaximumSeconds: ttls.length > 0 ? Math.max(...ttls) : 0
  };
}

function createBudgetRedisClient(url: string) {
  return createClient({ url });
}

function readLogMetrics(directory: string): {
  files: number;
  compressedFiles: number;
  totalBytes: number;
  oldestAgeDays: number;
} {
  const files = readdirSync(directory).filter((name) => name.startsWith("focowiki-budget"));
  const stats = files.map((name) => statSync(join(directory, name)));
  const now = Date.now();
  return {
    files: files.length,
    compressedFiles: files.filter((name) => name.endsWith(".log.gz")).length,
    totalBytes: stats.reduce((total, stat) => total + stat.size, 0),
    oldestAgeDays: stats.length > 0
      ? Math.max(...stats.map((stat) => (now - stat.mtimeMs) / 86_400_000))
      : 0
  };
}

function safeNumber(value: unknown): number {
  const parsed = Number(value ?? 0);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error("Runtime budget evidence value exceeds the safe integer range");
  }
  return parsed;
}

function silentSink(): RuntimeLogSink {
  return {
    error() {},
    warn() {},
    info() {},
    debug() {}
  };
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise<void>((resolveDelay) => {
    const timer = setTimeout(resolveDelay, milliseconds);
    timer.unref();
  });
}

function databaseConnectionUrl(connectionUrl: string, databaseName: string): string {
  const url = new URL(connectionUrl);
  url.pathname = "/" + databaseName;
  return url.toString();
}

function quoteIdentifier(value: string): string {
  return "\"" + value.replaceAll("\"", "\"\"") + "\"";
}
