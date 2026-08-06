import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DatabaseClient } from "../src/db/client.js";
import {
  createPostgresStorageVnextCleanupActionRepository,
  type StorageVnextCleanupAction
} from "../src/storage-vnext/cleanup/postgres-cleanup-action-repository.js";

const databaseUrl = process.env.FOCOWIKI_STORAGE_VNEXT_TEST_DATABASE_URL;
const runOwner = process.env.FOCOWIKI_STORAGE_VNEXT_TEST_RUN_OWNER;
const hasOwnedTarget = Boolean(
  databaseUrl
  && runOwner
  && /^svnext-[a-z0-9]{8,16}$/u.test(runOwner)
);
const describeOwnedDatabase = hasOwnedTarget ? describe : describe.skip;

describeOwnedDatabase("storage vNext live cleanup PostgreSQL repository", () => {
  const connectionUrl = databaseUrl
    ?? "postgres://unused:unused@127.0.0.1:5432/unused";
  const ownerToken = (runOwner ?? "invalid").replaceAll("-", "_");
  const databaseName = `focowiki_vnext_cleanup_${ownerToken}_${
    randomUUID().replaceAll("-", "").slice(0, 10)
  }`;
  const admin = postgres(databaseConnectionUrl(connectionUrl, "postgres"), { max: 1 });
  const sql = postgres(databaseConnectionUrl(connectionUrl, databaseName), { max: 4 });
  const database = sql as unknown as DatabaseClient;
  const repository = createPostgresStorageVnextCleanupActionRepository(database);
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
      VALUES ('kb-cleanup', 'Cleanup knowledge base', 1)
    `;
    await sql`
      INSERT INTO focowiki.operations
        (public_id, knowledge_base_id, operation_kind, state)
      VALUES ('operation-cleanup', 'kb-cleanup', 'publication', 'processing')
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

  it("keeps only live cleanup facts and deletes detail after completion", async () => {
    const now = Date.now();
    const action = cleanupAction(now);
    await expect(repository.enqueue(action)).resolves.toEqual(action);
    await expect(repository.enqueue({ ...action, publicId: "cleanup-replay" }))
      .resolves.toMatchObject({ publicId: "cleanup-action", state: "queued" });
    await expect(repository.enqueue({
      ...action,
      publicId: "cleanup-conflict",
      idempotency: { ...action.idempotency, requestHash: "c".repeat(64) }
    })).rejects.toMatchObject({ code: "idempotency_conflict" });

    const firstClaim = await repository.claim({
      owner: "cleanup-worker-one",
      limit: 1,
      leaseExpiresAt: new Date(now + 3_600_000).toISOString()
    });
    expect(firstClaim).toHaveLength(1);
    expect(firstClaim[0]).toMatchObject({
      publicId: "cleanup-action",
      state: "running",
      attempt: 1,
      leaseOwner: "cleanup-worker-one"
    });
    await repository.saveCheckpoint({
      publicId: "cleanup-action",
      owner: "cleanup-worker-one",
      checkpoint: { completedPlane: "postgres" }
    });
    await repository.releaseForRetry({
      publicId: "cleanup-action",
      owner: "cleanup-worker-one",
      notBefore: new Date(now - 1_000).toISOString(),
      safeErrorCode: "SEARCH_PROVIDER_RETRY",
      checkpoint: { completedPlane: "postgres" }
    });

    const secondClaim = await repository.claim({
      owner: "cleanup-worker-two",
      limit: 1,
      leaseExpiresAt: new Date(now + 7_200_000).toISOString()
    });
    expect(secondClaim[0]).toMatchObject({
      state: "running",
      attempt: 2,
      leaseOwner: "cleanup-worker-two",
      checkpoint: { completedPlane: "postgres" }
    });
    await expect(repository.complete({
      publicId: "cleanup-action",
      owner: "cleanup-worker-one"
    })).resolves.toBe(false);
    await expect(repository.complete({
      publicId: "cleanup-action",
      owner: "cleanup-worker-two"
    })).resolves.toBe(true);
    await expect(repository.complete({
      publicId: "cleanup-action",
      owner: "cleanup-worker-two"
    })).resolves.toBe(false);

    const rows = await sql<Array<{ cleanup_count: number | string }>>`
      SELECT count(*) AS cleanup_count FROM focowiki.cleanup_actions
    `;
    expect(rows[0]?.cleanup_count).toBe("0");
  });

  it("recovers one expired cleanup lease and rejects the crashed owner", async () => {
    const now = Date.now();
    const stale: StorageVnextCleanupAction = {
      ...cleanupAction(now),
      publicId: "cleanup-stale",
      target: {
        ...cleanupAction(now).target,
        publicId: "candidate-stale"
      },
      state: "running",
      attempt: 1,
      leaseOwner: "cleanup-worker-crashed",
      leaseExpiresAt: new Date(now - 10_000).toISOString(),
      checkpoint: { completedPlane: "postgres" },
      idempotency: {
        key: "cleanup-candidate-stale",
        requestHash: "d".repeat(64)
      }
    };
    await repository.enqueue(stale);
    const restartedLeft = createPostgresStorageVnextCleanupActionRepository(database);
    const restartedRight = createPostgresStorageVnextCleanupActionRepository(database);
    const recoveryInput = {
      expiredBefore: new Date(now).toISOString(),
      notBefore: new Date(now - 1_000).toISOString(),
      safeErrorCode: "STALE_LEASE",
      limit: 10
    };
    const recovered = await Promise.all([
      restartedLeft.recoverStale(recoveryInput),
      restartedRight.recoverStale(recoveryInput)
    ]);
    expect(recovered[0] + recovered[1]).toBe(1);
    const claimed = await restartedLeft.claim({
      owner: "cleanup-worker-restarted",
      limit: 1,
      leaseExpiresAt: new Date(now + 3_600_000).toISOString()
    });
    expect(claimed[0]).toMatchObject({
      publicId: "cleanup-stale",
      attempt: 2,
      checkpoint: { completedPlane: "postgres" }
    });
    await expect(restartedLeft.saveCheckpoint({
      publicId: "cleanup-stale",
      owner: "cleanup-worker-crashed",
      checkpoint: { completedPlane: "must-not-win" }
    })).rejects.toMatchObject({ code: "lease_lost" });
  });

  it("claims only the requested cleanup domain and provider plane", async () => {
    const now = Date.now();
    const candidateObject = {
      ...cleanupAction(now),
      publicId: "cleanup-candidate-object",
      domain: "candidate_projection",
      target: {
        publicId: "object-candidate-cleanup",
        resourceKind: "superseded_candidate_object",
        plane: "object_storage" as const,
        required: true,
        sequence: 30
      },
      idempotency: {
        key: "cleanup-candidate-object",
        requestHash: "e".repeat(64)
      }
    };
    const search = {
      ...cleanupAction(now),
      publicId: "cleanup-search-index",
      target: {
        ...cleanupAction(now).target,
        publicId: "search-candidate-cleanup"
      },
      idempotency: {
        key: "cleanup-search-index",
        requestHash: "f".repeat(64)
      }
    };
    await repository.enqueue(candidateObject);
    await repository.enqueue(search);

    const claimed = await repository.claim({
      owner: "candidate-object-cleanup-worker",
      limit: 10,
      leaseExpiresAt: new Date(now + 3_600_000).toISOString(),
      selector: {
        domain: "candidate_projection",
        plane: "object_storage",
        resourceKind: "superseded_candidate_object"
      }
    });
    expect(claimed.map((action) => action.publicId))
      .toEqual(["cleanup-candidate-object"]);
    await expect(repository.complete({
      publicId: "cleanup-candidate-object",
      owner: "candidate-object-cleanup-worker"
    })).resolves.toBe(true);

    const remaining = await repository.claim({
      owner: "remaining-cleanup-worker",
      limit: 10,
      leaseExpiresAt: new Date(now + 3_600_000).toISOString()
    });
    expect(remaining.map((action) => action.publicId))
      .toEqual(["cleanup-search-index"]);
    await expect(repository.complete({
      publicId: "cleanup-search-index",
      owner: "remaining-cleanup-worker"
    })).resolves.toBe(true);
  });
});

function cleanupAction(now: number): StorageVnextCleanupAction {
  return {
    publicId: "cleanup-action",
    operationPublicId: "operation-cleanup",
    knowledgeBaseId: "kb-cleanup",
    domain: "publication",
    target: {
      publicId: "candidate-one",
      resourceKind: "unified_search_candidate",
      plane: "search",
      required: true,
      sequence: 30
    },
    state: "queued",
    attempt: 0,
    leaseOwner: null,
    leaseExpiresAt: null,
    safeErrorCode: null,
    notBefore: new Date(now - 1_000).toISOString(),
    checkpoint: {},
    idempotency: {
      key: "cleanup-candidate-one",
      requestHash: "b".repeat(64)
    }
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
