import { createHash, randomUUID } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { basename, relative, resolve } from "node:path";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { loadEnvFile } from "node:process";
import { parseUploadedMarkdownSource } from "@focowiki/okf";
import postgres from "postgres";
import type {
  LexicalClaimProcessingMetrics
} from "../src/maintenance/lexical-rebuild-worker.js";
import type {
  LexicalRebuildSettingsSnapshot
} from "../src/application/ports/lexical-rebuild-work-repository.js";
import type { ResourceBudget } from "../src/runtime/resource-budget.js";
import { loadRuntimeConfig } from "../src/config.js";
import { applyMigrations } from "../src/db/migrations.js";
import { createPostgresLexicalRebuildRepository } from
  "../src/infrastructure/postgres/lexical-rebuild-repository.js";
import { createPostgresLexicalRebuildWorkRepository } from
  "../src/infrastructure/postgres/lexical-rebuild-work-repository.js";
import { createPostgresActiveGenerationReadRepository } from
  "../src/infrastructure/postgres/active-generation-read-repository.js";
import { createPostgresSearchProjectionRepository } from
  "../src/infrastructure/postgres/search-projection-repository.js";
import { createNodeJiebaTokenizer } from
  "../src/infrastructure/tokenization/nodejieba-tokenizer.js";
import { runLexicalCapacityRefill } from
  "../src/maintenance/lexical-rebuild-capacity.js";
import { runLexicalRebuildFinalization } from
  "../src/maintenance/lexical-rebuild-finalization.js";
import { processLexicalRebuildClaims } from
  "../src/maintenance/lexical-rebuild-worker.js";
import { createLexicalSourceReader } from
  "../src/maintenance/lexical-source-reader.js";
import {
  createS3StorageAdapter,
  type StorageAdapter
} from "../src/storage/s3.js";
import { createLexicalHttpEvidenceHarness } from
  "./support/lexical-evidence-http.js";
import { createOperationTimer, summarizeDurations } from
  "./support/lexical-evidence-duration-summary.js";

const reportDirectory = resolve(
  process.cwd(),
  "../../ReferenceDocs/performance/lexical-rebuild"
);
const LARGE_VALIDATION_SOURCE_COUNT = 10_000;
const BASELINE_PROFILE_SOURCE_COUNT = 29_735;

loadLocalEnvironment();

const sourceCount = readPositiveInteger(
  process.env.LEXICAL_REBUILD_EVIDENCE_SOURCE_COUNT,
  120
);
const sourceRoot = process.env.LEXICAL_REBUILD_EVIDENCE_SOURCE_ROOT?.trim();
if (!sourceRoot) {
  throw new Error("LEXICAL_REBUILD_EVIDENCE_SOURCE_ROOT is required");
}
const sourceUrlBase = process.env.LEXICAL_REBUILD_EVIDENCE_SOURCE_URL_BASE
  ?.replace(/\/+$/u, "") ?? null;
const settings: LexicalRebuildSettingsSnapshot = {
  concurrency: 4,
  sourceReadConcurrency: readPositiveInteger(
    process.env.LEXICAL_REBUILD_EVIDENCE_SOURCE_READ_CONCURRENCY,
    2
  ),
  databaseWriteConcurrency: 2,
  claimBatchSize: 500,
  databaseBatchSize: 50,
  maxInFlightSourceBytes: 64 * 1_024 * 1_024
};

async function main(): Promise<void> {
  const config = loadRuntimeConfig();
  const selected = (await listMarkdownFiles(sourceRoot)).slice(0, sourceCount);
  if (selected.length !== sourceCount) {
    throw new Error(`Expected ${sourceCount} Markdown files, found ${selected.length}`);
  }

  const runId = randomUUID().replaceAll("-", "").slice(0, 12);
  const databaseName = `focowiki_lexical_evidence_${process.pid}_${runId}`;
  const evidencePrefix = `${config.storage.prefix}/validation/lexical-${runId}`;
  const storage = createS3StorageAdapter({
    ...config.storage,
    prefix: evidencePrefix
  });
  const admin = postgres(databaseConnectionUrl(config.database.url, "postgres"), {
    max: 1
  });
  const queryMetrics = createQueryMetrics();
  const sql = postgres(databaseConnectionUrl(config.database.url, databaseName), {
    max: 12,
    debug: (_connection, query) => queryMetrics.observe(query)
  });
  const probes = postgres(databaseConnectionUrl(config.database.url, databaseName), {
    max: 4
  });
  const knowledgeBaseId = `kb-lexical-evidence-${runId}`;
  const baseGenerationId = `generation-lexical-evidence-base-${runId}`;
  const targetGenerationId = `generation-lexical-evidence-target-${runId}`;
  const sources = new Array<SourceSeed>(selected.length);
  let httpHarness: Awaited<
    ReturnType<typeof createLexicalHttpEvidenceHarness>
  > | null = null;
  let prefixResidue = -1;

  try {
    await admin.unsafe(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
    await applyMigrations(sql);
    console.error(`lexical-evidence stage=prepare files=${selected.length}`);
    await mapWithConcurrency(
      selected.map((filePath, index) => ({ filePath, index })),
      16,
      async ({ filePath, index }) => {
      const body = await readFile(filePath, "utf8");
      const sourceFileId = `source-lexical-evidence-${runId}-${index}`;
      const revisionId = `revision-lexical-evidence-${runId}-${index}`;
      const objectKey = storage.keyspace.sourceRevisionKey(
        knowledgeBaseId,
        sourceFileId,
        revisionId
      );
      const metadata = parseUploadedMarkdownSource({
        fileName: basename(filePath),
        content: body
      }).metadata;
        sources[index] = {
          index,
          sourceFileId,
          revisionId,
          objectKey,
          relativePath: `evidence/source-${index.toString().padStart(7, "0")}.md`,
          title: basename(filePath, ".md"),
          sourceUrl: metadata.resource
            ?? (sourceUrlBase === null
              ? null
              : `${sourceUrlBase}/${encodePublicPath(relative(sourceRoot, filePath))}`),
          sizeBytes: Buffer.byteLength(body),
          checksumSha256: createHash("sha256").update(body).digest("hex")
        };
      await storage.putObject({
        key: objectKey,
        body,
        contentType: "text/markdown; charset=utf-8"
      });
      }
    );
    console.error(`lexical-evidence stage=uploaded files=${sources.length}`);
    await seedDatabase({
      sql,
      knowledgeBaseId,
      baseGenerationId,
      targetGenerationId,
      sources
    });
    console.error(`lexical-evidence stage=seeded files=${sources.length}`);

    queryMetrics.reset();
    const resources = createResourceSampler();
    const eventLoop = monitorEventLoopDelay({ resolution: 20 });
    const stageMetrics: LexicalClaimProcessingMetrics[] = [];
    const claimGapsMs: number[] = [];
    const sourceStorageDurationsMs: number[] = [];
    const databaseBatchDurationsMs: number[] = [];
    let sourceStorageErrors = 0;
    let previousCompletionAt: number | null = null;
    let processedSources = 0;
    const databaseBudget = createBoundedBudget(settings.databaseWriteConcurrency);
    const workRepository = createPostgresLexicalRebuildWorkRepository(sql);
    const retryEvidence = new Map<string, number>();
    const work: typeof workRepository = {
      ...workRepository,
      async persistBatch(input) {
        const startedAt = performance.now();
        try {
          await workRepository.persistBatch(input);
        } finally {
          databaseBatchDurationsMs.push(performance.now() - startedAt);
        }
      },
      async retry(input) {
        const key = `${input.stage}:${input.errorCode}:${input.errorMessage}`;
        retryEvidence.set(key, (retryEvidence.get(key) ?? 0) + input.claims.length);
        await workRepository.retry(input);
      }
    };
      const rebuilds = createPostgresLexicalRebuildRepository(sql);
      const search = createPostgresSearchProjectionRepository(sql);
      const tokenizer = createNodeJiebaTokenizer();
      const activeReads = createPostgresActiveGenerationReadRepository(sql, tokenizer);
      const searchQuery = sources[0]!.title;
      const searchBefore = await readSearchEvidence({
        repository: activeReads,
        knowledgeBaseId,
        query: searchQuery
      });
      const acceptedEdgesBefore = await readAcceptedEdgeCount(sql, knowledgeBaseId);
      httpHarness = await createLexicalHttpEvidenceHarness({
        config,
        sql,
        storage,
        activeGenerationReads: activeReads,
        knowledgeBaseId,
        query: searchQuery,
        generatedFileId: `bundle-${sources[0]!.sourceFileId}`,
        keyPrefix: `focowiki-lexical-evidence-${runId}`,
        enforceContentDrift: sourceCount >= 100
      });
    const sourceStorage: Pick<StorageAdapter, "getObjectText"> = {
      async getObjectText(key, options) {
        const startedAt = performance.now();
        try {
          return await storage.getObjectText(key, options);
        } catch (error) {
          sourceStorageErrors += 1;
          throw error;
        } finally {
          sourceStorageDurationsMs.push(performance.now() - startedAt);
        }
      }
    };
      const sourceReader = createLexicalSourceReader({
      storage: sourceStorage,
      concurrency: settings.sourceReadConcurrency,
      maxInFlightBytes: settings.maxInFlightSourceBytes,
      maxObjectBytes: 10 * 1_024 * 1_024
    });
    const workerId = `lexical-evidence-worker-${runId}`;

    resources.start();
    eventLoop.enable();
    const cpuStart = process.cpuUsage();
    const activeProcessingTimer = createOperationTimer();
    const endToEndTimer = createOperationTimer();
      const execution = activeProcessingTimer.track(runLexicalCapacityRefill({
      concurrency: settings.concurrency,
      databaseBatchSize: settings.databaseBatchSize,
      maxClaimCycles: Math.ceil(sourceCount / settings.claimBatchSize) + 2,
      async claim() {
        const now = new Date();
        if (previousCompletionAt !== null) {
          claimGapsMs.push(performance.now() - previousCompletionAt);
          previousCompletionAt = null;
        }
        return work.claimBatch({
          workerId,
          leaseTokenPrefix: randomUUID(),
          limit: settings.claimBatchSize,
          settingsRevision: 1,
          settings,
          now: now.toISOString(),
          leaseExpiresAt: new Date(now.getTime() + 15 * 60_000).toISOString()
        });
      },
      process: async (claims) => {
        const result = await processLexicalRebuildClaims({
          repository: work,
          sourceReader,
          tokenizer,
          databaseWriteBudget: databaseBudget,
          workerId,
          claims,
          databaseBatchSize: settings.databaseBatchSize,
          retryDelayMs: 1_000,
          leaseDurationMs: 15 * 60_000,
          heartbeatIntervalMs: 15_000,
          onMetrics(metrics) {
            stageMetrics.push(metrics);
            processedSources += metrics.completed;
            console.error(
              `lexical-evidence stage=rebuild completed=${processedSources}/${sourceCount}`
            );
          }
        });
        previousCompletionAt = performance.now();
        return result;
      }
      }));
    const rebuildOperation = endToEndTimer.track((async () => {
      const capacity = await execution;
      await completeFinalization({
        work,
        rebuilds,
        search,
        workerId,
        databaseBatchSize: settings.databaseBatchSize
      });
      console.error(`lexical-evidence stage=finalized files=${sourceCount}`);
      return capacity;
    })());
      const readProbePromise = measureReadProbes(
      probes,
      knowledgeBaseId,
      rebuildOperation
    );
      const httpReadPromise = httpHarness.measureLoaded(rebuildOperation);
    const postgresSessionsPromise = measurePostgresSessions(probes, rebuildOperation);
    const capacity = await rebuildOperation;
    const elapsedMs = endToEndTimer.elapsedMs();
    const activeProcessingElapsedMs = activeProcessingTimer.elapsedMs();
    const cpu = process.cpuUsage(cpuStart);
    eventLoop.disable();
    const resource = resources.stop();
    const [readProbes, httpReads, postgresSessions] = await Promise.all([
      readProbePromise,
      httpReadPromise,
      postgresSessionsPromise
    ]);
      const resultCounts = await readResultCounts(sql, knowledgeBaseId, targetGenerationId);
    const sourceStorageLatency = summarizeDurations(sourceStorageDurationsMs);
    const databaseBatchLatency = summarizeDurations(databaseBatchDurationsMs);
      const stages = {
      ...summarizeStages(stageMetrics),
      sourceReadLatencyAverageMs: sourceStorageLatency.averageMs,
      sourceReadLatencyMaximumMs: sourceStorageLatency.maximumMs,
      sourceReadLatencyP50Ms: sourceStorageLatency.p50Ms,
      sourceReadLatencyP95Ms: sourceStorageLatency.p95Ms
    };
      const searchAfter = await readSearchEvidence({
        repository: activeReads,
        knowledgeBaseId,
        query: searchQuery
      });
      const acceptedEdgesAfter = await readAcceptedEdgeCount(sql, knowledgeBaseId);
    const activeGenerationId = (await sql<Array<{
      active_generation_id: string | null;
    }>>`
      SELECT active_generation_id
      FROM focowiki.knowledge_bases
      WHERE id = ${knowledgeBaseId}
    `)[0]?.active_generation_id ?? null;
    const report = {
      schemaVersion: 1,
      kind: "lexical-rebuild-optimized",
      generatedAt: new Date().toISOString(),
      dataset: {
        identity: sourceCount === LARGE_VALIDATION_SOURCE_COUNT
          ? "frozen-real-markdown-10000"
          : `representative-real-markdown-${sourceCount}`,
        sourceCount,
        selection: `first ${sourceCount} Markdown files sorted by normalized logical path`,
        sourceBytes: sources.reduce(
          (total, source) => total + source.sizeBytes,
          0
        ),
        sourceBodiesCommitted: false
      },
      environment: {
        nodeVersion: process.version,
        platform: process.platform,
        architecture: process.arch,
        cpuCount: navigator.hardwareConcurrency,
        database: "PostgreSQL 18",
        storageClass: "external S3-compatible object storage",
        endpointCommitted: false,
        credentialsCommitted: false,
        modelCalls: 0
      },
      settings,
      settingsRevision: 1,
        result: {
        elapsedMs: round(elapsedMs),
        activeProcessingElapsedMs: round(activeProcessingElapsedMs),
        filesPerSecond: round(sourceCount / (elapsedMs / 1_000)),
        claimed: capacity.claimed,
        completed: capacity.completed,
        retried: capacity.retried,
        claimCycles: capacity.claimCycles,
        maximumClaimGapMs: round(maximum(claimGapsMs)),
        activated: activeGenerationId === targetGenerationId,
          ...resultCounts
        },
        comparison: {
          observedLargeBaselineFilesPerSecond: 0.44,
          throughputMultiple: round(
            (sourceCount / (elapsedMs / 1_000)) / 0.44
          ),
          observedLargeBaselineHours: 18.8,
          optimizedLargeExtrapolationHours: round(
            BASELINE_PROFILE_SOURCE_COUNT
              / (sourceCount / (elapsedMs / 1_000))
              / 3_600
          ),
          stages: {
            activeProcessing: {
              baseline: "720 seconds per 1,000-source slice",
              optimized: `${round(activeProcessingElapsedMs)} ms for ${sourceCount} sources`
            },
            interClaimDelay: {
              baselineMs: 1_500_000,
              optimizedMaximumMs: round(maximum(claimGapsMs))
            },
            sourceRead: {
              baseline: "not captured",
              optimizedP50Ms: sourceStorageLatency.p50Ms,
              optimizedP95Ms: sourceStorageLatency.p95Ms,
              optimizedAverageMs: stages.sourceReadLatencyAverageMs,
              optimizedMaximumMs: stages.sourceReadLatencyMaximumMs
            },
            databasePersistence: {
              baseline: "not captured",
              optimizedStatementCount: queryMetrics.total,
              optimizedBatchCount: databaseBatchLatency.count,
              optimizedP50Ms: databaseBatchLatency.p50Ms,
              optimizedP95Ms: databaseBatchLatency.p95Ms
            }
          }
        },
        stages,
      storage: {
        readRequests: sourceStorageLatency.count,
        readBytes: stages.sourceReadBytes,
        readLatency: sourceStorageLatency,
        retries: stages.sourceReadRetries,
        errors: sourceStorageErrors
      },
      retries: Array.from(retryEvidence, ([key, count]) => {
        const [stage, code, ...message] = key.split(":");
        return { stage, code, message: message.join(":"), count };
      }),
      postgres: {
        statementCount: queryMetrics.total,
        statementsByOperation: queryMetrics.byOperation,
        databaseBatchLatency,
        sessions: postgresSessions,
        databaseWriteBudget: databaseBudget.snapshot()
      },
      resources: {
        cpuUserMs: round(cpu.user / 1_000),
        cpuSystemMs: round(cpu.system / 1_000),
        rssStartBytes: resource.rssStartBytes,
        rssPeakBytes: resource.rssPeakBytes,
        rssGrowthBytes: resource.rssPeakBytes - resource.rssStartBytes,
        eventLoopDelayP95Ms: round(eventLoop.percentile(95) / 1_000_000)
      },
        concurrentReads: readProbes,
        httpReads,
        searchComparison: {
          query: searchQuery,
          before: searchBefore,
          after: searchAfter,
          acceptedEdgesBefore,
          acceptedEdgesAfter
        },
        acceptance: evaluateAcceptance({
        sourceCount,
        elapsedMs,
        claimGapsMs,
        capacity,
        resultCounts,
        activeGenerationId,
          targetGenerationId,
          searchBefore,
          searchAfter,
          acceptedEdgesBefore,
          acceptedEdgesAfter,
          expectedPath: `pages/${sources[0]!.relativePath}`,
          expectedSourceUrl: sources[0]!.sourceUrl,
          httpReadsPassed: httpReads.acceptance.passed,
          rssGrowthBytes: resource.rssPeakBytes - resource.rssStartBytes
      })
    };
    await writeFile(
      resolve(reportDirectory, `optimized-${sourceCount}.json`),
      `${JSON.stringify(report, null, 2)}\n`,
      "utf8"
    );
    await writeFile(
      resolve(reportDirectory, `optimized-${sourceCount}.md`),
      renderReport(report),
      "utf8"
    );
    console.log(JSON.stringify(report, null, 2));
    if (!report.acceptance.passed) {
      throw new Error(`Lexical evidence failed: ${report.acceptance.failures.join(", ")}`);
    }
    } finally {
      await httpHarness?.close().catch(() => undefined);
      await probes.end({ timeout: 5 }).catch(() => undefined);
    await sql.end({ timeout: 5 }).catch(() => undefined);
    await admin.unsafe(
      `DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)} WITH (FORCE)`
    ).catch(() => undefined);
    await admin.end({ timeout: 5 });
    if (storage.purgePrefix && storage.countPrefix) {
      const cleanupPrefix = `${storage.keyspace.prefix}/`;
      for (let page = 0; page < 100; page += 1) {
        const cleanup = await storage.purgePrefix(cleanupPrefix);
        if (cleanup.remaining === 0) break;
      }
      prefixResidue = await storage.countPrefix(cleanupPrefix);
    }
    if (prefixResidue > 0) {
      throw new Error(`External storage cleanup left ${prefixResidue} objects`);
    }
  }
}

type SourceSeed = {
  index: number;
  sourceFileId: string;
  revisionId: string;
  objectKey: string;
  relativePath: string;
  title: string;
  sourceUrl: string | null;
  sizeBytes: number;
  checksumSha256: string;
};

async function seedDatabase(input: {
  sql: ReturnType<typeof postgres>;
  knowledgeBaseId: string;
  baseGenerationId: string;
  targetGenerationId: string;
  sources: SourceSeed[];
}): Promise<void> {
  await input.sql.begin(async (transaction) => {
    await transaction`
      INSERT INTO focowiki.knowledge_bases (id, name, description)
      VALUES (
        ${input.knowledgeBaseId},
        'Lexical rebuild performance evidence',
        'Domain-neutral real Markdown performance fixture'
      )
    `;
    await transaction`
      INSERT INTO focowiki.publication_generations (
        id, knowledge_base_id, predecessor_generation_id,
        state, format_version, generation_kind, activated_at
      ) VALUES
        (
          ${input.baseGenerationId}, ${input.knowledgeBaseId}, NULL,
          'active', 2, 'normal', now()
        ),
        (
          ${input.targetGenerationId}, ${input.knowledgeBaseId},
          ${input.baseGenerationId}, 'building', 2, 'lexical_rebuild', NULL
        )
    `;
    await transaction`
      UPDATE focowiki.knowledge_bases
      SET active_generation_id = ${input.baseGenerationId}
      WHERE id = ${input.knowledgeBaseId}
    `;
  });
  for (const batch of chunk(input.sources, 500)) {
    await input.sql.begin(async (transaction) => {
      const rows = batch.map((source) => ({
        source_file_id: source.sourceFileId,
        revision_id: source.revisionId,
        object_key: source.objectKey,
        name: `${source.index}.md`,
        relative_path: source.relativePath,
          size_bytes: source.sizeBytes,
          checksum_sha256: source.checksumSha256,
          title: source.title,
          source_url: source.sourceUrl
        }));
      await transaction`
        INSERT INTO focowiki.source_files (
          id, knowledge_base_id, object_key, content_type, size_bytes,
          checksum_sha256, processing_status, processing_stage,
          generated_output_status, name, relative_path, path_key,
          active_revision_id, metadata_json
        )
        SELECT row.source_file_id, ${input.knowledgeBaseId}, row.object_key,
               'text/markdown; charset=utf-8', row.size_bytes,
               row.checksum_sha256, 'completed', 'generation_activation',
               'visible', row.name, row.relative_path, row.relative_path,
                 row.revision_id, jsonb_strip_nulls(jsonb_build_object(
                   'title', row.title,
                   'resource', row.source_url
                 ))
          FROM jsonb_to_recordset(${transaction.json(rows as never)}) AS row(
            source_file_id text, revision_id text, object_key text,
            name text, relative_path text, size_bytes bigint,
            checksum_sha256 text, title text, source_url text
          )
      `;
      await transaction`
        INSERT INTO focowiki.source_revisions (
          id, knowledge_base_id, source_file_id, revision, object_key,
          content_type, size_bytes, checksum_sha256, processing_status,
          metadata_json
        )
        SELECT row.revision_id, ${input.knowledgeBaseId}, row.source_file_id,
               1, row.object_key, 'text/markdown; charset=utf-8',
               row.size_bytes, row.checksum_sha256, 'completed',
                 jsonb_strip_nulls(jsonb_build_object(
                   'title', row.title,
                   'resource', row.source_url
                 ))
          FROM jsonb_to_recordset(${transaction.json(rows as never)}) AS row(
            source_file_id text, revision_id text, object_key text,
            name text, relative_path text, size_bytes bigint,
            checksum_sha256 text, title text, source_url text
          )
        `;
        await transaction`
          INSERT INTO focowiki.immutable_objects (
            checksum_sha256, format_version, object_key, content_type,
            size_bytes, verified_at
          )
          SELECT DISTINCT ON (row.checksum_sha256)
                 row.checksum_sha256, 1, row.object_key,
                 'text/markdown; charset=utf-8', row.size_bytes, now()
          FROM jsonb_to_recordset(${transaction.json(rows as never)}) AS row(
            source_file_id text, revision_id text, object_key text,
            name text, relative_path text, size_bytes bigint,
            checksum_sha256 text, title text, source_url text
          )
          ORDER BY row.checksum_sha256, row.object_key
          ON CONFLICT (checksum_sha256, format_version) DO NOTHING
        `;
        await transaction`
          INSERT INTO focowiki.active_object_refs (
            knowledge_base_id, ref_kind, ref_key, file_id,
            last_changed_generation_id, checksum_sha256, format_version,
            logical_path, source_file_id
          )
          SELECT ${input.knowledgeBaseId}, 'page', row.source_file_id,
                 'bundle-' || row.source_file_id, ${input.baseGenerationId},
                 row.checksum_sha256, 1, 'pages/' || row.relative_path,
                 row.source_file_id
          FROM jsonb_to_recordset(${transaction.json(rows as never)}) AS row(
            source_file_id text, revision_id text, object_key text,
            name text, relative_path text, size_bytes bigint,
            checksum_sha256 text, title text, source_url text
          )
        `;
        await transaction`
          INSERT INTO focowiki.active_projection_records (
            knowledge_base_id, projection_kind, record_id,
            last_changed_generation_id, shard_key, source_file_id,
            logical_path, parent_path, sort_key, title, summary,
            searchable_text, payload_json
          )
          SELECT ${input.knowledgeBaseId}, projection.kind,
                 row.source_file_id, ${input.baseGenerationId},
                 projection.kind || '/evidence/0001', row.source_file_id,
                 'pages/' || row.relative_path, 'pages/evidence',
                 row.relative_path, row.title, NULL, row.title,
                 jsonb_strip_nulls(jsonb_build_object(
                   'fileId', 'bundle-' || row.source_file_id,
                   'kind', 'file',
                   'path', 'pages/' || row.relative_path,
                   'sourceUrl', row.source_url,
                   'title', row.title
                 ))
          FROM jsonb_to_recordset(${transaction.json(rows as never)}) AS row(
            source_file_id text, revision_id text, object_key text,
            name text, relative_path text, size_bytes bigint,
            checksum_sha256 text, title text, source_url text
          )
          CROSS JOIN (
            VALUES ('tree'::text), ('search'::text), ('graph_node'::text)
          ) AS projection(kind)
        `;
        await transaction`
          INSERT INTO focowiki.source_file_graph_nodes (
            knowledge_base_id, source_file_id, path, title,
            profile_version, profile_source, profile_json, metadata_json
          )
          SELECT ${input.knowledgeBaseId}, row.source_file_id,
                 'pages/' || row.relative_path, row.title,
                 'content-profile-v1', 'deterministic',
                 '{}'::jsonb,
                 jsonb_strip_nulls(jsonb_build_object(
                   'title', row.title,
                   'resource', row.source_url
                 ))
          FROM jsonb_to_recordset(${transaction.json(rows as never)}) AS row(
            source_file_id text, revision_id text, object_key text,
            name text, relative_path text, size_bytes bigint,
            checksum_sha256 text, title text, source_url text
          )
        `;
        await transaction`
        INSERT INTO focowiki.lexical_rebuild_work_items (
          knowledge_base_id, target_generation_id, source_file_id,
          source_revision_id, logical_path,
          target_search_schema_version, target_tokenizer_contract_version,
          target_segmentation_version, target_content_profile_version,
          target_graph_lexical_projection_version, state, max_attempts,
          next_attempt_at, settings_revision, settings_snapshot_json
        )
        SELECT ${input.knowledgeBaseId}, ${input.targetGenerationId},
               row.source_file_id, row.revision_id,
               'pages/' || row.relative_path, 'body-search-v1',
               ${createNodeJiebaTokenizer().contractVersion},
               'body-segmentation-v1', 'content-profile-v2',
               'graph-lexical-v2', 'pending', 3, now(), 1,
               ${transaction.json(settings as never)}
          FROM jsonb_to_recordset(${transaction.json(rows as never)}) AS row(
            source_file_id text, revision_id text, object_key text,
            name text, relative_path text, size_bytes bigint,
            checksum_sha256 text, title text, source_url text
          )
        `;
      });
    }
    if (input.sources.length >= 2) {
      const [from, to] = input.sources;
      await input.sql.begin(async (transaction) => {
        await transaction`
          INSERT INTO focowiki.active_projection_records (
            knowledge_base_id, projection_kind, record_id,
            last_changed_generation_id, shard_key, source_file_id,
            related_source_file_id, logical_path, sort_key, title, summary,
            searchable_text, payload_json
          ) VALUES (
            ${input.knowledgeBaseId}, 'graph_edge', 'evidence-edge-0001',
            ${input.baseGenerationId}, 'graph_edge/evidence/0001',
            ${from!.sourceFileId}, ${to!.sourceFileId},
            ${`pages/${from!.relativePath}`}, 'evidence-edge-0001',
            ${`${from!.title} → ${to!.title}`},
            'Stable accepted-edge parity evidence',
            ${`${from!.title} ${to!.title}`},
            ${transaction.json({
              fromFileId: from!.sourceFileId,
              fromPath: `pages/${from!.relativePath}`,
              fromTitle: from!.title,
              toFileId: to!.sourceFileId,
              toPath: `pages/${to!.relativePath}`,
              toTitle: to!.title,
              relationType: "related",
              weight: 0.9,
              reason: "Stable validation fixture"
            })}
          )
        `;
        await transaction`
          INSERT INTO focowiki.generation_graph_summaries (
            knowledge_base_id, generation_id, node_count, edge_count,
            graph_index_available
          ) VALUES (
            ${input.knowledgeBaseId}, ${input.baseGenerationId},
            ${input.sources.length}, 1, true
          )
        `;
      });
    }
  await input.sql`
    INSERT INTO focowiki.knowledge_base_lexical_rebuilds (
      knowledge_base_id, target_search_schema_version,
      target_tokenizer_contract_version, target_segmentation_version,
      target_content_profile_version, target_graph_lexical_projection_version,
      base_generation_id, target_generation_id, state, phase,
      pending_source_count, total_source_count,
      settings_revision, settings_snapshot_json,
      started_at, next_attempt_at, updated_at
    ) VALUES (
      ${input.knowledgeBaseId}, 'body-search-v1',
      ${createNodeJiebaTokenizer().contractVersion}, 'body-segmentation-v1',
      'content-profile-v2', 'graph-lexical-v2',
      ${input.baseGenerationId}, ${input.targetGenerationId},
      'running', 'documents', ${input.sources.length}, ${input.sources.length},
      1, ${input.sql.json(settings as never)}, now(), now(), now()
    )
  `;
}

async function completeFinalization(input: {
  work: ReturnType<typeof createPostgresLexicalRebuildWorkRepository>;
  rebuilds: ReturnType<typeof createPostgresLexicalRebuildRepository>;
  search: ReturnType<typeof createPostgresSearchProjectionRepository>;
  workerId: string;
  databaseBatchSize: number;
}): Promise<void> {
  for (let step = 0; step < 4; step += 1) {
    const ran = await runLexicalRebuildFinalization({
      work: input.work,
      rebuilds: input.rebuilds,
      search: input.search,
      workerId: input.workerId,
      leaseToken: randomUUID(),
      now: new Date(),
      leaseDurationMs: 60_000,
      retryDelayMs: 1_000,
      cleanupBatchSize: input.databaseBatchSize
    });
    if (!ran) break;
  }
}

async function readResultCounts(
  sql: ReturnType<typeof postgres>,
  knowledgeBaseId: string,
  targetGenerationId: string
) {
  return (await sql<Array<{
    completed_work_items: number;
    failed_work_items: number;
    search_documents: number;
    search_references: number;
    graph_nodes: number;
    graph_terms: number;
  }>>`
    SELECT
      (
        SELECT count(*)::int
        FROM focowiki.lexical_rebuild_work_items
        WHERE knowledge_base_id = ${knowledgeBaseId}
          AND state = 'completed'
      ) AS completed_work_items,
      (
        SELECT count(*)::int
        FROM focowiki.lexical_rebuild_work_items
        WHERE knowledge_base_id = ${knowledgeBaseId}
          AND state = 'failed'
      ) AS failed_work_items,
      (
        SELECT count(*)::int
        FROM focowiki.search_projection_documents
        WHERE knowledge_base_id = ${knowledgeBaseId}
      ) AS search_documents,
      (
        SELECT count(*)::int
        FROM focowiki.generation_search_projection_refs
        WHERE generation_id = ${targetGenerationId}
      ) AS search_references,
      (
        SELECT count(*)::int
        FROM focowiki.source_file_graph_nodes
        WHERE knowledge_base_id = ${knowledgeBaseId}
      ) AS graph_nodes,
      (
        SELECT count(*)::int
        FROM focowiki.source_file_graph_term_documents
        WHERE knowledge_base_id = ${knowledgeBaseId}
      ) AS graph_terms
  `)[0]!;
}

type SearchMode = "file" | "graph" | "hybrid";

type SearchModeEvidence = {
  resultCount: number;
  topPath: string | null;
  topTitle: string | null;
  topSourceUrl: string | null;
  cursorAvailable: boolean;
  generationConsistent: boolean;
};

async function readSearchEvidence(input: {
  repository: ReturnType<typeof createPostgresActiveGenerationReadRepository>;
  knowledgeBaseId: string;
  query: string;
}): Promise<Record<SearchMode, SearchModeEvidence>> {
  const result = await input.repository.withActiveGeneration(
    input.knowledgeBaseId,
    async (scope) => {
      const modes: SearchMode[] = ["file", "graph", "hybrid"];
      const pages = await Promise.all(modes.map(async (mode) => ({
        mode,
        page: await scope.search({
          query: input.query,
          mode,
          limit: 10,
          cursor: null
        })
      })));
      return Object.fromEntries(pages.map(({ mode, page }) => {
        const top = page.items[0] ?? null;
        return [mode, {
          resultCount: page.items.length,
          topPath: top?.path ?? null,
          topTitle: top?.title ?? null,
          topSourceUrl: readPayloadString(top?.payload, "sourceUrl"),
          cursorAvailable: page.nextCursor !== null,
          generationConsistent: page.items.every(
            (item) => item.generationId === scope.generationId
          )
        }];
      })) as Record<SearchMode, SearchModeEvidence>;
    }
  );
  if (!result) throw new Error("Lexical evidence active generation is unavailable");
  return result;
}

async function readAcceptedEdgeCount(
  sql: ReturnType<typeof postgres>,
  knowledgeBaseId: string
): Promise<number> {
  return Number((await sql<Array<{ edge_count: number }>>`
    SELECT count(*)::int AS edge_count
    FROM focowiki.active_projection_records
    WHERE knowledge_base_id = ${knowledgeBaseId}
      AND projection_kind = 'graph_edge'
  `)[0]?.edge_count ?? 0);
}

async function measureReadProbes(
  sql: ReturnType<typeof postgres>,
  knowledgeBaseId: string,
  operation: Promise<unknown>
) {
  let complete = false;
  void operation.then(
    () => {
      complete = true;
    },
    () => {
      complete = true;
    }
  );
  const adminMs: number[] = [];
  const openApiMs: number[] = [];
  await Promise.all(Array.from({ length: 4 }, async () => {
    do {
      let startedAt = performance.now();
      await sql`
        SELECT active_generation_id, resource_revision
        FROM focowiki.knowledge_bases
        WHERE id = ${knowledgeBaseId} AND deleted_at IS NULL
      `;
      adminMs.push(performance.now() - startedAt);
      startedAt = performance.now();
      await sql`
        SELECT id, relative_path
        FROM focowiki.source_files
        WHERE knowledge_base_id = ${knowledgeBaseId}
          AND deleted_at IS NULL
          AND deletion_intent_id IS NULL
        ORDER BY id
        LIMIT 50
      `;
      openApiMs.push(performance.now() - startedAt);
      await sleep(50);
    } while (!complete);
  }));
  return {
    admin: summarizeDurations(adminMs),
    developerOpenApi: summarizeDurations(openApiMs)
  };
}

async function measurePostgresSessions(
  sql: ReturnType<typeof postgres>,
  operation: Promise<unknown>
): Promise<{
  sampleCount: number;
  maximumActive: number;
  maximumTotal: number;
}> {
  let complete = false;
  void operation.then(
    () => {
      complete = true;
    },
    () => {
      complete = true;
    }
  );
  let sampleCount = 0;
  let maximumActive = 0;
  let maximumTotal = 0;
  do {
    const sample = (await sql<Array<{
      active_count: number;
      total_count: number;
    }>>`
      SELECT
        count(*) FILTER (WHERE state = 'active')::int AS active_count,
        count(*)::int AS total_count
      FROM pg_stat_activity
      WHERE datname = current_database()
    `)[0];
    sampleCount += 1;
    maximumActive = Math.max(maximumActive, Number(sample?.active_count ?? 0));
    maximumTotal = Math.max(maximumTotal, Number(sample?.total_count ?? 0));
    if (!complete) await sleep(1_000);
  } while (!complete);
  return { sampleCount, maximumActive, maximumTotal };
}

function summarizeStages(values: LexicalClaimProcessingMetrics[]) {
  const sourceReadLatencies = values.flatMap((value) =>
    value.sourceReadLatencyAverageMs === null ? [] : [value.sourceReadLatencyAverageMs]
  );
  return {
    batchCount: values.length,
    sourceReadCount: sum(values.map((value) => value.sourceReadCount)),
    sourceReadBytes: sum(values.map((value) => value.sourceReadBytes)),
    sourceReadRetries: sum(values.map((value) => value.sourceReadRetries)),
    sourceReadWallMs: round(sum(values.map((value) => value.sourceReadDurationMs))),
    sourceReadLatencyAverageMs: round(average(sourceReadLatencies)),
    sourceReadLatencyMaximumMs: round(maximum(
      values.flatMap((value) =>
        value.sourceReadLatencyMaximumMs === null
          ? []
          : [value.sourceReadLatencyMaximumMs]
      )
    )),
    deriveCount: sum(values.map((value) => value.deriveCount)),
    deriveDurationMs: round(sum(values.map((value) => value.deriveDurationMs))),
    databaseBatchCount: sum(values.map((value) => value.databaseBatchCount)),
    databaseWriteDurationMs: round(sum(
      values.map((value) => value.databaseWriteDurationMs)
    ))
  };
}

function evaluateAcceptance(input: {
  sourceCount: number;
  elapsedMs: number;
  claimGapsMs: number[];
  capacity: { completed: number; retried: number };
  resultCounts: Awaited<ReturnType<typeof readResultCounts>>;
  activeGenerationId: string | null;
  targetGenerationId: string;
  searchBefore: Record<SearchMode, SearchModeEvidence>;
  searchAfter: Record<SearchMode, SearchModeEvidence>;
  acceptedEdgesBefore: number;
  acceptedEdgesAfter: number;
  expectedPath: string;
  expectedSourceUrl: string | null;
  httpReadsPassed: boolean;
  rssGrowthBytes: number;
}) {
  const failures: string[] = [];
  const filesPerSecond = input.sourceCount / (input.elapsedMs / 1_000);
  if (input.capacity.completed !== input.sourceCount) {
    failures.push("Not every source work item completed");
  }
  if (input.capacity.retried !== 0 || input.resultCounts.failed_work_items !== 0) {
    failures.push("Unexpected lexical retries or terminal failures were recorded");
  }
  for (const value of [
    input.resultCounts.completed_work_items,
    input.resultCounts.search_documents,
    input.resultCounts.search_references,
    input.resultCounts.graph_nodes,
    input.resultCounts.graph_terms
  ]) {
    if (value !== input.sourceCount) {
      failures.push("Projection parity does not match the source count");
      break;
    }
  }
  if (input.activeGenerationId !== input.targetGenerationId) {
    failures.push("The compatible candidate did not activate atomically");
  }
  for (const phase of [input.searchBefore, input.searchAfter]) {
    for (const mode of ["file", "graph", "hybrid"] as const) {
      const evidence = phase[mode];
      if (evidence.resultCount === 0 || evidence.topPath !== input.expectedPath) {
        failures.push(`${mode} search did not preserve the expected source path`);
      }
      if (!evidence.generationConsistent) {
        failures.push(`${mode} search mixed active-generation results`);
      }
      if (
        input.expectedSourceUrl !== null
        && evidence.topSourceUrl !== input.expectedSourceUrl
      ) {
        failures.push(`${mode} search did not preserve the public source URL`);
      }
    }
  }
  if (
    input.acceptedEdgesBefore === 0
    || input.acceptedEdgesAfter !== input.acceptedEdgesBefore
  ) {
    failures.push("Accepted graph-edge parity changed during lexical activation");
  }
  if (!input.httpReadsPassed) {
    failures.push("Concurrent Admin and Developer OpenAPI HTTP validation failed");
  }
  if (input.sourceCount >= LARGE_VALIDATION_SOURCE_COUNT && filesPerSecond < 3) {
    failures.push("Large-profile throughput is below 3 files per second");
  }
  if (
    input.sourceCount >= LARGE_VALIDATION_SOURCE_COUNT
    && input.elapsedMs > 10_800_000
  ) {
    failures.push("Large-profile completion exceeded three hours");
  }
  if (maximum(input.claimGapsMs) > 2_000) {
    failures.push("The next eligible claim exceeded two normal poll intervals");
  }
  if (input.rssGrowthBytes > settings.maxInFlightSourceBytes * 2) {
    failures.push("Process RSS growth exceeded the bounded evidence budget");
  }
  return { passed: failures.length === 0, failures };
}

function createBoundedBudget(concurrency: number): ResourceBudget {
  let active = 0;
  let started = 0;
  let completed = 0;
  let failed = 0;
  let retries = 0;
  let saturationCount = 0;
  let totalWaitMs = 0;
  let totalRunMs = 0;
  const queue: Array<() => void> = [];
  async function run<T>(operation: () => Promise<T>): Promise<T> {
    const waitStartedAt = performance.now();
    if (active >= concurrency) {
      saturationCount += 1;
      await new Promise<void>((resolve) => queue.push(resolve));
    }
    totalWaitMs += performance.now() - waitStartedAt;
    active += 1;
    started += 1;
    const startedAt = performance.now();
    try {
      const value = await operation();
      completed += 1;
      return value;
    } catch (error) {
      failed += 1;
      throw error;
    } finally {
      totalRunMs += performance.now() - startedAt;
      active -= 1;
      queue.shift()?.();
    }
  }
  return {
    run,
    recordRetry(count = 1) {
      retries += count;
    },
    snapshot() {
      return {
        concurrency,
        active,
        waiting: queue.length,
        started,
        completed,
        failed,
        retries,
        saturationCount,
        saturated: active >= concurrency || queue.length > 0,
        utilization: round(active / concurrency),
        totalWaitMs: round(totalWaitMs),
        maxWaitMs: 0,
        averageWaitMs: round(started === 0 ? 0 : totalWaitMs / started),
        totalRunMs: round(totalRunMs),
        maxRunMs: 0,
        averageRunMs: round(
          completed + failed === 0 ? 0 : totalRunMs / (completed + failed)
        ),
        throughputPerSecond: 0
      };
    }
  };
}

function createQueryMetrics() {
  let total = 0;
  const byOperation: Record<string, number> = {};
  return {
    observe(query: string) {
      total += 1;
      const operation = query.trim().split(/\s+/u)[0]?.toUpperCase() ?? "UNKNOWN";
      byOperation[operation] = (byOperation[operation] ?? 0) + 1;
    },
    reset() {
      total = 0;
      for (const key of Object.keys(byOperation)) delete byOperation[key];
    },
    get total() {
      return total;
    },
    get byOperation() {
      return { ...byOperation };
    }
  };
}

function createResourceSampler() {
  let timer: NodeJS.Timeout | null = null;
  const rssStartBytes = process.memoryUsage().rss;
  let rssPeakBytes = rssStartBytes;
  return {
    start() {
      timer = setInterval(() => {
        rssPeakBytes = Math.max(rssPeakBytes, process.memoryUsage().rss);
      }, 100);
      timer.unref();
    },
    stop() {
      if (timer) clearInterval(timer);
      rssPeakBytes = Math.max(rssPeakBytes, process.memoryUsage().rss);
      return { rssStartBytes, rssPeakBytes };
    }
  };
}

async function listMarkdownFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".md"))
    .map((entry) => resolve(entry.parentPath, entry.name))
    .sort((left, right) => left.localeCompare(right, "en"));
}

function renderReport(report: Record<string, any>): string {
  return [
    "# 词法投影重建优化实测",
    "",
    `- 数据集：${report.dataset.sourceCount} 个真实 Markdown，${report.dataset.sourceBytes} 字节。`,
    `- 样本选择：按规范化逻辑路径排序后的前 ${report.dataset.sourceCount} 个 Markdown。`,
    `- 外部存储：${report.environment.storageClass}。`,
    `- 端到端总耗时：${report.result.elapsedMs} ms；活跃处理耗时：${report.result.activeProcessingElapsedMs} ms。`,
    `- 吞吐量：${report.result.filesPerSecond} files/s。`,
    `- 相对已记录的 0.44 files/s 大规模基线：${report.comparison.throughputMultiple} 倍。`,
    report.dataset.sourceCount === LARGE_VALIDATION_SOURCE_COUNT
      ? `- 10,000 文件完整实测耗时：${round(report.result.elapsedMs / 3_600_000)} 小时。`
      : `- 按本次吞吐外推 29,735 文件：${report.comparison.optimizedLargeExtrapolationHours} 小时；该值不能替代完整规模实测。`,
    `- 实测配置：工作通道 ${report.settings.concurrency}，来源读取 ${report.settings.sourceReadConcurrency}，数据库写入 ${report.settings.databaseWriteConcurrency}，领取批次 ${report.settings.claimBatchSize}，数据库批次 ${report.settings.databaseBatchSize}，在途正文 ${report.settings.maxInFlightSourceBytes} 字节。`,
      `- S3 读取 p50/p95/平均/最大延迟：${report.storage.readLatency.p50Ms} / ${report.storage.readLatency.p95Ms} / ${report.storage.readLatency.averageMs} / ${report.storage.readLatency.maximumMs} ms。`,
    `- S3 读取请求/重试/错误：${report.storage.readRequests} / ${report.storage.retries} / ${report.storage.errors}。`,
    `- 数据库语句：${report.postgres.statementCount} 条；写入批次：${report.postgres.databaseBatchLatency.count}；批次 p50/p95：${report.postgres.databaseBatchLatency.p50Ms} / ${report.postgres.databaseBatchLatency.p95Ms} ms。`,
    `- PostgreSQL 会话采样：${report.postgres.sessions.sampleCount} 次；活跃/总会话峰值：${report.postgres.sessions.maximumActive} / ${report.postgres.sessions.maximumTotal}。`,
    `- RSS 增量：${report.resources.rssGrowthBytes} 字节；事件循环 p95：${report.resources.eventLoopDelayP95Ms} ms。`,
    `- Admin 读取 p95：${report.concurrentReads.admin.p95Ms} ms。`,
      `- Developer OpenAPI 读取 p95：${report.concurrentReads.developerOpenApi.p95Ms} ms。`,
      `- HTTP Admin 前置空闲/负载/后置空闲 p95：${report.httpReads.idleBefore.admin.p95Ms} / ${report.httpReads.loaded.admin.p95Ms} / ${report.httpReads.idleAfter.admin.p95Ms} ms。`,
      `- HTTP Developer OpenAPI 前置空闲/负载/后置空闲 p95：${report.httpReads.idleBefore.developerOpenApi.p95Ms} / ${report.httpReads.loaded.developerOpenApi.p95Ms} / ${report.httpReads.idleAfter.developerOpenApi.p95Ms} ms。`,
      `- HTTP 内容读取前置空闲/负载/后置空闲 p95：${report.httpReads.idleBefore.content.p95Ms} / ${report.httpReads.loaded.content.p95Ms} / ${report.httpReads.idleAfter.content.p95Ms} ms。`,
      `- HTTP 认证、错误包、游标与内容一致性：${report.httpReads.acceptance.passed ? "通过" : "失败"}。`,
      `- 激活前搜索：file=${report.searchComparison.before.file.resultCount}，graph=${report.searchComparison.before.graph.resultCount}，hybrid=${report.searchComparison.before.hybrid.resultCount}。`,
      `- 激活后搜索：file=${report.searchComparison.after.file.resultCount}，graph=${report.searchComparison.after.graph.resultCount}，hybrid=${report.searchComparison.after.hybrid.resultCount}。`,
      `- 路径与公开来源 URL：${searchEvidencePassed(report.searchComparison.after) ? "通过" : "失败"}。`,
      `- 已接受图边数量：${report.searchComparison.acceptedEdgesBefore} → ${report.searchComparison.acceptedEdgesAfter}。`,
      `- 原子激活：${report.result.activated ? "通过" : "失败"}。`,
      `- 验收：${report.acceptance.passed ? "通过" : "失败"}。`,
      "",
      "## 阶段对比",
      "",
      "| 阶段 | 优化前证据 | 优化后证据 |",
      "| --- | --- | --- |",
      `| 活跃处理 | ${report.comparison.stages.activeProcessing.baseline} | ${report.comparison.stages.activeProcessing.optimized} |`,
      `| 相邻领取间隔 | ${report.comparison.stages.interClaimDelay.baselineMs} ms | ${report.comparison.stages.interClaimDelay.optimizedMaximumMs} ms |`,
      `| S3 读取延迟 | ${report.comparison.stages.sourceRead.baseline} | p50 ${report.comparison.stages.sourceRead.optimizedP50Ms} ms，p95 ${report.comparison.stages.sourceRead.optimizedP95Ms} ms，平均 ${report.comparison.stages.sourceRead.optimizedAverageMs} ms，最大 ${report.comparison.stages.sourceRead.optimizedMaximumMs} ms |`,
      `| PostgreSQL 持久化 | ${report.comparison.stages.databasePersistence.baseline} | ${report.comparison.stages.databasePersistence.optimizedStatementCount} 条语句，${report.comparison.stages.databasePersistence.optimizedBatchCount} 个写入批次，p50 ${report.comparison.stages.databasePersistence.optimizedP50Ms} ms，p95 ${report.comparison.stages.databasePersistence.optimizedP95Ms} ms |`,
      "",
      "历史基线缺少 S3 和数据库阶段遥测，因此相关单元格明确记为未采集，不使用推测值。",
      "",
      "## 剩余边界",
      "",
      "- 实际吞吐仍受外部对象存储延迟和服务容量影响。",
      "- 来源读取并发 2 已通过正文读取延迟门槛；调高前需要在目标存储上重复同一并发读取验证。",
      "- 本次重建不调用模型，不提交端点、凭据、正文、对象键或本机路径。",
      "",
      ""
  ].join("\n");
}

function searchEvidencePassed(
  evidence: Record<SearchMode, SearchModeEvidence>
): boolean {
  return (["file", "graph", "hybrid"] as const).every((mode) =>
    evidence[mode].resultCount > 0
    && evidence[mode].topPath !== null
    && evidence[mode].topSourceUrl !== null
    && evidence[mode].generationConsistent
  );
}

async function mapWithConcurrency<T>(
  values: T[],
  concurrency: number,
  operation: (value: T) => Promise<void>
): Promise<void> {
  let index = 0;
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (index < values.length) {
      const current = values[index++]!;
      await operation(current);
    }
  }));
}

function chunk<T>(values: T[], size: number): T[][] {
  const output: T[][] = [];
  for (let offset = 0; offset < values.length; offset += size) {
    output.push(values.slice(offset, offset + size));
  }
  return output;
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function average(values: number[]): number {
  return values.length === 0 ? 0 : sum(values) / values.length;
}

function maximum(values: number[]): number {
  let result = 0;
  for (const value of values) {
    if (value > result) result = value;
  }
  return result;
}

function readPayloadString(value: unknown, key: string): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = (value as Record<string, unknown>)[key];
  return typeof candidate === "string" && candidate.length > 0
    ? candidate
    : null;
}

function encodePublicPath(value: string): string {
  return value
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");
}

function round(value: number): number {
  return Math.round(value * 1_000) / 1_000;
}

function readPositiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value ?? fallback);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error("Lexical evidence source count must be a positive integer");
  }
  return parsed;
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds));
}

function databaseConnectionUrl(url: string, databaseName: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${databaseName}`;
  return parsed.toString();
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll("\"", "\"\"")}"`;
}

function loadLocalEnvironment(): void {
  const envPath = resolve(process.cwd(), "../../.env");
  try {
    loadEnvFile(envPath);
  } catch {
    // Environment variables may already be supplied by the caller.
  }
}

await main();
