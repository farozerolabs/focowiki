import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DatabaseClient } from "../src/db/client.js";
import {
  createPostgresStorageVnextAuditRepository
} from "../src/storage-vnext/audit/postgres-repository.js";
import type { StorageVnextSecurityAuditEvent } from "../src/storage-vnext/audit/ports.js";
import {
  createPostgresStorageVnextWorkflowRepository
} from "../src/storage-vnext/workflow/postgres-repository.js";
import type {
  StorageVnextBoundedResult,
  StorageVnextLiveWork
} from "../src/storage-vnext/workflow/ports.js";

const databaseUrl = process.env.FOCOWIKI_STORAGE_VNEXT_TEST_DATABASE_URL;
const runOwner = process.env.FOCOWIKI_STORAGE_VNEXT_TEST_RUN_OWNER;
const hasOwnedTarget = Boolean(
  databaseUrl
  && runOwner
  && /^svnext-[a-z0-9]{8,16}$/u.test(runOwner)
);
const describeOwnedDatabase = hasOwnedTarget ? describe : describe.skip;

describeOwnedDatabase("storage vNext workflow and audit PostgreSQL repositories", () => {
  const connectionUrl = databaseUrl
    ?? "postgres://unused:unused@127.0.0.1:5432/unused";
  const ownerToken = (runOwner ?? "invalid").replaceAll("-", "_");
  const databaseName = `focowiki_vnext_workflow_${ownerToken}_${
    randomUUID().replaceAll("-", "").slice(0, 10)
  }`;
  const admin = postgres(databaseConnectionUrl(connectionUrl, "postgres"), { max: 1 });
  const sql = postgres(databaseConnectionUrl(connectionUrl, databaseName), { max: 4 });
  const database = sql as unknown as DatabaseClient;
  const workflow = createPostgresStorageVnextWorkflowRepository(database);
  const audit = createPostgresStorageVnextAuditRepository(database);
  let databaseCreated = false;

  beforeAll(async () => {
    await admin.unsafe(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
    databaseCreated = true;
    await sql.unsafe(readFileSync(
      resolve(import.meta.dirname, "../migrations/001_storage_vnext.sql"),
      "utf8"
    ));
    await sql`
      INSERT INTO focowiki.knowledge_bases (public_id, name, revision)
      VALUES ('kb-workflow', 'Workflow knowledge base', 1)
    `;
    await sql`
      INSERT INTO focowiki.runtime_setting_revisions
        (public_id, checksum_sha256, settings_values)
      VALUES ('settings-workflow', ${"a".repeat(64)}, '{}'::jsonb)
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

  it("converges idempotent live work into one bounded terminal product result", async () => {
    const now = Date.now();
    const requestHash = "b".repeat(64);
    const work = liveWork("operation-one", "request-one", requestHash, now);
    await expect(workflow.enqueue(work)).resolves.toMatchObject({
      type: "live",
      work: { publicId: "operation-one", state: "queued" }
    });
    await expect(workflow.enqueue({ ...work, publicId: "operation-replay" }))
      .resolves.toMatchObject({
        type: "live",
        work: { publicId: "operation-one" }
      });
    await expect(workflow.enqueue({
      ...work,
      publicId: "operation-conflict",
      idempotency: { ...work.idempotency, requestHash: "c".repeat(64) }
    })).rejects.toMatchObject({
      code: "idempotency_conflict"
    });

    const claimed = await workflow.claim({
      kinds: ["source"],
      owner: "worker-one",
      limit: 10,
      leaseExpiresAt: new Date(now + 3_600_000).toISOString()
    });
    expect(claimed).toHaveLength(1);
    expect(claimed[0]).toMatchObject({
      publicId: "operation-one",
      state: "running",
      attempt: 1,
      leaseOwner: "worker-one"
    });
    await workflow.saveCheckpoint({
      publicId: "operation-one",
      owner: "worker-one",
      checkpoint: { stage: "source", completedFiles: 1 }
    });
    await workflow.releaseForRetry({
      publicId: "operation-one",
      owner: "worker-one",
      nextAttemptAt: new Date(now - 1_000).toISOString(),
      reasonCode: "PROVIDER_RETRY"
    });

    const reclaimed = await workflow.claim({
      kinds: ["source"],
      owner: "worker-two",
      limit: 1,
      leaseExpiresAt: new Date(now + 7_200_000).toISOString()
    });
    expect(reclaimed[0]).toMatchObject({
      publicId: "operation-one",
      attempt: 2,
      leaseOwner: "worker-two",
      checkpoint: { stage: "source", completedFiles: 1 }
    });

    const result = boundedResult("operation-one", now);
    await workflow.complete({
      publicId: "operation-one",
      owner: "worker-two",
      result
    });
    await expect(workflow.complete({
      publicId: "operation-one",
      owner: "worker-two",
      result
    })).resolves.toBeUndefined();
    await expect(workflow.findIdempotent({
      knowledgeBaseId: "kb-workflow",
      key: "request-one",
      requestHash
    })).resolves.toEqual({ type: "result", result });
    await expect(workflow.listResults({
      knowledgeBaseId: "kb-workflow",
      limit: 10,
      cursor: null
    })).resolves.toEqual({ items: [result], nextCursor: null });

    const counts = await sql<Array<{
      live_count: number | string;
      result_count: number | string;
      replay_count: number | string;
    }>>`
      SELECT
        (SELECT count(*) FROM focowiki.operation_work_items) AS live_count,
        (SELECT count(*) FROM focowiki.operation_results) AS result_count,
        (SELECT count(*) FROM focowiki.operations
         WHERE public_id IN ('operation-replay', 'operation-conflict')) AS replay_count
    `;
    expect(counts[0]).toEqual({ live_count: "0", result_count: "1", replay_count: "0" });
  });

  it("converges concurrent idempotency and SKIP LOCKED claims", async () => {
    const now = Date.now();
    const requestHash = "d".repeat(64);
    const left = liveWork("operation-concurrent-left", "request-concurrent", requestHash, now);
    const right = liveWork("operation-concurrent-right", "request-concurrent", requestHash, now);
    const outcomes = await Promise.all([
      workflow.enqueue(left),
      workflow.enqueue(right)
    ]);
    expect(outcomes[0].type).toBe("live");
    expect(outcomes[1].type).toBe("live");
    const publicIds = outcomes.map((outcome) =>
      outcome.type === "live" ? outcome.work.publicId : outcome.result.publicId
    );
    expect(new Set(publicIds).size).toBe(1);

    const claims = await Promise.all([
      workflow.claim({
        kinds: ["source"],
        owner: "worker-concurrent-left",
        limit: 1,
        leaseExpiresAt: new Date(now + 3_600_000).toISOString()
      }),
      workflow.claim({
        kinds: ["source"],
        owner: "worker-concurrent-right",
        limit: 1,
        leaseExpiresAt: new Date(now + 3_600_000).toISOString()
      })
    ]);
    expect([...claims[0], ...claims[1]].map((work) => work.publicId)).toEqual([
      publicIds[0]
    ]);
    expect(claims[0].length + claims[1].length).toBe(1);
    const claimed = [...claims[0], ...claims[1]][0]!;
    await workflow.complete({
      publicId: claimed.publicId,
      owner: claimed.leaseOwner!,
      result: boundedResult(claimed.publicId, now)
    });

    const rows = await sql<Array<{ operation_count: number | string }>>`
      SELECT count(*) AS operation_count
      FROM focowiki.operations
      WHERE public_id IN ('operation-concurrent-left', 'operation-concurrent-right')
    `;
    expect(rows[0]?.operation_count).toBe("1");
  });

  it("releases paginated progress without consuming the failure attempt budget", async () => {
    const now = Date.now();
    const work = liveWork(
      "operation-continuation",
      "request-continuation",
      "e".repeat(64),
      now
    );
    await workflow.enqueue(work);
    const first = await workflow.claim({
      kinds: ["source"],
      owner: "worker-continuation-one",
      limit: 1,
      leaseExpiresAt: new Date(now + 3_600_000).toISOString()
    });
    expect(first[0]?.attempt).toBe(1);
    await workflow.releaseForContinuation({
      publicId: work.publicId,
      owner: "worker-continuation-one",
      nextAttemptAt: new Date(now - 1_000).toISOString()
    });
    const second = await workflow.claim({
      kinds: ["source"],
      owner: "worker-continuation-two",
      limit: 1,
      leaseExpiresAt: new Date(now + 7_200_000).toISOString()
    });
    expect(second[0]).toMatchObject({
      publicId: work.publicId,
      attempt: 1,
      safeErrorCode: null
    });
    await workflow.complete({
      publicId: work.publicId,
      owner: "worker-continuation-two",
      result: boundedResult(work.publicId, now)
    });
  });

  it("claims at most one publication-plane work item per knowledge base", async () => {
    const now = Date.now();
    await sql`
      INSERT INTO focowiki.knowledge_bases (public_id, name, revision)
      VALUES ('kb-workflow-other', 'Other workflow knowledge base', 1)
    `;
    const sameKnowledgeBase = Array.from({ length: 3 }, (_, index) => ({
      ...liveWork(
        `operation-serialized-${index}`,
        `request-serialized-${index}`,
        String(index + 1).repeat(64),
        now
      ),
      kind: "mutation" as const
    }));
    const otherKnowledgeBase = {
      ...liveWork(
        "operation-serialized-other",
        "request-serialized-other",
        "4".repeat(64),
        now
      ),
      knowledgeBaseId: "kb-workflow-other",
      kind: "mutation" as const
    };
    await Promise.all([
      ...sameKnowledgeBase.map((work) => workflow.enqueue(work)),
      workflow.enqueue(otherKnowledgeBase)
    ]);

    const firstClaims = await workflow.claim({
      kinds: ["publication", "mutation"],
      owner: "worker-serialized-first",
      limit: 10,
      leaseExpiresAt: new Date(now + 3_600_000).toISOString()
    });
    expect(firstClaims).toHaveLength(2);
    expect(new Set(firstClaims.map((work) => work.knowledgeBaseId)).size).toBe(2);

    for (const work of firstClaims) {
      await workflow.complete({
        publicId: work.publicId,
        owner: work.leaseOwner!,
        result: {
          ...boundedResult(work.publicId, now),
          knowledgeBaseId: work.knowledgeBaseId,
          kind: "mutation"
        }
      });
    }
    for (let remaining = 2; remaining > 0; remaining -= 1) {
      const claims = await workflow.claim({
        kinds: ["publication", "mutation"],
        owner: `worker-serialized-${remaining}`,
        limit: 10,
        leaseExpiresAt: new Date(now + 3_600_000).toISOString()
      });
      expect(claims).toHaveLength(1);
      await workflow.complete({
        publicId: claims[0]!.publicId,
        owner: claims[0]!.leaseOwner!,
        result: {
          ...boundedResult(claims[0]!.publicId, now),
          kind: "mutation"
        }
      });
    }
  });

  it("does not consume a publication attempt while source work is still live", async () => {
    const now = Date.now();
    const knowledgeBaseId = "kb-workflow-prerequisite";
    await sql`
      INSERT INTO focowiki.knowledge_bases (public_id, name, revision)
      VALUES (${knowledgeBaseId}, 'Workflow prerequisite knowledge base', 1)
    `;
    const source = {
      ...liveWork(
      "operation-source-prerequisite",
      "request-source-prerequisite",
      "a".repeat(64),
      now
      ),
      knowledgeBaseId
    };
    const publication = {
      ...liveWork(
        "operation-publication-prerequisite",
        "request-publication-prerequisite",
        "b".repeat(64),
        now + 1
      ),
      knowledgeBaseId,
      kind: "publication" as const
    };
    await workflow.enqueue(source);
    await workflow.enqueue(publication);

    await expect(workflow.claim({
      kinds: ["publication"],
      owner: "publication-worker-prerequisite",
      limit: 1,
      leaseExpiresAt: new Date(now + 3_600_000).toISOString()
    })).resolves.toEqual([]);
    await expect(workflow.findIdempotent({
      knowledgeBaseId: publication.knowledgeBaseId,
      key: publication.idempotency.key,
      requestHash: publication.idempotency.requestHash
    })).resolves.toMatchObject({
      type: "live",
      work: { state: "queued", attempt: 0 }
    });

    const claimedSource = await workflow.claim({
      kinds: ["source"],
      owner: "source-worker-prerequisite",
      limit: 1,
      leaseExpiresAt: new Date(now + 3_600_000).toISOString()
    });
    expect(claimedSource[0]?.publicId).toBe(source.publicId);
    await workflow.complete({
      publicId: source.publicId,
      owner: "source-worker-prerequisite",
      result: {
        ...boundedResult(source.publicId, now),
        knowledgeBaseId
      }
    });

    await expect(workflow.claim({
      kinds: ["publication"],
      owner: "publication-worker-after-source",
      limit: 1,
      leaseExpiresAt: new Date(now + 7_200_000).toISOString()
    })).resolves.toEqual([
      expect.objectContaining({
        publicId: publication.publicId,
        state: "running",
        attempt: 1
      })
    ]);
  });

  it("reclaims only the operation that owns a live release candidate", async () => {
    const now = Date.now();
    await sql`
      INSERT INTO focowiki.knowledge_bases (public_id, name, revision)
      VALUES ('kb-workflow-candidate', 'Candidate workflow knowledge base', 1)
    `;
    const owner = {
      ...liveWork(
        "operation-candidate-owner",
        "request-candidate-owner",
        "5".repeat(64),
        now
      ),
      knowledgeBaseId: "kb-workflow-candidate",
      kind: "mutation" as const
    };
    const follower = {
      ...liveWork(
        "operation-candidate-follower",
        "request-candidate-follower",
        "6".repeat(64),
        now + 1
      ),
      knowledgeBaseId: "kb-workflow-candidate",
      kind: "mutation" as const
    };
    await workflow.enqueue(owner);
    await workflow.enqueue(follower);
    await sql`
      INSERT INTO focowiki.release_roots (
        public_id, knowledge_base_id, root_role, revision
      ) VALUES (
        'root-candidate-owner', 'kb-workflow-candidate', 'candidate', 1
      )
    `;
    await sql`
      INSERT INTO focowiki.release_candidates (
        public_id, knowledge_base_id, operation_public_id,
        candidate_root_public_id, expected_active_revision, state,
        changed_fact_count, affected_dependency_count
      ) VALUES (
        'candidate-owner', 'kb-workflow-candidate',
        'operation-candidate-owner', 'root-candidate-owner', 0, 'building', 0, 0
      )
    `;

    const first = await workflow.claim({
      kinds: ["mutation"],
      owner: "worker-candidate-owner",
      limit: 10,
      leaseExpiresAt: new Date(now + 3_600_000).toISOString()
    });
    expect(first.map((work) => work.publicId)).toEqual(["operation-candidate-owner"]);
    await workflow.releaseForRetry({
      publicId: "operation-candidate-owner",
      owner: "worker-candidate-owner",
      nextAttemptAt: new Date(now - 1_000).toISOString(),
      reasonCode: "PROVIDER_RETRY"
    });

    const second = await workflow.claim({
      kinds: ["mutation"],
      owner: "worker-candidate-owner-retry",
      limit: 10,
      leaseExpiresAt: new Date(now + 7_200_000).toISOString()
    });
    expect(second.map((work) => work.publicId)).toEqual(["operation-candidate-owner"]);
  });

  it("converges concurrent enqueue of the same deterministic operation identity", async () => {
    const now = Date.now();
    const work = {
      ...liveWork(
        "operation-concurrent-same",
        "request-concurrent-same",
        "8".repeat(64),
        now
      ),
      kind: "publication" as const
    };

    const outcomes = await Promise.all(Array.from(
      { length: 16 },
      () => createPostgresStorageVnextWorkflowRepository(database).enqueue(work)
    ));

    expect(outcomes).toHaveLength(16);
    expect(outcomes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "live",
        work: expect.objectContaining({ publicId: work.publicId })
      })
    ]));
    expect(outcomes.every((outcome) => (
      outcome.type === "live" && outcome.work.publicId === work.publicId
    ))).toBe(true);
    const rows = await sql<Array<{
      operation_count: number | string;
      work_count: number | string;
      idempotency_count: number | string;
    }>>`
      SELECT
        (SELECT count(*) FROM focowiki.operations
         WHERE public_id = ${work.publicId}) AS operation_count,
        (SELECT count(*) FROM focowiki.operation_work_items
         WHERE operation_public_id = ${work.publicId}) AS work_count,
        (SELECT count(*) FROM focowiki.operation_idempotency
         WHERE operation_public_id = ${work.publicId}) AS idempotency_count
    `;
    expect(rows[0]).toEqual({
      operation_count: "1",
      work_count: "1",
      idempotency_count: "1"
    });
  });

  it("recovers one expired lease across worker and API restart without losing progress", async () => {
    const now = Date.now();
    const stale = {
      ...liveWork("operation-stale", "request-stale", "e".repeat(64), now),
      state: "running" as const,
      attempt: 1,
      leaseOwner: "worker-crashed",
      leaseExpiresAt: new Date(now - 10_000).toISOString(),
      checkpoint: { stage: "graph", completedFiles: 7 }
    };
    await workflow.enqueue(stale);
    const restartedLeft = createPostgresStorageVnextWorkflowRepository(database);
    const restartedRight = createPostgresStorageVnextWorkflowRepository(database);
    const recoveryInput = {
      kinds: ["source"] as const,
      expiredBefore: new Date(now).toISOString(),
      retryAt: new Date(now - 1_000).toISOString(),
      reasonCode: "STALE_LEASE",
      limit: 10
    };
    const recovered = await Promise.all([
      restartedLeft.recoverStale(recoveryInput),
      restartedRight.recoverStale(recoveryInput)
    ]);
    expect(recovered[0] + recovered[1]).toBe(1);
    await expect(restartedLeft.findIdempotent({
      knowledgeBaseId: "kb-workflow",
      key: "request-stale",
      requestHash: "e".repeat(64)
    })).resolves.toMatchObject({
      type: "live",
      work: {
        publicId: "operation-stale",
        state: "retry",
        attempt: 1,
        leaseOwner: null,
        safeErrorCode: "STALE_LEASE",
        checkpoint: { stage: "graph", completedFiles: 7 }
      }
    });

    const claims = await Promise.all([
      restartedLeft.claim({
        kinds: ["source"],
        owner: "worker-restarted-left",
        limit: 1,
        leaseExpiresAt: new Date(now + 3_600_000).toISOString()
      }),
      restartedRight.claim({
        kinds: ["source"],
        owner: "worker-restarted-right",
        limit: 1,
        leaseExpiresAt: new Date(now + 3_600_000).toISOString()
      })
    ]);
    expect(claims[0].length + claims[1].length).toBe(1);
    const claimed = [...claims[0], ...claims[1]][0]!;
    expect(claimed).toMatchObject({
      publicId: "operation-stale",
      attempt: 2,
      safeErrorCode: null,
      checkpoint: { stage: "graph", completedFiles: 7 }
    });
    await expect(restartedLeft.saveCheckpoint({
      publicId: "operation-stale",
      owner: "worker-crashed",
      checkpoint: { stage: "must-not-win" }
    })).rejects.toMatchObject({ code: "lease_lost" });
  });

  it("lets the current owner release an expired timed-out attempt for retry", async () => {
    const now = Date.now();
    const timedOut = {
      ...liveWork("operation-timeout-boundary", "request-timeout-boundary", "7".repeat(64), now),
      kind: "publication" as const,
      state: "running" as const,
      attempt: 1,
      leaseOwner: "publication-worker-timeout",
      leaseExpiresAt: new Date(now - 1_000).toISOString()
    };
    await workflow.enqueue(timedOut);

    await expect(workflow.releaseForRetry({
      publicId: timedOut.publicId,
      owner: "publication-worker-timeout",
      nextAttemptAt: new Date(now + 1_000).toISOString(),
      reasonCode: "PUBLICATION_TIMEOUT"
    })).resolves.toBeUndefined();
    await expect(workflow.findIdempotent({
      knowledgeBaseId: timedOut.knowledgeBaseId,
      key: timedOut.idempotency.key,
      requestHash: timedOut.idempotency.requestHash
    })).resolves.toMatchObject({
      type: "live",
      work: {
        publicId: timedOut.publicId,
        state: "retry",
        leaseOwner: null,
        leaseExpiresAt: null,
        safeErrorCode: "PUBLICATION_TIMEOUT"
      }
    });
  });

  it("rolls back all workflow facts when enqueue fails before commit", async () => {
    const now = Date.now();
    const invalid = {
      ...liveWork("operation-before-commit", "request-before-commit", "f".repeat(64), now),
      settingsRevisionPublicId: "settings-missing"
    };
    await expect(workflow.enqueue(invalid)).rejects.toBeDefined();
    const partial = await sql<Array<{ count: number | string }>>`
      SELECT count(*) AS count
      FROM focowiki.operations
      WHERE public_id = 'operation-before-commit'
    `;
    expect(partial[0]?.count).toBe("0");
    await expect(workflow.enqueue({
      ...invalid,
      settingsRevisionPublicId: "settings-workflow"
    })).resolves.toMatchObject({
      type: "live",
      work: { publicId: "operation-before-commit", state: "queued" }
    });
  });

  it("converges concurrent terminal completion on one bounded result", async () => {
    const now = Date.now();
    const running = {
      ...liveWork("operation-terminal-race", "request-terminal-race", "9".repeat(64), now),
      state: "running" as const,
      attempt: 1,
      leaseOwner: "worker-terminal-race",
      leaseExpiresAt: new Date(now + 3_600_000).toISOString()
    };
    await workflow.enqueue(running);
    const result = boundedResult("operation-terminal-race", now);
    await expect(Promise.all([
      workflow.complete({
        publicId: running.publicId,
        owner: "worker-terminal-race",
        result
      }),
      createPostgresStorageVnextWorkflowRepository(database).complete({
        publicId: running.publicId,
        owner: "worker-terminal-race",
        result
      })
    ])).resolves.toEqual([undefined, undefined]);
    const rows = await sql<Array<{
      live_count: number | string;
      result_count: number | string;
    }>>`
      SELECT
        (SELECT count(*) FROM focowiki.operation_work_items
          WHERE operation_public_id = 'operation-terminal-race') AS live_count,
        (SELECT count(*) FROM focowiki.operation_results
          WHERE public_id = 'operation-terminal-race') AS result_count
    `;
    expect(rows[0]).toEqual({ live_count: "0", result_count: "1" });
  });

  it("appends immutable bounded security audit and binds pagination cursors", async () => {
    const now = Date.now();
    const first = auditEvent("audit-one", "settings.changed", now);
    const second = auditEvent("audit-two", "settings.changed", now + 1_000);
    await audit.append(first);
    await audit.append(first);
    await audit.append(second);
    await expect(audit.append({ ...first, result: "blocked" }))
      .rejects.toMatchObject({
        code: "event_conflict"
      });
    await expect(audit.append({
      ...first,
      publicId: "audit-secret",
      metadata: { apiToken: "must-not-persist" }
    })).rejects.toMatchObject({
      code: "invalid_input"
    });

    const firstPage = await audit.list({
      knowledgeBaseId: "kb-workflow",
      eventType: "settings.changed",
      result: "success",
      createdAfter: null,
      createdBefore: null,
      limit: 1,
      cursor: null
    });
    expect(firstPage.items).toEqual([second]);
    expect(firstPage.nextCursor).not.toBeNull();
    const secondPage = await audit.list({
      knowledgeBaseId: "kb-workflow",
      eventType: "settings.changed",
      result: "success",
      createdAfter: null,
      createdBefore: null,
      limit: 1,
      cursor: firstPage.nextCursor
    });
    expect(secondPage).toEqual({ items: [first], nextCursor: null });
    await expect(audit.list({
      knowledgeBaseId: "kb-workflow",
      eventType: "login.failed",
      result: "success",
      createdAfter: null,
      createdBefore: null,
      limit: 1,
      cursor: firstPage.nextCursor
    })).rejects.toMatchObject({
      code: "invalid_cursor"
    });

    const rows = await sql<Array<{ count: number | string }>>`
      SELECT count(*) AS count FROM focowiki.security_audit_events
    `;
    expect(rows[0]?.count).toBe("2");
  });
});

function liveWork(
  publicId: string,
  idempotencyKey: string,
  requestHash: string,
  now: number
): StorageVnextLiveWork {
  return {
    publicId,
    knowledgeBaseId: "kb-workflow",
    kind: "source",
    searchProviderKind: null,
    state: "queued",
    operationRevision: 0,
    settingsRevisionPublicId: "settings-workflow",
    attempt: 0,
    leaseOwner: null,
    leaseExpiresAt: null,
    nextAttemptAt: null,
    safeErrorCode: null,
    checkpoint: {},
    idempotency: {
      key: idempotencyKey,
      requestHash,
      expiresAt: new Date(now + 86_400_000).toISOString()
    }
  };
}

function boundedResult(publicId: string, now: number): StorageVnextBoundedResult {
  return {
    publicId,
    knowledgeBaseId: "kb-workflow",
    kind: "source",
    state: "completed",
    resultCode: "SOURCE_COMPLETED",
    safeMessage: null,
    summary: { processedFiles: 1 },
    correlationPublicId: "source-one",
    completedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 86_400_000).toISOString()
  };
}

function auditEvent(
  publicId: string,
  eventType: string,
  createdAt: number
): StorageVnextSecurityAuditEvent {
  return {
    publicId,
    knowledgeBaseId: "kb-workflow",
    actorPublicId: "admin-one",
    eventType,
    targetKind: "knowledge_base",
    targetPublicId: "kb-workflow",
    result: "success",
    reasonCode: null,
    sourceIp: "127.0.0.1",
    userAgent: "storage-vnext-test",
    metadata: { actorRole: "admin" },
    createdAt: new Date(createdAt).toISOString(),
    expiresAt: new Date(createdAt + 86_400_000).toISOString()
  };
}

function databaseConnectionUrl(connectionUrl: string, databaseName: string): string {
  const url = new URL(connectionUrl);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}
