#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { execFile as execFileCallback } from "node:child_process";
import { createRequire } from "node:module";
import { loadEnvFile } from "node:process";
import { promisify } from "node:util";
import { writeS3VersionInventory } from
  "../deployment/storage-vnext-s3-backup.mjs";
import {
  createStorageVnextScaleRuntimeEnvironment,
  createStorageVnextValidationProfile
} from "./lib/storage-vnext-scale-scope.mjs";
import {
  shouldCompactStorageVnextSearch,
  summarizeStorageVnextS3ContentBytes,
  summarizeStorageVnextScaleTuningEvidence
} from "./lib/storage-vnext-scale-resource-evidence.mjs";
import {
  STORAGE_VNEXT_10000_BUDGETS,
  STORAGE_VNEXT_FULL_BUDGETS
} from "./storage-vnext-scale-budget.mjs";

const require = createRequire(new URL("../../apps/api/package.json", import.meta.url));
const { S3Client } = require("@aws-sdk/client-s3");
const postgres = require("postgres");
const { createClient: createRedisClient } = require("redis");
const execFile = promisify(execFileCallback);
const SETTLE_TIMEOUT_MS = 15 * 60 * 1_000;
const QUARANTINE_CLOCK_ADVANCE_HOURS = 25;

loadLocalEnv();
const tuningMode = process.env.FOCOWIKI_STORAGE_VNEXT_TUNING_MODE?.trim() || "scale";
const profile = createStorageVnextValidationProfile(tuningMode);
const proofPath = path.resolve(requiredEnv("FOCOWIKI_STORAGE_VNEXT_PROOF_FILE"));
const proof = readJson(proofPath)?.proof;
const runtimeEnv = createStorageVnextScaleRuntimeEnvironment({ proof, env: process.env });
Object.assign(process.env, runtimeEnv);
const rebuild = readJson(path.join(proof.filesystemScope, profile.rebuildFileName));
const resources = readJson(path.join(proof.filesystemScope, profile.resourcesFileName));
assertInputs();
const reportPath = path.join(proof.filesystemScope, profile.tuningFileName);
const report = {
  kind: profile.tuningKind,
  version: 1,
  runId: proof.runId,
  knowledgeBaseId: rebuild.knowledgeBaseId,
  startedAt: new Date().toISOString(),
  finishedAt: null,
  quarantine: null,
  searchCompaction: null,
  redisCompaction: null,
  storageBefore: null,
  convergence: null,
  summary: null,
  failure: null
};
const sql = postgres(runtimeEnv.DATABASE_URL, { max: 1, prepare: false });
const redis = createRedisClient({ url: requiredEnv("REDIS_URL") });
const s3 = new S3Client({
  endpoint: requiredEnv("S3_ENDPOINT"),
  region: requiredEnv("S3_REGION"),
  forcePathStyle: requiredBooleanEnv("S3_FORCE_PATH_STYLE"),
  credentials: {
    accessKeyId: requiredEnv("S3_ACCESS_KEY_ID"),
    secretAccessKey: requiredEnv("S3_SECRET_ACCESS_KEY")
  }
});

try {
  const before = await readDatabaseState();
  const beforeS3 = await readS3Inventory();
  report.storageBefore = {
    s3: beforeS3,
    s3ContentBytes: summarizeStorageVnextS3ContentBytes(
      beforeS3,
      resources.providers.s3.ownerMarkerBytes
    )
  };
  writeReport();
  if (before.knowledgeBaseCount !== 1 || before.knowledgeBaseId !== rebuild.knowledgeBaseId) {
    throw new Error("Scale tuning database contains an unowned knowledge base scope");
  }
  if (before.quarantineGracePeriodSeconds !== 86_400) {
    throw new Error("Scale tuning requires the unchanged 24-hour quarantine setting");
  }
  const advancedAt = new Date().toISOString();
  const advanced = await sql`
    UPDATE focowiki.object_registrations registration
    SET zero_owner_since = least(
      registration.zero_owner_since,
      now() - (${QUARANTINE_CLOCK_ADVANCE_HOURS}::text || ' hours')::interval
    )
    WHERE registration.state = 'verified'
      AND registration.zero_owner_since IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM focowiki.object_owners owner
        WHERE owner.object_id = registration.object_id
      )
    RETURNING registration.object_id
  `;
  if (advanced.length !== before.unownedObjects) {
    throw new Error("Scale tuning quarantine clock advance changed scope");
  }
  report.quarantine = {
    unchangedGracePeriodSeconds: before.quarantineGracePeriodSeconds,
    simulatedClockAdvanceHours: QUARANTINE_CLOCK_ADVANCE_HOURS,
    advancedAt,
    eligibleObjects: advanced.length
  };
  writeReport();

  report.searchCompaction = await compactSearchHighWater();
  writeReport();
  report.redisCompaction = await compactRedisHighWater();
  writeReport();
  const convergenceStartedAtMs = Date.now();
  let after;
  do {
    after = await readDatabaseState();
    if (
      after.unownedObjects === 0
      && after.liveWorkItems === 0
      && after.liveCleanupActions === 0
    ) break;
    if (Date.now() - convergenceStartedAtMs >= SETTLE_TIMEOUT_MS) {
      throw new Error("Scale tuning zero-owner cleanup did not converge by deadline");
    }
    await sleep(2_000);
  } while (true);
  const afterS3 = await readS3Inventory();
  const providerTasksInFlight = await readScopedProviderTasksInFlight();
  const afterSearch = await fetchMeili("/stats");
  const afterPhysicalSearchBytes = await readMeilisearchPhysicalBytes();
  report.convergence = {
    durationMs: Date.now() - convergenceStartedAtMs,
    database: after,
    s3: afterS3,
    providerTasksInFlight,
    searchDatabaseBytes: integer(afterSearch.databaseSize),
    searchUsedBytes: integer(afterSearch.usedDatabaseSize),
    searchPhysicalBytes: afterPhysicalSearchBytes,
    redisPersistedBytes: report.redisCompaction.after.persistedBytes
  };
  report.summary = summarizeStorageVnextScaleTuningEvidence({
    beforeUnownedObjects: before.unownedObjects,
    afterUnownedObjects: after.unownedObjects,
    beforeS3Bytes: report.storageBefore.s3ContentBytes,
    afterS3Bytes: summarizeStorageVnextS3ContentBytes(
      afterS3,
      resources.providers.s3.ownerMarkerBytes
    ),
    beforeSearchDatabaseBytes: report.searchCompaction.before.databaseSizeBytes,
    afterSearchDatabaseBytes: integer(afterSearch.databaseSize),
    afterSearchUsedBytes: integer(afterSearch.usedDatabaseSize),
    beforeRedisPersistedBytes: report.redisCompaction.before.persistedBytes,
    afterRedisPersistedBytes: report.redisCompaction.after.persistedBytes,
    activeUnifiedIndexes: after.activeUnifiedIndexes,
    candidateUnifiedIndexes: after.candidateUnifiedIndexes,
    providerTasksInFlight,
    liveWorkItems: after.liveWorkItems,
    liveCleanupActions: after.liveCleanupActions
  });
  report.finishedAt = new Date().toISOString();
  writeReport();
  process.stdout.write(`${JSON.stringify({
    status: "complete",
    runId: proof.runId,
    quarantine: report.quarantine,
    searchCompaction: report.searchCompaction,
    redisCompaction: report.redisCompaction,
    convergence: report.convergence,
    summary: report.summary,
    reportPath
  }, null, 2)}\n`);
} catch (error) {
  report.failure = {
    name: error instanceof Error ? error.name : "Error",
    message: String(error instanceof Error ? error.message : error).slice(0, 2_000)
  };
  report.finishedAt = new Date().toISOString();
  writeReport();
  throw error;
} finally {
  await sql.end({ timeout: 5 }).catch(() => undefined);
  if (redis.isOpen) await redis.quit().catch(() => undefined);
  s3.destroy();
}

async function compactRedisHighWater() {
  if (!redis.isOpen) await redis.connect();
  const before = {
    persistedBytes: await readRedisPhysicalBytes(),
    persistence: parseRedisPersistence(await redis.info("persistence"))
  };
  if (!before.persistence.aofEnabled) {
    throw new Error("Scale tuning requires Redis AOF persistence");
  }
  const budgets = tuningMode === "full"
    ? STORAGE_VNEXT_FULL_BUDGETS
    : STORAGE_VNEXT_10000_BUDGETS;
  if (before.persistedBytes <= budgets.storageBytes.redisPersistedMaximum) {
    return { outcome: "not-needed", before, after: before };
  }
  const rewriteCount = before.persistence.aofRewrites;
  if (!before.persistence.aofRewriteInProgress) {
    await redis.sendCommand(["BGREWRITEAOF"]);
  }
  const persistence = await waitForRedisAofRewrite(rewriteCount);
  const after = {
    persistedBytes: await readRedisPhysicalBytes(),
    persistence
  };
  if (after.persistedBytes > before.persistedBytes) {
    throw new Error("Scale tuning Redis AOF rewrite increased persisted bytes");
  }
  return { outcome: "compacted", before, after };
}

async function waitForRedisAofRewrite(previousRewriteCount) {
  const deadline = Date.now() + SETTLE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const persistence = parseRedisPersistence(await redis.info("persistence"));
    if (
      !persistence.aofRewriteInProgress
      && !persistence.aofRewriteScheduled
      && persistence.aofLastRewriteStatus === "ok"
      && persistence.aofRewrites > previousRewriteCount
    ) return persistence;
    await sleep(250);
  }
  throw new Error("Scale tuning Redis AOF rewrite timed out");
}

async function readRedisPhysicalBytes() {
  const project = requiredEnv("FOCOWIKI_STORAGE_VNEXT_COMPOSE_PROJECT");
  const { stdout } = await execFile("docker", [
    "compose", "-p", project, "-f", "docker-compose.local.yml",
    "exec", "-T", "redis", "du", "-sb", "/data"
  ], { cwd: process.cwd(), env: process.env });
  return integer(stdout.trim().split(/\s+/u)[0]);
}

function parseRedisPersistence(text) {
  const values = {};
  for (const line of text.split(/\r?\n/u)) {
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf(":");
    if (separator > 0) values[line.slice(0, separator)] = line.slice(separator + 1);
  }
  return {
    aofEnabled: values.aof_enabled === "1",
    aofRewriteInProgress: values.aof_rewrite_in_progress === "1",
    aofRewriteScheduled: values.aof_rewrite_scheduled === "1",
    aofLastRewriteStatus: values.aof_last_bgrewrite_status ?? null,
    aofRewrites: integer(values.aof_rewrites)
  };
}

async function compactSearchHighWater() {
  const beforeStats = await fetchMeili("/stats");
  const before = {
    databaseSizeBytes: integer(beforeStats.databaseSize),
    usedDatabaseSizeBytes: integer(beforeStats.usedDatabaseSize),
    physicalBytes: await readMeilisearchPhysicalBytes()
  };
  const reclaimableBytes = before.databaseSizeBytes - before.usedDatabaseSizeBytes;
  if (!shouldCompactStorageVnextSearch(before)) {
    return {
      outcome: "not-needed",
      reclaimableBytes,
      fragmentationRatio: before.databaseSizeBytes === 0
        ? 0
        : reclaimableBytes / before.databaseSizeBytes,
      before,
      after: before,
      taskUid: null
    };
  }
  const [projection] = await sql`
    SELECT provider_index_uid
    FROM focowiki.search_projections
    WHERE knowledge_base_id = ${rebuild.knowledgeBaseId}
      AND projection_role = 'active'
      AND state = 'ready'
  `;
  if (!projection?.provider_index_uid?.startsWith(proof.searchScope)) {
    throw new Error("Scale tuning active index is outside the run-owned scope");
  }
  const availableDiskBytes = await readMeilisearchAvailableDiskBytes();
  if (availableDiskBytes < before.databaseSizeBytes) {
    throw new Error("Scale tuning has insufficient disk for Meilisearch compaction");
  }
  const accepted = await fetchMeili(
    `/indexes/${encodeURIComponent(projection.provider_index_uid)}/compact`,
    { method: "POST" }
  );
  const taskUid = integer(accepted.taskUid);
  const task = await waitForMeiliTask(taskUid);
  if (task.status !== "succeeded") {
    throw new Error(`Scale tuning Meilisearch compaction ended in ${task.status}`);
  }
  const afterStats = await fetchMeili("/stats");
  return {
    outcome: "compacted",
    taskUid,
    availableDiskBytes,
    before,
    after: {
      databaseSizeBytes: integer(afterStats.databaseSize),
      usedDatabaseSizeBytes: integer(afterStats.usedDatabaseSize),
      physicalBytes: await readMeilisearchPhysicalBytes()
    }
  };
}

async function waitForMeiliTask(taskUid) {
  const deadline = Date.now() + SETTLE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const task = await fetchMeili(`/tasks/${taskUid}`);
    if (["succeeded", "failed", "canceled"].includes(task.status)) return task;
    await sleep(1_000);
  }
  throw new Error("Scale tuning Meilisearch task timed out");
}

async function readScopedProviderTasksInFlight() {
  const page = await fetchMeili("/tasks?statuses=enqueued,processing&limit=1000");
  if (page.next !== null && page.next !== undefined) {
    throw new Error("Scale tuning provider in-flight task evidence is incomplete");
  }
  return (page.results ?? []).filter((task) =>
    task.indexUid?.startsWith(proof.searchScope)
  ).length;
}

async function readDatabaseState() {
  const rows = await sql`
    SELECT
      (SELECT count(*) FROM focowiki.knowledge_bases
        WHERE deleted_at IS NULL)::text AS knowledge_base_count,
      (SELECT min(public_id) FROM focowiki.knowledge_bases
        WHERE deleted_at IS NULL) AS knowledge_base_id,
      (SELECT count(*) FROM focowiki.object_registrations registration
        WHERE registration.state = 'verified'
          AND NOT EXISTS (
            SELECT 1 FROM focowiki.object_owners owner
            WHERE owner.object_id = registration.object_id
          ))::text AS unowned_objects,
      (SELECT count(*) FROM focowiki.operation_work_items)::text AS live_work_items,
      (SELECT count(*) FROM focowiki.cleanup_actions)::text AS live_cleanup_actions,
      (SELECT count(*) FROM focowiki.search_projections
        WHERE projection_role = 'active')::text AS active_unified_indexes,
      (SELECT count(*) FROM focowiki.search_projections
        WHERE projection_role = 'candidate')::text AS candidate_unified_indexes,
      (SELECT (revision.settings_values->'sections'->'maintenance'
        ->>'quarantineGracePeriodSeconds')::text
        FROM focowiki.runtime_setting_current current
        JOIN focowiki.runtime_setting_revisions revision
          ON revision.public_id = current.revision_public_id
        WHERE current.singleton) AS quarantine_grace_period_seconds
  `;
  const row = rows[0];
  return {
    knowledgeBaseCount: integer(row.knowledge_base_count),
    knowledgeBaseId: row.knowledge_base_id,
    unownedObjects: integer(row.unowned_objects),
    liveWorkItems: integer(row.live_work_items),
    liveCleanupActions: integer(row.live_cleanup_actions),
    activeUnifiedIndexes: integer(row.active_unified_indexes),
    candidateUnifiedIndexes: integer(row.candidate_unified_indexes),
    quarantineGracePeriodSeconds: integer(row.quarantine_grace_period_seconds)
  };
}

async function readS3Inventory() {
  return writeS3VersionInventory({
    client: s3,
    bucket: requiredEnv("S3_BUCKET"),
    prefix: proof.objectScope,
    async write() {}
  });
}

async function readMeilisearchPhysicalBytes() {
  const project = requiredEnv("FOCOWIKI_STORAGE_VNEXT_COMPOSE_PROJECT");
  const { stdout } = await execFile("docker", [
    "compose", "-p", project, "-f", "docker-compose.local.yml",
    "exec", "-T", "meilisearch", "du", "-sb", "/meili_data"
  ], { cwd: process.cwd(), env: process.env });
  return integer(stdout.trim().split(/\s+/u)[0]);
}

async function readMeilisearchAvailableDiskBytes() {
  const project = requiredEnv("FOCOWIKI_STORAGE_VNEXT_COMPOSE_PROJECT");
  const { stdout } = await execFile("docker", [
    "compose", "-p", project, "-f", "docker-compose.local.yml",
    "exec", "-T", "meilisearch", "df", "-Pk", "/meili_data"
  ], { cwd: process.cwd(), env: process.env });
  const fields = stdout.trim().split("\n").at(-1).trim().split(/\s+/u);
  return integer(fields[3]) * 1_024;
}

async function fetchMeili(pathname, options = {}) {
  const response = await fetch(`${requiredEnv("MEILI_HOST")}${pathname}`, {
    ...options,
    headers: {
      authorization: `Bearer ${requiredEnv("MEILI_API_KEY")}`,
      ...(options.headers ?? {})
    },
    signal: AbortSignal.timeout(30_000)
  });
  if (!response.ok) throw new Error(`Meilisearch returned HTTP ${response.status}`);
  return response.json();
}

function assertInputs() {
  if (
    rebuild?.kind !== profile.rebuildKind
    || rebuild.runId !== proof?.runId
    || rebuild.failure !== null
    || rebuild.finishedAt === null
    || rebuild.corpus?.fileCount !== profile.expectedFileCount
    || resources?.kind !== profile.resourcesKind
    || resources.runId !== proof.runId
    || resources.knowledgeBaseId !== rebuild.knowledgeBaseId
    || resources.finishedAt === null
    || path.dirname(proofPath) !== proof.filesystemScope
  ) throw new Error("Storage vNext tuning input evidence is invalid");
}

function writeReport() {
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
}

function integer(value) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`Expected safe nonnegative integer, received ${value}`);
  }
  return parsed;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function loadLocalEnv() {
  const envPath = process.env.ENV_FILE || ".env";
  if (fs.existsSync(envPath)) loadEnvFile(envPath);
}

function requiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function requiredBooleanEnv(name) {
  const value = requiredEnv(name);
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`${name} must be true or false`);
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
