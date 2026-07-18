import { createHash } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { normalizeSourceRelativePath } from "../src/domain/source-path.js";
import { createPostgresSourceDispatchRepository } from "../src/infrastructure/postgres/source-dispatch-repository.js";
import { createPostgresUploadSessionRepository } from "../src/infrastructure/postgres/upload-session-repository.js";

const databaseUrl = process.env.FOCOWIKI_TEST_DATABASE_URL;
const describeDatabase = databaseUrl ? describe : describe.skip;

describeDatabase("source dispatch repository integration", () => {
  const sql = postgres(databaseUrl!, { max: 4 });
  const uploads = createPostgresUploadSessionRepository(sql);
  const dispatcher = createPostgresSourceDispatchRepository(sql);
  const knowledgeBaseId = "kb-source-dispatch-integration";
  const pressure = {
    hard: {
      sourceQueueDepth: 2,
      oldestSourceQueueAgeSeconds: 3_600,
      dirtyFileCount: 100,
      oldestDirtyAgeSeconds: 3_600,
      pendingImpactCount: 100
    },
    resume: {
      sourceQueueDepth: 0,
      oldestSourceQueueAgeSeconds: 60,
      dirtyFileCount: 10,
      oldestDirtyAgeSeconds: 60,
      pendingImpactCount: 10
    }
  };

  beforeAll(async () => {
    await cleanup();
    await sql`
      INSERT INTO focowiki.knowledge_bases (id, name)
      VALUES (${knowledgeBaseId}, 'Source dispatch integration')
    `;
    for (let index = 0; index < 3; index += 1) {
      await registerSource(index);
    }
  });

  afterAll(async () => {
    await cleanup();
    await sql.end({ timeout: 5 });
  });

  it("dispatches deterministically, pauses at hard pressure, and resumes below low water", async () => {
    const first = await dispatcher.dispatchPending({
      dispatcherId: "dispatcher-a",
      now: new Date().toISOString(),
      batchSize: 2,
      maxAttempts: 3,
      settingsSnapshot: { sourceConcurrency: 2 },
      pressure
    });
    expect(first).toMatchObject({ paused: false, dispatchedCount: 2, pendingMarkerCount: 1 });

    const dispatchedSources = await sql<Array<{ source_file_id: string }>>`
      SELECT source_file_id
      FROM focowiki.role_jobs
      WHERE knowledge_base_id = ${knowledgeBaseId} AND role = 'source'
      ORDER BY created_at ASC, id ASC
    `;
    expect(dispatchedSources.map((row) => row.source_file_id).sort()).toEqual([
      "source-file-dispatch-0",
      "source-file-dispatch-1"
    ]);

    const paused = await dispatcher.dispatchPending({
      dispatcherId: "dispatcher-b",
      now: new Date().toISOString(),
      batchSize: 10,
      maxAttempts: 3,
      settingsSnapshot: { sourceConcurrency: 2 },
      pressure
    });
    expect(paused).toMatchObject({
      paused: true,
      reason: "sourceQueueDepth",
      dispatchedCount: 0,
      pendingMarkerCount: 1
    });

    await sql`
      UPDATE focowiki.role_jobs
      SET status = 'completed', completed_at = now(), updated_at = now()
      WHERE knowledge_base_id = ${knowledgeBaseId} AND role = 'source'
    `;
    const resumed = await dispatcher.dispatchPending({
      dispatcherId: "dispatcher-c",
      now: new Date().toISOString(),
      batchSize: 10,
      maxAttempts: 3,
      settingsSnapshot: { sourceConcurrency: 2 },
      pressure
    });
    expect(resumed).toMatchObject({ paused: false, dispatchedCount: 1, pendingMarkerCount: 0 });

    const replay = await dispatcher.dispatchPending({
      dispatcherId: "dispatcher-d",
      now: new Date().toISOString(),
      batchSize: 10,
      maxAttempts: 3,
      settingsSnapshot: { sourceConcurrency: 2 },
      pressure
    });
    expect(replay.dispatchedCount).toBe(0);
    const counts = await sql<Array<{ markers: number; jobs: number; distinct_revisions: number }>>`
      SELECT
        (SELECT count(*)::int FROM focowiki.source_dispatch_markers
         WHERE knowledge_base_id = ${knowledgeBaseId} AND status = 'dispatched') AS markers,
        (SELECT count(*)::int FROM focowiki.role_jobs
         WHERE knowledge_base_id = ${knowledgeBaseId} AND role = 'source') AS jobs,
        (SELECT count(DISTINCT source_revision_id)::int FROM focowiki.role_jobs
         WHERE knowledge_base_id = ${knowledgeBaseId} AND role = 'source') AS distinct_revisions
    `;
    expect(counts[0]).toEqual({ markers: 3, jobs: 3, distinct_revisions: 3 });
  });

  async function registerSource(index: number) {
    const sessionId = `upload-session-dispatch-${index}`;
    const entryId = `upload-entry-dispatch-${index}`;
    const sourceFileId = `source-file-dispatch-${index}`;
    const content = `# Dispatch ${index}`;
    const checksum = createHash("sha256").update(content).digest("hex");
    await uploads.createSession({
      id: sessionId,
      knowledgeBaseId,
      idempotencyKey: `dispatch-${index}`,
      declaredFileCount: 1,
      declaredByteCount: Buffer.byteLength(content),
      expiresAt: new Date(Date.now() + 60_000).toISOString()
    });
    await uploads.addManifestEntries({
      knowledgeBaseId,
      sessionId,
      entries: [{
        id: entryId,
        sourceFileId,
        path: normalizeSourceRelativePath(`docs/file-${index}.md`),
        declaredSize: Buffer.byteLength(content),
        checksumSha256: checksum
      }]
    });
    await uploads.sealManifest({
      knowledgeBaseId,
      sessionId,
      manifestFingerprint: checksum
    });
    await uploads.markEntryUploaded({
      knowledgeBaseId,
      sessionId,
      entryId,
      stagingObjectKey: `test/${entryId}.md`,
      receivedSize: Buffer.byteLength(content),
      receivedChecksumSha256: checksum
    });
    await uploads.finalizeSession({
      knowledgeBaseId,
      sessionId,
      now: new Date().toISOString()
    });
  }

  async function cleanup() {
    await sql.begin(async (transaction) => {
      await transaction`DELETE FROM focowiki.dispatch_pressure_state WHERE scope = 'global'`;
      await transaction`DELETE FROM focowiki.role_jobs WHERE knowledge_base_id = ${knowledgeBaseId}`;
      await transaction`DELETE FROM focowiki.source_dispatch_markers WHERE knowledge_base_id = ${knowledgeBaseId}`;
      await transaction`DELETE FROM focowiki.upload_sessions WHERE knowledge_base_id = ${knowledgeBaseId}`;
      await transaction`DELETE FROM focowiki.source_files WHERE knowledge_base_id = ${knowledgeBaseId}`;
      await transaction`DELETE FROM focowiki.source_directories WHERE knowledge_base_id = ${knowledgeBaseId}`;
      await transaction`DELETE FROM focowiki.knowledge_bases WHERE id = ${knowledgeBaseId}`;
    });
  }
});
