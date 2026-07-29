import { createHash } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createPostgresSearchProjectionRepository } from "../src/infrastructure/postgres/search-projection-repository.js";
import { createPostgresSearchProjectionDocumentRepository } from "../src/infrastructure/postgres/search-projection-document-repository.js";
import { updateGenerationSearchReferences } from "../src/infrastructure/postgres/generation-search-reference-writer.js";
import { searchBodyProjection } from "../src/infrastructure/postgres/body-search-query.js";
import { createPostgresActiveGenerationReadRepository } from "../src/infrastructure/postgres/active-generation-read-repository.js";
import { createNodeJiebaTokenizer } from "../src/infrastructure/tokenization/nodejieba-tokenizer.js";
import { GRAPH_LEXICAL_PROJECTION_VERSION } from "../src/graph/graph-term-document.js";
import { buildBodySearchDocument } from "../src/search/body-search-document.js";

const databaseUrl = process.env.FOCOWIKI_TEST_DATABASE_URL;
const describeDatabase = databaseUrl ? describe : describe.skip;

describeDatabase("search projection repository integration", () => {
  const sql = postgres(databaseUrl!, { max: 3 });
  const repository = createPostgresSearchProjectionRepository(sql);
  const documentRepository = createPostgresSearchProjectionDocumentRepository(sql);
  const knowledgeBaseId = "kb-search-projection-repository";
  const sourceFileId = "source-file-search-projection-repository";
  const sourceRevisionId = "source-revision-search-projection-repository";
  const generationId = "generation-search-projection-repository";
  const body = "# Cache consistency\n\nLease recovery validates the version token.";
  const checksum = createHash("sha256").update(body).digest("hex");
  const tokenizer = createNodeJiebaTokenizer();

  beforeEach(async () => {
    await cleanup();
    await seedSource();
  });

  afterAll(async () => {
    await cleanup();
    await sql.end({ timeout: 5 });
  });

  it("persists one immutable document and reuses it on a duplicate retry", async () => {
    const document = testDocument();

    await expect(repository.persistDocument({
      document,
      completedAt: "2026-07-24T01:00:00.000Z"
    })).resolves.toMatchObject({
      status: "created",
      document: {
        documentId: document.documentId,
        lifecycleState: "ready",
        segmentCount: document.segments.length
      }
    });
    await expect(repository.persistDocument({
      document,
      completedAt: "2026-07-24T01:01:00.000Z"
    })).resolves.toMatchObject({ status: "reused" });

    const counts = await sql<Array<{ documents: number; segments: number }>>`
      SELECT
        (SELECT count(*)::int FROM focowiki.search_projection_documents
         WHERE knowledge_base_id = ${knowledgeBaseId}) AS documents,
        (SELECT count(*)::int FROM focowiki.search_projection_segments
         WHERE knowledge_base_id = ${knowledgeBaseId}) AS segments
    `;
    expect(counts[0]).toEqual({
      documents: 1,
      segments: document.segments.length
    });
  });

  it("persists large search documents across bounded segment batches", async () => {
    const largeBody = Array.from(
      { length: 260 },
      (_, index) => `segment-${index} ${"x".repeat(2_020)}`
    ).join("\n\n");
    const largeChecksum = createHash("sha256").update(largeBody).digest("hex");
    const document = buildBodySearchDocument({
      knowledgeBaseId,
      sourceFileId,
      sourceRevisionId,
      sourceBodyChecksumSha256: largeChecksum,
      title: "Large search projection",
      logicalPath: "pages/guides/cache.md",
      summary: null,
      body: largeBody,
      tokenizer
    });

    expect(document.segments.length).toBe(260);
    await expect(repository.persistDocument({
      document,
      completedAt: "2026-07-24T01:00:00.000Z"
    })).resolves.toMatchObject({
      status: "created",
      document: {
        documentId: document.documentId,
        segmentCount: 260
      }
    });
    const rows = await sql<Array<{ segment_count: number; max_ordinal: number }>>`
      SELECT count(*)::int AS segment_count, max(ordinal)::int AS max_ordinal
      FROM focowiki.search_projection_segments
      WHERE knowledge_base_id = ${knowledgeBaseId}
        AND document_id = ${document.documentId}
    `;
    expect(rows[0]).toEqual({ segment_count: 260, max_ordinal: 259 });
  });

  it("updates path-dependent generation evidence without rewriting the immutable document", async () => {
    const document = testDocument();
    await repository.persistDocument({
      document,
      completedAt: "2026-07-24T01:00:00.000Z"
    });

    await repository.attachGenerationReference({
      knowledgeBaseId,
      generationId,
      sourceFileId,
      sourceRevisionId,
      searchDocumentId: document.documentId,
      searchSchemaVersion: document.searchSchemaVersion,
      tokenizerContractVersion: document.tokenizerContractVersion,
      segmentationVersion: document.segmentationVersion,
      logicalPath: "pages/guides/cache.md",
      title: "Cache consistency",
      summary: "Lease recovery",
      sourceUrl: "https://example.com/cache",
      metadata: { status: "active" }
    });
    await repository.attachGenerationReference({
      knowledgeBaseId,
      generationId,
      sourceFileId,
      sourceRevisionId,
      searchDocumentId: document.documentId,
      searchSchemaVersion: document.searchSchemaVersion,
      tokenizerContractVersion: document.tokenizerContractVersion,
      segmentationVersion: document.segmentationVersion,
      logicalPath: "pages/reference/cache.md",
      title: "Cache consistency",
      summary: "Lease recovery",
      sourceUrl: "https://example.com/cache",
      metadata: { status: "active" }
    });

    const rows = await sql<Array<{
      logical_path: string;
      reference_count: number;
      document_count: number;
    }>>`
      SELECT reference.logical_path,
             count(*) OVER ()::int AS reference_count,
             (SELECT count(*)::int FROM focowiki.search_projection_documents
              WHERE knowledge_base_id = ${knowledgeBaseId}) AS document_count
      FROM focowiki.generation_search_projection_refs reference
      WHERE reference.generation_id = ${generationId}
        AND reference.source_file_id = ${sourceFileId}
    `;
    expect(rows).toEqual([{
      logical_path: "pages/reference/cache.md",
      reference_count: 1,
      document_count: 1
    }]);
  });

  it("replays planned records after the mutable source revision advances", async () => {
    const document = testDocument();
    await repository.persistDocument({
      document,
      completedAt: "2026-07-24T01:00:00.000Z"
    });
    await repository.attachGenerationReference({
      knowledgeBaseId,
      generationId,
      sourceFileId,
      sourceRevisionId,
      searchDocumentId: document.documentId,
      searchSchemaVersion: document.searchSchemaVersion,
      tokenizerContractVersion: document.tokenizerContractVersion,
      segmentationVersion: document.segmentationVersion,
      logicalPath: document.logicalPath,
      title: document.title,
      summary: document.summary,
      sourceUrl: null,
      metadata: {}
    });
    const scope = {
      knowledgeBaseId,
      generationId,
      activeGenerationId: generationId,
      activeEpoch: 0,
      pendingEpoch: 1,
      indexKind: "content" as const
    };
    const planned = await documentRepository.listRecords({
      ...scope,
      cursor: null,
      limit: 10
    });
    expect(planned.records.length).toBeGreaterThan(0);

    await sql`
      UPDATE focowiki.source_files
      SET resource_revision = resource_revision + 1
      WHERE knowledge_base_id = ${knowledgeBaseId}
        AND id = ${sourceFileId}
    `;

    await expect(documentRepository.loadRecords({
      ...scope,
      recordKeys: planned.records.map((record) => record.key)
    })).resolves.toEqual(planned.records);
  });

  it("cleans only documents that have no generation reference", async () => {
    const document = testDocument();
    await repository.persistDocument({
      document,
      completedAt: "2026-07-24T01:00:00.000Z"
    });
    await repository.attachGenerationReference({
      knowledgeBaseId,
      generationId,
      sourceFileId,
      sourceRevisionId,
      searchDocumentId: document.documentId,
      searchSchemaVersion: document.searchSchemaVersion,
      tokenizerContractVersion: document.tokenizerContractVersion,
      segmentationVersion: document.segmentationVersion,
      logicalPath: document.logicalPath,
      title: document.title,
      summary: document.summary,
      sourceUrl: null,
      metadata: {}
    });
    await sql`
      UPDATE focowiki.search_projection_documents
      SET updated_at = '2026-07-23T00:00:00.000Z'
      WHERE id = ${document.documentId}
    `;

    await expect(repository.cleanupUnreferencedDocuments({
      olderThan: "2026-07-24T00:00:00.000Z",
      limit: 10
    })).resolves.toBe(0);
    await expect(repository.deleteGenerationReferences({
      knowledgeBaseId,
      generationId,
      sourceFileIds: [sourceFileId]
    })).resolves.toBe(1);
    await expect(repository.cleanupUnreferencedDocuments({
      olderThan: "2026-07-24T00:00:00.000Z",
      limit: 10
    })).resolves.toBe(1);
    await expect(repository.findReadyDocument({
      knowledgeBaseId,
      sourceFileId,
      sourceBodyChecksumSha256: checksum,
      searchSchemaVersion: document.searchSchemaVersion,
      tokenizerContractVersion: document.tokenizerContractVersion,
      segmentationVersion: document.segmentationVersion
    })).resolves.toBeNull();
  });

  it("retains documents until every generation reference is removed", async () => {
    const document = testDocument();
    const secondGenerationId = "generation-search-projection-shared-reference";
    await repository.persistDocument({
      document,
      completedAt: "2026-07-24T01:00:00.000Z"
    });
    await sql`
      INSERT INTO focowiki.publication_generations (
        id, knowledge_base_id, predecessor_generation_id,
        state, format_version, generation_kind
      ) VALUES (
        ${secondGenerationId}, ${knowledgeBaseId}, ${generationId},
        'building', 2, 'normal'
      )
    `;
    for (const referenceGenerationId of [generationId, secondGenerationId]) {
      await repository.attachGenerationReference({
        knowledgeBaseId,
        generationId: referenceGenerationId,
        sourceFileId,
        sourceRevisionId,
        searchDocumentId: document.documentId,
        searchSchemaVersion: document.searchSchemaVersion,
        tokenizerContractVersion: document.tokenizerContractVersion,
        segmentationVersion: document.segmentationVersion,
        logicalPath: document.logicalPath,
        title: document.title,
        summary: document.summary,
        sourceUrl: null,
        metadata: {}
      });
    }
    await sql`
      UPDATE focowiki.search_projection_documents
      SET updated_at = '2026-07-23T00:00:00.000Z'
      WHERE id = ${document.documentId}
    `;

    await expect(repository.deleteGenerationReferences({
      knowledgeBaseId,
      generationId,
      sourceFileIds: [sourceFileId]
    })).resolves.toBe(1);
    await expect(repository.cleanupUnreferencedDocuments({
      olderThan: "2026-07-24T00:00:00.000Z",
      limit: 10
    })).resolves.toBe(0);

    await expect(repository.deleteGenerationReferences({
      knowledgeBaseId,
      generationId: secondGenerationId,
      sourceFileIds: [sourceFileId]
    })).resolves.toBe(1);
    await expect(repository.cleanupUnreferencedDocuments({
      olderThan: "2026-07-24T00:00:00.000Z",
      limit: 10
    })).resolves.toBe(1);
  });

  it("retains recent unreferenced documents until the cleanup boundary passes", async () => {
    const document = testDocument();
    await repository.persistDocument({
      document,
      completedAt: "2026-07-24T01:00:00.000Z"
    });

    await expect(repository.cleanupUnreferencedDocuments({
      olderThan: "2026-07-24T00:00:00.000Z",
      limit: 10
    })).resolves.toBe(0);
    await expect(repository.findReadyDocument({
      knowledgeBaseId,
      sourceFileId,
      sourceBodyChecksumSha256: checksum,
      searchSchemaVersion: document.searchSchemaVersion,
      tokenizerContractVersion: document.tokenizerContractVersion,
      segmentationVersion: document.segmentationVersion
    })).resolves.toMatchObject({
      documentId: document.documentId,
      lifecycleState: "ready"
    });
  });

  it("inherits, updates, and removes generation search references without rewriting documents", async () => {
    const document = testDocument();
    const targetGenerationId = "generation-search-projection-target";
    await repository.persistDocument({
      document,
      completedAt: "2026-07-24T01:00:00.000Z"
    });
    await repository.attachGenerationReference({
      knowledgeBaseId,
      generationId,
      sourceFileId,
      sourceRevisionId,
      searchDocumentId: document.documentId,
      searchSchemaVersion: document.searchSchemaVersion,
      tokenizerContractVersion: document.tokenizerContractVersion,
      segmentationVersion: document.segmentationVersion,
      logicalPath: document.logicalPath,
      title: document.title,
      summary: document.summary,
      sourceUrl: null,
      metadata: {}
    });
    await sql`
      UPDATE focowiki.publication_generations
      SET state = 'superseded'
      WHERE id = ${generationId}
    `;
    await sql`
      INSERT INTO focowiki.publication_generations (
        id, knowledge_base_id, predecessor_generation_id,
        state, format_version, generation_kind
      ) VALUES (
        ${targetGenerationId}, ${knowledgeBaseId}, ${generationId},
        'open', 2, 'normal'
      )
    `;

    await sql.begin((transaction) => updateGenerationSearchReferences(transaction, {
      knowledgeBaseId,
      generationId: targetGenerationId,
      predecessorGenerationId: generationId,
      inheritPredecessor: true,
      changes: [{
        kind: "source_moved",
        sourceFileId,
        sourceRevisionId,
        searchDocumentId: null,
        path: "reference/cache.md"
      }],
      now: "2026-07-24T02:00:00.000Z"
    }));

    const moved = await sql<Array<{ logical_path: string }>>`
      SELECT logical_path
      FROM focowiki.generation_search_projection_refs
      WHERE generation_id = ${targetGenerationId}
    `;
    expect(moved).toEqual([{ logical_path: "pages/reference/cache.md" }]);

    await sql.begin((transaction) => updateGenerationSearchReferences(transaction, {
      knowledgeBaseId,
      generationId: targetGenerationId,
      predecessorGenerationId: generationId,
      inheritPredecessor: false,
      changes: [{
        kind: "source_deleted",
        sourceFileId,
        sourceRevisionId,
        searchDocumentId: null,
        path: null
      }],
      now: "2026-07-24T02:01:00.000Z"
    }));
    const remaining = await sql<Array<{ count: number }>>`
      SELECT count(*)::int AS count
      FROM focowiki.generation_search_projection_refs
      WHERE generation_id = ${targetGenerationId}
    `;
    expect(remaining[0]?.count).toBe(0);
  });

  it("reuses one body search document across identical-content source revisions", async () => {
    const original = testDocument();
    const replacementRevisionId = "source-revision-search-projection-replacement";
    const targetGenerationId = "generation-search-projection-replacement";
    await repository.persistDocument({
      document: original,
      completedAt: "2026-07-24T01:00:00.000Z"
    });
    await repository.attachGenerationReference({
      knowledgeBaseId,
      generationId,
      sourceFileId,
      sourceRevisionId,
      searchDocumentId: original.documentId,
      searchSchemaVersion: original.searchSchemaVersion,
      tokenizerContractVersion: original.tokenizerContractVersion,
      segmentationVersion: original.segmentationVersion,
      logicalPath: original.logicalPath,
      title: original.title,
      summary: original.summary,
      sourceUrl: null,
      metadata: {}
    });
    await sql`
      INSERT INTO focowiki.source_revisions (
        id, knowledge_base_id, source_file_id, revision, object_key,
        content_type, size_bytes, checksum_sha256, processing_status
      ) VALUES (
        ${replacementRevisionId}, ${knowledgeBaseId}, ${sourceFileId}, 2,
        'sources/cache-replacement.md', 'text/markdown; charset=utf-8',
        ${body.length}, ${checksum}, 'completed'
      )
    `;
    const replacement = buildBodySearchDocument({
      knowledgeBaseId,
      sourceFileId,
      sourceRevisionId: replacementRevisionId,
      sourceBodyChecksumSha256: checksum,
      title: "Cache consistency",
      logicalPath: "pages/guides/cache.md",
      summary: "Lease recovery",
      body,
      tokenizer
    });
    expect(replacement.documentId).toBe(original.documentId);
    await expect(repository.persistDocument({
      document: replacement,
      completedAt: "2026-07-24T02:00:00.000Z"
    })).resolves.toMatchObject({ status: "reused" });
    await sql`
      UPDATE focowiki.publication_generations
      SET state = 'active',
          search_schema_version = ${original.searchSchemaVersion},
          tokenizer_contract_version = ${original.tokenizerContractVersion},
          search_segmentation_version = ${original.segmentationVersion}
      WHERE id = ${generationId}
    `;
    await sql`
      UPDATE focowiki.knowledge_bases
      SET active_generation_id = ${generationId}
      WHERE id = ${knowledgeBaseId}
    `;
    await sql`
      INSERT INTO focowiki.publication_generations (
        id, knowledge_base_id, predecessor_generation_id,
        state, format_version, generation_kind
      ) VALUES (
        ${targetGenerationId}, ${knowledgeBaseId}, ${generationId},
        'open', 2, 'normal'
      )
    `;

    await sql.begin((transaction) => updateGenerationSearchReferences(transaction, {
      knowledgeBaseId,
      generationId: targetGenerationId,
      predecessorGenerationId: generationId,
      inheritPredecessor: true,
      changes: [{
        kind: "source_replaced",
        sourceFileId,
        sourceRevisionId: replacementRevisionId,
        searchDocumentId: replacement.documentId,
        path: "guides/cache.md"
      }],
      now: "2026-07-24T02:01:00.000Z"
    }));

    const references = await sql<Array<{
      source_revision_id: string;
      search_document_id: string;
    }>>`
      SELECT source_revision_id, search_document_id
      FROM focowiki.generation_search_projection_refs
      WHERE generation_id = ${targetGenerationId}
        AND source_file_id = ${sourceFileId}
    `;
    expect(references).toEqual([{
      source_revision_id: replacementRevisionId,
      search_document_id: original.documentId
    }]);
  });

  it("retrieves late body evidence through the bounded token projection", async () => {
    const document = testDocument();
    await repository.persistDocument({
      document,
      completedAt: "2026-07-24T01:00:00.000Z"
    });
    await repository.attachGenerationReference({
      knowledgeBaseId,
      generationId,
      sourceFileId,
      sourceRevisionId,
      searchDocumentId: document.documentId,
      searchSchemaVersion: document.searchSchemaVersion,
      tokenizerContractVersion: document.tokenizerContractVersion,
      segmentationVersion: document.segmentationVersion,
      logicalPath: document.logicalPath,
      title: document.title,
      summary: document.summary,
      sourceUrl: "https://example.com/cache",
      metadata: { status: "active" }
    });
    const objectChecksum = "ab".repeat(32);
    await sql`
      INSERT INTO focowiki.immutable_objects (
        checksum_sha256, format_version, object_key, content_type, size_bytes,
        verified_at
      ) VALUES (
        ${objectChecksum}, 1, 'generated/cache.md', 'text/markdown', 4, now()
      )
      ON CONFLICT (checksum_sha256, format_version) DO NOTHING
    `;
    await sql`
      INSERT INTO focowiki.active_object_refs (
        knowledge_base_id, ref_kind, ref_key, file_id,
        last_changed_generation_id, checksum_sha256, format_version,
        logical_path, source_file_id
      ) VALUES (
        ${knowledgeBaseId}, 'page', ${sourceFileId}, 'bundle-file-cache',
        ${generationId}, ${objectChecksum}, 1, ${document.logicalPath}, ${sourceFileId}
      )
    `;

    await expect(searchBodyProjection({
      sql,
      tokenizer,
      knowledgeBaseId,
      generationId,
      query: "lease recovery",
      limit: 10,
      cursor: null
    })).resolves.toMatchObject({
      items: [{
        sourceFileId,
        path: "pages/guides/cache.md",
        title: "Cache consistency",
        payload: {
          fileId: "bundle-file-cache",
          sourceUrl: "https://example.com/cache"
        }
      }],
      nextCursor: null
    });

    await sql`
      UPDATE focowiki.publication_generations
      SET state = 'active',
          search_schema_version = ${document.searchSchemaVersion},
          tokenizer_contract_version = ${document.tokenizerContractVersion},
          search_segmentation_version = ${document.segmentationVersion}
      WHERE id = ${generationId}
    `;
    await sql`
      UPDATE focowiki.knowledge_bases
      SET active_generation_id = ${generationId}
      WHERE id = ${knowledgeBaseId}
    `;
    const activeReads = createPostgresActiveGenerationReadRepository(sql, tokenizer);
    await expect(activeReads.withActiveGeneration(knowledgeBaseId, (scope) => scope.search({
      query: "lease recovery",
      mode: "file",
      limit: 10,
      cursor: null
    }))).resolves.toMatchObject({
      items: [{
        sourceFileId,
        path: "pages/guides/cache.md"
      }]
    });
  });

  it("ranks exact titles before body matches and keeps Chinese queries paginated and deletion-aware", async () => {
    await seedSearchableSource({
      sourceFileId: "source-file-search-chinese-title",
      sourceRevisionId: "source-revision-search-chinese-title",
      relativePath: "guides/cache-consistency.md",
      title: "缓存一致性指南",
      summary: "版本校验说明",
      body: "# 缓存一致性指南\n\n租约恢复需要校验当前版本。",
      sourceUrl: "https://example.com/cache-consistency"
    });
    await seedSearchableSource({
      sourceFileId: "source-file-search-chinese-body",
      sourceRevisionId: "source-revision-search-chinese-body",
      relativePath: "guides/lease-recovery.md",
      title: "租约恢复说明",
      summary: "恢复流程",
      body: "# 租约恢复说明\n\n缓存一致性指南是恢复流程的参考材料。",
      sourceUrl: "https://example.com/lease-recovery"
    });
    await seedSearchableSource({
      sourceFileId: "source-file-search-chinese-weak-overlap",
      sourceRevisionId: "source-revision-search-chinese-weak-overlap",
      relativePath: "guides/unrelated-consensus.md",
      title: "协商流程",
      summary: "确认参与方意见",
      body: "# 协商流程\n\n参与方表达一致意见后记录会议结论。",
      sourceUrl: "https://example.com/unrelated-consensus"
    });

    const firstPage = await searchBodyProjection({
      sql,
      tokenizer,
      knowledgeBaseId,
      generationId,
      query: "缓存一致性指南",
      limit: 1,
      cursor: null
    });
    expect(firstPage.items).toMatchObject([{
      sourceFileId: "source-file-search-chinese-title",
      title: "缓存一致性指南"
    }]);
    expect(firstPage.nextCursor).not.toBeNull();

    const secondPage = await searchBodyProjection({
      sql,
      tokenizer,
      knowledgeBaseId,
      generationId,
      query: "缓存一致性指南",
      limit: 1,
      cursor: firstPage.nextCursor
    });
    expect(secondPage.items).toMatchObject([{
      sourceFileId: "source-file-search-chinese-body"
    }]);

    const boundedOverlap = await searchBodyProjection({
      sql,
      tokenizer,
      knowledgeBaseId,
      generationId,
      query: "缓存一致性",
      limit: 10,
      cursor: null
    });
    expect(boundedOverlap.items.map((item) => item.sourceFileId)).toEqual([
      "source-file-search-chinese-title",
      "source-file-search-chinese-body"
    ]);

    await expect(searchBodyProjection({
      sql,
      tokenizer,
      knowledgeBaseId,
      generationId,
      query: "缓存 恢复",
      limit: 10,
      cursor: null
    })).resolves.toMatchObject({
      items: expect.arrayContaining([
        expect.objectContaining({ sourceFileId: "source-file-search-chinese-title" }),
        expect.objectContaining({ sourceFileId: "source-file-search-chinese-body" })
      ])
    });

    await sql`
      UPDATE focowiki.source_files
      SET task_deleted_at = now()
      WHERE knowledge_base_id = ${knowledgeBaseId}
        AND id = 'source-file-search-chinese-title'
    `;
    const afterTaskDelete = await searchBodyProjection({
      sql,
      tokenizer,
      knowledgeBaseId,
      generationId,
      query: "缓存一致性指南",
      limit: 10,
      cursor: null
    });
    expect(afterTaskDelete.items.map((item) => item.sourceFileId)).toContain(
      "source-file-search-chinese-title"
    );

    await sql`
      UPDATE focowiki.source_files
      SET deleted_at = now()
      WHERE knowledge_base_id = ${knowledgeBaseId}
        AND id = 'source-file-search-chinese-title'
    `;
    const afterDelete = await searchBodyProjection({
      sql,
      tokenizer,
      knowledgeBaseId,
      generationId,
      query: "缓存一致性指南",
      limit: 10,
      cursor: null
    });
    expect(afterDelete.items.map((item) => item.sourceFileId)).not.toContain(
      "source-file-search-chinese-title"
    );
  });

  it("searches target-version graph terms without depending on legacy graph searchable text", async () => {
    const graphSourceFileId = "source-file-search-versioned-graph";
    const graphSourceRevisionId = "source-revision-search-versioned-graph";
    const weakGraphSourceFileId = "source-file-search-versioned-graph-weak";
    const weakGraphSourceRevisionId = "source-revision-search-versioned-graph-weak";
    await seedSearchableSource({
      sourceFileId: graphSourceFileId,
      sourceRevisionId: graphSourceRevisionId,
      relativePath: "guides/distributed-locking.md",
      title: "分布式锁指南",
      summary: "租约与一致性",
      body: "# 分布式锁指南\n\n正文后段说明租约续期冲突恢复。",
      sourceUrl: "https://example.com/distributed-locking"
    });
    await seedSearchableSource({
      sourceFileId: weakGraphSourceFileId,
      sourceRevisionId: weakGraphSourceRevisionId,
      relativePath: "guides/unrelated-conflict.md",
      title: "协作冲突说明",
      summary: "会议意见处理",
      body: "# 协作冲突说明\n\n会议冲突通过协商流程处理。",
      sourceUrl: "https://example.com/unrelated-conflict"
    });
    await sql`
      INSERT INTO focowiki.source_file_graph_term_documents (
        knowledge_base_id, source_file_id, source_revision_id,
        term_fingerprint, lexical_text, exact_terms, phrase_terms,
        explicit_references, tokenizer_contract_version,
        lexical_projection_version
      ) VALUES (
        ${knowledgeBaseId}, ${graphSourceFileId}, ${graphSourceRevisionId},
        ${"cd".repeat(32)}, '分布式 锁 指南 租约 续期 冲突 恢复',
        ${tokenizer.tokenizeDocument("分布式锁指南 租约续期冲突恢复", 100)},
        ARRAY['租约续期冲突恢复']::text[], ARRAY[]::text[],
        ${tokenizer.contractVersion}, ${GRAPH_LEXICAL_PROJECTION_VERSION}
      ),
      (
        ${knowledgeBaseId}, ${weakGraphSourceFileId}, ${weakGraphSourceRevisionId},
        ${"ce".repeat(32)}, '协作 冲突 说明 会议 意见 处理',
        ${tokenizer.tokenizeDocument("协作冲突说明 会议意见处理", 100)},
        ARRAY['协作冲突说明']::text[], ARRAY[]::text[],
        ${tokenizer.contractVersion}, ${GRAPH_LEXICAL_PROJECTION_VERSION}
      )
    `;
    await sql`
      INSERT INTO focowiki.active_projection_records (
        knowledge_base_id, projection_kind, record_id,
        last_changed_generation_id, shard_key, source_file_id,
        logical_path, sort_key, title, summary, searchable_text, payload_json
      ) VALUES
      (
        ${knowledgeBaseId}, 'graph_node', ${graphSourceFileId},
        ${generationId}, 'graph-node/v2/0001', ${graphSourceFileId},
        'pages/guides/distributed-locking.md',
        'pages/guides/distributed-locking.md', '分布式锁指南',
        '租约与一致性', 'legacy graph text',
        ${sql.json({
          fileId: graphSourceFileId,
          path: "pages/guides/distributed-locking.md",
          title: "分布式锁指南"
        })}
      ),
      (
        ${knowledgeBaseId}, 'graph_node', ${weakGraphSourceFileId},
        ${generationId}, 'graph-node/v2/0002', ${weakGraphSourceFileId},
        'pages/guides/unrelated-conflict.md',
        'pages/guides/unrelated-conflict.md', '协作冲突说明',
        '会议意见处理', 'legacy graph text',
        ${sql.json({
          fileId: weakGraphSourceFileId,
          path: "pages/guides/unrelated-conflict.md",
          title: "协作冲突说明"
        })}
      )
    `;
    const document = buildBodySearchDocument({
      knowledgeBaseId,
      sourceFileId,
      sourceRevisionId,
      sourceBodyChecksumSha256: checksum,
      title: "Cache consistency",
      logicalPath: "pages/guides/cache.md",
      summary: "Lease recovery",
      body,
      tokenizer
    });
    await repository.persistDocument({
      document,
      completedAt: "2026-07-24T01:00:00.000Z"
    });
    await repository.attachGenerationReference({
      knowledgeBaseId,
      generationId,
      sourceFileId,
      sourceRevisionId,
      searchDocumentId: document.documentId,
      searchSchemaVersion: document.searchSchemaVersion,
      tokenizerContractVersion: document.tokenizerContractVersion,
      segmentationVersion: document.segmentationVersion,
      logicalPath: document.logicalPath,
      title: document.title,
      summary: document.summary,
      sourceUrl: null,
      metadata: {}
    });
    await sql`
      UPDATE focowiki.publication_generations
      SET state = 'active',
          search_schema_version = ${document.searchSchemaVersion},
          tokenizer_contract_version = ${document.tokenizerContractVersion},
          search_segmentation_version = ${document.segmentationVersion}
      WHERE id = ${generationId}
    `;
    await sql`
      UPDATE focowiki.knowledge_bases
      SET active_generation_id = ${generationId}
      WHERE id = ${knowledgeBaseId}
    `;

    const activeReads = createPostgresActiveGenerationReadRepository(sql, tokenizer);
    const result = await activeReads.withActiveGeneration(knowledgeBaseId, (scope) => scope.search({
      query: "续期 冲突",
      mode: "graph",
      limit: 10,
      cursor: null
    }));
    if (!result) {
      throw new Error("Expected an active graph search result.");
    }
    expect(result.items.map((item) => item.sourceFileId)).toEqual([graphSourceFileId]);
    expect(result.items[0]).toMatchObject({
      path: "pages/guides/distributed-locking.md",
      payload: expect.objectContaining({
        matchType: "graph_node",
        sourceUrl: "https://example.com/distributed-locking"
      })
    });
  });

  it("treats SQL syntax and wildcard characters as literal search evidence", async () => {
    await seedSearchableSource({
      sourceFileId: "source-file-search-literal-input",
      sourceRevisionId: "source-revision-search-literal-input",
      relativePath: "guides/literal-input.md",
      title: "Literal input",
      summary: "Parameterized query evidence",
      body: "# Literal input\n\nA percent sign and quote remain ordinary content.",
      sourceUrl: "https://example.com/literal-input"
    });

    for (const query of ["' OR 1=1 --", "%", "_", "\\", "nonexistent needle"]) {
      await expect(searchBodyProjection({
        sql,
        tokenizer,
        knowledgeBaseId,
        generationId,
        query,
        limit: 10,
        cursor: null
      })).resolves.toEqual({ items: [], nextCursor: null });
    }

    const table = await sql<Array<{ count: number }>>`
      SELECT count(*)::int AS count
      FROM focowiki.search_projection_documents
      WHERE knowledge_base_id = ${knowledgeBaseId}
    `;
    expect(table[0]?.count).toBe(1);
  });

  it("keeps the complete legacy search projection readable while a rebuild is failed", async () => {
    const objectChecksum = "ef".repeat(32);
    await sql`
      INSERT INTO focowiki.immutable_objects (
        checksum_sha256, format_version, object_key, content_type, size_bytes,
        verified_at
      ) VALUES (
        ${objectChecksum}, 1, 'generated/legacy.md', 'text/markdown', 6, now()
      )
      ON CONFLICT (checksum_sha256, format_version) DO NOTHING
    `;
    await sql`
      INSERT INTO focowiki.active_object_refs (
        knowledge_base_id, ref_kind, ref_key, file_id,
        last_changed_generation_id, checksum_sha256, format_version,
        logical_path, source_file_id
      ) VALUES (
        ${knowledgeBaseId}, 'page', ${sourceFileId}, 'bundle-file-legacy',
        ${generationId}, ${objectChecksum}, 1, 'pages/guides/cache.md',
        ${sourceFileId}
      )
    `;
    await sql`
      INSERT INTO focowiki.active_projection_records (
        knowledge_base_id, projection_kind, record_id,
        last_changed_generation_id, shard_key, source_file_id,
        logical_path, sort_key, title, summary, searchable_text, payload_json
      ) VALUES (
        ${knowledgeBaseId}, 'search', ${sourceFileId}, ${generationId},
        'search/v1/0001', ${sourceFileId}, 'pages/guides/cache.md',
        'pages/guides/cache.md', 'Cache consistency', 'Legacy summary',
        'complete legacy marker', ${sql.json({
          fileId: "bundle-file-legacy",
          path: "pages/guides/cache.md"
        })}
      )
    `;
    await sql`
      UPDATE focowiki.publication_generations
      SET state = 'active'
      WHERE id = ${generationId}
    `;
    await sql`
      UPDATE focowiki.knowledge_bases
      SET active_generation_id = ${generationId}
      WHERE id = ${knowledgeBaseId}
    `;
    await rebuildSeed();
    await sql`
      UPDATE focowiki.knowledge_base_lexical_rebuilds
      SET state = 'failed',
          last_error_code = 'LEXICAL_REBUILD_FAILED',
          last_error_message = 'Candidate validation failed'
      WHERE knowledge_base_id = ${knowledgeBaseId}
    `;

    const activeReads = createPostgresActiveGenerationReadRepository(sql, tokenizer);
    await expect(activeReads.withActiveGeneration(knowledgeBaseId, (scope) => scope.search({
      query: "complete legacy marker",
      mode: "file",
      limit: 10,
      cursor: null
    }))).resolves.toMatchObject({
      items: [expect.objectContaining({
        sourceFileId,
        path: "pages/guides/cache.md"
      })]
    });
  });

  it("excludes every descendant marked by a directory deletion intent", async () => {
    const phrase = "bounded directory removal evidence";
    const sources = [
      {
        sourceFileId: "source-file-directory-delete-a",
        sourceRevisionId: "source-revision-directory-delete-a",
        relativePath: "manual/section/a.md",
        title: "Directory child A"
      },
      {
        sourceFileId: "source-file-directory-delete-b",
        sourceRevisionId: "source-revision-directory-delete-b",
        relativePath: "manual/section/nested/b.md",
        title: "Directory child B"
      },
      {
        sourceFileId: "source-file-directory-delete-outside",
        sourceRevisionId: "source-revision-directory-delete-outside",
        relativePath: "manual/outside.md",
        title: "Directory outside"
      }
    ];
    for (const source of sources) {
      await seedSearchableSource({
        ...source,
        summary: "Directory deletion visibility",
        body: `# ${source.title}\n\n${phrase}.`,
        sourceUrl: `https://example.com/${source.sourceFileId}`
      });
    }

    const beforeDeletion = await searchBodyProjection({
      sql,
      tokenizer,
      knowledgeBaseId,
      generationId,
      query: phrase,
      limit: 10,
      cursor: null
    });
    expect(beforeDeletion.items.map((item) => item.sourceFileId).sort()).toEqual(
      sources.map((source) => source.sourceFileId).sort()
    );

    await sql.begin(async (transaction) => {
      await transaction`
        INSERT INTO focowiki.deletion_intents (
          id, knowledge_base_id, target_kind, target_id,
          catalog_generation, state
        ) VALUES (
          'deletion-intent-search-directory', ${knowledgeBaseId},
          'source_directory', 'source-directory-search-section', 1, 'running'
        )
      `;
      await transaction`
        UPDATE focowiki.source_files
        SET deletion_intent_id = 'deletion-intent-search-directory'
        WHERE knowledge_base_id = ${knowledgeBaseId}
          AND id = ANY(${sources.slice(0, 2).map((source) => source.sourceFileId)})
      `;
    });

    const afterDeletion = await searchBodyProjection({
      sql,
      tokenizer,
      knowledgeBaseId,
      generationId,
      query: phrase,
      limit: 10,
      cursor: null
    });
    expect(afterDeletion.items.map((item) => item.sourceFileId)).toEqual([
      "source-file-directory-delete-outside"
    ]);
  });

  it("cascades immutable search projections when a source file is hard deleted", async () => {
    const deletedSourceFileId = "source-file-search-hard-delete";
    await seedSearchableSource({
      sourceFileId: deletedSourceFileId,
      sourceRevisionId: "source-revision-search-hard-delete",
      relativePath: "guides/hard-delete.md",
      title: "Hard delete evidence",
      summary: "Deletion lifecycle",
      body: "# Hard delete evidence\n\nThis body must leave no searchable projection.",
      sourceUrl: "https://example.com/hard-delete"
    });

    await sql`
      DELETE FROM focowiki.active_object_refs
      WHERE knowledge_base_id = ${knowledgeBaseId}
        AND source_file_id = ${deletedSourceFileId}
    `;
    await sql`
      DELETE FROM focowiki.source_files
      WHERE knowledge_base_id = ${knowledgeBaseId}
        AND id = ${deletedSourceFileId}
    `;

    const counts = await sql<Array<{
      documents: number;
      segments: number;
      generation_references: number;
    }>>`
      SELECT
        (
          SELECT count(*)::int
          FROM focowiki.search_projection_documents
          WHERE knowledge_base_id = ${knowledgeBaseId}
            AND source_file_id = ${deletedSourceFileId}
        ) AS documents,
        (
          SELECT count(*)::int
          FROM focowiki.search_projection_segments segment
          JOIN focowiki.search_projection_documents document
            ON document.knowledge_base_id = segment.knowledge_base_id
           AND document.id = segment.document_id
          WHERE document.knowledge_base_id = ${knowledgeBaseId}
            AND document.source_file_id = ${deletedSourceFileId}
        ) AS segments,
        (
          SELECT count(*)::int
          FROM focowiki.generation_search_projection_refs
          WHERE knowledge_base_id = ${knowledgeBaseId}
            AND source_file_id = ${deletedSourceFileId}
        ) AS generation_references
    `;
    expect(counts[0]).toEqual({
      documents: 0,
      segments: 0,
      generation_references: 0
    });
  });

  it("cascades all owned search and rebuild state when a knowledge base is deleted", async () => {
    await repository.persistDocument({
      document: testDocument(),
      completedAt: "2026-07-24T01:00:00.000Z"
    });
    await rebuildSeed();

    await sql`DELETE FROM focowiki.knowledge_bases WHERE id = ${knowledgeBaseId}`;

    const counts = await sql<Array<{
      documents: number;
      segments: number;
      references: number;
      rebuilds: number;
    }>>`
      SELECT
        (SELECT count(*)::int FROM focowiki.search_projection_documents
         WHERE knowledge_base_id = ${knowledgeBaseId}) AS documents,
        (SELECT count(*)::int FROM focowiki.search_projection_segments
         WHERE knowledge_base_id = ${knowledgeBaseId}) AS segments,
        (SELECT count(*)::int FROM focowiki.generation_search_projection_refs
         WHERE knowledge_base_id = ${knowledgeBaseId}) AS references,
        (SELECT count(*)::int FROM focowiki.knowledge_base_lexical_rebuilds
         WHERE knowledge_base_id = ${knowledgeBaseId}) AS rebuilds
    `;
    expect(counts[0]).toEqual({
      documents: 0,
      segments: 0,
      references: 0,
      rebuilds: 0
    });
  });

  function testDocument() {
    return buildBodySearchDocument({
      knowledgeBaseId,
      sourceFileId,
      sourceRevisionId,
      sourceBodyChecksumSha256: checksum,
      title: "Cache consistency",
      logicalPath: "pages/guides/cache.md",
      summary: "Lease recovery",
      body,
      tokenizer
    });
  }

  async function seedSource(): Promise<void> {
    await sql.begin(async (transaction) => {
      await transaction`
        INSERT INTO focowiki.knowledge_bases (id, name)
        VALUES (${knowledgeBaseId}, 'Search projection repository')
      `;
      await transaction`
        INSERT INTO focowiki.source_files (
          id, knowledge_base_id, object_key, content_type, size_bytes,
          checksum_sha256, processing_status, processing_stage,
          generated_output_status, name, relative_path, path_key,
          active_revision_id
        ) VALUES (
          ${sourceFileId}, ${knowledgeBaseId}, 'sources/cache.md',
          'text/markdown; charset=utf-8', ${body.length}, ${checksum},
          'completed', 'generation_activation', 'visible', 'cache.md',
          'guides/cache.md', 'guides/cache.md', ${sourceRevisionId}
        )
      `;
      await transaction`
        INSERT INTO focowiki.source_revisions (
          id, knowledge_base_id, source_file_id, revision, object_key,
          content_type, size_bytes, checksum_sha256, processing_status
        ) VALUES (
          ${sourceRevisionId}, ${knowledgeBaseId}, ${sourceFileId}, 1,
          'sources/cache.md', 'text/markdown; charset=utf-8', ${body.length},
          ${checksum}, 'completed'
        )
      `;
      await transaction`
        INSERT INTO focowiki.publication_generations (
          id, knowledge_base_id, state, format_version, generation_kind
        ) VALUES (${generationId}, ${knowledgeBaseId}, 'open', 2, 'normal')
      `;
    });
  }

  async function seedSearchableSource(input: {
    sourceFileId: string;
    sourceRevisionId: string;
    relativePath: string;
    title: string;
    summary: string;
    body: string;
    sourceUrl: string;
  }): Promise<void> {
    const bodyChecksum = createHash("sha256").update(input.body).digest("hex");
    const document = buildBodySearchDocument({
      knowledgeBaseId,
      sourceFileId: input.sourceFileId,
      sourceRevisionId: input.sourceRevisionId,
      sourceBodyChecksumSha256: bodyChecksum,
      title: input.title,
      logicalPath: `pages/${input.relativePath}`,
      summary: input.summary,
      body: input.body,
      tokenizer
    });
    await sql.begin(async (transaction) => {
      await transaction`
        INSERT INTO focowiki.source_files (
          id, knowledge_base_id, object_key, content_type, size_bytes,
          checksum_sha256, processing_status, processing_stage,
          generated_output_status, name, relative_path, path_key,
          active_revision_id
        ) VALUES (
          ${input.sourceFileId}, ${knowledgeBaseId}, ${`sources/${input.relativePath}`},
          'text/markdown; charset=utf-8', ${input.body.length}, ${bodyChecksum},
          'completed', 'generation_activation', 'visible',
          ${input.relativePath.split("/").at(-1)!}, ${input.relativePath},
          ${input.relativePath}, ${input.sourceRevisionId}
        )
      `;
      await transaction`
        INSERT INTO focowiki.source_revisions (
          id, knowledge_base_id, source_file_id, revision, object_key,
          content_type, size_bytes, checksum_sha256, processing_status
        ) VALUES (
          ${input.sourceRevisionId}, ${knowledgeBaseId}, ${input.sourceFileId}, 1,
          ${`sources/${input.relativePath}`}, 'text/markdown; charset=utf-8',
          ${input.body.length}, ${bodyChecksum}, 'completed'
        )
      `;
    });
    await repository.persistDocument({
      document,
      completedAt: "2026-07-24T01:00:00.000Z"
    });
    await repository.attachGenerationReference({
      knowledgeBaseId,
      generationId,
      sourceFileId: input.sourceFileId,
      sourceRevisionId: input.sourceRevisionId,
      searchDocumentId: document.documentId,
      searchSchemaVersion: document.searchSchemaVersion,
      tokenizerContractVersion: document.tokenizerContractVersion,
      segmentationVersion: document.segmentationVersion,
      logicalPath: document.logicalPath,
      title: document.title,
      summary: document.summary,
      sourceUrl: input.sourceUrl,
      metadata: {}
    });
    const objectChecksum = createHash("sha256")
      .update(`object:${input.sourceFileId}`)
      .digest("hex");
    await sql`
      INSERT INTO focowiki.immutable_objects (
        checksum_sha256, format_version, object_key, content_type, size_bytes,
        verified_at
      ) VALUES (
        ${objectChecksum}, 1, ${`generated/${input.relativePath}`},
        'text/markdown', ${input.body.length}, now()
      )
      ON CONFLICT (checksum_sha256, format_version) DO NOTHING
    `;
    await sql`
      INSERT INTO focowiki.active_object_refs (
        knowledge_base_id, ref_kind, ref_key, file_id,
        last_changed_generation_id, checksum_sha256, format_version,
        logical_path, source_file_id
      ) VALUES (
        ${knowledgeBaseId}, 'page', ${input.sourceFileId},
        ${`bundle-file-${input.sourceFileId}`}, ${generationId},
        ${objectChecksum}, 1, ${document.logicalPath}, ${input.sourceFileId}
      )
    `;
  }

  async function rebuildSeed(): Promise<void> {
    await sql`
      INSERT INTO focowiki.knowledge_base_lexical_rebuilds (
        knowledge_base_id, target_search_schema_version,
        target_tokenizer_contract_version, target_segmentation_version,
        target_content_profile_version,
        target_graph_lexical_projection_version,
        base_generation_id
      ) VALUES (
        ${knowledgeBaseId}, 'body-search-v1', ${tokenizer.contractVersion},
        'body-segmentation-v1', 'content-profile-v2', 'graph-lexical-v2',
        ${generationId}
      )
    `;
  }

  async function cleanup(): Promise<void> {
    await sql`DELETE FROM focowiki.knowledge_bases WHERE id = ${knowledgeBaseId}`;
  }
});
