import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createPostgresWorkerJobRepository } from "../src/db/worker-job-repository.js";

const databaseUrl = process.env.FOCOWIKI_TEST_DATABASE_URL;
const describeDatabase = databaseUrl ? describe : describe.skip;

describeDatabase("worker job repository integration", () => {
  const sql = postgres(databaseUrl!, { max: 2 });
  const repository = createPostgresWorkerJobRepository(sql);
  const knowledgeBaseId = "kb-worker-publication-follow-up";

  beforeAll(async () => {
    await cleanup();
    await sql`
      INSERT INTO focowiki.knowledge_bases (id, name)
      VALUES (${knowledgeBaseId}, 'Worker publication follow-up')
    `;
  });

  afterAll(async () => {
    await cleanup();
    await sql.end({ timeout: 5 });
  });

  it("queues one required empty publication behind a running ordinary publication", async () => {
    await sql`
      INSERT INTO focowiki.worker_jobs (
        id, kind, status, knowledge_base_id, payload_json,
        run_after, max_attempts, locked_by, locked_at
      ) VALUES (
        'worker-job-running-publication', 'publication', 'running',
        ${knowledgeBaseId}, ${sql.json({ reason: "per_file" })},
        now(), 3, 'worker-integration', now()
      )
    `;

    const deletion = await repository.enqueuePublicationJob({
      knowledgeBaseId,
      reason: "deletion",
      runAfter: new Date().toISOString(),
      maxAttempts: 3
    });
    expect(deletion.status).toBe("queued");
    expect(deletion.payload).toEqual({ reason: "deletion" });

    const metadata = await repository.enqueuePublicationJob({
      knowledgeBaseId,
      reason: "metadata",
      runAfter: new Date().toISOString(),
      maxAttempts: 3
    });
    const replayedDeletion = await repository.enqueuePublicationJob({
      knowledgeBaseId,
      reason: "deletion",
      runAfter: new Date().toISOString(),
      maxAttempts: 3
    });

    expect(metadata.id).toBe(deletion.id);
    expect(metadata.payload).toEqual({ reason: "deletion" });
    expect(replayedDeletion.id).toBe(deletion.id);

    const rows = await sql<Array<{ status: string; reason: string }>>`
      SELECT status, payload_json->>'reason' AS reason
      FROM focowiki.worker_jobs
      WHERE knowledge_base_id = ${knowledgeBaseId}
        AND kind = 'publication'
        AND status IN ('queued', 'running')
      ORDER BY status ASC
    `;
    expect(rows).toEqual([
      { status: "queued", reason: "deletion" },
      { status: "running", reason: "per_file" }
    ]);
  });

  async function cleanup(): Promise<void> {
    await sql`DELETE FROM focowiki.worker_jobs WHERE knowledge_base_id = ${knowledgeBaseId}`;
    await sql`DELETE FROM focowiki.knowledge_bases WHERE id = ${knowledgeBaseId}`;
  }
});
