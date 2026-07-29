import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { applyMigrations } from "../src/db/migrations.js";
import {
  createPostgresKnowledgeBaseIndexMaintenanceRepository
} from "../src/infrastructure/postgres/knowledge-base-index-maintenance-repository.js";
import {
  REQUIRED_PROJECTION_REPAIR_VERSIONS
} from "../src/maintenance/projection-repair-plan.js";

const databaseUrl = process.env.FOCOWIKI_TEST_DATABASE_URL;
const describeDatabase = databaseUrl ? describe : describe.skip;
const NOW = "2026-07-27T00:00:00.000Z";

describeDatabase("knowledge-base index maintenance repository integration", () => {
  const connectionUrl = databaseUrl ?? "postgres://unused:unused@127.0.0.1:5432/unused";
  const databaseName = `focowiki_index_maintenance_${process.pid}_${
    randomUUID().replaceAll("-", "").slice(0, 10)
  }`;
  const admin = postgres(databaseConnectionUrl(connectionUrl, "postgres"), { max: 1 });
  const sql = postgres(databaseConnectionUrl(connectionUrl, databaseName), { max: 4 });
  const repository = createPostgresKnowledgeBaseIndexMaintenanceRepository(sql);

  beforeAll(async () => {
    await admin.unsafe(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
    await applyMigrations(sql);
  });

  beforeEach(async () => {
    await sql`TRUNCATE focowiki.knowledge_bases CASCADE`;
    await seedKnowledgeBase("kb-1", "generation-1", "2026-07-20T00:00:00.000Z");
  });

  afterAll(async () => {
    await sql.end({ timeout: 5 });
    await admin.unsafe(`DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)} WITH (FORCE)`);
    await admin.end({ timeout: 5 });
  });

  it("shares one active slot across manual and automatic requests and releases it at completion", async () => {
    const first = await createRequest({
      requestId: "request-manual-1",
      idempotencyKey: "manual-key-1",
      trigger: "manual"
    });
    const duplicate = await createRequest({
      requestId: "request-manual-duplicate",
      idempotencyKey: "manual-key-1",
      trigger: "manual"
    });
    const competing = await createRequest({
      requestId: "request-automatic-1",
      idempotencyKey: null,
      trigger: "automatic"
    });

    expect(first.outcome).toBe("accepted");
    expect(duplicate).toMatchObject({
      outcome: "already_active",
      request: { id: "request-manual-1" }
    });
    expect(competing).toMatchObject({
      outcome: "already_active",
      request: { id: "request-manual-1" }
    });

    const [claimed] = await repository.claimBatch({
      workerId: "maintenance-worker-1",
      leaseTokenPrefix: "lease",
      limit: 1,
      now: NOW,
      leaseExpiresAt: "2026-07-27T00:01:00.000Z"
    });
    expect(claimed).toMatchObject({
      id: "request-manual-1",
      state: "planning",
      trigger: "manual"
    });
    if (!claimed) throw new Error("Expected maintenance claim");

    await expect(repository.start({
      request: claimed,
      plannedScopes: ["tree", "search"],
      startedAt: NOW
    })).resolves.toBe(true);
    await expect(repository.heartbeat({
      request: claimed,
      stage: "search:documents",
      completedCount: 40,
      expectedCount: 100,
      heartbeatAt: "2026-07-27T00:00:10.000Z",
      leaseExpiresAt: "2026-07-27T00:01:10.000Z"
    })).resolves.toBe(true);
    await expect(repository.complete({
      request: claimed,
      completedScopes: ["tree", "search"],
      completedAt: "2026-07-27T00:00:20.000Z"
    })).resolves.toBe(true);

    await expect(repository.getSummary({ knowledgeBaseId: "kb-1" })).resolves.toMatchObject({
      requestId: "request-manual-1",
      state: "completed",
      active: false,
      completedCount: 100,
      expectedCount: 100,
      lastCompletedAt: "2026-07-27T00:00:20.000Z"
    });

    await expect(createRequest({
      requestId: "request-manual-2",
      idempotencyKey: "manual-key-2",
      trigger: "manual"
    })).resolves.toMatchObject({
      outcome: "accepted",
      request: { id: "request-manual-2" }
    });
  });

  it("discovers due knowledge bases with a bound and cancels active work on deletion", async () => {
    await seedKnowledgeBase("kb-2", "generation-2", "2026-07-20T00:00:00.000Z");

    await expect(repository.discoverAutomaticDue({
      requestIdPrefix: "automatic",
      settingsRevision: 1,
      settingsSnapshot: { mode: "automatic" },
      maxAttempts: 5,
      dueBefore: "2026-07-26T00:00:00.000Z",
      limit: 1,
      now: NOW
    })).resolves.toBe(1);

    const [activeKnowledgeBaseId] = await repository.listActiveKnowledgeBaseIds({ limit: 10 });
    expect(["kb-1", "kb-2"]).toContain(activeKnowledgeBaseId);
    if (!activeKnowledgeBaseId) throw new Error("Expected active maintenance request");

    await sql`
      UPDATE focowiki.knowledge_bases
      SET deleted_at = '2026-07-27T00:00:30.000Z'
      WHERE id = ${activeKnowledgeBaseId}
    `;

    const rows = await sql<Array<{ state: string }>>`
      SELECT state
      FROM focowiki.knowledge_base_index_maintenance_requests
      WHERE knowledge_base_id = ${activeKnowledgeBaseId}
      ORDER BY created_at DESC
      LIMIT 1
    `;
    expect(rows[0]?.state).toBe("canceled");
    await expect(repository.listActiveKnowledgeBaseIds({ limit: 10 })).resolves.not.toContain(
      activeKnowledgeBaseId
    );
  });

  it("measures the automatic interval from the latest request completion", async () => {
    await sql`
      INSERT INTO focowiki.knowledge_base_index_maintenance_requests (
        id,
        knowledge_base_id,
        trigger_kind,
        state,
        settings_revision,
        completed_at,
        next_attempt_at,
        created_at,
        updated_at
      )
      VALUES (
        'request-recently-completed',
        'kb-1',
        'automatic',
        'completed',
        1,
        '2026-07-27T00:00:00.000Z',
        '2026-07-27T00:00:00.000Z',
        '2026-07-20T00:00:00.000Z',
        '2026-07-27T00:00:00.000Z'
      )
    `;

    await expect(repository.discoverAutomaticDue({
      requestIdPrefix: "automatic",
      settingsRevision: 1,
      settingsSnapshot: { mode: "automatic" },
      maxAttempts: 5,
      dueBefore: "2026-07-26T23:59:59.000Z",
      limit: 10,
      now: "2026-07-27T00:00:01.000Z"
    })).resolves.toBe(0);

    await expect(repository.discoverAutomaticDue({
      requestIdPrefix: "automatic",
      settingsRevision: 1,
      settingsSnapshot: { mode: "automatic" },
      maxAttempts: 5,
      dueBefore: "2026-07-27T00:00:00.000Z",
      limit: 10,
      now: "2026-07-27T06:00:00.000Z"
    })).resolves.toBe(1);
  });

  it("includes pending search projection maintenance in the summary", async () => {
    await sql`
      UPDATE focowiki.publication_generations
      SET search_schema_version = 'search-current',
          tokenizer_contract_version = 'tokenizer-current',
          search_segmentation_version = 'segmentation-current'
      WHERE id = 'generation-1'
    `;
    for (const [kind, version] of Object.entries(
      REQUIRED_PROJECTION_REPAIR_VERSIONS
    )) {
      await sql`
        INSERT INTO focowiki.knowledge_base_projection_versions (
          knowledge_base_id, projection_kind, format_version,
          input_version, active_generation_id
        ) VALUES (
          'kb-1', ${kind}, ${version}, ${version}, 'generation-1'
        )
      `;
    }

    await expect(repository.getSummary({
      knowledgeBaseId: "kb-1"
    })).resolves.toMatchObject({
      state: "idle",
      maintenanceRequired: true
    });

    await sql`
      UPDATE focowiki.knowledge_base_search_states
      SET maintenance_required = false
      WHERE knowledge_base_id = 'kb-1'
    `;

    await expect(repository.getSummary({
      knowledgeBaseId: "kb-1"
    })).resolves.toMatchObject({
      state: "idle",
      maintenanceRequired: false
    });
  });

  it("recovers expired leases and releases the active slot after retry exhaustion", async () => {
    await repository.createOrGet({
      requestId: "request-recovery",
      knowledgeBaseId: "kb-1",
      trigger: "manual",
      idempotencyKey: "recovery-key",
      actor: "admin",
      settingsRevision: 3,
      settingsSnapshot: { mode: "manual" },
      maxAttempts: 2,
      now: NOW
    });
    const [firstClaim] = await repository.claimBatch({
      workerId: "maintenance-worker-1",
      leaseTokenPrefix: "lease-1",
      limit: 1,
      now: NOW,
      leaseExpiresAt: "2026-07-27T00:00:05.000Z"
    });
    if (!firstClaim) throw new Error("Expected first maintenance claim");

    await expect(repository.claimBatch({
      workerId: "maintenance-worker-2",
      leaseTokenPrefix: "lease-2",
      limit: 1,
      now: "2026-07-27T00:00:04.000Z",
      leaseExpiresAt: "2026-07-27T00:01:04.000Z"
    })).resolves.toHaveLength(0);

    const [recoveredClaim] = await repository.claimBatch({
      workerId: "maintenance-worker-2",
      leaseTokenPrefix: "lease-2",
      limit: 1,
      now: "2026-07-27T00:00:06.000Z",
      leaseExpiresAt: "2026-07-27T00:01:06.000Z"
    });
    expect(recoveredClaim).toMatchObject({
      id: "request-recovery",
      leaseOwner: "maintenance-worker-2"
    });
    if (!recoveredClaim) throw new Error("Expected recovered maintenance claim");

    await expect(repository.retryOrFail({
      request: recoveredClaim,
      errorCode: "INDEX_MAINTENANCE_FAILED",
      errorMessage: "Maintenance could not continue",
      retryAt: "2026-07-27T00:01:10.000Z",
      failedAt: "2026-07-27T00:00:10.000Z"
    })).resolves.toBe("retry");
    const [retryClaim] = await repository.claimBatch({
      workerId: "maintenance-worker-3",
      leaseTokenPrefix: "lease-3",
      limit: 1,
      now: "2026-07-27T00:01:10.000Z",
      leaseExpiresAt: "2026-07-27T00:02:10.000Z"
    });
    if (!retryClaim) throw new Error("Expected retry maintenance claim");
    await expect(repository.retryOrFail({
      request: retryClaim,
      errorCode: "INDEX_MAINTENANCE_FAILED",
      errorMessage: "Maintenance could not continue",
      retryAt: "2026-07-27T00:02:20.000Z",
      failedAt: "2026-07-27T00:01:20.000Z"
    })).resolves.toBe("failed");

    await expect(repository.getSummary({ knowledgeBaseId: "kb-1" })).resolves.toMatchObject({
      state: "failed",
      active: false,
      retryCount: 2,
      safeErrorCode: "INDEX_MAINTENANCE_FAILED"
    });
    await expect(createRequest({
      requestId: "request-after-failure",
      idempotencyKey: "after-failure-key",
      trigger: "manual"
    })).resolves.toMatchObject({ outcome: "accepted" });
  });

  it("cancels only unstarted automatic requests when manual mode becomes effective", async () => {
    await seedKnowledgeBase("kb-2", "generation-2", "2026-07-20T00:00:00.000Z");
    await seedKnowledgeBase("kb-3", "generation-3", "2026-07-20T00:00:00.000Z");
    await createRequest({
      requestId: "request-running-automatic",
      idempotencyKey: null,
      trigger: "automatic"
    });
    const [running] = await repository.claimBatch({
      workerId: "maintenance-worker-1",
      leaseTokenPrefix: "lease",
      limit: 1,
      now: NOW,
      leaseExpiresAt: "2026-07-27T00:01:00.000Z"
    });
    if (!running) throw new Error("Expected running automatic request");
    await repository.start({
      request: running,
      plannedScopes: ["tree"],
      startedAt: NOW
    });
    await repository.createOrGet({
      requestId: "request-queued-automatic",
      knowledgeBaseId: "kb-2",
      trigger: "automatic",
      idempotencyKey: null,
      actor: null,
      settingsRevision: 1,
      settingsSnapshot: { mode: "automatic" },
      maxAttempts: 5,
      now: NOW
    });
    await repository.createOrGet({
      requestId: "request-queued-manual",
      knowledgeBaseId: "kb-3",
      trigger: "manual",
      idempotencyKey: "manual-kb-3",
      actor: "admin",
      settingsRevision: 1,
      settingsSnapshot: { mode: "manual" },
      maxAttempts: 5,
      now: NOW
    });

    await expect(repository.cancelQueuedAutomatic({
      canceledAt: "2026-07-27T00:00:30.000Z"
    })).resolves.toBe(1);
    await expect(repository.getSummary({ knowledgeBaseId: "kb-1" })).resolves.toMatchObject({
      state: "running",
      active: true
    });
    await expect(repository.getSummary({ knowledgeBaseId: "kb-2" })).resolves.toMatchObject({
      state: "canceled",
      active: false
    });
    await expect(repository.getSummary({ knowledgeBaseId: "kb-3" })).resolves.toMatchObject({
      state: "queued",
      active: true
    });
  });

  async function createRequest(input: {
    requestId: string;
    idempotencyKey: string | null;
    trigger: "manual" | "automatic";
  }) {
    return repository.createOrGet({
      ...input,
      knowledgeBaseId: "kb-1",
      actor: input.trigger === "manual" ? "admin" : null,
      settingsRevision: 1,
      settingsSnapshot: { mode: input.trigger === "manual" ? "manual" : "automatic" },
      maxAttempts: 5,
      now: NOW
    });
  }

  async function seedKnowledgeBase(
    knowledgeBaseId: string,
    generationId: string,
    createdAt: string
  ): Promise<void> {
    await sql`
      INSERT INTO focowiki.knowledge_bases (
        id,
        name,
        created_at,
        updated_at,
        index_maintenance_last_activity_at
      )
      VALUES (
        ${knowledgeBaseId},
        ${knowledgeBaseId},
        ${createdAt},
        ${createdAt},
        ${createdAt}
      )
    `;
    await sql`
      INSERT INTO focowiki.publication_generations (
        id, knowledge_base_id, predecessor_generation_id, state,
        format_version, generation_kind, activated_at
      ) VALUES (
        ${generationId}, ${knowledgeBaseId}, NULL, 'active',
        2, 'normal', ${createdAt}
      )
    `;
    await sql`
      UPDATE focowiki.knowledge_bases
      SET active_generation_id = ${generationId}
      WHERE id = ${knowledgeBaseId}
    `;
  }
});

function databaseConnectionUrl(connectionUrl: string, databaseName: string): string {
  const url = new URL(connectionUrl);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll("\"", "\"\"")}"`;
}
