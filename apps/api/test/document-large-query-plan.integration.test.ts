import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyStorageVnextTestMigrations } from
  "./helpers/storage-vnext-test-migrations.js";

const databaseUrl = process.env.FOCOWIKI_STORAGE_VNEXT_TEST_DATABASE_URL;
const runOwner = process.env.FOCOWIKI_STORAGE_VNEXT_TEST_RUN_OWNER;
const enabled = Boolean(databaseUrl && runOwner && /^svnext-[a-z0-9]{8,16}$/u.test(runOwner));

(enabled ? describe : describe.skip)("document large projection PostgreSQL plans", () => {
  const connectionUrl = databaseUrl
    ?? "postgres://unused:unused@127.0.0.1:5432/unused";
  const databaseName = `focowiki_document_plans_${
    (runOwner ?? "invalid").replaceAll("-", "_")
  }_${randomUUID().replaceAll("-", "").slice(0, 8)}`;
  const admin = postgres(databaseConnectionUrl(connectionUrl, "postgres"), { max: 1 });
  const sql = postgres(databaseConnectionUrl(connectionUrl, databaseName), { max: 2 });
  let databaseCreated = false;

  beforeAll(async () => {
    await admin.unsafe(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
    databaseCreated = true;
    await applyStorageVnextTestMigrations(sql);
  }, 120_000);

  afterAll(async () => {
    await sql.end({ timeout: 5 });
    if (databaseCreated) {
      await admin.unsafe(
        `DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)} WITH (FORCE)`
      );
    }
    await admin.end({ timeout: 5 });
  }, 120_000);

  it.each([
    {
      name: "relationship evaluation lookup",
      expectedIndexes: [
        "relationship_evaluations_source_idx",
        "relationship_evaluations_target_idx",
        "relationship_evaluations_identity_key"
      ],
      query: `
        SELECT target_revision_public_id, decision
        FROM focowiki.relationship_evaluations
        WHERE knowledge_base_id = 'knowledge-base-plan'
          AND source_revision_public_id = 'source-revision-plan'
        ORDER BY target_revision_public_id, created_at
        LIMIT 65
      `
    },
    {
      name: "model analysis reuse lookup",
      expectedIndexes: [
        "document_model_analysis_results_source_idx",
        "document_model_analysis_results_identity_key"
      ],
      query: `
        SELECT public_id, model_input_sha256
        FROM focowiki.document_model_analysis_results
        WHERE knowledge_base_id = 'knowledge-base-plan'
          AND source_revision_public_id = 'source-revision-plan'
        ORDER BY created_at
        LIMIT 8
      `
    },
    {
      name: "generated path pagination",
      expectedIndexes: ["generated_page_heads_path_idx"],
      query: `
        SELECT normalized_path
        FROM focowiki.generated_page_heads
        WHERE knowledge_base_id = 'knowledge-base-plan'
          AND normalized_path > 'pages/large/05000.md'
        ORDER BY normalized_path, logical_path
        LIMIT 501
      `
    },
    {
      name: "semantic page-directory scope",
      expectedIndexes: [
        "generated_page_heads_semantic_scope_idx",
        "generated_page_heads_path_idx"
      ],
      query: `
        SELECT normalized_path
        FROM focowiki.generated_page_heads
        WHERE knowledge_base_id = 'knowledge-base-plan'
          AND normalized_path LIKE '_index/pages/guides/%'
        ORDER BY normalized_path, logical_path
        LIMIT 501
      `
    },
    {
      name: "normalized source identity lookup",
      expectedIndexes: ["source_file_identity_keys_active_lookup_idx"],
      query: `
        SELECT public_id
        FROM focowiki.source_file_identity_keys
        WHERE knowledge_base_id = 'knowledge-base-plan'
          AND normalized_identity_key = 'alias:climate'
          AND state = 'active'
        ORDER BY normalized_identity_key, source_file_public_id
        LIMIT 257
      `
    },
    {
      name: "source page lookup",
      expectedIndexes: ["generated_page_heads_source_idx"],
      query: `
        SELECT normalized_path
        FROM focowiki.generated_page_heads
        WHERE knowledge_base_id = 'knowledge-base-plan'
          AND source_file_public_id = 'source-file-plan'
        ORDER BY normalized_path
        LIMIT 501
      `
    },
    {
      name: "reverse unresolved reference lookup",
      expectedIndexes: [
        "unresolved_file_references_reverse_idx",
        "unresolved_file_references_source_idx"
      ],
      query: `
        SELECT source_file_public_id
        FROM focowiki.unresolved_file_references
        WHERE knowledge_base_id = 'knowledge-base-plan'
          AND normalized_target_key = 'title:target'
          AND resolution_state = 'unresolved'
        ORDER BY source_file_public_id
        LIMIT 501
      `
    },
    {
      name: "forward active relation lookup",
      expectedIndexes: [
        "canonical_file_relations_first_active_idx",
        "canonical_file_relations_second_active_idx"
      ],
      query: `
        SELECT second_source_file_public_id
        FROM focowiki.canonical_file_relations
        WHERE knowledge_base_id = 'knowledge-base-plan'
          AND first_source_file_public_id = 'source-file-plan'
          AND active AND retired_at IS NULL
        ORDER BY second_source_file_public_id, relation_kind
        LIMIT 501
      `
    },
    {
      name: "reverse active relation lookup",
      expectedIndexes: [
        "canonical_file_relations_second_active_idx",
        "canonical_file_relations_first_active_idx"
      ],
      query: `
        SELECT first_source_file_public_id
        FROM focowiki.canonical_file_relations
        WHERE knowledge_base_id = 'knowledge-base-plan'
          AND second_source_file_public_id = 'source-file-plan'
          AND active AND retired_at IS NULL
        ORDER BY first_source_file_public_id, relation_kind
        LIMIT 501
      `
    }
  ])("uses bounded indexes for $name", async ({ expectedIndexes, query }) => {
    const plans = await sql.begin(async (transaction) => {
      await transaction`SET LOCAL enable_seqscan = off`;
      return transaction.unsafe(`EXPLAIN (FORMAT JSON) ${query}`);
    });
    const plan = JSON.stringify(plans);
    expect(plan).toMatch(/Index (?:Only )?Scan/u);
    expect(plan).not.toContain('"Node Type":"Seq Scan"');
    expect(
      expectedIndexes.some((indexName) => plan.includes(indexName)),
      plan
    ).toBe(true);
  });
});

function databaseConnectionUrl(connectionUrl: string, databaseName: string): string {
  const url = new URL(connectionUrl);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}
