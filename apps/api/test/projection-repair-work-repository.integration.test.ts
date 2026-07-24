import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { applyMigrations } from "../src/db/migrations.js";
import { createPostgresProjectionRepairBuildRepository } from
  "../src/infrastructure/postgres/projection-repair-build-repository.js";
import { createPostgresProjectionRepairWorkRepository } from
  "../src/infrastructure/postgres/projection-repair-work-repository.js";
import {
  createProjectionRepairDirectoryStream
} from "../src/maintenance/projection-repair-directory-builder.js";

const databaseUrl = process.env.FOCOWIKI_TEST_DATABASE_URL;
const describeDatabase = databaseUrl ? describe : describe.skip;

describeDatabase("projection repair work repository integration", () => {
  const connectionUrl = databaseUrl ?? "postgres://unused:unused@127.0.0.1:5432/unused";
  const databaseName = `focowiki_repair_work_${process.pid}_${
    randomUUID().replaceAll("-", "").slice(0, 10)
  }`;
  let statementCount = 0;
  const admin = postgres(databaseConnectionUrl(connectionUrl, "postgres"), { max: 1 });
  const sql = postgres(databaseConnectionUrl(connectionUrl, databaseName), {
    max: 8,
    debug() {
      statementCount += 1;
    }
  });
  const work = createPostgresProjectionRepairWorkRepository(sql);
  const builds = createPostgresProjectionRepairBuildRepository(sql);
  const settings = {
    concurrency: 4,
    databaseBatchSize: 2_000,
    objectWriteConcurrency: 8
  };

  beforeAll(async () => {
    await admin.unsafe(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
    await applyMigrations(sql);
  });

  beforeEach(async () => {
    await sql`DELETE FROM focowiki.knowledge_bases WHERE id = 'kb-repair-work'`;
    await seedKnowledgeBase();
    statementCount = 0;
  });

  afterAll(async () => {
    await sql.end({ timeout: 5 });
    await admin.unsafe(`DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)} WITH (FORCE)`);
    await admin.end({ timeout: 5 });
  });

  it("plans deterministic stale partitions once and captures settings and watermarks", async () => {
    expect(await bootstrap()).toBe(1);
    expect(await plan("generation-repair-one")).toEqual({
      knowledgeBaseId: "kb-repair-work",
      taskCount: 8
    });
    expect(await plan("generation-repair-unused")).toBeNull();

    const rows = await sql<Array<{
      task_kind: string;
      partition_key: string;
      source_watermark: number;
      settings_revision: number;
      settings_snapshot_json: unknown;
    }>>`
      SELECT task_kind, partition_key, source_watermark,
             settings_revision, settings_snapshot_json
      FROM focowiki.projection_repair_subtasks
      WHERE target_generation_id = 'generation-repair-one'
      ORDER BY phase_order, partition_key
    `;
    expect(rows.map((row) => [row.task_kind, row.partition_key])).toEqual([
      ["tree_partition", "tree/v1/0000"],
      ["tree_partition", "tree/v1/0001"],
      ["directory", "pages"],
      ["directory", "pages/guides"],
      ["graph_partition", "graph_edge\u001fgraph_edge/v1/0000"],
      ["graph_partition", "graph_node\u001fgraph_node/v1/0000"],
      ["graph_finalize", "graph"],
      ["finalize", "root"]
    ]);
    expect(rows.every((row) =>
      row.source_watermark === 3
      && row.settings_revision === 9
      && row.settings_snapshot_json
    )).toBe(true);
    await expect(sql<Array<{
      node_count: number;
      edge_count: number;
      graph_index_available: boolean;
    }>>`
      SELECT node_count::int AS node_count, edge_count::int AS edge_count,
             graph_index_available
      FROM focowiki.generation_graph_summaries
      WHERE generation_id = 'generation-repair-one'
    `).resolves.toEqual([{
      node_count: 1,
      edge_count: 1,
      graph_index_available: true
    }]);
  });

  it("supersedes an older running repair before starting the current version", async () => {
    await bootstrap();
    await plan("generation-repair-old-order");

    expect(await work.bootstrap({
      repairVersion: 5,
      plannerVersion: 1,
      settingsRevision: 9,
      settings,
      maxAttempts: 5,
      now: "2026-07-24T00:01:00.000Z"
    })).toBe(1);

    expect(await sql<Array<{
      repair_version: number;
      repair_state: string;
      generation_state: string | null;
    }>>`
      SELECT repair.repair_version, repair.state AS repair_state,
             generation.state AS generation_state
      FROM focowiki.knowledge_base_projection_repairs repair
      LEFT JOIN focowiki.publication_generations generation
        ON generation.id = repair.target_generation_id
      WHERE repair.knowledge_base_id = 'kb-repair-work'
      ORDER BY repair.repair_version
    `).toEqual([
      {
        repair_version: 4,
        repair_state: "superseded",
        generation_state: "superseded"
      },
      {
        repair_version: 5,
        repair_state: "pending",
        generation_state: null
      }
    ]);
  });

  it("starts the current repair version after an older repair failed", async () => {
    await bootstrap();
    await plan("generation-repair-failed-order");
    await sql.begin(async (transaction) => {
      await transaction`
        UPDATE focowiki.knowledge_base_projection_repairs
        SET state = 'failed', current_phase = 'failed'
        WHERE knowledge_base_id = 'kb-repair-work'
          AND repair_version = 4
      `;
      await transaction`
        UPDATE focowiki.publication_generations
        SET state = 'failed', failed_at = now(),
            safe_error_code = 'PROJECTION_REPAIR_TASK_FAILED',
            safe_error_message = 'Directory entries must be strictly ordered'
        WHERE id = 'generation-repair-failed-order'
      `;
    });

    expect(await work.bootstrap({
      repairVersion: 5,
      plannerVersion: 1,
      settingsRevision: 9,
      settings,
      maxAttempts: 5,
      now: "2026-07-24T00:01:00.000Z"
    })).toBe(1);

    expect(await sql<Array<{
      repair_version: number;
      repair_state: string;
      generation_state: string | null;
    }>>`
      SELECT repair.repair_version, repair.state AS repair_state,
             generation.state AS generation_state
      FROM focowiki.knowledge_base_projection_repairs repair
      LEFT JOIN focowiki.publication_generations generation
        ON generation.id = repair.target_generation_id
      WHERE repair.knowledge_base_id = 'kb-repair-work'
      ORDER BY repair.repair_version
    `).toEqual([
      {
        repair_version: 4,
        repair_state: "failed",
        generation_state: "failed"
      },
      {
        repair_version: 5,
        repair_state: "pending",
        generation_state: null
      }
    ]);
  });

  it("claims runnable partitions without duplicates and recovers an expired lease", async () => {
    await bootstrap();
    await plan("generation-repair-claims");
    const first = await work.claimBatch({
      repairVersion: 4,
      workerId: "repair-worker-a",
      leaseTokenPrefix: "lease-a",
      limit: 4,
      now: "2026-07-24T00:00:01.000Z",
      leaseExpiresAt: "2026-07-24T00:01:01.000Z"
    });
    const concurrent = await work.claimBatch({
      repairVersion: 4,
      workerId: "repair-worker-b",
      leaseTokenPrefix: "lease-b",
      limit: 4,
      now: "2026-07-24T00:00:02.000Z",
      leaseExpiresAt: "2026-07-24T00:01:02.000Z"
    });

    expect(first).toHaveLength(2);
    expect(first.every((task) => task.kind === "tree_partition")).toBe(true);
    expect(concurrent).toEqual([]);

    await work.completeTask({
      task: first[0]!,
      processedRecordCount: first[0]!.expectedRecordCount,
      objectWriteCount: 1,
      objectReuseCount: 0,
      durationMs: 50,
      completedAt: "2026-07-24T00:00:03.000Z"
    });
    const recovered = await work.claimBatch({
      repairVersion: 4,
      workerId: "repair-worker-b",
      leaseTokenPrefix: "lease-b",
      limit: 4,
      now: "2026-07-24T00:02:00.000Z",
      leaseExpiresAt: "2026-07-24T00:03:00.000Z"
    });
    expect(recovered).toHaveLength(1);
    expect(recovered[0]?.id).toBe(first[1]?.id);
    expect(recovered[0]?.attemptCount).toBe(2);
    expect(recovered[0]?.leaseOwner).toBe("repair-worker-b");
  });

  it("stages a whole tree partition with bounded set-based SQL", async () => {
    await bootstrap();
    await plan("generation-repair-tree");
    const tasks = await work.claimBatch({
      repairVersion: 4,
      workerId: "repair-worker",
      leaseTokenPrefix: "lease",
      limit: 4,
      now: "2026-07-24T00:00:01.000Z",
      leaseExpiresAt: "2026-07-24T00:01:01.000Z"
    });
    const task = tasks.find((candidate) => candidate.partitionKey === "tree/v1/0001");
    expect(task).toBeDefined();

    statementCount = 0;
    const batch = await builds.stageTreeBatch({
      task: task!,
      cursor: null,
      limit: 2_000
    });
    const statementsForBatch = statementCount;
    const staged = await builds.listStagedTreePartition({
      task: task!,
      limit: 2_000
    });

    expect(batch).toEqual({
      processedRecordCount: 201,
      nextCursor: "source-file-0200",
      complete: true
    });
    expect(staged).toHaveLength(201);
    expect(staged.map((record) => record.recordId)).toEqual(
      [...staged.map((record) => record.recordId)].sort()
    );
    expect(statementsForBatch).toBeLessThanOrEqual(4);
    expect(staged.find((record) => record.recordId === "directory:pages/guides")?.payload)
      .toMatchObject({
        directEntryCount: 200,
        directDirectoryCount: 0,
        directFileCount: 200,
        descendantFileCount: 200
      });
  });

  it("streams mixed-case and Unicode directory entries in stable byte order", async () => {
    await sql`
      UPDATE focowiki.active_projection_records
      SET sort_key = CASE record_id
            WHEN 'source-file-0001' THEN 'Z'
            WHEN 'source-file-0002' THEN 'a'
          END
      WHERE knowledge_base_id = 'kb-repair-work'
        AND record_id IN ('source-file-0001', 'source-file-0002')
    `;
    await bootstrap();
    await plan("generation-repair-directory-order");
    const treeTasks = await work.claimBatch({
      repairVersion: 4,
      workerId: "repair-worker",
      leaseTokenPrefix: "tree",
      limit: 4,
      now: "2026-07-24T00:00:01.000Z",
      leaseExpiresAt: "2026-07-24T00:01:01.000Z"
    });
    for (const task of treeTasks) {
      await work.completeTask({
        task,
        processedRecordCount: task.expectedRecordCount,
        objectWriteCount: 1,
        objectReuseCount: 0,
        durationMs: 1,
        completedAt: "2026-07-24T00:00:02.000Z"
      });
    }
    const directoryTasks = await work.claimBatch({
      repairVersion: 4,
      workerId: "repair-worker",
      leaseTokenPrefix: "directory",
      limit: 4,
      now: "2026-07-24T00:00:03.000Z",
      leaseExpiresAt: "2026-07-24T00:01:03.000Z"
    });
    const task = directoryTasks.find(
      (candidate) => candidate.partitionKey === "pages/guides"
    );
    expect(task).toBeDefined();

    const observed: string[] = [];
    const stream = createProjectionRepairDirectoryStream({
      directoryPath: "pages/guides",
      limits: { maxEntries: 500, maxBytes: 1_048_576 },
      writeLeaf: async () => undefined
    });
    let cursor = null;
    do {
      const page = await builds.listDirectoryEntryPage({
        task: task!,
        cursor,
        limit: 1
      });
      for (const entry of page.entries) {
        observed.push(entry.sortKey);
        await stream.add(entry);
      }
      cursor = page.nextCursor;
    } while (cursor);
    await stream.finish();

    expect(observed.slice(0, 3)).toEqual(["Z", "a", "file-0003"]);
    expect(observed).toHaveLength(200);
  });

  it("writes and replaces a generated directory leaf with the schema conflict key", async () => {
    await bootstrap();
    await plan("generation-repair-directory");
    const treeTasks = await work.claimBatch({
      repairVersion: 4,
      workerId: "repair-worker",
      leaseTokenPrefix: "tree",
      limit: 4,
      now: "2026-07-24T00:00:01.000Z",
      leaseExpiresAt: "2026-07-24T00:01:01.000Z"
    });
    for (const task of treeTasks) {
      await work.completeTask({
        task,
        processedRecordCount: task.expectedRecordCount,
        objectWriteCount: 1,
        objectReuseCount: 0,
        durationMs: 1,
        completedAt: "2026-07-24T00:00:02.000Z"
      });
    }
    const directoryTasks = await work.claimBatch({
      repairVersion: 4,
      workerId: "repair-worker",
      leaseTokenPrefix: "directory",
      limit: 4,
      now: "2026-07-24T00:00:03.000Z",
      leaseExpiresAt: "2026-07-24T00:01:03.000Z"
    });
    const task = directoryTasks.find((candidate) => candidate.partitionKey === "pages");
    expect(task).toBeDefined();

    const leaf = {
      id: "directory-leaf-000000",
      previousLeafId: null,
      nextLeafId: null,
      entries: [{
        id: "directory:pages/guides",
        sortKey: "guides",
        name: "guides",
        targetPath: "pages/guides/index.md",
        kind: "directory" as const
      }],
      revision: 1
    };
    await builds.upsertDirectoryLeaf({ task: task!, leaf });
    await builds.upsertDirectoryLeaf({
      task: task!,
      leaf: {
        ...leaf,
        entries: [{ ...leaf.entries[0]!, name: "Guides" }]
      }
    });

    const rows = await sql<Array<{ name: string }>>`
      SELECT entries_json->0->>'name' AS name
      FROM focowiki.generation_directory_navigation_leaves
      WHERE generation_id = 'generation-repair-directory'
        AND id = 'directory-leaf-000000'
    `;
    expect(rows).toEqual([{ name: "Guides" }]);
  });

  it("schedules bounded catch-up without discarding completed baseline work", async () => {
    await bootstrap();
    await plan("generation-repair-catch-up");
    await sql`
      UPDATE focowiki.projection_repair_subtasks
      SET state = 'completed', completed_at = '2026-07-24T00:00:01.000Z',
          processed_record_count = expected_record_count,
          updated_at = '2026-07-24T00:00:01.000Z'
      WHERE target_generation_id = 'generation-repair-catch-up'
        AND task_kind <> 'finalize'
    `;
    await sql.begin(async (transaction) => {
      await transaction`
        INSERT INTO focowiki.generation_projection_records (
          generation_id, knowledge_base_id, projection_kind, record_id,
          action, shard_key, source_file_id, related_source_file_id,
          logical_path, parent_path, sort_key, title, summary,
          searchable_text, payload_json
        )
        SELECT 'generation-repair-catch-up', knowledge_base_id,
               projection_kind, record_id, 'upsert', shard_key,
               source_file_id, related_source_file_id, logical_path,
               parent_path, sort_key, title, summary, searchable_text,
               payload_json
        FROM focowiki.active_projection_records
        WHERE knowledge_base_id = 'kb-repair-work'
          AND (
            (projection_kind = 'tree' AND shard_key = 'tree/v1/0001')
            OR projection_kind IN ('graph_node', 'graph_edge')
          )
      `;
      await transaction`
        UPDATE focowiki.publication_generations
        SET state = 'superseded',
            successor_generation_id = 'generation-normal-next',
            updated_at = '2026-07-24T00:00:02.000Z'
        WHERE id = 'generation-repair-active'
      `;
      await transaction`
        INSERT INTO focowiki.publication_generations (
          id, knowledge_base_id, predecessor_generation_id,
          state, generation_kind, activated_at, created_at, updated_at
        ) VALUES (
          'generation-normal-next', 'kb-repair-work',
          'generation-repair-active', 'active', 'normal',
          '2026-07-24T00:00:02.000Z',
          '2026-07-24T00:00:02.000Z',
          '2026-07-24T00:00:02.000Z'
        )
      `;
      await transaction`
        UPDATE focowiki.knowledge_bases
        SET active_generation_id = 'generation-normal-next',
            resource_revision = 4,
            updated_at = '2026-07-24T00:00:02.000Z'
        WHERE id = 'kb-repair-work'
      `;
      await transaction`
        DELETE FROM focowiki.active_projection_records
        WHERE knowledge_base_id = 'kb-repair-work'
          AND projection_kind = 'tree'
          AND shard_key = 'tree/v1/0001'
      `;
      await transaction`
        DELETE FROM focowiki.active_projection_records
        WHERE knowledge_base_id = 'kb-repair-work'
          AND projection_kind = 'graph_edge'
          AND record_id = 'graph-edge-one'
      `;
      await transaction`
        UPDATE focowiki.active_projection_records
        SET last_changed_generation_id = 'generation-normal-next',
            title = 'Updated node'
        WHERE knowledge_base_id = 'kb-repair-work'
          AND projection_kind = 'graph_node'
          AND record_id = 'graph-node-one'
      `;
      await transaction`
        INSERT INTO focowiki.publication_change_facts (
          id, knowledge_base_id, source_file_id, kind, path,
          resource_revision, generation_id, created_at
        ) VALUES (
          'change-fact-catch-up', 'kb-repair-work', 'source-file-0200',
          'source_replaced', 'guides/file-0200.md', 4,
          'generation-normal-next', '2026-07-24T00:00:02.000Z'
        )
      `;
      await transaction`
        INSERT INTO focowiki.publication_impacts (
          id, knowledge_base_id, generation_id, projection_kind,
          projection_key, record_identity, action, status,
          completed_at, created_at, updated_at
        ) VALUES
          (
            'impact-catch-up-tree', 'kb-repair-work',
            'generation-normal-next', 'tree', 'tree/v1/0001',
            'source-file-0200', 'delete', 'completed',
            '2026-07-24T00:00:02.000Z',
            '2026-07-24T00:00:02.000Z',
            '2026-07-24T00:00:02.000Z'
          ),
          (
            'impact-catch-up-directory', 'kb-repair-work',
            'generation-normal-next', 'directory', 'guides',
            'source-file-0200:guides', 'validate', 'completed',
            '2026-07-24T00:00:02.000Z',
            '2026-07-24T00:00:02.000Z',
            '2026-07-24T00:00:02.000Z'
          ),
          (
            'impact-catch-up-graph', 'kb-repair-work',
            'generation-normal-next', 'graph_node', 'graph_node/v1/0000',
            'graph-node-one', 'upsert', 'completed',
            '2026-07-24T00:00:02.000Z',
            '2026-07-24T00:00:02.000Z',
            '2026-07-24T00:00:02.000Z'
          ),
          (
            'impact-catch-up-graph-delete', 'kb-repair-work',
            'generation-normal-next', 'graph_edge', 'graph_edge/v1/0000',
            'graph-edge-one', 'delete', 'completed',
            '2026-07-24T00:00:02.000Z',
            '2026-07-24T00:00:02.000Z',
            '2026-07-24T00:00:02.000Z'
          )
      `;
      await transaction`
        DELETE FROM focowiki.publication_impacts
        WHERE generation_id = 'generation-normal-next'
      `;
    });
    const claimed = await work.claimBatch({
      repairVersion: 4,
      workerId: "repair-worker",
      leaseTokenPrefix: "catch-up",
      limit: 1,
      now: "2026-07-24T00:00:03.000Z",
      leaseExpiresAt: "2026-07-24T00:01:03.000Z"
    });
    expect(claimed).toHaveLength(1);
    expect(claimed[0]?.kind).toBe("finalize");

    expect(await work.scheduleCatchUp({
      task: claimed[0]!,
      scheduledAt: "2026-07-24T00:00:04.000Z"
    })).toBe("scheduled");

    const tasks = await sql<Array<{
      task_kind: string;
      partition_key: string;
      state: string;
      base_generation_id: string;
      attempt_count: number;
    }>>`
      SELECT task_kind, partition_key, state, base_generation_id, attempt_count
      FROM focowiki.projection_repair_subtasks
      WHERE target_generation_id = 'generation-repair-catch-up'
      ORDER BY phase_order, task_kind, partition_key
    `;
    expect(tasks.filter((task) => task.task_kind.endsWith("_rebase"))).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          task_kind: "tree_rebase",
          partition_key: "generation-normal-next\u001etree/v1/0001"
        }),
        expect.objectContaining({
          task_kind: "directory_rebase",
          partition_key: "generation-normal-next\u001epages/guides"
        }),
        expect.objectContaining({
          task_kind: "directory_rebase",
          partition_key: "generation-normal-next\u001epages"
        }),
        expect.objectContaining({
          task_kind: "graph_rebase",
          partition_key:
            "generation-normal-next\u001egraph_node\u001fgraph_node/v1/0000"
        }),
        expect.objectContaining({
          task_kind: "graph_rebase",
          partition_key:
            "generation-normal-next\u001egraph_edge\u001fgraph_edge/v1/0000"
        })
      ])
    );
    expect(tasks).toContainEqual(expect.objectContaining({
      task_kind: "graph_rebase_finalize",
      partition_key: "generation-normal-next\u001egraph"
    }));
    expect(tasks).toContainEqual(expect.objectContaining({
      task_kind: "tree_partition",
      partition_key: "tree/v1/0000",
      state: "completed"
    }));
    expect(tasks).toContainEqual(expect.objectContaining({
      task_kind: "finalize",
      state: "pending",
      base_generation_id: "generation-normal-next",
      attempt_count: 0
    }));

    const state = await sql<Array<{
      current_phase: string;
      expected_subtask_count: number;
      predecessor_generation_id: string;
    }>>`
      SELECT repair.current_phase, repair.expected_subtask_count,
             generation.predecessor_generation_id
      FROM focowiki.knowledge_base_projection_repairs repair
      JOIN focowiki.publication_generations generation
        ON generation.id = repair.target_generation_id
      WHERE repair.knowledge_base_id = 'kb-repair-work'
        AND repair.repair_version = 4
    `;
    expect(state[0]).toMatchObject({
      current_phase: "catch_up",
      expected_subtask_count: 14,
      predecessor_generation_id: "generation-normal-next"
    });

    const catchUp = await work.claimBatch({
      repairVersion: 4,
      workerId: "repair-worker",
      leaseTokenPrefix: "catch-up-tree",
      limit: 4,
      now: "2026-07-24T00:00:05.000Z",
      leaseExpiresAt: "2026-07-24T00:01:05.000Z"
    });
    expect(catchUp).toHaveLength(1);
    expect(catchUp[0]?.kind).toBe("tree_rebase");
    const treeTask = {
      ...catchUp[0]!,
      partitionKey: "tree/v1/0001"
    };
    expect(await builds.stageTreeRebaseBatch({
      task: treeTask,
      cursor: null,
      limit: 2_000
    })).toMatchObject({
      processedRecordCount: 201,
      complete: true
    });
    const changes = await builds.listStagedTreeRebaseChanges({
      task: treeTask,
      limit: 2_000
    });
    expect(changes).toContainEqual({
      recordId: "source-file-0200",
      record: null
    });
    expect(await builds.directoryExists({
      task: {
        ...claimed[0]!,
        kind: "directory_rebase",
        baseGenerationId: "generation-normal-next",
        partitionKey: "pages/guides",
        expectedRecordCount: 0
      }
    })).toBe(false);

    const graphTask = {
      ...claimed[0]!,
      kind: "graph_rebase" as const,
      baseGenerationId: "generation-normal-next",
      partitionKey: "graph_edge\u001fgraph_edge/v1/0000",
      expectedRecordCount: 1
    };
    expect(await builds.stageGraphRebaseBatch({
      task: graphTask,
      projectionKind: "graph_edge",
      shardKey: "graph_edge/v1/0000",
      cursor: null,
      limit: 2_000
    })).toMatchObject({
      processedRecordCount: 1,
      complete: true
    });
    expect(await builds.listStagedGraphRebaseChanges({
      task: graphTask,
      projectionKind: "graph_edge",
      shardKey: "graph_edge/v1/0000",
      limit: 2_000
    })).toContainEqual({
      recordId: "graph-edge-one",
      record: null
    });
  });

  it("requeues compatible directory validation failures after repair activation", async () => {
    await bootstrap();
    await plan("generation-repair-recovery");
    await sql.begin(async (transaction) => {
      await transaction`
        INSERT INTO focowiki.publication_generations (
          id, knowledge_base_id, predecessor_generation_id, state,
          generation_kind, failed_at, safe_error_code, safe_error_message
        ) VALUES (
          'generation-directory-failed', 'kb-repair-work',
          'generation-repair-active', 'failed', 'normal', now(),
          'PUBLICATION_RETRIES_EXHAUSTED',
          'DIRECTORY_NAVIGATION_COUNT_MISMATCH:pages'
        )
      `;
      await transaction`
        INSERT INTO focowiki.publication_change_facts (
          id, knowledge_base_id, kind, resource_revision, generation_id,
          assembly_state, planning_payload_json
        ) VALUES (
          'fact-directory-failed', 'kb-repair-work',
          'knowledge_base_metadata_changed', 3,
          'generation-directory-failed', 'assembled',
          ${transaction.json({ preplannedImpacts: [] })}
        )
      `;
      await transaction`
        INSERT INTO focowiki.publication_impacts (
          id, knowledge_base_id, generation_id, projection_kind,
          projection_key, record_identity, action, status
        ) VALUES (
          'impact-directory-failed', 'kb-repair-work',
          'generation-directory-failed', 'root',
          'index.md', 'index.md', 'upsert', 'completed'
        )
      `;
      await transaction`
        INSERT INTO focowiki.publication_impact_causes (impact_id, change_fact_id)
        VALUES ('impact-directory-failed', 'fact-directory-failed')
      `;
      await transaction`
        UPDATE focowiki.projection_repair_subtasks
        SET state = 'completed', completed_at = now(),
            processed_record_count = expected_record_count
        WHERE target_generation_id = 'generation-repair-recovery'
          AND task_kind <> 'finalize'
      `;
    });
    const [finalizeTask] = await work.claimBatch({
      repairVersion: 4,
      workerId: "repair-worker",
      leaseTokenPrefix: "finalize",
      limit: 1,
      now: "2026-07-24T00:01:00.000Z",
      leaseExpiresAt: "2026-07-24T00:02:00.000Z"
    });
    expect(finalizeTask?.kind).toBe("finalize");
    await sql.begin(async (transaction) => {
      await transaction`
        UPDATE focowiki.publication_generations
        SET state = 'superseded', successor_generation_id = 'generation-repair-recovery'
        WHERE id = 'generation-repair-active'
      `;
      await transaction`
        UPDATE focowiki.publication_generations
        SET state = 'active', activated_at = now()
        WHERE id = 'generation-repair-recovery'
      `;
      await transaction`
        UPDATE focowiki.knowledge_bases
        SET active_generation_id = 'generation-repair-recovery'
        WHERE id = 'kb-repair-work'
      `;
    });
    await work.completeTask({
      task: finalizeTask!,
      processedRecordCount: 1,
      objectWriteCount: 1,
      objectReuseCount: 0,
      durationMs: 1,
      completedAt: "2026-07-24T00:01:01.000Z"
    });

    await expect(work.completeRepair({
      task: finalizeTask!,
      activeGenerationId: "generation-repair-recovery",
      completedAt: "2026-07-24T00:01:02.000Z"
    })).resolves.toBe(true);
    await expect(sql<Array<{
      generation_state: string;
      fact_generation_id: string | null;
      assembly_state: string;
      impact_count: number;
    }>>`
      SELECT generation.state AS generation_state,
             fact.generation_id AS fact_generation_id,
             fact.assembly_state,
             (SELECT count(*)::int
              FROM focowiki.publication_impacts
              WHERE generation_id = 'generation-directory-failed') AS impact_count
      FROM focowiki.publication_generations generation
      JOIN focowiki.publication_change_facts fact
        ON fact.id = 'fact-directory-failed'
      WHERE generation.id = 'generation-directory-failed'
    `).resolves.toEqual([{
      generation_state: "superseded",
      fact_generation_id: null,
      assembly_state: "pending",
      impact_count: 0
    }]);
  });

  async function bootstrap(): Promise<number> {
    return work.bootstrap({
      repairVersion: 4,
      plannerVersion: 1,
      settingsRevision: 9,
      settings,
      maxAttempts: 5,
      now: "2026-07-24T00:00:00.000Z"
    });
  }

  async function plan(targetGenerationId: string) {
    return work.planNext({
      repairVersion: 4,
      plannerVersion: 1,
      targetGenerationId,
      settingsRevision: 9,
      settings,
      maxAttempts: 5,
      now: "2026-07-24T00:00:00.000Z"
    });
  }

  async function seedKnowledgeBase(): Promise<void> {
    await sql.begin(async (transaction) => {
      await transaction`
        INSERT INTO focowiki.knowledge_bases (
          id, name, description, resource_revision
        ) VALUES (
          'kb-repair-work', 'Repair work', 'Domain-neutral fixture', 3
        )
      `;
      await transaction`
        INSERT INTO focowiki.publication_generations (
          id, knowledge_base_id, state, generation_kind, activated_at
        ) VALUES (
          'generation-repair-active', 'kb-repair-work',
          'active', 'normal', now()
        )
      `;
      await transaction`
        UPDATE focowiki.knowledge_bases
        SET active_generation_id = 'generation-repair-active'
        WHERE id = 'kb-repair-work'
      `;
      await transaction`
        INSERT INTO focowiki.active_projection_records (
          knowledge_base_id, projection_kind, record_id,
          last_changed_generation_id, shard_key, logical_path,
          parent_path, sort_key, title, searchable_text, payload_json
        ) VALUES
          (
            'kb-repair-work', 'tree', 'directory:',
            'generation-repair-active', 'tree/v1/0000', 'pages', '',
            'pages', 'pages', 'pages',
            '{"id":"directory:","kind":"directory","path":"pages"}'::jsonb
          ),
          (
            'kb-repair-work', 'tree', 'directory:pages/guides',
            'generation-repair-active', 'tree/v1/0001', 'pages/guides', 'pages',
            'guides', 'guides', 'guides',
            '{"id":"directory:pages/guides","kind":"directory","path":"pages/guides"}'::jsonb
          ),
          (
            'kb-repair-work', 'graph_node', 'graph-node-one',
            'generation-repair-active', 'graph_node/v1/0000', 'pages/guides/one.md',
            NULL, 'one', 'One', 'one',
            '{"kind":"graph_node"}'::jsonb
          ),
          (
            'kb-repair-work', 'graph_edge', 'graph-edge-one',
            'generation-repair-active', 'graph_edge/v1/0000', NULL,
            NULL, 'one', 'One relationship', 'one relationship',
            '{"kind":"graph_edge"}'::jsonb
          )
      `;
      await transaction`
        INSERT INTO focowiki.active_projection_records (
          knowledge_base_id, projection_kind, record_id,
          last_changed_generation_id, shard_key, logical_path,
          parent_path, sort_key, title, searchable_text, payload_json
        )
        SELECT 'kb-repair-work', 'tree',
               'source-file-' || lpad(value::text, 4, '0'),
               'generation-repair-active', 'tree/v1/0001',
               'pages/guides/file-' || lpad(value::text, 4, '0') || '.md',
               'pages/guides', 'file-' || lpad(value::text, 4, '0'),
               'File ' || value, 'file ' || value,
               jsonb_build_object(
                 'id', 'source-file-' || lpad(value::text, 4, '0'),
                 'kind', 'file',
                 'path', 'pages/guides/file-' || lpad(value::text, 4, '0') || '.md'
               )
        FROM generate_series(1, 200) value
      `;
      await transaction`
        INSERT INTO focowiki.generation_graph_summaries (
          knowledge_base_id, generation_id, node_count, edge_count,
          graph_index_available
        ) VALUES (
          'kb-repair-work', 'generation-repair-active', 1, 1, true
        )
      `;
    });
  }
});

function databaseConnectionUrl(source: string, database: string): string {
  const url = new URL(source);
  url.pathname = `/${database}`;
  return url.toString();
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll("\"", "\"\"")}"`;
}
