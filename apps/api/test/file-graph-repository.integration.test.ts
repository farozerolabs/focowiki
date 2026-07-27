import postgres from "postgres";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createPostgresFileGraphRepository } from "../src/db/file-graph-repository.js";

const databaseUrl = process.env.FOCOWIKI_TEST_DATABASE_URL;
const describeDatabase = databaseUrl ? describe : describe.skip;

describeDatabase("file graph repository integration", () => {
  const sql = postgres(databaseUrl!, { max: 2 });
  const tokenizer = {
    contractVersion: "file-graph-test-tokenizer-v1",
    tokenizeDocument(value: string, limit: number) {
      return value.toLowerCase().match(/[\p{L}\p{N}]+/gu)?.slice(0, limit) ?? [];
    },
    tokenizeQuery(value: string, limit: number) {
      return value.toLowerCase().match(/[\p{L}\p{N}]+/gu)?.slice(0, limit) ?? [];
    }
  };
  const repository = createPostgresFileGraphRepository(sql, tokenizer);
  const knowledgeBaseId = "kb-file-graph-repository";
  const sourceFileId = "source-file-graph-repository";
  const revisionId = "source-revision-graph-repository";
  const targetFileId = "source-file-graph-target";
  const targetRevisionId = "source-revision-graph-target";

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
        ) VALUES
          (
            ${sourceFileId}, ${knowledgeBaseId}, 'test/source.md',
            'text/markdown; charset=utf-8', 32, ${"ab".repeat(32)},
            'running', 'graph_generation', 'pending', 'source.md',
            'source.md', 'source.md', ${revisionId}
          ),
          (
            ${targetFileId}, ${knowledgeBaseId}, 'test/target.md',
            'text/markdown; charset=utf-8', 32, ${"cd".repeat(32)},
            'completed', 'generation_activation', 'visible', 'target.md',
            'target.md', 'target.md', ${targetRevisionId}
          )
      `;
      await transaction`
        INSERT INTO focowiki.source_revisions (
          id, knowledge_base_id, source_file_id, revision, object_key,
          content_type, size_bytes, checksum_sha256, processing_status
        ) VALUES
          (
            ${revisionId}, ${knowledgeBaseId}, ${sourceFileId}, 1,
            'test/source.md', 'text/markdown; charset=utf-8', 32,
            ${"ab".repeat(32)}, 'running'
          ),
          (
            ${targetRevisionId}, ${knowledgeBaseId}, ${targetFileId}, 1,
            'test/target.md', 'text/markdown; charset=utf-8', 32,
            ${"cd".repeat(32)}, 'completed'
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

  it("does not publish a graph edge to a source concurrently marked for deletion", async () => {
    let releaseDeletion!: () => void;
    const deletionRelease = new Promise<void>((resolve) => {
      releaseDeletion = resolve;
    });
    let deletionStarted!: () => void;
    const deletionReady = new Promise<void>((resolve) => {
      deletionStarted = resolve;
    });
    const deletion = Promise.resolve(sql.begin(async (transaction) => {
      await transaction`
        SELECT id
        FROM focowiki.source_files
        WHERE id = ${targetFileId}
        FOR UPDATE
      `;
      await transaction`
        UPDATE focowiki.source_files
        SET deleted_at = now()
        WHERE id = ${targetFileId}
      `;
      deletionStarted();
      await deletionRelease;
    }));
    await deletionReady;

    const mutation = repository.applyGraphMutationSet({
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
      acceptedEdges: [{
        fromFileId: sourceFileId,
        toFileId: targetFileId,
        relationType: "same_specific_subject",
        weight: 0.8,
        reason: "Concurrent deletion regression.",
        source: "deterministic",
        evidence: {}
      }],
      rejectedEdges: [],
      limit: 100
    });

    try {
      const settledBeforeDeletion = await Promise.race([
        mutation.then(() => true),
        new Promise<false>((resolve) => setTimeout(() => resolve(false), 100))
      ]);
      expect(settledBeforeDeletion).toBe(false);
    } finally {
      releaseDeletion();
    }
    await deletion;
    await expect(mutation).resolves.toMatchObject({
      edgeCount: 0,
      edgeIds: []
    });
    await expect(sql<Array<{ count: number }>>`
      SELECT count(*)::int AS count
      FROM focowiki.source_file_graph_edges
      WHERE knowledge_base_id = ${knowledgeBaseId}
        AND to_source_file_id = ${targetFileId}
    `).resolves.toEqual([{ count: 0 }]);
  });

  async function cleanup() {
    await sql`DELETE FROM focowiki.knowledge_bases WHERE id = ${knowledgeBaseId}`;
  }
});
