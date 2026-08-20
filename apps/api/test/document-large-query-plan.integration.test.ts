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
    await seedDeepWaitingQueue(sql);
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
      name: "deep waiting-work claim",
      expectedIndexes: ["document_artifact_work_claim_idx"],
      query: `
        SELECT work.public_id
        FROM focowiki.document_artifact_work work
        JOIN focowiki.document_processing_jobs job
          ON job.knowledge_base_id = work.knowledge_base_id
         AND job.public_id = work.document_job_public_id
         AND job.source_revision_public_id = work.source_revision_public_id
        WHERE work.state = 'waiting'
          AND work.attempt_count < work.maximum_attempts
          AND work.work_kind = 'relation_reconcile'
          AND work.next_eligible_at <= now()
          AND job.state IN ('waiting', 'processing', 'available')
          AND job.cancellation_requested_at IS NULL
          AND EXISTS (
            SELECT 1
            FROM focowiki.document_artifact_work prerequisite
            JOIN focowiki.document_artifact_receipts receipt
              ON receipt.work_public_id = prerequisite.public_id
            WHERE prerequisite.knowledge_base_id = work.knowledge_base_id
              AND prerequisite.document_job_public_id
                = work.document_job_public_id
              AND prerequisite.source_revision_public_id
                = work.source_revision_public_id
              AND prerequisite.work_kind = 'graphrag'
              AND prerequisite.state = 'completed'
          )
        ORDER BY work.next_eligible_at, work.created_at, work.public_id
        LIMIT 64
        FOR UPDATE OF work SKIP LOCKED
      `
    },
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
      name: "terminal page candidate release",
      expectedIndexes: [
        "generated_page_candidates_work_state_idx",
        "generated_page_candidates_active_idx"
      ],
      query: `
        WITH job_work AS (
          SELECT public_id
          FROM focowiki.document_artifact_work
          WHERE knowledge_base_id = 'knowledge-base-plan'
            AND document_job_public_id = 'document-job-plan'
        ), releasable AS (
          SELECT candidate.public_id, candidate.object_id
          FROM job_work
          JOIN focowiki.generated_page_candidates candidate
            ON candidate.knowledge_base_id = 'knowledge-base-plan'
           AND candidate.source_work_public_id = job_work.public_id
          WHERE NOT EXISTS (
            SELECT 1 FROM focowiki.generated_page_heads head
            WHERE head.knowledge_base_id = candidate.knowledge_base_id
              AND head.page_candidate_public_id = candidate.public_id
          )
          UNION
          SELECT candidate.public_id, candidate.object_id
          FROM focowiki.generated_page_candidates candidate
          WHERE candidate.knowledge_base_id = 'knowledge-base-plan'
            AND candidate.state = 'active'
            AND NOT EXISTS (
              SELECT 1 FROM focowiki.generated_page_heads head
              WHERE head.knowledge_base_id = candidate.knowledge_base_id
                AND head.page_candidate_public_id = candidate.public_id
            )
        )
        SELECT public_id, object_id FROM releasable ORDER BY public_id
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
    },
    {
      name: "current-revision relationship projection closure",
      expectedIndexes: [
        "canonical_file_relations_first_active_idx",
        "canonical_file_relations_second_active_idx",
        "canonical_file_relations_first_pending_projection_idx",
        "canonical_file_relations_second_pending_projection_idx"
      ],
      query: `
        WITH closure AS (
          SELECT public_id
          FROM focowiki.canonical_file_relations
          WHERE knowledge_base_id = 'knowledge-base-plan'
            AND active AND retired_at IS NULL
            AND (
              (first_source_file_public_id = 'source-file-plan'
                AND first_source_revision_public_id = 'source-revision-plan')
              OR
              (second_source_file_public_id = 'source-file-plan'
                AND second_source_revision_public_id = 'source-revision-plan')
            )
          UNION ALL
          SELECT public_id
          FROM focowiki.canonical_file_relations
          WHERE knowledge_base_id = 'knowledge-base-plan'
            AND NOT active AND retired_at IS NULL
            AND (
              (first_source_file_public_id = 'source-file-plan'
                AND first_source_revision_public_id = 'source-revision-plan')
              OR
              (second_source_file_public_id = 'source-file-plan'
                AND second_source_revision_public_id = 'source-revision-plan')
            )
        )
        SELECT public_id FROM closure ORDER BY public_id
        LIMIT 501
      `
    }
  ])("uses bounded indexes for $name", async ({ name, expectedIndexes, query }) => {
    const plans = await sql.begin(async (transaction) => {
      await transaction`SET LOCAL enable_seqscan = off`;
      return transaction.unsafe(`EXPLAIN (${
        name === "deep waiting-work claim" ? "ANALYZE, BUFFERS, " : ""
      }FORMAT JSON) ${query}`);
    });
    const plan = JSON.stringify(plans);
    expect(plan).toMatch(/Index (?:Only )?Scan/u);
    expect(plan).not.toContain('"Node Type":"Seq Scan"');
    expect(
      expectedIndexes.some((indexName) => plan.includes(indexName)),
      plan
    ).toBe(true);
    if (name === "deep waiting-work claim") {
      expect(plan).toContain("document_artifact_work_claim_idx");
      expect(plan).toContain("document_artifact_work_pkey");
      expect(plan).toContain("document_artifact_receipts_work_idx");
      const executionMilliseconds = Number(
        /"Execution Time":([0-9.]+)/u.exec(plan)?.[1]
      );
      expect(executionMilliseconds).toBeGreaterThanOrEqual(0);
      expect(executionMilliseconds).toBeLessThan(1_000);
    }
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

async function seedDeepWaitingQueue(sql: postgres.Sql): Promise<void> {
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
        state, maximum_attempts, accepted_at
      ) VALUES (
        'deep-job', 'deep-kb', 'deep-operation',
        'deep-source', 'deep-revision', 'deep-settings',
        'deep-model', 1, 'deep-embedding', 'deep-semantic',
        'deep-contract', 'processing', 3, now()
      )
    `;
    await transaction`
      INSERT INTO focowiki.document_artifact_work (
        public_id, knowledge_base_id, document_job_public_id,
        source_file_public_id, source_revision_public_id,
        work_kind, resource_lane, input_fingerprint_sha256,
        state, maximum_attempts, next_eligible_at
      ) VALUES (
        'deep-prerequisite', 'deep-kb', 'deep-job',
        'deep-source', 'deep-revision', 'graphrag',
        'graphrag_adapter', ${"f".repeat(64)}, 'completed', 3, now()
      )
    `;
    await transaction`
      INSERT INTO focowiki.document_artifact_receipts (
        public_id, knowledge_base_id, document_job_public_id,
        work_public_id, source_file_public_id, source_revision_public_id,
        receipt_kind, receipt_key, input_fingerprint_sha256,
        output_fingerprint_sha256, receipt
      ) VALUES (
        'deep-prerequisite-receipt', 'deep-kb', 'deep-job',
        'deep-prerequisite', 'deep-source', 'deep-revision',
        'graphrag', 'deep', ${"f".repeat(64)}, ${"e".repeat(64)}, '{}'::jsonb
      )
    `;
    await transaction.unsafe(`
      INSERT INTO focowiki.document_artifact_work (
        public_id, knowledge_base_id, document_job_public_id,
        source_file_public_id, source_revision_public_id,
        work_kind, resource_lane, input_fingerprint_sha256,
        state, maximum_attempts, next_eligible_at, created_at, updated_at
      )
      SELECT 'deep-work-' || item::text, 'deep-kb', 'deep-job',
             'deep-source', 'deep-revision', 'relation_reconcile',
             'coordination', lpad(to_hex(item), 64, '0'),
             'waiting', 3, now() - interval '1 minute',
             now() + item * interval '1 microsecond', now()
      FROM generate_series(1, 100000) item
    `);
  });
  await sql`ANALYZE focowiki.document_artifact_work`;
  await sql`ANALYZE focowiki.document_artifact_receipts`;
  await sql`ANALYZE focowiki.document_processing_jobs`;
}
