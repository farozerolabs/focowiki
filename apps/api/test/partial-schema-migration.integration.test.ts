import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  applyMigrations,
  MIGRATION_FILES,
  readMigrationSql,
  RUNTIME_SCHEMA_GENERATION
} from "../src/db/migrations.js";

const databaseUrl = process.env.FOCOWIKI_TEST_DATABASE_URL;
const describeDatabase = databaseUrl ? describe : describe.skip;

describeDatabase("partial schema compatible migration", () => {
  const connectionUrl = databaseUrl
    ?? "postgres://unused:unused@127.0.0.1:5432/unused";
  const databaseName = `focowiki_partial_migration_${process.pid}_${
    randomUUID().replaceAll("-", "").slice(0, 10)
  }`;
  const admin = postgres(databaseConnectionUrl(connectionUrl, "postgres"), { max: 1 });
  const sql = postgres(databaseConnectionUrl(connectionUrl, databaseName), { max: 2 });

  beforeAll(async () => {
    await admin.unsafe(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
    const migrationIndex = MIGRATION_FILES.indexOf(
      "012_storage_reconciliation_lease_recovery.sql"
    );
    for (const fileName of MIGRATION_FILES.slice(0, migrationIndex)) {
      await sql.begin(async (transaction) => {
        await transaction.unsafe(readMigrationSql(fileName));
      });
    }
    await sql`
      ALTER TABLE focowiki.publication_generations
      DROP CONSTRAINT publication_generations_search_version_check,
      DROP COLUMN search_schema_version,
      DROP COLUMN tokenizer_contract_version,
      DROP COLUMN search_segmentation_version
    `;
    await sql`
      ALTER TABLE focowiki.publication_generations
      ADD CONSTRAINT publication_generations_kind_check CHECK (
        generation_kind = ANY (ARRAY['normal', 'projection_repair'])
      )
    `;
    await sql`
      ALTER TABLE focowiki.generation_search_projection_refs
      DROP CONSTRAINT generation_search_projection_refs_text_bounds_check,
      DROP COLUMN segmentation_version
    `;
    await sql`
      ALTER TABLE focowiki.generation_search_projection_refs
      ADD CONSTRAINT generation_search_projection_refs_text_bounds_check CHECK (
        octet_length(logical_path) <= 4096
        AND octet_length(title) <= 4096
        AND (summary IS NULL OR octet_length(summary) <= 16384)
        AND (source_url IS NULL OR octet_length(source_url) <= 8192)
      )
    `;
    await sql`
      ALTER TABLE focowiki.knowledge_base_lexical_rebuilds
      DROP CONSTRAINT knowledge_base_lexical_rebuilds_version_check,
      DROP COLUMN target_content_profile_version,
      DROP COLUMN target_graph_lexical_projection_version
    `;
    await sql`
      ALTER TABLE focowiki.knowledge_base_lexical_rebuilds
      ADD CONSTRAINT knowledge_base_lexical_rebuilds_version_check CHECK (
        char_length(target_search_schema_version) BETWEEN 1 AND 160
        AND char_length(target_tokenizer_contract_version) BETWEEN 1 AND 200
        AND char_length(target_segmentation_version) BETWEEN 1 AND 160
      )
    `;
    await sql`
      ALTER TABLE focowiki.storage_reconciliation_candidates
      ADD COLUMN deletion_lease_token text
    `;
    await sql`
      CREATE TABLE focowiki.storage_reconciliation_page_checkpoints (
        prefix text NOT NULL,
        cycle_id text NOT NULL,
        page_id text NOT NULL,
        continuation_token text,
        next_continuation_token text,
        expected_chunk_count integer NOT NULL,
        listed_count integer NOT NULL,
        protected_count integer DEFAULT 0 NOT NULL,
        pending_count integer DEFAULT 0 NOT NULL,
        quarantined_count integer DEFAULT 0 NOT NULL,
        resolved_count integer DEFAULT 0 NOT NULL,
        committed_at timestamp with time zone,
        created_at timestamp with time zone DEFAULT now() NOT NULL,
        updated_at timestamp with time zone DEFAULT now() NOT NULL,
        CONSTRAINT storage_reconciliation_page_checkpoints_pkey PRIMARY KEY (
          prefix, cycle_id, page_id
        ),
        CONSTRAINT storage_reconciliation_page_checkpoints_counts_check CHECK (
          expected_chunk_count >= 0
          AND listed_count >= 0
          AND protected_count >= 0
          AND pending_count >= 0
          AND quarantined_count >= 0
          AND resolved_count >= 0
        )
      )
    `;
  }, 120_000);

  afterAll(async () => {
    await sql.end({ timeout: 5 });
    await admin.unsafe(`DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)} WITH (FORCE)`);
    await admin.end({ timeout: 5 });
  });

  it("finishes an interrupted compatible migration without dropping business data", async () => {
    await expect(applyMigrations(sql)).resolves.toBeUndefined();
    await expect(applyMigrations(sql)).resolves.toBeUndefined();

    const generation = await sql<Array<{ generation: string }>>`
      SELECT generation
      FROM focowiki.runtime_generation
      WHERE singleton = true
    `;
    const columns = await sql<Array<{ count: number }>>`
      SELECT count(*)::int AS count
      FROM information_schema.columns
      WHERE table_schema = 'focowiki' AND (
        (
          table_name = 'storage_reconciliation_candidates'
          AND column_name = 'deletion_lease_token'
        )
        OR (
          table_name = 'generation_search_projection_refs'
          AND column_name = 'segmentation_version'
        )
        OR (
          table_name = 'knowledge_base_lexical_rebuilds'
          AND column_name IN (
            'target_content_profile_version',
            'target_graph_lexical_projection_version'
          )
        )
        OR (
          table_name = 'publication_generations'
          AND column_name IN (
            'search_schema_version',
            'tokenizer_contract_version',
            'search_segmentation_version'
          )
        )
      )
    `;
    const obsoleteConstraints = await sql<Array<{ count: number }>>`
      SELECT count(*)::int AS count
      FROM pg_constraint
      WHERE conrelid = 'focowiki.publication_generations'::regclass
        AND conname = 'publication_generations_kind_check'
    `;
    const pageCheckpointColumns = await sql<Array<{
      column_name: string;
      is_nullable: string;
      column_default: string | null;
    }>>`
      SELECT column_name, is_nullable, column_default
      FROM information_schema.columns
      WHERE table_schema = 'focowiki'
        AND table_name = 'storage_reconciliation_page_checkpoints'
        AND column_name = 'database_chunk_size'
    `;

    expect(generation[0]?.generation).toBe(RUNTIME_SCHEMA_GENERATION);
    expect(columns[0]?.count).toBe(7);
    expect(obsoleteConstraints[0]?.count).toBe(0);
    expect(pageCheckpointColumns).toEqual([{
      column_name: "database_chunk_size",
      is_nullable: "NO",
      column_default: "100"
    }]);
  });
});

function databaseConnectionUrl(url: string, databaseName: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${databaseName}`;
  return parsed.toString();
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll("\"", "\"\"")}"`;
}
