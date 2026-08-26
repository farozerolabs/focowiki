import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MIGRATION_FILES, readMigrationSql } from "../src/db/migrations.js";

const databaseUrl = process.env.FOCOWIKI_STORAGE_VNEXT_TEST_DATABASE_URL;
const runOwner = process.env.FOCOWIKI_STORAGE_VNEXT_TEST_RUN_OWNER;
const enabled = Boolean(databaseUrl && runOwner
  && /^svnext-[a-z0-9]{8,16}$/u.test(runOwner));
const FOUNDATION_MIGRATION = "013_single_job_publication_foundation.sql";
const foundationIndex = MIGRATION_FILES.indexOf(FOUNDATION_MIGRATION);

(enabled ? describe : describe.skip)("single-job publication migration", () => {
  const connectionUrl = databaseUrl
    ?? "postgres://unused:unused@127.0.0.1:5432/unused";
  const databaseName = `focowiki_single_migration_${
    (runOwner ?? "invalid").replaceAll("-", "_")
  }_${randomUUID().replaceAll("-", "").slice(0, 8)}`;
  const admin = postgres(withDatabase(connectionUrl, "postgres"), { max: 1 });
  const sql = postgres(withDatabase(connectionUrl, databaseName), { max: 4 });
  let databaseCreated = false;

  beforeAll(async () => {
    await admin.unsafe(`CREATE DATABASE ${quote(databaseName)}`);
    databaseCreated = true;
    for (const file of MIGRATION_FILES.slice(0, foundationIndex)) {
      await sql.unsafe(readMigrationSql(file));
    }
    await seedLegacyStrandedState();
  }, 120_000);

  afterAll(async () => {
    await sql.end({ timeout: 5 });
    if (databaseCreated) {
      await admin.unsafe(`DROP DATABASE IF EXISTS ${quote(databaseName)} WITH (FORCE)`);
    }
    await admin.end({ timeout: 5 });
  }, 120_000);

  it("preserves active data and converts the unfinished boundary once",
    async () => {
      await sql.unsafe(readMigrationSql(FOUNDATION_MIGRATION));
      await expect(sql<Array<{
        mutation_public_id: string;
        outcome: string;
        readiness_sequence: number | string;
        prior_logical_path: string | null;
        next_logical_path: string | null;
      }>>`
        SELECT mutation_public_id, outcome, readiness_sequence,
               prior_logical_path, next_logical_path
        FROM focowiki.publication_items
        WHERE knowledge_base_id = 'legacy-stranded-kb'
        ORDER BY readiness_sequence
      `).resolves.toEqual(expect.arrayContaining([{
        mutation_public_id: "legacy-ready-mutation",
        outcome: "pending",
        readiness_sequence: "1",
        prior_logical_path: null,
        next_logical_path: "ready.md"
      }]));
      await expect(sql<Array<{
        item_count: number | string;
        maximum_sequence: number | string;
      }>>`
        SELECT count(*) AS item_count,
               max(readiness_sequence) AS maximum_sequence
        FROM focowiki.publication_items
        WHERE knowledge_base_id = 'legacy-stranded-kb'
      `).resolves.toEqual([{
        item_count: "302",
        maximum_sequence: "309"
      }]);
      await expect(sql<Array<{
        active_revision: number | string;
        active_readiness_sequence: number | string;
        source_count: number | string;
      }>>`
        SELECT head.active_revision, head.active_readiness_sequence,
               count(source.public_id) AS source_count
        FROM focowiki.knowledge_base_publication_heads head
        JOIN focowiki.source_files source
          ON source.knowledge_base_id = head.knowledge_base_id
        WHERE head.knowledge_base_id = 'legacy-stranded-kb'
        GROUP BY head.active_revision, head.active_readiness_sequence
      `).resolves.toEqual([{
        active_revision: "0",
        active_readiness_sequence: "0",
        source_count: "1"
      }]);
      await expect(sql<Array<{ count: number | string }>>`
        SELECT count(*) AS count FROM focowiki.publication_items
        WHERE knowledge_base_id = 'legacy-stranded-kb'
      `).resolves.toEqual([{ count: "302" }]);
      await expect(sql<Array<{
        knowledge_base_id: string;
        active_revision: number | string;
        active_readiness_sequence: number | string;
      }>>`
        SELECT knowledge_base_id, active_revision,
               active_readiness_sequence
        FROM focowiki.knowledge_base_publication_heads
        WHERE knowledge_base_id IN ('legacy-active-only-kb', 'legacy-deleted-kb')
        ORDER BY knowledge_base_id
      `).resolves.toEqual([
        {
          knowledge_base_id: "legacy-active-only-kb",
          active_revision: "3",
          active_readiness_sequence: "9"
        },
        {
          knowledge_base_id: "legacy-deleted-kb",
          active_revision: "0",
          active_readiness_sequence: "0"
        }
      ]);
      await expect(sql<Array<{ count: number | string }>>`
        SELECT count(*) AS count FROM focowiki.publication_items
        WHERE knowledge_base_id = 'legacy-deleted-kb'
      `).resolves.toEqual([{ count: "0" }]);
      await expect(sql<Array<{ definition: string }>>`
        SELECT pg_get_constraintdef(constraint_oid) AS definition
        FROM (
          SELECT relation_constraint.oid AS constraint_oid
          FROM pg_constraint relation_constraint
          WHERE relation_constraint.conrelid
                  = 'focowiki.publication_items'::regclass
            AND relation_constraint.confrelid
                  = 'focowiki.document_processing_jobs'::regclass
        ) publication_item_job_constraint
      `).resolves.toEqual([{
        definition: expect.stringContaining("ON DELETE SET NULL")
      }]);
      await sql`
        INSERT INTO focowiki.publication_jobs (
          public_id, knowledge_base_id, base_active_revision,
          target_readiness_sequence, renderer_contract_version,
          settings_snapshot, outcome, next_eligible_at,
          created_at, updated_at
        ) VALUES (
          'legacy-membership-job', 'legacy-stranded-kb', 0, 1,
          'portable-okf-v5', '{}'::jsonb, 'pending', now(), now(), now()
        )
      `;
      await sql`
        INSERT INTO focowiki.publication_job_items (
          job_public_id, item_public_id, membership_order
        )
        SELECT 'legacy-membership-job', public_id, 0
        FROM focowiki.publication_items
        WHERE knowledge_base_id = 'legacy-stranded-kb'
          AND mutation_public_id = 'legacy-ready-mutation'
      `;
      await sql`
        DELETE FROM focowiki.document_processing_jobs
        WHERE public_id = 'legacy-document-job'
      `;
      await expect(sql<Array<{
        document_job_public_id: string | null;
        job_public_id: string;
      }>>`
        SELECT item.document_job_public_id, membership.job_public_id
        FROM focowiki.publication_items item
        JOIN focowiki.publication_job_items membership
          ON membership.item_public_id = item.public_id
        WHERE item.knowledge_base_id = 'legacy-stranded-kb'
      `).resolves.toEqual([{
        document_job_public_id: null,
        job_public_id: "legacy-membership-job"
      }]);
      await expect(sql<Array<{ legacy_table_count: number | string }>>`
        SELECT count(*) AS legacy_table_count
        FROM pg_class relation
        JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
        WHERE namespace.nspname = 'focowiki'
          AND relation.relname IN (
            'projection_publication_generations',
            'projection_scope_generations',
            'projection_scope_generation_pages',
            'projection_cutover_states'
          )
      `).resolves.toEqual([{ legacy_table_count: "0" }]);
      await expect(sql<Array<{
        state: string;
        active: boolean;
      }>>`
        SELECT state, active FROM focowiki.search_family_receipts
        WHERE public_id = 'legacy-staged-search-receipt'
      `).resolves.toEqual([{ state: "buffered", active: false }]);
      await expect(sql<Array<{
        blocking_work_kind: string;
        state: string;
      }>>`
        SELECT blocking_work_kind, state
        FROM focowiki.document_processing_jobs
        WHERE public_id LIKE 'legacy-upstream-%'
        ORDER BY blocking_work_kind COLLATE "C"
      `).resolves.toEqual([
        "activate",
        "cleanup",
        "content_projection",
        "first_layer",
        "graphrag",
        "knowledge_projection",
        "prepare",
        "relation_reconcile"
      ].map((blocking_work_kind) => ({
        blocking_work_kind,
        state: "processing"
      })));
      await expect(sql<Array<{ count: number | string }>>`
        SELECT count(*) AS count
        FROM focowiki.publication_items item
        WHERE item.document_job_public_id LIKE 'legacy-upstream-%'
      `).resolves.toEqual([{ count: "0" }]);
      await expect(sql<Array<{ count: number | string }>>`
        SELECT count(*) AS count
        FROM focowiki.publication_items item
        WHERE item.mutation_public_id = 'legacy-ready-mutation'
      `).resolves.toEqual([{ count: "1" }]);
    });

  it("rolls back an interrupted clean migration and converges on rerun",
    async () => {
      const retryDatabaseName = `${databaseName}_retry`;
      const retrySql = postgres(withDatabase(connectionUrl, retryDatabaseName), {
        max: 1
      });
      await admin.unsafe(`CREATE DATABASE ${quote(retryDatabaseName)}`);
      try {
        for (const file of MIGRATION_FILES.slice(0, foundationIndex)) {
          await retrySql.unsafe(readMigrationSql(file));
        }
        await expect(retrySql.begin(async (rawTransaction) => {
          const transaction = rawTransaction as unknown as typeof retrySql;
          await transaction.unsafe(readMigrationSql(FOUNDATION_MIGRATION));
          throw new Error("injected migration interruption");
        })).rejects.toThrow("injected migration interruption");
        await expect(retrySql<Array<{ relation: string | null }>>`
          SELECT to_regclass('focowiki.publication_items')::text AS relation
        `).resolves.toEqual([{ relation: null }]);
        await retrySql.unsafe(readMigrationSql(FOUNDATION_MIGRATION));
        await expect(retrySql<Array<{
          relation: string | null;
          item_count: number | string;
        }>>`
          SELECT to_regclass('focowiki.publication_items')::text AS relation,
                 (SELECT count(*) FROM focowiki.publication_items) AS item_count
        `).resolves.toEqual([{
          relation: "focowiki.publication_items",
          item_count: "0"
        }]);
      } finally {
        await retrySql.end({ timeout: 5 });
        await admin.unsafe(
          `DROP DATABASE IF EXISTS ${quote(retryDatabaseName)} WITH (FORCE)`
        );
      }
    }, 120_000);

  async function seedLegacyStrandedState(): Promise<void> {
    await sql`
      INSERT INTO focowiki.knowledge_bases (public_id, name, revision)
      VALUES ('legacy-stranded-kb', 'Legacy stranded', 1),
             ('legacy-active-only-kb', 'Legacy active only', 1),
             ('legacy-deleted-kb', 'Legacy deleted', 1)
    `;
    await sql`
      UPDATE focowiki.knowledge_bases
      SET deleted_at = '2026-08-25T12:00:00.000Z'
      WHERE public_id = 'legacy-deleted-kb'
    `;
    await sql`
      INSERT INTO focowiki.knowledge_base_projection_heads (
        knowledge_base_id, active_fact_epoch, head_version
      ) VALUES ('legacy-stranded-kb', 0, 0),
               ('legacy-active-only-kb', 9, 3),
               ('legacy-deleted-kb', 0, 0)
    `;
    await sql`
      INSERT INTO focowiki.knowledge_base_sequences (
        knowledge_base_id, current_sequence
      ) VALUES ('legacy-stranded-kb', 0),
               ('legacy-deleted-kb', 0)
    `;
    await sql`
      INSERT INTO focowiki.object_registrations (
        object_id, storage_key, checksum_sha256, byte_count, content_type,
        object_format, state, write_attempt_public_id,
        reservation_expires_at, verified_at, created_at
      ) VALUES (
        'legacy-source-object', 'objects/legacy-source-object',
        ${"1".repeat(64)}, 10, 'text/markdown; charset=utf-8',
        'source-markdown-v1', 'verified', 'legacy-source-attempt',
        NULL, '2026-08-25T13:00:00.000Z',
        '2026-08-25T12:00:00.000Z'
      ), (
        'legacy-partial-object', 'objects/legacy-partial-object',
        ${"4".repeat(64)}, 20, 'text/markdown; charset=utf-8',
        'okf-generated-markdown-v1', 'reserved', 'legacy-partial-attempt',
        '2026-08-25T14:00:00.000Z', NULL,
        '2026-08-25T13:00:00.000Z'
      )
    `;
    await sql`
      INSERT INTO focowiki.source_files (
        public_id, knowledge_base_id, logical_path, normalized_path,
        title, metadata, revision
      ) VALUES (
        'legacy-source', 'legacy-stranded-kb', 'ready.md', 'ready.md',
        'Ready', '{}'::jsonb, 1
      ), (
        'legacy-deleted-source', 'legacy-deleted-kb', 'deleted.md',
        'deleted.md', 'Deleted', '{}'::jsonb, 1
      )
    `;
    await sql`
      INSERT INTO focowiki.source_revisions (
        public_id, knowledge_base_id, source_file_public_id, object_id,
        checksum_sha256, byte_count, content_type
      ) VALUES (
        'legacy-revision', 'legacy-stranded-kb', 'legacy-source',
        'legacy-source-object', ${"1".repeat(64)}, 10,
        'text/markdown; charset=utf-8'
      ), (
        'legacy-deleted-revision', 'legacy-deleted-kb',
        'legacy-deleted-source', 'legacy-source-object', ${"1".repeat(64)},
        10, 'text/markdown; charset=utf-8'
      )
    `;
    await sql`
      INSERT INTO focowiki.source_file_active_revisions (
        knowledge_base_id, source_file_public_id,
        current_source_revision_public_id, active_source_revision_public_id,
        activation_sequence
      ) VALUES (
        'legacy-stranded-kb', 'legacy-source', 'legacy-revision', NULL, 0
      ), (
        'legacy-deleted-kb', 'legacy-deleted-source',
        'legacy-deleted-revision', NULL, 0
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
        'legacy-stranded-kb', 'legacy-source', 'legacy-revision',
        'ready.md', 'ready.md', 'Ready', 'Ready', '{}'::jsonb,
        '{}'::text[], '{}'::text[], 'text/markdown; charset=utf-8',
        ${"1".repeat(64)}, 10, 'tokenizer-v1', ${"2".repeat(64)}, false
      ), (
        'legacy-deleted-kb', 'legacy-deleted-source',
        'legacy-deleted-revision', 'deleted.md', 'deleted.md', 'Deleted',
        'Deleted', '{}'::jsonb, '{}'::text[], '{}'::text[],
        'text/markdown; charset=utf-8', ${"1".repeat(64)}, 10,
        'tokenizer-v1', ${"2".repeat(64)}, false
      )
    `;
    await sql.begin(async (rawTransaction) => {
      const transaction = rawTransaction as unknown as typeof sql;
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
          state, maximum_attempts, accepted_at, started_at, created_at
        ) VALUES (
          'legacy-document-job', 'legacy-stranded-kb',
          'legacy-document-operation', 'legacy-source', 'legacy-revision',
          'legacy-settings', 'legacy-model', 1, 'legacy-embedding',
          'legacy-semantic', 'legacy-contract', 'processing', 3,
          '2026-08-25T13:00:00.000Z', '2026-08-25T13:00:00.000Z',
          '2026-08-25T13:00:00.000Z'
        )
      `;
      await transaction`
        INSERT INTO focowiki.document_processing_jobs (
          public_id, knowledge_base_id, operation_public_id,
          source_file_public_id, source_revision_public_id,
          runtime_settings_revision_public_id,
          generation_model_configuration_public_id,
          generation_model_configuration_revision,
          embedding_configuration_revision_public_id,
          semantic_generation_public_id, semantic_contract_version,
          state, maximum_attempts, accepted_at, started_at, created_at,
          active_work_kinds, blocking_work_kind
        )
        SELECT 'legacy-upstream-' || stage.stage,
               'legacy-stranded-kb',
               'legacy-operation-' || stage.stage,
               'legacy-source-' || stage.stage,
               'legacy-revision-' || stage.stage,
               'legacy-settings', 'legacy-model', 1,
               'legacy-embedding', 'legacy-semantic', 'legacy-contract',
               'processing', 3,
               '2026-08-25T13:00:00.000Z'::timestamptz,
               '2026-08-25T13:00:00.000Z'::timestamptz,
               '2026-08-25T13:00:00.000Z'::timestamptz,
               ARRAY[stage.stage]::text[], stage.stage
        FROM unnest(ARRAY[
          'prepare', 'first_layer', 'content_projection', 'graphrag',
          'relation_reconcile', 'knowledge_projection', 'activate', 'cleanup'
        ]::text[]) AS stage(stage)
      `;
    });
    await sql`
      INSERT INTO focowiki.projection_fact_epochs (
        knowledge_base_id, fact_epoch, mutation_public_id,
        source_file_public_id, source_revision_public_id, fact_kind,
        state, created_at
      ) VALUES (
        'legacy-stranded-kb', 1, 'legacy-ready-mutation',
        'legacy-source', 'legacy-revision', 'create', 'ready',
        '2026-08-25T13:00:00.000Z'
      ), (
        'legacy-stranded-kb', 2, 'legacy-superseded-mutation',
        'legacy-source', 'legacy-revision', 'replace', 'superseded',
        '2026-08-25T13:00:01.000Z'
      ), (
        'legacy-stranded-kb', 3, 'legacy-included-mutation',
        'legacy-source', 'legacy-revision', 'replace', 'included',
        '2026-08-25T13:00:02.000Z'
      ), (
        'legacy-deleted-kb', 1, 'legacy-deleted-mutation',
        'legacy-deleted-source', 'legacy-deleted-revision', 'create', 'ready',
        '2026-08-25T13:00:00.000Z'
      )
    `;
    await sql`
      INSERT INTO focowiki.projection_fact_epochs (
        knowledge_base_id, fact_epoch, mutation_public_id,
        source_file_public_id, source_revision_public_id, fact_kind,
        state, created_at
      )
      SELECT 'legacy-stranded-kb', series,
             'legacy-large-mutation-' || series,
             'legacy-source', 'legacy-revision', 'repair', 'ready',
             '2026-08-25T13:01:00.000Z'::timestamptz
               + series * interval '1 millisecond'
      FROM generate_series(10, 309) series
    `;
    await sql`
      INSERT INTO focowiki.projection_publication_generations (
        public_id, knowledge_base_id, target_fact_epoch,
        renderer_contract_version, deterministic_changed_at, state,
        input_fingerprint_sha256, created_at, updated_at
      ) VALUES (
        'legacy-stranded-generation', 'legacy-stranded-kb', 1,
        'portable-okf-v2', '2026-08-25T13:00:00.000Z', 'planned',
        ${"3".repeat(64)}, '2026-08-25T13:00:00.000Z',
        '2026-08-25T13:00:00.000Z'
      ), (
        'legacy-duplicate-generation', 'legacy-stranded-kb', 3,
        'portable-okf-v2', '2026-08-25T13:00:02.000Z', 'quarantined',
        ${"5".repeat(64)}, '2026-08-25T13:00:02.000Z',
        '2026-08-25T13:00:02.000Z'
      )
    `;
    await sql`
      INSERT INTO focowiki.projection_generation_documents (
        generation_public_id, mutation_public_id,
        source_file_public_id, source_revision_public_id, fact_epoch,
        document_job_public_id
      ) VALUES (
        'legacy-stranded-generation', 'legacy-ready-mutation',
        'legacy-source', 'legacy-revision', 1, 'legacy-document-job'
      ), (
        'legacy-duplicate-generation', 'legacy-ready-mutation',
        'legacy-source', 'legacy-revision', 1, NULL
      ), (
        'legacy-duplicate-generation', 'legacy-included-mutation',
        'legacy-source', 'legacy-revision', 3, 'legacy-document-job'
      )
    `;
    await sql`
      INSERT INTO focowiki.projection_scope_generations (
        public_id, publication_generation_public_id, knowledge_base_id,
        scope_identity, scope_kind, scope_key, scope_generation,
        lease_generation, lease_owner, lease_expires_at, heartbeat_at,
        state, input_snapshot_fingerprint_sha256, created_at, updated_at
      ) VALUES (
        'legacy-expired-scope', 'legacy-stranded-generation',
        'legacy-stranded-kb', 'source:legacy-source', 'source',
        'legacy-source', 1, 4, 'legacy-worker',
        '2026-08-25T12:00:00.000Z', '2026-08-25T11:59:00.000Z',
        'running', ${"6".repeat(64)}, '2026-08-25T11:00:00.000Z',
        '2026-08-25T11:59:00.000Z'
      )
    `;
    await sql`
      INSERT INTO focowiki.projection_scope_generation_pages (
        scope_generation_public_id, publication_generation_public_id,
        owner_scope_identity, logical_path, normalized_path, action,
        entry_kind, object_id, checksum_sha256, byte_count
      ) VALUES (
        'legacy-expired-scope', 'legacy-stranded-generation',
        'source:legacy-source', 'pages/partial.md', 'pages/partial.md',
        'put', 'source', 'legacy-partial-object', ${"4".repeat(64)}, 20
      )
    `;
    await sql`
      INSERT INTO focowiki.projection_cutover_states (
        knowledge_base_id, writer_mode, shadow_generation_public_id,
        shadow_cursor, shadow_expected_path_count,
        shadow_processed_path_count, shadow_target_fact_epoch,
        shadow_started_at, revision
      ) VALUES (
        'legacy-stranded-kb', 'shadow', 'legacy-duplicate-generation',
        'pages/partial.md', 100, 1, 3,
        '2026-08-25T11:00:00.000Z', 1
      )
    `;
    await sql`
      INSERT INTO focowiki.search_family_receipts (
        public_id, knowledge_base_id, source_file_public_id,
        source_revision_public_id, provider_kind, family,
        input_fingerprint_sha256, state, active
      ) VALUES (
        'legacy-staged-search-receipt', 'legacy-stranded-kb',
        'legacy-source', 'legacy-revision', 'meilisearch',
        'content_metadata', ${"7".repeat(64)}, 'buffered', false
      )
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
