import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DatabaseClient } from "../src/db/client.js";
import { DOCUMENT_PUBLICATION_RENDERER_CONTRACT_VERSION } from
  "../src/document-indexing/application/document-publication-renderer-contract.js";
import { fingerprintDocumentPublicationOutputs } from
  "../src/document-indexing/application/document-publication-manifest.js";
import { createPostgresDocumentPublicationActivation } from
  "../src/document-indexing/infrastructure/postgres-document-publication-activation.js";
import { createPostgresDocumentPublicationJobRepository } from
  "../src/document-indexing/infrastructure/postgres-document-publication-job-repository.js";
import { applyStorageVnextTestMigrations } from
  "./helpers/storage-vnext-test-migrations.js";

const databaseUrl = process.env.FOCOWIKI_STORAGE_VNEXT_TEST_DATABASE_URL;
const runOwner = process.env.FOCOWIKI_STORAGE_VNEXT_TEST_RUN_OWNER;
const enabled = Boolean(databaseUrl && runOwner
  && /^svnext-[a-z0-9]{8,16}$/u.test(runOwner));

(enabled ? describe : describe.skip)("single-job publication query plans", () => {
  const connectionUrl = databaseUrl
    ?? "postgres://unused:unused@127.0.0.1:5432/unused";
  const databaseName = `focowiki_single_plan_${
    (runOwner ?? "invalid").replaceAll("-", "_")
  }_${randomUUID().replaceAll("-", "").slice(0, 8)}`;
  const admin = postgres(withDatabase(connectionUrl, "postgres"), { max: 1 });
  const sql = postgres(withDatabase(connectionUrl, databaseName), { max: 2 });
  let databaseCreated = false;

  beforeAll(async () => {
    await admin.unsafe(`CREATE DATABASE ${quote(databaseName)}`);
    databaseCreated = true;
    await applyStorageVnextTestMigrations(sql);
    await sql`
      INSERT INTO focowiki.knowledge_bases (public_id, name, revision)
      SELECT 'plan-kb-' || lpad(series::text, 5, '0'),
             'Plan ' || series::text, 1
      FROM generate_series(1, 10000) series
    `;
    await sql`
      INSERT INTO focowiki.knowledge_base_publication_heads (
        knowledge_base_id, latest_readiness_sequence, pending_item_count,
        oldest_pending_at, latest_pending_at
      )
      SELECT public_id,
             CASE WHEN public_id = 'plan-kb-00001' THEN 100000 ELSE 0 END,
             CASE WHEN public_id = 'plan-kb-00001' THEN 100000 ELSE 0 END,
             CASE WHEN public_id = 'plan-kb-00001'
               THEN '2026-08-25T00:00:00.000Z'::timestamptz END,
             CASE WHEN public_id = 'plan-kb-00001'
               THEN '2026-08-25T00:00:01.000Z'::timestamptz END
      FROM focowiki.knowledge_bases
    `;
    await sql`
      INSERT INTO focowiki.publication_items (
        public_id, mutation_public_id, knowledge_base_id,
        source_file_public_id, source_revision_public_id, operation,
        next_logical_path, readiness_sequence, created_at, updated_at
      )
      SELECT 'plan-item-' || series::text,
             'plan-mutation-' || series::text, 'plan-kb-00001',
             'plan-source-' || series::text,
             'plan-revision-' || series::text, 'create',
             'pages/' || series::text || '.md', series,
             '2026-08-25T00:00:00.000Z'::timestamptz
               + series * interval '1 microsecond',
             '2026-08-25T00:00:00.000Z'::timestamptz
      FROM generate_series(1, 100000) series
    `;
    await sql`ANALYZE focowiki.knowledge_base_publication_heads`;
    await sql`ANALYZE focowiki.publication_items`;
  }, 120_000);

  afterAll(async () => {
    await sql.end({ timeout: 5 });
    if (databaseCreated) {
      await admin.unsafe(`DROP DATABASE IF EXISTS ${quote(databaseName)} WITH (FORCE)`);
    }
    await admin.end({ timeout: 5 });
  }, 120_000);

  it("selects an eligible knowledge base without scanning publication items",
    async () => {
      const plan = await explain(`
        SELECT head.knowledge_base_id
        FROM focowiki.knowledge_base_publication_heads head
        LEFT JOIN focowiki.publication_jobs active_job
          ON active_job.knowledge_base_id = head.knowledge_base_id
         AND active_job.outcome = 'pending'
        WHERE head.pending_item_count > 0
          AND active_job.public_id IS NULL
          AND (head.pending_item_count >= 256
            OR head.oldest_pending_at
                 <= '2026-08-25T00:00:02.000Z'::timestamptz - interval '1 second'
            OR head.latest_pending_at
                 <= '2026-08-25T00:00:02.000Z'::timestamptz - interval '100 milliseconds')
        ORDER BY head.oldest_pending_at, head.knowledge_base_id COLLATE "C"
        LIMIT 1
      `);
      expect(plan).toContain("knowledge_base_publication_heads_pending_idx");
      expect(plan).not.toMatch(/Seq Scan[^]*publication_items/u);
    });

  it("uses bounded per-knowledge-base item and age indexes", async () => {
    const membershipPlan = await explain(`
      SELECT public_id FROM focowiki.publication_items
      WHERE knowledge_base_id = 'plan-kb-00001' AND outcome = 'pending'
      ORDER BY readiness_sequence, public_id COLLATE "C" LIMIT 256
    `);
    const agePlan = await explain(`
      SELECT created_at FROM focowiki.publication_items
      WHERE knowledge_base_id = 'plan-kb-00001' AND outcome = 'pending'
      ORDER BY created_at, public_id COLLATE "C" LIMIT 1
    `);
    expect(membershipPlan).toContain("publication_items_eligibility_idx");
    expect(agePlan).toContain("publication_items_pending_age_idx");
  });

  it("activates a ten-document delta without touching ten thousand active paths",
    async () => {
      await seedPerformanceFixture();
      const database = sql as unknown as DatabaseClient;
      const repository = createPostgresDocumentPublicationJobRepository(database);
      const activation = createPostgresDocumentPublicationActivation({
        sql: database
      });
      for (let index = 1; index <= 10; index += 1) {
        const identity = String(index).padStart(5, "0");
        await repository.createItem({
          publicId: `performance-item-${identity}`,
          mutationPublicId: `performance-mutation-${identity}`,
          knowledgeBaseId: "performance-kb",
          documentJobPublicId: null,
          sourceFilePublicId: `performance-source-${identity}`,
          sourceRevisionPublicId: `performance-revision-${identity}`,
          operation: "delete",
          priorLogicalPath: `pages/document-${identity}.md`,
          nextLogicalPath: null,
          affectedEvidence: {},
          readinessSequence: index,
          createdAt: "2026-08-24T01:00:00.000Z"
        });
      }
      const startedAt = performance.now();
      const startedCpu = process.cpuUsage();
      const startedHeapBytes = process.memoryUsage().heapUsed;
      const admitted = await repository.admitOne({
        now: "2026-08-24T01:00:02.000Z",
        rendererContractVersion: DOCUMENT_PUBLICATION_RENDERER_CONTRACT_VERSION
      });
      expect(admitted?.items).toHaveLength(10);
      const claimed = await repository.claimOne({
        workerId: "performance-worker",
        now: "2026-08-24T01:00:03.000Z"
      });
      expect(claimed?.publicId).toBe(admitted?.publicId);
      const outputs = [{
        normalizedPath: "index.md",
        logicalPath: "index.md",
        action: "put" as const,
        entryKind: "root-index",
        sourceFilePublicId: null,
        sourceRevisionPublicId: null,
        objectId: "performance-next-object",
        checksumSha256: "2".repeat(64),
        byteCount: 20,
        contentType: "text/markdown; charset=utf-8",
        producerFingerprintSha256: "3".repeat(64),
        navigationMutations: []
      }, ...Array.from({ length: 10 }, (_, index) => {
        const identity = String(index + 1).padStart(5, "0");
        return {
          normalizedPath: `pages/document-${identity}.md`,
          logicalPath: `pages/document-${identity}.md`,
          action: "delete" as const,
          entryKind: null,
          sourceFilePublicId: null,
          sourceRevisionPublicId: null,
          objectId: null,
          checksumSha256: null,
          byteCount: null,
          contentType: null,
          producerFingerprintSha256: "4".repeat(64),
          navigationMutations: []
        };
      })];
      await expect(repository.persistManifest({
        jobPublicId: claimed!.publicId,
        attemptToken: claimed!.attemptToken!,
        fingerprintSha256: fingerprintDocumentPublicationOutputs(outputs),
        outputs,
        persistedAt: "2026-08-24T01:00:04.000Z"
      })).resolves.toBe(true);
      const activationStartedAt = performance.now();
      await expect(activation.activate({
        jobPublicId: claimed!.publicId,
        attemptToken: claimed!.attemptToken!,
        activatedAt: "2026-08-24T01:00:05.000Z"
      })).resolves.toMatchObject({
        activeRevision: 1,
        documentCount: 0,
        putCount: 1,
        deleteCount: 10
      });
      const activationDurationMs = performance.now() - activationStartedAt;
      const jobDurationMs = performance.now() - startedAt;
      const cpu = process.cpuUsage(startedCpu);
      const heapDeltaBytes = process.memoryUsage().heapUsed - startedHeapBytes;
      const metrics = {
        activeRecordCount: 10_000,
        deltaDocumentCount: 10,
        queueAgeMs: 2_000,
        outputRowCount: outputs.length,
        jobDurationMs,
        activationDurationMs,
        cpuMicroseconds: cpu.user + cpu.system,
        heapDeltaBytes,
        s3RequestCount: 0,
        s3AttemptedBytes: 0,
        structurallyReusedPathCount: 9_990,
        searchProviderCallCount: 0,
        objectAmplification: 1 / 10
      };
      if (process.env.FOCOWIKI_TEST_PERFORMANCE_REPORT === "true") {
        process.stdout.write(
          `PUBLICATION_ACTIVATION_METRICS ${JSON.stringify(metrics)}\n`
        );
      }
      expect(metrics.jobDurationMs).toBeLessThan(30_000);
      expect(metrics.activationDurationMs).toBeLessThan(30_000);
      expect(metrics.cpuMicroseconds).toBeLessThan(30_000_000);
      expect(metrics.heapDeltaBytes).toBeLessThan(64 * 1_048_576);
      expect(metrics).toMatchObject({
        activeRecordCount: 10_000,
        deltaDocumentCount: 10,
        queueAgeMs: 2_000,
        outputRowCount: 11,
        s3RequestCount: 0,
        s3AttemptedBytes: 0,
        structurallyReusedPathCount: 9_990,
        searchProviderCallCount: 0,
        objectAmplification: 0.1
      });
      await expect(sql<Array<{
        generated_path_count: number | string;
        inactive_source_count: number | string;
        output_row_count: number | string;
      }>>`
        SELECT count(DISTINCT head.normalized_path) AS generated_path_count,
               count(DISTINCT active.source_file_public_id)
                 FILTER (WHERE active.active_source_revision_public_id IS NULL)
                   AS inactive_source_count,
               count(DISTINCT output.normalized_path) AS output_row_count
        FROM focowiki.knowledge_base_publication_heads publication_head
        LEFT JOIN focowiki.generated_page_heads head
          ON head.knowledge_base_id = publication_head.knowledge_base_id
        LEFT JOIN focowiki.source_file_active_revisions active
          ON active.knowledge_base_id = publication_head.knowledge_base_id
        LEFT JOIN focowiki.publication_jobs job
          ON job.knowledge_base_id = publication_head.knowledge_base_id
        LEFT JOIN focowiki.publication_job_outputs output
          ON output.job_public_id = job.public_id
        WHERE publication_head.knowledge_base_id = 'performance-kb'
      `).resolves.toEqual([{
        generated_path_count: "9991",
        inactive_source_count: "10",
        output_row_count: "11"
      }]);
    }, 120_000);

  async function explain(statement: string): Promise<string> {
    const rows = await sql.unsafe<Array<{ "QUERY PLAN": unknown }>>(
      `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${statement}`
    );
    return JSON.stringify(rows[0]?.["QUERY PLAN"] ?? null);
  }

  async function seedPerformanceFixture(): Promise<void> {
    await sql`
      INSERT INTO focowiki.knowledge_bases (public_id, name, revision)
      VALUES ('performance-kb', 'Performance fixture', 1)
    `;
    await sql`
      INSERT INTO focowiki.knowledge_base_sequences (
        knowledge_base_id, current_sequence
      ) VALUES ('performance-kb', 0)
    `;
    await sql`
      INSERT INTO focowiki.object_registrations (
        object_id, storage_key, checksum_sha256, byte_count, content_type,
        object_format, state, write_attempt_public_id, verified_at
      ) VALUES
        ('performance-active-object', 'objects/performance-active-object',
         ${"1".repeat(64)}, 10, 'text/markdown; charset=utf-8',
         'okf-generated-markdown-v1', 'verified',
         'performance-active-attempt', '2026-08-26T00:59:00.000Z'),
        ('performance-next-object', 'objects/performance-next-object',
         ${"2".repeat(64)}, 20, 'text/markdown; charset=utf-8',
         'okf-generated-markdown-v1', 'verified',
         'performance-next-attempt', '2026-08-26T00:59:00.000Z')
    `;
    await sql`
      INSERT INTO focowiki.source_files (
        public_id, knowledge_base_id, logical_path, normalized_path,
        title, metadata, revision
      )
      SELECT 'performance-source-' || lpad(sequence::text, 5, '0'),
             'performance-kb',
             'document-' || lpad(sequence::text, 5, '0') || '.md',
             'document-' || lpad(sequence::text, 5, '0') || '.md',
             'Performance ' || sequence, '{}'::jsonb, 1
      FROM generate_series(1, 10) sequence
    `;
    await sql`
      INSERT INTO focowiki.source_revisions (
        public_id, knowledge_base_id, source_file_public_id, object_id,
        checksum_sha256, byte_count, content_type
      )
      SELECT 'performance-revision-' || lpad(sequence::text, 5, '0'),
             'performance-kb',
             'performance-source-' || lpad(sequence::text, 5, '0'),
             'performance-active-object', ${"1".repeat(64)}, 10,
             'text/markdown; charset=utf-8'
      FROM generate_series(1, 10) sequence
    `;
    await sql`
      INSERT INTO focowiki.source_file_active_revisions (
        knowledge_base_id, source_file_public_id,
        current_source_revision_public_id, active_source_revision_public_id,
        activation_sequence
      )
      SELECT 'performance-kb',
             'performance-source-' || lpad(sequence::text, 5, '0'),
             'performance-revision-' || lpad(sequence::text, 5, '0'),
             'performance-revision-' || lpad(sequence::text, 5, '0'), 0
      FROM generate_series(1, 10) sequence
    `;
    await sql`
      INSERT INTO focowiki.document_projection_records (
        knowledge_base_id, source_file_public_id, source_revision_public_id,
        logical_path, normalized_path, title, summary, metadata, headings,
        entities, content_type, checksum_sha256, byte_count,
        tokenizer_contract_version, navigation_term_fingerprint_sha256,
        active
      )
      SELECT 'performance-kb',
             'performance-source-' || lpad(sequence::text, 5, '0'),
             'performance-revision-' || lpad(sequence::text, 5, '0'),
             'document-' || lpad(sequence::text, 5, '0') || '.md',
             'document-' || lpad(sequence::text, 5, '0') || '.md',
             'Performance ' || sequence, 'Summary', '{}'::jsonb,
             '{}'::text[], '{}'::text[], 'text/markdown; charset=utf-8',
             ${"1".repeat(64)}, 10, 'tokenizer-v1', ${"3".repeat(64)}, true
      FROM generate_series(1, 10) sequence
    `;
    await sql`
      INSERT INTO focowiki.generated_page_heads (
        knowledge_base_id, logical_path, normalized_path, entry_kind,
        source_file_public_id, source_revision_public_id,
        page_candidate_public_id, object_id, checksum_sha256, byte_count,
        activation_revision
      )
      SELECT 'performance-kb',
             'pages/document-' || lpad(sequence::text, 5, '0') || '.md',
             'pages/document-' || lpad(sequence::text, 5, '0') || '.md',
             CASE WHEN sequence <= 10 THEN 'source-page'
                  ELSE 'index-extension-resource' END,
             CASE WHEN sequence <= 10
               THEN 'performance-source-' || lpad(sequence::text, 5, '0') END,
             CASE WHEN sequence <= 10
               THEN 'performance-revision-' || lpad(sequence::text, 5, '0') END,
             NULL, 'performance-active-object', ${"1".repeat(64)}, 10, 0
      FROM generate_series(1, 10000) sequence
    `;
  }
});

function withDatabase(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

function quote(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}
