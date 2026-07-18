import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPostgresSourceResourceRepository } from "../src/infrastructure/postgres/source-resource-repository.js";

const databaseUrl = process.env.FOCOWIKI_TEST_DATABASE_URL;
const describeDatabase = databaseUrl ? describe : describe.skip;

describeDatabase("source resource deletion integration", () => {
  const sql = postgres(databaseUrl!, { max: 2 });
  const repository = createPostgresSourceResourceRepository(sql);
  const knowledgeBaseId = "kb-directory-deletion-integration";
  const sourceFileKnowledgeBaseId = "kb-source-file-deletion-integration";

  beforeAll(async () => {
    await sql`DELETE FROM focowiki.source_file_graph_edges WHERE knowledge_base_id = ${knowledgeBaseId}`;
    await sql`DELETE FROM focowiki.source_files WHERE knowledge_base_id = ${knowledgeBaseId}`;
    await sql`DELETE FROM focowiki.source_directories WHERE knowledge_base_id = ${knowledgeBaseId}`;
    await sql`DELETE FROM focowiki.knowledge_bases WHERE id = ${knowledgeBaseId}`;
    await sql`DELETE FROM focowiki.source_file_graph_edges WHERE knowledge_base_id = ${sourceFileKnowledgeBaseId}`;
    await sql`DELETE FROM focowiki.source_files WHERE knowledge_base_id = ${sourceFileKnowledgeBaseId}`;
    await sql`DELETE FROM focowiki.source_directories WHERE knowledge_base_id = ${sourceFileKnowledgeBaseId}`;
    await sql`DELETE FROM focowiki.knowledge_bases WHERE id = ${sourceFileKnowledgeBaseId}`;
    await sql`
      INSERT INTO focowiki.knowledge_bases (id, name)
      VALUES (${knowledgeBaseId}, 'Directory deletion integration')
    `;
    await sql`
      INSERT INTO focowiki.source_directories (
        id, knowledge_base_id, parent_id, name, relative_path, path_key, depth
      ) VALUES
        ('source-directory-root', ${knowledgeBaseId}, NULL, 'root', 'root', 'root', 1),
        ('source-directory-child', ${knowledgeBaseId}, 'source-directory-root', 'child', 'root/child', 'root/child', 2),
        ('source-directory-sibling', ${knowledgeBaseId}, 'source-directory-root', 'sibling', 'root/sibling', 'root/sibling', 2),
        ('source-directory-outside', ${knowledgeBaseId}, NULL, 'outside', 'outside', 'outside', 1)
    `;
    await sql.begin(async (transaction) => {
      await transaction`
        INSERT INTO focowiki.source_files (
          id, knowledge_base_id, name, relative_path, path_key, directory_id,
          object_key, content_type, size_bytes, checksum_sha256, active_revision_id
        ) VALUES
          ('source-file-child-a', ${knowledgeBaseId}, 'a.md', 'root/child/a.md', 'root/child/a.md', 'source-directory-child', 'objects/a', 'text/markdown', 1, 'a', 'source-revision-child-a'),
          ('source-file-child-b', ${knowledgeBaseId}, 'b.md', 'root/child/b.md', 'root/child/b.md', 'source-directory-child', 'objects/b', 'text/markdown', 1, 'b', 'source-revision-child-b'),
          ('source-file-sibling', ${knowledgeBaseId}, 'c.md', 'root/sibling/c.md', 'root/sibling/c.md', 'source-directory-sibling', 'objects/c', 'text/markdown', 1, 'c', 'source-revision-sibling'),
          ('source-file-outside', ${knowledgeBaseId}, 'outside.md', 'outside/outside.md', 'outside/outside.md', 'source-directory-outside', 'objects/outside', 'text/markdown', 1, 'outside', 'source-revision-outside')
      `;
      await transaction`
        INSERT INTO focowiki.source_revisions (
          id, knowledge_base_id, source_file_id, revision, object_key,
          content_type, size_bytes, checksum_sha256
        ) VALUES
          ('source-revision-child-a', ${knowledgeBaseId}, 'source-file-child-a', 1, 'objects/a', 'text/markdown', 1, 'a'),
          ('source-revision-child-b', ${knowledgeBaseId}, 'source-file-child-b', 1, 'objects/b', 'text/markdown', 1, 'b'),
          ('source-revision-sibling', ${knowledgeBaseId}, 'source-file-sibling', 1, 'objects/c', 'text/markdown', 1, 'c'),
          ('source-revision-outside', ${knowledgeBaseId}, 'source-file-outside', 1, 'objects/outside', 'text/markdown', 1, 'outside')
      `;
      await transaction`
        INSERT INTO focowiki.source_file_graph_edges (
          id, knowledge_base_id, from_source_file_id, to_source_file_id,
          relation_type, weight, reason, source, status
        ) VALUES (
          'source-edge-directory-delete-neighbor', ${knowledgeBaseId},
          'source-file-child-a', 'source-file-outside', 'direct_reference',
          0.9, 'Deletion neighbor regression.', 'content', 'accepted'
        )
      `;
    });
    await sql`
      INSERT INTO focowiki.knowledge_bases (id, name)
      VALUES (${sourceFileKnowledgeBaseId}, 'Source file deletion integration')
    `;
    await sql`
      INSERT INTO focowiki.source_directories (
        id, knowledge_base_id, parent_id, name, relative_path, path_key, depth
      ) VALUES (
        'source-directory-file-delete', ${sourceFileKnowledgeBaseId}, NULL,
        'documents', 'documents', 'documents', 1
      )
    `;
    await sql.begin(async (transaction) => {
      await transaction`
        INSERT INTO focowiki.source_files (
          id, knowledge_base_id, name, relative_path, path_key, directory_id,
          object_key, content_type, size_bytes, checksum_sha256, active_revision_id
        ) VALUES
          ('source-file-delete-target', ${sourceFileKnowledgeBaseId}, 'target.md', 'documents/target.md', 'documents/target.md', 'source-directory-file-delete', 'objects/target', 'text/markdown', 1, 'target', 'source-revision-delete-target'),
          ('source-file-delete-neighbor', ${sourceFileKnowledgeBaseId}, 'neighbor.md', 'documents/neighbor.md', 'documents/neighbor.md', 'source-directory-file-delete', 'objects/neighbor', 'text/markdown', 1, 'neighbor', 'source-revision-delete-neighbor')
      `;
      await transaction`
        INSERT INTO focowiki.source_revisions (
          id, knowledge_base_id, source_file_id, revision, object_key,
          content_type, size_bytes, checksum_sha256
        ) VALUES
          ('source-revision-delete-target', ${sourceFileKnowledgeBaseId}, 'source-file-delete-target', 1, 'objects/target', 'text/markdown', 1, 'target'),
          ('source-revision-delete-neighbor', ${sourceFileKnowledgeBaseId}, 'source-file-delete-neighbor', 1, 'objects/neighbor', 'text/markdown', 1, 'neighbor')
      `;
      await transaction`
        INSERT INTO focowiki.source_file_graph_edges (
          id, knowledge_base_id, from_source_file_id, to_source_file_id,
          relation_type, weight, reason, source, status
        ) VALUES (
          'source-edge-file-delete-neighbor', ${sourceFileKnowledgeBaseId},
          'source-file-delete-target', 'source-file-delete-neighbor', 'direct_reference',
          0.9, 'Source deletion neighbor regression.', 'content', 'accepted'
        )
      `;
    });
  });

  afterAll(async () => {
    await sql`DELETE FROM focowiki.source_file_graph_edges WHERE knowledge_base_id = ${knowledgeBaseId}`;
    await sql`DELETE FROM focowiki.source_files WHERE knowledge_base_id = ${knowledgeBaseId}`;
    await sql`DELETE FROM focowiki.source_directories WHERE knowledge_base_id = ${knowledgeBaseId}`;
    await sql`DELETE FROM focowiki.knowledge_bases WHERE id = ${knowledgeBaseId}`;
    await sql`DELETE FROM focowiki.source_file_graph_edges WHERE knowledge_base_id = ${sourceFileKnowledgeBaseId}`;
    await sql`DELETE FROM focowiki.source_files WHERE knowledge_base_id = ${sourceFileKnowledgeBaseId}`;
    await sql`DELETE FROM focowiki.source_directories WHERE knowledge_base_id = ${sourceFileKnowledgeBaseId}`;
    await sql`DELETE FROM focowiki.knowledge_bases WHERE id = ${sourceFileKnowledgeBaseId}`;
    await sql.end({ timeout: 5 });
  });

  it("lets a parent deletion absorb a child intent and marks descendants in bounded batches", async () => {
    const child = await repository.acceptDirectoryDeletion({
      operationId: "resource-operation-delete-child",
      deletionIntentId: "deletion-intent-child",
      knowledgeBaseId,
      directoryId: "source-directory-child",
      idempotencyKey: "delete-child",
      requestFingerprint: "fingerprint-child",
      expectedResourceRevision: 1,
      deletedAt: new Date().toISOString()
    });
    expect(child.replayed).toBe(false);

    const parent = await repository.acceptDirectoryDeletion({
      operationId: "resource-operation-delete-parent",
      deletionIntentId: "deletion-intent-parent",
      knowledgeBaseId,
      directoryId: "source-directory-root",
      idempotencyKey: "delete-parent",
      requestFingerprint: "fingerprint-parent",
      expectedResourceRevision: 1,
      deletedAt: new Date().toISOString()
    });
    expect(parent.replayed).toBe(false);

    let prepared = await repository.prepareOperation({
      knowledgeBaseId,
      operationId: parent.operation.id,
      now: new Date().toISOString(),
      batchSize: 1
    });
    while (prepared.requiresContinuation) {
      prepared = await repository.prepareOperation({
        knowledgeBaseId,
        operationId: parent.operation.id,
        now: new Date().toISOString(),
        batchSize: 1
      });
    }

    expect(prepared.requiresPublication).toBe(true);
    expect(prepared.directoryDeletion).toEqual({
      deletionIntentId: "deletion-intent-parent",
      directoryId: "source-directory-root"
    });

    const intents = await sql<Array<{ id: string; state: string }>>`
      SELECT id, state
      FROM focowiki.deletion_intents
      WHERE knowledge_base_id = ${knowledgeBaseId}
      ORDER BY id
    `;
    expect(intents).toEqual([
      { id: "deletion-intent-child", state: "superseded" },
      { id: "deletion-intent-parent", state: "running" }
    ]);

    const files = await sql<Array<{
      id: string;
      deletion_intent_id: string | null;
    }>>`
      SELECT id, deletion_intent_id
      FROM focowiki.source_files
      WHERE knowledge_base_id = ${knowledgeBaseId}
      ORDER BY id
    `;
    expect(files).toEqual([
      {
        id: "source-file-child-a",
        deletion_intent_id: "deletion-intent-parent"
      },
      {
        id: "source-file-child-b",
        deletion_intent_id: "deletion-intent-parent"
      },
      {
        id: "source-file-outside",
        deletion_intent_id: null
      },
      {
        id: "source-file-sibling",
        deletion_intent_id: "deletion-intent-parent"
      }
    ]);

    const absorbed = await repository.acceptSourceFileDeletion({
      operationId: "resource-operation-delete-file",
      deletionIntentId: "deletion-intent-file",
      knowledgeBaseId,
      sourceFileId: "source-file-child-a",
      idempotencyKey: "delete-file-after-parent",
      requestFingerprint: "fingerprint-file-after-parent",
      expectedResourceRevision: 1,
      deletedAt: new Date().toISOString()
    });
    expect(absorbed.replayed).toBe(true);
    expect(absorbed.deletionIntentId).toBe("deletion-intent-parent");
    expect(absorbed.operation.id).toBe(parent.operation.id);
  });

  it("returns a deterministic source-deletion fact input without mutating neighbors", async () => {
    const accepted = await repository.acceptSourceFileDeletion({
      operationId: "resource-operation-delete-source-file",
      deletionIntentId: "deletion-intent-source-file",
      knowledgeBaseId: sourceFileKnowledgeBaseId,
      sourceFileId: "source-file-delete-target",
      idempotencyKey: "delete-source-file",
      requestFingerprint: "fingerprint-delete-source-file",
      expectedResourceRevision: 1,
      deletedAt: new Date().toISOString()
    });
    expect(accepted.sourceMutation).toEqual({
      sourceFileId: "source-file-delete-target",
      sourceRevisionId: "source-revision-delete-target",
      kind: "source_deleted",
      previousPath: "documents/target.md",
      path: null,
      resourceRevision: 1
    });

    const rows = await sql<Array<{
      id: string;
      deletion_intent_id: string | null;
      generated_output_status: string;
    }>>`
      SELECT id, deletion_intent_id, generated_output_status
      FROM focowiki.source_files
      WHERE knowledge_base_id = ${sourceFileKnowledgeBaseId}
      ORDER BY id
    `;
    expect(rows).toEqual([
      {
        id: "source-file-delete-neighbor",
        deletion_intent_id: null,
        generated_output_status: "pending"
      },
      {
        id: "source-file-delete-target",
        deletion_intent_id: "deletion-intent-source-file",
        generated_output_status: "pending"
      }
    ]);
  });
});
