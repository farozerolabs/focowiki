import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  applyMigrations,
  MIGRATION_FILES,
  readMigrationSql,
  RUNTIME_SCHEMA_GENERATION
} from "../src/db/migrations.js";
import { createPostgresLexicalRebuildWorkRepository } from "../src/infrastructure/postgres/lexical-rebuild-work-repository.js";
import { createPostgresPublicationSubtaskRepository } from "../src/infrastructure/postgres/publication-subtask-repository.js";

const databaseUrl = process.env.FOCOWIKI_TEST_DATABASE_URL;
const describeDatabase = databaseUrl ? describe : describe.skip;

describeDatabase("lexical rebuild worker migration integration", () => {
  const connectionUrl = databaseUrl ?? "postgres://unused:unused@127.0.0.1:5432/unused";
  const databaseName = `focowiki_lexical_worker_migration_${process.pid}_${
    randomUUID().replaceAll("-", "").slice(0, 10)
  }`;
  const admin = postgres(databaseConnectionUrl(connectionUrl, "postgres"), { max: 1 });
  const sql = postgres(databaseConnectionUrl(connectionUrl, databaseName), { max: 4 });

  beforeAll(async () => {
    await admin.unsafe(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
    const migrationIndex = MIGRATION_FILES.indexOf("015_lexical_rebuild_worker.sql");
    for (const fileName of MIGRATION_FILES.slice(0, migrationIndex)) {
      await sql.begin(async (transaction) => {
        await transaction.unsafe(readMigrationSql(fileName));
      });
    }
    await seedCompatibleCandidate();
    await applyMigrations(sql);
  });

  afterAll(async () => {
    await sql.end({ timeout: 5 });
    await admin.unsafe(`DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)} WITH (FORCE)`);
    await admin.end({ timeout: 5 });
  });

  it("adopts only fully matched source records without replacing generation identity", async () => {
    expect((await sql<Array<{ generation: string }>>`
      SELECT generation
      FROM focowiki.runtime_generation
      WHERE singleton = true
    `)[0]?.generation).toBe(RUNTIME_SCHEMA_GENERATION);

    expect((await sql<Array<{
      active_generation_id: string;
      target_generation_id: string;
      attempt_count: number;
      lease_owner: string;
      lease_token: string;
      processed_source_count: number;
      pending_source_count: number;
      total_source_count: number;
    }>>`
      SELECT knowledge_base.active_generation_id,
             rebuild.target_generation_id,
             rebuild.attempt_count,
             rebuild.lease_owner,
             rebuild.lease_token,
             rebuild.processed_source_count::int AS processed_source_count,
             rebuild.pending_source_count::int AS pending_source_count,
             rebuild.total_source_count::int AS total_source_count
      FROM focowiki.knowledge_bases knowledge_base
      JOIN focowiki.knowledge_base_lexical_rebuilds rebuild
        ON rebuild.knowledge_base_id = knowledge_base.id
      WHERE knowledge_base.id = 'kb-lexical-migration'
    `)[0]).toEqual({
      active_generation_id: "generation-lexical-active",
      target_generation_id: "generation-lexical-target",
      attempt_count: 2,
      lease_owner: "maintenance-worker-legacy",
      lease_token: "legacy-lease",
      processed_source_count: 1,
      pending_source_count: 3,
      total_source_count: 4
    });

    expect(await sql<Array<{
      source_file_id: string;
      source_revision_id: string;
      logical_path: string;
      state: string;
    }>>`
      SELECT source_file_id, source_revision_id, logical_path, state
      FROM focowiki.lexical_rebuild_work_items
      WHERE knowledge_base_id = 'kb-lexical-migration'
      ORDER BY source_file_id
    `).toEqual([
      {
        source_file_id: "source-changed",
        source_revision_id: "revision-changed-current",
        logical_path: "pages/guides/changed.md",
        state: "pending"
      },
      {
        source_file_id: "source-missing",
        source_revision_id: "revision-missing",
        logical_path: "pages/guides/missing.md",
        state: "pending"
      },
      {
        source_file_id: "source-moved",
        source_revision_id: "revision-moved",
        logical_path: "pages/current/moved.md",
        state: "pending"
      },
      {
        source_file_id: "source-valid",
        source_revision_id: "revision-valid",
        logical_path: "pages/guides/valid.md",
        state: "completed"
      }
    ]);
  });

  it("does not create work for deleted sources or completed rebuilds", async () => {
    expect((await sql<Array<{ count: number }>>`
      SELECT count(*)::int AS count
      FROM focowiki.lexical_rebuild_work_items
      WHERE source_file_id = 'source-deleted'
         OR knowledge_base_id = 'kb-lexical-completed'
    `)[0]?.count).toBe(0);
  });

  it("rebases an unfinished normal publication onto an already active lexical generation", async () => {
    expect((await sql<Array<{
      active_generation_id: string;
      predecessor_generation_id: string;
      state: string;
    }>>`
      SELECT knowledge_base.active_generation_id,
             generation.predecessor_generation_id,
             generation.state
      FROM focowiki.knowledge_bases knowledge_base
      JOIN focowiki.publication_generations generation
        ON generation.knowledge_base_id = knowledge_base.id
       AND generation.id = 'generation-normal-recovery'
      WHERE knowledge_base.id = 'kb-lexical-predecessor-recovery'
    `)[0]).toEqual({
      active_generation_id: "generation-lexical-recovery",
      predecessor_generation_id: "generation-lexical-recovery",
      state: "validating"
    });

    const subtasks = createPostgresPublicationSubtaskRepository(sql);
    const claimed = await subtasks.claim({
      workerId: "publication-worker-recovery",
      limit: 10,
      now: "2026-07-26T00:00:00.000Z",
      staleBefore: "2026-07-25T23:30:00.000Z"
    });
    expect(claimed).toHaveLength(1);
    expect(claimed[0]).toMatchObject({
      generationId: "generation-normal-recovery",
      taskKind: "activation"
    });
    expect((await sql<Array<{ state: string }>>`
      SELECT state
      FROM focowiki.publication_subtasks
      WHERE id = 'publication-subtask-recovery-activation'
    `)[0]?.state).toBe("running");
  });

  it("advances stale projection version ownership to the active generation", async () => {
    expect(await sql<Array<{
      projection_kind: string;
      active_generation_id: string;
    }>>`
      SELECT projection_kind, active_generation_id
      FROM focowiki.knowledge_base_projection_versions
      WHERE knowledge_base_id = 'kb-lexical-predecessor-recovery'
      ORDER BY projection_kind
    `).toEqual([
      {
        projection_kind: "directory",
        active_generation_id: "generation-lexical-recovery"
      },
      {
        projection_kind: "graph",
        active_generation_id: "generation-lexical-recovery"
      },
      {
        projection_kind: "tree",
        active_generation_id: "generation-lexical-recovery"
      }
    ]);
  });

  it("waits for an unexpired legacy lease and adopts work after it expires", async () => {
    const work = createPostgresLexicalRebuildWorkRepository(sql);
    const claim = (workerId: string) => work.claimBatch({
      workerId,
      leaseTokenPrefix: workerId,
      limit: 2,
      settingsRevision: 1,
      settings: {
        concurrency: 4,
        sourceReadConcurrency: 8,
        databaseWriteConcurrency: 2,
        claimBatchSize: 500,
        databaseBatchSize: 50,
        maxInFlightSourceBytes: 67_108_864
      },
      now: "2026-07-26T00:00:00.000Z",
      leaseExpiresAt: "2026-07-26T00:15:00.000Z"
    });

    await expect(claim("worker-before-expiry")).resolves.toEqual([]);

    await sql`
      UPDATE focowiki.knowledge_base_lexical_rebuilds
      SET lease_expires_at = '2026-07-25T23:59:00.000Z'
      WHERE knowledge_base_id = 'kb-lexical-migration'
    `;
    await sql`
      UPDATE focowiki.lexical_rebuild_work_items
      SET next_attempt_at = '2026-07-25T23:59:00.000Z'
      WHERE knowledge_base_id = 'kb-lexical-migration'
        AND state = 'pending'
    `;

    const adopted = await claim("worker-after-expiry");
    expect(adopted).toHaveLength(2);
    expect(adopted.every((item) =>
      item.knowledgeBaseId === "kb-lexical-migration"
    )).toBe(true);
  });

  async function seedCompatibleCandidate(): Promise<void> {
    await sql.begin(async (transaction) => {
      await transaction`
        INSERT INTO focowiki.knowledge_bases (id, name)
        VALUES
          ('kb-lexical-migration', 'Lexical migration'),
          ('kb-lexical-completed', 'Completed lexical migration'),
          ('kb-lexical-predecessor-recovery', 'Lexical predecessor recovery')
      `;
      await transaction`
        INSERT INTO focowiki.publication_generations (
          id, knowledge_base_id, predecessor_generation_id,
          state, format_version, generation_kind, activated_at
        ) VALUES
          (
            'generation-lexical-active', 'kb-lexical-migration', NULL,
            'active', 2, 'normal', now()
          ),
          (
            'generation-lexical-target', 'kb-lexical-migration',
            'generation-lexical-active', 'building', 2, 'lexical_rebuild', NULL
          ),
          (
            'generation-completed-active', 'kb-lexical-completed', NULL,
            'active', 2, 'normal', now()
          ),
          (
            'generation-completed-target', 'kb-lexical-completed',
            'generation-completed-active', 'superseded', 2,
            'lexical_rebuild', NULL
          ),
          (
            'generation-repair-recovery', 'kb-lexical-predecessor-recovery',
            NULL, 'superseded', 2, 'projection_repair', now()
          ),
          (
            'generation-lexical-recovery', 'kb-lexical-predecessor-recovery',
            'generation-repair-recovery', 'active', 2,
            'lexical_rebuild', now()
          ),
          (
            'generation-normal-recovery', 'kb-lexical-predecessor-recovery',
            'generation-repair-recovery', 'validating', 2, 'normal', NULL
          )
      `;
      await transaction`
        UPDATE focowiki.knowledge_bases
        SET active_generation_id = CASE id
          WHEN 'kb-lexical-migration' THEN 'generation-lexical-active'
          WHEN 'kb-lexical-predecessor-recovery' THEN 'generation-lexical-recovery'
          ELSE 'generation-completed-active'
        END
        WHERE id IN (
          'kb-lexical-migration',
          'kb-lexical-completed',
          'kb-lexical-predecessor-recovery'
        )
      `;
      await transaction`
        INSERT INTO focowiki.knowledge_base_projection_versions (
          knowledge_base_id, projection_kind, format_version,
          input_version, active_generation_id
        ) VALUES
          (
            'kb-lexical-predecessor-recovery', 'tree', 2, 2,
            'generation-repair-recovery'
          ),
          (
            'kb-lexical-predecessor-recovery', 'directory', 2, 2,
            'generation-repair-recovery'
          ),
          (
            'kb-lexical-predecessor-recovery', 'graph', 2, 2,
            'generation-repair-recovery'
          )
      `;
      await transaction`
        INSERT INTO focowiki.publication_subtasks (
          id, knowledge_base_id, generation_id, task_kind,
          projection_kind, physical_partition, state,
          processed_count, total_count, max_attempts,
          run_after, completed_at
        ) VALUES
          (
            'publication-subtask-recovery-validation',
            'kb-lexical-predecessor-recovery',
            'generation-normal-recovery',
            'validation', '', 'workflow', 'completed',
            1, 1, 3, '2026-07-24T00:00:00.000Z',
            '2026-07-24T00:00:00.000Z'
          ),
          (
            'publication-subtask-recovery-activation',
            'kb-lexical-predecessor-recovery',
            'generation-normal-recovery',
            'activation', '', 'workflow', 'retry',
            0, 1, 3, '2026-07-24T00:00:00.000Z', NULL
          )
      `;
      for (const item of [
        {
          sourceFileId: "source-valid",
          revisionId: "revision-valid",
          relativePath: "guides/valid.md",
          deleted: false
        },
        {
          sourceFileId: "source-missing",
          revisionId: "revision-missing",
          relativePath: "guides/missing.md",
          deleted: false
        },
        {
          sourceFileId: "source-moved",
          revisionId: "revision-moved",
          relativePath: "current/moved.md",
          deleted: false
        },
        {
          sourceFileId: "source-changed",
          revisionId: "revision-changed-current",
          relativePath: "guides/changed.md",
          deleted: false
        },
        {
          sourceFileId: "source-deleted",
          revisionId: "revision-deleted",
          relativePath: "guides/deleted.md",
          deleted: true
        }
      ]) {
        await transaction`
          INSERT INTO focowiki.source_files (
            id, knowledge_base_id, object_key, content_type, size_bytes,
            checksum_sha256, processing_status, processing_stage,
            generated_output_status, name, relative_path, path_key,
            active_revision_id, metadata_json, deleted_at
          ) VALUES (
            ${item.sourceFileId}, 'kb-lexical-migration',
            ${`sources/${item.sourceFileId}.md`},
            'text/markdown; charset=utf-8', 100, ${"a".repeat(64)},
            'completed', 'generation_activation', 'visible',
            ${`${item.sourceFileId}.md`}, ${item.relativePath},
            ${item.relativePath}, ${item.revisionId}, '{}'::jsonb,
            ${item.deleted ? "2026-07-24T00:00:00.000Z" : null}
          )
        `;
        await transaction`
          INSERT INTO focowiki.source_revisions (
            id, knowledge_base_id, source_file_id, revision, object_key,
            content_type, size_bytes, checksum_sha256, processing_status,
            metadata_json
          ) VALUES (
            ${item.revisionId}, 'kb-lexical-migration', ${item.sourceFileId},
            ${item.sourceFileId === "source-changed" ? 2 : 1},
            ${`sources/${item.sourceFileId}.md`},
            'text/markdown; charset=utf-8', 100, ${"a".repeat(64)},
            'completed', '{}'::jsonb
          )
        `;
      }
      await transaction`
        INSERT INTO focowiki.source_revisions (
          id, knowledge_base_id, source_file_id, revision, object_key,
          content_type, size_bytes, checksum_sha256, processing_status,
          metadata_json
        ) VALUES (
          'revision-changed-old', 'kb-lexical-migration', 'source-changed', 1,
          'sources/source-changed-old.md', 'text/markdown; charset=utf-8',
          100, ${"b".repeat(64)}, 'superseded', '{}'::jsonb
        )
      `;
      await transaction`
        INSERT INTO focowiki.knowledge_base_lexical_rebuilds (
          knowledge_base_id, target_search_schema_version,
          target_tokenizer_contract_version, target_segmentation_version,
          target_content_profile_version,
          target_graph_lexical_projection_version,
          base_generation_id, target_generation_id, state, phase,
          processed_source_count, total_source_count,
          lease_owner, lease_token, lease_expires_at, heartbeat_at,
          attempt_count, max_attempts, started_at, updated_at
        ) VALUES
          (
            'kb-lexical-migration', 'body-search-v1', 'tokenizer-v2',
            'body-segmentation-v1', 'content-profile-v2', 'graph-lexical-v2',
            'generation-lexical-active', 'generation-lexical-target',
            'running', 'documents', 99, 99,
            'maintenance-worker-legacy', 'legacy-lease',
            '2099-07-24T00:00:00.000Z', '2026-07-24T00:00:00.000Z',
            2, 5, '2026-07-24T00:00:00.000Z', '2026-07-24T00:00:00.000Z'
          ),
          (
            'kb-lexical-completed', 'body-search-v1', 'tokenizer-v2',
            'body-segmentation-v1', 'content-profile-v2', 'graph-lexical-v2',
            'generation-completed-active', 'generation-completed-target',
            'completed', 'cleanup', 0, 0, NULL, NULL, NULL, NULL,
            0, 5, '2026-07-24T00:00:00.000Z', '2026-07-24T00:00:00.000Z'
          )
      `;
      await seedValidProjection(transaction, {
        sourceFileId: "source-valid",
        revisionId: "revision-valid",
        logicalPath: "pages/guides/valid.md"
      });
      await seedValidProjection(transaction, {
        sourceFileId: "source-moved",
        revisionId: "revision-moved",
        logicalPath: "pages/old/moved.md"
      });
      await seedValidProjection(transaction, {
        sourceFileId: "source-changed",
        revisionId: "revision-changed-old",
        logicalPath: "pages/guides/changed.md"
      });
    });
  }

  async function seedValidProjection(
    transaction: postgres.TransactionSql,
    input: {
      sourceFileId: string;
      revisionId: string;
      logicalPath: string;
    }
  ): Promise<void> {
    const documentId = `search-${input.sourceFileId}`;
    await transaction`
      INSERT INTO focowiki.search_projection_documents (
        id, knowledge_base_id, source_file_id, source_revision_id,
        source_body_checksum_sha256, search_schema_version,
        tokenizer_contract_version, segmentation_version,
        segment_count, lifecycle_state, completed_at
      ) VALUES (
        ${documentId}, 'kb-lexical-migration', ${input.sourceFileId},
        ${input.revisionId}, ${"a".repeat(64)}, 'body-search-v1',
        'tokenizer-v2', 'body-segmentation-v1', 0, 'ready', now()
      )
    `;
    await transaction`
      INSERT INTO focowiki.generation_search_projection_refs (
        knowledge_base_id, generation_id, source_file_id, source_revision_id,
        search_document_id, search_schema_version, tokenizer_contract_version,
        segmentation_version, logical_path, title
      ) VALUES (
        'kb-lexical-migration', 'generation-lexical-target',
        ${input.sourceFileId}, ${input.revisionId}, ${documentId},
        'body-search-v1', 'tokenizer-v2', 'body-segmentation-v1',
        ${input.logicalPath}, ${input.sourceFileId}
      )
    `;
    await transaction`
      INSERT INTO focowiki.source_file_graph_nodes (
        knowledge_base_id, source_file_id, path, title,
        tokenizer_contract_version, lexical_projection_version
      ) VALUES (
        'kb-lexical-migration', ${input.sourceFileId}, ${input.logicalPath},
        ${input.sourceFileId}, 'tokenizer-v2', 'content-profile-v2'
      )
    `;
    await transaction`
      INSERT INTO focowiki.source_file_graph_term_documents (
        knowledge_base_id, source_file_id, source_revision_id,
        term_fingerprint, lexical_text, tokenizer_contract_version,
        lexical_projection_version
      ) VALUES (
        'kb-lexical-migration', ${input.sourceFileId}, ${input.revisionId},
        ${"c".repeat(64)}, ${input.sourceFileId},
        'tokenizer-v2', 'graph-lexical-v2'
      )
    `;
  }
});

function databaseConnectionUrl(url: string, databaseName: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${databaseName}`;
  return parsed.toString();
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll("\"", "\"\"")}"`;
}
