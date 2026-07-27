import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { LexicalRebuildSettingsSnapshot } from "../src/application/ports/lexical-rebuild-work-repository.js";
import { applyMigrations } from "../src/db/migrations.js";
import { createPostgresLexicalRebuildRepository } from "../src/infrastructure/postgres/lexical-rebuild-repository.js";
import { createPostgresLexicalRebuildWorkRepository } from "../src/infrastructure/postgres/lexical-rebuild-work-repository.js";

const databaseUrl = process.env.FOCOWIKI_TEST_DATABASE_URL;
const describeDatabase = databaseUrl ? describe : describe.skip;
const settings: LexicalRebuildSettingsSnapshot = {
  concurrency: 4,
  sourceReadConcurrency: 8,
  databaseWriteConcurrency: 2,
  claimBatchSize: 500,
  databaseBatchSize: 50,
  maxInFlightSourceBytes: 64 * 1_024 * 1_024
};

describeDatabase("lexical rebuild inverse lifecycle integration", () => {
  const connectionUrl = databaseUrl ?? "postgres://unused:unused@127.0.0.1:5432/unused";
  const databaseName = `focowiki_lexical_lifecycle_${process.pid}_${
    randomUUID().replaceAll("-", "").slice(0, 10)
  }`;
  const admin = postgres(databaseConnectionUrl(connectionUrl, "postgres"), { max: 1 });
  const sql = postgres(databaseConnectionUrl(connectionUrl, databaseName), { max: 4 });
  const repository = createPostgresLexicalRebuildWorkRepository(sql);
  const activationRepository = createPostgresLexicalRebuildRepository(sql);

  beforeAll(async () => {
    await admin.unsafe(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
    await applyMigrations(sql);
  });

  beforeEach(async () => {
    await sql`DELETE FROM focowiki.knowledge_bases WHERE id LIKE 'kb-lifecycle-%'`;
  });

  afterAll(async () => {
    await sql.end({ timeout: 5 });
    await admin.unsafe(`DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)} WITH (FORCE)`);
    await admin.end({ timeout: 5 });
  });

  it("resets only changed source work after replacement, move, or rename", async () => {
    await seedLifecycle("kb-lifecycle-change", 2);
    await sql`
      UPDATE focowiki.source_files
      SET active_revision_id = 'revision-kb-lifecycle-change-0-next',
          relative_path = 'moved/renamed.md',
          path_key = 'moved/renamed.md'
      WHERE knowledge_base_id = 'kb-lifecycle-change'
        AND id = 'source-kb-lifecycle-change-0'
    `;

    expect(await workState("kb-lifecycle-change")).toEqual([
      {
        source_file_id: "source-kb-lifecycle-change-0",
        source_revision_id: "revision-kb-lifecycle-change-0-next",
        logical_path: "pages/moved/renamed.md",
        state: "pending",
        lease_owner: null
      },
      {
        source_file_id: "source-kb-lifecycle-change-1",
        source_revision_id: "revision-kb-lifecycle-change-1",
        logical_path: "pages/source-1.md",
        state: "completed",
        lease_owner: null
      }
    ]);
    expect(await referenceSourceIds("kb-lifecycle-change")).toEqual([
      "source-kb-lifecycle-change-1"
    ]);
  });

  it("adds a newly uploaded active revision without rescanning completed sources", async () => {
    await seedLifecycle("kb-lifecycle-upload", 1);
    await sql.begin(async (transaction) => {
      await transaction`
        INSERT INTO focowiki.source_files (
          id, knowledge_base_id, object_key, content_type, size_bytes,
          checksum_sha256, processing_status, processing_stage,
          generated_output_status, name, relative_path, path_key,
          active_revision_id, metadata_json
        ) VALUES (
          'source-kb-lifecycle-upload-new', 'kb-lifecycle-upload',
          'sources/new.md', 'text/markdown; charset=utf-8', 80,
          ${"c".repeat(64)}, 'completed', 'generation_activation', 'visible',
          'new.md', 'new.md', 'new.md', 'revision-kb-lifecycle-upload-new',
          '{}'::jsonb
        )
      `;
      await transaction`
        INSERT INTO focowiki.source_revisions (
          id, knowledge_base_id, source_file_id, revision, object_key,
          content_type, size_bytes, checksum_sha256, processing_status,
          metadata_json
        ) VALUES (
          'revision-kb-lifecycle-upload-new', 'kb-lifecycle-upload',
          'source-kb-lifecycle-upload-new', 1, 'sources/new.md',
          'text/markdown; charset=utf-8', 80, ${"c".repeat(64)},
          'completed', '{}'::jsonb
        )
      `;
    });

    expect(await workState("kb-lifecycle-upload")).toEqual([
      {
        source_file_id: "source-kb-lifecycle-upload-0",
        source_revision_id: "revision-kb-lifecycle-upload-0",
        logical_path: "pages/source-0.md",
        state: "completed",
        lease_owner: null
      },
      {
        source_file_id: "source-kb-lifecycle-upload-new",
        source_revision_id: "revision-kb-lifecycle-upload-new",
        logical_path: "pages/new.md",
        state: "pending",
        lease_owner: null
      }
    ]);
    expect((await sql<Array<{
      processed_source_count: number;
      pending_source_count: number;
      total_source_count: number;
      phase: string;
    }>>`
      SELECT processed_source_count::int AS processed_source_count,
             pending_source_count::int AS pending_source_count,
             total_source_count::int AS total_source_count,
             phase
      FROM focowiki.knowledge_base_lexical_rebuilds
      WHERE knowledge_base_id = 'kb-lifecycle-upload'
    `)[0]).toEqual({
      processed_source_count: 1,
      pending_source_count: 1,
      total_source_count: 2,
      phase: "reconcile"
    });
  });

  it("cancels file source work immediately when deletion hides a source", async () => {
    await seedLifecycle("kb-lifecycle-delete", 2);
    await sql`
      UPDATE focowiki.source_files
      SET deleted_at = '2026-07-25T01:00:00.000Z'
      WHERE knowledge_base_id = 'kb-lifecycle-delete'
        AND id = 'source-kb-lifecycle-delete-0'
    `;

    expect((await workState("kb-lifecycle-delete")).map((item) => item.state)).toEqual([
      "cancelled",
      "completed"
    ]);
    expect(await referenceSourceIds("kb-lifecycle-delete")).toEqual([
      "source-kb-lifecycle-delete-1"
    ]);
  });

  it("cancels every nested source and candidate reference in a deleted directory", async () => {
    const knowledgeBaseId = "kb-lifecycle-directory-delete";
    await seedLifecycle(knowledgeBaseId, 3);
    await sql`
      UPDATE focowiki.source_files
      SET relative_path = CASE
            WHEN id = 'source-kb-lifecycle-directory-delete-0'
              THEN 'folder/source-0.md'
            WHEN id = 'source-kb-lifecycle-directory-delete-1'
              THEN 'folder/nested/source-1.md'
            ELSE 'outside/source-2.md'
          END,
          path_key = CASE
            WHEN id = 'source-kb-lifecycle-directory-delete-0'
              THEN 'folder/source-0.md'
            WHEN id = 'source-kb-lifecycle-directory-delete-1'
              THEN 'folder/nested/source-1.md'
            ELSE 'outside/source-2.md'
          END
      WHERE knowledge_base_id = ${knowledgeBaseId}
    `;
    await sql`
      UPDATE focowiki.source_files
      SET deleted_at = '2026-07-25T01:00:01.000Z'
      WHERE knowledge_base_id = ${knowledgeBaseId}
        AND (
          path_key = 'folder'
          OR path_key LIKE 'folder/%'
        )
    `;

    expect((await workState(knowledgeBaseId)).map((item) => item.state)).toEqual([
      "cancelled",
      "cancelled",
      "pending"
    ]);
    expect(await referenceSourceIds(knowledgeBaseId)).toEqual([]);
  });

  it("stops claims immediately and leaves bounded work cleanup to hard deletion", async () => {
    await seedLifecycle("kb-lifecycle-kb-delete", 2);
    await sql`
      UPDATE focowiki.knowledge_bases
      SET deleted_at = '2026-07-25T02:00:00.000Z'
      WHERE id = 'kb-lifecycle-kb-delete'
    `;

    expect((await sql<Array<{ state: string; phase: string }>>`
      SELECT state, phase
      FROM focowiki.knowledge_base_lexical_rebuilds
      WHERE knowledge_base_id = 'kb-lifecycle-kb-delete'
    `)[0]).toEqual({ state: "cancelled", phase: "cleanup" });
    expect((await workState("kb-lifecycle-kb-delete")).map((item) => item.state)).toEqual([
      "completed",
      "completed"
    ]);
    expect(await repository.claimBatch({
      workerId: "worker-hidden-knowledge-base",
      leaseTokenPrefix: "hidden",
      limit: 10,
      settingsRevision: 1,
      settings,
      now: "2026-07-25T02:00:01.000Z",
      leaseExpiresAt: "2026-07-25T02:01:01.000Z"
    })).toEqual([]);
  });

  it("defers lexical activation while normal publication is still in flight", async () => {
    const knowledgeBaseId = "kb-lifecycle-forward-publication";
    const baseGenerationId = `generation-${knowledgeBaseId}-base`;
    const targetGenerationId = `generation-${knowledgeBaseId}-target`;
    const normalGenerationId = `generation-${knowledgeBaseId}-normal`;
    await seedLifecycle(knowledgeBaseId, 1);
    await sql.begin(async (transaction) => {
      await transaction`
        UPDATE focowiki.knowledge_base_lexical_rebuilds
        SET state = 'activating',
            phase = 'activate',
            lease_owner = 'lexical-activation-worker',
            lease_token = 'lexical-activation-lease',
            lease_expires_at = '2026-07-25T03:01:00.000Z',
            heartbeat_at = '2026-07-25T03:00:00.000Z'
        WHERE knowledge_base_id = ${knowledgeBaseId}
      `;
      await transaction`
        INSERT INTO focowiki.publication_generations (
          id, knowledge_base_id, predecessor_generation_id, state,
          format_version, generation_kind
        ) VALUES (
          ${normalGenerationId}, ${knowledgeBaseId}, ${baseGenerationId},
          'validating', 2, 'normal'
        )
      `;
    });

    await expect(activationRepository.activate({
      knowledgeBaseId,
      workerId: "lexical-activation-worker",
      leaseToken: "lexical-activation-lease",
      activatedAt: "2026-07-25T03:00:01.000Z",
      retryDelayMs: 1_000
    })).resolves.toBe("deferred");

    expect((await sql<Array<{
      active_generation_id: string;
      target_state: string;
      normal_predecessor_generation_id: string;
      rebuild_state: string;
      rebuild_phase: string;
      lease_owner: string | null;
    }>>`
      SELECT knowledge_base.active_generation_id,
             target.state AS target_state,
             normal.predecessor_generation_id AS normal_predecessor_generation_id,
             rebuild.state AS rebuild_state,
             rebuild.phase AS rebuild_phase,
             rebuild.lease_owner
      FROM focowiki.knowledge_bases knowledge_base
      JOIN focowiki.publication_generations target
        ON target.knowledge_base_id = knowledge_base.id
       AND target.id = ${targetGenerationId}
      JOIN focowiki.publication_generations normal
        ON normal.knowledge_base_id = knowledge_base.id
       AND normal.id = ${normalGenerationId}
      JOIN focowiki.knowledge_base_lexical_rebuilds rebuild
        ON rebuild.knowledge_base_id = knowledge_base.id
      WHERE knowledge_base.id = ${knowledgeBaseId}
    `)[0]).toEqual({
      active_generation_id: baseGenerationId,
      target_state: "building",
      normal_predecessor_generation_id: baseGenerationId,
      rebuild_state: "pending",
      rebuild_phase: "activate",
      lease_owner: null
    });
  });

  async function seedLifecycle(knowledgeBaseId: string, sourceCount: number): Promise<void> {
    const baseGenerationId = `generation-${knowledgeBaseId}-base`;
    const targetGenerationId = `generation-${knowledgeBaseId}-target`;
    await sql.begin(async (transaction) => {
      await transaction`
        INSERT INTO focowiki.knowledge_bases (id, name)
        VALUES (${knowledgeBaseId}, ${knowledgeBaseId})
      `;
      await transaction`
        INSERT INTO focowiki.publication_generations (
          id, knowledge_base_id, state, format_version, generation_kind, activated_at
        ) VALUES (
          ${baseGenerationId}, ${knowledgeBaseId}, 'active', 2, 'normal', now()
        )
      `;
      await transaction`
        INSERT INTO focowiki.publication_generations (
          id, knowledge_base_id, predecessor_generation_id, state,
          format_version, generation_kind
        ) VALUES (
          ${targetGenerationId}, ${knowledgeBaseId}, ${baseGenerationId},
          'building', 2, 'lexical_rebuild'
        )
      `;
      await transaction`
        UPDATE focowiki.knowledge_bases
        SET active_generation_id = ${baseGenerationId}
        WHERE id = ${knowledgeBaseId}
      `;
      for (let index = 0; index < sourceCount; index += 1) {
        const sourceFileId = `source-${knowledgeBaseId}-${index}`;
        const revisionId = `revision-${knowledgeBaseId}-${index}`;
        const nextRevisionId = `${revisionId}-next`;
        const relativePath = `source-${index}.md`;
        await transaction`
          INSERT INTO focowiki.source_files (
            id, knowledge_base_id, object_key, content_type, size_bytes,
            checksum_sha256, processing_status, processing_stage,
            generated_output_status, name, relative_path, path_key,
            active_revision_id, metadata_json
          ) VALUES (
            ${sourceFileId}, ${knowledgeBaseId}, ${`sources/${sourceFileId}.md`},
            'text/markdown; charset=utf-8', 100, ${"a".repeat(64)},
            'completed', 'generation_activation', 'visible', ${relativePath},
            ${relativePath}, ${relativePath}, ${revisionId}, '{}'::jsonb
          )
        `;
        await transaction`
          INSERT INTO focowiki.source_revisions (
            id, knowledge_base_id, source_file_id, revision, object_key,
            content_type, size_bytes, checksum_sha256, processing_status,
            metadata_json
          ) VALUES
          (
            ${revisionId}, ${knowledgeBaseId}, ${sourceFileId}, 1,
            ${`sources/${sourceFileId}.md`}, 'text/markdown; charset=utf-8',
            100, ${"a".repeat(64)}, 'completed', '{}'::jsonb
          ),
          (
            ${nextRevisionId}, ${knowledgeBaseId}, ${sourceFileId}, 2,
            ${`sources/${sourceFileId}-next.md`}, 'text/markdown; charset=utf-8',
            120, ${"b".repeat(64)}, 'completed', '{}'::jsonb
          )
        `;
      }
      await transaction`
        INSERT INTO focowiki.knowledge_base_lexical_rebuilds (
          knowledge_base_id, target_search_schema_version,
          target_tokenizer_contract_version, target_segmentation_version,
          target_content_profile_version,
          target_graph_lexical_projection_version,
          base_generation_id, target_generation_id, state, phase,
          processed_source_count, total_source_count
        ) VALUES (
          ${knowledgeBaseId}, 'body-search-v1', 'tokenizer-v1',
          'segmentation-v1', 'profile-v1', 'graph-v1',
          ${baseGenerationId}, ${targetGenerationId}, 'running', 'documents',
          ${sourceCount}, ${sourceCount}
        )
      `;
      for (let index = 0; index < sourceCount; index += 1) {
        const sourceFileId = `source-${knowledgeBaseId}-${index}`;
        const revisionId = `revision-${knowledgeBaseId}-${index}`;
        await transaction`
          INSERT INTO focowiki.lexical_rebuild_work_items (
            knowledge_base_id, target_generation_id, source_file_id,
            source_revision_id, logical_path,
            target_search_schema_version,
            target_tokenizer_contract_version,
            target_segmentation_version,
            target_content_profile_version,
            target_graph_lexical_projection_version,
            state, completed_at
          ) VALUES (
            ${knowledgeBaseId}, ${targetGenerationId}, ${sourceFileId},
            ${revisionId}, ${`pages/source-${index}.md`},
            'body-search-v1', 'tokenizer-v1', 'segmentation-v1',
            'profile-v1', 'graph-v1', 'completed', now()
          )
        `;
        await transaction`
          INSERT INTO focowiki.search_projection_documents (
            id, knowledge_base_id, source_file_id, source_revision_id,
            source_body_checksum_sha256, search_schema_version,
            tokenizer_contract_version, segmentation_version,
            segment_count, lifecycle_state, completed_at
          ) VALUES (
            ${`search-${sourceFileId}`}, ${knowledgeBaseId}, ${sourceFileId},
            ${revisionId}, ${"a".repeat(64)}, 'body-search-v1',
            'tokenizer-v1', 'segmentation-v1', 0, 'ready', now()
          )
        `;
        await transaction`
          INSERT INTO focowiki.generation_search_projection_refs (
            knowledge_base_id, generation_id, source_file_id,
            source_revision_id, search_document_id, search_schema_version,
            tokenizer_contract_version, segmentation_version,
            logical_path, title
          ) VALUES (
            ${knowledgeBaseId}, ${targetGenerationId}, ${sourceFileId},
            ${revisionId}, ${`search-${sourceFileId}`}, 'body-search-v1',
            'tokenizer-v1', 'segmentation-v1',
            ${`pages/source-${index}.md`}, ${sourceFileId}
          )
        `;
      }
    });
  }

  async function workState(knowledgeBaseId: string) {
    return sql<Array<{
      source_file_id: string;
      source_revision_id: string;
      logical_path: string;
      state: string;
      lease_owner: string | null;
    }>>`
      SELECT source_file_id, source_revision_id, logical_path, state, lease_owner
      FROM focowiki.lexical_rebuild_work_items
      WHERE knowledge_base_id = ${knowledgeBaseId}
      ORDER BY source_file_id
    `;
  }

  async function referenceSourceIds(knowledgeBaseId: string): Promise<string[]> {
    const rows = await sql<Array<{ source_file_id: string }>>`
      SELECT source_file_id
      FROM focowiki.generation_search_projection_refs
      WHERE knowledge_base_id = ${knowledgeBaseId}
      ORDER BY source_file_id
    `;
    return rows.map((row) => row.source_file_id);
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
