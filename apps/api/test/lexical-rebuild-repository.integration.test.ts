import { createHash } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createPostgresFileGraphRepository } from "../src/db/file-graph-repository.js";
import { createPostgresLexicalRebuildRepository } from "../src/infrastructure/postgres/lexical-rebuild-repository.js";
import { createPostgresSearchProjectionRepository } from "../src/infrastructure/postgres/search-projection-repository.js";
import { runLexicalRebuildSlice } from "../src/maintenance/lexical-rebuild.js";

const databaseUrl = process.env.FOCOWIKI_TEST_DATABASE_URL;
const describeDatabase = databaseUrl ? describe : describe.skip;

describeDatabase("lexical rebuild repository integration", () => {
  const sql = postgres(databaseUrl!, { max: 3 });
  const rebuilds = createPostgresLexicalRebuildRepository(sql);
  const search = createPostgresSearchProjectionRepository(sql);
  const knowledgeBaseId = "kb-lexical-rebuild";
  const sourceFileId = "source-file-lexical-rebuild";
  const sourceRevisionId = "source-revision-lexical-rebuild";
  const baseGenerationId = "generation-lexical-rebuild-base";
  const secondaryKnowledgeBaseId = "kb-lexical-rebuild-secondary";
  const secondaryBaseGenerationId = "generation-lexical-rebuild-secondary-base";
  const body = "# Search\n\nLate body evidence remains searchable.";
  const checksum = createHash("sha256").update(body).digest("hex");
  const tokenizer = {
    contractVersion: "lexical-tokenizer-integration-v1",
    tokenizeDocument(value: string, limit: number) {
      return value.toLowerCase().match(/[a-z]+/gu)?.slice(0, limit) ?? [];
    },
    tokenizeQuery(value: string, limit: number) {
      return value.toLowerCase().match(/[a-z]+/gu)?.slice(0, limit) ?? [];
    }
  };
  const graph = createPostgresFileGraphRepository(sql, tokenizer);

  beforeEach(async () => {
    await cleanup();
    await seed();
  });

  afterAll(async () => {
    await cleanup();
    await sql.end({ timeout: 5 });
  });

  it("rebuilds bounded source pages and atomically activates the versioned search generation", async () => {
    const events: string[] = [];
    const run = async (index: number) => runLexicalRebuildSlice({
      rebuilds,
      search,
      graph,
      storage: {
        async getObjectText(key: string) {
          return key === "sources/rebuild.md" ? body : null;
        }
      },
      tokenizer,
      workerId: "maintenance-worker-lexical",
      leaseToken: `lease-${index}`,
      now: `2026-07-24T02:0${index}:00.000Z`,
      leaseExpiresAt: `2026-07-24T02:0${index}:30.000Z`,
      batchSize: 10,
      concurrency: 2,
      retryDelayMs: 1_000,
      onEvent(event) {
        events.push(event.type);
      }
    });

    await expect(run(0)).resolves.toMatchObject({
      phase: "documents",
      processed: 1,
      failed: false
    });
    await expect(run(1)).resolves.toMatchObject({ phase: "documents", processed: 0 });
    await expect(run(2)).resolves.toMatchObject({ phase: "reconcile", processed: 0 });
    await expect(run(3)).resolves.toMatchObject({ phase: "validate", failed: false });
    const activation = await run(4);
    if (activation.failed) {
      const failures = await sql<Array<{ last_error_message: string | null }>>`
        SELECT last_error_message
        FROM focowiki.knowledge_base_lexical_rebuilds
        WHERE knowledge_base_id = ${knowledgeBaseId}
      `;
      throw new Error(failures[0]?.last_error_message ?? "Lexical activation failed");
    }
    expect(activation).toMatchObject({ phase: "activate", failed: false });
    await expect(run(5)).resolves.toMatchObject({ phase: "cleanup", completed: true });

    const state = await sql<Array<{
      active_generation_id: string;
      search_schema_version: string;
      tokenizer_contract_version: string;
      search_segmentation_version: string;
      rebuild_state: string;
      reference_count: number;
      profile_version: string | null;
      profile_tokenizer_version: string | null;
      graph_projection_version: string | null;
      graph_tokenizer_version: string | null;
    }>>`
      SELECT knowledge_base.active_generation_id,
             generation.search_schema_version,
             generation.tokenizer_contract_version,
             generation.search_segmentation_version,
             rebuild.state AS rebuild_state,
             node.lexical_projection_version AS profile_version,
             node.tokenizer_contract_version AS profile_tokenizer_version,
             terms.lexical_projection_version AS graph_projection_version,
             terms.tokenizer_contract_version AS graph_tokenizer_version,
             (
               SELECT count(*)::int
               FROM focowiki.generation_search_projection_refs reference
               WHERE reference.generation_id = knowledge_base.active_generation_id
             ) AS reference_count
      FROM focowiki.knowledge_bases knowledge_base
      JOIN focowiki.publication_generations generation
        ON generation.id = knowledge_base.active_generation_id
      JOIN focowiki.knowledge_base_lexical_rebuilds rebuild
        ON rebuild.knowledge_base_id = knowledge_base.id
      JOIN focowiki.source_file_graph_nodes node
        ON node.knowledge_base_id = knowledge_base.id
       AND node.source_file_id = ${sourceFileId}
      JOIN focowiki.source_file_graph_term_documents terms
        ON terms.knowledge_base_id = knowledge_base.id
       AND terms.source_file_id = ${sourceFileId}
      WHERE knowledge_base.id = ${knowledgeBaseId}
    `;
    expect(state[0]).toMatchObject({
      search_schema_version: "body-search-v1",
      tokenizer_contract_version: tokenizer.contractVersion,
      search_segmentation_version: "body-segmentation-v1",
      rebuild_state: "completed",
      reference_count: 1,
      profile_version: "content-profile-v2",
      profile_tokenizer_version: tokenizer.contractVersion,
      graph_projection_version: "graph-lexical-v2",
      graph_tokenizer_version: tokenizer.contractVersion
    });
    expect(state[0]?.active_generation_id).not.toBe(baseGenerationId);
    expect(events).toContain("bootstrap");
    expect(events).toContain("claim");
    expect(events).toContain("slice_completed");
    expect(events).toContain("validation");
    expect(events).toContain("activation");
    expect(events).toContain("cleanup");
  });

  it("rebases onto a newer active generation without rereading completed source bodies", async () => {
    const sourceReads: string[] = [];
    const events: string[] = [];
    const run = async (index: number) => runLexicalRebuildSlice({
      rebuilds,
      search,
      graph,
      storage: {
        async getObjectText(key: string) {
          sourceReads.push(key);
          if (key === "sources/rebuild.md") return body;
          if (key === "sources/rebuild-new.md") {
            return "# Search\n\nA newly published source remains searchable.";
          }
          return null;
        }
      },
      tokenizer,
      workerId: "maintenance-worker-rebase",
      leaseToken: `rebase-lease-${index}`,
      now: `2026-07-24T03:${String(index).padStart(2, "0")}:00.000Z`,
      leaseExpiresAt: `2026-07-24T03:${String(index).padStart(2, "0")}:30.000Z`,
      batchSize: 10,
      concurrency: 2,
      retryDelayMs: 1_000,
      onEvent(event) {
        events.push(event.type);
      }
    });

    await expect(run(0)).resolves.toMatchObject({ phase: "documents", processed: 1 });
    await expect(run(1)).resolves.toMatchObject({ phase: "documents", processed: 0 });
    await expect(run(2)).resolves.toMatchObject({ phase: "reconcile", processed: 0 });
    await expect(run(3)).resolves.toMatchObject({ phase: "validate", failed: false });
    const targetBeforeRebase = await currentRebuildTarget();

    await advanceActiveGenerationWithNewSource();
    await expect(run(4)).resolves.toMatchObject({ phase: "activate", failed: false });

    const rebased = await sql<Array<{
      phase: string;
      target_generation_id: string | null;
      total_source_count: number;
    }>>`
      SELECT phase, target_generation_id, total_source_count::int
      FROM focowiki.knowledge_base_lexical_rebuilds
      WHERE knowledge_base_id = ${knowledgeBaseId}
    `;
    expect(rebased[0]).toEqual({
      phase: "reconcile",
      target_generation_id: targetBeforeRebase,
      total_source_count: 1
    });

    await expect(run(5)).resolves.toMatchObject({ phase: "reconcile", processed: 1 });
    expect(sourceReads).toEqual(["sources/rebuild.md", "sources/rebuild-new.md"]);
    await expect(run(6)).resolves.toMatchObject({ phase: "reconcile", processed: 0 });
    await expect(run(7)).resolves.toMatchObject({ phase: "validate", failed: false });
    await expect(run(8)).resolves.toMatchObject({ phase: "activate", failed: false });
    await expect(run(9)).resolves.toMatchObject({ phase: "cleanup", completed: true });

    const references = await sql<Array<{ count: number }>>`
      SELECT count(*)::int AS count
      FROM focowiki.generation_search_projection_refs
      WHERE generation_id = ${targetBeforeRebase}
    `;
    expect(references[0]?.count).toBe(2);
    expect(events).toContain("rebase");
  });

  it("rebuilds stale graph lexical projections for visible files with hidden task records", async () => {
    await sql`
      UPDATE focowiki.publication_generations
      SET search_schema_version = 'body-search-v1',
          tokenizer_contract_version = ${tokenizer.contractVersion},
          search_segmentation_version = 'body-segmentation-v1'
      WHERE id = ${baseGenerationId}
    `;
    await sql`
      UPDATE focowiki.source_files
      SET task_deleted_at = '2026-07-24T03:59:00.000Z'
      WHERE knowledge_base_id = ${knowledgeBaseId}
        AND id = ${sourceFileId}
    `;

    const slice = await runLexicalRebuildSlice({
      rebuilds,
      search,
      graph,
      storage: {
        async getObjectText(key: string) {
          return key === "sources/rebuild.md" ? body : null;
        }
      },
      tokenizer,
      workerId: "maintenance-worker-stale-graph",
      leaseToken: "stale-graph-lease",
      now: "2026-07-24T04:00:00.000Z",
      leaseExpiresAt: "2026-07-24T04:00:30.000Z",
      batchSize: 10,
      concurrency: 2,
      retryDelayMs: 1_000
    });

    expect(slice).toMatchObject({
      knowledgeBaseId,
      phase: "documents",
      processed: 1,
      failed: false
    });
  });

  it("claims different knowledge bases across maintenance replicas without duplicate bootstrap state", async () => {
    await seedSecondaryKnowledgeBase();
    const bootstrapInput = {
      searchSchemaVersion: "body-search-v1",
      tokenizerContractVersion: tokenizer.contractVersion,
      segmentationVersion: "body-segmentation-v1",
      contentProfileVersion: "content-profile-v2",
      graphLexicalProjectionVersion: "graph-lexical-v2",
      now: "2026-07-24T04:10:00.000Z"
    };
    await Promise.all([
      rebuilds.bootstrap(bootstrapInput),
      rebuilds.bootstrap(bootstrapInput)
    ]);

    const [first, second] = await Promise.all([
      rebuilds.claimNext({
        workerId: "maintenance-worker-replica-a",
        leaseToken: "replica-lease-a",
        targetGenerationId: "generation-lexical-replica-a",
        now: "2026-07-24T04:10:01.000Z",
        leaseExpiresAt: "2026-07-24T04:11:01.000Z"
      }),
      rebuilds.claimNext({
        workerId: "maintenance-worker-replica-b",
        leaseToken: "replica-lease-b",
        targetGenerationId: "generation-lexical-replica-b",
        now: "2026-07-24T04:10:01.000Z",
        leaseExpiresAt: "2026-07-24T04:11:01.000Z"
      })
    ]);
    expect(new Set([
      first?.knowledgeBaseId,
      second?.knowledgeBaseId
    ])).toEqual(new Set([
      knowledgeBaseId,
      secondaryKnowledgeBaseId
    ]));

    await rebuilds.bootstrap({
      ...bootstrapInput,
      now: "2026-07-24T04:10:02.000Z"
    });
    const state = await sql<Array<{
      rebuild_count: number;
      target_count: number;
      generation_count: number;
    }>>`
      SELECT
        (
          SELECT count(*)::int
          FROM focowiki.knowledge_base_lexical_rebuilds
          WHERE knowledge_base_id IN (
            ${knowledgeBaseId},
            ${secondaryKnowledgeBaseId}
          )
        ) AS rebuild_count,
        (
          SELECT count(target_generation_id)::int
          FROM focowiki.knowledge_base_lexical_rebuilds
          WHERE knowledge_base_id IN (
            ${knowledgeBaseId},
            ${secondaryKnowledgeBaseId}
          )
        ) AS target_count,
        (
          SELECT count(*)::int
          FROM focowiki.publication_generations
          WHERE knowledge_base_id IN (
            ${knowledgeBaseId},
            ${secondaryKnowledgeBaseId}
          )
            AND generation_kind = 'lexical_rebuild'
        ) AS generation_count
    `;
    expect(state[0]).toEqual({
      rebuild_count: 2,
      target_count: 2,
      generation_count: 2
    });
  });

  it("reconciles a source deletion that occurs during the initial document scan", async () => {
    const run = async (index: number) => runLexicalRebuildSlice({
      rebuilds,
      search,
      graph,
      storage: {
        async getObjectText(key: string) {
          return key === "sources/rebuild.md" ? body : null;
        }
      },
      tokenizer,
      workerId: "maintenance-worker-delete-race",
      leaseToken: `delete-race-lease-${index}`,
      now: `2026-07-24T05:${String(index).padStart(2, "0")}:00.000Z`,
      leaseExpiresAt: `2026-07-24T05:${String(index).padStart(2, "0")}:30.000Z`,
      batchSize: 10,
      concurrency: 2,
      retryDelayMs: 1_000
    });

    await expect(run(0)).resolves.toMatchObject({ phase: "documents", processed: 1 });
    await sql`
      UPDATE focowiki.source_files
      SET deleted_at = '2026-07-24T05:00:30.000Z'
      WHERE knowledge_base_id = ${knowledgeBaseId}
        AND id = ${sourceFileId}
    `;
    await expect(run(1)).resolves.toMatchObject({
      phase: "documents",
      processed: 0,
      failed: false
    });
    const afterInitialScan = await sql<Array<{ phase: string }>>`
      SELECT phase
      FROM focowiki.knowledge_base_lexical_rebuilds
      WHERE knowledge_base_id = ${knowledgeBaseId}
    `;
    expect(afterInitialScan[0]?.phase).toBe("reconcile");

    await expect(run(2)).resolves.toMatchObject({
      phase: "reconcile",
      processed: 0,
      failed: false
    });
    await expect(run(3)).resolves.toMatchObject({ phase: "validate", failed: false });
    await expect(run(4)).resolves.toMatchObject({ phase: "activate", failed: false });
    await expect(run(5)).resolves.toMatchObject({ phase: "cleanup", completed: true });

    const targetGenerationId = await currentRebuildTarget();
    const state = await sql<Array<{
      reference_count: number;
      active_generation_id: string;
      rebuild_state: string;
    }>>`
      SELECT
        (
          SELECT count(*)::int
          FROM focowiki.generation_search_projection_refs reference
          WHERE reference.generation_id = rebuild.target_generation_id
        ) AS reference_count,
        knowledge_base.active_generation_id,
        rebuild.state AS rebuild_state
      FROM focowiki.knowledge_base_lexical_rebuilds rebuild
      JOIN focowiki.knowledge_bases knowledge_base
        ON knowledge_base.id = rebuild.knowledge_base_id
      WHERE rebuild.knowledge_base_id = ${knowledgeBaseId}
    `;
    expect(targetGenerationId).toBe(state[0]?.active_generation_id);
    expect(state[0]).toMatchObject({
      reference_count: 0,
      rebuild_state: "completed"
    });
  });

  it("reconciles a source replacement and move that occur during the initial document scan", async () => {
    const replacementBody = "# Replacement\n\nUpdated late body evidence remains searchable.";
    const replacementRevisionId = "source-revision-lexical-rebuild-replacement";
    const sourceReads: string[] = [];
    const run = async (index: number) => runLexicalRebuildSlice({
      rebuilds,
      search,
      graph,
      storage: {
        async getObjectText(key: string) {
          sourceReads.push(key);
          if (key === "sources/rebuild.md") return body;
          if (key === "sources/rebuild-replacement.md") return replacementBody;
          return null;
        }
      },
      tokenizer,
      workerId: "maintenance-worker-replacement-race",
      leaseToken: `replacement-race-lease-${index}`,
      now: `2026-07-24T05:${String(index + 10).padStart(2, "0")}:00.000Z`,
      leaseExpiresAt: `2026-07-24T05:${String(index + 10).padStart(2, "0")}:30.000Z`,
      batchSize: 10,
      concurrency: 2,
      retryDelayMs: 1_000
    });

    await expect(run(0)).resolves.toMatchObject({ phase: "documents", processed: 1 });
    await replaceAndMoveSource({
      revisionId: replacementRevisionId,
      body: replacementBody,
      relativePath: "reference/rebuild-replacement.md",
      objectKey: "sources/rebuild-replacement.md"
    });
    await expect(run(1)).resolves.toMatchObject({ phase: "documents", processed: 0 });
    await expect(run(2)).resolves.toMatchObject({
      phase: "reconcile",
      processed: 1,
      failed: false
    });
    expect(sourceReads).toEqual([
      "sources/rebuild.md",
      "sources/rebuild-replacement.md"
    ]);

    const targetGenerationId = await currentRebuildTarget();
    const references = await sql<Array<{
      source_revision_id: string;
      logical_path: string;
      reference_count: number;
    }>>`
      SELECT max(source_revision_id) AS source_revision_id,
             max(logical_path) AS logical_path,
             count(*)::int AS reference_count
      FROM focowiki.generation_search_projection_refs
      WHERE generation_id = ${targetGenerationId}
        AND source_file_id = ${sourceFileId}
    `;
    expect(references[0]).toEqual({
      source_revision_id: replacementRevisionId,
      logical_path: "pages/reference/rebuild-replacement.md",
      reference_count: 1
    });
  });

  it("reclaims an expired lease without creating a duplicate candidate generation", async () => {
    await rebuilds.bootstrap({
      searchSchemaVersion: "body-search-v1",
      tokenizerContractVersion: tokenizer.contractVersion,
      segmentationVersion: "body-segmentation-v1",
      contentProfileVersion: "content-profile-v2",
      graphLexicalProjectionVersion: "graph-lexical-v2",
      now: "2026-07-24T06:00:00.000Z"
    });
    const first = await rebuilds.claimNext({
      workerId: "maintenance-worker-a",
      leaseToken: "lease-a",
      targetGenerationId: "generation-lexical-lease-a",
      now: "2026-07-24T06:00:00.000Z",
      leaseExpiresAt: "2026-07-24T06:01:00.000Z"
    });
    expect(first).not.toBeNull();
    expect(first?.leaseRecovered).toBe(false);
    await expect(rebuilds.claimNext({
      workerId: "maintenance-worker-b",
      leaseToken: "lease-b-before-expiry",
      targetGenerationId: "generation-lexical-lease-b-before-expiry",
      now: "2026-07-24T06:00:30.000Z",
      leaseExpiresAt: "2026-07-24T06:01:30.000Z"
    })).resolves.toBeNull();
    await rebuilds.heartbeat({
      knowledgeBaseId,
      workerId: "maintenance-worker-a",
      leaseToken: "lease-a",
      heartbeatAt: "2026-07-24T06:00:50.000Z",
      leaseExpiresAt: "2026-07-24T06:02:00.000Z"
    });
    await expect(rebuilds.claimNext({
      workerId: "maintenance-worker-b",
      leaseToken: "lease-b-after-heartbeat",
      targetGenerationId: "generation-lexical-lease-b-after-heartbeat",
      now: "2026-07-24T06:01:01.000Z",
      leaseExpiresAt: "2026-07-24T06:02:01.000Z"
    })).resolves.toBeNull();

    const reclaimed = await rebuilds.claimNext({
      workerId: "maintenance-worker-b",
      leaseToken: "lease-b",
      targetGenerationId: "generation-lexical-lease-b",
      now: "2026-07-24T06:02:01.000Z",
      leaseExpiresAt: "2026-07-24T06:03:01.000Z"
    });
    expect(reclaimed?.targetGenerationId).toBe(first?.targetGenerationId);
    expect(reclaimed?.leaseRecovered).toBe(true);
    const generations = await sql<Array<{ count: number }>>`
      SELECT count(*)::int AS count
      FROM focowiki.publication_generations
      WHERE knowledge_base_id = ${knowledgeBaseId}
        AND generation_kind = 'lexical_rebuild'
    `;
    expect(generations[0]?.count).toBe(1);
  });

  it("stops retrying after the durable attempt limit and leaves the active generation unchanged", async () => {
    await rebuilds.bootstrap({
      searchSchemaVersion: "body-search-v1",
      tokenizerContractVersion: tokenizer.contractVersion,
      segmentationVersion: "body-segmentation-v1",
      contentProfileVersion: "content-profile-v2",
      graphLexicalProjectionVersion: "graph-lexical-v2",
      now: "2026-07-24T07:00:00.000Z"
    });

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const now = `2026-07-24T07:00:${String(attempt * 2).padStart(2, "0")}.000Z`;
      const claim = await rebuilds.claimNext({
        workerId: "maintenance-worker-failure",
        leaseToken: `failure-lease-${attempt}`,
        targetGenerationId: `generation-lexical-failure-${attempt}`,
        now,
        leaseExpiresAt: `2026-07-24T07:01:${String(attempt * 2).padStart(2, "0")}.000Z`
      });
      expect(claim).not.toBeNull();
      await expect(rebuilds.fail({
        knowledgeBaseId,
        workerId: "maintenance-worker-failure",
        leaseToken: `failure-lease-${attempt}`,
        errorCode: "LEXICAL_REBUILD_TEST_FAILURE",
        errorMessage: "The deterministic rebuild test failed.",
        failedAt: now,
        retryDelayMs: 1_000
      })).resolves.toEqual({
        attemptCount: attempt + 1,
        maxAttempts: 5,
        terminal: attempt === 4
      });
    }

    await expect(rebuilds.claimNext({
      workerId: "maintenance-worker-failure",
      leaseToken: "failure-lease-exhausted",
      targetGenerationId: "generation-lexical-failure-exhausted",
      now: "2026-07-24T07:01:00.000Z",
      leaseExpiresAt: "2026-07-24T07:02:00.000Z"
    })).resolves.toBeNull();

    const state = await sql<Array<{
      active_generation_id: string;
      rebuild_state: string;
      attempt_count: number;
      last_error_code: string;
    }>>`
      SELECT knowledge_base.active_generation_id,
             rebuild.state AS rebuild_state,
             rebuild.attempt_count,
             rebuild.last_error_code
      FROM focowiki.knowledge_base_lexical_rebuilds rebuild
      JOIN focowiki.knowledge_bases knowledge_base
        ON knowledge_base.id = rebuild.knowledge_base_id
      WHERE rebuild.knowledge_base_id = ${knowledgeBaseId}
    `;
    expect(state[0]).toEqual({
      active_generation_id: baseGenerationId,
      rebuild_state: "failed",
      attempt_count: 5,
      last_error_code: "LEXICAL_REBUILD_TEST_FAILURE"
    });
  });

  it("rejects activation when accepted graph-edge parity is inconsistent", async () => {
    const run = async (index: number) => runLexicalRebuildSlice({
      rebuilds,
      search,
      graph,
      storage: {
        async getObjectText(key: string) {
          return key === "sources/rebuild.md" ? body : null;
        }
      },
      tokenizer,
      workerId: "maintenance-worker-edge-parity",
      leaseToken: `edge-parity-lease-${index}`,
      now: `2026-07-24T07:30:${String(index).padStart(2, "0")}.000Z`,
      leaseExpiresAt: `2026-07-24T07:31:${String(index).padStart(2, "0")}.000Z`,
      batchSize: 10,
      concurrency: 2,
      retryDelayMs: 1_000
    });

    await expect(run(0)).resolves.toMatchObject({ phase: "documents", processed: 1 });
    await expect(run(1)).resolves.toMatchObject({ phase: "documents", processed: 0 });
    await expect(run(2)).resolves.toMatchObject({ phase: "reconcile", processed: 0 });
    await sql`
      INSERT INTO focowiki.generation_graph_summaries (
        knowledge_base_id, generation_id, node_count, edge_count,
        graph_index_available
      ) VALUES (
        ${knowledgeBaseId}, ${baseGenerationId}, 1, 1, true
      )
    `;

    await expect(run(3)).resolves.toMatchObject({
      phase: "validate",
      failed: true
    });
    const state = await sql<Array<{
      active_generation_id: string;
      last_error_message: string | null;
    }>>`
      SELECT knowledge_base.active_generation_id, rebuild.last_error_message
      FROM focowiki.knowledge_bases knowledge_base
      JOIN focowiki.knowledge_base_lexical_rebuilds rebuild
        ON rebuild.knowledge_base_id = knowledge_base.id
      WHERE knowledge_base.id = ${knowledgeBaseId}
    `;
    expect(state[0]?.active_generation_id).toBe(baseGenerationId);
    expect(state[0]?.last_error_message).toBe(
      "Lexical search projection parity validation failed"
    );
  });

  it("does not reset a failed rebuild retry delay during repeated bootstrap", async () => {
    const bootstrapInput = {
      searchSchemaVersion: "body-search-v1",
      tokenizerContractVersion: tokenizer.contractVersion,
      segmentationVersion: "body-segmentation-v1",
      contentProfileVersion: "content-profile-v2",
      graphLexicalProjectionVersion: "graph-lexical-v2",
      now: "2026-07-24T08:00:00.000Z"
    };
    await expect(rebuilds.bootstrap(bootstrapInput)).resolves.toBe(1);
    const claim = await rebuilds.claimNext({
      workerId: "maintenance-worker-retry-delay",
      leaseToken: "retry-delay-lease",
      targetGenerationId: "generation-lexical-retry-delay",
      now: bootstrapInput.now,
      leaseExpiresAt: "2026-07-24T08:01:00.000Z"
    });
    expect(claim).not.toBeNull();
    await rebuilds.fail({
      knowledgeBaseId,
      workerId: "maintenance-worker-retry-delay",
      leaseToken: "retry-delay-lease",
      errorCode: "LEXICAL_REBUILD_TEST_FAILURE",
      errorMessage: "The deterministic rebuild test failed.",
      failedAt: "2026-07-24T08:00:00.000Z",
      retryDelayMs: 60_000
    });

    await expect(rebuilds.bootstrap({
      ...bootstrapInput,
      now: "2026-07-24T08:00:01.000Z"
    })).resolves.toBe(0);
    await expect(rebuilds.claimNext({
      workerId: "maintenance-worker-retry-delay",
      leaseToken: "retry-delay-early-lease",
      targetGenerationId: "generation-lexical-retry-delay-early",
      now: "2026-07-24T08:00:01.000Z",
      leaseExpiresAt: "2026-07-24T08:01:01.000Z"
    })).resolves.toBeNull();
  });

  it("keeps rebuild claims fair across repeated maintenance bootstrap cycles", async () => {
    await seedSecondaryKnowledgeBase();
    const bootstrapInput = {
      searchSchemaVersion: "body-search-v1",
      tokenizerContractVersion: tokenizer.contractVersion,
      segmentationVersion: "body-segmentation-v1",
      contentProfileVersion: "content-profile-v2",
      graphLexicalProjectionVersion: "graph-lexical-v2",
      now: "2026-07-24T09:00:00.000Z"
    };
    await rebuilds.bootstrap(bootstrapInput);
    const first = await rebuilds.claimNext({
      workerId: "maintenance-worker-fairness",
      leaseToken: "fairness-lease-a",
      targetGenerationId: "generation-lexical-fairness-a",
      now: "2026-07-24T09:00:01.000Z",
      leaseExpiresAt: "2026-07-24T09:01:01.000Z"
    });
    expect(first).not.toBeNull();
    await rebuilds.recordDocumentProgress({
      knowledgeBaseId: first!.knowledgeBaseId,
      workerId: "maintenance-worker-fairness",
      leaseToken: "fairness-lease-a",
      sourceCursor: "source-file-fairness-cursor",
      processedCount: 0,
      updatedAt: "2026-07-24T09:00:02.000Z"
    });

    await expect(rebuilds.bootstrap({
      ...bootstrapInput,
      now: "2026-07-24T09:00:03.000Z"
    })).resolves.toBe(0);
    const second = await rebuilds.claimNext({
      workerId: "maintenance-worker-fairness",
      leaseToken: "fairness-lease-b",
      targetGenerationId: "generation-lexical-fairness-b",
      now: "2026-07-24T09:00:03.000Z",
      leaseExpiresAt: "2026-07-24T09:01:03.000Z"
    });
    expect(second?.knowledgeBaseId).not.toBe(first?.knowledgeBaseId);
  });

  async function currentRebuildTarget(): Promise<string> {
    const rows = await sql<Array<{ target_generation_id: string }>>`
      SELECT target_generation_id
      FROM focowiki.knowledge_base_lexical_rebuilds
      WHERE knowledge_base_id = ${knowledgeBaseId}
    `;
    return rows[0]!.target_generation_id;
  }

  async function advanceActiveGenerationWithNewSource(): Promise<void> {
    const sourceFileIdNew = "source-file-lexical-rebuild-new";
    const sourceRevisionIdNew = "source-revision-lexical-rebuild-new";
    const nextGenerationId = "generation-lexical-rebuild-next";
    const nextBody = "# Search\n\nA newly published source remains searchable.";
    const nextChecksum = createHash("sha256").update(nextBody).digest("hex");
    await sql.begin(async (transaction) => {
      await transaction`
        INSERT INTO focowiki.source_files (
          id, knowledge_base_id, object_key, content_type, size_bytes,
          checksum_sha256, processing_status, processing_stage,
          generated_output_status, name, relative_path, path_key,
          active_revision_id, metadata_json
        ) VALUES (
          ${sourceFileIdNew}, ${knowledgeBaseId}, 'sources/rebuild-new.md',
          'text/markdown; charset=utf-8', ${nextBody.length}, ${nextChecksum},
          'completed', 'generation_activation', 'visible', 'rebuild-new.md',
          'guides/rebuild-new.md', 'guides/rebuild-new.md', ${sourceRevisionIdNew},
          ${transaction.json({ title: "New search source" })}
        )
      `;
      await transaction`
        INSERT INTO focowiki.source_revisions (
          id, knowledge_base_id, source_file_id, revision, object_key,
          content_type, size_bytes, checksum_sha256, processing_status,
          metadata_json
        ) VALUES (
          ${sourceRevisionIdNew}, ${knowledgeBaseId}, ${sourceFileIdNew}, 1,
          'sources/rebuild-new.md', 'text/markdown; charset=utf-8',
          ${nextBody.length}, ${nextChecksum}, 'completed',
          ${transaction.json({ title: "New search source" })}
        )
      `;
      await transaction`
        UPDATE focowiki.publication_generations
        SET state = 'superseded'
        WHERE id = ${baseGenerationId}
      `;
      await transaction`
        INSERT INTO focowiki.publication_generations (
          id, knowledge_base_id, predecessor_generation_id, state,
          format_version, generation_kind, activated_at
        ) VALUES (
          ${nextGenerationId}, ${knowledgeBaseId}, ${baseGenerationId},
          'active', 2, 'normal', now()
        )
      `;
      await transaction`
        UPDATE focowiki.knowledge_bases
        SET active_generation_id = ${nextGenerationId}
        WHERE id = ${knowledgeBaseId}
      `;
    });
  }

  async function replaceAndMoveSource(input: {
    revisionId: string;
    body: string;
    relativePath: string;
    objectKey: string;
  }): Promise<void> {
    const replacementChecksum = createHash("sha256").update(input.body).digest("hex");
    await sql.begin(async (transaction) => {
      await transaction`
        INSERT INTO focowiki.source_revisions (
          id, knowledge_base_id, source_file_id, revision, object_key,
          content_type, size_bytes, checksum_sha256, processing_status,
          metadata_json
        ) VALUES (
          ${input.revisionId}, ${knowledgeBaseId}, ${sourceFileId}, 2,
          ${input.objectKey}, 'text/markdown; charset=utf-8', ${input.body.length},
          ${replacementChecksum}, 'completed',
          ${transaction.json({ title: "Replacement search source" })}
        )
      `;
      await transaction`
        UPDATE focowiki.source_files
        SET object_key = ${input.objectKey},
            size_bytes = ${input.body.length},
            checksum_sha256 = ${replacementChecksum},
            name = 'rebuild-replacement.md',
            relative_path = ${input.relativePath},
            path_key = ${input.relativePath},
            active_revision_id = ${input.revisionId},
            metadata_json = ${transaction.json({ title: "Replacement search source" })}
        WHERE knowledge_base_id = ${knowledgeBaseId}
          AND id = ${sourceFileId}
      `;
    });
  }

  async function seedSecondaryKnowledgeBase(): Promise<void> {
    await sql.begin(async (transaction) => {
      await transaction`
        INSERT INTO focowiki.knowledge_bases (id, name)
        VALUES (${secondaryKnowledgeBaseId}, 'Secondary lexical rebuild')
      `;
      await transaction`
        INSERT INTO focowiki.publication_generations (
          id, knowledge_base_id, state, format_version, generation_kind,
          activated_at
        ) VALUES (
          ${secondaryBaseGenerationId}, ${secondaryKnowledgeBaseId},
          'active', 2, 'normal', now()
        )
      `;
      await transaction`
        UPDATE focowiki.knowledge_bases
        SET active_generation_id = ${secondaryBaseGenerationId}
        WHERE id = ${secondaryKnowledgeBaseId}
      `;
    });
  }

  async function seed(): Promise<void> {
    await sql.begin(async (transaction) => {
      await transaction`
        INSERT INTO focowiki.knowledge_bases (id, name)
        VALUES (${knowledgeBaseId}, 'Lexical rebuild')
      `;
      await transaction`
        INSERT INTO focowiki.source_files (
          id, knowledge_base_id, object_key, content_type, size_bytes,
          checksum_sha256, processing_status, processing_stage,
          generated_output_status, name, relative_path, path_key,
          active_revision_id, metadata_json
        ) VALUES (
          ${sourceFileId}, ${knowledgeBaseId}, 'sources/rebuild.md',
          'text/markdown; charset=utf-8', ${body.length}, ${checksum},
          'completed', 'generation_activation', 'visible', 'rebuild.md',
          'guides/rebuild.md', 'guides/rebuild.md', ${sourceRevisionId},
          ${transaction.json({ title: "Search rebuild" })}
        )
      `;
      await transaction`
        INSERT INTO focowiki.source_revisions (
          id, knowledge_base_id, source_file_id, revision, object_key,
          content_type, size_bytes, checksum_sha256, processing_status,
          metadata_json
        ) VALUES (
          ${sourceRevisionId}, ${knowledgeBaseId}, ${sourceFileId}, 1,
          'sources/rebuild.md', 'text/markdown; charset=utf-8', ${body.length},
          ${checksum}, 'completed',
          ${transaction.json({ title: "Search rebuild" })}
        )
      `;
      await transaction`
        INSERT INTO focowiki.publication_generations (
          id, knowledge_base_id, state, format_version, generation_kind,
          activated_at
        ) VALUES (
          ${baseGenerationId}, ${knowledgeBaseId}, 'active', 2, 'normal', now()
        )
      `;
      await transaction`
        UPDATE focowiki.knowledge_bases
        SET active_generation_id = ${baseGenerationId}
        WHERE id = ${knowledgeBaseId}
      `;
    });
  }

  async function cleanup(): Promise<void> {
    await sql`
      DELETE FROM focowiki.knowledge_bases
      WHERE id IN (${knowledgeBaseId}, ${secondaryKnowledgeBaseId})
    `;
  }
});
