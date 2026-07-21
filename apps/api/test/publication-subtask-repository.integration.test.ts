import postgres from "postgres";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createPostgresPublicationSubtaskRepository } from "../src/infrastructure/postgres/publication-subtask-repository.js";

const databaseUrl = process.env.FOCOWIKI_TEST_DATABASE_URL;
const describeDatabase = databaseUrl ? describe : describe.skip;

describeDatabase("publication subtask repository integration", () => {
  const sql = postgres(databaseUrl!, { max: 6 });
  const repository = createPostgresPublicationSubtaskRepository(sql);
  const knowledgeBaseIds = ["kb-subtask-a", "kb-subtask-b"];
  const generationIds = ["generation-subtask-a", "generation-subtask-b"];

  beforeEach(async () => {
    await cleanup();
    for (let index = 0; index < knowledgeBaseIds.length; index += 1) {
      await sql`
        INSERT INTO focowiki.knowledge_bases (id, name)
        VALUES (${knowledgeBaseIds[index]!}, ${`Subtask ${index}`})
      `;
      await sql`
        INSERT INTO focowiki.publication_generations (
          id, knowledge_base_id, state, created_at, updated_at
        ) VALUES (
          ${generationIds[index]!}, ${knowledgeBaseIds[index]!},
          'building', now(), now()
        )
      `;
      await sql`
        INSERT INTO focowiki.publication_progress (
          knowledge_base_id, generation_id, stage,
          total_impact_count, remaining_impact_count
        ) VALUES (
          ${knowledgeBaseIds[index]!}, ${generationIds[index]!},
          'projection', 2, 2
        )
      `;
    }
  });

  afterAll(async () => {
    await cleanup();
    await sql.end({ timeout: 5 });
  });

  it("creates deterministic physical-partition tasks and claims independent knowledge bases", async () => {
    await insertImpact(knowledgeBaseIds[0]!, generationIds[0]!, "search", "search/v1/0001", "a");
    await insertImpact(knowledgeBaseIds[0]!, generationIds[0]!, "search", "search/v1/0001", "b");
    await insertImpact(knowledgeBaseIds[0]!, generationIds[0]!, "search", "search/v1/0002", "d");
    await insertImpact(knowledgeBaseIds[1]!, generationIds[1]!, "tree", "tree/v1/0001", "c");

    await repository.ensureGenerationTasks({
      knowledgeBaseId: knowledgeBaseIds[0]!,
      generationId: generationIds[0]!,
      settingsSnapshot: {},
      maxAttempts: 5,
      createdAt: "2026-07-20T00:00:00.000Z"
    });
    await repository.ensureGenerationTasks({
      knowledgeBaseId: knowledgeBaseIds[1]!,
      generationId: generationIds[1]!,
      settingsSnapshot: {},
      maxAttempts: 5,
      createdAt: "2026-07-20T00:00:00.000Z"
    });

    const claimed = await repository.claim({
      workerId: "publication-subtask-worker-a",
      limit: 4,
      now: "2099-07-20T00:00:01.000Z",
      staleBefore: "2099-07-19T23:59:01.000Z"
    });

    expect(claimed).toHaveLength(3);
    expect(new Set(claimed.map((task) => task.knowledgeBaseId))).toEqual(
      new Set(knowledgeBaseIds)
    );
    expect(claimed.filter((task) => task.knowledgeBaseId === knowledgeBaseIds[0]))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ projectionKind: "search", totalCount: 2 }),
        expect.objectContaining({ projectionKind: "search", totalCount: 1 })
      ]));
  });

  it("persists the complete publication workflow and releases phases in order", async () => {
    await insertImpact(knowledgeBaseIds[0]!, generationIds[0]!, "search", "search/v1/0001", "a");
    await insertImpact(knowledgeBaseIds[0]!, generationIds[0]!, "directory", "guides", "b");

    const ensured = await repository.ensureGenerationTasks({
      knowledgeBaseId: knowledgeBaseIds[0]!,
      generationId: generationIds[0]!,
      settingsSnapshot: {},
      maxAttempts: 5,
      createdAt: "2026-07-20T00:00:00.000Z"
    });
    expect(ensured.taskCount).toBe(5);
    const rows = await sql<Array<{ task_kind: string; state: string }>>`
      SELECT task_kind, state
      FROM focowiki.publication_subtasks
      WHERE generation_id = ${generationIds[0]!}
      ORDER BY task_kind, physical_partition
    `;
    expect(rows).toEqual([
      { task_kind: "activation", state: "pending" },
      { task_kind: "coordinator", state: "completed" },
      { task_kind: "directory", state: "pending" },
      { task_kind: "object", state: "pending" },
      { task_kind: "projection_partition", state: "pending" },
      { task_kind: "validation", state: "pending" }
    ]);

    const firstPhase = await repository.claim({
      workerId: "publication-subtask-worker-a",
      limit: 10,
      now: "2099-07-20T00:00:01.000Z",
      staleBefore: "2099-07-19T23:59:01.000Z"
    });
    expect(new Set(firstPhase.map((task) => task.taskKind))).toEqual(
      new Set(["directory", "projection_partition"])
    );
    for (const task of firstPhase) {
      await repository.complete({
        taskId: task.id,
        workerId: task.leaseOwner!,
        processedCount: task.totalCount,
        completedAt: "2099-07-20T00:00:02.000Z"
      });
    }

    const objectPhase = await repository.claim({
      workerId: "publication-subtask-worker-a",
      limit: 10,
      now: "2099-07-20T00:00:03.000Z",
      staleBefore: "2099-07-19T23:59:03.000Z"
    });
    expect(objectPhase.map((task) => task.taskKind)).toEqual(["object"]);
    await repository.complete({
      taskId: objectPhase[0]!.id,
      workerId: objectPhase[0]!.leaseOwner!,
      processedCount: 1,
      completedAt: "2099-07-20T00:00:04.000Z"
    });
    const validationPhase = await repository.claim({
      workerId: "publication-subtask-worker-a",
      limit: 10,
      now: "2099-07-20T00:00:05.000Z",
      staleBefore: "2099-07-19T23:59:05.000Z"
    });
    expect(validationPhase.map((task) => task.taskKind)).toEqual(["validation"]);
    await repository.complete({
      taskId: validationPhase[0]!.id,
      workerId: validationPhase[0]!.leaseOwner!,
      processedCount: 1,
      completedAt: "2099-07-20T00:00:06.000Z"
    });
    const activationPhase = await repository.claim({
      workerId: "publication-subtask-worker-a",
      limit: 10,
      now: "2099-07-20T00:00:07.000Z",
      staleBefore: "2099-07-19T23:59:07.000Z"
    });
    expect(activationPhase.map((task) => task.taskKind)).toEqual(["activation"]);
    await sql`
      UPDATE focowiki.publication_generations
      SET state = 'active'
      WHERE id = ${generationIds[0]!}
    `;
    const resumedActivation = await repository.claim({
      workerId: "publication-subtask-worker-b",
      limit: 10,
      now: "2099-07-20T00:02:00.000Z",
      staleBefore: "2099-07-20T00:01:00.000Z"
    });
    expect(resumedActivation).toHaveLength(1);
    expect(resumedActivation[0]).toMatchObject({
      id: activationPhase[0]!.id,
      taskKind: "activation",
      attemptCount: 2
    });
  });

  it("fences one physical partition and decrements durable remaining work on completion", async () => {
    await insertImpact(knowledgeBaseIds[0]!, generationIds[0]!, "search", "search/v1/0001", "a");
    await repository.ensureGenerationTasks({
      knowledgeBaseId: knowledgeBaseIds[0]!,
      generationId: generationIds[0]!,
      settingsSnapshot: {},
      maxAttempts: 5,
      createdAt: "2026-07-20T00:00:00.000Z"
    });

    const tasks = await sql<Array<{ state: string }>>`
      SELECT state FROM focowiki.publication_subtasks
      WHERE generation_id = ${generationIds[0]!}
        AND task_kind = 'projection_partition'
    `;
    expect(tasks).toEqual([{ state: "pending" }]);

    const first = await repository.claim({
      workerId: "publication-subtask-worker-a",
      limit: 1,
      now: "2099-07-20T00:00:01.000Z",
      staleBefore: "2099-07-19T23:59:01.000Z"
    });
    const second = await repository.claim({
      workerId: "publication-subtask-worker-b",
      limit: 1,
      now: "2099-07-20T00:00:01.000Z",
      staleBefore: "2099-07-19T23:59:01.000Z"
    });
    expect(first.length + second.length).toBe(1);
    const task = first[0] ?? second[0]!;

    await repository.complete({
      taskId: task.id,
      workerId: task.leaseOwner!,
      processedCount: 1,
      completedAt: "2026-07-20T00:00:02.000Z"
    });

    expect(await repository.getGenerationStatus({
      knowledgeBaseId: knowledgeBaseIds[0]!,
      generationId: generationIds[0]!
    })).toEqual({ pending: 3, running: 0, failed: 0, remaining: 3 });
    const progress = await sql<Array<{ remaining_subtask_count: number }>>`
      SELECT remaining_subtask_count
      FROM focowiki.publication_progress
      WHERE generation_id = ${generationIds[0]!}
    `;
    expect(Number(progress[0]?.remaining_subtask_count)).toBe(3);
  });

  it("reclaims an expired lease without rewriting completed partitions", async () => {
    await insertImpact(knowledgeBaseIds[0]!, generationIds[0]!, "search", "search/v1/0001", "a");
    await insertImpact(knowledgeBaseIds[0]!, generationIds[0]!, "search", "search/v1/0002", "b");
    await repository.ensureGenerationTasks({
      knowledgeBaseId: knowledgeBaseIds[0]!,
      generationId: generationIds[0]!,
      settingsSnapshot: {},
      maxAttempts: 5,
      createdAt: "2026-07-20T00:00:00.000Z"
    });
    const firstClaims = await repository.claim({
      workerId: "publication-subtask-worker-a",
      limit: 2,
      now: "2099-07-20T00:00:01.000Z",
      staleBefore: "2099-07-19T23:59:01.000Z"
    });
    const completed = firstClaims[0]!;
    const interrupted = firstClaims[1]!;
    await repository.complete({
      taskId: completed.id,
      workerId: completed.leaseOwner!,
      processedCount: completed.totalCount,
      completedAt: "2099-07-20T00:00:02.000Z"
    });

    const reclaimed = await repository.claim({
      workerId: "publication-subtask-worker-b",
      limit: 2,
      now: "2099-07-20T00:02:00.000Z",
      staleBefore: "2099-07-20T00:01:00.000Z"
    });
    expect(reclaimed).toHaveLength(1);
    expect(reclaimed[0]).toMatchObject({
      id: interrupted.id,
      attemptCount: 2,
      leaseOwner: "publication-subtask-worker-b"
    });
    expect(reclaimed[0]?.id).not.toBe(completed.id);
  });

  async function insertImpact(
    knowledgeBaseId: string,
    generationId: string,
    projectionKind: string,
    projectionKey: string,
    recordIdentity: string
  ): Promise<void> {
    const factId = `fact-${generationId}-${recordIdentity}`;
    const impactId = `impact-${generationId}-${recordIdentity}`;
    await sql`
      INSERT INTO focowiki.publication_change_facts (
        id, knowledge_base_id, generation_id, kind, resource_revision,
        path, created_at
      ) VALUES (
        ${factId}, ${knowledgeBaseId}, ${generationId}, 'source_created', 1, ${recordIdentity}, now()
      )
    `;
    await sql`
      INSERT INTO focowiki.publication_impacts (
        id, knowledge_base_id, generation_id, projection_kind,
        projection_key, record_identity, action
      ) VALUES (
        ${impactId}, ${knowledgeBaseId}, ${generationId}, ${projectionKind},
        ${projectionKey}, ${recordIdentity}, 'upsert'
      )
    `;
    await sql`
      INSERT INTO focowiki.publication_impact_causes (impact_id, change_fact_id)
      VALUES (${impactId}, ${factId})
    `;
  }

  async function cleanup(): Promise<void> {
    await sql`DELETE FROM focowiki.knowledge_bases WHERE id = ANY(${knowledgeBaseIds})`;
  }
});
