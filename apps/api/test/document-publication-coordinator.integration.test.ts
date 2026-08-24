import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DatabaseClient } from "../src/db/client.js";
import { planDocumentPublicationGeneration } from
  "../src/document-indexing/application/document-publication-planner.js";
import { planDocumentPublicationActivationReservations } from
  "../src/document-indexing/application/document-publication-activation.js";
import { createPostgresDocumentPublicationCoordinator } from
  "../src/document-indexing/infrastructure/postgres-document-publication-coordinator.js";
import { createPostgresDocumentPublicationSnapshot } from
  "../src/document-indexing/infrastructure/postgres-document-publication-snapshot.js";
import { createPostgresDocumentScopeGenerationRepository } from
  "../src/document-indexing/infrastructure/postgres-document-scope-generation-repository.js";
import { createProductionDocumentPublicationCoordinatorRuntime } from
  "../src/document-indexing/infrastructure/production-document-publication-coordinator-runtime.js";
import { readGenerationFactDeltas } from
  "../src/document-indexing/infrastructure/production-document-publication-fact-deltas.js";
import { applyStorageVnextTestMigrations } from
  "./helpers/storage-vnext-test-migrations.js";

const databaseUrl = process.env.FOCOWIKI_STORAGE_VNEXT_TEST_DATABASE_URL;
const runOwner = process.env.FOCOWIKI_STORAGE_VNEXT_TEST_RUN_OWNER;
const enabled = Boolean(databaseUrl && runOwner
  && /^svnext-[a-z0-9]{8,16}$/u.test(runOwner));

(enabled ? describe : describe.skip)("document publication coordinator", () => {
  const connectionUrl = databaseUrl
    ?? "postgres://unused:unused@127.0.0.1:5432/unused";
  const databaseName = `focowiki_publication_coordinator_${
    (runOwner ?? "invalid").replaceAll("-", "_")
  }_${randomUUID().replaceAll("-", "").slice(0, 8)}`;
  const admin = postgres(withDatabase(connectionUrl, "postgres"), { max: 1 });
  const sql = postgres(withDatabase(connectionUrl, databaseName), { max: 8 });
  const database = sql as unknown as DatabaseClient;
  let databaseCreated = false;

  beforeAll(async () => {
    await admin.unsafe(`CREATE DATABASE ${quote(databaseName)}`);
    databaseCreated = true;
    await applyStorageVnextTestMigrations(sql);
    await seed(sql);
  }, 120_000);

  afterAll(async () => {
    await sql.end({ timeout: 5 });
    if (databaseCreated) {
      await admin.unsafe(`DROP DATABASE IF EXISTS ${quote(databaseName)} WITH (FORCE)`);
    }
    await admin.end({ timeout: 5 });
  }, 120_000);

  it("freezes bounded ready facts independently per knowledge base", async () => {
    const coordinator = createPostgresDocumentPublicationCoordinator(database);
    const [hot, quiet] = await Promise.all([
      coordinator.freezeReady({
        knowledgeBaseId: "hot-kb",
        now: "2026-08-21T12:00:01.000Z",
        contributorCap: 2,
        rendererContractVersion: "portable-okf-v2"
      }),
      coordinator.freezeReady({
        knowledgeBaseId: "quiet-kb",
        now: "2026-08-21T12:00:01.000Z",
        contributorCap: 8,
        rendererContractVersion: "portable-okf-v2"
      })
    ]);
    expect(hot?.documents.map((item) => item.documentJobPublicId))
      .toEqual(["hot-job-1", "hot-job-2"]);
    expect(quiet?.documents.map((item) => item.documentJobPublicId))
      .toEqual(["quiet-job-1"]);
    expect(await coordinator.freezeReady({
      knowledgeBaseId: "hot-kb",
      now: "2026-08-21T12:00:02.000Z",
      contributorCap: 8,
      rendererContractVersion: "portable-okf-v2"
    })).toBeNull();
    await expect(sql<Array<{ state: string; mutation_public_id: string }>>`
      SELECT state, mutation_public_id
      FROM focowiki.projection_fact_epochs
      WHERE knowledge_base_id = 'hot-kb'
      ORDER BY fact_epoch
    `).resolves.toEqual([
      { state: "included", mutation_public_id: "hot-job-1" },
      { state: "included", mutation_public_id: "hot-job-2" },
      { state: "ready", mutation_public_id: "hot-job-3" },
      { state: "ready", mutation_public_id: "hot-job-4" }
    ]);
  });

  it("reclaims a planned generation left without scopes after interruption", async () => {
    const coordinator = createPostgresDocumentPublicationCoordinator(database);
    const reclaimed = await coordinator.claimStrandedPlan({
      knowledgeBaseId: "hot-kb",
      now: new Date(Date.now() + 31_000).toISOString(),
      staleAfterMs: 30_000
    });
    expect(reclaimed).toMatchObject({
      generationPublicId: expect.stringMatching(/^projection-generation-/u),
      rendererContractVersion: "portable-okf-v2",
      documents: expect.arrayContaining([
        expect.objectContaining({
          documentJobPublicId: expect.stringMatching(/^(hot|quiet)-job-/u),
          sourceFilePublicId: expect.stringMatching(/^(hot|quiet)-source-/u),
          sourceRevisionPublicId: expect.stringMatching(
            /^(hot|quiet)-revision-/u
          )
        })
      ])
    });
    expect(await coordinator.claimStrandedPlan({
      knowledgeBaseId: "hot-kb",
      now: new Date(Date.now() + 31_001).toISOString(),
      staleAfterMs: 30_000
    })).toBeNull();
  });

  it("loads deterministic navigation buckets for a frozen generation", async () => {
    const generations = await sql<Array<{ public_id: string }>>`
      SELECT public_id
      FROM focowiki.projection_publication_generations
      WHERE knowledge_base_id = 'hot-kb'
    `;
    await sql.begin(async (transaction) => {
      await transaction`SET LOCAL session_replication_role = replica`;
      await transaction`
        INSERT INTO focowiki.canonical_file_relations (
          public_id, knowledge_base_id, pair_public_id,
          first_source_file_public_id, first_source_revision_public_id,
          second_source_file_public_id, second_source_revision_public_id,
          relation_kind, direction, active
        ) VALUES (
          'pending-relation', 'hot-kb', 'pending-pair',
          'hot-source-1', 'hot-revision-1',
          'pending-source', 'pending-revision',
          'related', 'bidirectional', false
        )
      `;
      await transaction`
        INSERT INTO focowiki.relation_directed_evidence (
          public_id, knowledge_base_id, pair_public_id,
          source_file_public_id, source_revision_public_id,
          target_source_file_public_id, target_source_revision_public_id,
          evidence_kind, evidence_fingerprint_sha256, evidence, active
        ) VALUES (
          'active-related-evidence', 'hot-kb', 'active-related-pair',
          'hot-source-1', 'hot-revision-1',
          'active-related-source', 'active-related-revision',
          'first_layer', repeat('e', 64), '{}'::jsonb, true
        )
      `;
      await transaction`
        INSERT INTO focowiki.document_projection_records (
          knowledge_base_id, source_file_public_id,
          source_revision_public_id, logical_path, normalized_path,
          title, summary, content_type, checksum_sha256, byte_count,
          tokenizer_contract_version,
          navigation_term_fingerprint_sha256, active
        ) VALUES (
          'hot-kb', 'active-related-source', 'active-related-revision',
          'reference/related.md', 'reference/related.md', 'Related', '',
          'text/markdown', repeat('c', 64), 1, 'nodejieba-v1',
          repeat('d', 64), true
        )
      `;
      await transaction`
        INSERT INTO focowiki.canonical_file_relations (
          public_id, knowledge_base_id, pair_public_id,
          first_source_file_public_id, first_source_revision_public_id,
          second_source_file_public_id, second_source_revision_public_id,
          relation_kind, direction, active, activated_sequence
        ) VALUES (
          'active-related-relation', 'hot-kb', 'active-related-pair',
          'hot-source-1', 'hot-revision-1',
          'active-related-source', 'active-related-revision',
          'related', 'bidirectional', true, 1
        )
      `;
      await transaction`
        INSERT INTO focowiki.source_file_active_revisions (
          knowledge_base_id, source_file_public_id,
          current_source_revision_public_id, active_source_revision_public_id,
          activation_sequence
        ) VALUES (
          'delete-kb', 'survivor-source-1', 'survivor-revision-1',
          'survivor-revision-1', 0
        )
      `;
    });
    const documents = await readGenerationFactDeltas(
      database,
      generations[0]!.public_id
    );
    expect(documents).toEqual(expect.arrayContaining([
      expect.objectContaining({ nextTermBuckets: ["latin"] })
    ]));
    expect(documents.find((document) =>
      document.sourceFilePublicId === "hot-source-1"
    )).toMatchObject({
      relatedSourceFilePublicIds: ["active-related-source"],
      nextGraphDirectoryPaths: expect.arrayContaining([
        "pages/hot",
        "pages/reference"
      ])
    });
  });

  it("freezes deletion facts without requiring a document job", async () => {
    await sql`
      INSERT INTO focowiki.knowledge_bases (public_id, name, revision)
      VALUES ('delete-kb', 'Delete', 1)
    `;
    await sql`
      INSERT INTO focowiki.projection_cutover_states (
        knowledge_base_id, writer_mode
      ) VALUES ('delete-kb', 'coherent')
    `;
    await sql`
      INSERT INTO focowiki.projection_fact_epochs (
        knowledge_base_id, fact_epoch, mutation_public_id,
        mutation_group_public_id, source_file_public_id,
        source_revision_public_id, fact_kind, created_at
      ) VALUES (
        'delete-kb', 1, 'delete-mutation-1', 'delete-operation-1',
        'delete-source-1', 'delete-revision-1', 'delete',
        '2026-08-21T12:00:00.000Z'
      )
    `;
    const frozen = await createPostgresDocumentPublicationCoordinator(database)
      .freezeReady({
        knowledgeBaseId: "delete-kb",
        now: "2026-08-21T12:00:01.000Z",
        contributorCap: 8,
        rendererContractVersion: "portable-okf-v2"
      });
    expect(frozen?.documents).toEqual([expect.objectContaining({
      mutationPublicId: "delete-mutation-1",
      documentJobPublicId: null,
      sourceFilePublicId: "delete-source-1",
      sourceRevisionPublicId: "delete-revision-1"
    })]);
    await expect(sql`
      SELECT mutation_public_id, document_job_public_id,
             source_file_public_id, source_revision_public_id
      FROM focowiki.projection_generation_documents
      WHERE generation_public_id = ${frozen!.generationPublicId}
    `).resolves.toEqual([{
      mutation_public_id: "delete-mutation-1",
      document_job_public_id: null,
      source_file_public_id: "delete-source-1",
      source_revision_public_id: "delete-revision-1"
    }]);
    await sql.begin(async (transaction) => {
      await transaction`SET LOCAL session_replication_role = replica`;
      await transaction`
        INSERT INTO focowiki.document_projection_records (
          knowledge_base_id, source_file_public_id,
          source_revision_public_id, logical_path, normalized_path,
          title, summary, content_type, checksum_sha256, byte_count,
          tokenizer_contract_version,
          navigation_term_fingerprint_sha256, active, retired_at
        ) VALUES (
          'delete-kb', 'delete-source-1', 'delete-revision-1',
          'archive/deep/deleted.md', 'archive/deep/deleted.md',
          'Deleted document', '', 'text/markdown',
          repeat('a', 64), 1, 'nodejieba-v1', repeat('b', 64),
          false, '2026-08-21T12:00:00.000Z'
        )
      `;
      await transaction`
        INSERT INTO focowiki.canonical_file_relations (
          public_id, knowledge_base_id, pair_public_id,
          first_source_file_public_id, first_source_revision_public_id,
          second_source_file_public_id, second_source_revision_public_id,
          relation_kind, direction, active, retired_at
        ) VALUES (
          'delete-relation-1', 'delete-kb', 'delete-pair-1',
          'delete-source-1', 'delete-revision-1',
          'survivor-source-1', 'survivor-revision-1',
          'related', 'bidirectional', false,
          '2026-08-21T12:00:00.000Z'
        )
      `;
    });
    await expect(readGenerationFactDeltas(
      database,
      frozen!.generationPublicId
    )).resolves.toEqual([expect.objectContaining({
      priorLogicalPath: "archive/deep/deleted.md",
      nextLogicalPath: null,
      relatedSourceFilePublicIds: ["survivor-source-1"],
      priorGraphDirectoryPaths: [
        "pages/archive/deep",
        "pages/archive",
        "pages"
      ],
      nextGraphDirectoryPaths: []
    })]);
  });

  it("persists immutable members and a dependency DAG in one plan", async () => {
    const coordinator = createPostgresDocumentPublicationCoordinator(database);
    const generations = await sql<Array<{
      public_id: string;
      target_fact_epoch: number | string;
      deterministic_changed_at: Date;
    }>>`
      SELECT public_id, target_fact_epoch, deterministic_changed_at
      FROM focowiki.projection_publication_generations
      WHERE knowledge_base_id = 'hot-kb'
    `;
    const generation = generations[0]!;
    const documents = [
      delta("hot-job-1", "hot-source-1", "hot-revision-1", 1,
        "laws/alpha.md", ["term-a"], ["active-related-source"]),
      delta("hot-job-2", "hot-source-2", "hot-revision-2", 2,
        "laws/beta.md", ["term-b"], ["hot-source-1"])
    ];
    const plan = planDocumentPublicationGeneration({
      generationPublicId: generation.public_id,
      baseGenerationPublicId: null,
      targetFactEpoch: Number(generation.target_fact_epoch),
      rendererContractVersion: "portable-okf-v2",
      deterministicChangedAt:
        generation.deterministic_changed_at.toISOString(),
      documents
    });
    await expect(coordinator.persistPlan({
      generationPublicId: generation.public_id,
      documents,
      scopes: plan.scopes,
      ownerReservations: planDocumentPublicationActivationReservations({
        documents: documents.map((document) => ({
          documentJobPublicId: document.documentJobPublicId,
          sourceFilePublicId: document.sourceFilePublicId,
          relatedSourceFilePublicIds: document.relatedSourceFilePublicIds
        })),
        putPaths: plan.putPaths,
        deletePaths: plan.deletePaths,
        searchSourceFilePublicIds: plan.searchSourceFilePublicIds,
        directoryPaths: plan.scopes.flatMap((scope) =>
          scope.kind === "directory" ? [scope.key] : [])
      }),
      createdAt: "2026-08-21T12:00:02.000Z"
    })).resolves.toBe(plan.scopes.length);
    const summary = await sql<Array<{
      state: string;
      scope_count: number | string;
      member_count: number | string;
      dependency_count: number | string;
    }>>`
      SELECT generation.state,
             count(DISTINCT scope.public_id) AS scope_count,
             count(DISTINCT (member.scope_generation_public_id,
                             member.member_kind,
                             member.member_public_id)) AS member_count,
             count(DISTINCT (dependency.scope_generation_public_id,
                             dependency.depends_on_scope_generation_public_id))
               AS dependency_count
      FROM focowiki.projection_publication_generations generation
      JOIN focowiki.projection_scope_generations scope
        ON scope.publication_generation_public_id = generation.public_id
      LEFT JOIN focowiki.projection_scope_snapshot_members member
        ON member.scope_generation_public_id = scope.public_id
      LEFT JOIN focowiki.projection_scope_generation_dependencies dependency
        ON dependency.scope_generation_public_id = scope.public_id
      WHERE generation.public_id = ${generation.public_id}
      GROUP BY generation.state
    `;
    expect(summary).toHaveLength(1);
    expect(summary[0]!.state).toBe("rendering");
    expect(Number(summary[0]!.scope_count)).toBe(plan.scopes.length);
    expect(Number(summary[0]!.member_count)).toBeGreaterThan(0);
    expect(Number(summary[0]!.member_count))
      .toBeLessThanOrEqual(plan.scopes.length * documents.length);
    expect(Number(summary[0]!.dependency_count)).toBeGreaterThan(0);
    await expect(sql<Array<{
      source_revision_public_id: string;
      incoming_count: number;
      outgoing_count: number;
    }>>`
      SELECT source_revision_public_id, incoming_count, outgoing_count
      FROM focowiki.projection_generation_graph_degrees
      WHERE publication_generation_public_id = ${generation.public_id}
      ORDER BY source_revision_public_id COLLATE "C"
    `).resolves.toEqual(expect.arrayContaining([
      {
        source_revision_public_id: "active-related-revision",
        incoming_count: 1,
        outgoing_count: 0
      },
      {
        source_revision_public_id: "hot-revision-1",
        incoming_count: 0,
        outgoing_count: 1
      },
      {
        source_revision_public_id: "hot-revision-2",
        incoming_count: 0,
        outgoing_count: 0
      }
    ]));
    const sourceScopes = await sql<Array<{ public_id: string }>>`
      SELECT public_id FROM focowiki.projection_scope_generations
      WHERE publication_generation_public_id = ${generation.public_id}
        AND scope_identity = 'source:hot-source-1'
    `;
    const snapshot = await createPostgresDocumentPublicationSnapshot(database)
      .readScope(sourceScopes[0]!.public_id);
    expect(snapshot.members).toContainEqual({
      kind: "source_revision",
      publicId: "hot-revision-1",
      version: "1",
      order: 0,
      sourceFilePublicId: null
    });
    expect(snapshot.scopeGeneration).toBe(1);
    expect(snapshot.targetFactEpoch).toBe(2);
    expect(snapshot.basePages).toEqual([]);
    const relatedScopes = await sql<Array<{ public_id: string }>>`
      SELECT public_id FROM focowiki.projection_scope_generations
      WHERE publication_generation_public_id = ${generation.public_id}
        AND scope_identity = 'source:active-related-source'
    `;
    const relatedSnapshot = await createPostgresDocumentPublicationSnapshot(
      database
    ).readScope(relatedScopes[0]!.public_id);
    expect(relatedSnapshot.members).toContainEqual({
      kind: "source_revision",
      publicId: "active-related-revision",
      version: "11",
      order: 1,
      sourceFilePublicId: "active-related-source"
    });
    const scopeRepository = createPostgresDocumentScopeGenerationRepository(
      database
    );
    const claimed = await scopeRepository.claim({
      workerId: "coordinator-worker",
      now: "2026-08-21T12:00:03.000Z",
      leaseDurationMs: 30_000,
      limit: 256
    });
    expect(claimed[0]).toMatchObject({
      knowledgeBaseId: "hot-kb",
      publicationGenerationPublicId: generation.public_id,
      targetFactEpoch: 2,
      activeFactEpoch: 0,
      scopeGeneration: 1,
      safeScopeKeyHash: expect.stringMatching(/^[0-9a-f]{64}$/u)
    });
    const claimedRows = await sql<Array<{ scope_identity: string }>>`
      SELECT scope_identity
      FROM focowiki.projection_scope_generations
      WHERE public_id IN ${sql(claimed.map((item) => item.publicId))}
    `;
    expect(claimedRows.length).toBeGreaterThan(0);
    expect(claimedRows.some((row) =>
      row.scope_identity === "root:index"
      || row.scope_identity.startsWith("validation:"))).toBe(false);
  });

  it("emits bounded per-knowledge-base backlog from durable state", async () => {
    await sql`
      INSERT INTO focowiki.projection_cutover_states (
        knowledge_base_id, writer_mode
      ) VALUES ('hot-kb', 'coherent')
      ON CONFLICT (knowledge_base_id) DO UPDATE SET writer_mode = 'coherent'
    `;
    const backlogs: Array<Record<string, unknown>> = [];
    const runtime = createProductionDocumentPublicationCoordinatorRuntime({
      sql: database,
      observability: {
        publication: () => undefined,
        publicationBacklog: (fields) => backlogs.push(fields)
      }
    });
    await runtime.runOne("2026-08-21T12:00:04.000Z");
    expect(backlogs).toContainEqual(expect.objectContaining({
      knowledgeBaseId: "hot-kb",
      runningScopeCount: expect.any(Number),
      waitingScopeCount: expect.any(Number),
      dirtyFactCount: 2,
      oldestAgeMs: expect.any(Number),
      statusRegressionCount: 0
    }));
  });
});

function delta(
  documentJobPublicId: string,
  sourceFilePublicId: string,
  sourceRevisionPublicId: string,
  factEpoch: number,
  path: string,
  terms: readonly string[],
  related: readonly string[]
) {
  return {
    mutationPublicId: documentJobPublicId,
    documentJobPublicId,
    sourceFilePublicId,
    sourceRevisionPublicId,
    factEpoch,
    operation: "create" as const,
    priorLogicalPath: null,
    nextLogicalPath: path,
    priorTermBuckets: [],
    nextTermBuckets: terms,
    relatedSourceFilePublicIds: related,
    priorGraphDirectoryPaths: [],
    nextGraphDirectoryPaths: ["laws"]
  };
}

async function seed(sql: postgres.Sql): Promise<void> {
  await sql`
    INSERT INTO focowiki.knowledge_bases (public_id, name, revision)
    VALUES ('hot-kb', 'Hot', 1), ('quiet-kb', 'Quiet', 1)
  `;
  await sql`
    INSERT INTO focowiki.knowledge_base_sequences (
      knowledge_base_id, current_sequence
    ) VALUES ('hot-kb', 11), ('quiet-kb', 0)
  `;
  await sql`
    INSERT INTO focowiki.object_registrations (
      object_id, storage_key, checksum_sha256, byte_count, content_type,
      object_format, state, write_attempt_public_id, verified_at
    ) VALUES (
      'active-related-object', 'objects/active-related-object',
      ${"a".repeat(64)}, 1, 'text/markdown; charset=utf-8',
      'source-markdown-v1', 'verified', 'active-related-attempt',
      '2026-08-21T11:58:00.000Z'
    )
  `;
  await sql`
    INSERT INTO focowiki.source_files (
      public_id, knowledge_base_id, logical_path, normalized_path,
      title, metadata, revision
    ) VALUES (
      'active-related-source', 'hot-kb', 'laws/related.md',
      'laws/related.md', 'Related', '{}'::jsonb, 1
    )
  `;
  await sql`
    INSERT INTO focowiki.source_revisions (
      public_id, knowledge_base_id, source_file_public_id, object_id,
      checksum_sha256, byte_count, content_type
    ) VALUES (
      'active-related-revision', 'hot-kb', 'active-related-source',
      'active-related-object', ${"a".repeat(64)}, 1,
      'text/markdown; charset=utf-8'
    )
  `;
  await sql`
    INSERT INTO focowiki.source_file_active_revisions (
      knowledge_base_id, source_file_public_id,
      current_source_revision_public_id, active_source_revision_public_id,
      activation_sequence
    ) VALUES (
      'hot-kb', 'active-related-source', 'active-related-revision',
      'active-related-revision', 11
    )
  `;
  await sql.begin(async (transaction) => {
    await transaction`SET LOCAL session_replication_role = replica`;
    for (const [knowledgeBaseId, prefix, count] of [
      ["hot-kb", "hot", 4],
      ["quiet-kb", "quiet", 1]
    ] as const) {
      for (let index = 1; index <= count; index += 1) {
        await transaction`
          INSERT INTO focowiki.document_processing_jobs (
            public_id, knowledge_base_id, operation_public_id,
            source_file_public_id, source_revision_public_id,
            runtime_settings_revision_public_id,
            generation_model_configuration_public_id,
            generation_model_configuration_revision,
            embedding_configuration_revision_public_id,
            semantic_generation_public_id, semantic_contract_version,
            state, maximum_attempts, accepted_at, started_at,
            created_at, updated_at
          ) VALUES (
            ${`${prefix}-job-${index}`}, ${knowledgeBaseId},
            ${`${prefix}-operation-${index}`}, ${`${prefix}-source-${index}`},
            ${`${prefix}-revision-${index}`}, 'settings', 'model', 1,
            'embedding', 'semantic', 'contract', 'processing', 3,
            '2026-08-21T11:59:00.000Z', '2026-08-21T11:59:00.000Z',
            '2026-08-21T11:59:00.000Z', '2026-08-21T11:59:00.000Z'
          )
        `;
        await transaction`
          INSERT INTO focowiki.document_artifact_work (
            public_id, knowledge_base_id, document_job_public_id,
            source_file_public_id, source_revision_public_id,
            work_kind, resource_lane, input_fingerprint_sha256,
            state, maximum_attempts, next_eligible_at, created_at, updated_at
          ) VALUES (
            ${`${prefix}-work-${index}`}, ${knowledgeBaseId},
            ${`${prefix}-job-${index}`}, ${`${prefix}-source-${index}`},
            ${`${prefix}-revision-${index}`}, 'knowledge_projection',
            'projection', ${index.toString(16).padStart(64, "0")},
            ${prefix === "hot" && index === 4
              ? "waiting" : "waiting_on_projection"},
            3, '2026-08-21T11:59:00.000Z',
            '2026-08-21T11:59:00.000Z', '2026-08-21T11:59:00.000Z'
          )
        `;
        await transaction`
          INSERT INTO focowiki.document_projection_records (
            knowledge_base_id, source_file_public_id,
            source_revision_public_id, logical_path, normalized_path,
            title, summary, content_type, checksum_sha256, byte_count,
            tokenizer_contract_version,
            navigation_term_fingerprint_sha256
          ) VALUES (
            ${knowledgeBaseId}, ${`${prefix}-source-${index}`},
            ${`${prefix}-revision-${index}`},
            ${`${prefix}/document-${index}.md`},
            ${`${prefix}/document-${index}.md`},
            ${`${prefix} document ${index}`}, '', 'text/markdown',
            ${index.toString(16).padStart(64, "0")}, 1,
            'nodejieba-v1', ${index.toString(16).padStart(64, "0")}
          )
        `;
        await transaction`
          INSERT INTO focowiki.document_navigation_terms (
            knowledge_base_id, source_revision_public_id,
            term, bucket, priority
          ) VALUES (
            ${knowledgeBaseId}, ${`${prefix}-revision-${index}`},
            ${`${prefix}-term-${index}`}, 'latin', 1
          )
        `;
      }
    }
  });
  await sql`
    INSERT INTO focowiki.projection_fact_epochs (
      knowledge_base_id, fact_epoch, mutation_public_id,
      source_file_public_id, source_revision_public_id, fact_kind, created_at
    ) VALUES
      ('hot-kb', 1, 'hot-job-1', 'hot-source-1', 'hot-revision-1',
       'create', '2026-08-21T11:59:58.000Z'),
      ('hot-kb', 2, 'hot-job-2', 'hot-source-2', 'hot-revision-2',
       'create', '2026-08-21T11:59:58.100Z'),
      ('hot-kb', 3, 'hot-job-3', 'hot-source-3', 'hot-revision-3',
       'create', '2026-08-21T11:59:58.200Z'),
      ('hot-kb', 4, 'hot-job-4', 'hot-source-4', 'hot-revision-4',
       'create', '2026-08-21T11:59:58.300Z'),
      ('quiet-kb', 1, 'quiet-job-1', 'quiet-source-1', 'quiet-revision-1',
       'create', '2026-08-21T11:59:58.000Z')
  `;
}

function withDatabase(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

function quote(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}
