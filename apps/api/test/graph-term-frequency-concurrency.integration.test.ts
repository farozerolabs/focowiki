import postgres from "postgres";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

const databaseUrl = process.env.FOCOWIKI_TEST_DATABASE_URL;
const describeDatabase = databaseUrl ? describe : describe.skip;

describeDatabase("graph term frequency concurrency", () => {
  const sql = postgres(databaseUrl!, { max: 20 });
  const knowledgeBaseId = "kb-graph-term-frequency-concurrency";
  const fileCount = 32;

  beforeEach(async () => {
    await cleanup();
    await sql`
      INSERT INTO focowiki.knowledge_bases (id, name)
      VALUES (${knowledgeBaseId}, 'Graph term frequency concurrency')
    `;
    await sql`
      INSERT INTO focowiki.source_directories (
        id, knowledge_base_id, name, relative_path, path_key, depth
      ) VALUES (
        'source-directory-graph-term-frequency', ${knowledgeBaseId},
        'documents', 'documents', 'documents', 1
      )
    `;
    await sql.begin(async (transaction) => {
      await transaction`
        INSERT INTO focowiki.source_files (
          id, knowledge_base_id, name, relative_path, path_key, directory_id,
          object_key, content_type, size_bytes, checksum_sha256, active_revision_id
        )
        SELECT 'source-file-graph-term-frequency-' || value,
               ${knowledgeBaseId}, value || '.md',
               'documents/' || value || '.md', 'documents/' || value || '.md',
               'source-directory-graph-term-frequency',
               'sources/graph-term-frequency-' || value || '.md',
               'text/markdown', 1, value::text,
               'source-revision-graph-term-frequency-' || value
        FROM generate_series(1, ${fileCount}) AS value
      `;
      await transaction`
        INSERT INTO focowiki.source_revisions (
          id, knowledge_base_id, source_file_id, revision, object_key,
          content_type, size_bytes, checksum_sha256
        )
        SELECT 'source-revision-graph-term-frequency-' || value,
               ${knowledgeBaseId}, 'source-file-graph-term-frequency-' || value,
               1, 'sources/graph-term-frequency-' || value || '.md',
               'text/markdown', 1, value::text
        FROM generate_series(1, ${fileCount}) AS value
      `;
    });
  });

  afterAll(async () => {
    await cleanup();
    await sql.end({ timeout: 5 });
  });

  it("serializes shared term counters without deadlocks or lost updates", async () => {
    await Promise.all(Array.from({ length: fileCount }, (_, offset) => {
      const number = offset + 1;
      const exactTerms = number % 2 === 0
        ? ["shared-beta", "shared-alpha", `unique-${number}`]
        : ["shared-alpha", "shared-beta", `unique-${number}`];
      return sql`
        INSERT INTO focowiki.source_file_graph_term_documents (
          knowledge_base_id, source_file_id, source_revision_id,
          term_fingerprint, lexical_text, exact_terms
        ) VALUES (
          ${knowledgeBaseId}, ${`source-file-graph-term-frequency-${number}`},
          ${`source-revision-graph-term-frequency-${number}`},
          ${number.toString(16).padStart(32, "0")},
          ${`shared alpha beta unique ${number}`}, ${exactTerms}
        )
      `;
    }));

    expect(await frequency("shared-alpha")).toBe(fileCount);
    expect(await frequency("shared-beta")).toBe(fileCount);

    await Promise.all(Array.from({ length: fileCount }, (_, offset) => {
      const number = offset + 1;
      return sql`
        UPDATE focowiki.source_file_graph_term_documents
        SET exact_terms = ${["shared-alpha", "shared-gamma", `unique-${number}`]},
            updated_at = now()
        WHERE knowledge_base_id = ${knowledgeBaseId}
          AND source_file_id = ${`source-file-graph-term-frequency-${number}`}
      `;
    }));

    expect(await frequency("shared-alpha")).toBe(fileCount);
    expect(await frequency("shared-beta")).toBe(0);
    expect(await frequency("shared-gamma")).toBe(fileCount);

    await Promise.all(Array.from({ length: fileCount }, (_, offset) => sql`
      DELETE FROM focowiki.source_file_graph_term_documents
      WHERE knowledge_base_id = ${knowledgeBaseId}
        AND source_file_id = ${`source-file-graph-term-frequency-${offset + 1}`}
    `));

    const remaining = await sql<Array<{ count: number }>>`
      SELECT count(*)::int AS count
      FROM focowiki.source_file_graph_term_frequencies
      WHERE knowledge_base_id = ${knowledgeBaseId}
    `;
    expect(remaining[0]?.count).toBe(0);
  });

  it("bounds frequency counters without truncating indexed document terms", async () => {
    const exactTerms = Array.from(
      { length: 150 },
      (_, offset) => `term-${String(offset + 1).padStart(3, "0")}`
    );
    await sql`
      INSERT INTO focowiki.source_file_graph_term_documents (
        knowledge_base_id, source_file_id, source_revision_id,
        term_fingerprint, lexical_text, exact_terms
      ) VALUES (
        ${knowledgeBaseId}, 'source-file-graph-term-frequency-1',
        'source-revision-graph-term-frequency-1',
        ${"ab".repeat(16)}, 'bounded frequency terms', ${exactTerms}
      )
    `;

    const indexed = await sql<Array<{ exact_term_count: number; matched: boolean }>>`
      SELECT cardinality(exact_terms)::int AS exact_term_count,
             exact_terms && ARRAY['term-150']::text[] AS matched
      FROM focowiki.source_file_graph_term_documents
      WHERE knowledge_base_id = ${knowledgeBaseId}
        AND source_file_id = 'source-file-graph-term-frequency-1'
    `;
    const frequencies = await sql<Array<{ count: number }>>`
      SELECT count(*)::int AS count
      FROM focowiki.source_file_graph_term_frequencies
      WHERE knowledge_base_id = ${knowledgeBaseId}
    `;

    expect(indexed[0]).toEqual({ exact_term_count: 150, matched: true });
    expect(frequencies[0]?.count).toBe(100);
    expect(await frequency("term-100")).toBe(1);
    expect(await frequency("term-101")).toBe(0);
    expect(await frequency("term-150")).toBe(0);
  });

  async function frequency(term: string) {
    const rows = await sql<Array<{ document_count: number }>>`
      SELECT sum(document_count)::int AS document_count
      FROM focowiki.source_file_graph_term_frequencies
      WHERE knowledge_base_id = ${knowledgeBaseId}
        AND term = ${term}
      GROUP BY term
    `;
    return rows[0]?.document_count ?? 0;
  }

  async function cleanup() {
    await sql`DELETE FROM focowiki.knowledge_bases WHERE id = ${knowledgeBaseId}`;
  }
});
