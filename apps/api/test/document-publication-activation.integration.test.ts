import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DatabaseClient } from "../src/db/client.js";
import { createPostgresDocumentPublicationActivation } from
  "../src/document-indexing/infrastructure/postgres-document-publication-activation.js";
import { activatePostgresDocumentPublicationPages } from
  "../src/document-indexing/infrastructure/postgres-document-publication-page-activation.js";
import { createPostgresDocumentPublicationRecovery } from
  "../src/document-indexing/infrastructure/postgres-document-publication-recovery.js";
import { updatePostgresDocumentJobSummary } from
  "../src/document-indexing/infrastructure/postgres-document-work-completion.js";
import { applyStorageVnextTestMigrations } from
  "./helpers/storage-vnext-test-migrations.js";

const databaseUrl = process.env.FOCOWIKI_STORAGE_VNEXT_TEST_DATABASE_URL;
const runOwner = process.env.FOCOWIKI_STORAGE_VNEXT_TEST_RUN_OWNER;
const enabled = Boolean(databaseUrl && runOwner
  && /^svnext-[a-z0-9]{8,16}$/u.test(runOwner));

(enabled ? describe : describe.skip)("document publication activation", () => {
  const connectionUrl = databaseUrl
    ?? "postgres://unused:unused@127.0.0.1:5432/unused";
  const databaseName = `focowiki_publication_activation_${
    (runOwner ?? "invalid").replaceAll("-", "_")
  }_${randomUUID().replaceAll("-", "").slice(0, 8)}`;
  const admin = postgres(withDatabase(connectionUrl, "postgres"), { max: 1 });
  const sql = postgres(withDatabase(connectionUrl, databaseName), { max: 8 });
  const database = sql as unknown as DatabaseClient;
  let databaseCreated = false;

  beforeAll(async () => {
    await admin.unsafe(`CREATE DATABASE ${quote(databaseName)}`);
    databaseCreated = true;
    await applyStorageVnextTestMigrations(sql);
  }, 120_000);

  afterAll(async () => {
    await sql.end({ timeout: 5 });
    if (databaseCreated) {
      await admin.unsafe(`DROP DATABASE IF EXISTS ${quote(databaseName)} WITH (FORCE)`);
    }
    await admin.end({ timeout: 5 });
  }, 120_000);

  it("atomically advances one generation and preserves the old head on failure",
    async () => {
      await seedKnowledgeBase("activation-kb");
      await seedReadyGeneration({
        knowledgeBaseId: "activation-kb",
        generationPublicId: "activation-generation-1",
        baseGenerationPublicId: null,
        targetFactEpoch: 1,
        objectId: "activation-object-1"
      });
      const activation = createPostgresDocumentPublicationActivation({ sql: database });
      await expect(activation.activate({
        generationPublicId: "activation-generation-1",
        expectedHeadVersion: 0,
        activatedAt: "2026-08-21T13:00:00.000Z"
      })).resolves.toMatchObject({
        headVersion: 1,
        putCount: 1,
        documentCount: 0
      });
      await expect(readVisible("activation-kb")).resolves.toEqual([{
        active_generation_public_id: "activation-generation-1",
        head_version: "1",
        object_id: "activation-object-1",
        projection_generation_public_id: "activation-generation-1"
      }]);

      await seedReadyGeneration({
        knowledgeBaseId: "activation-kb",
        generationPublicId: "activation-generation-2",
        baseGenerationPublicId: "activation-generation-1",
        targetFactEpoch: 2,
        objectId: "activation-object-2"
      });
      const interrupted = createPostgresDocumentPublicationActivation({
        sql: database,
        beforeHeadAdvance: async () => {
          throw new Error("INJECTED_ACTIVATION_INTERRUPTION");
        }
      });
      await expect(interrupted.activate({
        generationPublicId: "activation-generation-2",
        expectedHeadVersion: 1,
        activatedAt: "2026-08-21T13:01:00.000Z"
      })).rejects.toThrow("INJECTED_ACTIVATION_INTERRUPTION");
      await expect(readVisible("activation-kb")).resolves.toEqual([{
        active_generation_public_id: "activation-generation-1",
        head_version: "1",
        object_id: "activation-object-1",
        projection_generation_public_id: "activation-generation-1"
      }]);
      const candidate = await sql<Array<{ state: string }>>`
        SELECT state FROM focowiki.projection_publication_generations
        WHERE public_id = 'activation-generation-2'
      `;
      expect(candidate).toEqual([{ state: "ready" }]);
    });

  it("rejects a stale-base candidate without changing active reads", async () => {
    await expect(createPostgresDocumentPublicationActivation({ sql: database })
      .activate({
        generationPublicId: "activation-generation-2",
        expectedHeadVersion: 0,
        activatedAt: "2026-08-21T13:02:00.000Z"
      })).rejects.toMatchObject({ code: "publication_generation_stale_base" });
    await expect(readVisible("activation-kb")).resolves.toEqual([{
      active_generation_public_id: "activation-generation-1",
      head_version: "1",
      object_id: "activation-object-1",
      projection_generation_public_id: "activation-generation-1"
    }]);
  });

  it("binds a related source page to its own snapshot revision", async () => {
    await seedKnowledgeBase("related-source-page-kb");
    for (const suffix of ["a", "b"] as const) {
      await sql`
        INSERT INTO focowiki.object_registrations (
          object_id, storage_key, checksum_sha256, byte_count, content_type,
          object_format, state, write_attempt_public_id, verified_at
        ) VALUES (
          ${`related-source-object-${suffix}`},
          ${`objects/related-source-object-${suffix}`},
          ${suffix.repeat(64)}, 1, 'text/markdown; charset=utf-8',
          'source-markdown-v1', 'verified',
          ${`related-source-attempt-${suffix}`},
          '2026-08-21T12:58:00.000Z'
        )
      `;
      await sql`
        INSERT INTO focowiki.source_files (
          public_id, knowledge_base_id, logical_path, normalized_path,
          title, metadata, revision
        ) VALUES (
          ${`related-source-${suffix}`}, 'related-source-page-kb',
          ${`${suffix}.md`}, ${`${suffix}.md`}, ${suffix.toUpperCase()},
          '{}'::jsonb, 1
        )
      `;
      await sql`
        INSERT INTO focowiki.source_revisions (
          public_id, knowledge_base_id, source_file_public_id, object_id,
          checksum_sha256, byte_count, content_type
        ) VALUES (
          ${`related-revision-${suffix}`}, 'related-source-page-kb',
          ${`related-source-${suffix}`}, ${`related-source-object-${suffix}`},
          ${suffix.repeat(64)}, 1, 'text/markdown; charset=utf-8'
        )
      `;
    }
    await sql`
      INSERT INTO focowiki.object_registrations (
        object_id, storage_key, checksum_sha256, byte_count, content_type,
        object_format, state, write_attempt_public_id, verified_at
      ) VALUES (
        'related-page-object', 'objects/related-page-object',
        ${"c".repeat(64)}, 1, 'text/markdown; charset=utf-8',
        'okf-generated-markdown-v1', 'verified', 'related-page-attempt',
        '2026-08-21T12:58:00.000Z'
      )
    `;
    await sql`
      INSERT INTO focowiki.projection_publication_generations (
        public_id, knowledge_base_id, target_fact_epoch,
        renderer_contract_version, deterministic_changed_at, state,
        input_fingerprint_sha256
      ) VALUES (
        'related-page-generation', 'related-source-page-kb', 1,
        'portable-okf-v2', '2026-08-21T12:59:00.000Z', 'rendering',
        ${"d".repeat(64)}
      )
    `;
    await sql`
      INSERT INTO focowiki.projection_scope_generations (
        public_id, publication_generation_public_id, knowledge_base_id,
        scope_identity, scope_kind, scope_key, scope_generation, state,
        input_snapshot_fingerprint_sha256
      ) VALUES (
        'related-page-scope', 'related-page-generation',
        'related-source-page-kb', 'source:related-source-b', 'source',
        'related-source-b', 1, 'completed', ${"e".repeat(64)}
      )
    `;
    await sql`
      INSERT INTO focowiki.projection_scope_snapshot_members (
        scope_generation_public_id, member_kind, member_public_id,
        member_version, member_order
      ) VALUES
        ('related-page-scope', 'source_revision', 'related-revision-a', '1', 0),
        ('related-page-scope', 'source_revision', 'related-revision-b', '1', 1)
    `;
    await sql`
      INSERT INTO focowiki.projection_scope_generation_pages (
        scope_generation_public_id, publication_generation_public_id,
        owner_scope_identity, logical_path, normalized_path, action,
        entry_kind, object_id, checksum_sha256, byte_count
      ) VALUES (
        'related-page-scope', 'related-page-generation',
        'source:related-source-b', 'pages/b.md', 'pages/b.md', 'put',
        'source-page', 'related-page-object', ${"c".repeat(64)}, 1
      )
    `;
    await sql.begin((transaction) => activatePostgresDocumentPublicationPages({
      transaction: transaction as unknown as DatabaseClient,
      generationPublicId: "related-page-generation",
      knowledgeBaseId: "related-source-page-kb",
      targetFactEpoch: 1,
      activatedAt: "2026-08-21T13:00:00.000Z"
    }));
    await expect(sql<Array<{
      source_file_public_id: string | null;
      source_revision_public_id: string | null;
    }>>`
      SELECT source_file_public_id, source_revision_public_id
      FROM focowiki.generated_page_heads
      WHERE knowledge_base_id = 'related-source-page-kb'
        AND normalized_path = 'pages/b.md'
    `).resolves.toEqual([{
      source_file_public_id: "related-source-b",
      source_revision_public_id: "related-revision-b"
    }]);
  });

  it("releases object references older than the immediate rollback generation",
    async () => {
      await seedKnowledgeBase("retention-kb");
      const activation = createPostgresDocumentPublicationActivation({
        sql: database
      });
      for (const generation of [1, 2, 3]) {
        await seedReadyGeneration({
          knowledgeBaseId: "retention-kb",
          generationPublicId: `retention-generation-${generation}`,
          baseGenerationPublicId: generation === 1
            ? null : `retention-generation-${generation - 1}`,
          targetFactEpoch: generation,
          objectId: `retention-object-${generation}`
        });
        await activation.activate({
          generationPublicId: `retention-generation-${generation}`,
          expectedHeadVersion: generation - 1,
          activatedAt: `2026-08-21T13:0${generation}:00.000Z`
        });
        if (generation === 1) {
          await sql`
            DELETE FROM focowiki.projection_scope_generation_object_refs
            WHERE object_id = 'retention-object-1'
          `;
        }
      }

      await expect(sql<Array<{
        generation_public_id: string;
        retention_state: string;
        reference_count: number | string;
      }>>`
        SELECT retention.generation_public_id, retention.retention_state,
               count(reference.object_id) AS reference_count
        FROM focowiki.projection_generation_retention retention
        JOIN focowiki.projection_publication_generations generation
          ON generation.public_id = retention.generation_public_id
        LEFT JOIN focowiki.projection_scope_generations scope
          ON scope.publication_generation_public_id = generation.public_id
        LEFT JOIN focowiki.projection_scope_generation_object_refs reference
          ON reference.scope_generation_public_id = scope.public_id
        WHERE generation.knowledge_base_id = 'retention-kb'
        GROUP BY retention.generation_public_id, retention.retention_state
        ORDER BY retention.generation_public_id
      `).resolves.toEqual([
        {
          generation_public_id: "retention-generation-1",
          retention_state: "eligible",
          reference_count: "0"
        },
        {
          generation_public_id: "retention-generation-2",
          retention_state: "retained",
          reference_count: "1"
        }
      ]);
      await expect(sql<Array<{
        object_id: string;
        zero_owner_since: Date | null;
      }>>`
        SELECT object_id, zero_owner_since
        FROM focowiki.object_registrations
        WHERE object_id LIKE 'retention-object-%'
        ORDER BY object_id
      `).resolves.toEqual([
        {
          object_id: "retention-object-1",
          zero_owner_since: new Date("2026-08-21T13:02:00.000Z")
        },
        { object_id: "retention-object-2", zero_owner_since: null },
        { object_id: "retention-object-3", zero_owner_since: null }
      ]);
      await expect(sql<Array<{
        resource_public_id: string;
        state: string;
      }>>`
        SELECT resource_public_id, state
        FROM focowiki.cleanup_actions
        WHERE knowledge_base_id = 'retention-kb'
          AND action_kind = 'zero_owner_object'
          AND resource_public_id LIKE 'retention-object-%'
        ORDER BY resource_public_id
      `).resolves.toEqual([{
        resource_public_id: "retention-object-1",
        state: "queued"
      }]);
    });

  it("queues an eligible object when a later activation displaces its last head",
    async () => {
      await seedKnowledgeBase("displaced-head-kb");
      const activation = createPostgresDocumentPublicationActivation({
        sql: database
      });
      for (const generation of [1, 2, 3, 4]) {
        await seedReadyGeneration({
          knowledgeBaseId: "displaced-head-kb",
          generationPublicId: `displaced-generation-${generation}`,
          baseGenerationPublicId: generation === 1
            ? null : `displaced-generation-${generation - 1}`,
          targetFactEpoch: generation,
          objectId: `displaced-object-${generation}`
        });
        if (generation === 2 || generation === 3) {
          await sql`
            DELETE FROM focowiki.projection_scope_generation_pages
            WHERE publication_generation_public_id
              = ${`displaced-generation-${generation}`}
          `;
        }
        await activation.activate({
          generationPublicId: `displaced-generation-${generation}`,
          expectedHeadVersion: generation - 1,
          activatedAt: `2026-08-21T13:1${generation}:00.000Z`
        });
      }
      await expect(sql<Array<{
        state: string;
        zero_owner_since: Date | null;
      }>>`
        SELECT action.state, registration.zero_owner_since
        FROM focowiki.cleanup_actions action
        JOIN focowiki.object_registrations registration
          ON registration.object_id = action.resource_public_id
        WHERE action.knowledge_base_id = 'displaced-head-kb'
          AND action.action_kind = 'zero_owner_object'
          AND action.resource_public_id = 'displaced-object-1'
      `).resolves.toEqual([{
        state: "queued",
        zero_owner_since: new Date("2026-08-21T13:14:00.000Z")
      }]);
    });

  it("obsoletes a stale generation without changing its completed receipts",
    async () => {
      await sql`
        UPDATE focowiki.projection_publication_generations
        SET base_generation_public_id = NULL
        WHERE public_id = 'activation-generation-2'
      `;
      await expect(createPostgresDocumentPublicationRecovery(database)
        .recoverStaleBase({
          generationPublicId: "activation-generation-2",
          recoveredAt: "2026-08-21T13:02:10.000Z"
        })).resolves.toEqual({
          generationPublicId: "activation-generation-2",
          knowledgeBaseId: "activation-kb",
          releasedFactCount: 0,
          supersededScopeCount: 0
        });
      await expect(sql<Array<{
        generation_state: string;
        scope_state: string;
        active_generation_public_id: string;
      }>>`
        SELECT generation.state AS generation_state,
               scope.state AS scope_state,
               head.active_generation_public_id
        FROM focowiki.projection_publication_generations generation
        JOIN focowiki.projection_scope_generations scope
          ON scope.publication_generation_public_id = generation.public_id
        JOIN focowiki.knowledge_base_projection_heads head
          ON head.knowledge_base_id = generation.knowledge_base_id
        WHERE generation.public_id = 'activation-generation-2'
      `).resolves.toEqual([{
        generation_state: "obsolete",
        scope_state: "completed",
        active_generation_public_id: "activation-generation-1"
      }]);
    });

  it("retries only the contended activation transaction and persists deferral",
    async () => {
      await seedKnowledgeBase("contention-kb");
      await seedReadyGeneration({
        knowledgeBaseId: "contention-kb",
        generationPublicId: "contention-generation-1",
        baseGenerationPublicId: null,
        targetFactEpoch: 1,
        objectId: "contention-object-1"
      });
      let invocationCount = 0;
      const retried = createPostgresDocumentPublicationActivation({
        sql: database,
        maximumContentionAttempts: 3,
        random: () => 0,
        wait: async () => undefined,
        beforeHeadAdvance: async () => {
          invocationCount += 1;
          if (invocationCount < 3) {
            throw Object.assign(new Error("injected contention"), {
              code: invocationCount === 1 ? "40P01" : "40001"
            });
          }
        }
      });
      await expect(retried.activate({
        generationPublicId: "contention-generation-1",
        expectedHeadVersion: 0,
        activatedAt: "2026-08-21T13:02:30.000Z"
      })).resolves.toMatchObject({ headVersion: 1 });
      expect(invocationCount).toBe(3);

      await seedReadyGeneration({
        knowledgeBaseId: "contention-kb",
        generationPublicId: "contention-generation-2",
        baseGenerationPublicId: "contention-generation-1",
        targetFactEpoch: 2,
        objectId: "contention-object-2"
      });
      const deferred = createPostgresDocumentPublicationActivation({
        sql: database,
        maximumContentionAttempts: 1,
        random: () => 0,
        beforeHeadAdvance: async () => {
          throw Object.assign(new Error("injected lock timeout"), {
            code: "55P03"
          });
        }
      });
      await expect(deferred.activate({
        generationPublicId: "contention-generation-2",
        expectedHeadVersion: 1,
        activatedAt: "2026-08-21T13:02:40.000Z"
      })).rejects.toMatchObject({
        code: "publication_activation_contention_deferred"
      });
      await expect(sql<Array<{
        state: string;
        activation_contention_count: number;
        safe_error_code: string | null;
        activation_next_eligible_at: Date | null;
      }>>`
        SELECT state, activation_contention_count, safe_error_code,
               activation_next_eligible_at
        FROM focowiki.projection_publication_generations
        WHERE public_id = 'contention-generation-2'
      `).resolves.toEqual([{
        state: "ready",
        activation_contention_count: 1,
        safe_error_code: "55P03",
        activation_next_eligible_at: expect.any(Date)
      }]);
    });

  it("activates disjoint knowledge bases concurrently", async () => {
    await Promise.all(["quiet-a", "quiet-b"].map(async (knowledgeBaseId) => {
      await seedKnowledgeBase(knowledgeBaseId);
      await seedReadyGeneration({
        knowledgeBaseId,
        generationPublicId: `${knowledgeBaseId}-generation-1`,
        baseGenerationPublicId: null,
        targetFactEpoch: 1,
        objectId: `${knowledgeBaseId}-object-1`
      });
    }));
    const activation = createPostgresDocumentPublicationActivation({ sql: database });
    const results = await Promise.all(["quiet-a", "quiet-b"].map(
      (knowledgeBaseId) => activation.activate({
        generationPublicId: `${knowledgeBaseId}-generation-1`,
        expectedHeadVersion: 0,
        activatedAt: "2026-08-21T13:03:00.000Z"
      })));
    expect(results.map((result) => result.knowledgeBaseId).sort())
      .toEqual(["quiet-a", "quiet-b"]);
    await expect(sql<Array<{ count: number | string }>>`
      SELECT count(*) AS count
      FROM focowiki.knowledge_base_projection_heads
      WHERE knowledge_base_id IN ('quiet-a', 'quiet-b')
        AND head_version = 1
    `).resolves.toEqual([{ count: "2" }]);
  });

  it("allows only one of two workers to activate overlapping owners",
    async () => {
      await seedKnowledgeBase("overlap-kb");
      await seedReadyGeneration({
        knowledgeBaseId: "overlap-kb",
        generationPublicId: "overlap-generation-1",
        baseGenerationPublicId: null,
        targetFactEpoch: 1,
        objectId: "overlap-object-1"
      });
      const requests = ["worker-a", "worker-b"].map(async () =>
        createPostgresDocumentPublicationActivation({ sql: database }).activate({
          generationPublicId: "overlap-generation-1",
          expectedHeadVersion: 0,
          activatedAt: "2026-08-21T13:03:30.000Z"
        }));
      const results = await Promise.allSettled(requests);
      expect(results.filter((result) => result.status === "fulfilled"))
        .toHaveLength(1);
      expect(results.filter((result) => result.status === "rejected"))
        .toHaveLength(1);
      await expect(readVisible("overlap-kb")).resolves.toEqual([{
        active_generation_public_id: "overlap-generation-1",
        head_version: "1",
        object_id: "overlap-object-1",
        projection_generation_public_id: "overlap-generation-1"
      }]);
    });

  it("publishes source, work, search family, receipt and operation state together",
    async () => {
      await seedKnowledgeBase("document-kb");
      await seedReadyGeneration({
        knowledgeBaseId: "document-kb",
        generationPublicId: "document-generation-1",
        baseGenerationPublicId: null,
        targetFactEpoch: 1,
        objectId: "document-page-object-1"
      });
      await seedPublicationDocument();
      await sql`
        INSERT INTO focowiki.operations (
          public_id, knowledge_base_id, operation_kind, state,
          target_kind, target_public_id
        ) VALUES (
          'document-deletion-still-cleaning', 'document-kb', 'deletion',
          'processing', 'source_file', 'document-source-1'
        )
      `;
      await sql.begin((transaction) => updatePostgresDocumentJobSummary(
        transaction,
        "document-job-1",
        "2026-08-21T13:03:59.000Z"
      ));
      await expect(sql<Array<{ blocking_work_kind: string }>>`
        SELECT blocking_work_kind
        FROM focowiki.document_processing_jobs
        WHERE public_id = 'document-job-1'
      `).resolves.toEqual([{ blocking_work_kind: "activate" }]);
      await expect(createPostgresDocumentPublicationActivation({ sql: database })
        .activate({
          generationPublicId: "document-generation-1",
          expectedHeadVersion: 0,
          activatedAt: "2026-08-21T13:04:00.000Z"
        })).resolves.toMatchObject({ documentCount: 1, sourceCount: 1 });
      await expect(sql<Array<{
        job_state: string;
        completed_work_count: number;
        blocking_work_kind: string;
        active_source_revision_public_id: string;
        identity_state: string;
        projection_active: boolean;
        search_active: boolean;
        operation_state: string;
        receipt_count: number | string;
      }>>`
        SELECT job.state AS job_state, job.completed_work_count,
               job.blocking_work_kind,
               active.active_source_revision_public_id,
               identity.state AS identity_state,
               projection.active AS projection_active,
               family.active AS search_active,
               operation.state AS operation_state,
               (SELECT count(*) FROM focowiki.document_artifact_receipts receipt
                WHERE receipt.document_job_public_id = job.public_id
                  AND receipt.receipt_kind IN ('generated_page', 'activation'))
                 AS receipt_count
        FROM focowiki.document_processing_jobs job
        JOIN focowiki.source_file_active_revisions active
          ON active.source_file_public_id = job.source_file_public_id
         AND active.knowledge_base_id = job.knowledge_base_id
        JOIN focowiki.source_file_identity_keys identity
          ON identity.source_revision_public_id = job.source_revision_public_id
         AND identity.knowledge_base_id = job.knowledge_base_id
        JOIN focowiki.document_projection_records projection
          ON projection.source_revision_public_id = job.source_revision_public_id
         AND projection.knowledge_base_id = job.knowledge_base_id
        JOIN focowiki.search_family_receipts family
          ON family.source_revision_public_id = job.source_revision_public_id
         AND family.knowledge_base_id = job.knowledge_base_id
        JOIN focowiki.operations operation
          ON operation.public_id = job.operation_public_id
        WHERE job.public_id = 'document-job-1'
      `).resolves.toEqual([{
        job_state: "available",
        completed_work_count: 7,
        blocking_work_kind: "cleanup",
        active_source_revision_public_id: "document-revision-1",
        identity_state: "active",
        projection_active: true,
        search_active: true,
        operation_state: "completed",
        receipt_count: "2"
      }]);
      await expect(sql<Array<{ terminal_state: string }>>`
        SELECT terminal_state FROM focowiki.operation_results
        WHERE public_id = 'document-operation-1'
      `).resolves.toEqual([{ terminal_state: "completed" }]);
      await expect(sql<Array<{ state: string }>>`
        SELECT state FROM focowiki.operations
        WHERE public_id = 'document-deletion-still-cleaning'
      `).resolves.toEqual([{ state: "processing" }]);
    });

  it("activates a deletion fact without a synthetic document job", async () => {
    await seedReadyGeneration({
      knowledgeBaseId: "document-kb",
      generationPublicId: "document-generation-delete",
      baseGenerationPublicId: "document-generation-1",
      targetFactEpoch: 2,
      objectId: "document-page-object-delete"
    });
    await sql`
      INSERT INTO focowiki.projection_fact_epochs (
        knowledge_base_id, fact_epoch, mutation_public_id,
        mutation_group_public_id, source_file_public_id,
        source_revision_public_id, fact_kind, state
      ) VALUES (
        'document-kb', 2, 'document-delete-mutation',
        'document-delete-operation', 'document-source-1',
        'document-revision-1', 'delete', 'included'
      )
    `;
    await sql`
      INSERT INTO focowiki.projection_generation_documents (
        generation_public_id, mutation_public_id, document_job_public_id,
        source_file_public_id, source_revision_public_id, fact_epoch
      ) VALUES (
        'document-generation-delete', 'document-delete-mutation', NULL,
        'document-source-1', 'document-revision-1', 2
      )
    `;
    await expect(createPostgresDocumentPublicationActivation({ sql: database })
      .activate({
        generationPublicId: "document-generation-delete",
        expectedHeadVersion: 1,
        activatedAt: "2026-08-21T13:05:00.000Z"
      })).resolves.toMatchObject({ documentCount: 0, sourceCount: 1 });
    await expect(sql`
      SELECT active.active_source_revision_public_id,
             projection.active AS projection_active,
             family.active AS search_active
      FROM focowiki.source_file_active_revisions active
      JOIN focowiki.document_projection_records projection
        ON projection.knowledge_base_id = active.knowledge_base_id
       AND projection.source_file_public_id = active.source_file_public_id
      JOIN focowiki.search_family_receipts family
        ON family.knowledge_base_id = active.knowledge_base_id
       AND family.source_file_public_id = active.source_file_public_id
      WHERE active.knowledge_base_id = 'document-kb'
        AND active.source_file_public_id = 'document-source-1'
    `).resolves.toEqual([{
      active_source_revision_public_id: null,
      projection_active: false,
      search_active: false
    }]);
  });

  async function seedKnowledgeBase(knowledgeBaseId: string): Promise<void> {
    await sql`
      INSERT INTO focowiki.knowledge_bases (public_id, name, revision)
      VALUES (${knowledgeBaseId}, ${knowledgeBaseId}, 1)
    `;
    await sql`
      INSERT INTO focowiki.knowledge_base_projection_heads (
        knowledge_base_id, active_generation_public_id,
        active_fact_epoch, head_version
      ) VALUES (${knowledgeBaseId}, NULL, 0, 0)
    `;
    await sql`
      INSERT INTO focowiki.knowledge_base_sequences (
        knowledge_base_id, current_sequence
      ) VALUES (${knowledgeBaseId}, 0)
    `;
  }

  async function seedReadyGeneration(input: {
    knowledgeBaseId: string;
    generationPublicId: string;
    baseGenerationPublicId: string | null;
    targetFactEpoch: number;
    objectId: string;
  }): Promise<void> {
    const scopePublicId = `${input.generationPublicId}-root-scope`;
    const fingerprint = input.targetFactEpoch.toString(16).padStart(64, "0");
    await sql`
      INSERT INTO focowiki.object_registrations (
        object_id, storage_key, checksum_sha256, byte_count, content_type,
        object_format, state, write_attempt_public_id, verified_at
      ) VALUES (
        ${input.objectId}, ${`objects/${input.objectId}`}, ${fingerprint}, 10,
        'text/markdown; charset=utf-8', 'okf-generated-markdown-v1',
        'verified', ${`${input.objectId}-attempt`},
        '2026-08-21T12:59:00.000Z'
      )
    `;
    await sql`
      INSERT INTO focowiki.projection_publication_generations (
        public_id, knowledge_base_id, base_generation_public_id,
        target_fact_epoch, renderer_contract_version,
        deterministic_changed_at, state, input_fingerprint_sha256,
        output_fingerprint_sha256
      ) VALUES (
        ${input.generationPublicId}, ${input.knowledgeBaseId},
        ${input.baseGenerationPublicId}, ${input.targetFactEpoch},
        'portable-okf-v2', '2026-08-21T12:59:00.000Z', 'ready',
        ${fingerprint}, ${fingerprint}
      )
    `;
    await sql`
      INSERT INTO focowiki.projection_scope_generations (
        public_id, publication_generation_public_id, knowledge_base_id,
        scope_identity, scope_kind, scope_key, scope_generation,
        state, input_snapshot_fingerprint_sha256,
        output_fingerprint_sha256, validation_evidence, completed_at
      ) VALUES (
        ${scopePublicId}, ${input.generationPublicId}, ${input.knowledgeBaseId},
        'root:index', 'root', 'index', ${input.targetFactEpoch}, 'completed',
        ${fingerprint}, ${fingerprint}, '{}'::jsonb,
        '2026-08-21T12:59:00.000Z'
      )
    `;
    await sql`
      INSERT INTO focowiki.projection_scope_generation_pages (
        scope_generation_public_id, publication_generation_public_id,
        owner_scope_identity, logical_path, normalized_path, action,
        entry_kind, object_id, checksum_sha256, byte_count
      ) VALUES (
        ${scopePublicId}, ${input.generationPublicId}, 'root:index',
        'index.md', 'index.md', 'put', 'root-index', ${input.objectId},
        ${fingerprint}, 10
      )
    `;
    await sql`
      INSERT INTO focowiki.projection_scope_generation_object_refs (
        scope_generation_public_id, object_id
      ) VALUES (${scopePublicId}, ${input.objectId})
    `;
    await sql`
      INSERT INTO focowiki.projection_generation_validation_results (
        generation_public_id, check_name, state, checked_count,
        evidence_sha256, safe_detail, checked_at
      ) VALUES (
        ${input.generationPublicId}, 'coherent_generation', 'passed', 1,
        ${fingerprint}, '{}'::jsonb, '2026-08-21T12:59:30.000Z'
      )
    `;
    await sql`
      INSERT INTO focowiki.projection_activation_owner_reservations (
        generation_public_id, knowledge_base_id, owner_family, owner_key
      ) VALUES (
        ${input.generationPublicId}, ${input.knowledgeBaseId},
        'page', 'index.md'
      )
    `;
  }

  async function seedPublicationDocument(): Promise<void> {
    await sql`
      INSERT INTO focowiki.object_registrations (
        object_id, storage_key, checksum_sha256, byte_count, content_type,
        object_format, state, write_attempt_public_id, verified_at
      ) VALUES (
        'document-source-object-1', 'objects/document-source-object-1',
        ${"7".repeat(64)}, 32, 'text/markdown; charset=utf-8',
        'source-markdown-v1', 'verified', 'document-source-attempt-1',
        '2026-08-21T12:58:00.000Z'
      )
    `;
    await sql`
      INSERT INTO focowiki.source_files (
        public_id, knowledge_base_id, logical_path, normalized_path,
        title, metadata, revision
      ) VALUES (
        'document-source-1', 'document-kb', 'draft.md', 'draft.md',
        'Draft', '{}'::jsonb, 1
      )
    `;
    await sql`
      INSERT INTO focowiki.source_revisions (
        public_id, knowledge_base_id, source_file_public_id, object_id,
        checksum_sha256, byte_count, content_type
      ) VALUES (
        'document-revision-1', 'document-kb', 'document-source-1',
        'document-source-object-1', ${"7".repeat(64)}, 32,
        'text/markdown; charset=utf-8'
      )
    `;
    await sql`
      INSERT INTO focowiki.source_revision_presentations (
        knowledge_base_id, source_file_public_id, source_revision_public_id,
        logical_path, normalized_path, title, metadata
      ) VALUES (
        'document-kb', 'document-source-1', 'document-revision-1',
        'published.md', 'published.md', 'Published', '{}'::jsonb
      )
    `;
    await sql`
      INSERT INTO focowiki.source_file_active_revisions (
        knowledge_base_id, source_file_public_id,
        current_source_revision_public_id, active_source_revision_public_id,
        activation_sequence
      ) VALUES (
        'document-kb', 'document-source-1', 'document-revision-1', NULL, 0
      )
    `;
    await sql`
      INSERT INTO focowiki.source_file_identity_keys (
        public_id, knowledge_base_id, source_file_public_id,
        source_revision_public_id, identity_kind, normalized_identity_key,
        state
      ) VALUES (
        'document-identity-1', 'document-kb', 'document-source-1',
        'document-revision-1', 'path', 'published.md', 'staged'
      )
    `;
    await sql`
      INSERT INTO focowiki.document_projection_records (
        knowledge_base_id, source_file_public_id, source_revision_public_id,
        logical_path, normalized_path, title, summary, metadata, headings,
        entities, content_type, checksum_sha256, byte_count,
        tokenizer_contract_version, navigation_term_fingerprint_sha256,
        active
      ) VALUES (
        'document-kb', 'document-source-1', 'document-revision-1',
        'published.md', 'published.md', 'Published', 'Summary', '{}'::jsonb,
        '{}'::text[], '{}'::text[], 'text/markdown; charset=utf-8',
        ${"7".repeat(64)}, 32, 'tokenizer-v1', ${"6".repeat(64)}, false
      )
    `;
    await sql`
      INSERT INTO focowiki.operations (
        public_id, knowledge_base_id, operation_kind, state,
        target_kind, target_public_id
      ) VALUES (
        'document-operation-1', 'document-kb', 'source_replace',
        'processing', 'source_file', 'document-source-1'
      )
    `;
    await sql.begin(async (transaction) => {
      await transaction`SET LOCAL session_replication_role = replica`;
      await transaction`
        INSERT INTO focowiki.document_processing_jobs (
          public_id, knowledge_base_id, operation_public_id,
          source_file_public_id, source_revision_public_id,
          runtime_settings_revision_public_id,
          generation_model_configuration_public_id,
          generation_model_configuration_revision,
          embedding_configuration_revision_public_id,
          semantic_generation_public_id, semantic_contract_version,
          state, maximum_attempts, required_work_count, completed_work_count,
          blocking_work_kind, accepted_at, started_at, revision,
          created_at, updated_at
        ) VALUES (
          'document-job-1', 'document-kb', 'document-operation-1',
          'document-source-1', 'document-revision-1', 'settings-1',
          'model-1', 1, 'embedding-1', 'semantic-generation-1',
          'document-fixed-dag-v1', 'processing', 3, 8, 5,
          'knowledge_projection', '2026-08-21T12:58:00.000Z',
          '2026-08-21T12:58:00.000Z', 1,
          '2026-08-21T12:58:00.000Z', '2026-08-21T12:58:00.000Z'
        )
      `;
      const kinds = [
        "prepare", "first_layer", "content_projection", "graphrag",
        "relation_reconcile", "knowledge_projection", "activate", "cleanup"
      ];
      for (const [index, kind] of kinds.entries()) {
        const state = index < 5 ? "completed"
          : kind === "knowledge_projection" ? "waiting_on_projection"
          : "waiting";
        await transaction`
          INSERT INTO focowiki.document_artifact_work (
            public_id, knowledge_base_id, document_job_public_id,
            source_file_public_id, source_revision_public_id,
            work_kind, resource_lane, input_fingerprint_sha256,
            state, maximum_attempts, next_eligible_at, ended_at,
            created_at, updated_at
          ) VALUES (
            ${`document-work-${kind}`}, 'document-kb', 'document-job-1',
            'document-source-1', 'document-revision-1', ${kind},
            ${kind === "knowledge_projection" || kind === "activate"
              ? "projection" : "cpu"},
            ${(index + 1).toString(16).padStart(64, "0")}, ${state}, 3,
            '2026-08-21T12:58:00.000Z',
            ${state === "completed" ? "2026-08-21T12:58:30.000Z" : null},
            '2026-08-21T12:58:00.000Z', '2026-08-21T12:58:00.000Z'
          )
        `;
      }
    });
    await sql`
      INSERT INTO focowiki.search_family_receipts (
        public_id, knowledge_base_id, source_file_public_id,
        source_revision_public_id, provider_kind, family,
        input_fingerprint_sha256, state, acknowledged_at, active
      ) VALUES (
        'document-search-family-1', 'document-kb', 'document-source-1',
        'document-revision-1', 'opensearch', 'content_metadata',
        ${"5".repeat(64)}, 'acknowledged',
        '2026-08-21T12:58:30.000Z', false
      )
    `;
    await sql`
      INSERT INTO focowiki.projection_fact_epochs (
        knowledge_base_id, fact_epoch, mutation_public_id,
        source_file_public_id, source_revision_public_id, fact_kind, state
      ) VALUES (
        'document-kb', 1, 'document-job-1', 'document-source-1',
        'document-revision-1', 'create', 'included'
      )
    `;
    await sql`
      INSERT INTO focowiki.projection_generation_documents (
        generation_public_id, mutation_public_id, document_job_public_id,
        source_file_public_id,
        source_revision_public_id, fact_epoch
      ) VALUES (
        'document-generation-1', 'document-job-1', 'document-job-1',
        'document-source-1',
        'document-revision-1', 1
      )
    `;
  }

  function readVisible(knowledgeBaseId: string) {
    return sql<Array<{
      active_generation_public_id: string;
      head_version: string;
      object_id: string;
      projection_generation_public_id: string;
    }>>`
      SELECT head.active_generation_public_id, head.head_version::text,
             page.object_id, page.projection_generation_public_id
      FROM focowiki.knowledge_base_projection_heads head
      JOIN focowiki.generated_page_heads page
        ON page.knowledge_base_id = head.knowledge_base_id
       AND page.normalized_path = 'index.md'
      WHERE head.knowledge_base_id = ${knowledgeBaseId}
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
