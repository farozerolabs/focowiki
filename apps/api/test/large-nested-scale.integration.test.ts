import { createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPostgresAdminRepositories } from "../src/db/admin-repositories.js";
import { createPostgresHardDeleteRepository } from "../src/db/hard-delete-repository.js";
import { createUploadSessionService } from "../src/application/upload-sessions.js";
import { normalizeSourceRelativePath } from "../src/domain/source-path.js";
import { createPostgresReleasePublicationRepository } from "../src/infrastructure/postgres/release-publication-repository.js";
import { cleanReleaseReadModelGinPendingLists } from "../src/infrastructure/postgres/release-search-index-maintenance.js";
import { createPostgresUploadSessionRepository } from "../src/infrastructure/postgres/upload-session-repository.js";
import { createUploadSessionStoragePort } from "../src/infrastructure/storage/upload-session-storage.js";
import { writeDirectoryNavigationFiles } from "../src/okf/directory-navigation-files.js";
import { createStorageKeyspace } from "../src/storage/keys.js";
import type { StorageAdapter, StoredObject } from "../src/storage/s3.js";

const databaseUrl = process.env.FOCOWIKI_TEST_DATABASE_URL;
const runScale = process.env.FOCOWIKI_RUN_LARGE_NESTED_SCALE === "1";
const describeScale = databaseUrl && runScale ? describe : describe.skip;

describeScale("large nested folder scale integration", () => {
  const sql = postgres(databaseUrl!, { max: 4 });
  const upload = createPostgresUploadSessionRepository(sql);
  const publication = createPostgresReleasePublicationRepository(sql);
  const hardDelete = createPostgresHardDeleteRepository(sql);
  const repositories = createPostgresAdminRepositories(sql);
  const knowledgeBaseId = "kb-large-nested-scale";
  const sessionId = "upload-session-large-nested-scale";
  const releaseId = "release-large-nested-scale";
  const fileCount = 20_000;
  const overlapNewFileCount = 20;
  const totalFileCount = fileCount + overlapNewFileCount;
  const manifestPageSize = 500;
  const metrics = createMetrics();

  beforeAll(async () => {
    await cleanup();
    await sql`
      INSERT INTO focowiki.knowledge_bases (id, name)
      VALUES (${knowledgeBaseId}, 'Large nested scale validation')
    `;
  }, 180_000);

  afterAll(async () => {
    await writeReport();
    await cleanup();
    await sql.end({ timeout: 5 });
  }, 180_000);

  it("keeps twenty thousand nested paths paged, reachable, searchable, and deletable", async () => {
    const totalBytes = fileCount * 128;
    const deferredWorkerRunAfter = new Date(Date.now() + 3_600_000).toISOString();
    await timed("createSession", () => upload.createSession({
      id: sessionId,
      knowledgeBaseId,
      idempotencyKey: "large-nested-scale",
      declaredFileCount: fileCount,
      declaredByteCount: totalBytes,
      expiresAt: new Date(Date.now() + 3_600_000).toISOString()
    }));

    await timed("manifestRegistration", async () => {
      for (let offset = 0; offset < fileCount; offset += manifestPageSize) {
        const entries = Array.from(
          { length: Math.min(manifestPageSize, fileCount - offset) },
          (_, pageIndex) => manifestEntry(offset + pageIndex)
        );
        await upload.addManifestEntries({ knowledgeBaseId, sessionId, entries });
        sampleResources();
      }
    });

    const sealed = await timed("manifestSeal", () => upload.sealManifest({
      knowledgeBaseId,
      sessionId,
      manifestFingerprint: checksum("large-nested-scale")
    }));
    expect(sealed.counts).toMatchObject({ selected: fileCount, uploadRequired: fileCount });

    let listedEntries = 0;
    await timed("manifestPagination", async () => {
      let cursor: string | null = null;
      do {
        const page = await upload.listEntries({
          knowledgeBaseId,
          sessionId,
          limit: manifestPageSize,
          cursor
        });
        listedEntries += page.items.length;
        cursor = page.nextCursor;
        sampleResources();
      } while (cursor);
    });
    expect(listedEntries).toBe(fileCount);

    await sql`
      UPDATE focowiki.upload_session_entries
      SET transfer_state = 'uploaded',
          received_size = declared_size,
          received_checksum_sha256 = checksum_sha256,
          staging_object_key = 'validation/source/' || source_file_id,
          updated_at = now()
      WHERE session_id = ${sessionId}
        AND disposition = 'upload_required'
    `;
    await upload.finalizeSession({
      knowledgeBaseId,
      sessionId,
      now: new Date().toISOString()
    });

    let finalized = 0;
    await timed("boundedFinalization", async () => {
      let completed = false;
      while (!completed) {
        const result = await upload.finalizeEntryBatch({
          knowledgeBaseId,
          sessionId,
          now: new Date().toISOString(),
          runAfter: deferredWorkerRunAfter,
          limit: manifestPageSize,
          jobMaxAttempts: 3
        });
        expect(result.processedCount).toBeLessThanOrEqual(manifestPageSize);
        finalized += result.processedCount;
        completed = result.completed;
        sampleResources();
      }
    });
    expect(finalized).toBe(fileCount);
    await upload.completeSession({ knowledgeBaseId, sessionId, now: new Date().toISOString() });

    const durableCounts = await sql<Array<{
      source_files: number;
      source_revisions: number;
      worker_jobs: number;
    }>>`
      SELECT
        (SELECT count(*)::int FROM focowiki.source_files WHERE knowledge_base_id = ${knowledgeBaseId}) AS source_files,
        (SELECT count(*)::int FROM focowiki.source_revisions WHERE knowledge_base_id = ${knowledgeBaseId}) AS source_revisions,
        (SELECT count(*)::int FROM focowiki.worker_jobs WHERE knowledge_base_id = ${knowledgeBaseId} AND kind = 'source_file_processing') AS worker_jobs
    `;
    expect(durableCounts[0]).toEqual({
      source_files: fileCount,
      source_revisions: fileCount,
      worker_jobs: fileCount
    });

    const overlapStorage = new CountingStorage();
    let finalizationDispatchCount = 0;
    const overlapService = createUploadSessionService({
      repository: upload,
      storage: createUploadSessionStoragePort(overlapStorage),
      runtime: {
        clock: { now: () => new Date() },
        ids: { create: (prefix) => `${prefix}-${randomUUID()}` }
      },
      finalization: {
        enqueue: async () => {
          finalizationDispatchCount += 1;
        }
      },
      sessionTtlSeconds: 3_600,
      maxFileBytes: 1_048_576
    });
    const overlapExistingCount = 1_000;
    const additionalFiles = Array.from({ length: overlapNewFileCount }, (_, index) => {
      const relativePath = `additional/group-${String(index % 4).padStart(2, "0")}/file-${String(index).padStart(3, "0")}.md`;
      const bytes = new TextEncoder().encode(
        `# Additional ${index}\n`.padEnd(128, " ")
      );
      return { relativePath, bytes };
    });
    const overlapEntries = [
      ...Array.from({ length: overlapExistingCount }, (_, index) => {
        const existing = manifestEntry(index);
        return {
          relativePath: existing.path.relativePath,
          declaredSize: existing.declaredSize,
          checksumSha256: existing.checksumSha256
        };
      }),
      ...additionalFiles.map((file) => ({
        relativePath: file.relativePath,
        declaredSize: file.bytes.byteLength,
        checksumSha256: checksumBytes(file.bytes)
      }))
    ];
    const overlapSession = await overlapService.createSession({
      knowledgeBaseId,
      idempotencyKey: "large-nested-overlap",
      declaredFileCount: overlapEntries.length,
      declaredByteCount: overlapEntries.reduce((total, entry) => total + entry.declaredSize, 0)
    });
    const overlapSessionId = overlapSession.id;
    for (let offset = 0; offset < overlapEntries.length; offset += manifestPageSize) {
      await overlapService.addManifestEntries({
        knowledgeBaseId,
        sessionId: overlapSessionId,
        entries: overlapEntries.slice(offset, offset + manifestPageSize)
      });
    }
    const overlapSealed = await overlapService.sealManifest({
      knowledgeBaseId,
      sessionId: overlapSessionId
    });
    expect(overlapSealed.counts).toMatchObject({
      selected: overlapExistingCount + overlapNewFileCount,
      skippedExisting: overlapExistingCount,
      uploadRequired: overlapNewFileCount
    });
    const additionalByPath = new Map(
      additionalFiles.map((file) => [file.relativePath, file.bytes])
    );
    let overlapCursor: string | null = null;
    do {
      const page = await overlapService.listEntries({
        knowledgeBaseId,
        sessionId: overlapSessionId,
        transferState: "missing",
        limit: manifestPageSize,
        cursor: overlapCursor
      });
      for (const entry of page.items) {
        const bytes = additionalByPath.get(entry.relativePath);
        if (!bytes) throw new Error(`Missing overlap bytes for ${entry.relativePath}`);
        await overlapService.putEntryContent({
          knowledgeBaseId,
          sessionId: overlapSessionId,
          entryId: entry.id,
          bytes
        });
      }
      overlapCursor = page.nextCursor;
    } while (overlapCursor);
    await overlapService.finalizeSession({ knowledgeBaseId, sessionId: overlapSessionId });
    let overlapFinalized = 0;
    let overlapCompleted = false;
    while (!overlapCompleted) {
      const result = await upload.finalizeEntryBatch({
        knowledgeBaseId,
        sessionId: overlapSessionId,
        now: new Date().toISOString(),
        runAfter: deferredWorkerRunAfter,
        limit: manifestPageSize,
        jobMaxAttempts: 3
      });
      overlapFinalized += result.processedCount;
      overlapCompleted = result.completed;
    }
    await upload.completeSession({
      knowledgeBaseId,
      sessionId: overlapSessionId,
      now: new Date().toISOString()
    });
    expect(overlapFinalized).toBe(overlapNewFileCount);
    expect(finalizationDispatchCount).toBe(1);
    expect(overlapStorage.putObjectKeys).toHaveLength(overlapNewFileCount);

    const overlapCounts = await sql<Array<{
      source_files: number;
      source_revisions: number;
      worker_jobs: number;
      dirty_sources: number;
      source_graph_nodes: number;
      search_documents: number;
    }>>`
      SELECT
        (SELECT count(*)::int FROM focowiki.source_files WHERE knowledge_base_id = ${knowledgeBaseId}) AS source_files,
        (SELECT count(*)::int FROM focowiki.source_revisions WHERE knowledge_base_id = ${knowledgeBaseId}) AS source_revisions,
        (SELECT count(*)::int FROM focowiki.worker_jobs WHERE knowledge_base_id = ${knowledgeBaseId} AND kind = 'source_file_processing') AS worker_jobs,
        (SELECT count(*)::int FROM focowiki.source_files WHERE knowledge_base_id = ${knowledgeBaseId} AND publication_dirty_at IS NOT NULL) AS dirty_sources,
        (SELECT count(*)::int FROM focowiki.source_file_graph_nodes WHERE knowledge_base_id = ${knowledgeBaseId}) AS source_graph_nodes,
        (SELECT count(*)::int FROM focowiki.knowledge_graph_search_documents WHERE knowledge_base_id = ${knowledgeBaseId}) AS search_documents
    `;
    expect(overlapCounts[0]).toEqual({
      source_files: totalFileCount,
      source_revisions: totalFileCount,
      worker_jobs: totalFileCount,
      dirty_sources: 0,
      source_graph_nodes: 0,
      search_documents: 0
    });

    await sql`
      UPDATE focowiki.source_files
      SET processing_status = 'completed',
          processing_stage = 'release_activation',
          generated_output_status = 'visible',
          generated_bundle_file_path = 'pages/' || relative_path,
          publication_dirty_at = now(),
          metadata_json = jsonb_build_object('title', name)
      WHERE knowledge_base_id = ${knowledgeBaseId}
    `;
    await sql`
      INSERT INTO focowiki.releases (
        id, knowledge_base_id, bundle_root_key, generated_at,
        file_count, manifest_checksum_sha256, catalog_generation
      ) VALUES (
        ${releaseId}, ${knowledgeBaseId}, 'validation/release', now(),
        0, ${checksum("release")}, 0
      )
    `;
    const publicationTargets = await sql<Array<{ id: string }>>`
      SELECT id
      FROM focowiki.source_files
      WHERE knowledge_base_id = ${knowledgeBaseId}
        AND publication_dirty_at IS NOT NULL
      ORDER BY id
    `;
    expect(publicationTargets).toHaveLength(totalFileCount);
    const snapshot = await timed("publicationPlanning", () =>
      publication.materializeSourceSnapshot({
        knowledgeBaseId,
        releaseId,
        publicationSourceFileIds: publicationTargets.map((source) => source.id)
      })
    );
    const missingSnapshotSources = await sql<Array<{
      id: string;
      relative_path: string;
      path_key: string;
      processing_status: string;
      deleted_at: Date | null;
      deletion_intent_id: string | null;
      candidate_operation_id: string | null;
      conflicting_source_file_id: string | null;
    }>>`
      SELECT source.id, source.relative_path, source.path_key,
             source.processing_status, source.deleted_at, source.deletion_intent_id,
             source.candidate_operation_id,
             conflict.source_file_id AS conflicting_source_file_id
      FROM focowiki.source_files source
      LEFT JOIN focowiki.release_source_files conflict
        ON conflict.release_id = ${releaseId}
       AND conflict.path_key = source.path_key
      WHERE source.knowledge_base_id = ${knowledgeBaseId}
        AND NOT EXISTS (
          SELECT 1
          FROM focowiki.release_source_files snapshot_source
          WHERE snapshot_source.release_id = ${releaseId}
            AND snapshot_source.source_file_id = source.id
        )
      ORDER BY source.path_key COLLATE "C", source.id
    `;
    expect(
      snapshot.sourceFileCount,
      `Missing release snapshot sources: ${JSON.stringify(missingSnapshotSources)}`
    ).toBe(totalFileCount);

    let plannedSourceCount = 0;
    let sourceCursor: string | null = null;
    do {
      const page = await publication.listSourceFiles({
        knowledgeBaseId,
        releaseId,
        cursor: sourceCursor,
        limit: manifestPageSize
      });
      plannedSourceCount += page.items.length;
      sourceCursor = page.nextCursor;
    } while (sourceCursor);
    expect(plannedSourceCount).toBe(totalFileCount);

    await seedBundleFiles();
    const navigationLinkCounts = new Map<string, number>();
    let navigationFileCount = 0;
    let maxNavigationFileBytes = 0;
    let maxNavigationWriteBatchSize = 0;
    await timed("indexPagination", () => writeDirectoryNavigationFiles({
      generatedAt: new Date().toISOString(),
      pageSize: manifestPageSize,
      maxEntriesPerPage: 200,
      maxBytesPerPage: 65_536,
      fetchEntryPage: (request) => publication.listNavigationEntries({
        knowledgeBaseId,
        releaseId,
        ...request
      }),
      writeFiles: async (files) => {
        navigationFileCount += files.length;
        maxNavigationWriteBatchSize = Math.max(maxNavigationWriteBatchSize, files.length);
        for (const file of files) {
          maxNavigationFileBytes = Math.max(
            maxNavigationFileBytes,
            new TextEncoder().encode(file.content).byteLength
          );
          collectSourceLinks(file.logicalPath, file.content, navigationLinkCounts);
        }
        sampleResources();
      }
    }));
    expect(navigationFileCount).toBeGreaterThan(100);
    expect(maxNavigationFileBytes).toBeLessThanOrEqual(65_536);
    expect(maxNavigationWriteBatchSize).toBe(1);
    expect(navigationLinkCounts.size).toBe(totalFileCount);
    expect([...navigationLinkCounts.values()].every((count) => count === 1)).toBe(true);

    await timed("treeMaterialization", () =>
      publication.materializeTree({ knowledgeBaseId, releaseId })
    );
    await timed("searchIndexFinalization", () => cleanReleaseReadModelGinPendingLists(sql));
    expect(metrics.phases.treeMaterialization?.durationMs).toBeLessThan(10_000);
    const fileRepository = repositories.files;
    if (!fileRepository?.listBundleTreeEntries || !fileRepository.searchBundleTreeEntries || !fileRepository.searchBundleFiles) {
      throw new Error("Scale read repositories are unavailable");
    }

    const readDurations: number[] = [];
    for (let index = 0; index < 30; index += 1) {
      const started = performance.now();
      const [tree, treeSearch, fileSearch] = await Promise.all([
        fileRepository.listBundleTreeEntries({
          knowledgeBaseId,
          releaseId,
          parentPath: "pages/bulk",
          entryType: null,
          limit: 100,
          cursor: null
        }),
        fileRepository.searchBundleTreeEntries({
          knowledgeBaseId,
          releaseId,
          query: `file-${String(19_900 + index).padStart(6, "0")}`,
          entryType: "file",
          limit: 10,
          cursor: null
        }),
        fileRepository.searchBundleFiles({
          knowledgeBaseId,
          releaseId,
          query: `file-${String(19_900 + index).padStart(6, "0")}`,
          scope: "all",
          fileKind: "page",
          limit: 10,
          cursor: null
        })
      ]);
      expect(tree.items.length).toBe(100);
      expect(treeSearch.items.length).toBeGreaterThan(0);
      expect(fileSearch.items.length).toBeGreaterThan(0);
      readDurations.push(performance.now() - started);
      sampleResources();
    }
    metrics.readLatency = summarizeLatency(readDurations);
    expect(metrics.readLatency.p95Ms).toBeLessThan(2_000);
    expect(metrics.readLatency.maxMs).toBeLessThan(10_000);
    expect(metrics.peakRssBytes).toBeLessThan(512 * 1024 * 1024);

    const bulkDirectory = await sql<Array<{ id: string }>>`
      SELECT id FROM focowiki.source_directories
      WHERE knowledge_base_id = ${knowledgeBaseId} AND path_key = 'bulk'
    `;
    const bulkDirectoryId = bulkDirectory[0]?.id;
    if (!bulkDirectoryId) throw new Error("Bulk directory was not materialized");
    const deletionIntentId = "deletion-intent-large-scale";
    await sql`
      INSERT INTO focowiki.deletion_intents (
        id, knowledge_base_id, target_kind, target_id, catalog_generation
      ) VALUES (${deletionIntentId}, ${knowledgeBaseId}, 'source_directory', ${bulkDirectoryId}, 1)
    `;
    await sql`
      UPDATE focowiki.source_files
      SET deletion_intent_id = ${deletionIntentId}, deleted_at = now()
      WHERE knowledge_base_id = ${knowledgeBaseId}
        AND directory_id = ${bulkDirectoryId}
    `;
    let deletionPageCount = 0;
    let deletionSourceCount = 0;
    let deletionCursor: string | null = null;
    await timed("deletionPagination", async () => {
      do {
        const page = await hardDelete.listSourceDirectorySourceFileIds({
          knowledgeBaseId,
          deletionIntentId,
          cursor: deletionCursor,
          limit: manifestPageSize
        });
        expect(page.items.length).toBeLessThanOrEqual(manifestPageSize);
        deletionPageCount += 1;
        deletionSourceCount += page.items.length;
        deletionCursor = page.nextCursor;
        sampleResources();
      } while (deletionCursor);
    });
    expect(deletionSourceCount).toBe(10_000);
    expect(deletionPageCount).toBe(20);

    metrics.counts = {
      fileCount: totalFileCount,
      overlapExistingCount,
      overlapNewFileCount,
      overlapStorageWriteCount: overlapStorage.putObjectKeys.length,
      directoryCount: snapshot.directoryCount,
      navigationFileCount,
      maxNavigationFileBytes,
      maxNavigationWriteBatchSize,
      deletionPageCount
    };
  }, 180_000);

  function manifestEntry(index: number) {
    const relativePath = index < 10_000
      ? `bulk/file-${String(index).padStart(6, "0")}.md`
      : `areas/area-${String(index % 100).padStart(3, "0")}/section-${String(Math.floor(index / 100) % 20).padStart(2, "0")}/file-${String(index).padStart(6, "0")}.md`;
    return {
      id: `upload-entry-${String(index).padStart(6, "0")}`,
      sourceFileId: `source-file-${String(index).padStart(6, "0")}`,
      path: normalizeSourceRelativePath(relativePath),
      declaredSize: 128,
      checksumSha256: checksum(relativePath)
    };
  }

  async function seedBundleFiles() {
    await sql`
      INSERT INTO focowiki.bundle_files (
        id, knowledge_base_id, release_id, source_file_id, file_kind,
        logical_path, object_key, content_type, size_bytes, checksum_sha256,
        title, frontmatter_json, navigation_only, source_directory_id
      )
      SELECT 'bundle-file-' || md5(snapshot.source_file_id), snapshot.knowledge_base_id,
             snapshot.release_id, snapshot.source_file_id, 'page', snapshot.generated_path,
             'validation/bundle/' || snapshot.source_file_id, snapshot.content_type,
             snapshot.size_bytes, snapshot.checksum_sha256, snapshot.name,
             jsonb_build_object('type', 'page', 'title', snapshot.name), false,
             snapshot.source_directory_id
      FROM focowiki.release_source_files snapshot
      WHERE snapshot.knowledge_base_id = ${knowledgeBaseId}
        AND snapshot.release_id = ${releaseId}
    `;
    await sql`
      INSERT INTO focowiki.bundle_file_search_documents (
        bundle_file_id, knowledge_base_id, release_id, source_file_id,
        file_kind, logical_path, path_text, title_text, description_text,
        metadata_text, search_text
      )
      SELECT file.id, file.knowledge_base_id, file.release_id, file.source_file_id,
             file.file_kind, file.logical_path, lower(file.logical_path),
             lower(COALESCE(file.title, '')), '', 'type page',
             lower(file.logical_path || ' ' || COALESCE(file.title, '') || ' type page')
      FROM focowiki.bundle_files file
      WHERE file.knowledge_base_id = ${knowledgeBaseId}
        AND file.release_id = ${releaseId}
        AND file.navigation_only = false
    `;
  }

  async function cleanup() {
    const rows = await sql<Array<{ count: number }>>`
      SELECT count(*)::int AS count
      FROM focowiki.knowledge_bases
      WHERE id = ${knowledgeBaseId}
    `;
    if ((rows[0]?.count ?? 0) > 0) {
      await hardDelete.purgeKnowledgeBaseData({
        jobId: "worker-job-large-scale-cleanup",
        knowledgeBaseId,
        batchSize: 1_000
      });
    }
  }

  async function timed<T>(name: string, work: () => Promise<T>): Promise<T> {
    const started = performance.now();
    const cpuStarted = process.cpuUsage();
    const result = await work();
    const cpu = process.cpuUsage(cpuStarted);
    metrics.phases[name] = {
      durationMs: round(performance.now() - started),
      cpuUserMs: round(cpu.user / 1_000),
      cpuSystemMs: round(cpu.system / 1_000)
    };
    sampleResources();
    return result;
  }

  function sampleResources() {
    metrics.peakRssBytes = Math.max(metrics.peakRssBytes, process.memoryUsage().rss);
  }

  async function writeReport() {
    const reportDir = process.env.FOCOWIKI_VALIDATION_REPORT_DIR
      ? resolve(process.env.FOCOWIKI_VALIDATION_REPORT_DIR)
      : resolve(
          import.meta.dirname,
          "../../../openspec/changes/improve-okf-navigation-and-metadata-quality"
        );
    await mkdir(reportDir, { recursive: true });
    await writeFile(
      resolve(reportDir, "large-nested-scale-report.json"),
      `${JSON.stringify(metrics, null, 2)}\n`,
      "utf8"
    );
  }
});

function collectSourceLinks(
  logicalPath: string,
  content: string,
  counts: Map<string, number>
) {
  const directory = logicalPath.slice(0, logicalPath.lastIndexOf("/"));
  for (const match of content.matchAll(/\]\(([^)]+\.md)\)/gu)) {
    const target = decodeURIComponent(match[1] ?? "");
    const name = target.split("/").at(-1) ?? target;
    if (/^(?:index|index-map)(?:-\d+)?\.md$/u.test(name)) {
      continue;
    }
    const path = `${directory}/${target}`;
    counts.set(path, (counts.get(path) ?? 0) + 1);
  }
}

function createMetrics() {
  return {
    generatedAt: new Date().toISOString(),
    phases: {} as Record<string, { durationMs: number; cpuUserMs: number; cpuSystemMs: number }>,
    peakRssBytes: process.memoryUsage().rss,
    readLatency: { p50Ms: 0, p95Ms: 0, maxMs: 0 },
    counts: {} as Record<string, number>
  };
}

function summarizeLatency(values: number[]) {
  const sorted = [...values].sort((left, right) => left - right);
  return {
    p50Ms: round(percentile(sorted, 0.5)),
    p95Ms: round(percentile(sorted, 0.95)),
    maxMs: round(sorted.at(-1) ?? 0)
  };
}

function percentile(sorted: number[], rank: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * rank) - 1)] ?? 0;
}

function checksum(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function checksumBytes(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

class CountingStorage implements StorageAdapter {
  public readonly keyspace = createStorageKeyspace("validation");
  public readonly putObjectKeys: string[] = [];
  private readonly objects = new Map<string, string>();

  public async putObject(object: StoredObject): Promise<void> {
    this.putObjectKeys.push(object.key);
    this.objects.set(
      object.key,
      typeof object.body === "string" ? object.body : new TextDecoder().decode(object.body)
    );
  }

  public async getObjectText(key: string): Promise<string | null> {
    return this.objects.get(key) ?? null;
  }

  public async deleteObject(key: string): Promise<void> {
    this.objects.delete(key);
  }
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
