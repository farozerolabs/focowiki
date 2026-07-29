import { mkdir, writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { resolve } from "node:path";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  buildExplainAnalyzeSql,
  createBodySearchPlanTargets,
  createGraphSearchPlanTargets,
  summarizeQueryPlan
} from "../src/db/query-plan-validation.js";

const databaseUrl = process.env.FOCOWIKI_TEST_DATABASE_URL;
const describeDatabase = databaseUrl
  && process.env.FOCOWIKI_RUN_SCALE_QUERY_PLAN_TESTS === "true"
  ? describe
  : describe.skip;

describeDatabase("body search query plan integration", () => {
  const pool = postgres(databaseUrl!, { max: 1 });
  let sql: Awaited<ReturnType<typeof pool.reserve>>;
  const knowledgeBaseId = "kb-body-search-plan-scale";
  const generationId = "generation-body-search-plan-scale";
  const evidence: Array<Record<string, unknown>> = [];

  beforeAll(async () => {
    sql = await pool.reserve();
    await sql`BEGIN`;
    await sql`SET CONSTRAINTS ALL DEFERRED`;
    await sql`
      INSERT INTO focowiki.knowledge_bases (id, name)
      VALUES (${knowledgeBaseId}, 'Body search plan scale')
    `;
    await sql`
      INSERT INTO focowiki.publication_generations (
        id, knowledge_base_id, state, format_version, generation_kind
      ) VALUES (${generationId}, ${knowledgeBaseId}, 'building', 2, 'normal')
    `;
  });

  afterAll(async () => {
    try {
      await writeBaselineReport(evidence);
      await sql`ROLLBACK`;
    } finally {
      sql.release();
      await pool.end({ timeout: 5 });
    }
  });

  it.each([20_000, 100_000])(
    "uses exact, token, trigram, and generation-reference indexes with %i files",
    async (fileCount) => {
      const seedStartedAt = performance.now();
      await seedTo(fileCount);
      const seedDurationMs = performance.now() - seedStartedAt;
      await sql`ANALYZE focowiki.generation_search_projection_refs`;
      await sql`ANALYZE focowiki.search_projection_segments`;
      await sql`ANALYZE focowiki.source_file_graph_term_documents`;
      const targets = [
        ...createBodySearchPlanTargets({
          knowledgeBaseId,
          generationId,
          phrase: `needle${fileCount - 1}`,
          terms: [`needle${fileCount - 1}`],
          limit: 50
        }),
        ...createGraphSearchPlanTargets({
          knowledgeBaseId,
          generationId,
          phrase: `needle${fileCount - 1}`,
          terms: [`needle${fileCount - 1}`],
          tokenizerContractVersion: "lexical-tokenizer-plan-v1",
          lexicalProjectionVersion: "graph-lexical-v2",
          limit: 50
        })
      ];
      const queryPlans: Array<Record<string, unknown>> = [];

      await sql`SET LOCAL enable_seqscan = off`;
      for (const target of targets) {
        const rows = await sql.unsafe<Array<{ "QUERY PLAN": unknown }>>(
          buildExplainAnalyzeSql(target.sql)
        );
        const summary = summarizeQueryPlan(rows[0]?.["QUERY PLAN"]);
        queryPlans.push({
          name: target.name,
          executionTimeMs: summary.executionTimeMs,
          planningTimeMs: summary.planningTimeMs,
          sharedHitBlocks: summary.sharedHitBlocks,
          sharedReadBlocks: summary.sharedReadBlocks,
          indexNames: summary.indexNames
        });
        expect(summary.sequentialScanRelations).not.toContain(
          "search_projection_segments"
        );
        expect(summary.sequentialScanRelations).not.toContain(
          "generation_search_projection_refs"
        );
        expect(summary.executionTimeMs ?? Number.POSITIVE_INFINITY).toBeLessThan(250);
        if (target.name === "body-search-token") {
          expect(
            summary.indexNames,
            JSON.stringify(summary)
          ).toContain("search_projection_segments_lexical_gin_idx");
        }
        if (target.name === "body-search-trigram") {
          expect(
            summary.indexNames,
            JSON.stringify(summary)
          ).toContain("search_projection_segments_text_trgm_idx");
        }
        if (target.name === "graph-search-token") {
          expect(
            summary.indexNames,
            JSON.stringify(summary)
          ).toContain("source_file_graph_term_documents_exact_gin_idx");
        }
        if (target.name === "graph-search-trigram") {
          expect(
            summary.indexNames,
            JSON.stringify(summary)
          ).toContain("source_file_graph_term_documents_text_trgm_idx");
        }
      }
      await sql`SET LOCAL enable_seqscan = on`;
      evidence.push({
        fileCount,
        seedDurationMs,
        processResidentMemoryBytes: process.memoryUsage().rss,
        queryPlans
      });
    },
    180_000
  );

  async function seedTo(fileCount: number): Promise<void> {
    await sql`
      INSERT INTO focowiki.source_files (
        id, knowledge_base_id, object_key, content_type, size_bytes,
        checksum_sha256, name, relative_path, path_key, active_revision_id,
        processing_status, processing_stage, generated_output_status
      )
      SELECT
        'source-body-plan-' || value,
        ${knowledgeBaseId},
        'source/body-plan/' || value,
        'text/markdown; charset=utf-8',
        32,
        md5(value::text) || md5((value + 1)::text),
        'file-' || value || '.md',
        'scale/file-' || value || '.md',
        'scale/file-' || value || '.md',
        'revision-body-plan-' || value,
        'completed',
        'generation_activation',
        'visible'
      FROM generate_series(0, ${fileCount - 1}) value
      ON CONFLICT (id) DO NOTHING
    `;
    await sql`
      INSERT INTO focowiki.source_revisions (
        id, knowledge_base_id, source_file_id, revision, object_key,
        content_type, size_bytes, checksum_sha256, processing_status
      )
      SELECT
        'revision-body-plan-' || value,
        ${knowledgeBaseId},
        'source-body-plan-' || value,
        1,
        'source/body-plan/' || value,
        'text/markdown; charset=utf-8',
        32,
        md5(value::text) || md5((value + 1)::text),
        'completed'
      FROM generate_series(0, ${fileCount - 1}) value
      ON CONFLICT (id) DO NOTHING
    `;
    await sql`
      INSERT INTO focowiki.search_projection_documents (
        id, knowledge_base_id, source_file_id, source_revision_id,
        source_body_checksum_sha256, search_schema_version,
        tokenizer_contract_version, segmentation_version,
        segment_count, lifecycle_state, completed_at
      )
      SELECT
        'search-body-plan-' || value,
        ${knowledgeBaseId},
        'source-body-plan-' || value,
        'revision-body-plan-' || value,
        md5(value::text) || md5((value + 1)::text),
        'body-search-v1',
        'lexical-tokenizer-plan-v1',
        'body-segmentation-v1',
        1,
        'ready',
        now()
      FROM generate_series(0, ${fileCount - 1}) value
      ON CONFLICT (id) DO NOTHING
    `;
    await sql`
      INSERT INTO focowiki.search_projection_segments (
        document_id, knowledge_base_id, ordinal, heading,
        normalized_text, tokens, token_text, character_count, byte_count
      )
      SELECT
        'search-body-plan-' || value,
        ${knowledgeBaseId},
        0,
        'Scale file ' || value,
        'common body needle' || value,
        ARRAY['common', 'needle' || value],
        'common needle' || value,
        char_length('common body needle' || value),
        octet_length('common body needle' || value)
      FROM generate_series(0, ${fileCount - 1}) value
      ON CONFLICT (document_id, ordinal) DO NOTHING
    `;
    await sql`
      INSERT INTO focowiki.generation_search_projection_refs (
        knowledge_base_id, generation_id, source_file_id, source_revision_id,
        search_document_id, search_schema_version, tokenizer_contract_version,
        segmentation_version, logical_path, path_revision, title, metadata_json
      )
      SELECT
        ${knowledgeBaseId},
        ${generationId},
        'source-body-plan-' || value,
        'revision-body-plan-' || value,
        'search-body-plan-' || value,
        'body-search-v1',
        'lexical-tokenizer-plan-v1',
        'body-segmentation-v1',
        'pages/scale/file-' || value || '.md',
        1,
        'Scale file needle' || value,
        '{}'::jsonb
      FROM generate_series(0, ${fileCount - 1}) value
      ON CONFLICT (generation_id, source_file_id) DO NOTHING
    `;
    await sql`
      INSERT INTO focowiki.source_file_graph_term_documents (
        knowledge_base_id, source_file_id, source_revision_id,
        term_fingerprint, lexical_text, exact_terms, phrase_terms,
        explicit_references, tokenizer_contract_version,
        lexical_projection_version
      )
      SELECT
        ${knowledgeBaseId},
        'source-body-plan-' || value,
        'revision-body-plan-' || value,
        md5(value::text) || md5((value + 1)::text),
        'common graph needle' || value,
        ARRAY['common', 'needle' || value],
        ARRAY['graph needle' || value],
        ARRAY[]::text[],
        'lexical-tokenizer-plan-v1',
        'graph-lexical-v2'
      FROM generate_series(0, ${fileCount - 1}) value
      ON CONFLICT (knowledge_base_id, source_file_id) DO NOTHING
    `;
  }
});

async function writeBaselineReport(
  evidence: Array<Record<string, unknown>>
): Promise<void> {
  const directory = resolve(
    process.cwd(),
    "ReferenceDocs/validate-meilisearch-search"
  );
  await mkdir(directory, { recursive: true });
  await writeFile(
    resolve(directory, "postgres-compatibility-baseline.json"),
    `${JSON.stringify({
      generatedAt: new Date().toISOString(),
      evidence
    }, null, 2)}\n`,
    "utf8"
  );
}
