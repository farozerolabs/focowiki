import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { DatabaseClient } from "../src/db/client.js";
import { createStorageVnextMaintenanceCoordinator } from
  "../src/storage-vnext/maintenance/maintenance-coordinator.js";
import { createPostgresStorageVnextMaintenanceRepository } from
  "../src/storage-vnext/maintenance/postgres-repository.js";
import { createStorageVnextMaintenanceResourceGate } from
  "../src/storage-vnext/maintenance/resource-gate.js";
import type {
  StorageVnextMaintenancePhaseResult,
  StorageVnextMaintenanceRequest
} from "../src/storage-vnext/maintenance/ports.js";
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
describeOwnedDatabase("storage vNext maintenance PostgreSQL repository", () => {
  const connectionUrl = databaseUrl
    ?? "postgres://unused:unused@127.0.0.1:5432/unused";
  const ownerToken = (runOwner ?? "invalid").replaceAll("-", "_");
  const databaseName = `focowiki_vnext_maintenance_${ownerToken}_${randomUUID()
    .replaceAll("-", "").slice(0, 10)}`;
  const admin = postgres(databaseConnectionUrl(connectionUrl, "postgres"), { max: 1 });
  const sql = postgres(databaseConnectionUrl(connectionUrl, databaseName), { max: 8 });
  const database = sql as unknown as DatabaseClient;
  const repository = createPostgresStorageVnextMaintenanceRepository(database, {
    selectedSearchProviderKind: "meilisearch"
  });
  const resourceGate = createStorageVnextMaintenanceResourceGate({
    limits: {
      maxMaintenanceConcurrency: 1,
      databaseConnectionLimit: 8,
      reservedApiConnections: 2,
      reservedForegroundConnections: 2,
      maintenanceDatabaseConnections: 1,
      searchInFlightLimit: 2,
      maintenanceSearchRequests: 1,
      objectInFlightLimit: 2,
      maintenanceObjectRequests: 1,
      memoryByteLimit: 64 * 1_024 * 1_024,
      maintenanceBatchBytes: 8 * 1_024 * 1_024
    },
    async sample() {
      return {
        databaseConnectionsInUse: 0,
        searchRequestsInFlight: 0,
        objectRequestsInFlight: 0,
        rssBytes: 0
      };
    }
  });
  let databaseCreated = false;

  beforeAll(async () => {
    await admin.unsafe(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
    databaseCreated = true;
    await applyStorageVnextTestMigrations(sql);
    await sql`
      INSERT INTO focowiki.runtime_setting_revisions
        (public_id, checksum_sha256, settings_values)
      VALUES ('settings-maintenance-integration', ${"a".repeat(64)}, '{}'::jsonb)
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

  afterEach(async () => {
    await sql`DELETE FROM focowiki.knowledge_bases`;
  });

  it("serializes one live owner and converges duplicate requests", async () => {
    await seedKnowledgeBase("kb-maintenance-owner", 7);
    const coordinator = createCoordinator([]);
    const first = request("owner-a", "kb-maintenance-owner", 7);

    await expect(coordinator.requestMaintenance(first)).resolves.toMatchObject({
      outcome: "queued",
      operationPublicId: "maintenance-owner-a"
    });
    await expect(coordinator.requestMaintenance(first)).resolves.toMatchObject({
      outcome: "replayed",
      operationPublicId: "maintenance-owner-a"
    });
    await expect(coordinator.requestMaintenance(request(
      "owner-b",
      "kb-maintenance-owner",
      7
    ))).resolves.toMatchObject({
      outcome: "already_active",
      operationPublicId: "maintenance-owner-a"
    });

    const counts = await sql<Array<{ operation_count: number; work_count: number }>>`
      SELECT
        count(DISTINCT operation.public_id)::int AS operation_count,
        count(DISTINCT work.operation_public_id)::int AS work_count
      FROM focowiki.operations AS operation
      LEFT JOIN focowiki.operation_work_items AS work
        ON work.operation_public_id = operation.public_id
      WHERE operation.knowledge_base_id = 'kb-maintenance-owner'
    `;
    expect(counts[0]).toEqual({ operation_count: 1, work_count: 1 });
  });

  it("keeps foreground work ahead of maintenance and deletion final", async () => {
    await seedKnowledgeBase("kb-maintenance-foreground", 3);
    await seedForegroundWork("kb-maintenance-foreground", "upload");
    const coordinator = createCoordinator([]);
    await expect(coordinator.requestMaintenance(request(
      "foreground-upload",
      "kb-maintenance-foreground",
      3
    ))).resolves.toEqual({
      outcome: "deferred",
      operationPublicId: null,
      state: "deferred",
      reasonCode: "FOREGROUND_WORK_ACTIVE"
    });
    await removeForegroundWork("kb-maintenance-foreground");
    await seedForegroundWork("kb-maintenance-foreground", "deletion");
    await expect(coordinator.requestMaintenance(request(
      "foreground-delete",
      "kb-maintenance-foreground",
      3
    ))).rejects.toMatchObject({ code: "knowledge_base_deleting" });
  });

  it("persists safe progress status and resets retry pressure after progress", async () => {
    await seedKnowledgeBase("kb-maintenance-progress", 5);
    const coordinator = createCoordinator([{
      outcome: "progress",
      cursor: "source-cursor-progress",
      completedDelta: 25,
      expectedCount: 100,
      processedBytesDelta: 1_024
    }]);
    await coordinator.requestMaintenance({
      ...request("progress", "kb-maintenance-progress", 5),
      requestedAt: new Date(Date.now() - 10_000).toISOString()
    });
    const failedClaim = await repository.claimOne(
      workerClaim("unified-worker-progress-failure")
    );
    expect(failedClaim).not.toBeNull();
    await expect(repository.releaseForRetry({
      operationPublicId: "maintenance-progress",
      leaseOwner: "unified-worker-progress-failure",
      safeErrorCode: "MAINTENANCE_PHASE_TIMEOUT"
    })).resolves.toBe("retry");
    await expect(repository.getStatus({
      knowledgeBaseId: "kb-maintenance-progress"
    })).resolves.toMatchObject({
      requestId: "maintenance-progress",
      state: "planning",
      retryCount: 1,
      safeErrorCode: "MAINTENANCE_PHASE_TIMEOUT"
    });

    await expect(coordinator.runOne(workerClaim("unified-worker-progress")))
      .resolves.toMatchObject({ outcome: "progress" });
    const status = await repository.getStatus({
      knowledgeBaseId: "kb-maintenance-progress"
    });
    expect(status).toMatchObject({
      requestId: "maintenance-progress",
      state: "planning",
      completedCount: 25,
      expectedCount: 100,
      retryCount: 0,
      safeErrorCode: null,
      lastCompletedAt: null,
      maintenanceRequired: true
    });
    expect(status.throughputPerSecond).toBeGreaterThan(0);
    expect(status.estimatedCompletionAt).not.toBeNull();
  });

  it("resumes one checkpoint after lease recovery and removes live detail at completion", async () => {
    await seedKnowledgeBase("kb-maintenance-resume", 11);
    const phaseResults: StorageVnextMaintenancePhaseResult[] = [{
      outcome: "progress",
      cursor: "source-cursor-50",
      completedDelta: 50,
      expectedCount: 100,
      processedBytesDelta: 2_048
    }];
    const coordinator = createCoordinator(phaseResults);
    await coordinator.requestMaintenance(request(
      "resume",
      "kb-maintenance-resume",
      11
    ));
    await expect(coordinator.runOne(workerClaim("unified-worker-one")))
      .resolves.toMatchObject({ outcome: "progress" });

    const firstCheckpoint = await sql<Array<{
      checkpoint: { cursor: string; completedCount: number; batchOrdinal: number };
    }>>`
      SELECT checkpoint
      FROM focowiki.operation_work_items
      WHERE operation_public_id = 'maintenance-resume'
    `;
    expect(firstCheckpoint[0]?.checkpoint).toMatchObject({
      cursor: "source-cursor-50",
      completedCount: 50,
      batchOrdinal: 1
    });

    const claimed = await repository.claimOne(workerClaim("unified-worker-stale"));
    expect(claimed?.checkpoint).toMatchObject({ cursor: "source-cursor-50" });
    await sql`
      UPDATE focowiki.operation_work_items
      SET lease_expires_at = now() - interval '1 minute'
      WHERE operation_public_id = 'maintenance-resume'
    `;
    await expect(coordinator.recoverStale({
      expiredBefore: new Date().toISOString(),
      retryAt: new Date(Date.now() - 1_000).toISOString(),
      limit: 10
    })).resolves.toBe(1);
    const reclaimed = await repository.claimOne(workerClaim("unified-worker-restart"));
    expect(reclaimed).toMatchObject({
      operationPublicId: "maintenance-resume",
      attempt: 0,
      checkpoint: { cursor: "source-cursor-50", completedCount: 50 }
    });
    await repository.complete({
      operationPublicId: "maintenance-resume",
      leaseOwner: "unified-worker-restart",
      state: "completed",
      resultCode: "MAINTENANCE_COMPLETED",
      summary: { completedCount: 50 }
    });

    const residue = await sql<Array<{ live_count: number; result_count: number }>>`
      SELECT
        (SELECT count(*)::int FROM focowiki.operation_work_items
         WHERE operation_public_id = 'maintenance-resume') AS live_count,
        (SELECT count(*)::int FROM focowiki.operation_results
         WHERE public_id = 'maintenance-resume') AS result_count
    `;
    expect(residue[0]).toEqual({ live_count: 0, result_count: 1 });
    await expect(repository.getStatus({
      knowledgeBaseId: "kb-maintenance-resume"
    })).resolves.toMatchObject({
      requestId: "maintenance-resume",
      state: "completed",
      active: false,
      lastCompletedAt: expect.any(String),
      maintenanceRequired: true,
      safeErrorCode: null
    });
  });

  it("cancels queued and running maintenance without allowing work resurrection", async () => {
    await seedKnowledgeBase("kb-maintenance-cancel", 2);
    const coordinator = createCoordinator([]);
    await coordinator.requestMaintenance(request(
      "cancel",
      "kb-maintenance-cancel",
      2
    ));
    const claim = await repository.claimOne(workerClaim("unified-worker-cancel"));
    expect(claim).not.toBeNull();
    const canceledAt = new Date().toISOString();

    await expect(repository.cancel({
      knowledgeBaseId: "kb-maintenance-cancel",
      operationPublicId: "maintenance-cancel",
      canceledAt
    })).resolves.toBe("cancelled");
    await expect(repository.saveProgress({
      operationPublicId: "maintenance-cancel",
      leaseOwner: "unified-worker-cancel",
      checkpoint: claim!.checkpoint
    })).resolves.toBe("terminal");

    const residue = await sql<Array<{ work_count: number; result_count: number }>>`
      SELECT
        (SELECT count(*)::int FROM focowiki.operation_work_items
         WHERE operation_public_id = 'maintenance-cancel') AS work_count,
        (SELECT count(*)::int FROM focowiki.operation_results
         WHERE public_id = 'maintenance-cancel'
           AND terminal_state = 'superseded') AS result_count
    `;
    expect(residue[0]).toEqual({ work_count: 0, result_count: 1 });
    await expect(repository.getStatus({
      knowledgeBaseId: "kb-maintenance-cancel"
    })).resolves.toMatchObject({
      requestId: "maintenance-cancel",
      state: "canceled",
      active: false,
      maintenanceRequired: true,
      safeErrorCode: "MAINTENANCE_CANCELLED"
    });
  });

  it("recovers a cancelled running lease after worker restart for terminal cleanup", async () => {
    await seedKnowledgeBase("kb-maintenance-cancel-restart", 1);
    const coordinator = createCoordinator([]);
    await coordinator.requestMaintenance(request(
      "cancel-restart",
      "kb-maintenance-cancel-restart",
      1
    ));
    await repository.claimOne(workerClaim("worker-before-cancel-restart"));
    await repository.cancel({
      knowledgeBaseId: "kb-maintenance-cancel-restart",
      operationPublicId: "maintenance-cancel-restart",
      canceledAt: new Date().toISOString()
    });

    await expect(repository.recoverStale({
      expiredBefore: new Date(Date.now() + 120_000).toISOString(),
      retryAt: new Date().toISOString(),
      limit: 10
    })).resolves.toBe(1);
    const recovered = await repository.claimOne(workerClaim("worker-after-cancel-restart"));
    expect(recovered).toMatchObject({
      operationPublicId: "maintenance-cancel-restart",
      state: "superseded"
    });
    await repository.complete({
      operationPublicId: "maintenance-cancel-restart",
      leaseOwner: "worker-after-cancel-restart",
      state: "superseded",
      resultCode: "MAINTENANCE_SUPERSEDED"
    });
    await expect(sql`
      SELECT operation_public_id FROM focowiki.operation_work_items
      WHERE operation_public_id = 'maintenance-cancel-restart'
    `).resolves.toEqual([]);
  });

  function createCoordinator(phaseResults: StorageVnextMaintenancePhaseResult[]) {
    return createStorageVnextMaintenanceCoordinator({
      repository,
      searchProviderKind: "meilisearch",
      phaseRunner: {
        async runPhase() {
          return phaseResults.shift() ?? {
            outcome: "phase_completed" as const,
            completedDelta: 0,
            expectedCount: 0,
            processedBytesDelta: 0
          };
        }
      },
      cleanup: { async terminate() {} },
      resourceGate,
      phaseTimeoutMs: 10_000
    });
  }

  async function seedKnowledgeBase(knowledgeBaseId: string, revision: number) {
    await sql`
      INSERT INTO focowiki.knowledge_bases (public_id, name, revision)
      VALUES (${knowledgeBaseId}, ${knowledgeBaseId}, ${revision})
    `;
  }

  async function seedForegroundWork(
    knowledgeBaseId: string,
    workKind: "upload" | "deletion"
  ) {
    const operationPublicId = `${workKind}-${knowledgeBaseId}`;
    await sql`
      INSERT INTO focowiki.operations (
        public_id, knowledge_base_id, operation_kind, state,
        expected_resource_revision, target_kind, target_public_id
      ) VALUES (
        ${operationPublicId}, ${knowledgeBaseId}, ${workKind}, 'accepted',
        0, 'knowledge_base', ${knowledgeBaseId}
      )
    `;
    await sql`
      INSERT INTO focowiki.operation_work_items (
        operation_public_id, knowledge_base_id, work_kind, state,
        operation_revision, settings_revision_public_id, attempt_count,
        next_attempt_at, checkpoint
      ) VALUES (
        ${operationPublicId}, ${knowledgeBaseId}, ${workKind}, 'queued', 0,
        'settings-maintenance-integration', 0, now(), '{}'::jsonb
      )
    `;
  }

  async function removeForegroundWork(knowledgeBaseId: string) {
    await sql`
      DELETE FROM focowiki.operations
      WHERE knowledge_base_id = ${knowledgeBaseId}
    `;
  }
});

function request(
  suffix: string,
  knowledgeBaseId: string,
  expectedResourceRevision: number
): StorageVnextMaintenanceRequest {
  return {
    knowledgeBaseId,
    operationPublicId: `maintenance-${suffix}`,
    searchProviderKind: "meilisearch",
    trigger: "manual",
    idempotencyKey: `maintenance-${suffix}`,
    expectedResourceRevision,
    settingsRevisionPublicId: "settings-maintenance-integration",
    requestedAt: new Date(Date.now() - 1_000).toISOString(),
    expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    maxAttempts: 3
  };
}

function workerClaim(workerId: string) {
  return {
    workerId,
    searchProviderKind: "meilisearch" as const,
    leaseExpiresAt: new Date(Date.now() + 60_000).toISOString()
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
