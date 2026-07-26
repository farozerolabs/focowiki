import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type {
  LexicalRebuildSettingsSnapshot,
  LexicalRebuildWorkClaim
} from "../src/application/ports/lexical-rebuild-work-repository.js";
import { applyMigrations } from "../src/db/migrations.js";
import { createPostgresLexicalRebuildRepository } from "../src/infrastructure/postgres/lexical-rebuild-repository.js";
import { createPostgresLexicalRebuildWorkRepository } from "../src/infrastructure/postgres/lexical-rebuild-work-repository.js";
import { deriveLexicalProjections } from "../src/maintenance/lexical-projection-derivation.js";
import { runLexicalRebuildFinalization } from "../src/maintenance/lexical-rebuild-finalization.js";

const databaseUrl = process.env.FOCOWIKI_TEST_DATABASE_URL;
const describeDatabase = databaseUrl ? describe : describe.skip;
const settings: LexicalRebuildSettingsSnapshot = {
  concurrency: 4,
  sourceReadConcurrency: 8,
  databaseWriteConcurrency: 2,
  claimBatchSize: 500,
  databaseBatchSize: 50,
  maxInFlightSourceBytes: 64 * 1_024 * 1_024
};

describeDatabase("lexical rebuild work repository integration", () => {
  const connectionUrl = databaseUrl ?? "postgres://unused:unused@127.0.0.1:5432/unused";
  const databaseName = `focowiki_lexical_work_${process.pid}_${
    randomUUID().replaceAll("-", "").slice(0, 10)
  }`;
  const admin = postgres(databaseConnectionUrl(connectionUrl, "postgres"), { max: 1 });
  const sql = postgres(databaseConnectionUrl(connectionUrl, databaseName), { max: 8 });
  const repository = createPostgresLexicalRebuildWorkRepository(sql);
  const rebuilds = createPostgresLexicalRebuildRepository(sql);

  beforeAll(async () => {
    await admin.unsafe(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
    await applyMigrations(sql);
  });

  beforeEach(async () => {
    await sql`DELETE FROM focowiki.knowledge_bases WHERE id LIKE 'kb-work-%'`;
  });

  afterAll(async () => {
    await sql.end({ timeout: 5 });
    await admin.unsafe(`DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)} WITH (FORCE)`);
    await admin.end({ timeout: 5 });
  });

  it("plans an unstarted rebuild from the current active generation", async () => {
    const knowledgeBaseId = "kb-work-stale-base";
    const staleGenerationId = "generation-kb-work-stale-base-old";
    const activeGenerationId = "generation-kb-work-stale-base-active";
    const targetGenerationId = "generation-kb-work-stale-base-target";
    await sql.begin(async (transaction) => {
      await transaction`
        INSERT INTO focowiki.knowledge_bases (id, name)
        VALUES (${knowledgeBaseId}, 'Stale lexical base')
      `;
      await transaction`
        INSERT INTO focowiki.publication_generations (
          id, knowledge_base_id, predecessor_generation_id,
          state, format_version, generation_kind, activated_at
        ) VALUES (
          ${staleGenerationId}, ${knowledgeBaseId}, NULL,
          'active', 2, 'normal', '2026-07-25T00:00:00.000Z'
        )
      `;
      await transaction`
        UPDATE focowiki.knowledge_bases
        SET active_generation_id = ${staleGenerationId}
        WHERE id = ${knowledgeBaseId}
      `;
      await transaction`
        INSERT INTO focowiki.knowledge_base_lexical_rebuilds (
          knowledge_base_id, target_search_schema_version,
          target_tokenizer_contract_version, target_segmentation_version,
          target_content_profile_version,
          target_graph_lexical_projection_version,
          base_generation_id, state, phase, next_attempt_at,
          settings_revision, settings_snapshot_json, updated_at
        ) VALUES (
          ${knowledgeBaseId}, 'body-search-v1', 'tokenizer-work-v1',
          'body-segmentation-v1', 'content-profile-v2', 'graph-lexical-v2',
          ${staleGenerationId}, 'pending', 'documents',
          '2026-07-25T00:00:00.000Z', 1,
          ${transaction.json(settings as never)}, '2026-07-25T00:00:00.000Z'
        )
      `;
      await transaction`
        UPDATE focowiki.publication_generations
        SET state = 'superseded', successor_generation_id = ${activeGenerationId}
        WHERE id = ${staleGenerationId}
      `;
      await transaction`
        INSERT INTO focowiki.publication_generations (
          id, knowledge_base_id, predecessor_generation_id,
          state, format_version, generation_kind, activated_at
        ) VALUES (
          ${activeGenerationId}, ${knowledgeBaseId}, ${staleGenerationId},
          'active', 2, 'normal', '2026-07-25T00:01:00.000Z'
        )
      `;
      await transaction`
        UPDATE focowiki.knowledge_bases
        SET active_generation_id = ${activeGenerationId}
        WHERE id = ${knowledgeBaseId}
      `;
    });

    await expect(repository.planNext({
      targetGenerationId,
      settingsRevision: 2,
      settings,
      maxAttempts: 3,
      now: "2026-07-25T00:02:00.000Z"
    })).resolves.toMatchObject({
      knowledgeBaseId,
      targetGenerationId,
      readyForValidation: true
    });

    expect((await sql<Array<{
      base_generation_id: string;
      predecessor_generation_id: string;
    }>>`
      SELECT rebuild.base_generation_id, target.predecessor_generation_id
      FROM focowiki.knowledge_base_lexical_rebuilds rebuild
      JOIN focowiki.publication_generations target
        ON target.id = rebuild.target_generation_id
      WHERE rebuild.knowledge_base_id = ${knowledgeBaseId}
    `)[0]).toEqual({
      base_generation_id: activeGenerationId,
      predecessor_generation_id: activeGenerationId
    });
  });

  it("claims fairly across knowledge bases without duplicate active leases", async () => {
    await seedWork("kb-work-a", 3);
    await seedWork("kb-work-b", 3);

    const first = await claimBatch("worker-first", 2, "2026-07-25T00:00:00.000Z");
    expect(first).toHaveLength(2);
    expect(new Set(first.map((claim) => claim.knowledgeBaseId))).toEqual(
      new Set(["kb-work-a", "kb-work-b"])
    );

    const [second, third] = await Promise.all([
      claimBatch("worker-second", 2, "2026-07-25T00:00:01.000Z"),
      claimBatch("worker-third", 2, "2026-07-25T00:00:01.000Z")
    ]);
    const concurrentlyClaimed = [...second, ...third];
    expect(concurrentlyClaimed).toHaveLength(4);
    expect(new Set(
      concurrentlyClaimed.map((claim) =>
        `${claim.targetGenerationId}:${claim.sourceFileId}`
      )
    )).toHaveLength(4);

    expect(await sql<Array<{
      knowledge_base_id: string;
      pending_source_count: number;
      running_source_count: number;
    }>>`
      SELECT knowledge_base_id,
             pending_source_count::int AS pending_source_count,
             running_source_count::int AS running_source_count
      FROM focowiki.knowledge_base_lexical_rebuilds
      WHERE knowledge_base_id IN ('kb-work-a', 'kb-work-b')
      ORDER BY knowledge_base_id
    `).toEqual([
      {
        knowledge_base_id: "kb-work-a",
        pending_source_count: 0,
        running_source_count: 3
      },
      {
        knowledge_base_id: "kb-work-b",
        pending_source_count: 0,
        running_source_count: 3
      }
    ]);
  });

  it.each([1, 2, 4])(
    "distributes one knowledge base safely across %i worker replicas",
    async (replicaCount) => {
      const knowledgeBaseId = `kb-work-replicas-${replicaCount}`;
      await seedWork(knowledgeBaseId, replicaCount * 8);

      const claims = (await Promise.all(
        Array.from({ length: replicaCount }, (_, index) =>
          claimBatch(
            `worker-replica-${replicaCount}-${index}`,
            8,
            "2026-07-25T00:00:00.000Z"
          )
        )
      )).flat();

      expect(claims).toHaveLength(replicaCount * 8);
      expect(new Set(claims.map((claim) =>
        `${claim.targetGenerationId}:${claim.sourceFileId}`
      )).size).toBe(replicaCount * 8);
      expect((await sql<Array<{ running_count: number }>>`
        SELECT count(*)::int AS running_count
        FROM focowiki.lexical_rebuild_work_items
        WHERE knowledge_base_id = ${knowledgeBaseId}
          AND state = 'running'
      `)[0]?.running_count).toBe(replicaCount * 8);
    }
  );

  it("reclaims an expired lease and leaves an unexpired lease untouched", async () => {
    await seedWork("kb-work-lease", 2);
    await sql`
      UPDATE focowiki.lexical_rebuild_work_items
      SET state = 'running',
          lease_owner = 'legacy-worker',
          lease_token = 'legacy-expired',
          lease_expires_at = '2026-07-25T00:00:00.000Z',
          heartbeat_at = '2026-07-24T23:59:00.000Z'
      WHERE knowledge_base_id = 'kb-work-lease'
        AND source_file_id = 'source-kb-work-lease-0'
    `;
    await sql`
      UPDATE focowiki.lexical_rebuild_work_items
      SET state = 'running',
          lease_owner = 'legacy-worker',
          lease_token = 'legacy-active',
          lease_expires_at = '2026-07-25T01:00:00.000Z',
          heartbeat_at = '2026-07-25T00:00:00.000Z'
      WHERE knowledge_base_id = 'kb-work-lease'
        AND source_file_id = 'source-kb-work-lease-1'
    `;

    const claimed = await claimBatch(
      "worker-recovery",
      2,
      "2026-07-25T00:00:10.000Z"
    );

    expect(claimed.map((claim) => claim.sourceFileId)).toEqual([
      "source-kb-work-lease-0"
    ]);
    expect((await sql<Array<{ lease_token: string }>>`
      SELECT lease_token
      FROM focowiki.lexical_rebuild_work_items
      WHERE knowledge_base_id = 'kb-work-lease'
        AND source_file_id = 'source-kb-work-lease-1'
    `)[0]?.lease_token).toBe("legacy-active");
  });

  it("keeps active claims on their settings snapshot and applies new settings to later claims", async () => {
    const knowledgeBaseId = "kb-work-settings-revision";
    const updatedSettings: LexicalRebuildSettingsSnapshot = {
      ...settings,
      sourceReadConcurrency: 12,
      databaseWriteConcurrency: 3,
      databaseBatchSize: 80
    };
    await seedWork(knowledgeBaseId, 2);

    const first = await repository.claimBatch({
      workerId: "worker-settings-first",
      leaseTokenPrefix: "lease-settings-first",
      limit: 1,
      settingsRevision: 1,
      settings,
      now: "2026-07-25T00:00:00.000Z",
      leaseExpiresAt: "2026-07-25T00:05:00.000Z"
    });
    const second = await repository.claimBatch({
      workerId: "worker-settings-second",
      leaseTokenPrefix: "lease-settings-second",
      limit: 1,
      settingsRevision: 2,
      settings: updatedSettings,
      now: "2026-07-25T00:00:01.000Z",
      leaseExpiresAt: "2026-07-25T00:05:01.000Z"
    });

    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
    expect(first[0]).toMatchObject({
      settingsRevision: 1,
      settings
    });
    expect(second[0]).toMatchObject({
      settingsRevision: 2,
      settings: updatedSettings
    });
    expect(await sql<Array<{
      source_file_id: string;
      settings_revision: number;
      settings_snapshot_json: LexicalRebuildSettingsSnapshot;
    }>>`
      SELECT source_file_id,
             settings_revision::int AS settings_revision,
             settings_snapshot_json
      FROM focowiki.lexical_rebuild_work_items
      WHERE knowledge_base_id = ${knowledgeBaseId}
      ORDER BY source_file_id
    `).toEqual([
      {
        source_file_id: first[0]!.sourceFileId,
        settings_revision: 1,
        settings_snapshot_json: settings
      },
      {
        source_file_id: second[0]!.sourceFileId,
        settings_revision: 2,
        settings_snapshot_json: updatedSettings
      }
    ].sort((left, right) => left.source_file_id.localeCompare(right.source_file_id)));
  });

  it("applies retry idempotently and isolates a terminal source failure", async () => {
    await seedWork("kb-work-retry", 2);
    await sql`
      UPDATE focowiki.lexical_rebuild_work_items
      SET max_attempts = 1
      WHERE knowledge_base_id = 'kb-work-retry'
        AND source_file_id = 'source-kb-work-retry-0'
    `;
    const claimed = await claimBatch(
      "worker-retry",
      2,
      "2026-07-25T00:00:00.000Z"
    );
    const failed = claimed.find(
      (claim) => claim.sourceFileId === "source-kb-work-retry-0"
    )!;

    const retryInput = {
      workerId: "worker-retry",
      claims: [failed],
      stage: "source_read" as const,
      errorCode: "LEXICAL_SOURCE_READ_TIMEOUT",
      errorMessage: "The source object read timed out",
      failedAt: "2026-07-25T00:00:10.000Z",
      retryDelayMs: 1_000
    };
    await repository.retry(retryInput);
    await repository.retry(retryInput);

    expect(await sql<Array<{
      source_file_id: string;
      state: string;
      attempt_count: number;
      source_read_retry_count: number;
    }>>`
      SELECT source_file_id, state, attempt_count, source_read_retry_count
      FROM focowiki.lexical_rebuild_work_items
      WHERE knowledge_base_id = 'kb-work-retry'
      ORDER BY source_file_id
    `).toEqual([
      {
        source_file_id: "source-kb-work-retry-0",
        state: "failed",
        attempt_count: 1,
        source_read_retry_count: 1
      },
      {
        source_file_id: "source-kb-work-retry-1",
        state: "running",
        attempt_count: 0,
        source_read_retry_count: 0
      }
    ]);
    expect((await sql<Array<{
      failed_source_count: number;
      running_source_count: number;
      source_read_retry_count: number;
    }>>`
      SELECT failed_source_count::int AS failed_source_count,
             running_source_count::int AS running_source_count,
             source_read_retry_count::int AS source_read_retry_count
      FROM focowiki.knowledge_base_lexical_rebuilds
      WHERE knowledge_base_id = 'kb-work-retry'
    `)[0]).toEqual({
      failed_source_count: 1,
      running_source_count: 1,
      source_read_retry_count: 1
    });
  });

  it("commits projections and completion together and rolls both back after ownership loss", async () => {
    await seedWork("kb-work-atomic", 2);
    const claims = await claimBatch(
      "worker-atomic",
      2,
      "2026-07-25T00:00:00.000Z"
    );
    const sources = await repository.loadSources(claims);
    const results = sources.map((source) =>
      deriveLexicalProjections({
        read: {
          source,
          body: `# ${source.title}\n\nSearchable source evidence.`,
          bytes: source.sizeBytes,
          latencyMs: 2,
          retryCount: source.sourceFileId.endsWith("-0") ? 1 : 0,
          release() {}
        },
        tokenizer: {
          contractVersion: "tokenizer-work-v1",
          tokenizeDocument(value, limit) {
            return (value.toLowerCase().match(/[a-z0-9-]+/gu) ?? [])
              .slice(0, limit);
          },
          tokenizeQuery(value, limit) {
            return this.tokenizeDocument(value, limit);
          }
        }
      })
    );
    const successful = results[0]!;
    const ownershipLost = results[1]!;
    await repository.persistBatch({
      workerId: "worker-atomic",
      results: [successful],
      completedAt: "2026-07-25T00:00:05.000Z"
    });
    await sql`
      UPDATE focowiki.lexical_rebuild_work_items
      SET lease_token = 'replaced-lease'
      WHERE target_generation_id = ${ownershipLost.claim.targetGenerationId}
        AND source_file_id = ${ownershipLost.claim.sourceFileId}
    `;

    await expect(repository.persistBatch({
      workerId: "worker-atomic",
      results: [ownershipLost],
      completedAt: "2026-07-25T00:00:06.000Z"
    })).rejects.toThrow(/ownership changed/u);

    expect((await sql<Array<{
      completed_items: number;
      persisted_documents: number;
      source_read_retries: number;
    }>>`
      SELECT
        count(*) FILTER (WHERE item.state = 'completed')::int
          AS completed_items,
        (
          SELECT count(*)::int
          FROM focowiki.search_projection_documents document
          WHERE document.knowledge_base_id = 'kb-work-atomic'
        ) AS persisted_documents,
        coalesce(sum(item.source_read_retry_count), 0)::int
          AS source_read_retries
      FROM focowiki.lexical_rebuild_work_items item
      WHERE item.knowledge_base_id = 'kb-work-atomic'
    `)[0]).toEqual({
      completed_items: 1,
      persisted_documents: 1,
      source_read_retries: 1
    });
    expect((await sql<Array<{
      processed_source_count: number;
      running_source_count: number;
      source_read_retry_count: number;
    }>>`
      SELECT processed_source_count::int AS processed_source_count,
             running_source_count::int AS running_source_count,
             source_read_retry_count::int AS source_read_retry_count
      FROM focowiki.knowledge_base_lexical_rebuilds
      WHERE knowledge_base_id = 'kb-work-atomic'
    `)[0]).toEqual({
      processed_source_count: 1,
      running_source_count: 1,
      source_read_retry_count: 1
    });
  });

  it("rebases a completed candidate without rereading or resetting completed sources", async () => {
    const knowledgeBaseId = "kb-work-rebase";
    const baseGenerationId = "generation-kb-work-rebase-base";
    const targetGenerationId = "generation-kb-work-rebase-target";
    const nextGenerationId = "generation-kb-work-rebase-next";
    await seedWork(knowledgeBaseId, 2);
    await sql`
      UPDATE focowiki.lexical_rebuild_work_items
      SET state = 'completed', completed_at = '2026-07-25T03:00:00.000Z'
      WHERE knowledge_base_id = ${knowledgeBaseId}
    `;
    await sql`
      UPDATE focowiki.knowledge_base_lexical_rebuilds
      SET state = 'activating',
          phase = 'activate',
          processed_source_count = 2,
          pending_source_count = 0,
          running_source_count = 0,
          total_source_count = 2,
          lease_owner = 'worker-rebase',
          lease_token = 'lease-rebase',
          lease_expires_at = '2099-07-25T03:05:00.000Z'
      WHERE knowledge_base_id = ${knowledgeBaseId}
    `;
    await sql.begin(async (transaction) => {
      await transaction`
        UPDATE focowiki.publication_generations
        SET state = 'superseded',
            successor_generation_id = ${nextGenerationId}
        WHERE knowledge_base_id = ${knowledgeBaseId}
          AND id = ${baseGenerationId}
      `;
      await transaction`
        INSERT INTO focowiki.publication_generations (
          id, knowledge_base_id, predecessor_generation_id,
          state, format_version, generation_kind, activated_at
        ) VALUES (
          ${nextGenerationId}, ${knowledgeBaseId}, ${baseGenerationId},
          'active', 2, 'normal', '2026-07-25T03:00:00.000Z'
        )
      `;
      await transaction`
        UPDATE focowiki.knowledge_bases
        SET active_generation_id = ${nextGenerationId}
        WHERE id = ${knowledgeBaseId}
      `;
    });

    await expect(rebuilds.activate({
      knowledgeBaseId,
      workerId: "worker-rebase",
      leaseToken: "lease-rebase",
      activatedAt: "2026-07-25T03:01:00.000Z",
      retryDelayMs: 1_000
    })).resolves.toBe("rebased");

    expect((await sql<Array<{
      base_generation_id: string;
      target_generation_id: string;
      state: string;
      phase: string;
      processed_source_count: number;
      total_source_count: number;
    }>>`
      SELECT base_generation_id, target_generation_id, state, phase,
             processed_source_count::int AS processed_source_count,
             total_source_count::int AS total_source_count
      FROM focowiki.knowledge_base_lexical_rebuilds
      WHERE knowledge_base_id = ${knowledgeBaseId}
    `)[0]).toEqual({
      base_generation_id: nextGenerationId,
      target_generation_id: targetGenerationId,
      state: "pending",
      phase: "validate",
      processed_source_count: 2,
      total_source_count: 2
    });
    expect((await sql<Array<{
      predecessor_generation_id: string;
      completed_work: number;
    }>>`
      SELECT generation.predecessor_generation_id,
             (
               SELECT count(*)::int
               FROM focowiki.lexical_rebuild_work_items item
               WHERE item.knowledge_base_id = ${knowledgeBaseId}
                 AND item.state = 'completed'
             ) AS completed_work
      FROM focowiki.publication_generations generation
      WHERE generation.id = ${targetGenerationId}
    `)[0]).toEqual({
      predecessor_generation_id: nextGenerationId,
      completed_work: 2
    });
  });

  it("defers activation, rebases after forward publication, and activates atomically", async () => {
    const knowledgeBaseId = "kb-work-activation";
    const baseGenerationId = "generation-kb-work-activation-base";
    const targetGenerationId = "generation-kb-work-activation-target";
    const pendingGenerationId = "generation-kb-work-activation-pending";
    await seedWork(knowledgeBaseId, 2);
    await completeAllWork(knowledgeBaseId, "worker-activation");
    await sql`
      INSERT INTO focowiki.knowledge_base_projection_versions (
        knowledge_base_id, projection_kind, format_version,
        input_version, active_generation_id
      ) VALUES
        (${knowledgeBaseId}, 'tree', 2, 2, ${baseGenerationId}),
        (${knowledgeBaseId}, 'directory', 2, 2, ${baseGenerationId}),
        (${knowledgeBaseId}, 'graph', 2, 2, ${baseGenerationId})
    `;
    await sql`
      INSERT INTO focowiki.active_projection_records (
        knowledge_base_id, projection_kind, record_id,
        last_changed_generation_id, shard_key, source_file_id,
        logical_path, sort_key, title, summary, searchable_text,
        payload_json
      ) VALUES
        (
          ${knowledgeBaseId}, 'search',
          'source-kb-work-activation-0', ${baseGenerationId}, 'search:00',
          'source-kb-work-activation-0', 'pages/guides/0.md',
          'pages/guides/0.md', 'stale title', 'stale summary',
          'stale title stale summary',
          '{"id":"source-kb-work-activation-0","summary":"stale summary"}'::jsonb
        ),
        (
          ${knowledgeBaseId}, 'graph_node',
          'source-kb-work-activation-0', ${baseGenerationId}, 'graph_node:00',
          'source-kb-work-activation-0', 'pages/guides/0.md',
          'pages/guides/0.md', 'stale title', 'stale summary',
          'stale title stale summary',
          '{"id":"source-kb-work-activation-0","summary":"stale summary"}'::jsonb
        )
    `;
    await sql`
      INSERT INTO focowiki.publication_generations (
        id, knowledge_base_id, predecessor_generation_id,
        state, format_version, generation_kind
      ) VALUES (
        ${pendingGenerationId}, ${knowledgeBaseId}, ${baseGenerationId},
        'validating', 2, 'normal'
      )
    `;

    expect((await sql<Array<{ state: string; phase: string }>>`
      SELECT state, phase
      FROM focowiki.knowledge_base_lexical_rebuilds
      WHERE knowledge_base_id = ${knowledgeBaseId}
    `)[0]).toEqual({ state: "pending", phase: "validate" });

    expect(await activeGenerationId(knowledgeBaseId)).toBe(baseGenerationId);
    await expect(finalizeOnce("worker-activation", "2026-07-25T04:00:11.000Z"))
      .resolves.toBe(true);
    expect(await activeGenerationId(knowledgeBaseId)).toBe(baseGenerationId);

    await expect(finalizeOnce("worker-activation", "2026-07-25T04:00:12.000Z"))
      .resolves.toBe(true);
    expect(await activeGenerationId(knowledgeBaseId)).toBe(baseGenerationId);
    expect((await sql<Array<{
      state: string;
      phase: string;
      lease_owner: string | null;
    }>>`
      SELECT state, phase, lease_owner
      FROM focowiki.knowledge_base_lexical_rebuilds
      WHERE knowledge_base_id = ${knowledgeBaseId}
    `)[0]).toEqual({
      state: "pending",
      phase: "activate",
      lease_owner: null
    });
    expect((await sql<Array<{ predecessor_generation_id: string }>>`
      SELECT predecessor_generation_id
      FROM focowiki.publication_generations
      WHERE id = ${pendingGenerationId}
    `)[0]?.predecessor_generation_id).toBe(baseGenerationId);

    await sql.begin(async (transaction) => {
      await transaction`
        UPDATE focowiki.publication_generations
        SET state = 'superseded',
            successor_generation_id = ${pendingGenerationId}
        WHERE knowledge_base_id = ${knowledgeBaseId}
          AND id = ${baseGenerationId}
      `;
      await transaction`
        UPDATE focowiki.publication_generations
        SET state = 'active',
            activated_at = '2026-07-25T04:00:12.500Z'
        WHERE knowledge_base_id = ${knowledgeBaseId}
          AND id = ${pendingGenerationId}
      `;
      await transaction`
        UPDATE focowiki.knowledge_bases
        SET active_generation_id = ${pendingGenerationId}
        WHERE id = ${knowledgeBaseId}
      `;
    });

    await expect(finalizeOnce("worker-activation", "2026-07-25T04:00:13.000Z"))
      .resolves.toBe(true);
    expect(await activeGenerationId(knowledgeBaseId)).toBe(pendingGenerationId);
    expect((await sql<Array<{
      base_generation_id: string;
      state: string;
      phase: string;
    }>>`
      SELECT base_generation_id, state, phase
      FROM focowiki.knowledge_base_lexical_rebuilds
      WHERE knowledge_base_id = ${knowledgeBaseId}
    `)[0]).toEqual({
      base_generation_id: pendingGenerationId,
      state: "pending",
      phase: "validate"
    });

    await expect(finalizeOnce("worker-activation", "2026-07-25T04:00:14.000Z"))
      .resolves.toBe(true);
    expect(await activeGenerationId(knowledgeBaseId)).toBe(pendingGenerationId);

    await expect(finalizeOnce("worker-activation", "2026-07-25T04:00:15.000Z"))
      .resolves.toBe(true);
    expect(await activeGenerationId(knowledgeBaseId)).toBe(targetGenerationId);
    expect((await sql<Array<{
      predecessor_generation_id: string;
      state: string;
    }>>`
      SELECT predecessor_generation_id, state
      FROM focowiki.publication_generations
      WHERE id = ${targetGenerationId}
    `)[0]).toEqual({
      predecessor_generation_id: pendingGenerationId,
      state: "active"
    });
    expect(await sql<Array<{ id: string; state: string }>>`
      SELECT id, state
      FROM focowiki.publication_generations
      WHERE knowledge_base_id = ${knowledgeBaseId}
        AND id IN (
          ${baseGenerationId}, ${pendingGenerationId}, ${targetGenerationId}
        )
      ORDER BY id
    `).toEqual([
      { id: baseGenerationId, state: "superseded" },
      { id: pendingGenerationId, state: "superseded" },
      { id: targetGenerationId, state: "active" }
    ]);
    expect(await sql<Array<{
      projection_kind: string;
      summary: string;
      payload_summary: string;
      last_changed_generation_id: string;
    }>>`
      SELECT projection_kind, summary,
             payload_json->>'summary' AS payload_summary,
             last_changed_generation_id
      FROM focowiki.active_projection_records
      WHERE knowledge_base_id = ${knowledgeBaseId}
        AND source_file_id = 'source-kb-work-activation-0'
        AND projection_kind IN ('search', 'graph_node')
      ORDER BY projection_kind
    `).toEqual([
      {
        projection_kind: "graph_node",
        summary: "Complete activation evidence.",
        payload_summary: "Complete activation evidence.",
        last_changed_generation_id: targetGenerationId
      },
      {
        projection_kind: "search",
        summary: "Complete activation evidence.",
        payload_summary: "Complete activation evidence.",
        last_changed_generation_id: targetGenerationId
      }
    ]);
    expect(await sql<Array<{ projection_kind: string; active_generation_id: string }>>`
      SELECT projection_kind, active_generation_id
      FROM focowiki.knowledge_base_projection_versions
      WHERE knowledge_base_id = ${knowledgeBaseId}
      ORDER BY projection_kind
    `).toEqual([
      { projection_kind: "directory", active_generation_id: targetGenerationId },
      { projection_kind: "graph", active_generation_id: targetGenerationId },
      { projection_kind: "tree", active_generation_id: targetGenerationId }
    ]);

    await expect(finalizeOnce("worker-activation", "2026-07-25T04:00:13.000Z"))
      .resolves.toBe(true);
    expect((await sql<Array<{ state: string }>>`
      SELECT state
      FROM focowiki.knowledge_base_lexical_rebuilds
      WHERE knowledge_base_id = ${knowledgeBaseId}
    `)[0]?.state).toBe("completed");
  });

  it("preserves the active generation when accepted-edge parity fails", async () => {
    const knowledgeBaseId = "kb-work-edge-parity";
    const baseGenerationId = "generation-kb-work-edge-parity-base";
    await seedWork(knowledgeBaseId, 1);
    await completeAllWork(knowledgeBaseId, "worker-edge-parity");
    await sql`
      INSERT INTO focowiki.generation_graph_summaries (
        knowledge_base_id, generation_id, node_count, edge_count,
        graph_index_available
      ) VALUES (
        ${knowledgeBaseId}, ${baseGenerationId}, 1, 1, true
      )
    `;
    await expect(finalizeOnce("worker-edge-parity", "2026-07-25T05:00:11.000Z"))
      .resolves.toBe(true);
    expect(await activeGenerationId(knowledgeBaseId)).toBe(baseGenerationId);
    expect((await sql<Array<{
      state: string;
      last_error_code: string;
    }>>`
      SELECT state, last_error_code
      FROM focowiki.knowledge_base_lexical_rebuilds
      WHERE knowledge_base_id = ${knowledgeBaseId}
    `)[0]).toEqual({
      state: "failed",
      last_error_code: "LEXICAL_REBUILD_FINALIZATION_FAILED"
    });
  });

  async function claimBatch(
    workerId: string,
    limit: number,
    now: string
  ): Promise<LexicalRebuildWorkClaim[]> {
    return repository.claimBatch({
      workerId,
      leaseTokenPrefix: `lease-${workerId}`,
      limit,
      settingsRevision: 1,
      settings,
      now,
      leaseExpiresAt: new Date(Date.parse(now) + 60_000).toISOString()
    });
  }

  async function completeAllWork(
    knowledgeBaseId: string,
    workerId: string
  ): Promise<void> {
    const claims = await claimBatch(workerId, 10, "2026-07-25T04:00:00.000Z");
    const owned = claims.filter((claim) => claim.knowledgeBaseId === knowledgeBaseId);
    const sources = await repository.loadSources(owned);
    await repository.persistBatch({
      workerId,
      results: sources.map((source) =>
        deriveLexicalProjections({
          read: {
            source,
            body: `# ${source.title}\n\nComplete activation evidence.`,
            bytes: source.sizeBytes,
            latencyMs: 1,
            retryCount: 0,
            release() {}
          },
          tokenizer: {
            contractVersion: "tokenizer-work-v1",
            tokenizeDocument(value, limit) {
              return (value.toLowerCase().match(/[a-z0-9-]+/gu) ?? [])
                .slice(0, limit);
            },
            tokenizeQuery(value, limit) {
              return this.tokenizeDocument(value, limit);
            }
          }
        })
      ),
      completedAt: "2026-07-25T04:00:05.000Z"
    });
  }

  async function finalizeOnce(workerId: string, now: string): Promise<boolean> {
    return runLexicalRebuildFinalization({
      work: repository,
      rebuilds,
      search: {
        async cleanupUnreferencedDocuments() {
          return 0;
        }
      },
      workerId,
      leaseToken: `finalize-${workerId}-${now}`,
      now: new Date(now),
      leaseDurationMs: 60_000,
      retryDelayMs: 1_000,
      cleanupBatchSize: 50
    });
  }

  async function activeGenerationId(knowledgeBaseId: string): Promise<string | null> {
    return (await sql<Array<{ active_generation_id: string | null }>>`
      SELECT active_generation_id
      FROM focowiki.knowledge_bases
      WHERE id = ${knowledgeBaseId}
    `)[0]?.active_generation_id ?? null;
  }

  async function seedWork(knowledgeBaseId: string, sourceCount: number): Promise<void> {
    const baseGenerationId = `generation-${knowledgeBaseId}-base`;
    const targetGenerationId = `generation-${knowledgeBaseId}-target`;
    await sql.begin(async (transaction) => {
      await transaction`
        INSERT INTO focowiki.knowledge_bases (id, name)
        VALUES (${knowledgeBaseId}, ${knowledgeBaseId})
      `;
      await transaction`
        INSERT INTO focowiki.publication_generations (
          id, knowledge_base_id, predecessor_generation_id,
          state, format_version, generation_kind, activated_at
        ) VALUES
          (
            ${baseGenerationId}, ${knowledgeBaseId}, NULL,
            'active', 2, 'normal', now()
          ),
          (
            ${targetGenerationId}, ${knowledgeBaseId}, ${baseGenerationId},
            'building', 2, 'lexical_rebuild', NULL
          )
      `;
      await transaction`
        UPDATE focowiki.knowledge_bases
        SET active_generation_id = ${baseGenerationId}
        WHERE id = ${knowledgeBaseId}
      `;
      for (let index = 0; index < sourceCount; index += 1) {
        const sourceFileId = `source-${knowledgeBaseId}-${index}`;
        const revisionId = `revision-${knowledgeBaseId}-${index}`;
        const relativePath = `guides/${index}.md`;
        await transaction`
          INSERT INTO focowiki.source_files (
            id, knowledge_base_id, object_key, content_type, size_bytes,
            checksum_sha256, processing_status, processing_stage,
            generated_output_status, name, relative_path, path_key,
            active_revision_id, metadata_json
          ) VALUES (
            ${sourceFileId}, ${knowledgeBaseId}, ${`sources/${sourceFileId}.md`},
            'text/markdown; charset=utf-8', 100, ${"a".repeat(64)},
            'completed', 'generation_activation', 'visible', ${`${index}.md`},
            ${relativePath}, ${relativePath}, ${revisionId},
            ${transaction.json({ title: sourceFileId })}
          )
        `;
        await transaction`
          INSERT INTO focowiki.source_revisions (
            id, knowledge_base_id, source_file_id, revision, object_key,
            content_type, size_bytes, checksum_sha256, processing_status,
            metadata_json
          ) VALUES (
            ${revisionId}, ${knowledgeBaseId}, ${sourceFileId}, 1,
            ${`sources/${sourceFileId}.md`},
            'text/markdown; charset=utf-8', 100, ${"a".repeat(64)},
            'completed', ${transaction.json({ title: sourceFileId })}
          )
        `;
        await transaction`
          INSERT INTO focowiki.lexical_rebuild_work_items (
            knowledge_base_id, target_generation_id, source_file_id,
            source_revision_id, logical_path,
            target_search_schema_version,
            target_tokenizer_contract_version,
            target_segmentation_version,
            target_content_profile_version,
            target_graph_lexical_projection_version,
            state, max_attempts, next_attempt_at,
            settings_revision, settings_snapshot_json
          ) VALUES (
            ${knowledgeBaseId}, ${targetGenerationId}, ${sourceFileId},
            ${revisionId}, ${`pages/${relativePath}`}, 'body-search-v1',
            'tokenizer-work-v1', 'body-segmentation-v1',
            'content-profile-v2', 'graph-lexical-v2', 'pending', 3,
            '2026-07-24T00:00:00.000Z', 1,
            ${transaction.json(settings as never)}
          )
        `;
      }
      await transaction`
        INSERT INTO focowiki.knowledge_base_lexical_rebuilds (
          knowledge_base_id, target_search_schema_version,
          target_tokenizer_contract_version, target_segmentation_version,
          target_content_profile_version,
          target_graph_lexical_projection_version,
          base_generation_id, target_generation_id, state, phase,
          pending_source_count, total_source_count,
          settings_revision, settings_snapshot_json,
          started_at, next_attempt_at, updated_at
        ) VALUES (
          ${knowledgeBaseId}, 'body-search-v1', 'tokenizer-work-v1',
          'body-segmentation-v1', 'content-profile-v2', 'graph-lexical-v2',
          ${baseGenerationId}, ${targetGenerationId}, 'running', 'documents',
          ${sourceCount}, ${sourceCount}, 1,
          ${transaction.json(settings as never)},
          '2026-07-24T00:00:00.000Z', '2026-07-24T00:00:00.000Z',
          '2026-07-24T00:00:00.000Z'
        )
      `;
    });
  }
});

function databaseConnectionUrl(url: string, databaseName: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${databaseName}`;
  return parsed.toString();
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll("\"", "\"\"")}"`;
}
