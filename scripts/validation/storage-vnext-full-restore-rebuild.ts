import { writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { loadEnvFile } from "node:process";
import { pathToFileURL } from "node:url";
import { loadRuntimeConfig } from "../../apps/api/src/config.js";
import { createMeilisearchTransport } from
  "../../apps/api/src/infrastructure/meilisearch/meilisearch-transport.js";
import { createPostgresStorageVnextCatalogRepository } from
  "../../apps/api/src/storage-vnext/catalog/postgres-repository.js";
import { createS3StorageVnextSourceBodyStore } from
  "../../apps/api/src/storage-vnext/catalog/s3-source-body-store.js";
import { createPostgresStorageVnextGraphRepository } from
  "../../apps/api/src/storage-vnext/graph/postgres-repository.js";
import { createStorageVnextMaintenanceSearchRebuild } from
  "../../apps/api/src/storage-vnext/maintenance/search-rebuild.js";
import {
  resolveFullRestoreRebuildPlan,
  type StorageVnextFullRestoreProjection as ProjectionRow,
  type StorageVnextFullRestoreSearchSettings as SearchSettings
} from "../../apps/api/src/storage-vnext/maintenance/full-restore-rebuild-plan.js";
import { createStorageVnextSearchSettings } from
  "../../apps/api/src/storage-vnext/search/settings.js";

const apiRequire = createRequire(resolve(import.meta.dirname, "../../apps/api/package.json"));
const postgres = apiRequire("postgres");
const { S3Client } = apiRequire("@aws-sdk/client-s3");
const RUN_ID_PATTERN = /^[a-z0-9][a-z0-9-]{2,64}$/u;

async function main(): Promise<void> {
  const args = parseArguments(process.argv.slice(2));
  loadEnvFile(resolve(args.envFile));
  assertMeilisearchValidationProvider(requiredEnvironment("SEARCH_PROVIDER"));
  assertLocalEndpoint(requiredEnvironment("DATABASE_URL"), "DATABASE_URL");
  assertLocalEndpoint(requiredEnvironment("S3_ENDPOINT"), "S3_ENDPOINT");
  const meilisearchEndpoint = normalizeMeilisearchEndpoint(
    requiredEnvironment("MEILI_HOST")
  );
  assertLocalEndpoint(meilisearchEndpoint, "MEILI_HOST");
  const config = loadRuntimeConfig(process.env);
  const sql = postgres(requiredEnvironment("DATABASE_URL"), {
    max: 2,
    idle_timeout: 5,
    connect_timeout: 10
  });
  const s3 = new S3Client({
    endpoint: requiredEnvironment("S3_ENDPOINT"),
    region: requiredEnvironment("S3_REGION"),
    credentials: {
      accessKeyId: requiredEnvironment("S3_ACCESS_KEY_ID"),
      secretAccessKey: requiredEnvironment("S3_SECRET_ACCESS_KEY")
    },
    forcePathStyle: requiredBoolean("S3_FORCE_PATH_STYLE")
  });
  const transport = createMeilisearchTransport({
    endpoint: meilisearchEndpoint,
    apiKey: requiredEnvironment("MEILI_MASTER_KEY"),
    metricsApiKey: requiredEnvironment("MEILI_MASTER_KEY"),
    timeoutMs: 10_000,
    maxAttempts: 3,
    retryDelayMs: 100
  });

  try {
    const [projectionRows, countRows, settingRows] = await Promise.all([
      sql<ProjectionRow[]>`
        SELECT projection.knowledge_base_id AS "knowledgeBaseId",
               projection.projection_role AS "projectionRole",
               projection.state,
               projection.provider_index_uid AS "providerIndexUid",
               projection.document_count AS "documentCount"
        FROM focowiki.active_snapshots AS snapshot
        JOIN focowiki.search_projections AS projection
          ON projection.knowledge_base_id = snapshot.knowledge_base_id
         AND projection.public_id = snapshot.search_projection_public_id
        WHERE snapshot.knowledge_base_id = ${args.knowledgeBaseId}
      `,
      sql<Array<{ sourceCount: string; graphNodeCount: string }>>`
        SELECT
          (SELECT count(*)::text
           FROM focowiki.source_files source
           JOIN focowiki.source_file_current_revisions current_revision
             ON current_revision.knowledge_base_id = source.knowledge_base_id
            AND current_revision.source_file_public_id = source.public_id
           WHERE source.knowledge_base_id = ${args.knowledgeBaseId}
             AND source.deleted_at IS NULL
             AND source.status = 'ready') AS "sourceCount",
          (SELECT count(*)::text
           FROM focowiki.graph_nodes node
           JOIN focowiki.source_file_current_revisions current_revision
             ON current_revision.knowledge_base_id = node.knowledge_base_id
            AND current_revision.source_file_public_id = node.source_file_public_id
            AND current_revision.source_revision_public_id = node.source_revision_public_id
           JOIN focowiki.source_files source
             ON source.knowledge_base_id = node.knowledge_base_id
            AND source.public_id = node.source_file_public_id
           WHERE node.knowledge_base_id = ${args.knowledgeBaseId}
             AND source.deleted_at IS NULL
             AND source.status = 'ready') AS "graphNodeCount"
      `,
      sql<Array<{ settingsValues: { search?: Partial<SearchSettings> } }>>`
        SELECT revision.settings_values->'sections' AS "settingsValues"
        FROM focowiki.runtime_setting_current AS current_setting
        JOIN focowiki.runtime_setting_revisions AS revision
          ON revision.public_id = current_setting.revision_public_id
        WHERE current_setting.singleton = true
      `
    ]);
    const counts = countRows[0];
    const settings = settingRows[0]?.settingsValues;
    if (!counts || !settings) throw new Error("Full restore authority is incomplete");
    const plan = resolveFullRestoreRebuildPlan({
      expectedKnowledgeBaseId: args.knowledgeBaseId,
      expectedIndexPrefix: requiredEnvironment("SEARCH_INDEX_PREFIX"),
      projections: projectionRows,
      sourceCount: counts.sourceCount,
      graphNodeCount: counts.graphNodeCount,
      settings,
      maximumSourceBytes: config.pagination.generatedContentMaxBytes,
      pageSize: Math.min(1_000, config.pagination.maxPageSize)
    });
    if (await transport.getIndex({ indexUid: plan.providerIndexUid })) {
      throw new Error("Full restore Meilisearch target is not clean");
    }

    await waitForTask(
      transport,
      (await transport.createIndex({
        indexUid: plan.providerIndexUid,
        primaryKey: "id"
      })).taskUid,
      plan.search
    );
    await waitForTask(
      transport,
      (await transport.updateSettings({
        indexUid: plan.providerIndexUid,
        settings: createStorageVnextSearchSettings({
          searchCutoffMs: plan.search.engineSearchCutoffMs
        })
      })).taskUid,
      plan.search
    );

    let documentsWritten = 0;
    const rebuild = createStorageVnextMaintenanceSearchRebuild({
      catalog: createPostgresStorageVnextCatalogRepository(sql),
      sourceBodies: createS3StorageVnextSourceBodyStore({
        client: s3,
        bucket: requiredEnvironment("S3_BUCKET"),
        prefix: requiredEnvironment("S3_PREFIX")
      }),
      graph: createPostgresStorageVnextGraphRepository(sql),
      projection: {
        async writeDocumentBatch(input) {
          await waitForTask(
            transport,
            (await transport.addDocuments({
              indexUid: plan.providerIndexUid,
              primaryKey: "id",
              documents: [...input.documents],
              correlation: `${input.operationPublicId}-${input.batchOrdinal}`
            })).taskUid,
            plan.search
          );
          documentsWritten += input.documents.length;
        }
      },
      limits: {
        sourcePageSize: plan.pageSize,
        graphPageSize: plan.pageSize,
        maxSourceBytes: plan.maximumSourceBytes,
        maxSegmentBytes: plan.maximumSourceBytes,
        maxBatchDocuments: plan.search.indexBatchDocumentCount,
        maxBatchCompressedBytes: plan.search.indexBatchCompressedBytes
      }
    });
    let cursor: string | null = null;
    let batchOrdinal = 0;
    const maximumPages = Math.ceil(plan.sourceCount / plan.pageSize)
      + Math.ceil(plan.graphNodeCount / plan.pageSize)
      + 4;
    let completed = false;
    for (let page = 0; page < maximumPages; page += 1) {
      const result = await rebuild.runPage({
        knowledgeBaseId: plan.knowledgeBaseId,
        candidatePublicId: plan.providerIndexUid,
        operationPublicId: `full-restore-${args.runId}`,
        cursor,
        batchOrdinal
      });
      batchOrdinal += result.batchOrdinalDelta;
      if (result.outcome === "phase_completed") {
        completed = true;
        break;
      }
      cursor = result.cursor;
    }
    if (!completed) throw new Error("Full restore search rebuild did not converge");
    if (!transport.listDocuments) {
      throw new Error("Full restore Meilisearch document inspection is unavailable");
    }
    const documents = await transport.listDocuments({
      indexUid: plan.providerIndexUid,
      offset: 0,
      limit: 1,
      fields: ["id"]
    });
    if (
      documents.total !== plan.expectedDocumentCount
      || documentsWritten !== plan.expectedDocumentCount
    ) {
      throw new Error("Full restore search document count differs from restored authority");
    }

    const report = {
      kind: "focowiki-storage-vnext-full-restore-rebuild",
      version: 1,
      runId: args.runId,
      knowledgeBaseId: plan.knowledgeBaseId,
      indexCount: 1,
      documentCount: documents.total,
      sourceCount: plan.sourceCount,
      graphNodeCount: plan.graphNodeCount,
      batchCount: batchOrdinal,
      finishedAt: new Date().toISOString(),
      ok: true
    };
    await writeFile(resolve(args.evidencePath), `${JSON.stringify(report, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx"
    });
    process.stdout.write(`${JSON.stringify(report)}\n`);
  } finally {
    s3.destroy?.();
    await sql.end({ timeout: 5 });
  }
}

async function waitForTask(
  transport: ReturnType<typeof createMeilisearchTransport>,
  taskUid: number,
  settings: Pick<SearchSettings, "taskPollIntervalMs" | "taskTimeoutMs">
): Promise<void> {
  const deadline = Date.now() + settings.taskTimeoutMs;
  while (Date.now() < deadline) {
    const task = await transport.getTask(taskUid);
    if (task.status === "succeeded") return;
    if (task.status === "failed" || task.status === "canceled") {
      throw new Error("Full restore Meilisearch task failed");
    }
    await new Promise((resolvePromise) =>
      setTimeout(resolvePromise, settings.taskPollIntervalMs));
  }
  throw new Error("Full restore Meilisearch task timed out");
}

function parseArguments(argv: string[]) {
  const options: Record<string, string> = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || !value || value.startsWith("--")) {
      throw new Error(`Full restore rebuild option requires a value: ${key ?? "<missing>"}`);
    }
    options[key] = value;
  }
  const runId = options["--run-id"];
  const knowledgeBaseId = options["--knowledge-base-id"];
  const envFile = options["--env-file"];
  const evidencePath = options["--evidence"];
  if (!runId || !RUN_ID_PATTERN.test(runId)) {
    throw new Error("Full restore rebuild run ID is invalid");
  }
  if (!knowledgeBaseId || !envFile || !evidencePath) {
    throw new Error("Full restore rebuild identity and paths are required");
  }
  return { runId, knowledgeBaseId, envFile, evidencePath };
}

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required for full restore rebuild`);
  return value;
}

function assertMeilisearchValidationProvider(provider: string): void {
  if (provider !== "meilisearch") {
    throw new Error("Full restore rebuild requires SEARCH_PROVIDER=meilisearch");
  }
}

function requiredBoolean(name: string): boolean {
  const value = requiredEnvironment(name);
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`${name} must be true or false`);
}

function normalizeMeilisearchEndpoint(value: string): string {
  const url = new URL(value);
  if (url.hostname === "meilisearch") url.hostname = "127.0.0.1";
  if (url.port === "7700") url.port = process.env.MEILI_PORT ?? "57700";
  return url.toString().replace(/\/$/u, "");
}

function assertLocalEndpoint(value: string, name: string): void {
  const hostname = new URL(value).hostname;
  if (!["127.0.0.1", "localhost", "::1"].includes(hostname)) {
    throw new Error(`${name} must use an isolated loopback endpoint`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : "Full restore rebuild failed"}\n`
    );
    process.exitCode = 1;
  });
}
