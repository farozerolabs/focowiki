import { createHash, randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { DatabaseClient } from "../src/db/client.js";
import { createStorageVnextUploadCoordinator } from
  "../src/storage-vnext/upload/upload-coordinator.js";
import { createPostgresStorageVnextUploadRepository } from
  "../src/storage-vnext/upload/postgres-repository.js";
import { createPostgresStorageVnextUploadTerminalPort } from
  "../src/storage-vnext/upload/postgres-terminal.js";
import { createPostgresStorageVnextWorkflowRepository } from
  "../src/storage-vnext/workflow/postgres-repository.js";
import { findIdempotentUploadSession } from
  "../src/storage-vnext/api/postgres-admin-upload-session-store.js";
import { applyStorageVnextTestMigrations } from
  "./helpers/storage-vnext-test-migrations.js";

const databaseUrl = process.env.FOCOWIKI_STORAGE_VNEXT_TEST_DATABASE_URL;
const runOwner = process.env.FOCOWIKI_STORAGE_VNEXT_TEST_RUN_OWNER;
const hasOwnedTarget = Boolean(
  databaseUrl
  && runOwner
  && /^svnext-[a-z0-9]{8,16}$/u.test(runOwner)
);
const describeOwnedDatabase = hasOwnedTarget ? describe : describe.skip;

describeOwnedDatabase("storage vNext upload PostgreSQL repository", () => {
  const connectionUrl = databaseUrl
    ?? "postgres://unused:unused@127.0.0.1:5432/unused";
  const ownerToken = (runOwner ?? "invalid").replaceAll("-", "_");
  const databaseName = `focowiki_vnext_upload_${ownerToken}_${
    randomUUID().replaceAll("-", "").slice(0, 10)
  }`;
  const admin = postgres(databaseConnectionUrl(connectionUrl, "postgres"), { max: 1 });
  const sql = postgres(databaseConnectionUrl(connectionUrl, databaseName), { max: 6 });
  const database = sql as unknown as DatabaseClient;
  const repository = createPostgresStorageVnextUploadRepository(database, {
    sourceWorkRetentionMilliseconds: 86_400_000
  });
  const terminal = createPostgresStorageVnextUploadTerminalPort(database, {
    resultRetentionMilliseconds: 86_400_000
  });
  const workflow = createPostgresStorageVnextWorkflowRepository(database);
  const bodyWriter = createDatabaseBackedBodyWriter(sql);
  const coordinator = createStorageVnextUploadCoordinator({
    repository,
    terminal,
    bodyWriter,
    limits: { maximumEntries: 100, maximumManifestBytes: 262_144 }
  });
  let databaseCreated = false;

  beforeAll(async () => {
    await admin.unsafe(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
    databaseCreated = true;
    await applyStorageVnextTestMigrations(sql);
    await sql`
      INSERT INTO focowiki.runtime_setting_revisions
        (public_id, checksum_sha256, settings_values)
      VALUES ('settings-upload-integration', ${"a".repeat(64)}, '{}'::jsonb)
    `;
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

  it("atomically accepts current revisions and source work without creating a search index", async () => {
    await seedKnowledgeBase("kb-upload-success");
    const first = manifestEntry(
      "entry-success-one",
      "file-success-one",
      "Guides/Start.md",
      "# Shared body\n"
    );
    const second = manifestEntry(
      "entry-success-two",
      "file-success-two",
      "Guides/Nested/Continue.md",
      "# Shared body\n"
    );
    const request = sessionRequest("success", "kb-upload-success", [first, second]);
    await coordinator.openSession(request);
    await coordinator.putEntry(putRequest("kb-upload-success", "success", first));
    await coordinator.putEntry(putRequest("kb-upload-success", "success", second));

    await expect(coordinator.finalizeSession({
      knowledgeBaseId: "kb-upload-success",
      sessionPublicId: "upload-success",
      completedAt: "2026-08-01T00:05:00.000Z"
    })).resolves.toEqual({
      outcome: "accepted",
      acceptedRevisionCount: 2,
      sourceWorkCount: 2,
      downstreamProcessingState: "queued"
    });

    const counts = await scopedCounts("kb-upload-success");
    expect(counts).toMatchObject({
      upload_sessions: "0",
      upload_entries: "0",
      upload_reservations: "0",
      upload_work: "0",
      operation_results: "1",
      source_files: "2",
      source_revisions: "2",
      current_revisions: "2",
      source_work: "2",
      object_registrations: "1",
      source_owners: "2",
      live_owners: "0",
      owned_with_zero_owner_since: "0",
      search_projections: "0"
    });
    const terminalResults = await sql<Array<{ result_summary: unknown }>>`
      SELECT result_summary
      FROM focowiki.operation_results
      WHERE knowledge_base_id = 'kb-upload-success'
    `;
    expect(terminalResults[0]?.result_summary).toMatchObject({
      expectedEntryCount: 2,
      receivedEntryCount: 2,
      skippedExistingCount: 0
    });
    const directories = await sql<Array<{
      logical_path: string;
      parent_path: string | null;
    }>>`
      SELECT child.logical_path, parent.logical_path AS parent_path
      FROM focowiki.source_directories child
      LEFT JOIN focowiki.source_directories parent
        ON parent.knowledge_base_id = child.knowledge_base_id
       AND parent.public_id = child.parent_public_id
      WHERE child.knowledge_base_id = 'kb-upload-success'
      ORDER BY child.logical_path
    `;
    expect(directories).toEqual([
      { logical_path: "Guides", parent_path: null },
      { logical_path: "Guides/Nested", parent_path: "Guides" }
    ]);
    await expect(coordinator.openSession(request)).resolves.toEqual({
      outcome: "replayed",
      sessionPublicId: "upload-success"
    });
    expect(await scopedCounts("kb-upload-success")).toEqual(counts);
    const claimed = await workflow.claim({
      kinds: ["source"],
      owner: "source-upload-integration",
      limit: 2,
      leaseExpiresAt: new Date(Date.now() + 60_000).toISOString()
    });
    expect(claimed).toHaveLength(2);
    expect(claimed.map((work) => work.checkpoint.sourceRevisionPublicId).sort())
      .toEqual(expect.arrayContaining([
        expect.stringMatching(/^source-revision-[0-9a-f]{64}$/u),
        expect.stringMatching(/^source-revision-[0-9a-f]{64}$/u)
      ]));
  });

  it("persists a checksum computed after sealing a manifest without one", async () => {
    const knowledgeBaseId = "kb-upload-computed-checksum";
    const operationPublicId = "operation-upload-computed-checksum";
    const sessionPublicId = "upload-computed-checksum";
    const entryPublicId = "entry-computed-checksum";
    const checksumSha256 = "c".repeat(64);
    const objectId = `source-sha256:${checksumSha256}`;
    await seedKnowledgeBase(knowledgeBaseId);
    await sql`
      INSERT INTO focowiki.operations (
        public_id, knowledge_base_id, operation_kind, state,
        target_kind, target_public_id
      ) VALUES (
        ${operationPublicId}, ${knowledgeBaseId}, 'upload', 'processing',
        'knowledge_base', ${knowledgeBaseId}
      )
    `;
    await sql`
      INSERT INTO focowiki.upload_sessions (
        public_id, knowledge_base_id, operation_public_id, manifest_fingerprint,
        state, expected_entry_count, expected_byte_count,
        received_entry_count, received_byte_count, expires_at,
        created_at, updated_at
      ) VALUES (
        ${sessionPublicId}, ${knowledgeBaseId}, ${operationPublicId},
        ${"f".repeat(64)}, 'uploading', 1, 12, 0, 0,
        '2036-08-01T01:00:00.000Z', '2026-08-01T00:00:00.000Z',
        '2026-08-01T00:00:00.000Z'
      )
    `;
    await sql`
      INSERT INTO focowiki.upload_entries (
        upload_session_public_id, entry_public_id, knowledge_base_id,
        source_file_public_id, logical_path, normalized_path, checksum_sha256,
        byte_count, content_type, object_id, state
      ) VALUES (
        ${sessionPublicId}, ${entryPublicId}, ${knowledgeBaseId},
        'source-file-computed-checksum', 'Computed.md', 'computed.md', NULL,
        12, 'text/markdown; charset=utf-8', NULL, 'pending'
      )
    `;
    await sql`
      INSERT INTO focowiki.object_registrations (
        object_id, storage_key, checksum_sha256, byte_count, content_type,
        object_format, state, write_attempt_public_id, verified_at
      ) VALUES (
        ${objectId}, 'run-owned/source/computed-checksum.md', ${checksumSha256}, 12,
        'text/markdown; charset=utf-8', 'source-markdown-v1', 'verified',
        'write-computed-checksum', now()
      )
    `;

    await expect(repository.markEntryUploaded({
      knowledgeBaseId,
      sessionPublicId,
      entryPublicId,
      objectId,
      checksumSha256,
      byteCount: 12,
      contentType: "text/markdown; charset=utf-8"
    })).resolves.toMatchObject({
      objectId,
      checksumSha256
    });
    await expect(sql<Array<{ checksum_sha256: string; state: string }>>`
      SELECT checksum_sha256, state
      FROM focowiki.upload_entries
      WHERE upload_session_public_id = ${sessionPublicId}
        AND entry_public_id = ${entryPublicId}
    `).resolves.toEqual([{ checksum_sha256: checksumSha256, state: "verified" }]);
  });

  it("finalizes more rows than one PostgreSQL parameterized insert can carry", async () => {
    const knowledgeBaseId = "kb-upload-large-finalization";
    const sessionPublicId = "upload-large-finalization";
    const operationPublicId = "operation-upload-large-finalization";
    const entryCount = 7_500;
    const checksum = "d".repeat(64);
    const objectId = `source-sha256:${checksum}`;
    await seedKnowledgeBase(knowledgeBaseId);
    await sql`
      INSERT INTO focowiki.object_registrations (
        object_id, storage_key, checksum_sha256, byte_count, content_type,
        object_format, state, write_attempt_public_id, verified_at,
        zero_owner_since
      ) VALUES (
        ${objectId}, 'run-owned/source/large-finalization.md', ${checksum}, 1,
        'text/markdown; charset=utf-8', 'source-markdown-v1', 'verified',
        'write-large-finalization', now(), now()
      )
    `;
    await sql.begin(async (transaction) => {
      await transaction`
        INSERT INTO focowiki.operations (
          public_id, knowledge_base_id, operation_kind, state,
          target_kind, target_public_id
        ) VALUES (
          ${operationPublicId}, ${knowledgeBaseId}, 'upload', 'processing',
          'knowledge_base', ${knowledgeBaseId}
        )
      `;
      await transaction`
        INSERT INTO focowiki.operation_work_items (
          operation_public_id, knowledge_base_id, work_kind, state,
          operation_revision, settings_revision_public_id, attempt_count,
          lease_owner, lease_expires_at, checkpoint
        ) VALUES (
          ${operationPublicId}, ${knowledgeBaseId}, 'upload', 'running', 1,
          'settings-upload-integration', 1, 'upload:large-finalization',
          '2026-08-02T00:00:00.000Z', ${transaction.json({ sessionPublicId })}
        )
      `;
      await transaction`
        INSERT INTO focowiki.upload_sessions (
          public_id, knowledge_base_id, operation_public_id, manifest_fingerprint,
          state, expected_entry_count, expected_byte_count,
          received_entry_count, received_byte_count, expires_at,
          created_at, updated_at
        ) VALUES (
          ${sessionPublicId}, ${knowledgeBaseId}, ${operationPublicId},
          ${"e".repeat(64)}, 'uploading', ${entryCount}, ${entryCount},
          ${entryCount}, ${entryCount}, '2026-08-02T00:00:00.000Z',
          '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z'
        )
      `;
      await transaction.unsafe(`
        INSERT INTO focowiki.upload_entries (
          upload_session_public_id, entry_public_id, knowledge_base_id,
          source_file_public_id, logical_path, normalized_path, checksum_sha256,
          byte_count, content_type, object_id, state
        )
        SELECT
          'upload-large-finalization',
          'entry-large-' || lpad(series::text, 5, '0'),
          'kb-upload-large-finalization',
          'file-large-' || lpad(series::text, 5, '0'),
          'File-' || lpad(series::text, 5, '0') || '.md',
          'file-' || lpad(series::text, 5, '0') || '.md',
          '${checksum}', 1, 'text/markdown; charset=utf-8',
          '${objectId}', 'verified'
        FROM generate_series(1, ${entryCount}) AS series
      `);
    });

    await expect(repository.finalizeSession({
      knowledgeBaseId,
      sessionPublicId,
      completedAt: "2026-08-01T00:10:00.000Z"
    })).resolves.toMatchObject({
      outcome: "accepted",
      acceptedRevisionCount: entryCount,
      sourceWorkCount: entryCount
    });
    await expect(scopedCounts(knowledgeBaseId)).resolves.toMatchObject({
      source_files: String(entryCount),
      source_revisions: String(entryCount),
      current_revisions: String(entryCount),
      source_work: String(entryCount),
      source_owners: String(entryCount),
      owned_with_zero_owner_since: "0"
    });
  }, 120_000);

  it("rejects a competing normalized path before any body or second operation write", async () => {
    await seedKnowledgeBase("kb-upload-conflict");
    const first = manifestEntry(
      "entry-conflict-one",
      "file-conflict-one",
      "Guides/Conflict.md",
      "# One\n"
    );
    const second = manifestEntry(
      "entry-conflict-two",
      "file-conflict-two",
      "guides/conflict.md",
      "# Two\n"
    );
    await coordinator.openSession(sessionRequest(
      "conflict-one",
      "kb-upload-conflict",
      [first]
    ));
    const bodyWriteCount = bodyWriter.putVerifiedStream.mock.calls.length;
    await expect(coordinator.openSession(sessionRequest(
      "conflict-two",
      "kb-upload-conflict",
      [second]
    ))).rejects.toMatchObject({ code: "path_conflict" });
    expect(bodyWriter.putVerifiedStream).toHaveBeenCalledTimes(bodyWriteCount);
    const operations = await sql<Array<{ count: number | string }>>`
      SELECT count(*) AS count FROM focowiki.operations
      WHERE knowledge_base_id = 'kb-upload-conflict'
    `;
    expect(operations[0]?.count).toBe("1");
    await coordinator.cancelSession({
      knowledgeBaseId: "kb-upload-conflict",
      sessionPublicId: "upload-conflict-one",
      cancelledAt: "2026-08-01T00:06:00.000Z"
    });
  });

  it("finalizes an all-existing overlap without creating another revision or source work", async () => {
    const knowledgeBaseId = "kb-upload-overlap";
    await seedKnowledgeBase(knowledgeBaseId);
    const entry = manifestEntry(
      "entry-overlap-initial",
      "file-overlap-existing",
      "Guides/Existing.md",
      "# Existing\n"
    );
    await coordinator.openSession(sessionRequest("overlap-initial", knowledgeBaseId, [entry]));
    await coordinator.putEntry(putRequest(knowledgeBaseId, "overlap-initial", entry));
    await coordinator.finalizeSession({
      knowledgeBaseId,
      sessionPublicId: "upload-overlap-initial",
      completedAt: "2026-08-01T00:05:00.000Z"
    });
    const current = await sql<Array<{ object_id: string; revision: number | string }>>`
      SELECT revision.object_id, source.revision
      FROM focowiki.source_files source
      JOIN focowiki.source_file_current_revisions current_revision
        ON current_revision.knowledge_base_id = source.knowledge_base_id
       AND current_revision.source_file_public_id = source.public_id
      JOIN focowiki.source_revisions revision
        ON revision.public_id = current_revision.source_revision_public_id
      WHERE source.knowledge_base_id = ${knowledgeBaseId}
        AND source.public_id = ${entry.sourceFilePublicId}
    `;
    expect(current).toHaveLength(1);

    await sql.begin(async (transaction) => {
      await transaction`
        INSERT INTO focowiki.operations (
          public_id, knowledge_base_id, operation_kind, state,
          target_kind, target_public_id
        ) VALUES (
          'operation-upload-overlap-replay', ${knowledgeBaseId}, 'upload', 'processing',
          'knowledge_base', ${knowledgeBaseId}
        )
      `;
      await transaction`
        INSERT INTO focowiki.operation_idempotency (
          public_id, knowledge_base_id, idempotency_key, request_hash,
          operation_public_id, expires_at, created_at
        ) VALUES (
          'idempotency-upload-overlap-replay', ${knowledgeBaseId},
          'request-upload-overlap-replay', ${"b".repeat(64)},
          'operation-upload-overlap-replay', '2026-08-02T00:06:00.000Z',
          '2026-08-01T00:06:00.000Z'
        )
      `;
      await transaction`
        INSERT INTO focowiki.operation_work_items (
          operation_public_id, knowledge_base_id, work_kind, state,
          operation_revision, settings_revision_public_id, attempt_count,
          lease_owner, lease_expires_at, checkpoint
        ) VALUES (
          'operation-upload-overlap-replay', ${knowledgeBaseId}, 'upload', 'running',
          1, 'settings-upload-integration', 1, 'upload:upload-overlap-replay',
          '2026-08-02T00:06:00.000Z', ${transaction.json({
            sessionPublicId: "upload-overlap-replay"
          })}
        )
      `;
      await transaction`
        INSERT INTO focowiki.upload_sessions (
          public_id, knowledge_base_id, operation_public_id, manifest_fingerprint,
          state, expected_entry_count, expected_byte_count,
          received_entry_count, received_byte_count, expires_at, created_at, updated_at
        ) VALUES (
          'upload-overlap-replay', ${knowledgeBaseId},
          'operation-upload-overlap-replay', ${"c".repeat(64)}, 'uploading',
          1, ${entry.byteCount}, 0, 0, '2026-08-02T00:06:00.000Z',
          '2026-08-01T00:06:00.000Z', '2026-08-01T00:06:00.000Z'
        )
      `;
      await transaction`
        INSERT INTO focowiki.upload_entries (
          upload_session_public_id, entry_public_id, knowledge_base_id,
          source_file_public_id, logical_path, normalized_path, checksum_sha256,
          byte_count, content_type, object_id, state
        ) VALUES (
          'upload-overlap-replay', 'entry-overlap-replay', ${knowledgeBaseId},
          ${entry.sourceFilePublicId}, ${entry.logicalPath}, 'guides/existing.md',
          ${entry.checksumSha256}, ${entry.byteCount}, ${entry.contentType},
          ${current[0]!.object_id}, 'verified'
        )
      `;
    });

    const finalized = await repository.finalizeSession({
      knowledgeBaseId,
      sessionPublicId: "upload-overlap-replay",
      completedAt: "2026-08-01T00:07:00.000Z"
    });
    expect(finalized).toMatchObject({
      acceptedRevisionCount: 0,
      sourceWorkCount: 0
    });
    await terminal.converge({
      ...finalized.session,
      temporaryObjectIds: [],
      outcome: "completed",
      resultCode: "UPLOAD_ACCEPTED",
      completedAt: "2026-08-01T00:07:00.000Z",
      successorOperationPublicId: null
    });
    expect(await scopedCounts(knowledgeBaseId)).toMatchObject({
      source_files: "1",
      source_revisions: "1",
      current_revisions: "1",
      source_work: "1",
      operation_results: "2"
    });
  });

  it("converges partial cancellation into a result and one durable object cleanup", async () => {
    await seedKnowledgeBase("kb-upload-cancel");
    const entry = manifestEntry(
      "entry-cancel",
      "file-cancel",
      "Cancel.md",
      "# Cancel\n"
    );
    await coordinator.openSession(sessionRequest("cancel", "kb-upload-cancel", [entry]));
    await coordinator.putEntry(putRequest("kb-upload-cancel", "cancel", entry));
    await coordinator.cancelSession({
      knowledgeBaseId: "kb-upload-cancel",
      sessionPublicId: "upload-cancel",
      cancelledAt: "2026-08-01T00:10:00.000Z"
    });

    expect(await scopedCounts("kb-upload-cancel")).toMatchObject({
      upload_sessions: "0",
      upload_entries: "0",
      upload_reservations: "0",
      source_files: "0",
      source_work: "0",
      live_owners: "0",
      operation_results: "1",
      cleanup_actions: "1",
      zero_owner_objects: "1"
    });
    const result = await sql<Array<{ terminal_state: string; result_code: string }>>`
      SELECT terminal_state, result_code FROM focowiki.operation_results
      WHERE knowledge_base_id = 'kb-upload-cancel'
    `;
    expect(result[0]).toEqual({
      terminal_state: "cancelled",
      result_code: "UPLOAD_CANCELLED"
    });
  });

  it("closes a finalization path conflict and releases the uploaded object", async () => {
    await seedKnowledgeBase("kb-upload-finalize-conflict");
    const entry = manifestEntry(
      "entry-finalize-conflict",
      "file-finalize-conflict",
      "Conflict.md",
      "# Upload conflict\n"
    );
    await coordinator.openSession(sessionRequest(
      "finalize-conflict",
      "kb-upload-finalize-conflict",
      [entry]
    ));
    await coordinator.putEntry(putRequest(
      "kb-upload-finalize-conflict",
      "finalize-conflict",
      entry
    ));
    await sql`
      INSERT INTO focowiki.source_files (
        public_id, knowledge_base_id, directory_public_id, logical_path,
        normalized_path, title, metadata, status, revision
      ) VALUES (
        'file-competing-current', 'kb-upload-finalize-conflict', NULL,
        'Conflict.md', 'conflict.md', 'Conflict', '{}'::jsonb, 'ready', 1
      )
    `;

    await expect(coordinator.finalizeSession({
      knowledgeBaseId: "kb-upload-finalize-conflict",
      sessionPublicId: "upload-finalize-conflict",
      completedAt: "2026-08-01T00:12:00.000Z"
    })).rejects.toMatchObject({ code: "path_conflict" });
    expect(await scopedCounts("kb-upload-finalize-conflict")).toMatchObject({
      upload_sessions: "0",
      upload_entries: "0",
      upload_reservations: "0",
      source_files: "1",
      source_revisions: "0",
      source_work: "0",
      live_owners: "0",
      operation_results: "1",
      cleanup_actions: "1",
      zero_owner_objects: "1"
    });
    const results = await sql<Array<{ terminal_state: string; result_code: string }>>`
      SELECT terminal_state, result_code FROM focowiki.operation_results
      WHERE knowledge_base_id = 'kb-upload-finalize-conflict'
    `;
    expect(results).toEqual([{
      terminal_state: "failed",
      result_code: "UPLOAD_FINALIZATION_CONFLICT"
    }]);
  });

  it("supersedes one uploaded session with a durable successor identity", async () => {
    await seedKnowledgeBase("kb-upload-superseded");
    const entry = manifestEntry(
      "entry-superseded",
      "file-superseded",
      "Superseded.md",
      "# Superseded\n"
    );
    await coordinator.openSession(sessionRequest(
      "superseded",
      "kb-upload-superseded",
      [entry]
    ));
    await coordinator.putEntry(putRequest("kb-upload-superseded", "superseded", entry));

    await coordinator.supersedeSession({
      knowledgeBaseId: "kb-upload-superseded",
      sessionPublicId: "upload-superseded",
      successorOperationPublicId: "operation-upload-successor",
      supersededAt: "2026-08-01T00:15:00.000Z"
    });

    expect(await scopedCounts("kb-upload-superseded")).toMatchObject({
      upload_sessions: "0",
      upload_entries: "0",
      upload_reservations: "0",
      source_files: "0",
      source_work: "0",
      live_owners: "0",
      operation_results: "1",
      cleanup_actions: "1",
      zero_owner_objects: "1"
    });
    const results = await sql<Array<{
      terminal_state: string;
      result_code: string;
      successor_operation_public_id: string | null;
    }>>`
      SELECT terminal_state, result_code,
             result_summary->>'successorOperationPublicId' AS successor_operation_public_id
      FROM focowiki.operation_results
      WHERE knowledge_base_id = 'kb-upload-superseded'
    `;
    expect(results).toEqual([{
      terminal_state: "superseded",
      result_code: "UPLOAD_SUPERSEDED",
      successor_operation_public_id: "operation-upload-successor"
    }]);
  });

  it("expires a bounded session page and removes all live upload state", async () => {
    await seedKnowledgeBase("kb-upload-expire");
    const entry = manifestEntry(
      "entry-expire",
      "file-expire",
      "Expire.md",
      "# Expire\n"
    );
    await coordinator.openSession(sessionRequest("expire", "kb-upload-expire", [entry]));

    await expect(coordinator.expireSessions({
      expiredBefore: "2026-08-01T02:00:00.000Z",
      limit: 1
    })).resolves.toBe(1);
    expect(await scopedCounts("kb-upload-expire")).toMatchObject({
      upload_sessions: "0",
      upload_entries: "0",
      upload_reservations: "0",
      source_files: "0",
      operation_results: "1"
    });
  });

  it("lets knowledge-base deletion supersede all live sessions without file fan-out", async () => {
    await seedKnowledgeBase("kb-upload-delete");
    await coordinator.openSession(sessionRequest("delete-one", "kb-upload-delete", [
      manifestEntry("entry-delete-one", "file-delete-one", "One.md", "# One\n")
    ]));
    await coordinator.openSession(sessionRequest("delete-two", "kb-upload-delete", [
      manifestEntry("entry-delete-two", "file-delete-two", "Two.md", "# Two\n")
    ]));

    await expect(coordinator.cancelKnowledgeBaseSessions({
      knowledgeBaseId: "kb-upload-delete",
      deletionOperationPublicId: "operation-delete-kb-upload",
      deletedAt: "2026-08-01T00:20:00.000Z",
      limit: 10
    })).resolves.toBe(2);
    expect(await scopedCounts("kb-upload-delete")).toMatchObject({
      upload_sessions: "0",
      upload_entries: "0",
      upload_reservations: "0",
      source_files: "0",
      source_work: "0",
      operation_results: "2"
    });
    const results = await sql<Array<{ terminal_state: string; result_code: string }>>`
      SELECT terminal_state, result_code FROM focowiki.operation_results
      WHERE knowledge_base_id = 'kb-upload-delete'
      ORDER BY public_id
    `;
    expect(results).toEqual([
      { terminal_state: "deleted", result_code: "KNOWLEDGE_BASE_DELETED" },
      { terminal_state: "deleted", result_code: "KNOWLEDGE_BASE_DELETED" }
    ]);
  });

  it("replays a terminal upload session after live upload rows are retired", async () => {
    const knowledgeBaseId = "kb-upload-terminal-replay";
    const requestHash = "d".repeat(64);
    await seedKnowledgeBase(knowledgeBaseId);
    await sql.begin(async (transaction) => {
      await transaction`
        INSERT INTO focowiki.operations (
          public_id, knowledge_base_id, operation_kind, state,
          target_kind, target_public_id, completed_at
        ) VALUES (
          'operation-upload-terminal-replay', ${knowledgeBaseId}, 'upload', 'completed',
          'knowledge_base', ${knowledgeBaseId}, '2026-08-01T00:10:00.000Z'
        )
      `;
      await transaction`
        INSERT INTO focowiki.operation_idempotency (
          public_id, knowledge_base_id, idempotency_key, request_hash,
          operation_public_id, expires_at, created_at
        ) VALUES (
          'idempotency-upload-terminal-replay', ${knowledgeBaseId},
          'request-upload-terminal-replay', ${requestHash},
          'operation-upload-terminal-replay', '2026-08-02T00:10:00.000Z',
          '2026-08-01T00:00:00.000Z'
        )
      `;
      await transaction`
        INSERT INTO focowiki.operation_results (
          public_id, knowledge_base_id, operation_kind, terminal_state,
          result_code, result_summary, correlation_public_id,
          completed_at, expires_at
        ) VALUES (
          'operation-upload-terminal-replay', ${knowledgeBaseId}, 'upload', 'completed',
          'UPLOAD_COMPLETED', ${transaction.json({ expectedEntryCount: 1 })},
          'upload-terminal-replay', '2026-08-01T00:10:00.000Z',
          '2026-08-02T00:10:00.000Z'
        )
      `;
    });

    await expect(sql.begin((transaction) => findIdempotentUploadSession(transaction, {
      knowledgeBaseId,
      idempotencyKey: "request-upload-terminal-replay",
      requestHash
    }))).resolves.toBe("upload-terminal-replay");
  });

  async function seedKnowledgeBase(knowledgeBaseId: string): Promise<void> {
    await sql`
      INSERT INTO focowiki.knowledge_bases (public_id, name, revision)
      VALUES (${knowledgeBaseId}, ${`Knowledge base ${knowledgeBaseId}`}, 1)
    `;
  }

  async function scopedCounts(knowledgeBaseId: string) {
    const rows = await sql<Array<Record<string, number | string>>[]>`
      SELECT
        (SELECT count(*) FROM focowiki.upload_sessions
         WHERE knowledge_base_id = ${knowledgeBaseId}) AS upload_sessions,
        (SELECT count(*) FROM focowiki.upload_entries
         WHERE knowledge_base_id = ${knowledgeBaseId}) AS upload_entries,
        (SELECT count(*) FROM focowiki.upload_path_reservations
         WHERE knowledge_base_id = ${knowledgeBaseId}) AS upload_reservations,
        (SELECT count(*) FROM focowiki.operation_work_items
         WHERE knowledge_base_id = ${knowledgeBaseId} AND work_kind = 'upload') AS upload_work,
        (SELECT count(*) FROM focowiki.operation_results
         WHERE knowledge_base_id = ${knowledgeBaseId}) AS operation_results,
        (SELECT count(*) FROM focowiki.source_files
         WHERE knowledge_base_id = ${knowledgeBaseId}) AS source_files,
        (SELECT count(*) FROM focowiki.source_revisions
         WHERE knowledge_base_id = ${knowledgeBaseId}) AS source_revisions,
        (SELECT count(*) FROM focowiki.source_file_current_revisions
         WHERE knowledge_base_id = ${knowledgeBaseId}) AS current_revisions,
        (SELECT count(*) FROM focowiki.operation_work_items
         WHERE knowledge_base_id = ${knowledgeBaseId} AND work_kind = 'source') AS source_work,
        (SELECT count(DISTINCT registration.object_id)
         FROM focowiki.object_registrations registration
         JOIN focowiki.source_revisions revision ON revision.object_id = registration.object_id
         WHERE revision.knowledge_base_id = ${knowledgeBaseId}) AS object_registrations,
        (SELECT count(*) FROM focowiki.object_owners
         WHERE knowledge_base_id = ${knowledgeBaseId}
           AND owner_kind = 'source_revision') AS source_owners,
        (SELECT count(*) FROM focowiki.object_owners
         WHERE knowledge_base_id = ${knowledgeBaseId}
           AND owner_kind = 'live_reservation') AS live_owners,
        (SELECT count(DISTINCT registration.object_id)
         FROM focowiki.object_registrations registration
         JOIN focowiki.object_owners owner ON owner.object_id = registration.object_id
         WHERE owner.knowledge_base_id = ${knowledgeBaseId}
           AND registration.zero_owner_since IS NOT NULL)
          AS owned_with_zero_owner_since,
        (SELECT count(*) FROM focowiki.search_projections
         WHERE knowledge_base_id = ${knowledgeBaseId}) AS search_projections,
        (SELECT count(*) FROM focowiki.cleanup_actions
         WHERE knowledge_base_id = ${knowledgeBaseId}) AS cleanup_actions,
        (SELECT count(DISTINCT registration.object_id)
         FROM focowiki.object_registrations registration
         JOIN focowiki.cleanup_actions cleanup
           ON cleanup.resource_public_id = registration.object_id
          AND cleanup.knowledge_base_id = ${knowledgeBaseId}
          AND cleanup.resource_kind = 'temporary_object'
         LEFT JOIN focowiki.object_owners owner ON owner.object_id = registration.object_id
         WHERE registration.zero_owner_since IS NOT NULL AND owner.object_id IS NULL)
           AS zero_owner_objects
    `;
    return rows[0]!;
  }
});

function createDatabaseBackedBodyWriter(sql: postgres.Sql) {
  return {
    putVerifiedStream: vi.fn(async (input: {
      body: AsyncIterable<Uint8Array>;
      checksumSha256: string;
      byteCount: number;
      contentType: string;
      writeAttemptPublicId: string;
    }) => {
      const chunks: Uint8Array[] = [];
      for await (const chunk of input.body) chunks.push(chunk);
      const bytes = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
      if (
        bytes.byteLength !== input.byteCount
        || createHash("sha256").update(bytes).digest("hex") !== input.checksumSha256
      ) throw new Error("Body verification failed");
      const objectId = `source-sha256:${input.checksumSha256}`;
      const inserted = await sql<Array<{ object_id: string }>>`
        INSERT INTO focowiki.object_registrations (
          object_id, storage_key, checksum_sha256, byte_count, content_type,
          object_format, state, write_attempt_public_id, verified_at,
          zero_owner_since, created_at
        ) VALUES (
          ${objectId}, ${`run-owned/source/${input.checksumSha256}.md`},
          ${input.checksumSha256}, ${input.byteCount}, ${input.contentType},
          'source-markdown-v1', 'verified', ${input.writeAttemptPublicId}, now(),
          now(), now()
        )
        ON CONFLICT (object_id) DO NOTHING
        RETURNING object_id
      `;
      return {
        outcome: inserted[0] ? "stored" as const : "reused" as const,
        objectId,
        checksumSha256: input.checksumSha256,
        byteCount: input.byteCount,
        contentType: input.contentType
      };
    })
  };
}

function sessionRequest(
  suffix: string,
  knowledgeBaseId: string,
  entries: readonly ReturnType<typeof manifestEntry>[]
) {
  return {
    knowledgeBaseId,
    operationPublicId: `operation-upload-${suffix}`,
    sessionPublicId: `upload-${suffix}`,
    idempotencyKey: `request-upload-${suffix}`,
    settingsRevisionPublicId: "settings-upload-integration",
    entries,
    createdAt: "2026-08-01T00:00:00.000Z",
    expiresAt: "2026-08-01T01:00:00.000Z"
  };
}

function manifestEntry(
  entryPublicId: string,
  sourceFilePublicId: string,
  logicalPath: string,
  body: string
) {
  const bytes = Buffer.from(body, "utf8");
  return {
    entryPublicId,
    sourceFilePublicId,
    logicalPath,
    byteCount: bytes.byteLength,
    checksumSha256: createHash("sha256").update(bytes).digest("hex"),
    contentType: "text/markdown; charset=utf-8",
    body
  };
}

function putRequest(
  knowledgeBaseId: string,
  suffix: string,
  entry: ReturnType<typeof manifestEntry>
) {
  return {
    knowledgeBaseId,
    sessionPublicId: `upload-${suffix}`,
    entryPublicId: entry.entryPublicId,
    body: chunks(entry.body)
  };
}

async function* chunks(body: string): AsyncGenerator<Uint8Array> {
  yield Buffer.from(body, "utf8");
}

function databaseConnectionUrl(connectionUrl: string, databaseName: string): string {
  const url = new URL(connectionUrl);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}
