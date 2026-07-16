import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

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
    await sql`
      UPDATE focowiki.knowledge_bases
      SET catalog_generation = 20
      WHERE id = ${knowledgeBaseId}
    `;
  });

  beforeEach(async () => {
    await sql`DELETE FROM focowiki.worker_jobs WHERE knowledge_base_id = ${knowledgeBaseId}`;
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
        ${knowledgeBaseId}, ${sql.json({ reason: "per_file", targetCatalogGeneration: 5 })},
        now(), 3, 'worker-integration', now()
      )
    `;

    const deletion = await repository.enqueuePublicationJob({
      knowledgeBaseId,
      reason: "deletion",
      targetCatalogGeneration: 6,
      runAfter: new Date().toISOString(),
      maxAttempts: 3
    });
    expect(deletion.status).toBe("queued");
    expect(deletion.payload).toEqual({ reason: "deletion", targetCatalogGeneration: 6 });

    const metadata = await repository.enqueuePublicationJob({
      knowledgeBaseId,
      reason: "metadata",
      targetCatalogGeneration: 8,
      runAfter: new Date().toISOString(),
      maxAttempts: 3
    });
    const replayedDeletion = await repository.enqueuePublicationJob({
      knowledgeBaseId,
      reason: "deletion",
      targetCatalogGeneration: 7,
      runAfter: new Date().toISOString(),
      maxAttempts: 3
    });

    expect(metadata.id).toBe(deletion.id);
    expect(metadata.payload).toEqual({ reason: "deletion", targetCatalogGeneration: 8 });
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

  it("reuses a running publication that already covers the requested generation", async () => {
    await sql`
      INSERT INTO focowiki.worker_jobs (
        id, kind, status, knowledge_base_id, payload_json,
        run_after, max_attempts, locked_by, locked_at
      ) VALUES (
        'worker-job-running-covering', 'publication', 'running',
        ${knowledgeBaseId}, ${sql.json({ reason: "manual", targetCatalogGeneration: 12 })},
        now(), 3, 'worker-integration', now()
      )
    `;

    const job = await repository.enqueuePublicationJob({
      knowledgeBaseId,
      reason: "metadata",
      targetCatalogGeneration: 10,
      runAfter: new Date().toISOString(),
      maxAttempts: 3
    });

    expect(job.id).toBe("worker-job-running-covering");
    const queued = await sql<Array<{ count: number }>>`
      SELECT count(*)::int AS count
      FROM focowiki.worker_jobs
      WHERE knowledge_base_id = ${knowledgeBaseId}
        AND kind = 'publication'
        AND status = 'queued'
    `;
    expect(queued[0]?.count).toBe(0);
  });

  it("queues a forced interactive successor behind the same target generation snapshot", async () => {
    await sql`
      INSERT INTO focowiki.worker_jobs (
        id, kind, status, knowledge_base_id, payload_json,
        run_after, max_attempts, locked_by, locked_at
      ) VALUES (
        'worker-job-running-interactive-snapshot', 'publication', 'running',
        ${knowledgeBaseId}, ${sql.json({ reason: "manual", targetCatalogGeneration: 12 })},
        now(), 3, 'worker-integration', now()
      )
    `;
    const runAfter = new Date().toISOString();

    const successor = await repository.enqueuePublicationJob({
      knowledgeBaseId,
      reason: "manual",
      targetCatalogGeneration: 12,
      runAfter,
      maxAttempts: 3,
      forceSuccessor: true
    });

    expect(successor.status).toBe("queued");
    expect(successor.id).not.toBe("worker-job-running-interactive-snapshot");
    expect(successor.payload).toEqual({ reason: "manual", targetCatalogGeneration: 12 });
    expect(successor.runAfter).toBe(runAfter);
  });

  it("coalesces concurrent uncovered generations into one immediate successor", async () => {
    await sql`
      INSERT INTO focowiki.worker_jobs (
        id, kind, status, knowledge_base_id, payload_json,
        run_after, max_attempts, locked_by, locked_at
      ) VALUES (
        'worker-job-running-old', 'publication', 'running',
        ${knowledgeBaseId}, ${sql.json({ reason: "per_file", targetCatalogGeneration: 3 })},
        now(), 3, 'worker-integration', now()
      )
    `;
    const immediate = new Date().toISOString();
    const jobs = await Promise.all(
      [4, 9, 6, 14, 11].map((targetCatalogGeneration) =>
        repository.enqueuePublicationJob({
          knowledgeBaseId,
          reason: "manual",
          targetCatalogGeneration,
          runAfter: immediate,
          maxAttempts: 3
        })
      )
    );

    expect(new Set(jobs.map((job) => job.id)).size).toBe(1);
    const queued = await sql<Array<{ payload_json: Record<string, unknown>; run_after: Date }>>`
      SELECT payload_json, run_after
      FROM focowiki.worker_jobs
      WHERE knowledge_base_id = ${knowledgeBaseId}
        AND kind = 'publication'
        AND status = 'queued'
    `;
    expect(queued).toHaveLength(1);
    expect(queued[0]?.payload_json).toEqual({
      reason: "manual",
      targetCatalogGeneration: 14
    });
    expect(queued[0]?.run_after.toISOString()).toBe(immediate);
  });

  it("keeps the queued successor when a running publication requests a retry", async () => {
    await insertPublicationJobs({
      runningTarget: 5,
      runningReason: "manual",
      queuedTarget: 9,
      queuedReason: "metadata"
    });
    const retryAfter = "2026-06-18T00:00:00.000Z";

    const retry = await repository.failWorkerJob({
      id: "worker-job-running-transition",
      workerId: "worker-integration",
      failedAt: new Date().toISOString(),
      errorCode: "PUBLICATION_FAILED",
      errorMessage: "Publication failed.",
      retryAfter
    });

    expect(retry?.id).toBe("worker-job-queued-transition");
    expect(retry?.payload).toEqual({ reason: "metadata", targetCatalogGeneration: 9 });
    const states = await readTransitionStates();
    expect(states).toEqual([
      { id: "worker-job-queued-transition", status: "queued" },
      { id: "worker-job-running-transition", status: "failed" }
    ]);
  });

  it("merges a released running publication into its queued successor", async () => {
    await insertPublicationJobs({
      runningTarget: 12,
      runningReason: "deletion",
      queuedTarget: 9,
      queuedReason: "manual"
    });

    const released = await repository.releaseWorkerJob({
      id: "worker-job-running-transition",
      workerId: "worker-integration",
      releasedAt: new Date().toISOString(),
      runAfter: "2026-06-18T00:00:00.000Z",
      preserveAttempt: true
    });

    expect(released?.id).toBe("worker-job-queued-transition");
    expect(released?.payload).toEqual({ reason: "deletion", targetCatalogGeneration: 12 });
    const states = await readTransitionStates();
    expect(states).toEqual([
      { id: "worker-job-queued-transition", status: "queued" },
      { id: "worker-job-running-transition", status: "cancelled" }
    ]);
  });

  it("does not claim a queued successor while the previous publication is running", async () => {
    await insertPublicationJobs({
      runningTarget: 5,
      runningReason: "manual",
      queuedTarget: 9,
      queuedReason: "metadata"
    });

    const blocked = await repository.claimWorkerJobs({
      workerId: "worker-second",
      kinds: ["publication"],
      limit: 1,
      now: new Date().toISOString(),
      staleBefore: "2020-01-01T00:00:00.000Z"
    });
    expect(blocked).toEqual([]);

    await sql`
      UPDATE focowiki.worker_jobs
      SET status = 'completed', locked_by = NULL, locked_at = NULL,
          heartbeat_at = NULL, completed_at = GREATEST(now(), started_at)
      WHERE id = 'worker-job-running-transition'
    `;
    const claimed = await repository.claimWorkerJobs({
      workerId: "worker-second",
      kinds: ["publication"],
      limit: 1,
      now: new Date(Date.now() + 10 * 60 * 1_000).toISOString(),
      staleBefore: "2020-01-01T00:00:00.000Z"
    });
    expect(claimed.map((job) => job.id)).toEqual(["worker-job-queued-transition"]);
  });

  async function insertPublicationJobs(input: {
    runningTarget: number;
    runningReason: string;
    queuedTarget: number;
    queuedReason: string;
  }): Promise<void> {
    await sql`
      INSERT INTO focowiki.worker_jobs (
        id, kind, status, knowledge_base_id, payload_json,
        run_after, max_attempts, locked_by, locked_at, started_at
      ) VALUES
        (
          'worker-job-running-transition', 'publication', 'running', ${knowledgeBaseId},
          ${sql.json({ reason: input.runningReason, targetCatalogGeneration: input.runningTarget })},
          now(), 3, 'worker-integration', now(), now()
        ),
        (
          'worker-job-queued-transition', 'publication', 'queued', ${knowledgeBaseId},
          ${sql.json({ reason: input.queuedReason, targetCatalogGeneration: input.queuedTarget })},
          now() + interval '5 minutes', 3, NULL, NULL, NULL
        )
    `;
  }

  async function readTransitionStates(): Promise<Array<{ id: string; status: string }>> {
    return sql<Array<{ id: string; status: string }>>`
      SELECT id, status
      FROM focowiki.worker_jobs
      WHERE id IN ('worker-job-running-transition', 'worker-job-queued-transition')
      ORDER BY id ASC
    `;
  }

  async function cleanup(): Promise<void> {
    await sql`DELETE FROM focowiki.worker_jobs WHERE knowledge_base_id = ${knowledgeBaseId}`;
    await sql`DELETE FROM focowiki.knowledge_bases WHERE id = ${knowledgeBaseId}`;
  }
});
