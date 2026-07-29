import { createHash, randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyMigrations } from "../src/db/migrations.js";
import {
  createPostgresSearchProjectionStateRepository
} from "../src/infrastructure/postgres/search-projection-state-repository.js";

const databaseUrl = process.env.FOCOWIKI_TEST_DATABASE_URL;
const describeDatabase = databaseUrl ? describe : describe.skip;

describeDatabase("search projection state repository integration", () => {
  const connectionUrl =
    databaseUrl ?? "postgres://unused:unused@127.0.0.1:5432/unused";
  const databaseName = `focowiki_search_projection_${process.pid}_${
    randomUUID().replaceAll("-", "").slice(0, 10)
  }`;
  const admin = postgres(databaseConnectionUrl(connectionUrl, "postgres"), { max: 1 });
  const sql = postgres(databaseConnectionUrl(connectionUrl, databaseName), { max: 4 });
  const repository = createPostgresSearchProjectionStateRepository(sql);

  beforeAll(async () => {
    await admin.unsafe(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
    await applyMigrations(sql);
    await applyMigrations(sql);
    await sql`
      INSERT INTO focowiki.knowledge_bases (id, name)
      VALUES ('kb-search-state', 'Search state')
    `;
    await sql`
      INSERT INTO focowiki.publication_generations (
        id, knowledge_base_id, predecessor_generation_id, state,
        format_version, generation_kind, activated_at
      ) VALUES (
        'generation-search-state', 'kb-search-state', NULL, 'active',
        2, 'normal', now()
      )
    `;
    await sql`
      UPDATE focowiki.knowledge_bases
      SET active_generation_id = 'generation-search-state'
      WHERE id = 'kb-search-state'
    `;
  }, 120_000);

  afterAll(async () => {
    await sql.end({ timeout: 5 });
    await admin.unsafe(
      `DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)} WITH (FORCE)`
    );
    await admin.end({ timeout: 5 });
  });

  it("keeps compatibility routing and reserves contiguous epochs", async () => {
    await expect(repository.getState("kb-search-state")).resolves.toMatchObject({
      routeState: "postgres_compatibility",
      activeEpoch: 0,
      pendingEpoch: null,
      maintenanceRequired: true
    });

    const reserved = await repository.reservePendingEpoch({
      knowledgeBaseId: "kb-search-state",
      generationId: "generation-search-state",
      maintenanceRequestId: null,
      contract: searchContract(),
      reservedAt: "2026-07-29T00:00:00.000Z"
    });
    expect(reserved).toMatchObject({
      outcome: "reserved",
      state: {
        activeEpoch: 0,
        pendingEpoch: 1,
        pendingActivationState: "indexing",
        pendingGenerationId: "generation-search-state"
      }
    });
    await expect(repository.reservePendingEpoch({
      knowledgeBaseId: "kb-search-state",
      generationId: "generation-search-state",
      maintenanceRequestId: null,
      contract: searchContract(),
      reservedAt: "2026-07-29T00:00:01.000Z"
    })).resolves.toMatchObject({
      outcome: "existing",
      state: { pendingEpoch: 1 }
    });
  });

  it("persists a forced full rebuild for a compatible active contract", async () => {
    const contract = searchContract();
    await sql`
      INSERT INTO focowiki.knowledge_bases (id, name)
      VALUES ('kb-search-force-rebuild', 'Search force rebuild')
    `;
    await sql`
      INSERT INTO focowiki.publication_generations (
        id, knowledge_base_id, predecessor_generation_id, state,
        format_version, generation_kind, search_schema_version,
        activated_at
      ) VALUES (
        'generation-search-force-rebuild', 'kb-search-force-rebuild',
        NULL, 'active', 2, 'normal', ${contract.contentSchemaVersion}, now()
      )
    `;
    await sql`
      UPDATE focowiki.knowledge_bases
      SET active_generation_id = 'generation-search-force-rebuild'
      WHERE id = 'kb-search-force-rebuild'
    `;
    await sql`
      UPDATE focowiki.knowledge_base_search_states
      SET route_state = 'meilisearch',
          active_epoch = 3,
          active_generation_id = 'generation-search-force-rebuild',
          content_schema_version = ${contract.contentSchemaVersion},
          graph_schema_version = ${contract.graphSchemaVersion},
          content_settings_checksum = ${contract.contentSettingsChecksum},
          graph_settings_checksum = ${contract.graphSettingsChecksum},
          maintenance_required = false,
          activated_at = now()
      WHERE knowledge_base_id = 'kb-search-force-rebuild'
    `;

    await expect(repository.reservePendingEpoch({
      knowledgeBaseId: "kb-search-force-rebuild",
      generationId: "generation-search-force-rebuild",
      maintenanceRequestId: null,
      forceFullRebuild: true,
      contract,
      reservedAt: "2026-07-29T00:00:02.000Z"
    })).resolves.toMatchObject({
      outcome: "reserved",
      state: {
        activeEpoch: 3,
        pendingEpoch: 4,
        pendingFullRebuild: true
      }
    });
  });

  it("persists tasks before waiting and replays deterministic work", async () => {
    const payloadChecksum = createHash("sha256").update("batch-1").digest("hex");
    const draft = {
      id: "search-work-1",
      knowledgeBaseId: "kb-search-state",
      epoch: 1,
      generationId: "generation-search-state",
      maintenanceRequestId: null,
      indexKind: "content" as const,
      workKind: "documents" as const,
      batchOrdinal: 0,
      payloadChecksum,
      documentCount: 2,
      compressedBytes: 128,
      taskCorrelation: "search-work-1",
      maxAttempts: 3
    };

    await expect(repository.createWork([draft])).resolves.toBe(1);
    await expect(repository.createWork([draft])).resolves.toBe(0);

    await expect(repository.claimWork({
      workerId: "maintenance-worker",
      leaseTokenPrefix: "pressure-lease",
      limit: 1,
      maxInFlightTasks: 8,
      allowNewSubmissions: false,
      now: "2099-07-29T00:00:30.000Z",
      leaseExpiresAt: "2099-07-29T00:10:30.000Z"
    })).resolves.toEqual([]);

    const claimed = await repository.claimWork({
      workerId: "maintenance-worker",
      leaseTokenPrefix: "lease",
      limit: 1,
      maxInFlightTasks: 8,
      allowNewSubmissions: true,
      now: "2099-07-29T00:01:00.000Z",
      leaseExpiresAt: "2099-07-29T00:11:00.000Z"
    });
    expect(claimed).toHaveLength(1);
    expect(await repository.markSubmitted({
      work: claimed[0]!,
      taskUid: 42,
      submittedAt: "2099-07-29T00:01:01.000Z",
      leaseExpiresAt: "2099-07-29T00:11:01.000Z"
    })).toBe(true);

    await expect(repository.createWork([{
      ...draft,
      id: "search-work-2",
      batchOrdinal: 1,
      payloadChecksum: createHash("sha256").update("batch-2").digest("hex"),
      taskCorrelation: "search-work-2"
    }])).resolves.toBe(1);

    const pressurePolled = await repository.claimWork({
      workerId: "maintenance-worker",
      leaseTokenPrefix: "pressure-poll-lease",
      limit: 2,
      maxInFlightTasks: 8,
      allowNewSubmissions: false,
      now: "2099-07-29T00:01:01.500Z",
      leaseExpiresAt: "2099-07-29T00:11:01.500Z"
    });
    expect(pressurePolled).toEqual([
      expect.objectContaining({
        id: "search-work-1",
        state: "submitted",
        taskUid: 42
      })
    ]);

    const concurrentClaim = await repository.claimWork({
      workerId: "maintenance-worker",
      leaseTokenPrefix: "concurrent-lease",
      limit: 2,
      maxInFlightTasks: 2,
      allowNewSubmissions: true,
      now: "2099-07-29T00:11:02.000Z",
      leaseExpiresAt: "2099-07-29T00:21:02.000Z"
    });
    expect(concurrentClaim).toEqual([
      expect.objectContaining({
        id: "search-work-1",
        state: "submitted",
        taskUid: 42
      }),
      expect.objectContaining({
        id: "search-work-2",
        state: "queued",
        taskUid: null
      })
    ]);

    expect(await repository.markSucceeded({
      work: concurrentClaim[1]!,
      completedAt: "2099-07-29T00:11:03.000Z"
    })).toBe(true);

    const submitted = {
      ...concurrentClaim[0]!,
      state: "submitted" as const,
      taskUid: 42
    };
    expect(await repository.markSucceeded({
      work: submitted,
      completedAt: "2099-07-29T00:01:02.000Z"
    })).toBe(true);

    const rows = await sql<Array<{
      state: string;
      task_uid: number;
      attempt_count: number;
    }>>`
      SELECT state, task_uid::int AS task_uid, attempt_count
      FROM focowiki.search_projection_work
      WHERE id = 'search-work-1'
    `;
    expect(rows[0]).toEqual({
      state: "succeeded",
      task_uid: 42,
      attempt_count: 0
    });
  });

  it("persists retry and terminal timestamps as timestamptz values", async () => {
    await sql`
      INSERT INTO focowiki.knowledge_bases (id, name)
      VALUES ('kb-search-retry', 'Search retry state')
    `;
    await sql`
      INSERT INTO focowiki.publication_generations (
        id, knowledge_base_id, predecessor_generation_id, state,
        format_version, generation_kind, activated_at
      ) VALUES (
        'generation-search-retry', 'kb-search-retry', NULL, 'active',
        2, 'normal', now()
      )
    `;
    await sql`
      UPDATE focowiki.knowledge_bases
      SET active_generation_id = 'generation-search-retry'
      WHERE id = 'kb-search-retry'
    `;
    await expect(repository.reservePendingEpoch({
      knowledgeBaseId: "kb-search-retry",
      generationId: "generation-search-retry",
      maintenanceRequestId: null,
      contract: searchContract(),
      reservedAt: "2099-07-29T00:20:00.000Z"
    })).resolves.toMatchObject({
      outcome: "reserved",
      state: { pendingEpoch: 1 }
    });

    const payloadChecksum = createHash("sha256")
      .update("retry-transition")
      .digest("hex");
    await expect(repository.createWork([{
      id: "search-work-retry-transition",
      knowledgeBaseId: "kb-search-retry",
      epoch: 1,
      generationId: "generation-search-retry",
      maintenanceRequestId: null,
      indexKind: "content",
      workKind: "documents",
      batchOrdinal: 2,
      payloadChecksum,
      documentCount: 1,
      compressedBytes: 128,
      taskCorrelation: "search-work-retry-transition",
      maxAttempts: 2
    }])).resolves.toBe(1);

    const firstClaim = await repository.claimWork({
      workerId: "maintenance-worker",
      leaseTokenPrefix: "retry-transition-lease",
      limit: 1,
      maxInFlightTasks: 8,
      allowNewSubmissions: true,
      now: "2099-07-29T00:21:00.000Z",
      leaseExpiresAt: "2099-07-29T00:31:00.000Z"
    });
    expect(firstClaim).toEqual([
      expect.objectContaining({ id: "search-work-retry-transition" })
    ]);
    await expect(repository.retryOrFail({
      work: firstClaim[0]!,
      code: "SEARCH_INDEX_TASK_FAILED",
      message: "Search indexing task did not complete",
      retryAt: "2099-07-29T00:21:02.000Z",
      failedAt: "2099-07-29T00:21:01.000Z"
    })).resolves.toBe("retry");

    const secondClaim = await repository.claimWork({
      workerId: "maintenance-worker",
      leaseTokenPrefix: "retry-transition-terminal-lease",
      limit: 1,
      maxInFlightTasks: 8,
      allowNewSubmissions: true,
      now: "2099-07-29T00:21:03.000Z",
      leaseExpiresAt: "2099-07-29T00:31:03.000Z"
    });
    expect(secondClaim).toEqual([
      expect.objectContaining({ id: "search-work-retry-transition" })
    ]);
    await expect(repository.retryOrFail({
      work: secondClaim[0]!,
      code: "SEARCH_INDEX_TASK_FAILED",
      message: "Search indexing task did not complete",
      retryAt: "2099-07-29T00:21:05.000Z",
      failedAt: "2099-07-29T00:21:04.000Z"
    })).resolves.toBe("failed");

    const rows = await sql<Array<{
      state: string;
      run_after: Date;
      completed_at: Date;
    }>>`
      SELECT state, run_after, completed_at
      FROM focowiki.search_projection_work
      WHERE id = 'search-work-retry-transition'
    `;
    expect(rows[0]?.state).toBe("failed");
    expect(rows[0]?.run_after.toISOString()).toBe("2099-07-29T00:21:02.000Z");
    expect(rows[0]?.completed_at.toISOString()).toBe(
      "2099-07-29T00:21:04.000Z"
    );
  });

  it("activates only complete work and permits the next contiguous epoch", async () => {
    const checksum = "a".repeat(64);
    await expect(repository.activateEpoch({
      knowledgeBaseId: "kb-search-state",
      generationId: "generation-search-state",
      epoch: 1,
      contentSchemaVersion: "content-v1",
      graphSchemaVersion: "graph-v1",
      contentSettingsChecksum: checksum,
      graphSettingsChecksum: checksum,
      activatedAt: "2099-07-29T00:01:59.000Z"
    })).resolves.toBe(false);
    await expect(repository.beginActivation({
      knowledgeBaseId: "kb-search-state",
      generationId: "generation-search-state",
      epoch: 1,
      startedAt: "2099-07-29T00:01:59.500Z"
    })).resolves.toBe(true);
    await expect(repository.activateEpoch({
      knowledgeBaseId: "kb-search-state",
      generationId: "generation-search-state",
      epoch: 1,
      contentSchemaVersion: "content-v1",
      graphSchemaVersion: "graph-v1",
      contentSettingsChecksum: checksum,
      graphSettingsChecksum: checksum,
      activatedAt: "2099-07-29T00:02:00.000Z"
    })).resolves.toBe(true);
    await expect(repository.getState("kb-search-state")).resolves.toMatchObject({
      routeState: "meilisearch",
      activeEpoch: 1,
      pendingEpoch: null,
      pendingActivationState: "indexing",
      maintenanceRequired: false
    });

    const cleanupChecksum = createHash("sha256")
      .update("active-cleanup")
      .digest("hex");
    await expect(repository.createWork([{
      id: "search-work-active-cleanup",
      knowledgeBaseId: "kb-search-state",
      epoch: 1,
      generationId: "generation-search-state",
      maintenanceRequestId: null,
      indexKind: "content",
      workKind: "cleanup",
      batchOrdinal: 0,
      payloadChecksum: cleanupChecksum,
      documentCount: 0,
      compressedBytes: 0,
      taskCorrelation: "search-work-active-cleanup",
      maxAttempts: 3
    }])).resolves.toBe(1);
    const cleanup = await repository.claimWork({
      workerId: "maintenance-worker",
      leaseTokenPrefix: "active-cleanup-lease",
      limit: 1,
      maxInFlightTasks: 8,
      allowNewSubmissions: true,
      now: "2099-07-29T00:02:30.000Z",
      leaseExpiresAt: "2099-07-29T00:12:30.000Z"
    });
    expect(cleanup).toEqual([
      expect.objectContaining({
        id: "search-work-active-cleanup",
        workKind: "cleanup"
      })
    ]);
    expect(await repository.markSucceeded({
      work: cleanup[0]!,
      completedAt: "2099-07-29T00:02:31.000Z"
    })).toBe(true);

    await expect(repository.reservePendingEpoch({
      knowledgeBaseId: "kb-search-state",
      generationId: "generation-search-state",
      maintenanceRequestId: null,
      contract: searchContract(),
      reservedAt: "2099-07-29T00:03:00.000Z"
    })).resolves.toMatchObject({
      outcome: "reserved",
      state: {
        activeEpoch: 1,
        pendingEpoch: 2
      }
    });
  });

  it("claims cleanup after terminal candidate failure", async () => {
    const failedChecksum = createHash("sha256")
      .update("terminal-failure")
      .digest("hex");
    const cleanupChecksum = createHash("sha256")
      .update("terminal-cleanup")
      .digest("hex");
    await repository.createWork([
      {
        id: "search-work-terminal-failure",
        knowledgeBaseId: "kb-search-state",
        epoch: 2,
        generationId: "generation-search-state",
        maintenanceRequestId: null,
        indexKind: "content",
        workKind: "documents",
        batchOrdinal: 0,
        payloadChecksum: failedChecksum,
        documentCount: 1,
        compressedBytes: 128,
        taskCorrelation: "search-work-terminal-failure",
        maxAttempts: 1
      },
      {
        id: "search-work-terminal-cleanup",
        knowledgeBaseId: "kb-search-state",
        epoch: 2,
        generationId: "generation-search-state",
        maintenanceRequestId: null,
        indexKind: "content",
        workKind: "cleanup",
        batchOrdinal: 0,
        payloadChecksum: cleanupChecksum,
        documentCount: 0,
        compressedBytes: 0,
        taskCorrelation: "search-work-terminal-cleanup",
        maxAttempts: 3
      }
    ]);
    await sql`
      UPDATE focowiki.search_projection_work
      SET state = 'failed',
          attempt_count = 1,
          safe_error_code = 'SEARCH_INDEX_TASK_FAILED',
          safe_error_message = 'Search indexing is temporarily unavailable',
          completed_at = now()
      WHERE id = 'search-work-terminal-failure'
    `;

    const claimed = await repository.claimWork({
      workerId: "maintenance-worker",
      leaseTokenPrefix: "cleanup-lease",
      limit: 1,
      maxInFlightTasks: 8,
      allowNewSubmissions: true,
      now: "2099-07-29T00:04:00.000Z",
      leaseExpiresAt: "2099-07-29T00:14:00.000Z"
    });

    expect(claimed).toHaveLength(1);
    expect(claimed[0]).toMatchObject({
      id: "search-work-terminal-cleanup",
      workKind: "cleanup"
    });
    expect(await repository.markSucceeded({
      work: claimed[0]!,
      completedAt: "2099-07-29T00:04:01.000Z"
    })).toBe(true);
    await expect(repository.restartFailedEpoch({
      knowledgeBaseId: "kb-search-state",
      generationId: "generation-search-state",
      maintenanceRequestId: null,
      epoch: 2,
      resetAll: false,
      maxAttempts: 3,
      contract: searchContract(),
      restartedAt: "2099-07-29T00:04:02.000Z"
    })).resolves.toBe(true);

    const restarted = await sql<Array<{
      id: string;
      state: string;
      attempt_count: number;
      task_uid: number | null;
    }>>`
      SELECT id, state, attempt_count, task_uid::int AS task_uid
      FROM focowiki.search_projection_work
      WHERE id IN (
        'search-work-terminal-failure',
        'search-work-terminal-cleanup'
      )
      ORDER BY id
    `;
    expect(restarted).toEqual([
      {
        id: "search-work-terminal-cleanup",
        state: "queued",
        attempt_count: 0,
        task_uid: null
      },
      {
        id: "search-work-terminal-failure",
        state: "queued",
        attempt_count: 0,
        task_uid: null
      }
    ]);
  });

  it("rebases a failed candidate onto a newer generation without skipping the epoch", async () => {
    await sql`
      INSERT INTO focowiki.publication_generations (
        id, knowledge_base_id, predecessor_generation_id, state,
        format_version, generation_kind, frozen_at
      ) VALUES (
        'generation-search-next', 'kb-search-state',
        'generation-search-state', 'frozen', 2, 'normal', now()
      )
    `;
    await sql`
      UPDATE focowiki.search_projection_work
      SET state = CASE
            WHEN work_kind = 'cleanup' THEN 'succeeded'
            ELSE 'failed'
          END,
          completed_at = now(),
          safe_error_code = CASE
            WHEN work_kind = 'cleanup' THEN NULL
            ELSE 'SEARCH_INDEX_TASK_FAILED'
          END,
          safe_error_message = CASE
            WHEN work_kind = 'cleanup' THEN NULL
            ELSE 'Search indexing is temporarily unavailable'
          END
      WHERE knowledge_base_id = 'kb-search-state'
        AND epoch = 2
        AND generation_id = 'generation-search-state'
    `;

    const rebased = await repository.rebaseFailedEpoch({
      knowledgeBaseId: "kb-search-state",
      generationId: "generation-search-next",
      maintenanceRequestId: null,
      epoch: 2,
      maxAttempts: 3,
      contract: searchContract(),
      rebasedAt: "2099-07-29T00:05:00.000Z"
    });
    expect(rebased).toMatchObject({
      activeEpoch: 1,
      pendingEpoch: 2,
      pendingGenerationId: "generation-search-next",
      pendingFullRebuild: true
    });
    await expect(repository.getEpochProgress({
      knowledgeBaseId: "kb-search-state",
      epoch: 2
    })).resolves.toMatchObject({
      total: 0,
      superseded: 0
    });

    const duplicatePayload = createHash("sha256")
      .update("terminal-failure")
      .digest("hex");
    await expect(repository.createWork([{
      id: "search-work-rebased-generation",
      knowledgeBaseId: "kb-search-state",
      epoch: 2,
      generationId: "generation-search-next",
      maintenanceRequestId: null,
      indexKind: "content",
      workKind: "documents",
      batchOrdinal: 0,
      payloadChecksum: duplicatePayload,
      documentCount: 1,
      compressedBytes: 128,
      taskCorrelation: "search-work-rebased-generation",
      maxAttempts: 3
    }])).resolves.toBe(1);

    const claimed = await repository.claimWork({
      workerId: "maintenance-worker",
      leaseTokenPrefix: "rebased-lease",
      limit: 1,
      maxInFlightTasks: 8,
      allowNewSubmissions: true,
      now: "2099-07-29T00:06:00.000Z",
      leaseExpiresAt: "2099-07-29T00:16:00.000Z"
    });
    expect(claimed).toHaveLength(1);
    expect(claimed[0]).toMatchObject({
      id: "search-work-rebased-generation",
      generationId: "generation-search-next",
      epoch: 2
    });
  });
});

function databaseConnectionUrl(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll("\"", "\"\"")}"`;
}

function searchContract() {
  return {
    contentSchemaVersion: "content-v1",
    graphSchemaVersion: "graph-v1",
    contentSettingsChecksum: "a".repeat(64),
    graphSettingsChecksum: "b".repeat(64)
  };
}
