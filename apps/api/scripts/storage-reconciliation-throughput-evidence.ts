import { createHash, randomUUID } from "node:crypto";
import { fork, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { loadEnvFile } from "node:process";
import { performance } from "node:perf_hooks";
import postgres, { type Sql } from "postgres";
import { applyMigrations } from "../src/db/migrations.js";
import {
  summarizeQueryPlan,
  type QueryPlanSummary
} from "../src/db/query-plan-validation.js";
import { createPostgresObjectProtectionRepository } from "../src/infrastructure/postgres/object-protection-repository.js";
import { createPostgresStorageReconciliationRepository } from "../src/infrastructure/postgres/storage-reconciliation-repository.js";
import { runObjectProtectionMaintenanceSlice } from "../src/maintenance/object-protection-maintenance.js";
import { runStorageReconciliationSlice } from "../src/maintenance/storage-reconciliation.js";
import { createStorageKeyspace } from "../src/storage/keys.js";
import type { StorageAdapter, StorageObjectMetadata } from "../src/storage/s3.js";

const STORAGE_PREFIX = "storage-reconciliation-evidence";
const KNOWLEDGE_BASE_ID = "kb-storage-reconciliation-evidence";
const ACTIVE_GENERATION_ID = "generation-storage-reconciliation-active";
const RETAINED_GENERATION_ID = "generation-storage-reconciliation-retained";
const READ_SOURCE_FILE_ID = "source-file-storage-reconciliation-read";
const READ_SOURCE_REVISION_ID = "source-revision-storage-reconciliation-read";
const READ_FILE_PATH = "pages/storage-reconciliation-benchmark.md";
const READ_OBJECT_CHECKSUM = "0".repeat(64);
const READ_OBJECT_KEY =
  `${STORAGE_PREFIX}/generated/v1/objects/00/${READ_OBJECT_CHECKSUM}`;
const PAGE_SIZE = 1_000;
const PRECONFIRMED_CANDIDATE_LIMIT = 100;
const HTTP_BASELINE_DURATION_MS = 3_000;
const HTTP_READ_INTERVAL_MS = 25;
const MAINTENANCE_POLL_INTERVAL_MS = 1_000;
const REPORT_DIRECTORY = resolve(
  process.cwd(),
  "../../ReferenceDocs/performance/storage-reconciliation"
);

type DatabaseStats = {
  xactCommit: number;
  blocksRead: number;
  blocksHit: number;
  tuplesReturned: number;
  tuplesFetched: number;
  tuplesInserted: number;
  tuplesUpdated: number;
  tuplesDeleted: number;
  temporaryFiles: number;
  temporaryBytes: number;
  deadlocks: number;
};

type FixtureCounts = {
  storageObjects: number;
  activeReferenced: number;
  retainedReferenced: number;
  writeReserved: number;
  projectionProtected: number;
  projectionUnreferenced: number;
  orphan: number;
  missingRegistered: number;
  preconfirmedCandidates: number;
};

type SliceEvidence = {
  phase: string;
  durationMs: number;
  readLatencyMs: number;
  scanned: number;
  deleted: number;
  verified: number;
  failed: number;
};

type BenchmarkReport = {
  kind: "storage-reconciliation-throughput-evidence";
  implementation: "baseline" | "optimized";
  generatedAt: string;
  profile: string;
  fixture: FixtureCounts & {
    pageSize: number;
    maintenancePollIntervalMs: number;
    httpReadIntervalMs: number;
    database: "temporary PostgreSQL database";
    storage: "deterministic in-process metadata adapter";
  };
  queryPlan: QueryPlanSummary;
  cycle: {
    durationMs: number;
    throughputPerSecond: number;
    slices: number;
    scanSlices: number;
    deleteSlices: number;
    verificationSlices: number;
    pageLatencyMs: Distribution;
    readLatencyMs: Distribution;
    scanned: number;
    deleted: number;
    verified: number;
    failed: number;
    heartbeatGapMs: number;
    leaseDurationMs: number;
    leaseExpiredDuringPage: boolean;
    retryCount: number;
    finalState: string | null;
  };
  resources: {
    processCpuUserMs: number;
    processCpuSystemMs: number;
    rssBeforeMb: number;
    peakRssMb: number;
    rssGrowthMb: number;
    databaseCpu: "not available in the portable local harness";
    databaseStats: DatabaseStats;
  };
  readTraffic: {
    baseline: HttpReadEvidence;
    concurrent: HttpReadEvidence;
    p95RegressionPercent: {
      admin: number;
      developerOpenApi: number;
      combined: number;
    };
  };
  preparation: {
    objectProtectionDurationMs: number;
    objectProtectionSlices: number;
    objectProtectionReady: boolean;
  };
};

type HttpReadSample = {
  plane: "admin" | "developerOpenApi";
  operation: string;
  durationMs: number;
  ok: boolean;
};

type HttpReadEvidence = {
  requestCount: number;
  errorCount: number;
  errorRatePercent: number;
  adminLatencyMs: Distribution;
  developerOpenApiLatencyMs: Distribution;
  combinedLatencyMs: Distribution;
};

type HttpReadTrafficHarness = {
  measureRound: () => Promise<HttpReadSample[]>;
  close: () => Promise<void>;
};

type Distribution = {
  minimum: number;
  median: number;
  p95: number;
  maximum: number;
};

const args = readArguments(process.argv.slice(2));
loadLocalEnvironment();
const sourceDatabaseUrl = readDatabaseUrl();
const databaseName =
  `focowiki_reconciliation_${process.pid}_${randomUUID().replaceAll("-", "").slice(0, 10)}`;
const admin = postgres(databaseConnectionUrl(sourceDatabaseUrl, "postgres"), { max: 1 });
const sql = postgres(databaseConnectionUrl(sourceDatabaseUrl, databaseName), { max: 6 });
const readSql = postgres(databaseConnectionUrl(sourceDatabaseUrl, databaseName), { max: 2 });

async function main(): Promise<void> {
  let readTraffic: HttpReadTrafficHarness | null = null;
  try {
    await admin.unsafe(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
    await applyMigrations(sql);
    const fixture = buildFixtureCounts(args.objects);
    await seedFixture(sql, fixture);
    const storage = new BenchmarkStorage(fixture.storageObjects);
    readTraffic = await createHttpReadTrafficHarness();
    const preparation = args.implementation === "optimized"
      ? await prepareObjectProtection(sql, fixture)
      : {
          objectProtectionDurationMs: 0,
          objectProtectionSlices: 0,
          objectProtectionReady: false
        };
    const queryPlan = await measureClassificationPlan(sql, fixture);
    const report = await measureCycle(
      sql,
      readSql,
      storage,
      readTraffic,
      fixture,
      queryPlan,
      preparation
    );
    await mkdir(REPORT_DIRECTORY, { recursive: true });
    await writeFile(
      resolve(REPORT_DIRECTORY, `${args.label}.json`),
      `${JSON.stringify(report, null, 2)}\n`,
      "utf8"
    );
    console.log(JSON.stringify(report, null, 2));
  } finally {
    await readTraffic?.close().catch(() => undefined);
    await Promise.all([
      sql.end({ timeout: 5 }).catch(() => undefined),
      readSql.end({ timeout: 5 }).catch(() => undefined)
    ]);
    await admin.unsafe(`DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)} WITH (FORCE)`);
    await admin.end({ timeout: 5 });
  }
}

async function seedFixture(database: Sql, fixture: FixtureCounts): Promise<void> {
  await database.begin(async (transaction) => {
    await transaction`
      INSERT INTO focowiki.knowledge_bases (id, name, description)
      VALUES (
        ${KNOWLEDGE_BASE_ID},
        'Storage reconciliation evidence',
        'Domain-neutral deterministic benchmark fixture'
      )
    `;
    await transaction`
      INSERT INTO focowiki.publication_generations (
        id, knowledge_base_id, state, generation_kind, format_version,
        activated_at, frozen_at, validated_at
      ) VALUES
        (
          ${ACTIVE_GENERATION_ID}, ${KNOWLEDGE_BASE_ID}, 'active', 'normal', 2,
          now(), now(), now()
        ),
        (
          ${RETAINED_GENERATION_ID}, ${KNOWLEDGE_BASE_ID}, 'superseded', 'normal', 2,
          now() - interval '1 day', now() - interval '1 day', now() - interval '1 day'
        )
    `;
    await transaction`
      UPDATE focowiki.knowledge_bases
      SET active_generation_id = ${ACTIVE_GENERATION_ID}
      WHERE id = ${KNOWLEDGE_BASE_ID}
    `;

    const immutableEnd =
      fixture.activeReferenced + fixture.retainedReferenced + fixture.writeReserved;
    const writingStart = fixture.activeReferenced + fixture.retainedReferenced;
    const missingStart = fixture.storageObjects;
    const missingEnd = missingStart + fixture.missingRegistered;

    await transaction`
      INSERT INTO focowiki.immutable_objects (
        checksum_sha256, format_version, object_key, content_type, size_bytes,
        lifecycle_state, write_token, write_started_at, verified_at
      )
      SELECT
        lpad(to_hex(value), 64, '0'),
        1,
        ${`${STORAGE_PREFIX}/generated/`} || 'v1/objects/' ||
          substring(lpad(to_hex(value), 64, '0'), 1, 2) || '/' ||
          lpad(to_hex(value), 64, '0'),
        'application/json',
        value + 1,
        CASE WHEN value >= ${writingStart} AND value < ${immutableEnd}
          THEN 'writing' ELSE 'active' END,
        CASE WHEN value >= ${writingStart} AND value < ${immutableEnd}
          THEN 'benchmark-write-token-' || value::text ELSE NULL END,
        CASE WHEN value >= ${writingStart} AND value < ${immutableEnd}
          THEN now() ELSE NULL END,
        CASE WHEN value >= ${writingStart} AND value < ${immutableEnd}
          THEN NULL ELSE now() END
      FROM (
        SELECT value
        FROM generate_series(0::bigint, ${immutableEnd - 1}::bigint) AS value
        UNION ALL
        SELECT value
        FROM generate_series(${missingStart}::bigint, ${missingEnd - 1}::bigint) AS value
      ) identities
    `;

    await transaction`
      INSERT INTO focowiki.active_object_refs (
        knowledge_base_id, ref_kind, ref_key, file_id,
        last_changed_generation_id, checksum_sha256, format_version, logical_path
      )
      SELECT
        ${KNOWLEDGE_BASE_ID}, 'page', 'active-' || value::text,
        'file-active-' || value::text, ${ACTIVE_GENERATION_ID},
        lpad(to_hex(value), 64, '0'), 1,
        'pages/active-' || value::text || '.md'
      FROM generate_series(
        0::bigint,
        ${fixture.activeReferenced - 1}::bigint
      ) AS value
    `;

    const retainedStart = fixture.activeReferenced;
    const retainedEnd = retainedStart + fixture.retainedReferenced;
    await transaction`
      INSERT INTO focowiki.generation_object_refs (
        generation_id, knowledge_base_id, ref_kind, ref_key, file_id,
        action, checksum_sha256, format_version, logical_path
      )
      SELECT
        ${RETAINED_GENERATION_ID}, ${KNOWLEDGE_BASE_ID}, 'page',
        'retained-' || value::text, 'file-retained-' || value::text,
        'upsert', lpad(to_hex(value), 64, '0'), 1,
        'pages/retained-' || value::text || '.md'
      FROM generate_series(
        ${retainedStart}::bigint,
        ${retainedEnd - 1}::bigint
      ) AS value
    `;

    const projectionStart = immutableEnd;
    const projectionEnd = projectionStart + fixture.projectionProtected;
    const unreferencedEnd = projectionEnd + fixture.projectionUnreferenced;
    await transaction`
      INSERT INTO focowiki.projection_segments (
        id, knowledge_base_id, projection_kind, logical_partition,
        segment_kind, sequence_number, format_version, checksum_sha256,
        object_key, logical_path, entry_count, encoded_bytes,
        lifecycle_state, ownership_count
      )
      SELECT
        'segment-benchmark-' || value::text,
        ${KNOWLEDGE_BASE_ID},
        'search',
        'partition-' || (value % 64)::text,
        'base',
        value,
        1,
        lpad(to_hex(value), 64, '0'),
        ${`${STORAGE_PREFIX}/generated/`} || 'v1/objects/' ||
          substring(lpad(to_hex(value), 64, '0'), 1, 2) || '/' ||
          lpad(to_hex(value), 64, '0'),
        '_segments/search/' || value::text || '.json',
        1,
        value + 1,
        CASE WHEN value < ${projectionEnd} THEN 'active' ELSE 'quarantined' END,
        CASE WHEN value < ${projectionEnd} THEN 1 ELSE 0 END
      FROM generate_series(
        ${projectionStart}::bigint,
        ${unreferencedEnd - 1}::bigint
      ) AS value
    `;

    const orphanStart = args.objects - fixture.orphan;
    const preconfirmedEnd = Math.min(
      args.objects,
      orphanStart + fixture.preconfirmedCandidates
    );
    if (preconfirmedEnd > orphanStart) {
      await transaction`
        INSERT INTO focowiki.storage_reconciliation_candidates (
          prefix, object_key, checksum_sha256, format_version, state,
          first_seen_cycle_id, last_seen_cycle_id, confirmation_count,
          first_seen_at, last_seen_at, observed_size_bytes, observed_etag,
          next_attempt_at, updated_at
        )
        SELECT
          ${`${STORAGE_PREFIX}/generated/`},
          ${`${STORAGE_PREFIX}/generated/`} || 'v1/objects/' ||
            substring(lpad(to_hex(value), 64, '0'), 1, 2) || '/' ||
            lpad(to_hex(value), 64, '0'),
          lpad(to_hex(value), 64, '0'),
          1,
          'quarantined',
          'benchmark-prior-cycle',
          'benchmark-prior-cycle',
          1,
          now() - interval '2 days',
          now() - interval '2 days',
          value + 1,
          'etag-' || value::text,
          now() - interval '2 days',
          now() - interval '2 days'
        FROM generate_series(
          ${orphanStart}::bigint,
          ${preconfirmedEnd - 1}::bigint
        ) AS value
      `;
    }

    await transaction`
      INSERT INTO focowiki.source_files (
        id, knowledge_base_id, name, relative_path, path_key, object_key,
        content_type, size_bytes, checksum_sha256, active_revision_id,
        processing_status, processing_stage, generated_output_status
      ) VALUES (
        ${READ_SOURCE_FILE_ID}, ${KNOWLEDGE_BASE_ID},
        'storage-reconciliation-benchmark.md',
        'storage-reconciliation-benchmark.md',
        'storage-reconciliation-benchmark.md',
        ${`${STORAGE_PREFIX}/sources/${READ_SOURCE_FILE_ID}.md`},
        'text/markdown', 42, ${createHash("sha256").update("read-source").digest("hex")},
        ${READ_SOURCE_REVISION_ID}, 'completed', 'generation_activation', 'visible'
      )
    `;
    await transaction`
      INSERT INTO focowiki.source_revisions (
        id, knowledge_base_id, source_file_id, revision, object_key,
        content_type, size_bytes, checksum_sha256, processing_status
      ) VALUES (
        ${READ_SOURCE_REVISION_ID}, ${KNOWLEDGE_BASE_ID}, ${READ_SOURCE_FILE_ID}, 1,
        ${`${STORAGE_PREFIX}/sources/${READ_SOURCE_FILE_ID}.md`},
        'text/markdown', 42,
        ${createHash("sha256").update("read-source").digest("hex")},
        'completed'
      )
    `;
    await transaction`
      INSERT INTO focowiki.active_object_refs (
        knowledge_base_id, ref_kind, ref_key, file_id,
        last_changed_generation_id, checksum_sha256, format_version,
        logical_path, source_file_id
      ) VALUES (
        ${KNOWLEDGE_BASE_ID}, 'page', ${READ_SOURCE_FILE_ID}, ${READ_SOURCE_FILE_ID},
        ${ACTIVE_GENERATION_ID}, ${READ_OBJECT_CHECKSUM}, 1,
        ${READ_FILE_PATH}, ${READ_SOURCE_FILE_ID}
      )
    `;
    for (const projectionKind of ["tree", "search", "graph_node"] as const) {
      await transaction`
        INSERT INTO focowiki.active_projection_records (
          knowledge_base_id, projection_kind, record_id,
          last_changed_generation_id, shard_key, source_file_id,
          logical_path, parent_path, sort_key, title, summary,
          searchable_text, payload_json
        ) VALUES (
          ${KNOWLEDGE_BASE_ID}, ${projectionKind}, ${READ_SOURCE_FILE_ID},
          ${ACTIVE_GENERATION_ID}, ${`${projectionKind}/v1/benchmark`},
          ${READ_SOURCE_FILE_ID}, ${READ_FILE_PATH}, 'pages',
          ${READ_FILE_PATH}, 'Storage reconciliation benchmark',
          'Representative generated file for concurrent read validation',
          'storage reconciliation benchmark representative generated file',
          ${transaction.json({
            fileId: READ_SOURCE_FILE_ID,
            path: READ_FILE_PATH,
            title: "Storage reconciliation benchmark",
            kind: "file"
          })}
        )
      `;
    }
    await transaction`
      INSERT INTO focowiki.generation_graph_summaries (
        generation_id, knowledge_base_id, node_count, edge_count,
        graph_index_available
      ) VALUES (
        ${ACTIVE_GENERATION_ID}, ${KNOWLEDGE_BASE_ID}, 1, 0, false
      )
    `;
  });

  for (const relation of [
    "immutable_objects",
    "active_object_refs",
    "generation_object_refs",
    "projection_segments",
    "storage_reconciliation_candidates"
  ]) {
    await database.unsafe(`ANALYZE focowiki.${relation}`);
  }
}

async function measureClassificationPlan(
  database: Sql,
  fixture: FixtureCounts
): Promise<QueryPlanSummary> {
  const page = createStoragePage(
    0,
    Math.min(PAGE_SIZE, fixture.storageObjects),
    `${STORAGE_PREFIX}/generated/`
  );
  const rows = args.implementation === "optimized"
    ? await database<Array<{ "QUERY PLAN": unknown }>>`
        EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
        SELECT protection.object_key
        FROM unnest(
          ${page.map((object) => object.key)}::text[],
          ${page.map((object) => object.checksumSha256)}::text[],
          ${page.map((object) => object.formatVersion)}::int[]
        ) AS listed(object_key, checksum_sha256, format_version)
        CROSS JOIN LATERAL (
          SELECT indexed.object_key
          FROM focowiki.storage_object_protection_index indexed
          WHERE indexed.object_key = listed.object_key
            AND indexed.checksum_sha256 = listed.checksum_sha256
            AND indexed.format_version = listed.format_version
            AND (indexed.protected OR indexed.dirty)
          LIMIT 1
        ) protection
      `
    : await database<Array<{ "QUERY PLAN": unknown }>>`
        EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
        SELECT DISTINCT listed.object_key
        FROM unnest(
          ${page.map((object) => object.key)}::text[],
          ${page.map((object) => object.checksumSha256)}::text[],
          ${page.map((object) => object.formatVersion)}::int[]
        ) AS listed(object_key, checksum_sha256, format_version)
        JOIN focowiki.storage_object_protection protection
          ON protection.checksum_sha256 = listed.checksum_sha256
         AND protection.format_version = listed.format_version
         AND protection.object_key = listed.object_key
         AND protection.protection_class <> 'unreferenced'
      `;
  return summarizeQueryPlan(rows[0]?.["QUERY PLAN"]);
}

async function measureCycle(
  database: Sql,
  concurrentReadDatabase: Sql,
  storage: BenchmarkStorage,
  readTraffic: HttpReadTrafficHarness,
  fixture: FixtureCounts,
  queryPlan: QueryPlanSummary,
  preparation: BenchmarkReport["preparation"]
): Promise<BenchmarkReport> {
  const repository = createPostgresStorageReconciliationRepository(database);
  const settings = {
    reconciliationEnabled: true,
    scanIntervalSeconds: 60,
    scanBatchSize: PAGE_SIZE,
    deletionBatchSize: 100,
    quarantineGracePeriodSeconds: 1,
    confirmationPasses: 2,
    maxAttempts: 5,
    retryDelayMs: 1_000
  };
  const startedAt = new Date("2090-07-27T00:00:00.000Z");
  const leaseDurationMs = 5 * 60_000;
  let clock = startedAt;
  let peakRssBytes = process.memoryUsage().rss;
  const rssBeforeBytes = peakRssBytes;
  const cpuBefore = process.cpuUsage();
  const databaseStatsBefore = await readDatabaseStats(database);
  const slices: SliceEvidence[] = [];
  let totalScanned = 0;
  let totalDeleted = 0;
  let totalVerified = 0;
  let totalFailed = 0;
  const baselineReadSamples: HttpReadSample[] = [];
  const concurrentReadSamples: HttpReadSample[] = [];

  baselineReadSamples.push(...await measureHttpReadTrafficForDuration(
    readTraffic,
    HTTP_BASELINE_DURATION_MS
  ));
  const cycleStartedAt = performance.now();
  let collectConcurrentReads = true;
  const concurrentReadTask = collectHttpReadTrafficWhile(
    readTraffic,
    () => collectConcurrentReads
  );

  try {
    for (
      let index = 0;
      index < Math.ceil(fixture.storageObjects / PAGE_SIZE) + 100;
      index += 1
    ) {
      const sliceStartedAt = performance.now();
      const [result, readLatencyMs] = await Promise.all([
        runStorageReconciliationSlice({
          repository,
          storage,
          settings,
          versionPurgeEnabled: false,
          now: () => clock,
          leaseToken: "benchmark-lease",
          cycleId: "benchmark-cycle"
        }),
        measureConcurrentRead(concurrentReadDatabase)
      ]);
      const durationMs = performance.now() - sliceStartedAt;
      slices.push({
        phase: result.phase,
        durationMs,
        readLatencyMs,
        scanned: result.scanned,
        deleted: result.deleted,
        verified: result.verified,
        failed: result.failed
      });
      totalScanned += result.scanned;
      totalDeleted += result.deleted;
      totalVerified += result.verified;
      totalFailed += result.failed;
      peakRssBytes = Math.max(peakRssBytes, process.memoryUsage().rss);
      clock = new Date(clock.getTime() + Math.max(1, Math.ceil(durationMs)));
      if (result.phase === "completed" || result.phase === "failed") break;
      await delay(MAINTENANCE_POLL_INTERVAL_MS);
      clock = new Date(clock.getTime() + MAINTENANCE_POLL_INTERVAL_MS);
    }
  } finally {
    collectConcurrentReads = false;
    concurrentReadSamples.push(...await concurrentReadTask);
  }

  const cycleDurationMs = performance.now() - cycleStartedAt;
  const databaseStatsAfter = await readDatabaseStats(database);
  const cpu = process.cpuUsage(cpuBefore);
  const status = await repository.getStatus(`${STORAGE_PREFIX}/generated/`);
  const pageDurations = slices
    .filter((slice) => slice.scanned > 0)
    .map((slice) => slice.durationMs);
  const readDurations = slices.map((slice) => slice.readLatencyMs);
  const maximumPageMs = pageDurations.length > 0 ? Math.max(...pageDurations) : 0;
  const baselineReadTraffic = summarizeHttpReadSamples(baselineReadSamples);
  const concurrentReadTraffic = summarizeHttpReadSamples(concurrentReadSamples);

  return {
    kind: "storage-reconciliation-throughput-evidence",
    implementation: args.implementation,
    generatedAt: new Date().toISOString(),
    profile: args.label,
    fixture: {
      ...fixture,
      pageSize: PAGE_SIZE,
      maintenancePollIntervalMs: MAINTENANCE_POLL_INTERVAL_MS,
      httpReadIntervalMs: HTTP_READ_INTERVAL_MS,
      database: "temporary PostgreSQL database",
      storage: "deterministic in-process metadata adapter"
    },
    queryPlan,
    cycle: {
      durationMs: round(cycleDurationMs),
      throughputPerSecond: round(fixture.storageObjects / (cycleDurationMs / 1_000)),
      slices: slices.length,
      scanSlices: slices.filter((slice) => slice.scanned > 0).length,
      deleteSlices: slices.filter((slice) => slice.deleted > 0).length,
      verificationSlices: slices.filter((slice) => slice.verified > 0).length,
      pageLatencyMs: distribution(pageDurations),
      readLatencyMs: distribution(readDurations),
      scanned: totalScanned,
      deleted: totalDeleted,
      verified: totalVerified,
      failed: totalFailed,
      heartbeatGapMs: round(maximumPageMs),
      leaseDurationMs,
      leaseExpiredDuringPage: maximumPageMs > leaseDurationMs,
      retryCount: status?.retryCount ?? 0,
      finalState: status?.state ?? null
    },
    resources: {
      processCpuUserMs: round(cpu.user / 1_000),
      processCpuSystemMs: round(cpu.system / 1_000),
      rssBeforeMb: round(rssBeforeBytes / 1024 / 1024),
      peakRssMb: round(peakRssBytes / 1024 / 1024),
      rssGrowthMb: round((peakRssBytes - rssBeforeBytes) / 1024 / 1024),
      databaseCpu: "not available in the portable local harness",
      databaseStats: subtractDatabaseStats(databaseStatsAfter, databaseStatsBefore)
    },
    readTraffic: {
      baseline: baselineReadTraffic,
      concurrent: concurrentReadTraffic,
      p95RegressionPercent: {
        admin: regressionPercent(
          baselineReadTraffic.adminLatencyMs.p95,
          concurrentReadTraffic.adminLatencyMs.p95
        ),
        developerOpenApi: regressionPercent(
          baselineReadTraffic.developerOpenApiLatencyMs.p95,
          concurrentReadTraffic.developerOpenApiLatencyMs.p95
        ),
        combined: regressionPercent(
          baselineReadTraffic.combinedLatencyMs.p95,
          concurrentReadTraffic.combinedLatencyMs.p95
        )
      }
    },
    preparation
  };
}

async function measureHttpReadTrafficForDuration(
  readTraffic: HttpReadTrafficHarness,
  durationMs: number
): Promise<HttpReadSample[]> {
  const samples: HttpReadSample[] = [];
  const deadline = performance.now() + durationMs;
  do {
    samples.push(...await readTraffic.measureRound());
    const remainingMs = deadline - performance.now();
    if (remainingMs > 0) {
      await delay(Math.min(HTTP_READ_INTERVAL_MS, remainingMs));
    }
  } while (performance.now() < deadline);
  return samples;
}

async function collectHttpReadTrafficWhile(
  readTraffic: HttpReadTrafficHarness,
  shouldContinue: () => boolean
): Promise<HttpReadSample[]> {
  const samples: HttpReadSample[] = [];
  while (shouldContinue()) {
    samples.push(...await readTraffic.measureRound());
    await delay(HTTP_READ_INTERVAL_MS);
  }
  return samples;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => {
    setTimeout(resolveDelay, milliseconds);
  });
}

async function prepareObjectProtection(
  database: Sql,
  fixture: FixtureCounts
): Promise<BenchmarkReport["preparation"]> {
  const repository = createPostgresObjectProtectionRepository(database);
  const startedAt = performance.now();
  let clock = new Date("2090-07-26T00:00:00.000Z");
  let slices = 0;
  const maximumSlices = Math.ceil(
    (
      fixture.storageObjects
      + fixture.missingRegistered
      + fixture.projectionProtected
      + fixture.projectionUnreferenced
    ) / PAGE_SIZE
  ) * 8 + 32;

  while (slices < maximumSlices) {
    const result = await runObjectProtectionMaintenanceSlice({
      repository,
      batchSize: PAGE_SIZE,
      leaseToken: "benchmark-object-protection",
      now: () => clock
    });
    slices += 1;
    clock = new Date(clock.getTime() + 1_000);
    if (result.failed) {
      throw new Error("Optimized benchmark object protection preparation failed");
    }
    if (result.completed) {
      return {
        objectProtectionDurationMs: round(performance.now() - startedAt),
        objectProtectionSlices: slices,
        objectProtectionReady: true
      };
    }
  }

  throw new Error("Optimized benchmark object protection preparation did not converge");
}

async function measureConcurrentRead(database: Sql): Promise<number> {
  const startedAt = performance.now();
  await database`
    SELECT id, name, active_generation_id
    FROM focowiki.knowledge_bases
    WHERE id = ${KNOWLEDGE_BASE_ID}
    LIMIT 1
  `;
  return performance.now() - startedAt;
}

async function createHttpReadTrafficHarness(): Promise<HttpReadTrafficHarness> {
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) {
    throw new Error("REDIS_URL is required for HTTP read-traffic evidence");
  }
  const redisKeyPrefix =
    `focowiki-reconciliation-evidence-${process.pid}-${randomUUID().slice(0, 8)}`;
  const workerPath = fileURLToPath(
    new URL("./storage-reconciliation-http-evidence-worker.ts", import.meta.url)
  );
  const worker = fork(workerPath, [], {
    execArgv: ["--import", "tsx"],
    env: {
      ...process.env,
      EVIDENCE_DATABASE_URL: databaseConnectionUrl(sourceDatabaseUrl, databaseName),
      EVIDENCE_REDIS_URL: redisUrl,
      EVIDENCE_REDIS_KEY_PREFIX: redisKeyPrefix,
      EVIDENCE_STORAGE_PREFIX: STORAGE_PREFIX
    },
    stdio: ["ignore", "ignore", "inherit", "ipc"]
  });
  let requestSequence = 0;
  await waitForEvidenceWorkerReady(worker);

  return {
    async measureRound() {
      requestSequence += 1;
      return requestEvidenceWorkerRound(worker, requestSequence);
    },
    async close() {
      await closeEvidenceWorker(worker);
    }
  };
}

function waitForEvidenceWorkerReady(worker: ChildProcess): Promise<void> {
  return new Promise((resolveReady, rejectReady) => {
    const timer = setTimeout(() => {
      cleanup();
      rejectReady(new Error("HTTP evidence worker startup timed out"));
    }, 30_000);
    const onMessage = (message: unknown) => {
      if (!isWorkerMessage(message)) return;
      if (message.type === "ready") {
        cleanup();
        resolveReady();
      } else if (message.type === "error") {
        cleanup();
        rejectReady(new Error(message.message));
      }
    };
    const onExit = (code: number | null) => {
      cleanup();
      rejectReady(new Error(`HTTP evidence worker exited during startup (${code ?? "unknown"})`));
    };
    const cleanup = () => {
      clearTimeout(timer);
      worker.off("message", onMessage);
      worker.off("exit", onExit);
    };
    worker.on("message", onMessage);
    worker.once("exit", onExit);
  });
}

function requestEvidenceWorkerRound(
  worker: ChildProcess,
  requestId: number
): Promise<HttpReadSample[]> {
  return new Promise((resolveRound, rejectRound) => {
    const timer = setTimeout(() => {
      cleanup();
      rejectRound(new Error("HTTP evidence worker round timed out"));
    }, 30_000);
    const onMessage = (message: unknown) => {
      if (!isWorkerMessage(message) || message.requestId !== requestId) return;
      cleanup();
      if (message.type === "round") {
        resolveRound(message.samples);
      } else if (message.type === "error") {
        rejectRound(new Error(message.message));
      }
    };
    const onExit = (code: number | null) => {
      cleanup();
      rejectRound(new Error(`HTTP evidence worker exited during a round (${code ?? "unknown"})`));
    };
    const cleanup = () => {
      clearTimeout(timer);
      worker.off("message", onMessage);
      worker.off("exit", onExit);
    };
    worker.on("message", onMessage);
    worker.once("exit", onExit);
    worker.send({ type: "measure", requestId });
  });
}

function closeEvidenceWorker(worker: ChildProcess): Promise<void> {
  if (worker.exitCode !== null || worker.signalCode !== null) return Promise.resolve();
  return new Promise((resolveClose) => {
    const timer = setTimeout(() => {
      worker.kill();
      resolveClose();
    }, 5_000);
    worker.once("exit", () => {
      clearTimeout(timer);
      resolveClose();
    });
    worker.send({ type: "close" });
  });
}

function isWorkerMessage(value: unknown): value is
  | { type: "ready" }
  | { type: "round"; requestId: number; samples: HttpReadSample[] }
  | { type: "error"; requestId?: number; message: string } {
  return typeof value === "object" && value !== null && "type" in value;
}

function summarizeHttpReadSamples(samples: HttpReadSample[]): HttpReadEvidence {
  const admin = samples
    .filter((sample) => sample.plane === "admin")
    .map((sample) => sample.durationMs);
  const developerOpenApi = samples
    .filter((sample) => sample.plane === "developerOpenApi")
    .map((sample) => sample.durationMs);
  const errorCount = samples.filter((sample) => !sample.ok).length;
  return {
    requestCount: samples.length,
    errorCount,
    errorRatePercent: round(samples.length > 0 ? errorCount / samples.length * 100 : 0),
    adminLatencyMs: distribution(admin),
    developerOpenApiLatencyMs: distribution(developerOpenApi),
    combinedLatencyMs: distribution(samples.map((sample) => sample.durationMs))
  };
}

function regressionPercent(baseline: number, measured: number): number {
  if (baseline <= 0) return measured <= 0 ? 0 : 100;
  return round((measured - baseline) / baseline * 100);
}

class BenchmarkStorage implements StorageAdapter {
  public readonly keyspace = createStorageKeyspace(STORAGE_PREFIX);

  public constructor(private readonly objectCount: number) {}

  public async putObject(): Promise<void> {
    throw new Error("Benchmark storage is read-only");
  }

  public async getObjectText(key: string): Promise<string | null> {
    return key === READ_OBJECT_KEY
      ? "# Storage reconciliation benchmark\n\nRepresentative generated content."
      : null;
  }

  public async listObjectMetadata(input: {
    prefix: string;
    continuationToken?: string | null;
    limit: number;
  }) {
    const offset = Number(input.continuationToken ?? "0");
    const end = Math.min(this.objectCount, offset + input.limit);
    return {
      objects: createStoragePage(offset, end, input.prefix),
      nextContinuationToken: end < this.objectCount ? String(end) : null
    };
  }

  public async headObjectMetadata(key: string): Promise<StorageObjectMetadata | null> {
    const checksumSha256 = key.split("/").at(-1);
    if (!checksumSha256) return null;
    const index = Number.parseInt(checksumSha256, 16);
    if (!Number.isSafeInteger(index) || index < 0 || index >= this.objectCount) return null;
    return storageMetadata(key, index);
  }

  public async deleteObjects(): Promise<void> {}
}

function createStoragePage(
  start: number,
  end: number,
  prefix: string
) {
  return Array.from({ length: end - start }, (_, pageIndex) => {
    const index = start + pageIndex;
    const checksumSha256 = index.toString(16).padStart(64, "0");
    return {
      ...storageMetadata(
        `${prefix}v1/objects/${checksumSha256.slice(0, 2)}/${checksumSha256}`,
        index
      ),
      checksumSha256,
      formatVersion: 1
    };
  });
}

function storageMetadata(key: string, index: number): StorageObjectMetadata {
  return {
    key,
    contentType: "application/json",
    sizeBytes: index + 1,
    etag: `etag-${index}`,
    lastModified: "2026-07-01T00:00:00.000Z",
    metadata: {}
  };
}

function buildFixtureCounts(storageObjects: number): FixtureCounts {
  const percent = (value: number) => Math.floor(storageObjects * value / 100);
  const activeReferenced = percent(25);
  const retainedReferenced = percent(20);
  const writeReserved = percent(15);
  const projectionProtected = percent(20);
  const projectionUnreferenced = percent(10);
  const orphan =
    storageObjects - activeReferenced - retainedReferenced - writeReserved
    - projectionProtected - projectionUnreferenced;
  return {
    storageObjects,
    activeReferenced,
    retainedReferenced,
    writeReserved,
    projectionProtected,
    projectionUnreferenced,
    orphan,
    missingRegistered: percent(5),
    preconfirmedCandidates: Math.min(PRECONFIRMED_CANDIDATE_LIMIT, orphan)
  };
}

async function readDatabaseStats(database: Sql): Promise<DatabaseStats> {
  const rows = await database<Array<{
    xact_commit: number;
    blks_read: number;
    blks_hit: number;
    tup_returned: number;
    tup_fetched: number;
    tup_inserted: number;
    tup_updated: number;
    tup_deleted: number;
    temp_files: number;
    temp_bytes: number;
    deadlocks: number;
  }>>`
    SELECT
      xact_commit, blks_read, blks_hit, tup_returned, tup_fetched,
      tup_inserted, tup_updated, tup_deleted, temp_files, temp_bytes, deadlocks
    FROM pg_stat_database
    WHERE datname = current_database()
  `;
  const row = rows[0]!;
  return {
    xactCommit: Number(row.xact_commit),
    blocksRead: Number(row.blks_read),
    blocksHit: Number(row.blks_hit),
    tuplesReturned: Number(row.tup_returned),
    tuplesFetched: Number(row.tup_fetched),
    tuplesInserted: Number(row.tup_inserted),
    tuplesUpdated: Number(row.tup_updated),
    tuplesDeleted: Number(row.tup_deleted),
    temporaryFiles: Number(row.temp_files),
    temporaryBytes: Number(row.temp_bytes),
    deadlocks: Number(row.deadlocks)
  };
}

function subtractDatabaseStats(
  after: DatabaseStats,
  before: DatabaseStats
): DatabaseStats {
  return Object.fromEntries(
    Object.entries(after).map(([key, value]) => [
      key,
      value - before[key as keyof DatabaseStats]
    ])
  ) as DatabaseStats;
}

function distribution(values: number[]): Distribution {
  if (values.length === 0) {
    return { minimum: 0, median: 0, p95: 0, maximum: 0 };
  }
  const sorted = [...values].sort((left, right) => left - right);
  return {
    minimum: round(sorted[0]!),
    median: round(percentile(sorted, 0.5)),
    p95: round(percentile(sorted, 0.95)),
    maximum: round(sorted.at(-1)!)
  };
}

function percentile(sorted: number[], ratio: number): number {
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1);
  return sorted[Math.max(0, index)]!;
}

function readArguments(input: string[]): {
  objects: number;
  label: string;
  implementation: "baseline" | "optimized";
} {
  const values = new Map(
    input.map((argument) => {
      const [key, value = ""] = argument.replace(/^--/u, "").split("=", 2);
      return [key, value];
    })
  );
  const objects = Number(values.get("objects") ?? "10000");
  if (!Number.isSafeInteger(objects) || objects < 1_000 || objects > 100_000) {
    throw new Error("objects must be an integer between 1000 and 100000");
  }
  const implementation = values.get("implementation") === "optimized"
    ? "optimized"
    : "baseline";
  const label = values.get("label") || `${implementation}-${objects}`;
  if (!/^[a-z0-9-]+$/u.test(label)) {
    throw new Error("label must contain lowercase letters, numbers, and hyphens");
  }
  return { objects, label, implementation };
}

function loadLocalEnvironment(): void {
  const envPath = resolve(process.cwd(), "../../.env");
  if (!existsSync(envPath)) return;
  try {
    loadEnvFile(envPath);
  } catch {
    // Explicit environment variables remain supported in CI.
  }
}

function readDatabaseUrl(): string {
  const explicit = process.env.FOCOWIKI_TEST_DATABASE_URL ?? process.env.DATABASE_URL;
  if (explicit) return explicit;
  const user = process.env.POSTGRES_USER;
  const password = process.env.POSTGRES_PASSWORD;
  const database = process.env.POSTGRES_DB;
  const port = process.env.POSTGRES_HOST_PORT ?? "55432";
  if (!user || !password || !database) {
    throw new Error("PostgreSQL benchmark configuration is incomplete");
  }
  return `postgres://${encodeURIComponent(user)}:${encodeURIComponent(password)}@127.0.0.1:${port}/${encodeURIComponent(database)}`;
}

function databaseConnectionUrl(connectionUrl: string, database: string): string {
  const url = new URL(connectionUrl);
  url.pathname = `/${database}`;
  return url.toString();
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll("\"", "\"\"")}"`;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

await main();
