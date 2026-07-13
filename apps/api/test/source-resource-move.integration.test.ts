import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPostgresSourceResourceRepository } from "../src/infrastructure/postgres/source-resource-repository.js";

const databaseUrl = process.env.FOCOWIKI_TEST_DATABASE_URL;
const describeDatabase = databaseUrl ? describe : describe.skip;

describeDatabase("source resource move integration", () => {
  const sql = postgres(databaseUrl!, { max: 2 });
  const repository = createPostgresSourceResourceRepository(sql);
  const knowledgeBaseId = "kb-source-directory-move-integration";

  beforeAll(async () => {
    await clearFixture();
    await sql`
      INSERT INTO focowiki.knowledge_bases (id, name)
      VALUES (${knowledgeBaseId}, 'Source directory move integration')
    `;
    await sql`
      INSERT INTO focowiki.source_directories (
        id, knowledge_base_id, parent_id, name, relative_path, path_key, depth
      ) VALUES
        ('source-directory-move-root', ${knowledgeBaseId}, NULL, 'root', 'root', 'root', 1),
        ('source-directory-move-child', ${knowledgeBaseId}, 'source-directory-move-root', 'child', 'root/child', 'root/child', 2)
    `;
    await sql.begin(async (transaction) => {
      await transaction`
        INSERT INTO focowiki.source_files (
          id, knowledge_base_id, name, relative_path, path_key, directory_id,
          object_key, content_type, size_bytes, checksum_sha256, active_revision_id
        ) VALUES (
          'source-file-move-child', ${knowledgeBaseId}, 'guide.md',
          'root/child/guide.md', 'root/child/guide.md', 'source-directory-move-child',
          'objects/guide', 'text/markdown', 1, 'guide', 'source-revision-move-child'
        ), (
          'source-file-move-busy', ${knowledgeBaseId}, 'busy.md',
          'root/busy.md', 'root/busy.md', 'source-directory-move-root',
          'objects/busy', 'text/markdown', 1, 'busy', 'source-revision-move-busy'
        ), (
          'source-file-replace', ${knowledgeBaseId}, 'replace.md',
          'root/replace.md', 'root/replace.md', 'source-directory-move-root',
          'objects/replace', 'text/markdown', 1, 'replace', 'source-revision-replace'
        )
      `;
      await transaction`
        UPDATE focowiki.source_files
        SET processing_status = CASE
          WHEN id IN ('source-file-move-child', 'source-file-replace') THEN 'completed'
          ELSE 'running'
        END
        WHERE knowledge_base_id = ${knowledgeBaseId}
      `;
      await transaction`
        INSERT INTO focowiki.source_revisions (
          id, knowledge_base_id, source_file_id, revision, object_key,
          content_type, size_bytes, checksum_sha256
        ) VALUES (
          'source-revision-move-child', ${knowledgeBaseId}, 'source-file-move-child', 1,
          'objects/guide', 'text/markdown', 1, 'guide'
        ), (
          'source-revision-move-busy', ${knowledgeBaseId}, 'source-file-move-busy', 1,
          'objects/busy', 'text/markdown', 1, 'busy'
        ), (
          'source-revision-replace', ${knowledgeBaseId}, 'source-file-replace', 1,
          'objects/replace', 'text/markdown', 1, 'replace'
        )
      `;
    });
  });

  afterAll(async () => {
    await clearFixture();
    await sql.end({ timeout: 5 });
  });

  it("reserves every directory and file path for a same-parent directory rename", async () => {
    await repository.createOperation({
      operationId: "resource-operation-directory-move-integration",
      knowledgeBaseId,
      kind: "source_directory_move",
      idempotencyKey: "move-directory-integration",
      requestFingerprint: "move-directory-integration-fingerprint",
      request: { relativePath: "root/renamed-child" },
      expectedResourceRevision: 1,
      targetKind: "source_directory",
      targetId: "source-directory-move-child"
    });

    const prepared = await repository.prepareOperation({
      knowledgeBaseId,
      operationId: "resource-operation-directory-move-integration",
      now: new Date().toISOString(),
      batchSize: 50
    });

    expect(prepared.operation.state).toBe("publishing");
    const reservations = await sql<Array<{
      resource_kind: string;
      path_key: string;
      target_id: string;
    }>>`
      SELECT resource_kind, path_key, target_id
      FROM focowiki.resource_path_reservations
      WHERE knowledge_base_id = ${knowledgeBaseId}
      ORDER BY resource_kind, target_id
    `;
    expect(reservations).toEqual([
      {
        resource_kind: "source_directory",
        path_key: "root/renamed-child",
        target_id: "source-directory-move-child"
      },
      {
        resource_kind: "source_file",
        path_key: "root/renamed-child/guide.md",
        target_id: "source-file-move-child"
      }
    ]);
  });

  it("rejects a file move while source processing is running", async () => {
    await repository.createOperation({
      operationId: "resource-operation-file-busy-integration",
      knowledgeBaseId,
      kind: "source_file_move",
      idempotencyKey: "move-file-busy-integration",
      requestFingerprint: "move-file-busy-integration-fingerprint",
      request: { relativePath: "root/moved-busy.md" },
      expectedResourceRevision: 1,
      targetKind: "source_file",
      targetId: "source-file-move-busy"
    });

    await expect(repository.prepareOperation({
      knowledgeBaseId,
      operationId: "resource-operation-file-busy-integration",
      now: new Date().toISOString(),
      batchSize: 50
    })).rejects.toMatchObject({ code: "RESOURCE_BUSY" });
  });

  it("cleans replacement candidates when an operation reaches terminal failure", async () => {
    const operationId = "resource-operation-replace-failure-integration";
    const candidateRevisionId = "source-revision-replace-candidate";
    await repository.createOperation({
      operationId,
      knowledgeBaseId,
      kind: "source_file_replace",
      idempotencyKey: "replace-file-failure-integration",
      requestFingerprint: "replace-file-failure-integration-fingerprint",
      request: {
        relativePath: "root/replaced.md",
        revisionId: candidateRevisionId,
        objectKey: "objects/replace-candidate",
        contentType: "text/markdown; charset=utf-8",
        sizeBytes: 10,
        checksumSha256: "replace-candidate"
      },
      expectedResourceRevision: 1,
      targetKind: "source_file",
      targetId: "source-file-replace"
    });
    await repository.prepareOperation({
      knowledgeBaseId,
      operationId,
      now: new Date().toISOString(),
      batchSize: 50
    });

    const failed = await repository.failSourceFileCandidateOperation({
      knowledgeBaseId,
      sourceFileId: "source-file-replace",
      errorCode: "SOURCE_FILE_PROCESSING_FAILED",
      failedAt: new Date().toISOString()
    });

    const [source] = await sql<Array<{
      candidate_operation_id: string | null;
      candidate_revision_id: string | null;
    }>>`
      SELECT candidate_operation_id, candidate_revision_id
      FROM focowiki.source_files
      WHERE id = 'source-file-replace'
    `;
    const [revisionCount] = await sql<Array<{ count: number }>>`
      SELECT count(*)::int AS count
      FROM focowiki.source_revisions
      WHERE id = ${candidateRevisionId}
    `;
    const [reservationCount] = await sql<Array<{ count: number }>>`
      SELECT count(*)::int AS count
      FROM focowiki.resource_path_reservations
      WHERE operation_id = ${operationId}
    `;

    expect(source).toEqual({
      candidate_operation_id: null,
      candidate_revision_id: null
    });
    expect(failed.operation?.id).toBe(operationId);
    expect(failed.objectKeys).toEqual(["objects/replace-candidate"]);
    expect(revisionCount?.count).toBe(0);
    expect(reservationCount?.count).toBe(0);
  });

  async function clearFixture() {
    await sql`DELETE FROM focowiki.source_files WHERE knowledge_base_id = ${knowledgeBaseId}`;
    await sql`DELETE FROM focowiki.source_directories WHERE knowledge_base_id = ${knowledgeBaseId}`;
    await sql`DELETE FROM focowiki.resource_operations WHERE knowledge_base_id = ${knowledgeBaseId}`;
    await sql`DELETE FROM focowiki.knowledge_bases WHERE id = ${knowledgeBaseId}`;
  }
});
