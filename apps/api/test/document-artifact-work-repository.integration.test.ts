import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyStorageVnextTestMigrations } from
  "./helpers/storage-vnext-test-migrations.js";
import { createPostgresDocumentArtifactWorkRepository } from
  "../src/document-indexing/infrastructure/postgres-document-artifact-work-repository.js";
import type { DatabaseClient } from "../src/db/client.js";
import { DOCUMENT_WORK_KINDS } from
  "../src/document-indexing/domain/document-work-graph.js";
import { createPostgresDocumentReferenceFactRepository } from
  "../src/document-indexing/infrastructure/postgres-document-reference-fact-repository.js";
import { createPostgresDocumentJobRepository } from
  "../src/document-indexing/infrastructure/postgres-document-job-repository.js";
import { createPostgresProjectionDirtyScopeRepository } from
  "../src/document-indexing/infrastructure/postgres-projection-dirty-scope-repository.js";
import { createPostgresProjectionScopeContributions } from
  "../src/document-indexing/infrastructure/postgres-projection-scope-contributions.js";
import { createPostgresProjectionScopeCompletion } from
  "../src/document-indexing/infrastructure/postgres-projection-scope-completion.js";
import { createPostgresProjectionScopeOutputRepository } from
  "../src/document-indexing/infrastructure/postgres-projection-scope-output-repository.js";
import { createPostgresGeneratedPageRepository } from
  "../src/document-indexing/infrastructure/postgres-generated-page-repository.js";
import { createPostgresRelationPairRepository } from
  "../src/document-indexing/infrastructure/postgres-relation-pair-repository.js";
import { createPostgresScopedActivationOwnerRepository } from
  "../src/document-indexing/infrastructure/postgres-scoped-activation-owner-repository.js";
import { createPostgresDocumentGraphRagChunkRepository } from
  "../src/document-indexing/infrastructure/postgres-document-graphrag-chunk-repository.js";
import { applyPostgresDocumentRelationActivation } from
  "../src/document-indexing/infrastructure/postgres-document-relation-activation.js";
import { createPostgresCandidateFileRelationRepository } from
  "../src/document-indexing/infrastructure/postgres-candidate-file-relation-repository.js";

const databaseUrl = process.env.FOCOWIKI_STORAGE_VNEXT_TEST_DATABASE_URL;
const runOwner = process.env.FOCOWIKI_STORAGE_VNEXT_TEST_RUN_OWNER;
const enabled = Boolean(
  databaseUrl && runOwner && /^svnext-[a-z0-9]{8,16}$/u.test(runOwner)
);
const describeOwnedDatabase = enabled ? describe : describe.skip;
const testStartedAt = Date.now() + 10_000;

describeOwnedDatabase("PostgreSQL fixed document work repository", () => {
  const connectionUrl = databaseUrl
    ?? "postgres://unused:unused@127.0.0.1:5432/unused";
  const databaseName = "focowiki_work_"
    + (runOwner ?? "invalid").replaceAll("-", "_") + "_"
    + randomUUID().replaceAll("-", "").slice(0, 10);
  const admin = postgres(withDatabase(connectionUrl, "postgres"), { max: 1 });
  const sql = postgres(withDatabase(connectionUrl, databaseName), { max: 4 });
  let created = false;

  beforeAll(async () => {
    await admin.unsafe("CREATE DATABASE " + quote(databaseName));
    created = true;
    await applyStorageVnextTestMigrations(sql);
    await seedDocument(sql);
  }, 120_000);

  afterAll(async () => {
    await sql.end({ timeout: 5 });
    if (created) {
      await admin.unsafe("DROP DATABASE IF EXISTS " + quote(databaseName) + " WITH (FORCE)");
    }
    await admin.end({ timeout: 5 });
  }, 120_000);

  it("creates the closed graph and fans out after a durable prepare receipt", async () => {
    const repository = createPostgresDocumentArtifactWorkRepository(
      sql as unknown as DatabaseClient
    );
    const fingerprints = Object.fromEntries(
      DOCUMENT_WORK_KINDS.map((kind, index) => [
        kind,
        (index + 1).toString(16).repeat(64)
      ])
    ) as Record<(typeof DOCUMENT_WORK_KINDS)[number], string>;
    await repository.createFixedGraph({
      knowledgeBaseId: "kb-work",
      documentJobPublicId: "job-work",
      sourceFilePublicId: "source-file-work",
      sourceRevisionPublicId: "source-revision-work",
      inputFingerprints: fingerprints,
      maximumAttempts: 3,
      acceptedAt: at(0)
    });

    const rows = await sql.unsafe<Array<{ work_kind: string }>>(
      "SELECT work_kind FROM focowiki.document_artifact_work "
      + "WHERE document_job_public_id = 'job-work' ORDER BY work_kind"
    );
    expect(rows.map((row) => row.work_kind).sort()).toEqual(
      [...DOCUMENT_WORK_KINDS].sort()
    );
    expect(await repository.claim({
      kind: "first_layer",
      resourceLane: "generation_model",
      workerId: "worker-model",
      limit: 1,
      now: at(1_000),
      leaseDurationMs: 30_000
    })).toEqual([]);

    await sql`
      UPDATE focowiki.document_artifact_work
      SET resource_lane = 'activation'
      WHERE document_job_public_id = 'job-work'
        AND work_kind = 'prepare'
    `;

    const [prepare] = await repository.claim({
      kind: "prepare",
      resourceLane: "postgres_s3",
      workerId: "worker-prepare",
      limit: 1,
      now: at(1_000),
      leaseDurationMs: 30_000
    });
    expect(prepare).toMatchObject({
      kind: "prepare",
      resourceLane: "postgres_s3",
      attemptCount: 1
    });
    const completion = {
      publicId: prepare!.publicId,
      workerId: "worker-prepare",
      now: at(2_000),
      receipt: {
        kind: "parsed_source" as const,
        key: "",
        inputFingerprintSha256: fingerprints.prepare,
        outputFingerprintSha256: "a".repeat(64),
        value: { parsed: true }
      }
    };
    await expect(repository.complete(completion)).resolves.toBe(true);
    await expect(repository.complete(completion)).resolves.toBe(true);
    await expect(sql<Array<{ state: string }>>`
      SELECT state FROM focowiki.document_processing_jobs
      WHERE public_id = 'job-work'
    `).resolves.toEqual([{ state: "processing" }]);

    const [firstLayer, contentProjection] = await Promise.all([
      repository.claim({
        kind: "first_layer",
        resourceLane: "generation_model",
        workerId: "worker-model",
        limit: 1,
        now: at(3_000),
        leaseDurationMs: 30_000
      }),
      repository.claim({
        kind: "content_projection",
        resourceLane: "embedding",
        workerId: "worker-content",
        limit: 1,
        now: at(3_000),
        leaseDurationMs: 30_000
      })
    ]);
    expect(firstLayer[0]).toMatchObject({ kind: "first_layer" });
    expect(contentProjection[0]).toMatchObject({ kind: "content_projection" });
  });

  it("recovers an expired lease from PostgreSQL without Redis state", async () => {
    const repository = createPostgresDocumentArtifactWorkRepository(
      sql as unknown as DatabaseClient
    );
    await expect(repository.recoverExpired({
      now: at(60_000),
      retryAt: at(61_000),
      limit: 10
    })).resolves.toBe(2);
    const rows = await sql.unsafe<Array<{ state: string; lease_owner: string | null }>>(
      "SELECT state, lease_owner FROM focowiki.document_artifact_work "
      + "WHERE work_kind IN ('first_layer', 'content_projection') ORDER BY work_kind"
    );
    expect(rows).toEqual([
      { state: "waiting", lease_owner: null },
      { state: "waiting", lease_owner: null }
    ]);
  });

  it("defers local capacity saturation without consuming an attempt", async () => {
    const repository = createPostgresDocumentArtifactWorkRepository(
      sql as unknown as DatabaseClient
    );
    const before = await sql<Array<{
      attempt_count: number;
      total_attempt_count: number | string;
    }>>`
      SELECT work.attempt_count, job.total_attempt_count
      FROM focowiki.document_artifact_work work
      JOIN focowiki.document_processing_jobs job
        ON job.public_id = work.document_job_public_id
      WHERE work.document_job_public_id = 'job-work'
        AND work.work_kind = 'first_layer'
    `;
    const [claimed] = await repository.claim({
      kind: "first_layer",
      resourceLane: "generation_model",
      workerId: "worker-capacity",
      limit: 1,
      now: at(61_500),
      leaseDurationMs: 30_000
    });
    await expect(repository.defer!({
      publicId: claimed!.publicId,
      workerId: "worker-capacity",
      now: at(61_600),
      nextEligibleAt: at(62_000)
    })).resolves.toBe(true);
    await expect(sql<Array<{
      state: string;
      job_state: string;
      attempt_count: number;
      total_attempt_count: number | string;
      next_eligible_at: Date;
    }>>`
      SELECT work.state, job.state AS job_state, work.attempt_count,
             job.total_attempt_count,
             work.next_eligible_at
      FROM focowiki.document_artifact_work work
      JOIN focowiki.document_processing_jobs job
        ON job.public_id = work.document_job_public_id
      WHERE work.public_id = ${claimed!.publicId}
    `).resolves.toEqual([{
      state: "waiting",
      job_state: "processing",
      attempt_count: before[0]!.attempt_count,
      total_attempt_count: before[0]!.total_attempt_count,
      next_eligible_at: new Date(at(62_000))
    }]);

    const [reclaimed] = await repository.claim({
      kind: "first_layer",
      resourceLane: "generation_model",
      workerId: "worker-capacity-reclaimed",
      limit: 1,
      now: at(62_000),
      leaseDurationMs: 30_000
    });
    const reclaimedTiming = await sql<Array<{ started_at: Date }>>`
      SELECT started_at
      FROM focowiki.document_artifact_work
      WHERE public_id = ${reclaimed!.publicId}
    `;
    expect(reclaimedTiming).toEqual([{ started_at: new Date(at(62_000)) }]);
    await expect(repository.defer!({
      publicId: reclaimed!.publicId,
      workerId: "worker-capacity-reclaimed",
      now: at(62_100),
      nextEligibleAt: at(62_500)
    })).resolves.toBe(true);
  });

  it("persists final private identities, pairs, scopes, and activation owners", async () => {
    const fingerprints = Object.fromEntries(
      DOCUMENT_WORK_KINDS.map((kind, index) => [
        kind,
        (index + 8).toString(16).repeat(64)
      ])
    ) as Record<(typeof DOCUMENT_WORK_KINDS)[number], string>;
    const jobs = createPostgresDocumentJobRepository(
      sql as unknown as DatabaseClient
    );
    const createInput = {
      publicId: "job-work-second",
      knowledgeBaseId: "kb-work",
      operationPublicId: "operation-work-second",
      sourceFilePublicId: "source-file-work-second",
      sourceRevisionPublicId: "source-revision-work-second",
      runtimeSettingsRevisionPublicId: "settings-work",
      generationModelConfigurationPublicId: "model-config-work",
      generationModelConfigurationRevision: 1,
      embeddingConfigurationRevisionPublicId: "embedding-revision-work",
      semanticGenerationPublicId: "semantic-generation-work",
      semanticContractVersion: "semantic-contract-v1",
      maximumAttempts: 3,
      acceptedAt: at(500),
      inputFingerprints: fingerprints
    };
    await expect(jobs.create(createInput)).resolves.toBe("created");
    await expect(jobs.create(createInput)).resolves.toBe("existing");
    const workCount = await sql<Array<{ count: number | string }>>`
      SELECT count(*) AS count FROM focowiki.document_artifact_work
      WHERE document_job_public_id = 'job-work-second'
    `;
    expect(Number(workCount[0]!.count)).toBe(8);

    const chunks = createPostgresDocumentGraphRagChunkRepository(
      sql as unknown as DatabaseClient
    );
    const acquiredChunk = await chunks.acquire({
      knowledgeBaseId: "kb-work",
      documentJobPublicId: "job-work-second",
      sourceRevisionPublicId: "source-revision-work-second",
      chunkNumber: 0,
      inputFingerprintSha256: "f".repeat(64),
      workerId: "chunk-worker",
      now: at(750),
      leaseDurationMs: 30_000
    });
    expect(acquiredChunk.state).toBe("acquired");
    await expect(chunks.complete({
      publicId: acquiredChunk.publicId,
      workerId: "chunk-worker",
      receipt: {
        objectId: "generated-sha256:okf-generated-json-v1:" + "e".repeat(64),
        storageKey: "focowiki/generated/chunk.json",
        checksumSha256: "e".repeat(64),
        byteCount: 42,
        contentType: "application/json; charset=utf-8",
        objectFormat: "okf-generated-json-v1"
      },
      now: at(800)
    })).resolves.toBe(true);
    await expect(chunks.acquire({
      knowledgeBaseId: "kb-work",
      documentJobPublicId: "job-work-second",
      sourceRevisionPublicId: "source-revision-work-second",
      chunkNumber: 0,
      inputFingerprintSha256: "f".repeat(64),
      workerId: "other-chunk-worker",
      now: at(900),
      leaseDurationMs: 30_000
    })).resolves.toMatchObject({
      state: "completed",
      receipt: { checksumSha256: "e".repeat(64) }
    });

    await sql`
      INSERT INTO focowiki.source_revision_presentations (
        knowledge_base_id, source_file_public_id, source_revision_public_id,
        logical_path, normalized_path, title, metadata
      ) VALUES (
        'kb-work', 'source-file-work', 'source-revision-work',
        'guides/work.md', 'guides/work.md', 'Work Guide',
        ${sql.json({ aliases: ["Work"], type: "guide", tags: ["docs"] })}
      )
      ON CONFLICT (knowledge_base_id, source_revision_public_id) DO NOTHING
    `;
    const references = createPostgresDocumentReferenceFactRepository(
      sql as unknown as DatabaseClient
    );
    await references.replaceRevision({
      knowledgeBaseId: "kb-work",
      sourceFilePublicId: "source-file-work",
      sourceRevisionPublicId: "source-revision-work",
      identityKeys: ["path:guides/work.md", "alias:work guide", "alias:work"],
      references: [{
        referenceKind: "markdown_link",
        rawTarget: "guides/second.md",
        normalizedTargetKey: "path:guides/second.md",
        evidenceChecksumSha256: "3".repeat(64),
        evidence: { rawTarget: "guides/second.md" }
      }]
    });
    expect(await references.findTargetsByIdentityKeys({
      knowledgeBaseId: "kb-work",
      identityKeys: ["alias:work"],
      excludeSourceRevisionPublicId: null,
      limit: 10
    })).toMatchObject([{ sourceFilePublicId: "source-file-work" }]);
    expect(await references.hydrateEligible({
      knowledgeBaseId: "kb-work",
      candidates: [{
        sourceFilePublicId: "source-file-work",
        sourceRevisionPublicId: "source-revision-work"
      }],
      limit: 10
    })).toMatchObject([{
      sourceFilePublicId: "source-file-work",
      sourceRevisionPublicId: "source-revision-work"
    }]);
    expect(await references.findTargetsByIdentityKeys({
      knowledgeBaseId: "kb-work",
      identityKeys: ["path:guides/second.md"],
      excludeSourceRevisionPublicId: null,
      limit: 10
    })).toEqual([]);
    expect(await references.findReferencingIdentityKeys({
      knowledgeBaseId: "kb-work",
      identityKeys: ["path:guides/second.md"],
      excludeSourceRevisionPublicId: null,
      limit: 10
    })).toMatchObject([{ sourceFilePublicId: "source-file-work" }]);

    const pairs = createPostgresRelationPairRepository(
      sql as unknown as DatabaseClient
    );
    const pairPublicId = await pairs.enqueue({
      knowledgeBaseId: "kb-work",
      sourceFilePublicId: "source-file-work-second",
      sourceRevisionPublicId: "source-revision-work-second",
      targetSourceFilePublicId: "source-file-work",
      targetSourceRevisionPublicId: "source-revision-work",
      evidenceFingerprintSha256: "4".repeat(64),
      nextEligibleAt: at(1_000)
    });
    await pairs.addEvidence({
      knowledgeBaseId: "kb-work",
      pairPublicId,
      sourceFilePublicId: "source-file-work-second",
      sourceRevisionPublicId: "source-revision-work-second",
      targetSourceFilePublicId: "source-file-work",
      targetSourceRevisionPublicId: "source-revision-work",
      evidenceKind: "explicit_reference",
      evidenceFingerprintSha256: "5".repeat(64),
      evidence: { target: "guides/work.md" }
    });
    await expect(pairs.enqueue({
      knowledgeBaseId: "kb-work",
      sourceFilePublicId: "source-file-work",
      sourceRevisionPublicId: "source-revision-work",
      targetSourceFilePublicId: "source-file-work-second",
      targetSourceRevisionPublicId: "source-revision-work-second",
      evidenceFingerprintSha256: "6".repeat(64),
      nextEligibleAt: at(1_500)
    })).resolves.toBe(pairPublicId);
    await pairs.addEvidence({
      knowledgeBaseId: "kb-work",
      pairPublicId,
      sourceFilePublicId: "source-file-work",
      sourceRevisionPublicId: "source-revision-work",
      targetSourceFilePublicId: "source-file-work-second",
      targetSourceRevisionPublicId: "source-revision-work-second",
      evidenceKind: "first_layer",
      evidenceFingerprintSha256: "7".repeat(64),
      evidence: { target: "guides/second.md" }
    });
    expect(await pairs.claim({
      workerId: "pair-worker",
      now: at(2_000),
      leaseDurationMs: 30_000,
      limit: 10
    })).toEqual([pairPublicId]);
    await expect(pairs.resolve({
      pairPublicId,
      workerId: "pair-worker",
      state: "resolved",
      ambiguityReason: null,
      pendingEndpointSourceFilePublicId: null,
      now: at(3_000)
    })).resolves.toBe(true);
    const relationPublicId = await pairs.stageCanonical({
      pairPublicId,
      relationKind: "references",
      now: at(3_100)
    });
    await expect(pairs.listProjectionClosureForRevision({
      knowledgeBaseId: "kb-work",
      sourceFilePublicId: "source-file-work-second",
      sourceRevisionPublicId: "source-revision-work-second",
      limit: 10
    })).resolves.toEqual([{
      pairPublicId,
      relationPublicId,
      neighborSourceFilePublicId: "source-file-work"
    }]);
    await expect(sql<Array<{ direction: string }>>`
      SELECT direction FROM focowiki.canonical_file_relations
      WHERE public_id = ${relationPublicId}
    `).resolves.toEqual([{ direction: "bidirectional" }]);
    await pairs.stageCanonical({
      pairPublicId,
      relationKind: "related",
      now: at(3_200)
    });
    await expect(sql<Array<{ direction: string; relation_kind: string }>>`
      SELECT direction, relation_kind
      FROM focowiki.canonical_file_relations
      WHERE public_id = ${relationPublicId}
    `).resolves.toEqual([{
      direction: "bidirectional",
      relation_kind: "references"
    }]);

    await sql`
      UPDATE focowiki.source_file_active_revisions
      SET active_source_revision_public_id = current_source_revision_public_id
      WHERE knowledge_base_id = 'kb-work'
        AND source_file_public_id IN ('source-file-work', 'source-file-work-second')
    `;
    await sql`
      UPDATE focowiki.canonical_file_relations
      SET active = true, activated_sequence = 1
      WHERE public_id = ${relationPublicId}
    `;
    await sql`
      UPDATE focowiki.relation_directed_evidence
      SET active = true
      WHERE pair_public_id = ${pairPublicId}
    `;
    await expect(pairs.listActiveNeighborSourceFilePublicIds({
      knowledgeBaseId: "kb-work",
      sourceFilePublicId: "source-file-work",
      limit: 10
    })).resolves.toEqual(["source-file-work-second"]);
    await sql`
      INSERT INTO focowiki.source_revisions (
        public_id, knowledge_base_id, source_file_public_id, object_id,
        checksum_sha256, byte_count, content_type
      ) VALUES (
        'source-revision-work-renamed', 'kb-work', 'source-file-work',
        'object-work', ${"1".repeat(64)}, 10, 'text/markdown; charset=utf-8'
      )
    `;
    await sql`
      UPDATE focowiki.source_file_active_revisions
      SET current_source_revision_public_id = 'source-revision-work-renamed'
      WHERE knowledge_base_id = 'kb-work'
        AND source_file_public_id = 'source-file-work'
    `;
    const reusableEvidence = await pairs.listReusableEvidence({
      knowledgeBaseId: "kb-work",
      sourceFilePublicId: "source-file-work",
      priorSourceRevisionPublicId: "source-revision-work",
      currentSourceRevisionPublicId: "source-revision-work-renamed",
      limit: 10
    });
    expect(reusableEvidence).toEqual([expect.objectContaining({
      sourceFilePublicId: "source-file-work",
      sourceRevisionPublicId: "source-revision-work-renamed",
      targetSourceFilePublicId: "source-file-work-second",
      targetSourceRevisionPublicId: "source-revision-work-second",
      evidenceKind: "first_layer"
    })]);
    const renderable = createPostgresCandidateFileRelationRepository(
      sql as unknown as DatabaseClient
    );
    await expect(renderable.listRenderable({
      knowledgeBaseId: "kb-work",
      currentSourceFilePublicId: "source-file-work",
      currentSourceRevisionPublicId: "source-revision-work-renamed",
      affectedSourceFilePublicIds: ["source-file-work"],
      limit: 10
    })).resolves.toEqual([]);
    const renamedPairPublicId = await pairs.enqueue({
      knowledgeBaseId: "kb-work",
      sourceFilePublicId: "source-file-work",
      sourceRevisionPublicId: "source-revision-work-renamed",
      targetSourceFilePublicId: "source-file-work-second",
      targetSourceRevisionPublicId: "source-revision-work-second",
      evidenceFingerprintSha256: "8".repeat(64),
      nextEligibleAt: at(3_300)
    });
    await pairs.addEvidence({
      knowledgeBaseId: "kb-work",
      pairPublicId: renamedPairPublicId,
      ...reusableEvidence[0]!,
      evidenceFingerprintSha256: "9".repeat(64)
    });
    const renamedRelationPublicId = await pairs.stageCanonical({
      pairPublicId: renamedPairPublicId,
      relationKind: "references",
      now: at(3_400)
    });
    await expect(renderable.listPublicIdsForPairs({
      knowledgeBaseId: "kb-work",
      pairPublicIds: [renamedPairPublicId],
      limit: 10
    })).resolves.toEqual([renamedRelationPublicId]);
    await sql`
      UPDATE focowiki.source_file_active_revisions
      SET active_source_revision_public_id = 'source-revision-work-renamed'
      WHERE knowledge_base_id = 'kb-work'
        AND source_file_public_id = 'source-file-work'
    `;
    await sql`
      INSERT INTO focowiki.document_projection_records (
        knowledge_base_id, source_file_public_id,
        source_revision_public_id, logical_path, normalized_path,
        title, summary, content_type, checksum_sha256, byte_count,
        tokenizer_contract_version, navigation_term_fingerprint_sha256,
        active
      ) VALUES
        (
          'kb-work', 'source-file-work', 'source-revision-work',
          'work-old.md', 'work-old.md', 'Work old', 'Work old',
          'text/markdown; charset=utf-8', ${"1".repeat(64)}, 10,
          'tokenizer-test', ${"2".repeat(64)}, false
        ),
        (
          'kb-work', 'source-file-work', 'source-revision-work-renamed',
          'work.md', 'work.md', 'Work', 'Work',
          'text/markdown; charset=utf-8', ${"1".repeat(64)}, 10,
          'tokenizer-test', ${"2".repeat(64)}, true
        ),
        (
          'kb-work', 'source-file-work-second', 'source-revision-work-second',
          'second.md', 'second.md', 'Second', 'Second',
          'text/markdown; charset=utf-8', ${"1".repeat(64)}, 10,
          'tokenizer-test', ${"2".repeat(64)}, true
        )
    `;
    await sql`
      INSERT INTO focowiki.document_graph_degrees (
        knowledge_base_id, source_revision_public_id,
        incoming_count, outgoing_count
      ) VALUES
        ('kb-work', 'source-revision-work', 9, 9),
        ('kb-work', 'source-revision-work-renamed', 9, 9),
        ('kb-work', 'source-revision-work-second', 9, 9)
    `;
    await applyPostgresDocumentRelationActivation({
      transaction: sql as unknown as DatabaseClient,
      knowledgeBaseId: "kb-work",
      sourceFilePublicId: "source-file-work",
      sourceRevisionPublicId: "source-revision-work-renamed",
      readinessSequence: 2,
      relationPublicIds: [],
      activatedAt: at(3_500)
    });
    await expect(sql<Array<{
      public_id: string;
      active: boolean;
      retired_at: Date | null;
    }>>`
      SELECT public_id, active, retired_at
      FROM focowiki.canonical_file_relations
      WHERE public_id IN (${relationPublicId}, ${renamedRelationPublicId})
      ORDER BY public_id
    `).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({
        public_id: relationPublicId,
        active: false,
        retired_at: expect.any(Date)
      }),
      expect.objectContaining({
        public_id: renamedRelationPublicId,
        active: true,
        retired_at: null
      })
    ]));
    await expect(sql<Array<{
      pair_public_id: string;
      active: boolean;
      retired_at: Date | null;
    }>>`
      SELECT pair_public_id, active, retired_at
      FROM focowiki.relation_directed_evidence
      WHERE pair_public_id IN (${pairPublicId}, ${renamedPairPublicId})
      ORDER BY pair_public_id, public_id
    `).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({
        pair_public_id: pairPublicId,
        active: false,
        retired_at: expect.any(Date)
      }),
      expect.objectContaining({
        pair_public_id: renamedPairPublicId,
        active: true,
        retired_at: null
      })
    ]));
    await expect(sql<Array<{
      source_revision_public_id: string;
      incoming_count: number;
      outgoing_count: number;
    }>>`
      SELECT source_revision_public_id, incoming_count, outgoing_count
      FROM focowiki.document_graph_degrees
      WHERE knowledge_base_id = 'kb-work'
        AND source_revision_public_id IN (
          'source-revision-work', 'source-revision-work-renamed',
          'source-revision-work-second'
        )
      ORDER BY source_revision_public_id
    `).resolves.toEqual([
      {
        source_revision_public_id: "source-revision-work",
        incoming_count: 0,
        outgoing_count: 0
      },
      {
        source_revision_public_id: "source-revision-work-renamed",
        incoming_count: 0,
        outgoing_count: 1
      },
      {
        source_revision_public_id: "source-revision-work-second",
        incoming_count: 1,
        outgoing_count: 0
      }
    ]);

    const dirty = createPostgresProjectionDirtyScopeRepository(
      sql as unknown as DatabaseClient
    );
    await dirty.mark({
      knowledgeBaseId: "kb-work",
      kind: "source",
      key: "source-file-work",
      requiredSequence: 1,
      nextEligibleAt: at(1_000)
    });
    const [claimedScope] = await dirty.claim({
      workerId: "render-worker",
      now: at(2_000),
      leaseDurationMs: 30_000,
      limit: 10
    });
    await dirty.mark({
      knowledgeBaseId: "kb-work",
      kind: "source",
      key: "source-file-work",
      requiredSequence: 2,
      nextEligibleAt: at(2_500)
    });
    await expect(dirty.complete({
      publicId: claimedScope!.publicId,
      workerId: "render-worker",
      renderedSequence: 1,
      now: at(3_000)
    })).resolves.toBe("waiting");
    const scopeRows = await sql<Array<{
      state: string;
      required_sequence: number | string;
      completed_sequence: number | string;
    }>>`
      SELECT state, required_sequence, completed_sequence
      FROM focowiki.projection_dirty_scopes
      WHERE public_id = ${claimedScope!.publicId}
    `;
    expect(scopeRows[0]?.state).toBe("waiting");
    expect(Number(scopeRows[0]?.required_sequence)).toBe(2);
    expect(Number(scopeRows[0]?.completed_sequence)).toBe(1);

    await expect(dirty.cover({
      knowledgeBaseId: "kb-work",
      scopes: [{ kind: "source", key: "source-file-work" }],
      renderedSequence: 2,
      now: at(3_100)
    })).resolves.toBe(1);
    await expect(dirty.cover({
      knowledgeBaseId: "kb-work",
      scopes: [{ kind: "source", key: "source-file-work" }],
      renderedSequence: 1,
      now: at(3_200)
    })).resolves.toBe(1);
    const coveredRows = await sql<Array<{
      state: string;
      required_sequence: number | string;
      completed_sequence: number | string;
    }>>`
      SELECT state, required_sequence, completed_sequence
      FROM focowiki.projection_dirty_scopes
      WHERE public_id = ${claimedScope!.publicId}
    `;
    expect(coveredRows[0]?.state).toBe("completed");
    expect(Number(coveredRows[0]?.required_sequence)).toBe(2);
    expect(Number(coveredRows[0]?.completed_sequence)).toBe(2);
    await sql`
      INSERT INTO focowiki.projection_scope_outputs (
        scope_public_id, rendered_sequence, knowledge_base_id,
        output_fingerprint_sha256
      ) VALUES (
        ${claimedScope!.publicId}, 2, 'kb-work', ${"e".repeat(64)}
      )
    `;

    const contributions = createPostgresProjectionScopeContributions(
      sql as unknown as DatabaseClient
    );
    await expect(contributions.contribute({
      knowledgeBaseId: "kb-work",
      sourceFilePublicId: "source-file-work-second",
      sourceRevisionPublicId: "source-revision-work-second",
      documentJobPublicId: "job-work-second",
      scopes: [{ publicId: claimedScope!.publicId, requiredSequence: 2 }]
    })).resolves.toHaveLength(1);
    await expect(contributions.allAcknowledged({
      documentJobPublicId: "job-work-second"
    })).resolves.toBe(true);
    await expect(contributions.acknowledge({
      scopePublicId: claimedScope!.publicId,
      renderedSequence: 2,
      outputFingerprintSha256: "e".repeat(64),
      now: at(3_300)
    })).resolves.toEqual({
      acknowledgedCount: 0,
      documentJobPublicIds: []
    });
    await expect(contributions.allAcknowledged({
      documentJobPublicId: "job-work-second"
    })).resolves.toBe(true);

    const latePageScope = await dirty.mark({
      knowledgeBaseId: "kb-work",
      kind: "directory",
      key: "pages/late-page",
      requiredSequence: 4,
      nextEligibleAt: at(3_225),
      coalesceMilliseconds: 50
    });
    await expect(dirty.cover({
      knowledgeBaseId: "kb-work",
      scopes: [{ kind: "directory", key: "pages/late-page" }],
      renderedSequence: 4,
      now: at(3_226)
    })).resolves.toBe(1);
    await sql`
      INSERT INTO focowiki.projection_scope_outputs (
        scope_public_id, rendered_sequence, knowledge_base_id,
        output_fingerprint_sha256, pages
      ) VALUES (
        ${latePageScope}, 4, 'kb-work', ${"9".repeat(64)},
        ${sql.json([{
          logicalPath: "pages/late-page/index.md",
          normalizedPath: "pages/late-page/index.md",
          entryKind: "index",
          sourceFilePublicId: null,
          sourceRevisionPublicId: null,
          objectId: "generated-late-page",
          checksumSha256: "8".repeat(64),
          byteCount: 64
        }] as never)}
      )
    `;
    const [lateContribution] = await contributions.contribute({
      knowledgeBaseId: "kb-work",
      sourceFilePublicId: "source-file-work-second",
      sourceRevisionPublicId: "source-revision-work-second",
      documentJobPublicId: "job-work-second",
      scopes: [{ publicId: latePageScope, requiredSequence: 4 }]
    });
    await expect(sql<Array<{ state: string }>>`
      SELECT state
      FROM focowiki.projection_scope_contributions
      WHERE public_id = ${lateContribution!}
    `).resolves.toEqual([{ state: "waiting" }]);
    await expect(sql<Array<{ state: string }>>`
      SELECT state
      FROM focowiki.projection_dirty_scopes
      WHERE public_id = ${latePageScope}
    `).resolves.toEqual([{ state: "waiting" }]);
    await sql`
      DELETE FROM focowiki.projection_scope_contributions
      WHERE public_id = ${lateContribution!}
    `;
    await sql`
      DELETE FROM focowiki.projection_scope_outputs
      WHERE scope_public_id = ${latePageScope}
    `;
    await sql`
      DELETE FROM focowiki.projection_dirty_scopes
      WHERE public_id = ${latePageScope}
    `;
    await sql`
      UPDATE focowiki.source_file_active_revisions
      SET active_source_revision_public_id = 'source-revision-work-second'
      WHERE knowledge_base_id = 'kb-work'
        AND source_file_public_id = 'source-file-work-second'
    `;
    await sql`
      UPDATE focowiki.document_processing_jobs
      SET state = 'available', started_at = ${at(3_350)},
          terminal_at = ${at(3_360)}
      WHERE public_id = 'job-work-second'
    `;
    await expect(dirty.compactTerminalHistory({
      before: at(3_400),
      limit: 10
    })).resolves.toEqual({ contributions: 0, storageMetrics: 0 });
    await sql`
      UPDATE focowiki.source_file_active_revisions
      SET active_source_revision_public_id = NULL
      WHERE knowledge_base_id = 'kb-work'
        AND source_file_public_id = 'source-file-work-second'
    `;
    await expect(dirty.compactTerminalHistory({
      before: at(3_400),
      limit: 10
    })).resolves.toEqual({ contributions: 1, storageMetrics: 0 });
    await expect(sql<Array<{ count: number | string }>>`
      SELECT count(*) AS count
      FROM focowiki.projection_scope_receipts receipt
      JOIN focowiki.projection_scope_contributions contribution
        ON contribution.public_id = receipt.contribution_public_id
      WHERE contribution.document_job_public_id = 'job-work-second'
    `).resolves.toEqual([{ count: "0" }]);

    const coalescedScope = await dirty.mark({
      knowledgeBaseId: "kb-work",
      kind: "directory",
      key: "pages/coalesced",
      requiredSequence: 3,
      nextEligibleAt: at(4_000),
      coalesceMilliseconds: 50
    });
    await expect(dirty.claim({
      workerId: "coalesce-worker",
      now: at(4_049),
      leaseDurationMs: 1_000,
      limit: 10
    })).resolves.toEqual([]);
    const coalescedClaims = await dirty.claim({
      workerId: "coalesce-worker",
      now: at(4_050),
      leaseDurationMs: 1_000,
      limit: 10
    });
    expect(coalescedClaims).toEqual([expect.objectContaining({
      publicId: coalescedScope,
      renderedSequence: 3
    })]);
    await expect(dirty.recoverExpired({
      now: at(5_051),
      retryAt: at(5_100),
      limit: 10
    })).resolves.toBe(1);

    const lateSequenceScope = await dirty.mark({
      knowledgeBaseId: "kb-work",
      kind: "root",
      key: "late-sequence",
      requiredSequence: 30,
      nextEligibleAt: at(5_200),
      coalesceMilliseconds: 50
    });
    await expect(dirty.cover({
      knowledgeBaseId: "kb-work",
      scopes: [{ kind: "root", key: "late-sequence" }],
      renderedSequence: 30,
      now: at(5_201)
    })).resolves.toBe(1);
    await expect(dirty.markWithSequence({
      knowledgeBaseId: "kb-work",
      kind: "root",
      key: "late-sequence",
      requiredSequence: 29,
      nextEligibleAt: at(5_210),
      coalesceMilliseconds: 50
    })).resolves.toEqual({
      publicId: lateSequenceScope,
      requiredSequence: 31
    });

    const sequencedScope = await dirty.mark({
      knowledgeBaseId: "kb-work",
      kind: "directory",
      key: "pages/sequenced",
      requiredSequence: 20,
      nextEligibleAt: at(6_000),
      coalesceMilliseconds: 50
    });
    await contributions.contribute({
      knowledgeBaseId: "kb-work",
      sourceFilePublicId: "source-file-work",
      sourceRevisionPublicId: "source-revision-work",
      documentJobPublicId: "job-work",
      scopes: [{ publicId: sequencedScope, requiredSequence: 20 }]
    });
    await expect(sql<Array<{ state: string }>>`
      SELECT state FROM focowiki.projection_scope_contributions
      WHERE scope_public_id = ${sequencedScope} AND required_sequence = 20
    `).resolves.toEqual([{ state: "waiting" }]);
    await dirty.mark({
      knowledgeBaseId: "kb-work",
      kind: "directory",
      key: "pages/sequenced",
      requiredSequence: 21,
      nextEligibleAt: at(6_010),
      coalesceMilliseconds: 50
    });
    await contributions.contribute({
      knowledgeBaseId: "kb-work",
      sourceFilePublicId: "source-file-work-second",
      sourceRevisionPublicId: "source-revision-work-second",
      documentJobPublicId: "job-work-second",
      scopes: [{ publicId: sequencedScope, requiredSequence: 21 }]
    });
    const firstSequence = (await dirty.claim({
      workerId: "sequence-worker",
      now: at(6_060),
      leaseDurationMs: 1_000,
      limit: 10
    })).find((scope) => scope.publicId === sequencedScope);
    expect(firstSequence).toMatchObject({
      publicId: sequencedScope,
      requiredSequence: 21,
      renderedSequence: 21
    });
    const scopeOutputs = createPostgresProjectionScopeOutputRepository(
      sql as unknown as DatabaseClient
    );
    const firstOutput = {
      scopePublicId: sequencedScope,
      renderedSequence: 21,
      knowledgeBaseId: "kb-work",
      outputFingerprintSha256: "f".repeat(64),
      pages: [{
        logicalPath: "_index/pages/sequenced/index.json",
        normalizedPath: "_index/pages/sequenced/index.json",
        entryKind: "page_directory",
        sourceFilePublicId: null,
        sourceRevisionPublicId: null,
        objectId: "scope-output-object-21",
        checksumSha256: "a".repeat(64),
        byteCount: 128
      }],
      removedNormalizedPaths: [],
      navigationMutations: [],
      activationOwnerVersions: [{
        kind: "page_head",
        key: "_index/pages/sequenced/index.json",
        expectedVersion: 2
      }],
      createdAt: at(6_065)
    } as const;
    await sql`
      INSERT INTO focowiki.object_registrations (
        object_id, storage_key, checksum_sha256, byte_count, content_type,
        object_format, state, write_attempt_public_id, verified_at
      ) VALUES (
        'scope-output-object-21', 'focowiki/test/scope-output-21.json',
        ${"a".repeat(64)}, 128, 'application/json; charset=utf-8',
        'okf-generated-json-v1', 'verified', 'scope-output-write-21', now()
      )
    `;
    await expect(scopeOutputs.persist(firstOutput)).resolves.toBeUndefined();
    await expect(scopeOutputs.persist(firstOutput)).resolves.toBeUndefined();
    await expect(scopeOutputs.read({
      scopePublicId: sequencedScope,
      renderedSequence: 21
    })).resolves.toEqual(firstOutput);
    const refreshedOwnerOutput = {
      ...firstOutput,
      activationOwnerVersions: [{
        kind: "page_head" as const,
        key: "_index/pages/sequenced/index.json",
        expectedVersion: 3
      }]
    };
    await expect(scopeOutputs.persist(refreshedOwnerOutput))
      .resolves.toBeUndefined();
    await expect(scopeOutputs.read({
      scopePublicId: sequencedScope,
      renderedSequence: 21
    })).resolves.toEqual(refreshedOwnerOutput);
    await expect(scopeOutputs.persist({
      ...firstOutput,
      outputFingerprintSha256: "1".repeat(64)
    })).rejects.toMatchObject({
      message: expect.stringContaining("projection_scope_output_conflict")
    });
    await expect(sql<Array<{ state: string }>>`
      SELECT state FROM focowiki.projection_scope_contributions
      WHERE scope_public_id = ${sequencedScope} AND required_sequence = 20
    `).resolves.toEqual([{ state: "waiting" }]);
    const coveredContributors = await contributions.listCovered({
      scopePublicId: sequencedScope,
      renderedSequence: 21,
      limit: 256
    });
    expect(coveredContributors).toEqual([
      expect.objectContaining({
        sourceFilePublicId: "source-file-work",
        sourceRevisionPublicId: "source-revision-work",
        documentJobPublicId: "job-work",
        requiredSequence: 20,
        sourceWorkPublicId: expect.any(String)
      }),
      expect.objectContaining({
        sourceFilePublicId: "source-file-work-second",
        sourceRevisionPublicId: "source-revision-work-second",
        documentJobPublicId: "job-work-second",
        requiredSequence: 21,
        sourceWorkPublicId: expect.any(String)
      })
    ]);
    const generatedPages = createPostgresGeneratedPageRepository(
      sql as unknown as DatabaseClient
    );
    await expect(generatedPages.stageForContributors({
      knowledgeBaseId: "kb-work",
      contributors: coveredContributors,
      pages: firstOutput.pages,
      stagedAt: at(6_066)
    })).resolves.toBe(2);
    await expect(generatedPages.stageForContributors({
      knowledgeBaseId: "kb-work",
      contributors: coveredContributors,
      pages: firstOutput.pages,
      stagedAt: at(6_067)
    })).resolves.toBe(2);
    await expect(generatedPages.readCandidatesForPaths({
      knowledgeBaseId: "kb-work",
      sourceRevisionPublicId: "source-revision-work",
      baseActivationRevision: 20,
      normalizedPaths: ["_index/pages/sequenced/index.json"],
      limit: 10
    })).resolves.toEqual([expect.objectContaining({
      normalizedPath: "_index/pages/sequenced/index.json",
      objectId: "scope-output-object-21",
      pageCandidatePublicId: expect.stringMatching(/^generated-page-candidate-/u)
    })]);
    const sequenceCompletion = createPostgresProjectionScopeCompletion(
      sql as unknown as DatabaseClient
    );
    await sql`
      UPDATE focowiki.projection_dirty_scopes
      SET safe_error_code = 'transient_projection_error', retryable = true
      WHERE public_id = ${sequencedScope}
    `;
    await expect(sequenceCompletion.commit({
      publicId: sequencedScope,
      workerId: "sequence-worker",
      renderedSequence: 21,
      outputFingerprintSha256: "f".repeat(64),
      storageRequests: {
        put: 1, head: 0, verification: 0,
        attemptedBytes: 128, retries: 0, latencyMilliseconds: 1
      },
      now: at(6_070)
    })).resolves.toEqual({
      state: "completed",
      readyDocumentJobPublicIds: ["job-work", "job-work-second"]
    });
    await expect(sql<Array<{
      state: string;
      safe_error_code: string | null;
      retryable: boolean;
    }>>`
      SELECT state, safe_error_code, retryable
      FROM focowiki.projection_dirty_scopes
      WHERE public_id = ${sequencedScope}
    `).resolves.toEqual([{
      state: "completed",
      safe_error_code: null,
      retryable: false
    }]);
    await expect(scopeOutputs.readForDocument({
      knowledgeBaseId: "kb-work",
      documentJobPublicId: "job-work",
      limit: 256
    })).resolves.toEqual([refreshedOwnerOutput]);
    await sql`
      UPDATE focowiki.document_artifact_work
      SET state = 'completed', lease_owner = NULL, lease_expires_at = NULL,
          ended_at = ${at(6_070)}, updated_at = ${at(6_070)}
      WHERE document_job_public_id = 'job-work'
        AND work_kind = 'knowledge_projection'
    `;
    const blockedSecondSequence = (await dirty.claim({
      workerId: "sequence-worker",
      now: at(6_071),
      leaseDurationMs: 1_000,
      limit: 10
    })).find((scope) => scope.publicId === sequencedScope);
    expect(blockedSecondSequence).toBeUndefined();
    await sql`
      UPDATE focowiki.document_processing_jobs
      SET state = 'available', started_at = ${at(6_000)},
          terminal_at = ${at(6_072)}, updated_at = ${at(6_072)}
      WHERE public_id = 'job-work'
    `;
    const secondSequence = (await dirty.claim({
      workerId: "sequence-worker",
      now: at(6_073),
      leaseDurationMs: 1_000,
      limit: 10
    })).find((scope) => scope.publicId === sequencedScope);
    expect(secondSequence).toBeUndefined();

    const activation = createPostgresScopedActivationOwnerRepository(
      sql as unknown as DatabaseClient
    );
    await expect(activation.activate({
      knowledgeBaseId: "kb-work",
      owners: [{
        kind: "source",
        key: "source-file-work",
        expectedVersion: 0,
        activeSourceRevisionPublicId: "source-revision-work",
        activePageCandidatePublicId: null
      }],
      readinessSequence: 1,
      now: at(4_000)
    })).resolves.toMatchObject({ status: "activated", sequence: 1 });
    await expect(activation.activate({
      knowledgeBaseId: "kb-work",
      owners: [{
        kind: "source",
        key: "source-file-work",
        expectedVersion: 0,
        activeSourceRevisionPublicId: "source-revision-work",
        activePageCandidatePublicId: null
      }],
      readinessSequence: 1,
      now: at(5_000)
    })).resolves.toEqual({
      status: "conflict",
      owner: { kind: "source", key: "source-file-work" },
      actualVersion: 1
    });
  });

  it("releases document work while independent scope receipts are pending", async () => {
    const repository = createPostgresDocumentArtifactWorkRepository(
      sql as unknown as DatabaseClient
    );
    const fingerprints = Object.fromEntries(
      DOCUMENT_WORK_KINDS.map((kind, index) => [
        kind,
        (index + 1).toString(16).repeat(64)
      ])
    ) as Record<(typeof DOCUMENT_WORK_KINDS)[number], string>;
    await sql`
      INSERT INTO focowiki.object_registrations (
        object_id, storage_key, checksum_sha256, byte_count, content_type,
        object_format, state, write_attempt_public_id, verified_at
      ) VALUES (
        'object-work-projection', 'focowiki/test/projection.md',
        ${"c".repeat(64)}, 20, 'text/markdown; charset=utf-8',
        'source_markdown', 'verified', 'write-work-projection', now()
      )
    `;
    await sql`
      INSERT INTO focowiki.source_files (
        public_id, knowledge_base_id, logical_path, normalized_path,
        title, metadata, revision
      ) VALUES (
        'source-file-work-projection', 'kb-work', 'projection.md',
        'projection.md', 'Projection', '{}'::jsonb, 1
      )
    `;
    await sql`
      INSERT INTO focowiki.source_revisions (
        public_id, knowledge_base_id, source_file_public_id, object_id,
        checksum_sha256, byte_count, content_type
      ) VALUES (
        'source-revision-work-projection', 'kb-work',
        'source-file-work-projection', 'object-work-projection',
        ${"c".repeat(64)}, 20, 'text/markdown; charset=utf-8'
      )
    `;
    await sql`
      INSERT INTO focowiki.operations (
        public_id, knowledge_base_id, operation_kind, state,
        target_kind, target_public_id
      ) VALUES (
        'operation-work-projection', 'kb-work', 'source_processing',
        'accepted', 'source_file', 'source-file-work-projection'
      )
    `;
    await sql`
      INSERT INTO focowiki.operation_idempotency (
        public_id, knowledge_base_id, idempotency_key, request_hash,
        operation_public_id, expires_at, created_at
      ) VALUES (
        'idempotency-work-projection', 'kb-work',
        'request-work-projection', ${"7".repeat(64)},
        'operation-work-projection', ${at(86_400_000)}, ${at(7_900)}
      )
    `;
    await sql`
      INSERT INTO focowiki.document_processing_jobs (
        public_id, knowledge_base_id, operation_public_id,
        source_file_public_id, source_revision_public_id,
        runtime_settings_revision_public_id,
        generation_model_configuration_public_id,
        generation_model_configuration_revision,
        embedding_configuration_revision_public_id,
        semantic_generation_public_id, semantic_contract_version,
        state, maximum_attempts, accepted_at
      ) VALUES (
        'job-work-projection', 'kb-work', 'operation-work-projection',
        'source-file-work-projection', 'source-revision-work-projection',
        'settings-work', 'model-config-work', 1,
        'embedding-revision-work', 'semantic-generation-work',
        'semantic-contract-v1', 'processing', 3, ${at(8_000)}
      )
    `;
    await sql`
      INSERT INTO focowiki.source_file_active_revisions (
        knowledge_base_id, source_file_public_id,
        current_source_revision_public_id,
        active_source_revision_public_id, activation_sequence
      ) VALUES (
        'kb-work', 'source-file-work-projection',
        'source-revision-work-projection', NULL, 0
      )
    `;
    await repository.createFixedGraph({
      knowledgeBaseId: "kb-work",
      documentJobPublicId: "job-work-projection",
      sourceFilePublicId: "source-file-work-projection",
      sourceRevisionPublicId: "source-revision-work-projection",
      inputFingerprints: fingerprints,
      maximumAttempts: 3,
      acceptedAt: at(8_000)
    });
    const knowledgeWork = await sql<Array<{ public_id: string }>>`
      UPDATE focowiki.document_artifact_work
      SET state = 'running', attempt_count = 1,
          lease_owner = 'projection-preparer',
          lease_expires_at = ${at(40_000)}, started_at = ${at(8_000)}
      WHERE document_job_public_id = 'job-work-projection'
        AND work_kind = 'knowledge_projection'
      RETURNING public_id
    `;
    const receipt = {
      kind: "generated_page" as const,
      key: "closure",
      inputFingerprintSha256: fingerprints.knowledge_projection,
      outputFingerprintSha256: "d".repeat(64),
      value: { projected: true }
    };
    await expect(repository.waitForProjectionWithMutation({
      publicId: knowledgeWork[0]!.public_id,
      workerId: "projection-preparer",
      now: at(9_000),
      receipt,
      async apply(transaction) {
        const dirty = createPostgresProjectionDirtyScopeRepository(transaction);
        const scopePublicId = await dirty.mark({
          knowledgeBaseId: "kb-work",
          kind: "source",
          key: "source-file-work-projection",
          requiredSequence: 9,
          nextEligibleAt: at(9_000),
          coalesceMilliseconds: 50
        });
        const contributions = createPostgresProjectionScopeContributions(transaction);
        await contributions.contribute({
          knowledgeBaseId: "kb-work",
          sourceFilePublicId: "source-file-work-projection",
          sourceRevisionPublicId: "source-revision-work-projection",
          documentJobPublicId: "job-work-projection",
          scopes: [{ publicId: scopePublicId, requiredSequence: 9 }]
        });
      }
    })).resolves.toBe(true);
    await expect(sql<Array<{
      state: string;
      lease_owner: string | null;
      lease_expires_at: Date | null;
    }>>`
      SELECT state, lease_owner, lease_expires_at
      FROM focowiki.document_artifact_work
      WHERE public_id = ${knowledgeWork[0]!.public_id}
    `).resolves.toEqual([{
      state: "waiting_on_projection",
      lease_owner: null,
      lease_expires_at: null
    }]);
    await expect(sql<Array<{ state: string }>>`
      SELECT state FROM focowiki.document_processing_jobs
      WHERE public_id = 'job-work-projection'
    `).resolves.toEqual([{ state: "processing" }]);
    await expect(repository.completeWaitingProjection({
      publicId: knowledgeWork[0]!.public_id,
      now: at(9_025)
    })).resolves.toBe(false);
    const dirty = createPostgresProjectionDirtyScopeRepository(
      sql as unknown as DatabaseClient
    );
    const claimedScopes = await dirty.claim({
      workerId: "scope-projector",
      now: at(9_050),
      leaseDurationMs: 1_000,
      limit: 10
    });
    let scope = claimedScopes.find((item) =>
      item.key === "source-file-work-projection");
    expect(scope).toMatchObject({ renderedSequence: 9 });
    await expect(dirty.fail({
      publicId: scope!.publicId,
      workerId: "scope-projector",
      now: at(9_060),
      errorCode: "portable_record_invalid",
      retryable: true,
      nextEligibleAt: null
    })).resolves.toBe("error");
    await expect(repository.completeReadyWaitingProjections({
      now: at(9_061),
      limit: 10,
      detectFailures: true
    })).resolves.toBe(0);
    await expect(sql<Array<{
      work_state: string;
      job_state: string;
      retryable: boolean;
      safe_error_code: string | null;
    }>>`
      SELECT work.state AS work_state, job.state AS job_state,
             job.retryable, job.safe_error_code
      FROM focowiki.document_artifact_work work
      JOIN focowiki.document_processing_jobs job
        ON job.public_id = work.document_job_public_id
      WHERE work.public_id = ${knowledgeWork[0]!.public_id}
    `).resolves.toEqual([{
      work_state: "error",
      job_state: "error",
      retryable: true,
      safe_error_code: "portable_record_invalid"
    }]);
    await sql`
      UPDATE focowiki.document_processing_jobs
      SET state = 'processing', retryable = false,
          safe_error_code = NULL, safe_error_message = NULL,
          terminal_at = NULL
      WHERE public_id = 'job-work-projection'
    `;
    await sql`
      UPDATE focowiki.document_artifact_work
      SET state = 'waiting_on_projection', retryable = false,
          safe_error_code = NULL, safe_error_message = NULL,
          ended_at = NULL
      WHERE public_id = ${knowledgeWork[0]!.public_id}
    `;
    await sql`
      UPDATE focowiki.projection_dirty_scopes
      SET state = 'waiting', attempt_count = 0,
          next_eligible_at = ${at(9_062)}, coalesce_until = ${at(9_062)},
          safe_error_code = NULL, safe_error_message = NULL,
          retryable = false
      WHERE public_id = ${scope!.publicId}
    `;
    const reclaimedScopes = await dirty.claim({
      workerId: "scope-projector",
      now: at(9_063),
      leaseDurationMs: 1_000,
      limit: 10
    });
    scope = reclaimedScopes.find((item) =>
      item.key === "source-file-work-projection");
    expect(scope).toMatchObject({ renderedSequence: 9 });
    const completion = createPostgresProjectionScopeCompletion(
      sql as unknown as DatabaseClient
    );
    await createPostgresProjectionScopeOutputRepository(
      sql as unknown as DatabaseClient
    ).persist({
      scopePublicId: scope!.publicId,
      renderedSequence: 9,
      knowledgeBaseId: "kb-work",
      outputFingerprintSha256: "d".repeat(64),
      pages: [{
        logicalPath: "pages/projection/index.md",
        normalizedPath: "pages/projection/index.md",
        entryKind: "index",
        sourceFilePublicId: null,
        sourceRevisionPublicId: null,
        objectId: "projection-scope-object",
        checksumSha256: "f".repeat(64),
        byteCount: 128
      }],
      removedNormalizedPaths: [],
      navigationMutations: [],
      activationOwnerVersions: [],
      createdAt: at(9_075)
    });
    await expect(completion.commit({
      publicId: scope!.publicId,
      workerId: "scope-projector",
      renderedSequence: 9,
      outputFingerprintSha256: "d".repeat(64),
      storageRequests: {
        put: 2,
        head: 1,
        verification: 1,
        attemptedBytes: 2048,
        retries: 1,
        latencyMilliseconds: 42
      },
      now: at(9_100)
    })).resolves.toEqual({
      state: "completed",
      readyDocumentJobPublicIds: ["job-work-projection"]
    });
    await expect(sql<Array<{
      put_count: number;
      head_count: number;
      verification_count: number;
      attempted_bytes: number | string;
      retry_count: number;
      latency_milliseconds: number | string;
    }>>`
      SELECT put_count, head_count, verification_count, attempted_bytes,
             retry_count, latency_milliseconds
      FROM focowiki.projection_scope_storage_metrics
      WHERE scope_public_id = ${scope!.publicId}
        AND rendered_sequence = 9
    `).resolves.toEqual([{
      put_count: 2,
      head_count: 1,
      verification_count: 1,
      attempted_bytes: "2048",
      retry_count: 1,
      latency_milliseconds: "42"
    }]);
    const contributions = createPostgresProjectionScopeContributions(
      sql as unknown as DatabaseClient
    );
    await expect(contributions.allAcknowledged({
      documentJobPublicId: "job-work-projection"
    })).resolves.toBe(true);
    await expect(sql<Array<{ state: string }>>`
      SELECT state
      FROM focowiki.document_artifact_work
      WHERE document_job_public_id = 'job-work-projection'
        AND work_kind = 'knowledge_projection'
    `).resolves.toEqual([{
      state: "waiting_on_projection"
    }]);
    await dirty.mark({
      knowledgeBaseId: "kb-work",
      kind: "source",
      key: "source-file-work-projection",
      requiredSequence: 10,
      nextEligibleAt: at(9_110),
      coalesceMilliseconds: 50
    });
    const claimWhileContributorAwaitsOtherScopes = await dirty.claim({
      workerId: "scope-projector-before-activation",
      now: at(9_200),
      leaseDurationMs: 1_000,
      limit: 10
    });
    expect(claimWhileContributorAwaitsOtherScopes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          publicId: scope!.publicId,
          renderedSequence: 10
        })
      ])
    );
    await expect(dirty.complete({
      publicId: scope!.publicId,
      workerId: "scope-projector-before-activation",
      renderedSequence: 10,
      now: at(9_210)
    })).resolves.toBe("completed");
    await expect(repository.completeReadyWaitingProjections({
      now: at(9_220),
      limit: 10,
      documentJobPublicIds: ["job-work-projection"]
    })).resolves.toBe(1);
    const activationClaim = await repository.claim({
      kind: "activate",
      resourceLane: "activation",
      workerId: "activation-after-projection",
      limit: 1,
      now: at(9_300),
      leaseDurationMs: 1_000
    });
    expect(activationClaim).toEqual([
      expect.objectContaining({
        documentJobPublicId: "job-work-projection",
        kind: "activate"
      })
    ]);
    await dirty.mark({
      knowledgeBaseId: "kb-work",
      kind: "source",
      key: "source-file-work-projection",
      requiredSequence: 11,
      nextEligibleAt: at(9_350),
      coalesceMilliseconds: 50
    });
    await expect(dirty.claim({
      workerId: "scope-projector-ahead",
      now: at(9_500),
      leaseDurationMs: 1_000,
      limit: 10
    })).resolves.not.toEqual(expect.arrayContaining([
      expect.objectContaining({
        publicId: scope!.publicId,
        renderedSequence: 11
      })
    ]));
    await sql`
      UPDATE focowiki.document_processing_jobs
      SET state = 'available', started_at = ${at(9_250)},
          terminal_at = ${at(9_550)}, updated_at = ${at(9_550)}
      WHERE public_id = 'job-work-projection'
    `;
    await expect(repository.defer!({
      publicId: activationClaim[0]!.publicId,
      workerId: "activation-after-projection",
      now: at(9_551),
      nextEligibleAt: at(9_552)
    })).resolves.toBe(true);
    await expect(sql<Array<{ state: string }>>`
      SELECT state FROM focowiki.document_processing_jobs
      WHERE public_id = 'job-work-projection'
    `).resolves.toEqual([{ state: "available" }]);
    await expect(dirty.claim({
      workerId: "scope-projector-after-activation",
      now: at(9_600),
      leaseDurationMs: 1_000,
      limit: 10
    })).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({
        publicId: scope!.publicId,
        renderedSequence: 11
      })
    ]));
  });

  it("keeps a terminal lease expiry manually retryable", async () => {
    const repository = createPostgresDocumentArtifactWorkRepository(
      sql as unknown as DatabaseClient
    );
    await sql`
      UPDATE focowiki.document_processing_jobs
      SET state = 'processing', retryable = false,
          safe_error_code = NULL, terminal_at = NULL
      WHERE public_id = 'job-work'
    `;
    await sql`
      UPDATE focowiki.document_artifact_work
      SET state = 'running', attempt_count = maximum_attempts,
          lease_owner = 'expired-worker',
          lease_expires_at = ${at(70_000)},
          next_eligible_at = ${at(70_000)},
          safe_error_code = NULL, retryable = false,
          ended_at = NULL, updated_at = ${at(70_000)}
      WHERE document_job_public_id = 'job-work'
        AND work_kind = 'first_layer'
    `;

    await expect(repository.recoverExpired({
      now: at(71_000),
      retryAt: at(72_000),
      limit: 10
    })).resolves.toBeGreaterThanOrEqual(1);
    await expect(sql<Array<{
      state: string;
      safe_error_code: string | null;
      retryable: boolean;
    }>>`
      SELECT state, safe_error_code, retryable
      FROM focowiki.document_processing_jobs
      WHERE public_id = 'job-work'
    `).resolves.toEqual([{
      state: "error",
      safe_error_code: "WORK_LEASE_EXPIRED",
      retryable: true
    }]);
  });
});

async function seedDocument(sql: postgres.Sql): Promise<void> {
  await sql.unsafe(
    "INSERT INTO focowiki.knowledge_bases (public_id, name, revision) "
    + "VALUES ('kb-work', 'Fixed work', 1); "
    + "INSERT INTO focowiki.knowledge_base_sequences (knowledge_base_id) "
    + "VALUES ('kb-work'); "
    + "INSERT INTO focowiki.runtime_setting_revisions "
    + "(public_id, checksum_sha256, settings_values) VALUES "
    + "('settings-work', '" + "0".repeat(64) + "', "
    + "'{\"schemaVersion\":\"document-indexing-settings-v1\"}'::jsonb); "
    + "INSERT INTO focowiki.object_registrations "
    + "(object_id, storage_key, checksum_sha256, byte_count, content_type, "
    + "object_format, state, write_attempt_public_id, verified_at) VALUES "
    + "('object-work', 'focowiki/test/work.md', '" + "1".repeat(64) + "', 10, "
    + "'text/markdown; charset=utf-8', 'source_markdown', 'verified', "
    + "'write-work', now()), "
    + "('object-work-second', 'focowiki/test/second.md', '" + "2".repeat(64) + "', 12, "
    + "'text/markdown; charset=utf-8', 'source_markdown', 'verified', "
    + "'write-work-second', now()); "
    + "INSERT INTO focowiki.source_files "
    + "(public_id, knowledge_base_id, logical_path, normalized_path, title, metadata, revision) "
    + "VALUES ('source-file-work', 'kb-work', 'work.md', 'work.md', 'Work', '{}'::jsonb, 1), "
    + "('source-file-work-second', 'kb-work', 'second.md', 'second.md', "
    + "'Second', '{}'::jsonb, 1); "
    + "INSERT INTO focowiki.source_revisions "
    + "(public_id, knowledge_base_id, source_file_public_id, object_id, "
    + "checksum_sha256, byte_count, content_type) VALUES "
    + "('source-revision-work', 'kb-work', 'source-file-work', 'object-work', '"
    + "1".repeat(64) + "', 10, 'text/markdown; charset=utf-8'), "
    + "('source-revision-work-second', 'kb-work', 'source-file-work-second', "
    + "'object-work-second', '" + "2".repeat(64) + "', 12, "
    + "'text/markdown; charset=utf-8'); "
    + "INSERT INTO focowiki.operations "
    + "(public_id, knowledge_base_id, operation_kind, state, target_kind, target_public_id) "
    + "VALUES ('operation-work', 'kb-work', 'source_processing', 'accepted', "
    + "'source_file', 'source-file-work'), "
    + "('operation-work-second', 'kb-work', 'source_processing', 'accepted', "
    + "'source_file', 'source-file-work-second'); "
    + "INSERT INTO focowiki.source_file_active_revisions "
    + "(knowledge_base_id, source_file_public_id, current_source_revision_public_id, "
    + "active_source_revision_public_id, activation_sequence) VALUES "
    + "('kb-work', 'source-file-work', 'source-revision-work', NULL, 0), "
    + "('kb-work', 'source-file-work-second', 'source-revision-work-second', NULL, 0)"
  );
  await sql`
    INSERT INTO focowiki.model_configs (
      public_id, provider, model, secret_reference, config, enabled, revision
    ) VALUES (
      'model-config-work', 'openai-compatible', 'generation-model',
      'runtime/model-config-work', '{}'::jsonb, true, 1
    )
  `;
  await sql`
    INSERT INTO focowiki.embedding_configurations (
      public_id, display_name, lifecycle_status, revision
    ) VALUES ('embedding-work', 'Embedding', 'active', 1)
  `;
  await sql`
    INSERT INTO focowiki.embedding_configuration_revisions (
      public_id, configuration_public_id, revision_number, authentication_mode,
      base_url, model_name, requested_dimension, resolved_dimension,
      normalization, maximum_input_tokens, batch_size, timeout_ms, retry_count,
      minimum_interval_ms, concurrency, maximum_response_bytes,
      minimum_vector_relevance, vector_producing_revision_public_id,
      validation_status, validation_fingerprint_sha256, validated_at
    ) VALUES (
      'embedding-revision-work', 'embedding-work', 1, 'none',
      'http://embedding.local/v1', 'embedding-model', 3, 3, 'l2',
      8192, 16, 5000, 1, 0, 2, 1048576, 0.7,
      'embedding-revision-work', 'valid', ${"a".repeat(64)}, now()
    )
  `;
  await sql`
    UPDATE focowiki.embedding_configurations
    SET active_revision_public_id = 'embedding-revision-work'
    WHERE public_id = 'embedding-work'
  `;
  await sql`
    INSERT INTO focowiki.operations (
      public_id, knowledge_base_id, operation_kind, state, completed_at
    ) VALUES (
      'operation-semantic-work', 'kb-work',
      'semantic_contract_bootstrap', 'completed', now()
    )
  `;
  await sql`
    INSERT INTO focowiki.semantic_generations (
      public_id, knowledge_base_id, operation_public_id,
      expected_predecessor_public_id, generation_role, state,
      generation_model_configuration_public_id,
      generation_model_configuration_revision,
      extraction_contract_version, graph_schema_version,
      prompt_contract_version, contract_fingerprint_sha256,
      revision, activated_at
    ) VALUES (
      'semantic-generation-work', 'kb-work', 'operation-semantic-work', NULL,
      'active', 'active', 'model-config-work', 1,
      'extract-v1', 'graph-v1', 'prompt-v1', ${"b".repeat(64)}, 1, now()
    )
  `;
  await sql`
    INSERT INTO focowiki.document_processing_jobs (
      public_id, knowledge_base_id, operation_public_id, source_file_public_id,
      source_revision_public_id, runtime_settings_revision_public_id,
      generation_model_configuration_public_id,
      generation_model_configuration_revision,
      embedding_configuration_revision_public_id,
      semantic_generation_public_id, semantic_contract_version,
      state, maximum_attempts, accepted_at
    ) VALUES (
      'job-work', 'kb-work', 'operation-work', 'source-file-work',
      'source-revision-work', 'settings-work', 'model-config-work', 1,
      'embedding-revision-work', 'semantic-generation-work',
      'semantic-contract-v1', 'waiting', 3, now()
    )
  `;
}

function withDatabase(connectionUrl: string, databaseName: string): string {
  const url = new URL(connectionUrl);
  url.pathname = "/" + databaseName;
  return url.toString();
}

function quote(value: string): string {
  return "\"" + value.replaceAll("\"", "\"\"") + "\"";
}

function at(offsetMilliseconds: number): string {
  return new Date(testStartedAt + offsetMilliseconds).toISOString();
}
