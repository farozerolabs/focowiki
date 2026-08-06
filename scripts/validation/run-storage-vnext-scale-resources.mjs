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
  parseStorageVnextRuntimeResourceRecords,
  selectStorageVnextHandleEvidence,
  summarizeStorageVnextProviderTasks,
  summarizeStorageVnextIdleDatabaseConnectionSamples,
  summarizeStorageVnextRuntimeResourceRecords,
  summarizeStorageVnextScaleResourceEvidence
} from "./lib/storage-vnext-scale-resource-evidence.mjs";
import {
  selectStorageVnextPeakStackEvidence
} from "./lib/storage-vnext-stack-resource-sampler.mjs";
import {
  STORAGE_VNEXT_10000_BUDGETS,
  STORAGE_VNEXT_FULL_BUDGETS,
  evaluateStorageVnextFullStorageEvidence
} from "./storage-vnext-scale-budget.mjs";

const require = createRequire(new URL("../../apps/api/package.json", import.meta.url));
const { GetObjectAttributesCommand, S3Client } = require("@aws-sdk/client-s3");
const postgres = require("postgres");
const { createClient: createRedisClient } = require("redis");
const execFile = promisify(execFileCallback);
const IDLE_WINDOW_MS = 30_000;
const IDLE_CONNECTION_SAMPLE_WINDOW_MS = 6_000;
const IDLE_CONNECTION_SAMPLE_INTERVAL_MS = 250;

loadLocalEnv();
const resourceMode = process.env.FOCOWIKI_STORAGE_VNEXT_RESOURCE_MODE?.trim() || "scale";
const profile = createStorageVnextValidationProfile(resourceMode);
const proofPath = path.resolve(requiredEnv("FOCOWIKI_STORAGE_VNEXT_PROOF_FILE"));
const manifest = readJson(proofPath);
const proof = manifest?.proof;
const runtimeEnv = createStorageVnextScaleRuntimeEnvironment({
  proof,
  env: process.env
});
Object.assign(process.env, runtimeEnv);
const rebuild = readJson(path.join(proof.filesystemScope, profile.rebuildFileName));
assertInputs(rebuild);
const reportPath = path.join(proof.filesystemScope, profile.resourcesFileName);
const report = {
  kind: profile.resourcesKind,
  version: 1,
  runId: proof.runId,
  knowledgeBaseId: rebuild.knowledgeBaseId,
  startedAt: new Date().toISOString(),
  finishedAt: null,
  storage: null,
  objects: null,
  amplification: null,
  queues: null,
  resources: null,
  providers: null,
  storageReferences: null,
  assessment: null,
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
  const beforeProcess = await readApplicationProcesses();
  const [database, s3Evidence, meilisearch, redisEvidence, containers] =
    await Promise.all([
      readPostgresEvidence(),
      readS3Evidence(),
      readMeilisearchEvidence(),
      readRedisEvidence(),
      readContainerEvidence()
    ]);
  const runtime = readRuntimeEvidence();
  const flow = readRuntimeFlowEvidence();
  const logs = readStructuredLogEvidence();
  await sleep(IDLE_WINDOW_MS);
  const afterProcess = await readApplicationProcesses();
  const idleDatabaseConnections = await readIdleDatabaseConnectionEvidence();
  const idle = summarizeIdleWindow(beforeProcess, afterProcess, IDLE_WINDOW_MS);
  const comparable = summarizeStorageVnextScaleResourceEvidence({
    sourceFiles: database.sourceFiles,
    sourceBytes: rebuild.corpus.totalSizeBytes,
    postgresRelationsBytes: database.relationsBytes,
    postgresDirectoryBytes: containers.postgres.directoryBytes,
    s3: s3Evidence.inventory,
    ownerMarkerBytes: s3Evidence.ownerMarkerBytes,
    ownerMarkerObjects: s3Evidence.ownerMarkerObjects,
    meilisearchPhysicalBytes: containers.meilisearch.directoryBytes,
    redisPersistedBytes: containers.redis.directoryBytes,
    structuredLogsBytes: logs.byteCount,
    currentSourceObjects: database.currentSourceObjects,
    transitionalSourceObjects: database.transitionalSourceObjects,
    activeGeneratedObjects: database.activeGeneratedObjects,
    candidateOnlyObjects: database.candidateOnlyObjects,
    activeUnifiedIndexes: database.activeUnifiedIndexes,
    candidateUnifiedIndexes: database.candidateUnifiedIndexes,
    unownedObjects: database.unownedObjects,
    registeredCurrentBytes: database.registeredCurrentBytes
  });
  const resources = summarizeResourceEvidence({
    runtime,
    flow,
    idle,
    containers,
    database: {
      ...database,
      databaseConnections: idleDatabaseConnections.minimum,
      databaseConnectionEvidence: idleDatabaseConnections
    },
    resourceSampling: rebuild.resourceSampling,
    rebuildStartedAt: rebuild.startedAt,
    rebuildFinishedAt: rebuild.finishedAt
  });
  const providers = {
    postgres: {
      databaseBytes: database.databaseBytes,
      databaseStats: database.databaseStats,
      wal: database.wal
    },
    s3: s3Evidence,
    meilisearch,
    redis: redisEvidence
  };
  const queues = {
    liveWorkItems: database.liveWorkItems,
    queueDepth: database.liveWorkItems,
    maximumQueueAgeMs: database.maximumQueueAgeMs,
    liveCleanupActions: database.liveCleanupActions,
    maximumCleanupAgeMs: database.maximumCleanupAgeMs,
    zeroOwnerObjects: database.unownedObjects,
    earliestZeroOwnerSince: database.earliestZeroOwnerSince,
    latestZeroOwnerSince: database.latestZeroOwnerSince,
    providerTasksInFlight: meilisearch.tasks.inFlight
  };
  report.storage = comparable.storage;
  report.objects = comparable.objects;
  report.amplification = {
    ...comparable.amplification,
    postgresWalUpperBoundToSource: round(
      database.wal.bytes / rebuild.corpus.totalSizeBytes
    ),
    accounting: {
      postgresWal: "container-global-since-stat-reset upper bound",
      registeredCurrent: "verified registrations with at least one current owner",
      s3: "current and noncurrent version bodies in the exact run-owned prefix",
      meilisearch: "complete provider directory because the run began with no indexes"
    }
  };
  report.queues = queues;
  report.resources = resources;
  report.providers = providers;
  report.assessment = assess({
    comparable,
    resources,
    queues,
    meilisearch
  });
  report.storageReferences = report.assessment.storageReferences;
  report.finishedAt = new Date().toISOString();
  writeReport();
  process.stdout.write(`${JSON.stringify({
    status: report.assessment.ok ? "passed" : "measured-with-budget-failures",
    runId: proof.runId,
    storage: report.storage,
    objects: report.objects,
    resources: report.resources,
    queues: report.queues,
    storageReferences: report.storageReferences,
    failures: report.assessment.failures,
    reportPath
  }, null, 2)}\n`);
  if (!report.assessment.ok) process.exitCode = 1;
} catch (error) {
  report.failure = {
    name: error instanceof Error ? error.name : "Error",
    message: String(error instanceof Error ? error.message : error).slice(0, 2_000)
  };
  report.finishedAt = new Date().toISOString();
  writeReport();
  throw error;
} finally {
  await Promise.all([
    sql.end({ timeout: 5 }).catch(() => undefined),
    redis.isOpen ? redis.quit().catch(() => undefined) : Promise.resolve(),
    s3.destroy()
  ]);
}

async function readPostgresEvidence() {
  const [physical] = await sql`
    SELECT
      pg_database_size(current_database())::text AS database_bytes,
      (
        SELECT coalesce(sum(pg_total_relation_size(
          format('%I.%I', schemaname, tablename)::regclass
        )), 0)::text
        FROM pg_tables
        WHERE schemaname = 'focowiki'
      ) AS relations_bytes
  `;
  const [counts] = await sql`
    SELECT
      (SELECT count(*) FROM focowiki.source_files
        WHERE knowledge_base_id = ${rebuild.knowledgeBaseId}
          AND deleted_at IS NULL)::text AS source_files,
      (SELECT count(DISTINCT object_id) FROM focowiki.source_revisions
        WHERE knowledge_base_id = ${rebuild.knowledgeBaseId}
          AND revision_role = 'current')::text AS current_source_objects,
      (SELECT count(DISTINCT object_id) FROM focowiki.source_revisions
        WHERE knowledge_base_id = ${rebuild.knowledgeBaseId}
          AND revision_role IN ('current', 'candidate', 'rollback'))::text
        AS transitional_source_objects,
      (SELECT count(DISTINCT object_id) FROM focowiki.object_owners
        WHERE knowledge_base_id = ${rebuild.knowledgeBaseId}
          AND owner_kind = 'active_root')::text AS active_generated_objects,
      (SELECT count(DISTINCT candidate.object_id)
        FROM focowiki.object_owners candidate
        WHERE candidate.knowledge_base_id = ${rebuild.knowledgeBaseId}
          AND candidate.owner_kind = 'candidate_root'
          AND NOT EXISTS (
            SELECT 1 FROM focowiki.object_owners active
            WHERE active.object_id = candidate.object_id
              AND active.owner_kind = 'active_root'
          ))::text AS candidate_only_objects,
      (SELECT count(*) FROM focowiki.search_projections
        WHERE knowledge_base_id = ${rebuild.knowledgeBaseId}
          AND projection_role = 'active')::text AS active_unified_indexes,
      (SELECT count(*) FROM focowiki.search_projections
        WHERE knowledge_base_id = ${rebuild.knowledgeBaseId}
          AND projection_role = 'candidate')::text AS candidate_unified_indexes,
      (SELECT count(*) FROM focowiki.object_registrations registration
        WHERE registration.state = 'verified'
          AND NOT EXISTS (
            SELECT 1 FROM focowiki.object_owners owner
            WHERE owner.object_id = registration.object_id
          ))::text AS unowned_objects,
      (SELECT coalesce(sum(registration.byte_count), 0)
        FROM focowiki.object_registrations registration
        WHERE registration.state = 'verified'
          AND EXISTS (
            SELECT 1 FROM focowiki.object_owners owner
            WHERE owner.object_id = registration.object_id
          ))::text AS registered_current_bytes,
      (SELECT min(zero_owner_since)::text FROM focowiki.object_registrations registration
        WHERE registration.state = 'verified'
          AND NOT EXISTS (
            SELECT 1 FROM focowiki.object_owners owner
            WHERE owner.object_id = registration.object_id
          )) AS earliest_zero_owner_since,
      (SELECT max(zero_owner_since)::text FROM focowiki.object_registrations registration
        WHERE registration.state = 'verified'
          AND NOT EXISTS (
            SELECT 1 FROM focowiki.object_owners owner
            WHERE owner.object_id = registration.object_id
          )) AS latest_zero_owner_since
  `;
  const [queues] = await sql`
    SELECT
      (SELECT count(*) FROM focowiki.operation_work_items)::text AS live_work_items,
      (SELECT coalesce(max(extract(epoch FROM now() - updated_at) * 1000), 0)
        FROM focowiki.operation_work_items)::text AS maximum_queue_age_ms,
      (SELECT count(*) FROM focowiki.cleanup_actions)::text AS live_cleanup_actions,
      (SELECT coalesce(max(extract(epoch FROM now() - not_before) * 1000), 0)
        FROM focowiki.cleanup_actions)::text AS maximum_cleanup_age_ms
  `;
  const [databaseStats] = await sql`
    SELECT xact_commit::text, xact_rollback::text, blks_read::text,
           blks_hit::text, temp_bytes::text, deadlocks::text,
           numbackends::text
    FROM pg_stat_database
    WHERE datname = current_database()
  `;
  const [wal] = await sql`
    SELECT wal_records::text, wal_fpi::text, wal_bytes::text
    FROM pg_stat_wal
  `;
  return {
    databaseBytes: integer(physical.database_bytes),
    relationsBytes: integer(physical.relations_bytes),
    sourceFiles: integer(counts.source_files),
    currentSourceObjects: integer(counts.current_source_objects),
    transitionalSourceObjects: integer(counts.transitional_source_objects),
    activeGeneratedObjects: integer(counts.active_generated_objects),
    candidateOnlyObjects: integer(counts.candidate_only_objects),
    activeUnifiedIndexes: integer(counts.active_unified_indexes),
    candidateUnifiedIndexes: integer(counts.candidate_unified_indexes),
    unownedObjects: integer(counts.unowned_objects),
    registeredCurrentBytes: integer(counts.registered_current_bytes),
    earliestZeroOwnerSince: counts.earliest_zero_owner_since ?? null,
    latestZeroOwnerSince: counts.latest_zero_owner_since ?? null,
    liveWorkItems: integer(queues.live_work_items),
    maximumQueueAgeMs: roundedInteger(queues.maximum_queue_age_ms),
    liveCleanupActions: integer(queues.live_cleanup_actions),
    maximumCleanupAgeMs: roundedInteger(queues.maximum_cleanup_age_ms),
    databaseStats: mapIntegerRecord(databaseStats),
    wal: {
      records: integer(wal.wal_records),
      fullPageImages: integer(wal.wal_fpi),
      bytes: integer(wal.wal_bytes)
    }
  };
}

async function readIdleDatabaseConnectionCount() {
  const [row] = await sql`
    SELECT count(*)::text AS database_connections
    FROM pg_stat_activity
    WHERE datname = current_database()
      AND pid <> pg_backend_pid()
  `;
  return integer(row.database_connections);
}

async function readIdleDatabaseConnectionEvidence() {
  const samples = [];
  const deadline = Date.now() + IDLE_CONNECTION_SAMPLE_WINDOW_MS;
  do {
    samples.push(await readIdleDatabaseConnectionCount());
    if (Date.now() >= deadline) break;
    await sleep(IDLE_CONNECTION_SAMPLE_INTERVAL_MS);
  } while (true);
  return summarizeStorageVnextIdleDatabaseConnectionSamples(samples);
}

async function readS3Evidence() {
  const markerKey = `${proof.objectScope}_run-owner.json`;
  let ownerMarkerBytes = 0;
  let ownerMarkerObjects = 0;
  const inventory = await writeS3VersionInventory({
    client: s3,
    bucket: requiredEnv("S3_BUCKET"),
    prefix: proof.objectScope,
    async write(item) {
      if (item.kind === "version" && item.key === markerKey && item.isLatest) {
        ownerMarkerBytes += item.size;
        ownerMarkerObjects += 1;
      }
    }
  });
  if (ownerMarkerObjects !== 1) throw new Error("S3 owner marker inventory is invalid");
  const marker = await s3.send(new GetObjectAttributesCommand({
    Bucket: requiredEnv("S3_BUCKET"),
    Key: markerKey,
    ObjectAttributes: ["ObjectSize"]
  }));
  if (Number(marker.ObjectSize) !== ownerMarkerBytes) {
    throw new Error("S3 owner marker byte evidence changed during inventory");
  }
  return { inventory, ownerMarkerBytes, ownerMarkerObjects };
}

async function readMeilisearchEvidence() {
  const indexes = [];
  let offset = 0;
  for (;;) {
    const page = await fetchMeili(`/indexes?limit=1000&offset=${offset}`);
    const pageItems = page.results ?? [];
    for (const index of pageItems) {
      if (!index.uid?.startsWith(proof.searchScope)) continue;
      const stats = await fetchMeili(`/indexes/${encodeURIComponent(index.uid)}/stats`);
      indexes.push({
        uid: index.uid,
        numberOfDocuments: integer(stats.numberOfDocuments),
        isIndexing: stats.isIndexing === true,
        fieldDistribution: stats.fieldDistribution ?? {}
      });
    }
    if (pageItems.length < 1_000) break;
    offset += pageItems.length;
  }
  const scopedTasks = [];
  let from = null;
  for (;;) {
    const page = await fetchMeili(
      `/tasks?limit=1000${from === null ? "" : `&from=${encodeURIComponent(from)}`}`
    );
    for (const task of page.results ?? []) {
      if (!task.indexUid?.startsWith(proof.searchScope)) continue;
      scopedTasks.push({ uid: task.uid, status: task.status, type: task.type });
    }
    if (page.next === null || page.next === undefined) break;
    from = page.next;
  }
  const tasks = summarizeStorageVnextProviderTasks({
    total: scopedTasks.length,
    next: null,
    results: scopedTasks
  });
  const stats = await fetchMeili("/stats");
  return {
    databaseSizeBytes: integer(stats.databaseSize),
    usedDatabaseSizeBytes: integer(stats.usedDatabaseSize),
    indexes,
    tasks
  };
}

async function readRedisEvidence() {
  if (!redis.isOpen) await redis.connect();
  const keys = [];
  for await (const scanned of redis.scanIterator({
    MATCH: `${proof.coordinationScope}*`,
    COUNT: 500
  })) {
    for (const key of Array.isArray(scanned) ? scanned : [scanned]) {
      keys.push({ key, type: await redis.type(key), ttlSeconds: await redis.ttl(key) });
    }
  }
  keys.sort((left, right) => left.key.localeCompare(right.key));
  const memory = parseRedisInfo(await redis.info("memory"));
  const persistence = parseRedisInfo(await redis.info("persistence"));
  return {
    scopedKeyCount: keys.length,
    keys,
    usedMemoryBytes: integer(memory.used_memory),
    usedMemoryRssBytes: integer(memory.used_memory_rss),
    aofEnabled: persistence.aof_enabled === "1",
    aofRewriteInProgress: persistence.aof_rewrite_in_progress === "1",
    aofRewriteScheduled: persistence.aof_rewrite_scheduled === "1"
  };
}

function readRuntimeEvidence() {
  const logDir = path.join(proof.filesystemScope, "logs");
  const names = [
    "focowiki-source-worker.log",
    "focowiki-publication-worker.log",
    "focowiki-maintenance-worker.log"
  ];
  const records = names.flatMap((name) => parseStorageVnextRuntimeResourceRecords(
    fs.readFileSync(path.join(logDir, name), "utf8")
  ));
  return summarizeStorageVnextRuntimeResourceRecords(records);
}

function readRuntimeFlowEvidence() {
  const file = path.join(proof.filesystemScope, "scale-runtime-flow.json");
  if (!fs.existsSync(file)) return null;
  const value = readJson(file);
  if (
    value?.kind !== "focowiki-storage-vnext-runtime-flow-evidence"
    || value.version !== 1
    || value.runId !== proof.runId
    || value.summary?.flowCount !== 7
  ) throw new Error("Runtime flow evidence is invalid");
  return value;
}

function readStructuredLogEvidence() {
  const root = path.join(proof.filesystemScope, "logs");
  const files = walkFiles(root).map((file) => ({
    name: path.relative(root, file),
    byteCount: fs.statSync(file).size
  }));
  return {
    files,
    byteCount: files.reduce((sum, file) => sum + file.byteCount, 0)
  };
}

async function readContainerEvidence() {
  const [postgresEvidence, redisEvidence, meiliEvidence, minioEvidence] =
    await Promise.all([
      containerMetrics("postgres", "/var/lib/postgresql"),
      containerMetrics("redis", "/data"),
      containerMetrics("meilisearch", "/meili_data"),
      containerMetrics("minio", "/data")
    ]);
  return {
    postgres: postgresEvidence,
    redis: redisEvidence,
    meilisearch: meiliEvidence,
    minio: minioEvidence
  };
}

async function containerMetrics(service, directory) {
  const directoryBytes = await composeDirectoryBytes(service, directory);
  const cgroup = await composeExec(service, [
    "sh",
    "-c",
    "cat /sys/fs/cgroup/memory.current; cat /sys/fs/cgroup/memory.peak; cat /sys/fs/cgroup/pids.current"
  ]);
  const values = cgroup.trim().split(/\s+/u).map(integer);
  if (values.length !== 3) throw new Error(`${service} cgroup evidence is invalid`);
  return {
    directoryBytes,
    currentMemoryBytes: values[0],
    peakMemoryBytes: values[1],
    processCount: values[2]
  };
}

async function composeDirectoryBytes(service, directory) {
  try {
    const output = await composeExec(service, ["du", "-sb", directory]);
    return parseDirectoryBytes(output, directory);
  } catch (error) {
    const output = typeof error?.stdout === "string" ? error.stdout : "";
    if (!output) throw error;
    return parseDirectoryBytes(output, directory);
  }
}

function parseDirectoryBytes(output, directory) {
  const line = output.split(/\r?\n/u).find((entry) => entry.trim().endsWith(directory));
  if (!line) throw new Error(`Container directory evidence is missing for ${directory}`);
  return integer(line.trim().split(/\s+/u)[0]);
}

async function composeExec(service, command) {
  const project = requiredEnv("FOCOWIKI_STORAGE_VNEXT_COMPOSE_PROJECT");
  const { stdout } = await execFile("docker", [
    "compose", "-p", project, "-f", "docker-compose.local.yml",
    "exec", "-T", service, ...command
  ], { cwd: process.cwd(), env: process.env, maxBuffer: 10 * 1024 * 1024 });
  return stdout;
}

async function readApplicationProcesses() {
  const { stdout } = await execFile("ps", [
    "-ax", "-o", "pid=,ppid=,rss=,time=,command="
  ], { maxBuffer: 10 * 1024 * 1024 });
  const processes = [];
  for (const line of stdout.split("\n")) {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/u);
    if (!match) continue;
    const command = match[5];
    const role = runtimeRole(command);
    if (!role) continue;
    const pid = integer(match[1]);
    processes.push({
      role,
      pid,
      parentPid: integer(match[2]),
      rssBytes: integer(match[3]) * 1_024,
      cpuSeconds: parseCpuTime(match[4]),
      fileDescriptors: await readNumericFileDescriptors(pid)
    });
  }
  processes.sort((left, right) => left.role.localeCompare(right.role));
  const requiredRoles = ["api", "maintenance-worker", "publication-worker", "source-worker"];
  if (processes.length !== requiredRoles.length
    || processes.some((process, index) => process.role !== requiredRoles[index])) {
    throw new Error("Scale application process evidence is incomplete");
  }
  return processes;
}

async function readNumericFileDescriptors(pid) {
  const { stdout } = await execFile("lsof", ["-nP", "-F", "f", "-p", String(pid)], {
    maxBuffer: 10 * 1024 * 1024
  });
  return stdout.split("\n").filter((line) => /^f\d+[rwu]?$/u.test(line)).length;
}

function summarizeIdleWindow(before, after, elapsedMs) {
  const initial = new Map(before.map((process) => [process.role, process]));
  let cpuSeconds = 0;
  for (const process of after) {
    const previous = initial.get(process.role);
    if (!previous || previous.pid !== process.pid) {
      throw new Error("Application process changed during the idle window");
    }
    const delta = process.cpuSeconds - previous.cpuSeconds;
    if (delta < 0) throw new Error("Application CPU time moved backwards");
    cpuSeconds += delta;
  }
  const beforeRss = before.reduce((sum, process) => sum + process.rssBytes, 0);
  const afterRss = after.reduce((sum, process) => sum + process.rssBytes, 0);
  return {
    settleWindowMs: elapsedMs,
    applicationCpuPercent: round(cpuSeconds / (elapsedMs / 1_000) * 100),
    beforeApplicationRssBytes: beforeRss,
    applicationRssBytes: afterRss,
    applicationRssDeltaBytes: Math.max(0, afterRss - beforeRss),
    maximumFileDescriptorsPerProcess: Math.max(
      ...before.concat(after).map((process) => process.fileDescriptors)
    ),
    processes: after
  };
}

function summarizeResourceEvidence(input) {
  const api = input.idle.processes.find((process) => process.role === "api");
  const handles = selectStorageVnextHandleEvidence(input);
  const peakApplicationRssBytes = input.runtime.peakKnownApplicationRssBytes
    + (api?.rssBytes ?? 0);
  const stack = selectStorageVnextPeakStackEvidence({
    sampling: input.resourceSampling,
    rebuildStartedAt: input.rebuildStartedAt,
    rebuildFinishedAt: input.rebuildFinishedAt,
    peakApplicationRssBytes,
    containers: input.containers
  });
  return {
    peakApplicationCpuPercent: input.runtime.peakKnownApplicationCpuPercent,
    idleApplicationCpuPercent: input.idle.applicationCpuPercent,
    peakApplicationRssBytes: stack.peakApplicationRssBytes,
    peakApplicationRssBasis: stack.basis,
    idleApplicationRssBytes: input.idle.applicationRssBytes,
    peakMeilisearchRssBytes: input.containers.meilisearch.peakMemoryBytes,
    peakStackRssBytes: stack.peakStackRssBytes,
    peakStackRssBasis: stack.basis,
    concurrentPeakEvidenceReady: stack.acceptanceReady,
    peakDatabaseConnections: configuredDatabasePoolCeiling(),
    peakDatabaseConnectionsBasis: "configured aggregate pool hard ceiling",
    idleDatabaseConnections: input.database.databaseConnections,
    idleDatabaseConnectionWindow: input.database.databaseConnectionEvidence,
    peakActiveHandlesPerProcess: handles.peakActiveHandlesPerProcess,
    idleActiveHandlesPerProcess: handles.idleActiveHandlesPerProcess,
    activeHandleBasis: handles.basis,
    peakFileDescriptorsPerProcess: input.idle.maximumFileDescriptorsPerProcess,
    peakFileDescriptorsBasis: "maximum observed at both idle-window boundaries",
    applicationRssDeltaBytes: input.idle.applicationRssDeltaBytes,
    idleWindow: input.idle,
    runtime: input.runtime,
    flow: input.flow,
    containers: input.containers
  };
}

function configuredDatabasePoolCeiling() {
  return [
    "DATABASE_POOL_MAX",
    "SOURCE_WORKER_DATABASE_POOL_MAX",
    "PUBLICATION_WORKER_DATABASE_POOL_MAX",
    "MAINTENANCE_WORKER_DATABASE_POOL_MAX"
  ].reduce((sum, name) => sum + integer(requiredEnv(name)), 0);
}

function assess(input) {
  const B = resourceMode === "full"
    ? STORAGE_VNEXT_FULL_BUDGETS
    : STORAGE_VNEXT_10000_BUDGETS;
  const failures = [];
  let storageReferences = null;
  if (resourceMode === "full") {
    const storageAssessment = evaluateStorageVnextFullStorageEvidence(
      input.comparable.storage
    );
    failures.push(...storageAssessment.failures);
    storageReferences = storageAssessment.references;
    exact(failures, "resources.concurrentPeakEvidenceReady",
      input.resources.concurrentPeakEvidenceReady, true);
  } else {
    maximum(failures, "storage.postgresRelationsBytes",
      input.comparable.storage.postgresRelationsBytes,
      B.storageBytes.postgresRelationsMaximum);
    maximum(failures, "storage.postgresDirectoryBytes",
      input.comparable.storage.postgresDirectoryBytes,
      B.storageBytes.postgresDirectoryMaximum);
    maximum(failures, "storage.s3AllVersionsBytes",
      input.comparable.storage.s3AllVersionsBytes,
      B.storageBytes.s3AllVersionsMaximum);
    maximum(failures, "storage.meilisearchPhysicalBytes",
      input.comparable.storage.meilisearchPhysicalBytes,
      B.storageBytes.meilisearchPhysicalMaximum);
    maximum(failures, "storage.redisPersistedBytes",
      input.comparable.storage.redisPersistedBytes,
      B.storageBytes.redisPersistedMaximum);
    maximum(failures, "storage.fourStoreTotalBytes",
      input.comparable.storage.fourStoreTotalBytes,
      B.storageBytes.fourStoreTotalMaximum);
    maximum(failures, "storage.structuredLogsBytes",
      input.comparable.storage.structuredLogsBytes,
      B.storageBytes.structuredLogsMaximum);
  }
  maximum(failures, "objects.currentSourceObjects",
    input.comparable.objects.currentSourceObjects,
    B.objects.currentSourceMaximum);
  maximum(failures, "objects.transitionalSourceObjects",
    input.comparable.objects.transitionalSourceObjects,
    B.objects.transitionalSourceMaximum);
  maximum(failures, "objects.activeGeneratedObjects",
    input.comparable.objects.activeGeneratedObjects,
    B.objects.activeGeneratedMaximum);
  maximum(failures, "objects.candidateOnlyObjects",
    input.comparable.objects.candidateOnlyObjects,
    B.objects.candidateOnlyMaximum);
  exact(failures, "objects.activeUnifiedIndexes",
    input.comparable.objects.activeUnifiedIndexes,
    B.objects.activeUnifiedIndexes);
  maximum(failures, "objects.candidateUnifiedIndexes",
    input.comparable.objects.candidateUnifiedIndexes,
    B.objects.candidateUnifiedIndexesMaximum);
  maximum(failures, "objects.unintendedVersions",
    input.comparable.objects.unintendedVersions,
    B.objects.unintendedVersionsMaximum);
  maximum(failures, "objects.deleteMarkers",
    input.comparable.objects.deleteMarkers,
    B.objects.deleteMarkersMaximum);
  maximum(failures, "objects.incompleteMultipartUploads",
    input.comparable.objects.incompleteMultipartUploads,
    B.objects.incompleteMultipartUploadsMaximum);
  maximum(failures, "objects.unownedObjects",
    input.comparable.objects.unownedObjects,
    B.objects.unownedObjectsMaximum);
  maximum(failures, "resources.peakApplicationCpuPercent",
    input.resources.peakApplicationCpuPercent,
    B.resources.maximumPeakApplicationCpuPercent);
  maximum(failures, "resources.idleApplicationCpuPercent",
    input.resources.idleApplicationCpuPercent,
    B.resources.maximumIdleApplicationCpuPercent);
  maximum(failures, "resources.peakApplicationRssBytes",
    input.resources.peakApplicationRssBytes,
    B.resources.maximumPeakApplicationRssBytes);
  maximum(failures, "resources.peakMeilisearchRssBytes",
    input.resources.peakMeilisearchRssBytes,
    B.resources.maximumPeakMeilisearchRssBytes);
  maximum(failures, "resources.peakStackRssBytes",
    input.resources.peakStackRssBytes,
    B.resources.maximumPeakStackRssBytes);
  maximum(failures, "resources.peakDatabaseConnections",
    input.resources.peakDatabaseConnections,
    B.resources.maximumPeakDatabaseConnections);
  maximum(failures, "resources.idleDatabaseConnections",
    input.resources.idleDatabaseConnections,
    B.resources.maximumIdleDatabaseConnections);
  requiredMaximum(failures, "resources.peakActiveHandlesPerProcess",
    input.resources.peakActiveHandlesPerProcess,
    B.resources.maximumPeakActiveHandlesPerProcess);
  requiredMaximum(failures, "resources.idleActiveHandlesPerProcess",
    input.resources.idleActiveHandlesPerProcess,
    B.resources.maximumIdleActiveHandlesPerProcess);
  maximum(failures, "resources.peakFileDescriptorsPerProcess",
    input.resources.peakFileDescriptorsPerProcess,
    B.resources.maximumPeakFileDescriptorsPerProcess);
  maximum(failures, "queues.liveWorkItems", input.queues.liveWorkItems, 0);
  maximum(failures, "queues.liveCleanupActions", input.queues.liveCleanupActions, 0);
  maximum(failures, "queues.providerTasksInFlight",
    input.meilisearch.tasks.inFlight,
    B.cleanup.maximumProviderTasksInFlight);
  return { ok: failures.length === 0, failures, budgets: B, storageReferences };
}

function maximum(failures, name, value, limit) {
  if (!Number.isFinite(value) || value < 0) {
    failures.push(`${name} is missing or invalid`);
  } else if (value > limit) {
    failures.push(`${name} ${value} exceeds maximum ${limit}`);
  }
}

function requiredMaximum(failures, name, value, limit) {
  if (value === null || value === undefined) {
    failures.push(`${name} evidence is missing`);
    return;
  }
  maximum(failures, name, value, limit);
}

function exact(failures, name, value, expected) {
  if (value !== expected) failures.push(`${name} ${value} must equal ${expected}`);
}

async function fetchMeili(pathname) {
  const response = await fetch(`${requiredEnv("MEILI_HOST")}${pathname}`, {
    headers: { authorization: `Bearer ${requiredEnv("MEILI_API_KEY")}` },
    signal: AbortSignal.timeout(30_000)
  });
  if (!response.ok) throw new Error(`Meilisearch returned HTTP ${response.status}`);
  return response.json();
}

function parseRedisInfo(text) {
  const values = {};
  for (const line of text.split(/\r?\n/u)) {
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf(":");
    if (separator > 0) values[line.slice(0, separator)] = line.slice(separator + 1);
  }
  return values;
}

function runtimeRole(command) {
  const matches = [
    ["api", "/apps/api/runtime/main.mjs"],
    ["source-worker", "/apps/api/runtime/source-worker.mjs"],
    ["publication-worker", "/apps/api/runtime/publication-worker.mjs"],
    ["maintenance-worker", "/apps/api/runtime/maintenance-worker.mjs"]
  ];
  return matches.find(([, suffix]) => command.includes(suffix))?.[0] ?? null;
}

function parseCpuTime(value) {
  const dayParts = value.split("-");
  const days = dayParts.length === 2 ? Number(dayParts[0]) : 0;
  const clock = dayParts.at(-1).split(":").map(Number);
  if (clock.some((part) => !Number.isFinite(part))) throw new Error("CPU time is invalid");
  const seconds = clock.length === 3
    ? clock[0] * 3_600 + clock[1] * 60 + clock[2]
    : clock[0] * 60 + clock[1];
  return days * 86_400 + seconds;
}

function walkFiles(root) {
  return fs.readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(root, entry.name);
    return entry.isDirectory() ? walkFiles(target) : [target];
  });
}

function mapIntegerRecord(record) {
  return Object.fromEntries(Object.entries(record).map(([key, value]) => [key, integer(value)]));
}

function integer(value) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`Expected safe nonnegative integer, received ${value}`);
  }
  return parsed;
}

function roundedInteger(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`Expected finite nonnegative number, received ${value}`);
  }
  return Math.round(parsed);
}

function round(value) {
  if (!Number.isFinite(value) || value < 0) throw new Error("Metric is invalid");
  return Math.round(value * 1_000) / 1_000;
}

function assertInputs(value) {
  if (
    value?.kind !== profile.rebuildKind
    || value.runId !== proof?.runId
    || value.failure !== null
    || value.corpus?.fileCount !== profile.expectedFileCount
    || value.convergence?.sourceFiles !== profile.expectedFileCount
    || value.convergence?.readySources !== profile.expectedFileCount
    || value.convergence?.activeUnifiedIndexes !== 1
    || path.dirname(proofPath) !== proof.filesystemScope
  ) throw new Error("Scale resource input evidence is invalid");
}

function writeReport() {
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
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
