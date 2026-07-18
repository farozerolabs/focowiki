import { createHash } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { normalizeSourceRelativePath } from "../src/domain/source-path.js";
import { createPostgresUploadSessionRepository } from "../src/infrastructure/postgres/upload-session-repository.js";
import { createPostgresSourceFileRepository } from "../src/infrastructure/postgres/source-file-repository.js";

const databaseUrl = process.env.FOCOWIKI_TEST_DATABASE_URL;
const describeDatabase = databaseUrl ? describe : describe.skip;

describeDatabase("upload session repository integration", () => {
  const sql = postgres(databaseUrl!, { max: 4 });
  const repository = createPostgresUploadSessionRepository(sql);
  const sourceFiles = createPostgresSourceFileRepository(sql);
  const knowledgeBaseId = "kb-upload-session-integration";

  beforeAll(async () => {
    await cleanup();
    await sql`
      INSERT INTO focowiki.knowledge_bases (id, name)
      VALUES (${knowledgeBaseId}, 'Upload session integration')
    `;
  });

  afterAll(async () => {
    await cleanup();
    await sql.end({ timeout: 5 });
  });

  it("finalizes nested sources and keeps repeated same-folder uploads incremental", async () => {
    const first = await createSealedSession({
      sessionId: "upload-session-first",
      idempotencyKey: "first",
      entries: [
        createEntry("upload-entry-a", "source-file-a", "team/guides/a.md", "A"),
        createEntry("upload-entry-b", "source-file-b", "team/guides/deep/b.md", "B")
      ]
    });
    expect(first.counts).toMatchObject({ uploadRequired: 2, skippedExisting: 0 });
    await uploadRequiredEntries(first.id);
    const finalizedFirst = await repository.finalizeSession({
      knowledgeBaseId,
      sessionId: first.id,
      now: new Date().toISOString()
    });
    expect(finalizedFirst).toMatchObject({ state: "completed", counts: { finalized: 2 } });
    const replayedFinalization = await repository.finalizeSession({
      knowledgeBaseId,
      sessionId: first.id,
      now: new Date().toISOString()
    });
    expect(replayedFinalization.state).toBe("completed");

    const activeRows = await sql<Array<{
      id: string;
      relative_path: string;
      active_revision_id: string;
      revision_count: number;
    }>>`
      SELECT source.id, source.relative_path, source.active_revision_id,
             count(revision.id)::int AS revision_count
      FROM focowiki.source_files source
      JOIN focowiki.source_revisions revision ON revision.source_file_id = source.id
      WHERE source.knowledge_base_id = ${knowledgeBaseId}
      GROUP BY source.id, source.relative_path, source.active_revision_id
      ORDER BY source.relative_path ASC
    `;
    expect(activeRows).toEqual([
      expect.objectContaining({ relative_path: "team/guides/a.md", revision_count: 1 }),
      expect.objectContaining({ relative_path: "team/guides/deep/b.md", revision_count: 1 })
    ]);
    const dispatch = await sql<Array<{ markers: number }>>`
      SELECT count(*)::int AS markers
      FROM focowiki.source_dispatch_markers
      WHERE knowledge_base_id = ${knowledgeBaseId}
    `;
    expect(dispatch[0]).toEqual({ markers: 2 });

    await sourceFiles.updateSourceFileMetadata({
      knowledgeBaseId,
      sourceFileId: "source-file-a",
      metadata: { type: "guide", title: "A" }
    });
    const revisionMetadata = await sql<Array<{ metadata_json: Record<string, unknown> }>>`
      SELECT revision.metadata_json
      FROM focowiki.source_revisions revision
      JOIN focowiki.source_files source ON source.active_revision_id = revision.id
      WHERE source.knowledge_base_id = ${knowledgeBaseId}
        AND source.id = 'source-file-a'
    `;
    expect(revisionMetadata[0]?.metadata_json).toEqual({ type: "guide", title: "A" });

    const repeated = await createSealedSession({
      sessionId: "upload-session-repeated",
      idempotencyKey: "repeated",
      entries: [
        createEntry("upload-entry-existing", "source-file-unused", "team/guides/a.md", "A"),
        createEntry("upload-entry-new", "source-file-c", "team/guides/c.md", "C")
      ]
    });
    expect(repeated.counts).toMatchObject({ uploadRequired: 1, skippedExisting: 1 });
    const repeatedEntries = await repository.listEntries({
      knowledgeBaseId,
      sessionId: repeated.id,
      limit: 10,
      cursor: null
    });
    expect(repeatedEntries.items.find((entry) => entry.relativePath.endsWith("a.md"))).toMatchObject({
      disposition: "skipped_existing",
      sourceFileId: "source-file-a",
      existingResourceRevision: 1
    });
    await uploadRequiredEntries(repeated.id);
    const finalizedRepeated = await repository.finalizeSession({
      knowledgeBaseId,
      sessionId: repeated.id,
      now: new Date().toISOString()
    });
    expect(finalizedRepeated).toMatchObject({ state: "completed", counts: { finalized: 1 } });
  });

  it("rejects an existing path while an ancestor directory deletion is active", async () => {
    const directories = await sql<Array<{ id: string }>>`
      SELECT id
      FROM focowiki.source_directories
      WHERE knowledge_base_id = ${knowledgeBaseId}
        AND path_key = 'team/guides'
        AND deleted_at IS NULL
    `;
    const directoryId = directories[0]?.id;
    if (!directoryId) throw new Error("Existing source directory was not found");
    await sql`
      INSERT INTO focowiki.deletion_intents (
        id, knowledge_base_id, target_kind, target_id, catalog_generation, state
      ) VALUES (
        'deletion-intent-upload-existing-path', ${knowledgeBaseId},
        'source_directory', ${directoryId}, 1, 'running'
      )
    `;

    const session = await createSealedSession({
      sessionId: "upload-session-active-deletion",
      idempotencyKey: "active-deletion",
      entries: [
        createEntry(
          "upload-entry-active-deletion",
          "source-file-active-deletion",
          "team/guides/a.md",
          "replacement"
        )
      ]
    });
    expect(session.counts).toMatchObject({
      uploadRequired: 0,
      skippedExisting: 0,
      rejectedDeleting: 1
    });
    const entries = await repository.listEntries({
      knowledgeBaseId,
      sessionId: session.id,
      limit: 10,
      cursor: null
    });
    expect(entries.items[0]).toMatchObject({
      disposition: "rejected_deleting",
      sourceFileId: "source-file-active-deletion"
    });

    await sql`
      UPDATE focowiki.deletion_intents
      SET state = 'completed', completed_at = now(), updated_at = now()
      WHERE id = 'deletion-intent-upload-existing-path'
    `;
  });

  it("reconciles concurrent path reservations without duplicate source rows", async () => {
    const left = await createSealedSession({
      sessionId: "upload-session-left",
      idempotencyKey: "left",
      entries: [createEntry("upload-entry-left", "source-file-left", "shared/new.md", "left")]
    });
    const right = await createSealedSession({
      sessionId: "upload-session-right",
      idempotencyKey: "right",
      entries: [createEntry("upload-entry-right", "source-file-right", "shared/new.md", "right")]
    });
    expect(left.counts.uploadRequired).toBe(1);
    expect(right.counts.waitingReservation).toBe(1);

    await uploadRequiredEntries(left.id);
    await repository.finalizeSession({
      knowledgeBaseId,
      sessionId: left.id,
      now: new Date().toISOString()
    });

    const reconciled = await repository.reconcileReservations({
      knowledgeBaseId,
      sessionId: right.id
    });
    expect(reconciled.counts).toMatchObject({ skippedExisting: 1, waitingReservation: 0 });
    const noOp = await repository.finalizeSession({
      knowledgeBaseId,
      sessionId: right.id,
      now: new Date().toISOString()
    });
    expect(noOp).toMatchObject({ state: "completed", counts: { finalized: 0 } });

    const duplicates = await sql<Array<{ count: number }>>`
      SELECT count(*)::int AS count
      FROM focowiki.source_files
      WHERE knowledge_base_id = ${knowledgeBaseId}
        AND path_key = 'shared/new.md'
    `;
    expect(duplicates[0]?.count).toBe(1);
  });

  it("rejects source registration after its source directory enters deletion", async () => {
    const session = await createSealedSession({
      sessionId: "upload-session-delete-conflict",
      idempotencyKey: "delete-conflict",
      entries: [
        createEntry(
          "upload-entry-delete-conflict",
          "source-file-delete-conflict",
          "conflict/docs/file.md",
          "conflict"
        )
      ]
    });
    const directories = await sql<Array<{ id: string }>>`
      SELECT id
      FROM focowiki.source_directories
      WHERE knowledge_base_id = ${knowledgeBaseId}
        AND path_key = 'conflict/docs'
    `;
    const directoryId = directories[0]?.id;
    if (!directoryId) throw new Error("Conflict directory was not created");
    await sql`
      INSERT INTO focowiki.deletion_intents (
        id, knowledge_base_id, target_kind, target_id, catalog_generation
      ) VALUES (
        'deletion-intent-upload-conflict', ${knowledgeBaseId},
        'source_directory', ${directoryId}, 1
      )
    `;
    await sql`
      UPDATE focowiki.source_directories
      SET deletion_intent_id = 'deletion-intent-upload-conflict', deleted_at = now()
      WHERE id = ${directoryId}
    `;

    await expect(repository.markEntryUploaded({
      knowledgeBaseId,
      sessionId: session.id,
      entryId: "upload-entry-delete-conflict",
      stagingObjectKey: "test/upload-entry-delete-conflict.md",
      receivedSize: 8,
      receivedChecksumSha256: checksum("conflict")
    })).rejects.toMatchObject({ code: "UPLOAD_SESSION_STATE_CONFLICT" });
    const sources = await sql<Array<{ count: number }>>`
      SELECT count(*)::int AS count
      FROM focowiki.source_files
      WHERE id = 'source-file-delete-conflict'
    `;
    expect(sources[0]?.count).toBe(0);
  });

  it("replays an identical session request and rejects a changed idempotency payload", async () => {
    const first = await repository.createSession({
      id: "upload-session-idempotency-first",
      knowledgeBaseId,
      idempotencyKey: "stable-session-request",
      declaredFileCount: 2,
      declaredByteCount: 20,
      expiresAt: new Date(Date.now() + 60_000).toISOString()
    });
    const replay = await repository.createSession({
      id: "upload-session-idempotency-replay",
      knowledgeBaseId,
      idempotencyKey: "stable-session-request",
      declaredFileCount: 2,
      declaredByteCount: 20,
      expiresAt: new Date(Date.now() + 60_000).toISOString()
    });

    expect(replay.id).toBe(first.id);
    await expect(repository.createSession({
      id: "upload-session-idempotency-conflict",
      knowledgeBaseId,
      idempotencyKey: "stable-session-request",
      declaredFileCount: 3,
      declaredByteCount: 30,
      expiresAt: new Date(Date.now() + 60_000).toISOString()
    })).rejects.toMatchObject({ code: "UPLOAD_IDEMPOTENCY_CONFLICT" });
  });

  async function createSealedSession(input: {
    sessionId: string;
    idempotencyKey: string;
    entries: ReturnType<typeof createEntry>[];
  }) {
    const declaredByteCount = input.entries.reduce((total, entry) => total + entry.declaredSize, 0);
    await repository.createSession({
      id: input.sessionId,
      knowledgeBaseId,
      idempotencyKey: input.idempotencyKey,
      declaredFileCount: input.entries.length,
      declaredByteCount,
      expiresAt: new Date(Date.now() + 60_000).toISOString()
    });
    await repository.addManifestEntries({
      knowledgeBaseId,
      sessionId: input.sessionId,
      entries: input.entries
    });
    return repository.sealManifest({
      knowledgeBaseId,
      sessionId: input.sessionId,
      manifestFingerprint: checksum(input.idempotencyKey)
    });
  }

  async function uploadRequiredEntries(sessionId: string) {
    const page = await repository.listEntries({
      knowledgeBaseId,
      sessionId,
      limit: 100,
      cursor: null
    });
    for (const entry of page.items.filter((item) => item.disposition === "upload_required")) {
      await repository.markEntryUploaded({
        knowledgeBaseId,
        sessionId,
        entryId: entry.id,
        stagingObjectKey: `test/${entry.id}.md`,
        receivedSize: entry.declaredSize,
        receivedChecksumSha256: entry.checksumSha256 ?? checksum(entry.relativePath)
      });
    }
  }

  async function cleanup() {
    await sql.begin(async (transaction) => {
      await transaction`DELETE FROM focowiki.upload_sessions WHERE knowledge_base_id = ${knowledgeBaseId}`;
      await transaction`DELETE FROM focowiki.source_dispatch_markers WHERE knowledge_base_id = ${knowledgeBaseId}`;
      await transaction`DELETE FROM focowiki.role_jobs WHERE knowledge_base_id = ${knowledgeBaseId}`;
      await transaction`DELETE FROM focowiki.source_files WHERE knowledge_base_id = ${knowledgeBaseId}`;
      await transaction`DELETE FROM focowiki.source_directories WHERE knowledge_base_id = ${knowledgeBaseId}`;
      await transaction`DELETE FROM focowiki.deletion_intents WHERE knowledge_base_id = ${knowledgeBaseId}`;
      await transaction`DELETE FROM focowiki.knowledge_bases WHERE id = ${knowledgeBaseId}`;
    });
  }
});

function createEntry(id: string, sourceFileId: string, relativePath: string, content: string) {
  const bytes = new TextEncoder().encode(content);
  return {
    id,
    sourceFileId,
    path: normalizeSourceRelativePath(relativePath),
    declaredSize: bytes.byteLength,
    checksumSha256: createHash("sha256").update(bytes).digest("hex")
  };
}

function checksum(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
