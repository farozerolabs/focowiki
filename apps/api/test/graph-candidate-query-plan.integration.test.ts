import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  buildExplainAnalyzeSql,
  createGraphCandidatePlanTarget,
  summarizeQueryPlan
} from "../src/db/query-plan-validation.js";

const databaseUrl = process.env.FOCOWIKI_TEST_DATABASE_URL;
const describeDatabase = databaseUrl
  && process.env.FOCOWIKI_RUN_SCALE_QUERY_PLAN_TESTS === "true"
  ? describe
  : describe.skip;

describeDatabase("graph candidate query plan integration", () => {
  const pool = postgres(databaseUrl!, { max: 1 });
  let sql: Awaited<ReturnType<typeof pool.reserve>>;
  const knowledgeBaseId = "kb-graph-plan-scale";

  beforeAll(async () => {
    sql = await pool.reserve();
    await sql`BEGIN`;
    await sql`SET CONSTRAINTS ALL DEFERRED`;
    await sql`
      INSERT INTO focowiki.knowledge_bases (id, name)
      VALUES (${knowledgeBaseId}, 'Graph plan scale')
    `;
  });

  afterAll(async () => {
    try {
      await sql`ROLLBACK`;
    } finally {
      sql.release();
      await pool.end({ timeout: 5 });
    }
  });

  it.each([10_000, 100_000])(
    "avoids a graph corpus scan with %i body-term documents",
    async (nodeCount) => {
      await seedTo(nodeCount);
      await sql`ANALYZE focowiki.source_file_graph_term_documents`;
      const frequencies = await sql<Array<{ term: string; document_count: number }>>`
        SELECT term, sum(document_count)::int AS document_count
        FROM focowiki.source_file_graph_term_frequencies
        WHERE knowledge_base_id = ${knowledgeBaseId}
          AND term IN ('common', ${`unique-scale-term-${nodeCount - 1}`})
        GROUP BY term
        ORDER BY term
      `;
      expect(frequencies).toEqual([
        { term: "common", document_count: nodeCount },
        { term: `unique-scale-term-${nodeCount - 1}`, document_count: 1 }
      ]);
      const target = createGraphCandidatePlanTarget({
        knowledgeBaseId,
        sourceFileId: "source-scale-0",
        terms: [`unique-scale-term-${nodeCount - 1}`],
        limit: 50
      });
      await sql`SET LOCAL enable_seqscan = off`;
      const rows = await sql.unsafe<Array<{ "QUERY PLAN": unknown }>>(
        buildExplainAnalyzeSql(target.sql)
      );
      await sql`SET LOCAL enable_seqscan = on`;
      const summary = summarizeQueryPlan(rows[0]?.["QUERY PLAN"]);
      expect(summary.sequentialScanRelations).not.toContain(
        "source_file_graph_term_documents"
      );
      expect(summary.indexNames.some((name) =>
        name.startsWith("source_file_graph_term_documents_")
      )).toBe(true);
      expect(summary.executionTimeMs ?? Number.POSITIVE_INFINITY).toBeLessThan(50);
    },
    120_000
  );

  it("filters corpus-wide terms before candidate retrieval", async () => {
    const target = createGraphCandidatePlanTarget({
      knowledgeBaseId,
      sourceFileId: "source-scale-0",
      terms: ["common"],
      limit: 50
    });
    const rows = await sql.unsafe<Array<{ source_file_id: string }>>(target.sql);
    expect(rows).toEqual([]);
  });

  it("updates document frequencies when one indexed document changes or is deleted", async () => {
    await sql`
      UPDATE focowiki.source_file_graph_term_documents
      SET exact_terms = ARRAY['replacement-term']::text[]
      WHERE knowledge_base_id = ${knowledgeBaseId}
        AND source_file_id = 'source-scale-99999'
    `;
    const afterUpdate = await frequencyCounts(["common", "replacement-term"]);
    expect(afterUpdate).toEqual([
      { term: "common", document_count: 99_999 },
      { term: "replacement-term", document_count: 1 }
    ]);

    await sql`
      DELETE FROM focowiki.source_file_graph_term_documents
      WHERE knowledge_base_id = ${knowledgeBaseId}
        AND source_file_id = 'source-scale-99999'
    `;
    expect(await frequencyCounts(["replacement-term"])).toEqual([]);
  });

  async function seedTo(nodeCount: number): Promise<void> {
    await sql`
      INSERT INTO focowiki.source_files (
        id, knowledge_base_id, object_key, content_type, size_bytes,
        checksum_sha256, name, relative_path, path_key, active_revision_id,
        processing_status, processing_stage, generated_output_status
      )
      SELECT
        'source-scale-' || value,
        ${knowledgeBaseId},
        'source/scale/' || value,
        'text/markdown; charset=utf-8',
        1,
        md5(value::text) || md5((value + 1)::text),
        'file-' || value || '.md',
        'scale/file-' || value || '.md',
        'scale/file-' || value || '.md',
        'revision-scale-shared',
        'completed',
        'generation_activation',
        'visible'
      FROM generate_series(0, ${nodeCount - 1}) value
      ON CONFLICT (id) DO NOTHING
    `;
    await sql`
      INSERT INTO focowiki.source_revisions (
        id, knowledge_base_id, source_file_id, revision, object_key,
        content_type, size_bytes, checksum_sha256, processing_status
      )
      VALUES (
        'revision-scale-shared',
        ${knowledgeBaseId},
        'source-scale-0',
        1,
        'source/scale/shared-revision',
        'text/markdown; charset=utf-8',
        1,
        md5('shared-revision') || md5('shared-revision-checksum'),
        'completed'
      )
      ON CONFLICT (id) DO NOTHING
    `;
    await sql`
      INSERT INTO focowiki.source_file_graph_term_documents (
        knowledge_base_id, source_file_id, source_revision_id,
        term_fingerprint, lexical_text, exact_terms, phrase_terms,
        explicit_references
      )
      SELECT
        ${knowledgeBaseId},
        'source-scale-' || value,
        'revision-scale-shared',
        md5(value::text),
        'common scale body unique-scale-term-' || value,
        ARRAY['common', 'scale', 'unique-scale-term-' || value],
        ARRAY['scale body'],
        ARRAY[]::text[]
      FROM generate_series(0, ${nodeCount - 1}) value
      ON CONFLICT (knowledge_base_id, source_file_id) DO NOTHING
    `;
  }

  async function frequencyCounts(terms: string[]) {
    return sql<Array<{ term: string; document_count: number }>>`
      SELECT term, sum(document_count)::int AS document_count
      FROM focowiki.source_file_graph_term_frequencies
      WHERE knowledge_base_id = ${knowledgeBaseId} AND term = ANY(${terms})
      GROUP BY term
      ORDER BY term
    `;
  }
});
