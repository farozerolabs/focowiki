import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { loadEnvFile } from "node:process";
import postgres from "postgres";
import { applyMigrations } from "../src/db/migrations.js";
import {
  buildExplainAnalyzeSql,
  summarizeQueryPlan,
  type QueryPlanSummary
} from "../src/db/query-plan-validation.js";
import { createPostgresStorageReconciliationRepository } from "../src/infrastructure/postgres/storage-reconciliation-repository.js";
import { runStorageReconciliationSlice } from "../src/maintenance/storage-reconciliation.js";
import { createStorageKeyspace } from "../src/storage/keys.js";
import type { StorageAdapter, StorageObjectMetadata } from "../src/storage/s3.js";

const KNOWLEDGE_BASE_ID = "kb-tree-storage-scale";
const GENERATION_ID = "generation-tree-storage-scale";
const DIRECTORY_COUNT = 1_000;
const FILE_COUNT = 100_000;
const GENERATED_FILE_COUNT = 10_000;
const RECONCILIATION_OBJECT_COUNT = 100_000;
const RECONCILIATION_PAGE_SIZE = 1_000;
const DELETION_SAMPLE_SIZE = 1_000;
const STORAGE_PREFIX = "scale-evidence";
const reportDirectory = resolve(
  process.cwd(),
  "../../openspec/changes/repair-tree-graph-contract-and-storage-reconciliation/evidence"
);

loadLocalEnvironment();
const sourceDatabaseUrl = readDatabaseUrl();
const databaseName = `focowiki_scale_${process.pid}_${randomUUID().replaceAll("-", "").slice(0, 10)}`;
const admin = postgres(databaseConnectionUrl(sourceDatabaseUrl, "postgres"), { max: 1 });
const sql = postgres(databaseConnectionUrl(sourceDatabaseUrl, databaseName), { max: 4 });

async function main(): Promise<void> {
  try {
    await admin.unsafe(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
    await applyMigrations(sql);
    await seedTreeFixture();
    const reconciliation = await measureReconciliation();
    const queryPlans = await measureQueryPlans();
    const report = {
      kind: "tree-storage-reconciliation-scale-evidence",
      generatedAt: new Date().toISOString(),
      fixture: {
        treeRecords: FILE_COUNT + DIRECTORY_COUNT + 1,
        sourceDirectories: DIRECTORY_COUNT + 1,
        generatedFileReferences: GENERATED_FILE_COUNT,
        managedStorageKeys: RECONCILIATION_OBJECT_COUNT,
        database: "temporary PostgreSQL database",
        storage: "bounded deterministic metadata adapter"
      },
      queryPlans,
      reconciliation,
      acceptance: evaluateAcceptance(queryPlans, reconciliation)
    };
    await mkdir(reportDirectory, { recursive: true });
    await writeFile(
      resolve(reportDirectory, "tree-storage-scale-evidence.json"),
      `${JSON.stringify(report, null, 2)}\n`,
      "utf8"
    );
    await writeFile(
      resolve(reportDirectory, "tree-storage-scale-evidence.md"),
      renderMarkdown(report),
      "utf8"
    );
    console.log(JSON.stringify(report, null, 2));
    if (!report.acceptance.ok) process.exitCode = 1;
  } finally {
    await sql.end({ timeout: 5 }).catch(() => undefined);
    await admin.unsafe(`DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)} WITH (FORCE)`);
    await admin.end({ timeout: 5 });
  }
}

async function seedTreeFixture(): Promise<void> {
  const checksum = "f".repeat(64);
  await sql.begin(async (transaction) => {
    await transaction`
      INSERT INTO focowiki.knowledge_bases (id, name, description)
      VALUES (${KNOWLEDGE_BASE_ID}, 'Tree storage scale evidence', 'Domain-neutral scale fixture')
    `;
    await transaction`
      INSERT INTO focowiki.publication_generations (
        id, knowledge_base_id, state, generation_kind, activated_at
      ) VALUES (${GENERATION_ID}, ${KNOWLEDGE_BASE_ID}, 'active', 'normal', now())
    `;
    await transaction`
      UPDATE focowiki.knowledge_bases
      SET active_generation_id = ${GENERATION_ID}
      WHERE id = ${KNOWLEDGE_BASE_ID}
    `;
    await transaction`
      INSERT INTO focowiki.immutable_objects (
        checksum_sha256, format_version, object_key, content_type,
        size_bytes, lifecycle_state, verified_at
      ) VALUES (
        ${checksum}, 1, 'scale-evidence/shared/generated.json',
        'application/json', 16, 'active', now()
      )
    `;
    await transaction`
      INSERT INTO focowiki.active_projection_records (
        knowledge_base_id, projection_kind, record_id,
        last_changed_generation_id, shard_key, logical_path,
        parent_path, sort_key, title, searchable_text, payload_json
      ) VALUES (
        ${KNOWLEDGE_BASE_ID}, 'tree', 'directory:pages',
        ${GENERATION_ID}, 'tree/v1/0000', 'pages', '', '0:pages',
        'pages', 'pages',
        ${transaction.json({ kind: "directory", path: "pages", parentPath: "" })}
      )
    `;
    await transaction`
      INSERT INTO focowiki.active_projection_records (
        knowledge_base_id, projection_kind, record_id,
        last_changed_generation_id, shard_key, logical_path,
        parent_path, sort_key, title, searchable_text, payload_json
      )
      SELECT
        ${KNOWLEDGE_BASE_ID}, 'tree',
        'directory:pages/group-' || lpad(value::text, 4, '0'),
        ${GENERATION_ID}, 'tree/v1/' || lpad((value % 64)::text, 4, '0'),
        'pages/group-' || lpad(value::text, 4, '0'), 'pages',
        '0:group-' || lpad(value::text, 4, '0'),
        'group-' || lpad(value::text, 4, '0'),
        'group-' || lpad(value::text, 4, '0'),
        jsonb_build_object(
          'kind', 'directory',
          'path', 'pages/group-' || lpad(value::text, 4, '0'),
          'parentPath', 'pages'
        )
      FROM generate_series(0, ${DIRECTORY_COUNT - 1}) AS value
    `;
    await transaction`
      INSERT INTO focowiki.active_projection_records (
        knowledge_base_id, projection_kind, record_id,
        last_changed_generation_id, shard_key, logical_path,
        parent_path, sort_key, title, searchable_text, payload_json
      )
      SELECT
        ${KNOWLEDGE_BASE_ID}, 'tree',
        'file-scale-' || lpad(value::text, 6, '0'),
        ${GENERATION_ID}, 'tree/v1/' || lpad((value % 64)::text, 4, '0'),
        'pages/group-' || lpad(((value - 1) / 100)::text, 4, '0') ||
          '/document-' || lpad(value::text, 6, '0') || '.md',
        'pages/group-' || lpad(((value - 1) / 100)::text, 4, '0'),
        '1:document-' || lpad(value::text, 6, '0'),
        'Document ' || lpad(value::text, 6, '0'),
        'Document ' || lpad(value::text, 6, '0'),
        jsonb_build_object(
          'kind', 'file',
          'fileId', 'file-scale-' || lpad(value::text, 6, '0'),
          'path', 'pages/group-' || lpad(((value - 1) / 100)::text, 4, '0') ||
            '/document-' || lpad(value::text, 6, '0') || '.md'
        )
      FROM generate_series(1, ${FILE_COUNT}) AS value
    `;
    await transaction`
      INSERT INTO focowiki.generation_tree_directory_stats (
        knowledge_base_id, generation_id, path, parent_path,
        direct_entry_count, direct_directory_count,
        direct_file_count, descendant_file_count
      ) VALUES (
        ${KNOWLEDGE_BASE_ID}, ${GENERATION_ID}, 'pages', '',
        ${DIRECTORY_COUNT}, ${DIRECTORY_COUNT}, 0, ${FILE_COUNT}
      )
    `;
    await transaction`
      INSERT INTO focowiki.generation_tree_directory_stats (
        knowledge_base_id, generation_id, path, parent_path,
        direct_entry_count, direct_directory_count,
        direct_file_count, descendant_file_count
      )
      SELECT ${KNOWLEDGE_BASE_ID}, ${GENERATION_ID},
             'pages/group-' || lpad(value::text, 4, '0'), 'pages',
             100, 0, 100, 100
      FROM generate_series(0, ${DIRECTORY_COUNT - 2}) AS value
    `;
    await transaction`
      INSERT INTO focowiki.active_object_refs (
        knowledge_base_id, ref_kind, ref_key, file_id,
        last_changed_generation_id, checksum_sha256, format_version, logical_path
      )
      SELECT ${KNOWLEDGE_BASE_ID}, 'graph_file',
             'graph-scale-' || lpad(value::text, 6, '0'),
             'graph-file-scale-' || lpad(value::text, 6, '0'),
             ${GENERATION_ID}, ${checksum}, 1,
             '_graph/by-file/document-' || lpad(value::text, 6, '0') || '.json'
      FROM generate_series(1, ${GENERATED_FILE_COUNT}) AS value
    `;
  });
  await sql.unsafe("ANALYZE focowiki.active_projection_records");
  await sql.unsafe("ANALYZE focowiki.active_object_refs");
  await sql.unsafe("ANALYZE focowiki.generation_tree_directory_stats");
}

async function measureQueryPlans(): Promise<Record<string, QueryPlanSummary>> {
  const cases: Record<string, string> = {
    rootFirstPage: `
      SELECT record_id, logical_path, payload_json
      FROM focowiki.active_projection_records
      WHERE knowledge_base_id = '${KNOWLEDGE_BASE_ID}'
        AND projection_kind = 'tree' AND parent_path = 'pages'
      ORDER BY sort_key, record_id LIMIT 51
    `,
    rootNextPage: `
      SELECT record_id, logical_path, payload_json
      FROM focowiki.active_projection_records
      WHERE knowledge_base_id = '${KNOWLEDGE_BASE_ID}'
        AND projection_kind = 'tree' AND parent_path = 'pages'
        AND (sort_key, record_id) > ('0:group-0049', 'directory:pages/group-0049')
      ORDER BY sort_key, record_id LIMIT 51
    `,
    nestedFirstPage: `
      SELECT record_id, logical_path, payload_json
      FROM focowiki.active_projection_records
      WHERE knowledge_base_id = '${KNOWLEDGE_BASE_ID}'
        AND projection_kind = 'tree' AND parent_path = 'pages/group-0050'
      ORDER BY sort_key, record_id LIMIT 51
    `,
    nestedNextPage: `
      SELECT record_id, logical_path, payload_json
      FROM focowiki.active_projection_records
      WHERE knowledge_base_id = '${KNOWLEDGE_BASE_ID}'
        AND projection_kind = 'tree' AND parent_path = 'pages/group-0050'
        AND (sort_key, record_id) > ('1:document-005050', 'file-scale-005050')
      ORDER BY sort_key, record_id LIMIT 51
    `,
    syntheticFirstPage: `
      SELECT file_id, logical_path
      FROM focowiki.active_object_refs
      WHERE knowledge_base_id = '${KNOWLEDGE_BASE_ID}'
        AND logical_path >= '_graph/by-file/' AND logical_path < '_graph/by-file0'
      ORDER BY logical_path LIMIT 51
    `,
    syntheticNextPage: `
      SELECT file_id, logical_path
      FROM focowiki.active_object_refs
      WHERE knowledge_base_id = '${KNOWLEDGE_BASE_ID}'
        AND logical_path >= '_graph/by-file/' AND logical_path < '_graph/by-file0'
        AND logical_path > '_graph/by-file/document-005000.json'
      ORDER BY logical_path LIMIT 51
    `,
    typedStatistics: `
      SELECT path, direct_entry_count, direct_directory_count,
             direct_file_count, descendant_file_count
      FROM focowiki.generation_tree_directory_stats
      WHERE knowledge_base_id = '${KNOWLEDGE_BASE_ID}'
        AND generation_id = '${GENERATION_ID}' AND parent_path = 'pages'
      ORDER BY path LIMIT 51
    `,
    legacyStatisticsFallback: `
      SELECT count(*) FILTER (WHERE payload_json->>'kind' = 'file')::int AS file_count
      FROM focowiki.active_projection_records
      WHERE knowledge_base_id = '${KNOWLEDGE_BASE_ID}'
        AND projection_kind = 'tree'
        AND logical_path >= 'pages/group-0999/'
        AND logical_path < 'pages/group-09990'
    `,
    reconciliationCandidatePage: `
      SELECT object_key
      FROM focowiki.storage_reconciliation_candidates
      WHERE prefix = '${STORAGE_PREFIX}/generated/'
        AND state IN ('quarantined', 'failed')
        AND last_seen_cycle_id = 'scale-cycle-second'
        AND first_seen_at <= '2026-07-20T00:00:00.000Z'
        AND confirmation_count >= 2
        AND attempt_count < 5
        AND next_attempt_at <= '2026-07-20T00:00:00.000Z'
      ORDER BY first_seen_at, object_key LIMIT 101
    `
  };
  const plans: Record<string, QueryPlanSummary> = {};
  for (const [name, query] of Object.entries(cases)) {
    const rows = await sql.unsafe<Array<{ "QUERY PLAN": unknown }>>(
      buildExplainAnalyzeSql(query)
    );
    plans[name] = summarizeQueryPlan(rows[0]?.["QUERY PLAN"]);
  }
  return plans;
}

async function measureReconciliation() {
  const repository = createPostgresStorageReconciliationRepository(sql);
  const storage = new ScaleStorage(RECONCILIATION_OBJECT_COUNT);
  const settings = {
    reconciliationEnabled: true,
    scanIntervalSeconds: 60,
    scanBatchSize: RECONCILIATION_PAGE_SIZE,
    deletionBatchSize: 100,
    quarantineGracePeriodSeconds: 1,
    confirmationPasses: 2,
    maxAttempts: 5,
    retryDelayMs: 1_000
  };
  let clock = new Date("2026-07-18T00:00:00.000Z");
  let leaseToken = "scale-lease-before-restart";
  let scanSlices = 0;
  let peakRssBytes = process.memoryUsage().rss;
  const rssBefore = peakRssBytes;
  const scanStartedAt = performance.now();

  while (scanSlices < RECONCILIATION_OBJECT_COUNT / RECONCILIATION_PAGE_SIZE) {
    const result = await runStorageReconciliationSlice({
      repository,
      storage,
      settings,
      versionPurgeEnabled: false,
      now: () => clock,
      leaseToken,
      cycleId: "scale-cycle-first"
    });
    if (!result.claimed || result.phase !== "scanning") {
      throw new Error(`Unexpected reconciliation scan state: ${result.phase}`);
    }
    scanSlices += 1;
    peakRssBytes = Math.max(peakRssBytes, process.memoryUsage().rss);
    if (scanSlices === 50) {
      clock = new Date(clock.getTime() + 6 * 60_000);
      leaseToken = "scale-lease-after-restart";
    }
  }
  const firstScanDurationMs = performance.now() - scanStartedAt;
  await runStorageReconciliationSlice({
    repository,
    storage,
    settings,
    versionPurgeEnabled: false,
    now: () => clock,
    leaseToken,
    cycleId: "scale-cycle-first"
  });

  clock = new Date(clock.getTime() + 2 * 24 * 60 * 60_000);
  leaseToken = "scale-lease-confirmation";
  for (let index = 0; index < RECONCILIATION_OBJECT_COUNT / RECONCILIATION_PAGE_SIZE; index += 1) {
    const result = await runStorageReconciliationSlice({
      repository,
      storage,
      settings,
      versionPurgeEnabled: false,
      now: () => clock,
      leaseToken,
      cycleId: "scale-cycle-second"
    });
    if (!result.claimed || result.phase !== "scanning") {
      throw new Error(`Unexpected confirmation scan state: ${result.phase}`);
    }
    peakRssBytes = Math.max(peakRssBytes, process.memoryUsage().rss);
  }

  await sql.unsafe("ANALYZE focowiki.storage_reconciliation_candidates");
  const deletionStartedAt = performance.now();
  let deleted = 0;
  while (deleted < DELETION_SAMPLE_SIZE) {
    const result = await runStorageReconciliationSlice({
      repository,
      storage,
      settings,
      versionPurgeEnabled: false,
      now: () => clock,
      leaseToken,
      cycleId: "scale-cycle-second"
    });
    if (!result.claimed || result.phase !== "deleting") {
      throw new Error(`Unexpected reconciliation deletion state: ${result.phase}`);
    }
    deleted += result.deleted;
    peakRssBytes = Math.max(peakRssBytes, process.memoryUsage().rss);
  }
  const deletionDurationMs = performance.now() - deletionStartedAt;
  const persisted = await sql<Array<{
    candidates: number;
    listed_count: number;
    deleted_count: number;
    continuation_token: string | null;
  }>>`
    SELECT
      (SELECT count(*)::int FROM focowiki.storage_reconciliation_candidates
       WHERE prefix = ${`${STORAGE_PREFIX}/generated/`}) AS candidates,
      listed_count::int, deleted_count::int, continuation_token
    FROM focowiki.storage_reconciliation_cycles
    WHERE prefix = ${`${STORAGE_PREFIX}/generated/`}
  `;
  return {
    firstPassScanned: RECONCILIATION_OBJECT_COUNT,
    scanPageSize: RECONCILIATION_PAGE_SIZE,
    scanSlices,
    cursorRecoveryAtObject: 50_000,
    cursorRecovered: scanSlices === 100,
    firstScanDurationMs: round(firstScanDurationMs),
    firstScanThroughputPerSecond: round(RECONCILIATION_OBJECT_COUNT / (firstScanDurationMs / 1_000)),
    deletionSampleSize: deleted,
    deletionDurationMs: round(deletionDurationMs),
    deletionThroughputPerSecond: round(deleted / (deletionDurationMs / 1_000)),
    rssBeforeMb: round(rssBefore / 1024 / 1024),
    peakRssMb: round(peakRssBytes / 1024 / 1024),
    rssGrowthMb: round((peakRssBytes - rssBefore) / 1024 / 1024),
    storageDeleteCalls: storage.deleteCalls,
    persisted: persisted[0]
  };
}

class ScaleStorage implements StorageAdapter {
  public readonly keyspace = createStorageKeyspace(STORAGE_PREFIX);
  public deleteCalls = 0;

  public constructor(private readonly objectCount: number) {}

  public async putObject(): Promise<void> {
    throw new Error("Scale storage is read-only");
  }

  public async getObjectText(): Promise<string | null> {
    return null;
  }

  public async listObjectMetadata(input: {
    prefix: string;
    continuationToken?: string | null;
    limit: number;
  }) {
    const offset = Number(input.continuationToken ?? "0");
    const end = Math.min(this.objectCount, offset + input.limit);
    return {
      objects: Array.from({ length: end - offset }, (_, pageIndex) => {
        const index = offset + pageIndex;
        const checksumSha256 = index.toString(16).padStart(64, "0");
        return {
          key: `${input.prefix}v1/objects/${checksumSha256.slice(0, 2)}/${checksumSha256}`,
          sizeBytes: index + 1,
          etag: `etag-${index}`,
          lastModified: "2026-07-01T00:00:00.000Z"
        };
      }),
      nextContinuationToken: end < this.objectCount ? String(end) : null
    };
  }

  public async headObjectMetadata(key: string): Promise<StorageObjectMetadata | null> {
    const checksumSha256 = key.split("/").at(-1);
    if (!checksumSha256) return null;
    const index = Number.parseInt(checksumSha256, 16);
    return {
      key,
      contentType: "application/json",
      sizeBytes: index + 1,
      etag: `etag-${index}`,
      lastModified: "2026-07-01T00:00:00.000Z",
      metadata: {}
    };
  }

  public async deleteObjects(keys: string[]): Promise<void> {
    this.deleteCalls += keys.length;
  }
}

function evaluateAcceptance(
  plans: Record<string, QueryPlanSummary>,
  reconciliation: Awaited<ReturnType<typeof measureReconciliation>>
) {
  const failures: string[] = [];
  for (const [name, plan] of Object.entries(plans)) {
    if ((plan.executionTimeMs ?? Number.POSITIVE_INFINITY) > 2_000) {
      failures.push(`${name} exceeded the 2000 ms query-plan budget.`);
    }
  }
  if (!reconciliation.cursorRecovered) failures.push("Reconciliation cursor recovery failed.");
  if (reconciliation.persisted?.candidates !== RECONCILIATION_OBJECT_COUNT) {
    failures.push("Reconciliation did not persist all managed candidates.");
  }
  if (reconciliation.deletionSampleSize !== DELETION_SAMPLE_SIZE) {
    failures.push("Reconciliation deletion sample was incomplete.");
  }
  if (reconciliation.rssGrowthMb > 256) {
    failures.push("Reconciliation process RSS growth exceeded 256 MiB.");
  }
  return { ok: failures.length === 0, failures };
}

function renderMarkdown(report: {
  generatedAt: string;
  fixture: Record<string, string | number>;
  queryPlans: Record<string, QueryPlanSummary>;
  reconciliation: Awaited<ReturnType<typeof measureReconciliation>>;
  acceptance: { ok: boolean; failures: string[] };
}): string {
  const planRows = Object.entries(report.queryPlans).map(([name, plan]) =>
    `| ${name} | ${plan.executionTimeMs ?? "n/a"} | ${plan.actualRows} | ${plan.sharedHitBlocks} | ${plan.sharedReadBlocks} | ${plan.indexNames.join(", ") || "none"} | ${plan.sequentialScanRelations.join(", ") || "none"} |`
  );
  return [
    "# Tree and storage reconciliation scale evidence",
    "",
    `Generated: ${report.generatedAt}`,
    "",
    `The isolated PostgreSQL fixture contains ${report.fixture.treeRecords} tree records and the reconciliation run pages through ${report.fixture.managedStorageKeys} managed storage keys without loading the corpus into process memory.`,
    "",
    "| Query | Execution ms | Plan rows | Buffer hits | Buffer reads | Indexes | Sequential scans |",
    "| --- | ---: | ---: | ---: | ---: | --- | --- |",
    ...planRows,
    "",
    "## Reconciliation",
    "",
    `- Scan throughput: ${report.reconciliation.firstScanThroughputPerSecond} objects/s across ${report.reconciliation.scanSlices} persisted pages.`,
    `- Cursor recovery: ${report.reconciliation.cursorRecovered ? "PASS" : "FAIL"} at object ${report.reconciliation.cursorRecoveryAtObject}.`,
    `- Deletion throughput: ${report.reconciliation.deletionThroughputPerSecond} objects/s for ${report.reconciliation.deletionSampleSize} confirmed objects.`,
    `- Process RSS: ${report.reconciliation.rssBeforeMb} MiB before, ${report.reconciliation.peakRssMb} MiB peak, ${report.reconciliation.rssGrowthMb} MiB growth.`,
    `- Persisted candidate rows: ${report.reconciliation.persisted?.candidates ?? 0}.`,
    "",
    `Acceptance: ${report.acceptance.ok ? "PASS" : "FAIL"}`,
    ...report.acceptance.failures.map((failure) => `- ${failure}`),
    ""
  ].join("\n");
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
  const databaseUrl = process.env.FOCOWIKI_TEST_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("PostgreSQL test configuration is incomplete");
  return databaseUrl;
}

function databaseConnectionUrl(connectionUrl: string, databaseName: string): string {
  const url = new URL(connectionUrl);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

await main();
