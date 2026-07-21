import postgres from "postgres";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createPostgresFileGraphRepository } from "../src/db/file-graph-repository.js";

const databaseUrl = process.env.FOCOWIKI_TEST_DATABASE_URL;
const describeDatabase = databaseUrl ? describe : describe.skip;

describeDatabase("file graph repository integration", () => {
  const sql = postgres(databaseUrl!, { max: 2 });
  const repository = createPostgresFileGraphRepository(sql);
  const knowledgeBaseId = "kb-file-graph-repository";
  const sourceFileId = "source-file-graph-repository";
  const revisionId = "source-revision-graph-repository";

  beforeEach(async () => {
    await cleanup();
    await sql.begin(async (transaction) => {
      await transaction`SET CONSTRAINTS ALL DEFERRED`;
      await transaction`
        INSERT INTO focowiki.knowledge_bases (id, name)
        VALUES (${knowledgeBaseId}, 'File graph repository')
      `;
      await transaction`
        INSERT INTO focowiki.source_files (
          id, knowledge_base_id, object_key, content_type, size_bytes,
          checksum_sha256, processing_status, processing_stage,
          generated_output_status, name, relative_path, path_key,
          active_revision_id
        ) VALUES (
          ${sourceFileId}, ${knowledgeBaseId}, 'test/source.md',
          'text/markdown; charset=utf-8', 32, ${"ab".repeat(32)},
          'running', 'graph_generation', 'pending', 'source.md',
          'source.md', 'source.md', ${revisionId}
        )
      `;
      await transaction`
        INSERT INTO focowiki.source_revisions (
          id, knowledge_base_id, source_file_id, revision, object_key,
          content_type, size_bytes, checksum_sha256, processing_status
        ) VALUES (
          ${revisionId}, ${knowledgeBaseId}, ${sourceFileId}, 1,
          'test/source.md', 'text/markdown; charset=utf-8', 32,
          ${"ab".repeat(32)}, 'running'
        )
      `;
    });
  });

  afterAll(async () => {
    await cleanup();
    await sql.end({ timeout: 5 });
  });

  it("applies an empty graph mutation set for a source with no matching referrers", async () => {
    await repository.upsertGraphNode({
      knowledgeBaseId,
      node: {
        fileId: sourceFileId,
        path: "pages/source.md",
        title: "Source",
        tags: [],
        subjects: [],
        entities: [],
        explicitReferences: [],
        relationshipHints: [],
        headings: ["Source"],
        keywords: [],
        metadata: {}
      }
    });

    await expect(repository.applyGraphMutationSet({
      knowledgeBaseId,
      sourceFileId,
      target: {
        fileId: sourceFileId,
        path: "pages/source.md",
        title: "Source",
        tags: [],
        subjects: [],
        entities: [],
        explicitReferences: [],
        relationshipHints: [],
        headings: ["Source"],
        keywords: [],
        metadata: {}
      },
      acceptedEdges: [],
      rejectedEdges: [],
      limit: 100
    })).resolves.toEqual({
      edgeCount: 0,
      affectedSourceFileIds: [sourceFileId],
      edgeIds: [],
      removedEdgeIds: []
    });
  });

  async function cleanup() {
    await sql`DELETE FROM focowiki.knowledge_bases WHERE id = ${knowledgeBaseId}`;
  }
});
