import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyStorageVnextTestMigrations } from './helpers/storage-vnext-test-migrations.js';
import type { SemanticDesiredFactSet, SemanticMaintenanceTarget } from '../src/semantic/domain/contracts.js';
import { createPostgresSemanticFactRepository } from '../src/semantic/infrastructure/postgres-fact-repository.js';
import { createPostgresSemanticGenerationRepository } from '../src/semantic/infrastructure/postgres-generation-repository.js';
import { createPostgresCommunityPartitionRepository } from '../src/semantic/infrastructure/postgres-community-partition-repository.js';
import { createPostgresCommunitySummaryArtifactRepository } from '../src/semantic/infrastructure/postgres-community-summary-artifacts.js';
import { createPostgresSemanticStageRepository } from '../src/semantic/infrastructure/postgres-stage-repository.js';
import { createPostgresSemanticVectorProjectionRepository } from '../src/semantic/infrastructure/postgres-vector-projection-repository.js';
import { createPostgresSemanticDeletionRepository } from '../src/semantic/infrastructure/postgres-semantic-deletion-repository.js';
import { createPostgresStorageVnextOperationRead } from '../src/storage-vnext/api/postgres-operation-read.js';
import { createPostgresActiveVectorHitRepository } from '../src/semantic/infrastructure/postgres-active-vector-hit-repository.js';
import { createPostgresSemanticFileGraphEvidenceRepository } from '../src/semantic/infrastructure/postgres-file-graph-evidence-repository.js';
import { createPostgresSemanticSourcePresentationRepository } from '../src/semantic/infrastructure/postgres-source-presentation-repository.js';
import { createPostgresKnowledgeBaseCreation } from '../src/storage-vnext/api/postgres-knowledge-base-creation.js';
import { createPostgresSemanticPublicationReadinessHooks } from '../src/semantic/infrastructure/postgres-publication-readiness.js';
import { createPostgresStorageVnextReleaseRepository } from '../src/storage-vnext/release/postgres-repository.js';
import { createPostgresStorageVnextAdminResourceRead } from '../src/storage-vnext/api/postgres-admin-resources.js';
import {
  deriveDirtyCommunityPartitions,
  deriveEntityPartitionAssignments
} from '../src/semantic/application/community-planner.js';
import { planSemanticSourceStages } from '../src/semantic/application/stage-orchestration.js';
import { planSemanticVectorProjection } from '../src/semantic/vector/projection-planner.js';

const databaseUrl = process.env.FOCOWIKI_STORAGE_VNEXT_TEST_DATABASE_URL;
const runOwner = process.env.FOCOWIKI_STORAGE_VNEXT_TEST_RUN_OWNER;
const hasOwnedTarget = Boolean(databaseUrl && runOwner && /^svnext-[a-z0-9]{8,16}$/u.test(runOwner));
const describeOwnedDatabase = hasOwnedTarget ? describe : describe.skip;

describeOwnedDatabase('semantic PostgreSQL repositories', () => {
  const connectionUrl = databaseUrl ?? 'postgres://unused:unused@127.0.0.1:5432/unused';
  const ownerToken = (runOwner ?? 'invalid').replaceAll('-', '_');
  const databaseName = 'focowiki_semantic_' + ownerToken + '_' + randomUUID().replaceAll('-', '').slice(0, 10);
  const admin = postgres(databaseConnectionUrl(connectionUrl, 'postgres'), { max: 1 });
  const sql = postgres(databaseConnectionUrl(connectionUrl, databaseName), { max: 8 });
  const generations = createPostgresSemanticGenerationRepository(sql);
  const factRepository = createPostgresSemanticFactRepository(sql);
  const facts = {
    ...factRepository,
    replaceSourceFacts(input: Parameters<typeof factRepository.replaceSourceFacts>[0]) {
      return factRepository.replaceSourceFacts(input, extractionManifest());
    }
  };
  const communityPartitions = createPostgresCommunityPartitionRepository(sql);
  const communitySummaryArtifacts = createPostgresCommunitySummaryArtifactRepository(sql);
  const stages = createPostgresSemanticStageRepository(sql);
  const vectors = createPostgresSemanticVectorProjectionRepository(sql);
  const deletions = createPostgresSemanticDeletionRepository(sql);
  const operationRead = createPostgresStorageVnextOperationRead(sql);
  const activeVectorHits = createPostgresActiveVectorHitRepository(sql);
  const fileGraphEvidence = createPostgresSemanticFileGraphEvidenceRepository(sql);
  const sourcePresentation = createPostgresSemanticSourcePresentationRepository(sql);
  const adminResources = createPostgresStorageVnextAdminResourceRead(sql);
  let databaseCreated = false;

  beforeAll(async () => {
    await admin.unsafe('CREATE DATABASE ' + quoteIdentifier(databaseName));
    databaseCreated = true;
    await applyStorageVnextTestMigrations(sql);
    await seedEmbeddingConfiguration();
  }, 120_000);

  it('creates an eligible knowledge base and empty active semantic contract atomically', async () => {
    const knowledgeBaseId = 'kb-semantic-bootstrap';
    const creation = createPostgresKnowledgeBaseCreation({
      sql,
      resolveSemanticTarget: async (requestedKnowledgeBaseId) =>
        target(requestedKnowledgeBaseId)
    });

    await expect(creation.create({
      publicId: knowledgeBaseId,
      name: 'Semantic bootstrap',
      description: null
    })).resolves.toMatchObject({ publicId: knowledgeBaseId });
    await expect(generations.getActiveProjection(knowledgeBaseId)).resolves.toMatchObject({
      knowledgeBaseId,
      role: 'active',
      state: 'active',
      generationModelConfigurationPublicId: 'model-config-test',
      generationModelConfigurationRevision: 1,
      embeddingConfigurationRevisionPublicId: 'embedding-revision',
      embeddingQueryPolicyRevisionPublicId: 'embedding-revision',
      minimumVectorRelevance: 0.7,
      resolvedDimension: 8,
      searchProviderKind: 'opensearch'
    });
    await expect(countRows('semantic_stage_work_items', knowledgeBaseId)).resolves.toBe(0);
    await expect(countRows('semantic_entities', knowledgeBaseId)).resolves.toBe(0);
    await expect(operationRead.list({
      knowledgeBaseId,
      limit: 10,
      cursor: null
    })).resolves.toEqual({ items: [], nextCursor: null });
  });

  it('keeps a knowledge base explicitly uncontracted when no semantic target is available', async () => {
    const knowledgeBaseId = 'kb-semantic-uncontracted';
    const creation = createPostgresKnowledgeBaseCreation({
      sql,
      resolveSemanticTarget: async () => null
    });

    await expect(creation.create({
      publicId: knowledgeBaseId,
      name: 'Uncontracted',
      description: null
    })).resolves.toMatchObject({ publicId: knowledgeBaseId });
    await expect(generations.getActiveProjection(knowledgeBaseId)).resolves.toBeNull();
  });

  it('reuses community summaries only for an immutable input, model, and prompt identity', async () => {
    const knowledgeBaseId = 'kb-semantic-summary-cache';
    await createPostgresKnowledgeBaseCreation({
      sql,
      resolveSemanticTarget: async (requestedKnowledgeBaseId) =>
        target(requestedKnowledgeBaseId)
    }).create({
      publicId: knowledgeBaseId,
      name: 'Summary cache',
      description: null
    });
    const identity = {
      knowledgeBaseId,
      inputSha256: 'd'.repeat(64),
      modelConfigurationPublicId: 'model-config-test',
      modelConfigurationRevision: 1,
      promptContractVersion: 'general-purpose-graph-v2'
    };

    await expect(communitySummaryArtifacts.find(identity)).resolves.toBeNull();
    await communitySummaryArtifacts.put({ ...identity, summary: 'First summary.' });
    await communitySummaryArtifacts.put({ ...identity, summary: 'Later summary.' });
    await expect(communitySummaryArtifacts.find(identity))
      .resolves.toBe('First summary.');
    await expect(communitySummaryArtifacts.find({
      ...identity,
      modelConfigurationRevision: 2
    })).resolves.toBeNull();
  });

  it('rolls back knowledge-base creation when empty semantic contract persistence fails', async () => {
    const knowledgeBaseId = 'kb-semantic-bootstrap-rollback';
    const creation = createPostgresKnowledgeBaseCreation({
      sql,
      resolveSemanticTarget: async (requestedKnowledgeBaseId) => ({
        ...target(requestedKnowledgeBaseId),
        embeddingConfigurationRevisionPublicId: 'missing-embedding-revision'
      })
    });

    await expect(creation.create({
      publicId: knowledgeBaseId,
      name: 'Rollback',
      description: null
    })).rejects.toBeDefined();
    await expect(sql<Array<{ present: boolean }>>`
      SELECT EXISTS (
        SELECT 1 FROM focowiki.knowledge_bases
        WHERE public_id = ${knowledgeBaseId}
      ) AS present
    `).resolves.toEqual([{ present: false }]);
  });

  it('finalizes semantic validation and source readiness only at release activation', async () => {
    const knowledgeBaseId = 'kb-semantic-publication-ready';
    const sourceOperationPublicId = 'operation-semantic-source-ready';
    const publicationOperationPublicId = 'operation-semantic-publication-ready';
    const candidatePublicId = 'candidate-semantic-publication-ready';
    const creation = createPostgresKnowledgeBaseCreation({
      sql,
      resolveSemanticTarget: async (requestedKnowledgeBaseId) =>
        target(requestedKnowledgeBaseId)
    });
    await creation.create({
      publicId: knowledgeBaseId,
      name: 'Publication readiness',
      description: null
    });
    await seedSource(knowledgeBaseId, 'file-semantic-ready', 'revision-semantic-ready');
    await sql`
      UPDATE focowiki.source_files
      SET status = 'processing',
          model_invocation_source_revision_public_id = 'revision-semantic-ready',
          model_invocation_status = 'skipped',
          model_invocation_model_name = NULL,
          model_invocation_started_at = NULL,
          model_invocation_ended_at = '2026-08-08T00:00:00.000Z',
          model_invocation_warning_count = 0,
          model_invocation_error_code = NULL
      WHERE knowledge_base_id = ${knowledgeBaseId}
        AND public_id = 'file-semantic-ready'
    `;
    await sql`
      INSERT INTO focowiki.webhook_subscriptions (
        public_id, knowledge_base_id, label, endpoint_url,
        secret_reference, event_types, enabled, revision,
        created_at, updated_at
      ) VALUES (
        'webhook-semantic-publication-ready', NULL,
        'Semantic publication readiness',
        'https://hooks.example.com/semantic-publication-ready',
        'inline-v1:test-secret',
        ${sql.json(['source_file.completed'])}, true, 1,
        '2026-08-08T00:00:00.000Z', '2026-08-08T00:00:00.000Z'
      )
    `;
    await sql`
      INSERT INTO focowiki.operations (
        public_id, knowledge_base_id, operation_kind, state, target_kind,
        target_public_id, completed_at
      ) VALUES (
        ${sourceOperationPublicId}, ${knowledgeBaseId}, 'source_processing',
        'completed', 'source_file', 'file-semantic-ready', now()
      ), (
        ${publicationOperationPublicId}, ${knowledgeBaseId}, 'publication',
        'publishing', 'source_file', 'file-semantic-ready', NULL
      )
    `;
    await sql`
      INSERT INTO focowiki.operation_idempotency (
        public_id, knowledge_base_id, idempotency_key, request_hash,
        operation_public_id, expires_at
      ) VALUES (
        'idempotency-semantic-publication-ready', ${knowledgeBaseId},
        'semantic-publication-ready', ${'8'.repeat(64)},
        ${publicationOperationPublicId}, '2027-08-08T00:00:00.000Z'
      )
    `;
    const active = await generations.getActiveProjection(knowledgeBaseId);
    if (!active) throw new Error('Missing active semantic projection');
    await sql`
      INSERT INTO focowiki.semantic_source_reconciliations (
        knowledge_base_id, semantic_generation_public_id,
        source_file_public_id, source_revision_public_id,
        extraction_contract_version, canonical_input_sha256,
        skeleton_policy_version, skeleton_selected,
        source_chunk_count, selected_chunk_count, selection_reasons,
        selection_decision_sha256, entity_count, relationship_count,
        evidence_count, affected_closure, reconciled_at
      ) VALUES (
        ${knowledgeBaseId}, ${active.publicId},
        'file-semantic-ready', 'revision-semantic-ready',
        ${active.extractionContractVersion}, ${'7'.repeat(64)},
        'semantic-skeleton-policy-v2', true,
        1, 1, ${sql.json(['stable_sample'])},
        ${'6'.repeat(64)}, 0, 0, 0, '{}'::jsonb,
        '2026-08-08T00:00:10.000Z'
      )
    `;
    const plan = planSemanticSourceStages({
      knowledgeBaseId,
      operationPublicId: sourceOperationPublicId,
      semanticGenerationPublicId: active.publicId,
      sourceFilePublicId: 'file-semantic-ready',
      sourceRevisionPublicId: 'revision-semantic-ready',
      extractionContractVersion: active.extractionContractVersion,
      embeddingConfigurationRevisionPublicId:
        active.embeddingConfigurationRevisionPublicId,
      settingsSnapshot: { projectionContractPublicId: active.projectionContractPublicId },
      dirtyCommunityPartitionKeys: [],
      includeValidation: true,
      maximumAttempts: 3
    });
    await stages.enqueue({ items: plan, enqueuedAt: '2026-08-08T00:00:00.000Z' });
    await sql`
      UPDATE focowiki.semantic_stage_work_items
      SET state = 'completed', completed_at = now(),
          checkpoint = CASE WHEN stage_kind = 'extraction'
            THEN ${sql.json({ skeletonSelected: true })}
            ELSE '{}'::jsonb END
      WHERE knowledge_base_id = ${knowledgeBaseId}
        AND operation_public_id = ${sourceOperationPublicId}
        AND stage_kind NOT IN ('publication', 'validation')
    `;
    const releases = createPostgresStorageVnextReleaseRepository(sql);
    await releases.createCandidate({
      publicId: candidatePublicId,
      knowledgeBaseId,
      operationPublicId: publicationOperationPublicId,
      candidateRootPublicId: 'root-semantic-publication-ready',
      expectedActiveRootPublicId: null,
      expectedActiveRevision: 0,
      changedFacts: [{
        kind: 'source_file',
        publicId: 'file-semantic-ready',
        change: 'updated'
      }],
      dependencies: [],
      idempotency: {
        key: 'semantic-publication-ready',
        requestHash: '8'.repeat(64)
      },
      createdAt: '2026-08-08T00:00:00.000Z'
    });
    const hooks = createPostgresSemanticPublicationReadinessHooks();
    await expect(sql.begin((transaction) => hooks.beforeActivate!({
      transaction,
      knowledgeBaseId,
      candidatePublicId,
      operationPublicId: publicationOperationPublicId,
      rollbackExpiresAt: null,
      eventExpiresAt: '2026-09-08T00:00:00.000Z',
      activatedAt: '2026-08-08T00:00:30.000Z'
    }))).rejects.toMatchObject({
      code: 'semantic_publication_barrier_incomplete'
    });
    await expect(sql<Array<{ status: string }>>`
      SELECT status FROM focowiki.source_files
      WHERE knowledge_base_id = ${knowledgeBaseId}
        AND public_id = 'file-semantic-ready'
    `).resolves.toEqual([{ status: 'processing' }]);
    await expect(sql<Array<{ event_count: number }>>`
      SELECT count(*)::integer AS event_count
      FROM focowiki.webhook_deliveries
      WHERE subscription_public_id = 'webhook-semantic-publication-ready'
        AND event_type = 'source_file.completed'
    `).resolves.toEqual([{ event_count: 0 }]);

    await sql`
      UPDATE focowiki.semantic_stage_work_items
      SET state = 'completed', completed_at = now(),
          checkpoint = ${sql.json({ candidatePublicId })}
      WHERE knowledge_base_id = ${knowledgeBaseId}
        AND operation_public_id = ${sourceOperationPublicId}
        AND stage_kind = 'publication'
    `;
    await sql.begin((transaction) => hooks.beforeActivate!({
      transaction,
      knowledgeBaseId,
      candidatePublicId,
      operationPublicId: publicationOperationPublicId,
      rollbackExpiresAt: null,
      eventExpiresAt: '2026-09-08T00:00:00.000Z',
      activatedAt: '2026-08-08T00:01:00.000Z'
    }));

    await expect(sql<Array<{
      status: string;
      model_invocation_status: string | null;
      model_invocation_model_name: string | null;
    }>>`
      SELECT status, model_invocation_status, model_invocation_model_name
      FROM focowiki.source_files
      WHERE knowledge_base_id = ${knowledgeBaseId}
        AND public_id = 'file-semantic-ready'
    `).resolves.toEqual([{
      status: 'ready',
      model_invocation_status: 'completed',
      model_invocation_model_name: 'test-generation'
    }]);
    await expect(sql<Array<{
      event_public_id: string;
      event_type: string;
      event_payload: Record<string, unknown>;
      state: string;
    }>>`
      SELECT event_public_id, event_type, event_payload, state
      FROM focowiki.webhook_deliveries
      WHERE subscription_public_id = 'webhook-semantic-publication-ready'
    `).resolves.toEqual([{
      event_public_id: expect.stringMatching(/^event-source-completed-/u),
      event_type: 'source_file.completed',
      event_payload: {
        knowledgeBaseId,
        sourceFileId: 'file-semantic-ready',
        sourceRevisionId: 'revision-semantic-ready'
      },
      state: 'queued'
    }]);
    await expect(stages.summarizeOperation({
      knowledgeBaseId,
      operationPublicId: sourceOperationPublicId,
      semanticGenerationPublicId: active.publicId
    })).resolves.toMatchObject({ totalCount: 7, completedCount: 7, pendingCount: 0 });
  });

  it('runs the contracted upload lifecycle in order and keeps readiness behind publication', async () => {
    const knowledgeBaseId = 'kb-semantic-upload-order';
    const operationPublicId = 'operation-semantic-upload-order';
    const sourceFilePublicId = 'file-semantic-upload-order';
    const sourceRevisionPublicId = 'revision-semantic-upload-order';
    const creation = createPostgresKnowledgeBaseCreation({
      sql,
      resolveSemanticTarget: async (requestedKnowledgeBaseId) =>
        target(requestedKnowledgeBaseId)
    });
    await creation.create({
      publicId: knowledgeBaseId,
      name: 'Semantic upload order',
      description: null
    });
    await seedSource(knowledgeBaseId, sourceFilePublicId, sourceRevisionPublicId);
    await sql`
      UPDATE focowiki.source_files SET status = 'processing'
      WHERE knowledge_base_id = ${knowledgeBaseId}
        AND public_id = ${sourceFilePublicId}
    `;
    await sql`
      INSERT INTO focowiki.operations (
        public_id, knowledge_base_id, operation_kind, state,
        target_kind, target_public_id
      ) VALUES (
        ${operationPublicId}, ${knowledgeBaseId}, 'source_processing',
        'processing', 'source_file', ${sourceFilePublicId}
      )
    `;
    const active = await generations.getActiveProjection(knowledgeBaseId);
    if (!active) throw new Error('Missing active semantic projection');
    const plan = planSemanticSourceStages({
      knowledgeBaseId,
      operationPublicId,
      semanticGenerationPublicId: active.publicId,
      sourceFilePublicId,
      sourceRevisionPublicId,
      extractionContractVersion: active.extractionContractVersion,
      embeddingConfigurationRevisionPublicId:
        active.embeddingConfigurationRevisionPublicId,
      settingsSnapshot: {},
      dirtyCommunityPartitionKeys: [],
      includeValidation: true,
      maximumAttempts: 3
    });
    await stages.enqueue({ items: plan, enqueuedAt: '2026-08-08T00:00:00.000Z' });
    const allKinds = [
      'extraction', 'reconciliation', 'community', 'embedding',
      'vector', 'publication', 'validation'
    ] as const;
    await expect(stages.claim({
      stageKinds: allKinds,
      owner: 'semantic-upload-worker',
      limit: 1,
      now: '2026-08-08T00:00:01.000Z',
      leaseExpiresAt: '2026-08-08T00:01:01.000Z'
    })).resolves.toEqual([]);
    await sql`
      UPDATE focowiki.operations
      SET state = 'completed', completed_at = '2026-08-08T00:00:01.000Z'
      WHERE public_id = ${operationPublicId}
    `;
    for (let ordinal = 0; ordinal < allKinds.length - 1; ordinal += 1) {
      const stageKind = allKinds[ordinal]!;
      const at = new Date(Date.UTC(2026, 7, 8, 0, 0, ordinal + 2)).toISOString();
      const claims = await stages.claim({
        stageKinds: allKinds,
        owner: 'semantic-upload-worker',
        limit: 1,
        now: at,
        leaseExpiresAt: new Date(Date.parse(at) + 60_000).toISOString()
      });
      expect(claims).toHaveLength(1);
      expect(claims[0]?.stageKind).toBe(stageKind);
      await expect(stages.finish({
        claim: claims[0]!,
        outcome: 'completed',
        safeCode: null,
        nextAttemptAt: at,
        completedAt: at
      })).resolves.toBe(true);
      await expect(sql<Array<{ status: string }>>`
        SELECT status FROM focowiki.source_files
        WHERE knowledge_base_id = ${knowledgeBaseId}
          AND public_id = ${sourceFilePublicId}
      `).resolves.toEqual([{ status: 'processing' }]);
    }
    await expect(stages.summarizeOperation({
      knowledgeBaseId,
      operationPublicId,
      semanticGenerationPublicId: active.publicId
    })).resolves.toMatchObject({
      totalCount: 7,
      completedCount: 6,
      pendingCount: 1
    });
  });

  it('presents every durable upload semantic stage and uncontracted maintenance state', async () => {
    const knowledgeBaseId = 'kb-semantic-admin-stages';
    const operationPublicId = 'operation-semantic-admin-stages';
    const sourceFilePublicId = 'file-semantic-admin-stages';
    const sourceRevisionPublicId = 'revision-semantic-admin-stages';
    const creation = createPostgresKnowledgeBaseCreation({
      sql,
      resolveSemanticTarget: async (requestedKnowledgeBaseId) =>
        target(requestedKnowledgeBaseId)
    });
    await creation.create({
      publicId: knowledgeBaseId,
      name: 'Semantic Admin stages',
      description: null
    });
    await seedSource(knowledgeBaseId, sourceFilePublicId, sourceRevisionPublicId);
    await sql`
      UPDATE focowiki.source_files SET status = 'processing'
      WHERE knowledge_base_id = ${knowledgeBaseId}
        AND public_id = ${sourceFilePublicId}
    `;
    await sql`
      INSERT INTO focowiki.operations (
        public_id, knowledge_base_id, operation_kind, state,
        target_kind, target_public_id, completed_at
      ) VALUES (
        ${operationPublicId}, ${knowledgeBaseId}, 'source_processing',
        'completed', 'source_file', ${sourceFilePublicId}, now()
      )
    `;
    const active = await generations.getActiveProjection(knowledgeBaseId);
    if (!active) throw new Error('Missing active semantic projection');
    const plan = planSemanticSourceStages({
      knowledgeBaseId,
      operationPublicId,
      semanticGenerationPublicId: active.publicId,
      sourceFilePublicId,
      sourceRevisionPublicId,
      extractionContractVersion: active.extractionContractVersion,
      embeddingConfigurationRevisionPublicId:
        active.embeddingConfigurationRevisionPublicId,
      settingsSnapshot: {},
      dirtyCommunityPartitionKeys: [],
      includeValidation: true,
      maximumAttempts: 3
    });
    await stages.enqueue({ items: plan, enqueuedAt: '2026-08-08T03:00:00.000Z' });

    await expect(adminResources.getSourceFile({
      knowledgeBaseId,
      sourceFileId: sourceFilePublicId
    })).resolves.toMatchObject({
      processingStatus: 'running',
      currentStage: 'graphrag_processing',
      terminalFailure: null
    });
    await completeStages(operationPublicId, ['extraction']);
    await expect(adminResources.getSourceFile({
      knowledgeBaseId,
      sourceFileId: sourceFilePublicId
    })).resolves.toMatchObject({ currentStage: 'semantic_reconciliation' });
    await completeStages(operationPublicId, ['reconciliation']);
    await expect(adminResources.getSourceFile({
      knowledgeBaseId,
      sourceFileId: sourceFilePublicId
    })).resolves.toMatchObject({ currentStage: 'affected_projection' });
    await completeStages(operationPublicId, ['community']);
    await expect(adminResources.getSourceFile({
      knowledgeBaseId,
      sourceFileId: sourceFilePublicId
    })).resolves.toMatchObject({ currentStage: 'embedding_generation' });
    await completeStages(operationPublicId, ['embedding']);
    await expect(adminResources.getSourceFile({
      knowledgeBaseId,
      sourceFileId: sourceFilePublicId
    })).resolves.toMatchObject({ currentStage: 'affected_projection' });
    await completeStages(operationPublicId, ['vector']);
    await expect(adminResources.getSourceFile({
      knowledgeBaseId,
      sourceFileId: sourceFilePublicId
    })).resolves.toMatchObject({ currentStage: 'search_publication' });
    await sql`
      UPDATE focowiki.semantic_stage_work_items
      SET state = 'failed',
          safe_error_code = 'semantic_provider_publication_failed',
          completed_at = now(), updated_at = now()
      WHERE operation_public_id = ${operationPublicId}
        AND stage_kind = 'publication'
    `;
    await sql`
      UPDATE focowiki.source_files
      SET status = 'failed',
          safe_error_code = 'semantic_provider_publication_failed'
      WHERE knowledge_base_id = ${knowledgeBaseId}
        AND public_id = ${sourceFilePublicId}
    `;
    await expect(adminResources.getSourceFile({
      knowledgeBaseId,
      sourceFileId: sourceFilePublicId
    })).resolves.toMatchObject({
      processingStatus: 'failed',
      currentStage: 'search_publication',
      terminalFailure: {
        stage: 'search_publication',
        code: 'semantic_provider_publication_failed',
        retryKind: 'publication'
      }
    });

    const uncontractedKnowledgeBaseId = 'kb-semantic-admin-uncontracted';
    await seedKnowledgeBase(uncontractedKnowledgeBaseId, []);
    await seedSource(
      uncontractedKnowledgeBaseId,
      'file-semantic-admin-uncontracted',
      'revision-semantic-admin-uncontracted'
    );
    await expect(adminResources.getSourceFile({
      knowledgeBaseId: uncontractedKnowledgeBaseId,
      sourceFileId: 'file-semantic-admin-uncontracted'
    })).resolves.toMatchObject({
      processingStatus: 'completed',
      currentStage: 'semantic_maintenance_required'
    });
  });

  afterAll(async () => {
    await sql.end({ timeout: 5 });
    if (databaseCreated) {
      await admin.unsafe('DROP DATABASE IF EXISTS ' + quoteIdentifier(databaseName) + ' WITH (FORCE)');
    }
    await admin.end({ timeout: 5 });
  }, 120_000);

  it('replaces facts transactionally and exposes only the active scoped generation', async () => {
    await seedKnowledgeBase('kb-semantic-main', ['operation-main']);
    await seedSource('kb-semantic-main', 'file-main', 'revision-main');
    const candidate = await generations.createCandidate({
      operationPublicId: 'operation-main',
      candidatePublicId: 'semantic-main',
      expectedPredecessorPublicId: null,
      target: target('kb-semantic-main'),
      contractFingerprintSha256: '3'.repeat(64)
    });
    const invalid = desiredFacts('kb-semantic-main', 'semantic-main', 'file-main', 'revision-main');
    invalid.mentions = [{ ...invalid.mentions[0]!, entityPublicId: 'missing-entity' }];
    await expect(facts.replaceSourceFacts(invalid)).rejects.toMatchObject({ code: '23503' });
    await expect(countRows('semantic_entities', 'kb-semantic-main')).resolves.toBe(0);

    const desired = desiredFacts('kb-semantic-main', 'semantic-main', 'file-main', 'revision-main');
    await facts.replaceSourceFacts(desired);
    await facts.replaceSourceFacts(desired);
    await expect(facts.listSourceEntityPublicIds({
      knowledgeBaseId: 'kb-semantic-main',
      semanticGenerationPublicId: 'semantic-main',
      sourceFilePublicId: 'file-main',
      sourceRevisionPublicId: 'revision-main',
      limit: 2_000
    })).resolves.toEqual(['entity-main-a', 'entity-main-b']);
    await sql`UPDATE focowiki.semantic_generations SET state = 'ready', revision = revision + 1 WHERE public_id = 'semantic-main'`;
    await expect(generations.activateCandidate({
      knowledgeBaseId: 'kb-semantic-main',
      candidatePublicId: 'semantic-main',
      expectedPredecessorPublicId: null,
      expectedCandidateRevision: candidate.revision + 1,
      activatedAt: '2026-08-08T00:00:00.000Z'
    })).resolves.toMatchObject({ role: 'active', state: 'active', revision: 2 });
    await expect(facts.listActiveEntities({
      knowledgeBaseId: 'kb-semantic-main', limit: 1, cursor: null
    })).resolves.toMatchObject({ items: [{ publicId: 'entity-main-a', aliases: ['Main A'] }] });
    await expect(generations.getActiveProjection('kb-semantic-main')).resolves.toMatchObject({
      publicId: 'semantic-main',
      generationModelConfigurationPublicId: 'model-config-test',
      generationModelConfigurationRevision: 1,
      embeddingConfigurationRevisionPublicId: 'embedding-revision',
      resolvedDimension: 8,
      searchProviderKind: 'opensearch'
    });
    await expect(countRows('semantic_entities', 'kb-semantic-main')).resolves.toBe(2);
  });

  it('accepts bounded CRUD work inside one active semantic contract generation', async () => {
    await seedKnowledgeBase('kb-semantic-active-delta', [
      'operation-active-contract',
      'operation-active-delta'
    ]);
    await seedSource(
      'kb-semantic-active-delta',
      'file-active-delta',
      'revision-active-delta'
    );
    const candidate = await generations.createCandidate({
      operationPublicId: 'operation-active-contract',
      candidatePublicId: 'semantic-active-delta',
      expectedPredecessorPublicId: null,
      target: target('kb-semantic-active-delta'),
      contractFingerprintSha256: 'a'.repeat(64)
    });
    await sql`
      UPDATE focowiki.semantic_generations
      SET state = 'ready', revision = revision + 1
      WHERE public_id = 'semantic-active-delta'
    `;
    await generations.activateCandidate({
      knowledgeBaseId: 'kb-semantic-active-delta',
      candidatePublicId: 'semantic-active-delta',
      expectedPredecessorPublicId: null,
      expectedCandidateRevision: candidate.revision + 1,
      activatedAt: '2027-08-08T00:00:00.000Z'
    });

    await expect(facts.replaceSourceFacts(desiredFacts(
      'kb-semantic-active-delta',
      'semantic-active-delta',
      'file-active-delta',
      'revision-active-delta'
    ))).resolves.toMatchObject({
      knowledgeBaseId: 'kb-semantic-active-delta',
      sourceFilePublicIds: ['file-active-delta']
    });

    const plan = planSemanticSourceStages({
      knowledgeBaseId: 'kb-semantic-active-delta',
      operationPublicId: 'operation-active-delta',
      semanticGenerationPublicId: 'semantic-active-delta',
      sourceFilePublicId: 'file-active-delta',
      sourceRevisionPublicId: 'revision-active-delta',
      extractionContractVersion: 'extract-v1',
      embeddingConfigurationRevisionPublicId: 'embedding-revision',
      settingsSnapshot: { generationModelRevisionPublicId: 'model-v1' },
      dirtyCommunityPartitionKeys: [],
      includeValidation: false,
      maximumAttempts: 2
    });
    await expect(stages.enqueue({
      items: plan,
      enqueuedAt: '2027-08-08T00:00:01.000Z'
    })).resolves.toBe(plan.length);
    const claims = await stages.claim({
      stageKinds: ['extraction'],
      owner: 'active-delta-worker',
      limit: 1,
      now: '2027-08-08T00:00:02.000Z',
      leaseExpiresAt: '2027-08-08T00:01:02.000Z'
    });
    expect(claims).toHaveLength(1);
    await expect(stages.isOwned({ claim: claims[0]! })).resolves.toBe(true);
  });

  it('converges a formerly selected source to an empty unselected manifest', async () => {
    const knowledgeBaseId = 'kb-semantic-selection-convergence';
    const operationPublicId = 'operation-semantic-selection-convergence';
    const generationPublicId = 'semantic-selection-convergence';
    const sourceFilePublicId = 'file-selection-convergence';
    const sourceRevisionPublicId = 'revision-selection-convergence';
    await seedKnowledgeBase(knowledgeBaseId, [operationPublicId]);
    await seedSource(
      knowledgeBaseId,
      sourceFilePublicId,
      sourceRevisionPublicId
    );
    await generations.createCandidate({
      operationPublicId,
      candidatePublicId: generationPublicId,
      expectedPredecessorPublicId: null,
      target: target(knowledgeBaseId),
      contractFingerprintSha256: '4'.repeat(64)
    });
    const selectedFacts = desiredFacts(
      knowledgeBaseId,
      generationPublicId,
      sourceFilePublicId,
      sourceRevisionPublicId
    );
    await factRepository.replaceSourceFacts(selectedFacts, extractionManifest());
    const unselectedFacts: SemanticDesiredFactSet = {
      ...selectedFacts,
      entities: [],
      evidence: [],
      mentions: [],
      relationships: [],
      communities: [],
      communityReports: []
    };
    await factRepository.replaceSourceFacts(unselectedFacts, {
      ...extractionManifest(),
      skeletonSelected: false,
      selectedChunkCount: 0,
      selectionReasons: [],
      selectionDecisionSha256: '0'.repeat(64)
    });

    await expect(sql<Array<{
      skeleton_selected: boolean;
      selected_chunk_count: number;
      entity_count: number;
      relationship_count: number;
      evidence_count: number;
    }>>`
      SELECT skeleton_selected, selected_chunk_count,
             entity_count, relationship_count, evidence_count
      FROM focowiki.semantic_source_reconciliations
      WHERE knowledge_base_id = ${knowledgeBaseId}
        AND semantic_generation_public_id = ${generationPublicId}
        AND source_file_public_id = ${sourceFilePublicId}
        AND source_revision_public_id = ${sourceRevisionPublicId}
    `).resolves.toEqual([{
      skeleton_selected: false,
      selected_chunk_count: 0,
      entity_count: 0,
      relationship_count: 0,
      evidence_count: 0
    }]);
    await expect(countRows('semantic_entities', knowledgeBaseId)).resolves.toBe(0);
    await expect(countRows('semantic_relationships', knowledgeBaseId)).resolves.toBe(0);
    await expect(countRows('semantic_evidence', knowledgeBaseId)).resolves.toBe(0);
  });

  it('reads bounded active source evidence for file graph and generated presentation without mutations', async () => {
    await seedKnowledgeBase('kb-semantic-presentation', ['operation-presentation']);
    await seedSource('kb-semantic-presentation', 'file-presentation-a', 'revision-presentation-a');
    await seedSource('kb-semantic-presentation', 'file-presentation-b', 'revision-presentation-b');
    const candidate = await generations.createCandidate({
      operationPublicId: 'operation-presentation',
      candidatePublicId: 'semantic-presentation',
      expectedPredecessorPublicId: null,
      target: target('kb-semantic-presentation'),
      contractFingerprintSha256: 'b'.repeat(64)
    });
    await facts.replaceSourceFacts(presentationFacts({
      sourceFilePublicId: 'file-presentation-a',
      sourceRevisionPublicId: 'revision-presentation-a',
      mentionedEntityPublicId: 'entity-presentation-from',
      evidenceSuffix: 'a'
    }));
    await facts.replaceSourceFacts(presentationFacts({
      sourceFilePublicId: 'file-presentation-b',
      sourceRevisionPublicId: 'revision-presentation-b',
      mentionedEntityPublicId: 'entity-presentation-to',
      evidenceSuffix: 'b'
    }));
    await sql`
      UPDATE focowiki.semantic_generations
      SET state = 'ready', revision = revision + 1
      WHERE public_id = 'semantic-presentation'
    `;
    await generations.activateCandidate({
      knowledgeBaseId: 'kb-semantic-presentation',
      candidatePublicId: 'semantic-presentation',
      expectedPredecessorPublicId: null,
      expectedCandidateRevision: candidate.revision + 1,
      activatedAt: '2027-08-08T00:00:00.000Z'
    });
    const before = await countRows('semantic_entities', 'kb-semantic-presentation');

    await expect(fileGraphEvidence.listOutboundCandidates({
      knowledgeBaseId: 'kb-semantic-presentation',
      operationPublicId: 'operation-presentation-read',
      sourceFilePublicId: 'file-presentation-a',
      sourceRevisionPublicId: 'revision-presentation-a',
      limit: 4
    })).resolves.toEqual([{
      targetSourceFilePublicId: 'file-presentation-b',
      targetSourceRevisionPublicId: 'revision-presentation-b',
      fromEntityLabel: 'Input service',
      toEntityLabel: 'Output service',
      kind: 'feeds',
      description: 'Input service feeds output service.',
      confidence: 0.9,
      evidence: [
        expect.objectContaining({
          sourceFilePublicId: 'file-presentation-a',
          logicalPath: 'file-presentation-a.md'
        }),
        expect.objectContaining({
          sourceFilePublicId: 'file-presentation-b',
          logicalPath: 'file-presentation-b.md'
        })
      ]
    }]);
    await expect(sourcePresentation.getSourceContext({
      knowledgeBaseId: 'kb-semantic-presentation',
      operationPublicId: 'operation-presentation-read',
      sourceFilePublicId: 'file-presentation-a',
      sourceRevisionPublicId: 'revision-presentation-a',
      entityLimit: 4
    })).resolves.toEqual({
      entities: [{
        label: 'Input service',
        kind: 'component',
        description: 'Receives source records.',
        confidence: 0.95,
        evidencePaths: ['pages/file-presentation-a.md']
      }]
    });
    await expect(fileGraphEvidence.listOutboundCandidates({
      knowledgeBaseId: 'kb-semantic-presentation',
      operationPublicId: 'operation-presentation-read',
      sourceFilePublicId: 'file-presentation-a',
      sourceRevisionPublicId: 'revision-stale',
      limit: 4
    })).resolves.toEqual([]);
    await expect(countRows('semantic_entities', 'kb-semantic-presentation'))
      .resolves.toBe(before);
  });

  it('presents a matching ready adoption candidate without changing active reads', async () => {
    const knowledgeBaseId = 'kb-semantic-candidate-presentation';
    const activeOperationPublicId = 'operation-candidate-presentation-active';
    const adoptionOperationPublicId = 'operation-candidate-presentation-adoption';
    await seedKnowledgeBase(knowledgeBaseId, [
      activeOperationPublicId,
      adoptionOperationPublicId
    ]);
    await seedSource(knowledgeBaseId, 'file-candidate-a', 'revision-candidate-a');
    await seedSource(knowledgeBaseId, 'file-candidate-b', 'revision-candidate-b');
    const active = await generations.createCandidate({
      operationPublicId: activeOperationPublicId,
      candidatePublicId: 'semantic-candidate-presentation-active',
      expectedPredecessorPublicId: null,
      target: target(knowledgeBaseId),
      contractFingerprintSha256: 'c'.repeat(64)
    });
    for (const source of [
      ['file-candidate-a', 'revision-candidate-a', 'entity-presentation-from', 'a'],
      ['file-candidate-b', 'revision-candidate-b', 'entity-presentation-to', 'b']
    ] as const) {
      await facts.replaceSourceFacts(presentationFacts({
        knowledgeBaseId,
        semanticGenerationPublicId: 'semantic-candidate-presentation-active',
        sourceFilePublicId: source[0],
        sourceRevisionPublicId: source[1],
        mentionedEntityPublicId: source[2],
        evidenceSuffix: source[3],
        labelPrefix: 'Active '
      }));
    }
    await sql`
      UPDATE focowiki.semantic_generations
      SET state = 'ready', revision = revision + 1
      WHERE public_id = 'semantic-candidate-presentation-active'
    `;
    await generations.activateCandidate({
      knowledgeBaseId,
      candidatePublicId: 'semantic-candidate-presentation-active',
      expectedPredecessorPublicId: null,
      expectedCandidateRevision: active.revision + 1,
      activatedAt: '2027-08-08T00:00:00.000Z'
    });
    const candidate = await generations.createCandidate({
      operationPublicId: adoptionOperationPublicId,
      candidatePublicId: 'semantic-candidate-presentation-ready',
      expectedPredecessorPublicId: 'semantic-candidate-presentation-active',
      target: { ...target(knowledgeBaseId), promptContractVersion: 'prompt-v2' },
      contractFingerprintSha256: 'd'.repeat(64)
    });
    for (const source of [
      ['file-candidate-a', 'revision-candidate-a', 'entity-presentation-from', 'a'],
      ['file-candidate-b', 'revision-candidate-b', 'entity-presentation-to', 'b']
    ] as const) {
      await facts.replaceSourceFacts(presentationFacts({
        knowledgeBaseId,
        semanticGenerationPublicId: 'semantic-candidate-presentation-ready',
        sourceFilePublicId: source[0],
        sourceRevisionPublicId: source[1],
        mentionedEntityPublicId: source[2],
        evidenceSuffix: source[3],
        labelPrefix: 'Candidate '
      }));
    }
    await sql`
      UPDATE focowiki.semantic_generations
      SET state = 'ready', revision = revision + 1
      WHERE public_id = 'semantic-candidate-presentation-ready'
    `;

    await expect(sourcePresentation.getSourceContext({
      knowledgeBaseId,
      operationPublicId: adoptionOperationPublicId,
      sourceFilePublicId: 'file-candidate-a',
      sourceRevisionPublicId: 'revision-candidate-a',
      entityLimit: 4
    })).resolves.toMatchObject({ entities: [{ label: 'Candidate Input service' }] });
    await expect(fileGraphEvidence.listOutboundCandidates({
      knowledgeBaseId,
      operationPublicId: adoptionOperationPublicId,
      sourceFilePublicId: 'file-candidate-a',
      sourceRevisionPublicId: 'revision-candidate-a',
      limit: 4
    })).resolves.toMatchObject([{
      fromEntityLabel: 'Candidate Input service',
      toEntityLabel: 'Candidate Output service'
    }]);
    await expect(sourcePresentation.getSourceContext({
      knowledgeBaseId,
      operationPublicId: 'ordinary-read-operation',
      sourceFilePublicId: 'file-candidate-a',
      sourceRevisionPublicId: 'revision-candidate-a',
      entityLimit: 4
    })).resolves.toMatchObject({ entities: [{ label: 'Active Input service' }] });
    await expect(generations.getActive(knowledgeBaseId)).resolves.toMatchObject({
      publicId: 'semantic-candidate-presentation-active',
      state: 'active'
    });
    await expect(generations.getCandidateByOperation({
      knowledgeBaseId,
      operationPublicId: adoptionOperationPublicId
    })).resolves.toMatchObject({
      publicId: 'semantic-candidate-presentation-ready',
      state: 'ready',
      revision: candidate.revision + 1
    });
  });

  it('discards one failed maintenance candidate and orphans only unowned artifacts', async () => {
    const knowledgeBaseId = 'kb-semantic-candidate-discard';
    const activeOperationPublicId = 'operation-candidate-discard-active';
    const failedOperationPublicId = 'operation-candidate-discard-failed';
    await seedKnowledgeBase(knowledgeBaseId, [
      activeOperationPublicId,
      failedOperationPublicId
    ]);
    await seedSource(knowledgeBaseId, 'file-candidate-discard', 'revision-candidate-discard');
    const active = await generations.createCandidate({
      operationPublicId: activeOperationPublicId,
      candidatePublicId: 'semantic-candidate-discard-active',
      expectedPredecessorPublicId: null,
      target: target(knowledgeBaseId),
      contractFingerprintSha256: 'e'.repeat(64)
    });
    await sql`
      UPDATE focowiki.semantic_generations
      SET state = 'ready', revision = revision + 1
      WHERE public_id = 'semantic-candidate-discard-active'
    `;
    await generations.activateCandidate({
      knowledgeBaseId,
      candidatePublicId: 'semantic-candidate-discard-active',
      expectedPredecessorPublicId: null,
      expectedCandidateRevision: active.revision + 1,
      activatedAt: '2027-08-08T00:00:00.000Z'
    });
    await generations.createCandidate({
      operationPublicId: failedOperationPublicId,
      candidatePublicId: 'semantic-candidate-discard-failed',
      expectedPredecessorPublicId: 'semantic-candidate-discard-active',
      target: { ...target(knowledgeBaseId), promptContractVersion: 'prompt-v2' },
      contractFingerprintSha256: 'f'.repeat(64)
    });
    await facts.replaceSourceFacts(desiredFacts(
      knowledgeBaseId,
      'semantic-candidate-discard-failed',
      'file-candidate-discard',
      'revision-candidate-discard'
    ));
    await seedVectorArtifact({
      knowledgeBaseId,
      semanticGenerationPublicId: 'semantic-candidate-discard-failed',
      operationPublicId: failedOperationPublicId,
      sourceFilePublicId: 'file-candidate-discard',
      sourceRevisionPublicId: 'revision-candidate-discard',
      ownerPublicId: 'file-candidate-discard',
      artifactPublicId: 'artifact-candidate-discard',
      family: 'content'
    });

    await expect(generations.discardCandidateByOperation({
      knowledgeBaseId,
      operationPublicId: failedOperationPublicId
    })).resolves.toBe('deleted');
    await expect(generations.discardCandidateByOperation({
      knowledgeBaseId,
      operationPublicId: failedOperationPublicId
    })).resolves.toBe('missing');
    await expect(generations.getActive(knowledgeBaseId)).resolves.toMatchObject({
      publicId: 'semantic-candidate-discard-active',
      state: 'active'
    });
    await expect(countRows('semantic_generations', knowledgeBaseId)).resolves.toBe(1);
    await expect(countRows('semantic_entities', knowledgeBaseId)).resolves.toBe(0);
    await expect(sql<Array<{ state: string }>>`
      SELECT state
      FROM focowiki.embedding_artifacts
      WHERE public_id = 'artifact-candidate-discard'
    `).resolves.toEqual([{ state: 'orphaned' }]);
  });

  it('presents durable semantic stage progress from the operation read SQL', async () => {
    const knowledgeBaseId = 'kb-semantic-operation-status';
    const operationPublicId = 'operation-semantic-status';
    const sourceFilePublicId = 'file-semantic-status';
    const sourceRevisionPublicId = 'revision-semantic-status';
    await seedKnowledgeBase(knowledgeBaseId, [operationPublicId]);
    await seedSource(knowledgeBaseId, sourceFilePublicId, sourceRevisionPublicId);
    await sql`
      UPDATE focowiki.operations
      SET operation_kind = 'source_replace', state = 'completed',
          target_kind = 'source_file', target_public_id = ${sourceFilePublicId},
          completed_at = '2027-08-08T00:00:01.000Z'
      WHERE public_id = ${operationPublicId}
    `;
    const candidate = await generations.createCandidate({
      operationPublicId,
      candidatePublicId: 'semantic-operation-status',
      expectedPredecessorPublicId: null,
      target: target(knowledgeBaseId),
      contractFingerprintSha256: '6'.repeat(64)
    });
    await sql`
      UPDATE focowiki.semantic_generations
      SET state = 'ready', revision = revision + 1
      WHERE public_id = 'semantic-operation-status'
    `;
    await generations.activateCandidate({
      knowledgeBaseId,
      candidatePublicId: 'semantic-operation-status',
      expectedPredecessorPublicId: null,
      expectedCandidateRevision: candidate.revision + 1,
      activatedAt: '2027-08-08T00:00:00.000Z'
    });
    const items = planSemanticSourceStages({
      knowledgeBaseId,
      operationPublicId,
      semanticGenerationPublicId: 'semantic-operation-status',
      sourceFilePublicId,
      sourceRevisionPublicId,
      extractionContractVersion: 'extract-v1',
      embeddingConfigurationRevisionPublicId: 'embedding-revision',
      settingsSnapshot: {},
      dirtyCommunityPartitionKeys: [],
      includeValidation: false,
      maximumAttempts: 3
    });
    await stages.enqueue({
      items,
      enqueuedAt: '2027-08-08T00:00:00.000Z'
    });
    await sql`
      UPDATE focowiki.semantic_stage_work_items
      SET state = CASE WHEN stage_kind = 'extraction' THEN 'failed'
            WHEN stage_kind = 'reconciliation' THEN 'completed'
            ELSE state END,
          safe_error_code = CASE WHEN stage_kind = 'extraction'
            THEN 'semantic_stage_invalid_output' ELSE NULL END,
          completed_at = CASE WHEN stage_kind IN ('extraction', 'reconciliation')
            THEN '2027-08-08T00:00:01.000Z'::timestamptz ELSE NULL END,
          updated_at = '2027-08-08T00:00:01.000Z'
      WHERE operation_public_id = ${operationPublicId}
    `;
    await sql`
      INSERT INTO focowiki.operation_results (
        public_id, knowledge_base_id, operation_kind, terminal_state,
        result_code, result_summary, completed_at, expires_at
      ) VALUES (
        ${operationPublicId}, ${knowledgeBaseId}, 'mutation', 'completed',
        'MUTATION_ACTIVATED', ${sql.json({ semanticState: 'pending' })},
        '2027-08-08T00:00:01.000Z', '2027-08-09T00:00:01.000Z'
      )
    `;

    await expect(operationRead.get({
      knowledgeBaseId,
      operationId: operationPublicId
    })).resolves.toMatchObject({
      state: 'failed',
      result: {
        semanticState: 'failed',
        semanticSafeCode: 'semantic_stage_invalid_output',
        semanticStageTotalCount: 6,
        semanticStageCompletedCount: 1,
        semanticStagePendingCount: 4,
        semanticStageFailedCount: 1,
        semanticStageSupersededCount: 0
      }
    });
  });

  it('preserves shared fact contributions while replacing one bounded source', async () => {
    await seedKnowledgeBase('kb-semantic-shared', ['operation-shared']);
    await seedSource('kb-semantic-shared', 'file-shared-a', 'revision-shared-a');
    await seedSource('kb-semantic-shared', 'file-shared-b', 'revision-shared-b');
    await generations.createCandidate({
      operationPublicId: 'operation-shared',
      candidatePublicId: 'semantic-shared',
      expectedPredecessorPublicId: null,
      target: target('kb-semantic-shared'),
      contractFingerprintSha256: '9'.repeat(64)
    });

    await facts.replaceSourceFacts(sharedDesiredFacts({
      sourceFilePublicId: 'file-shared-a',
      sourceRevisionPublicId: 'revision-shared-a',
      alias: 'Shared Alpha',
      entityDescription: 'Alpha source description.',
      relationshipDescription: 'Alpha source relationship.'
    }));
    const secondClosure = await facts.replaceSourceFacts(sharedDesiredFacts({
      sourceFilePublicId: 'file-shared-b',
      sourceRevisionPublicId: 'revision-shared-b',
      alias: 'Shared Beta',
      entityDescription: 'Beta source description.',
      relationshipDescription: 'Beta source relationship.'
    }));
    expect(secondClosure.affectedFileNeighborPublicIds).toEqual(['file-shared-a']);
    await expect(readSharedPresentation()).resolves.toEqual({
      aliases: ['Shared Alpha', 'Shared Beta'],
      entityDescription: 'Alpha source description.',
      relationshipDescription: 'Alpha source relationship.',
      entityObservationCount: 4,
      relationshipObservationCount: 2
    });

    const removed = sharedDesiredFacts({
      sourceFilePublicId: 'file-shared-a',
      sourceRevisionPublicId: 'revision-shared-a',
      alias: 'Unused',
      entityDescription: 'Unused',
      relationshipDescription: 'Unused'
    });
    removed.entities = [];
    removed.evidence = [];
    removed.mentions = [];
    removed.relationships = [];
    const removalClosure = await facts.replaceSourceFacts(removed);
    expect(removalClosure.affectedFileNeighborPublicIds).toEqual(['file-shared-b']);
    await expect(readSharedPresentation()).resolves.toEqual({
      aliases: ['Shared Beta'],
      entityDescription: 'Beta source description.',
      relationshipDescription: 'Beta source relationship.',
      entityObservationCount: 2,
      relationshipObservationCount: 1
    });
  });

  it('serializes competing candidates for one knowledge base', async () => {
    await seedKnowledgeBase('kb-semantic-race', ['operation-race-a', 'operation-race-b']);
    const attempts = await Promise.allSettled(['a', 'b'].map((suffix) => generations.createCandidate({
      operationPublicId: 'operation-race-' + suffix,
      candidatePublicId: 'semantic-race-' + suffix,
      expectedPredecessorPublicId: null,
      target: target('kb-semantic-race'),
      contractFingerprintSha256: '4'.repeat(64)
    })));
    expect(attempts.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(attempts.find((result) => result.status === 'rejected')).toMatchObject({
      reason: expect.objectContaining({ code: 'candidate_conflict' })
    });
  });

  it('durably orders, checkpoints, cancels, recovers, and fairly claims semantic stages', async () => {
    for (const suffix of ['a', 'b']) {
      const knowledgeBaseId = 'kb-semantic-stage-' + suffix;
      const operationPublicId = 'operation-stage-' + suffix;
      const generationPublicId = 'semantic-stage-' + suffix;
      const filePublicId = 'file-stage-' + suffix;
      const revisionPublicId = 'revision-stage-' + suffix;
      await seedKnowledgeBase(knowledgeBaseId, [operationPublicId]);
      await seedSource(knowledgeBaseId, filePublicId, revisionPublicId);
      await generations.createCandidate({
        operationPublicId,
        candidatePublicId: generationPublicId,
        expectedPredecessorPublicId: null,
        target: target(knowledgeBaseId),
        contractFingerprintSha256: suffix.repeat(64)
      });
      const plan = planSemanticSourceStages({
        knowledgeBaseId, operationPublicId,
        semanticGenerationPublicId: generationPublicId,
        sourceFilePublicId: filePublicId,
        sourceRevisionPublicId: revisionPublicId,
        extractionContractVersion: 'extract-v1',
        embeddingConfigurationRevisionPublicId: 'embedding-revision',
        settingsSnapshot: { generationModelRevisionPublicId: 'model-v1' },
        dirtyCommunityPartitionKeys: [],
        includeValidation: false,
        maximumAttempts: 2
      });
      await expect(stages.enqueue({
        items: plan, enqueuedAt: '2027-08-08T00:00:00.000Z'
      })).resolves.toBe(plan.length);
      await expect(stages.enqueue({
        items: plan, enqueuedAt: '2027-08-08T00:00:00.000Z'
      })).resolves.toBe(plan.length);
    }
    const firstClaims = await stages.claim({
      stageKinds: ['extraction', 'embedding', 'reconciliation', 'vector', 'publication'],
      owner: 'stage-worker-1', limit: 2,
      now: '2027-08-08T00:00:01.000Z',
      leaseExpiresAt: '2027-08-08T00:00:03.000Z'
    });
    expect(firstClaims).toHaveLength(2);
    expect(new Set(firstClaims.map((claim) => claim.knowledgeBaseId)).size).toBe(2);
    expect(firstClaims.every((claim) => claim.stageKind === 'extraction')).toBe(true);
    const first = firstClaims[0]!;
    await expect(stages.saveCheckpoint({
      claim: first, checkpoint: { artifactPublicId: 'artifact-stage-a' }
    })).resolves.toBe(true);
    await expect(stages.finish({
      claim: first, outcome: 'completed', safeCode: null,
      nextAttemptAt: '2027-08-08T00:00:02.000Z',
      completedAt: '2027-08-08T00:00:02.000Z'
    })).resolves.toBe(true);
    await expect(sql<Array<{ service_time_milliseconds: string }>>`
      SELECT service_time_milliseconds::text
      FROM focowiki.semantic_stage_work_items
      WHERE public_id = ${first.publicId}
    `).resolves.toEqual([{ service_time_milliseconds: '1000' }]);
    const activePeer = firstClaims.find((claim) => claim.publicId !== first.publicId)!;
    const refill = await stages.claim({
      stageKinds: ['extraction', 'embedding', 'reconciliation', 'vector', 'publication'],
      owner: 'stage-worker-refill', limit: 1,
      excludedKnowledgeBaseIds: [activePeer.knowledgeBaseId],
      now: '2027-08-08T00:00:02.500Z',
      leaseExpiresAt: '2027-08-08T00:00:03.500Z'
    });
    expect(refill).toHaveLength(1);
    expect(refill[0]).toMatchObject({
      knowledgeBaseId: first.knowledgeBaseId,
      stageKind: 'reconciliation'
    });
    await expect(stages.finish({
      claim: refill[0]!, outcome: 'completed', safeCode: null,
      nextAttemptAt: '2027-08-08T00:00:02.750Z',
      completedAt: '2027-08-08T00:00:02.750Z'
    })).resolves.toBe(true);
    await expect(stages.recoverExpired({
      expiredBefore: '2027-08-08T00:00:04.000Z',
      nextAttemptAt: '2027-08-08T00:00:04.000Z', limit: 10
    })).resolves.toBe(1);
    const resumed = await stages.claim({
      stageKinds: ['extraction'], owner: 'stage-worker-2', limit: 2,
      now: '2027-08-08T00:00:05.000Z',
      leaseExpiresAt: '2027-08-08T00:00:10.000Z'
    });
    expect(resumed).toHaveLength(1);
    expect(resumed[0]).toMatchObject({ attemptCount: 2, leaseOwner: 'stage-worker-2' });
    await expect(stages.requestCancellation({
      knowledgeBaseId: resumed[0]!.knowledgeBaseId,
      semanticGenerationPublicId: resumed[0]!.semanticGenerationPublicId,
      sourceFilePublicIds: [resumed[0]!.sourceFilePublicId],
      requestedAt: '2027-08-08T00:00:06.000Z'
    })).resolves.toBeGreaterThan(0);
    await expect(stages.isOwned({ claim: resumed[0]! })).resolves.toBe(false);
    await expect(stages.finish({
      claim: resumed[0]!, outcome: 'cancelled', safeCode: 'semantic_stage_cancelled',
      nextAttemptAt: '2027-08-08T00:00:06.000Z',
      completedAt: '2027-08-08T00:00:06.000Z'
    })).resolves.toBe(false);
    await expect(stages.recoverExpired({
      expiredBefore: '2027-08-08T00:00:11.000Z',
      nextAttemptAt: '2027-08-08T00:00:11.000Z', limit: 10
    })).resolves.toBe(1);
  });

  it('makes exhausted lease recovery terminal without resetting its durable checkpoint', async () => {
    const knowledgeBaseId = 'kb-semantic-exhausted';
    const operationPublicId = 'operation-semantic-exhausted';
    const semanticGenerationPublicId = 'semantic-exhausted';
    const sourceFilePublicId = 'file-semantic-exhausted';
    const sourceRevisionPublicId = 'revision-semantic-exhausted';
    await seedKnowledgeBase(knowledgeBaseId, [operationPublicId]);
    await seedSource(knowledgeBaseId, sourceFilePublicId, sourceRevisionPublicId);
    await generations.createCandidate({
      operationPublicId,
      candidatePublicId: semanticGenerationPublicId,
      expectedPredecessorPublicId: null,
      target: target(knowledgeBaseId),
      contractFingerprintSha256: '5'.repeat(64)
    });
    const plan = planSemanticSourceStages({
      knowledgeBaseId,
      operationPublicId,
      semanticGenerationPublicId,
      sourceFilePublicId,
      sourceRevisionPublicId,
      extractionContractVersion: 'extract-v1',
      embeddingConfigurationRevisionPublicId: 'embedding-revision',
      settingsSnapshot: { generationModelRevisionPublicId: 'model-v1' },
      dirtyCommunityPartitionKeys: [],
      includeValidation: false,
      maximumAttempts: 1
    });
    await stages.enqueue({ items: plan, enqueuedAt: '2026-08-08T01:00:00.000Z' });
    const claims = await stages.claim({
      stageKinds: ['extraction'], owner: 'exhausted-worker', limit: 1,
      now: '2026-08-08T01:00:01.000Z',
      leaseExpiresAt: '2026-08-08T01:00:02.000Z'
    });
    expect(claims).toHaveLength(1);
    await expect(stages.saveCheckpoint({
      claim: claims[0]!,
      checkpoint: { artifactPublicId: 'artifact-exhausted-preserved' }
    })).resolves.toBe(true);
    await expect(stages.recoverExpired({
      expiredBefore: '2026-08-08T01:00:03.000Z',
      nextAttemptAt: '2026-08-08T01:00:03.000Z',
      limit: 10
    })).resolves.toBe(1);
    await expect(stages.claim({
      stageKinds: ['extraction'], owner: 'exhausted-worker-next', limit: 1,
      now: '2026-08-08T01:00:04.000Z',
      leaseExpiresAt: '2026-08-08T01:01:04.000Z'
    })).resolves.toEqual([]);
    const exhausted = await sql<Array<{
      state: string;
      safe_error_code: string | null;
      checkpoint: Record<string, unknown>;
      attempt_count: string;
    }>>`
      SELECT state, safe_error_code, checkpoint, attempt_count::text
      FROM focowiki.semantic_stage_work_items
      WHERE public_id = ${claims[0]!.publicId}
    `;
    expect(exhausted).toEqual([{
      state: 'failed',
      safe_error_code: 'semantic_stage_lease_expired',
      checkpoint: { artifactPublicId: 'artifact-exhausted-preserved' },
      attempt_count: '1'
    }]);
  });

  it('allows two extraction leases but blocks a third stage in the same knowledge base', async () => {
    const knowledgeBaseId = 'kb-semantic-running-lease';
    const operationPublicId = 'operation-semantic-running-lease';
    const generationPublicId = 'semantic-running-lease';
    await seedKnowledgeBase(knowledgeBaseId, [operationPublicId]);
    await generations.createCandidate({
      operationPublicId,
      candidatePublicId: generationPublicId,
      expectedPredecessorPublicId: null,
      target: target(knowledgeBaseId),
      contractFingerprintSha256: 'a'.repeat(64)
    });
    for (const suffix of ['a', 'b']) {
      const sourceFilePublicId = `file-running-lease-${suffix}`;
      const sourceRevisionPublicId = `revision-running-lease-${suffix}`;
      await seedSource(
        knowledgeBaseId,
        sourceFilePublicId,
        sourceRevisionPublicId
      );
      await stages.enqueue({
        items: planSemanticSourceStages({
          knowledgeBaseId,
          operationPublicId,
          semanticGenerationPublicId: generationPublicId,
          sourceFilePublicId,
          sourceRevisionPublicId,
          extractionContractVersion: 'extract-v1',
          embeddingConfigurationRevisionPublicId: 'embedding-revision',
          settingsSnapshot: { generationModelRevisionPublicId: 'model-v1' },
          dirtyCommunityPartitionKeys: [],
          includeValidation: false,
          maximumAttempts: 2
        }),
        enqueuedAt: '2027-08-08T00:10:00.000Z'
      });
    }

    const first = await stages.claim({
      stageKinds: ['extraction'], owner: 'running-lease-worker-a', limit: 2,
      now: '2027-08-08T00:10:01.000Z',
      leaseExpiresAt: '2027-08-08T00:11:01.000Z'
    });
    expect(first).toHaveLength(2);
    expect(new Set(first.map((claim) => claim.sourceFilePublicId)).size).toBe(2);
    const second = await stages.claim({
      stageKinds: ['extraction'], owner: 'running-lease-worker-b', limit: 2,
      now: '2027-08-08T00:10:02.000Z',
      leaseExpiresAt: '2027-08-08T00:11:02.000Z'
    });
    expect(second).toHaveLength(0);
    await expect(stages.claim({
      stageKinds: ['extraction', 'reconciliation'],
      owner: 'running-lease-worker-c', limit: 2,
      excludedKnowledgeBaseIds: ['kb-semantic-stage-a', 'kb-semantic-stage-b'],
      now: '2027-08-08T00:10:03.000Z',
      leaseExpiresAt: '2027-08-08T00:11:03.000Z'
    })).resolves.toEqual([]);
  });

  it('allows bounded same-knowledge-base leases within every source-local stage wave', async () => {
    const knowledgeBaseId = 'kb-semantic-embedding-leases';
    const operationPublicId = 'operation-semantic-embedding-leases';
    const generationPublicId = 'semantic-embedding-leases';
    await seedKnowledgeBase(knowledgeBaseId, [operationPublicId]);
    await generations.createCandidate({
      operationPublicId,
      candidatePublicId: generationPublicId,
      expectedPredecessorPublicId: null,
      target: target(knowledgeBaseId),
      contractFingerprintSha256: 'b'.repeat(64)
    });
    for (const suffix of ['a', 'b']) {
      const sourceFilePublicId = `file-embedding-lease-${suffix}`;
      const sourceRevisionPublicId = `revision-embedding-lease-${suffix}`;
      await seedSource(knowledgeBaseId, sourceFilePublicId, sourceRevisionPublicId);
      await stages.enqueue({
        items: planSemanticSourceStages({
          knowledgeBaseId,
          operationPublicId,
          semanticGenerationPublicId: generationPublicId,
          sourceFilePublicId,
          sourceRevisionPublicId,
          extractionContractVersion: 'extract-v1',
          embeddingConfigurationRevisionPublicId: 'embedding-revision',
          settingsSnapshot: { generationModelRevisionPublicId: 'model-v1' },
          dirtyCommunityPartitionKeys: [],
          includeValidation: false,
          maximumAttempts: 2
        }),
        enqueuedAt: '2027-08-08T00:20:00.000Z'
      });
    }
    const excludedKnowledgeBaseIds = (await sql<Array<{ public_id: string }>>`
      SELECT public_id
      FROM focowiki.knowledge_bases
      WHERE public_id <> ${knowledgeBaseId}
      ORDER BY public_id
    `).map((row) => row.public_id);
    await sql`
      UPDATE focowiki.semantic_stage_work_items
      SET state = 'completed', completed_at = '2027-08-08T00:20:01.000Z',
          next_attempt_at = '2027-08-08T00:20:01.000Z'
      WHERE knowledge_base_id = ${knowledgeBaseId}
        AND stage_kind = 'extraction'
    `;
    const reconciliationClaims = await stages.claim({
      stageKinds: ['reconciliation'], owner: 'reconciliation-lease-worker', limit: 2,
      maximumParallelStagesPerKnowledgeBase: 2,
      excludedKnowledgeBaseIds,
      now: '2027-08-08T00:20:01.100Z',
      leaseExpiresAt: '2027-08-08T00:21:01.100Z'
    });
    expect(reconciliationClaims).toHaveLength(2);
    await Promise.all(reconciliationClaims.map((claim) => stages.finish({
      claim, outcome: 'completed', safeCode: null,
      nextAttemptAt: '2027-08-08T00:20:01.200Z',
      completedAt: '2027-08-08T00:20:01.200Z'
    })));
    const communityClaims = await stages.claim({
      stageKinds: ['community'], owner: 'community-lease-worker', limit: 2,
      maximumParallelStagesPerKnowledgeBase: 2,
      excludedKnowledgeBaseIds,
      now: '2027-08-08T00:20:01.300Z',
      leaseExpiresAt: '2027-08-08T00:21:01.300Z'
    });
    expect(communityClaims).toHaveLength(2);
    await Promise.all(communityClaims.map((claim) => stages.finish({
      claim, outcome: 'completed', safeCode: null,
      nextAttemptAt: '2027-08-08T00:20:01.500Z',
      completedAt: '2027-08-08T00:20:01.500Z'
    })));
    await expect(sql<Array<{ stage_kind: string; state: string; work_items: number }>>`
      SELECT stage_kind, state, count(*)::integer AS work_items
      FROM focowiki.semantic_stage_work_items
      WHERE knowledge_base_id = ${knowledgeBaseId}
      GROUP BY stage_kind, state
      ORDER BY stage_kind, state
    `).resolves.toEqual([
      { stage_kind: 'community', state: 'completed', work_items: 2 },
      { stage_kind: 'embedding', state: 'queued', work_items: 2 },
      { stage_kind: 'extraction', state: 'completed', work_items: 2 },
      { stage_kind: 'publication', state: 'queued', work_items: 2 },
      { stage_kind: 'reconciliation', state: 'completed', work_items: 2 },
      { stage_kind: 'vector', state: 'queued', work_items: 2 }
    ]);

    const first = await stages.claim({
      stageKinds: ['embedding'], owner: 'embedding-lease-worker-a', limit: 2,
      maximumParallelStagesPerKnowledgeBase: 2,
      excludedKnowledgeBaseIds,
      now: '2027-08-08T00:20:02.000Z',
      leaseExpiresAt: '2027-08-08T00:21:02.000Z'
    });
    const second = await stages.claim({
      stageKinds: ['embedding'], owner: 'embedding-lease-worker-b', limit: 2,
      maximumParallelStagesPerKnowledgeBase: 2,
      excludedKnowledgeBaseIds,
      now: '2027-08-08T00:20:03.000Z',
      leaseExpiresAt: '2027-08-08T00:21:03.000Z'
    });

    expect(first).toHaveLength(2);
    expect(new Set(first.map((claim) => claim.sourceFilePublicId)).size).toBe(2);
    expect(second).toHaveLength(0);
    await expect(stages.claim({
      stageKinds: ['vector'], owner: 'embedding-lease-worker-c', limit: 1,
      maximumParallelStagesPerKnowledgeBase: 2,
      excludedKnowledgeBaseIds,
      now: '2027-08-08T00:20:04.000Z',
      leaseExpiresAt: '2027-08-08T00:21:04.000Z'
    })).resolves.toEqual([]);
    await Promise.all(first.map((claim) => stages.finish({
      claim, outcome: 'completed', safeCode: null,
      nextAttemptAt: '2027-08-08T00:20:04.100Z',
      completedAt: '2027-08-08T00:20:04.100Z'
    })));
    const vectorClaims = await stages.claim({
      stageKinds: ['vector'], owner: 'vector-lease-worker', limit: 2,
      maximumParallelStagesPerKnowledgeBase: 2,
      excludedKnowledgeBaseIds,
      now: '2027-08-08T00:20:04.200Z',
      leaseExpiresAt: '2027-08-08T00:21:04.200Z'
    });
    expect(vectorClaims).toHaveLength(2);
    await Promise.all(vectorClaims.map((claim) => stages.finish({
      claim, outcome: 'completed', safeCode: null,
      nextAttemptAt: '2027-08-08T00:20:04.300Z',
      completedAt: '2027-08-08T00:20:04.300Z'
    })));
    const publicationClaims = await stages.claim({
      stageKinds: ['publication'], owner: 'publication-handoff-worker', limit: 2,
      maximumParallelStagesPerKnowledgeBase: 2,
      excludedKnowledgeBaseIds,
      now: '2027-08-08T00:20:04.400Z',
      leaseExpiresAt: '2027-08-08T00:21:04.400Z'
    });
    expect(publicationClaims).toHaveLength(2);
  });

  it('finishes the earliest semantic stage wave before advancing another source', async () => {
    const knowledgeBaseId = 'kb-semantic-stage-wave';
    const operationA = 'operation-semantic-stage-wave-a';
    const operationB = 'operation-semantic-stage-wave-b';
    const generationPublicId = 'semantic-stage-wave';
    await seedKnowledgeBase(knowledgeBaseId, [operationA, operationB]);
    await generations.createCandidate({
      operationPublicId: operationA,
      candidatePublicId: generationPublicId,
      expectedPredecessorPublicId: null,
      target: target(knowledgeBaseId),
      contractFingerprintSha256: '7'.repeat(64)
    });
    for (const [operationPublicId, suffix] of [
      [operationA, 'a'],
      [operationB, 'b']
    ] as const) {
      const sourceFilePublicId = `file-semantic-stage-wave-${suffix}`;
      const sourceRevisionPublicId = `revision-semantic-stage-wave-${suffix}`;
      await seedSource(
        knowledgeBaseId,
        sourceFilePublicId,
        sourceRevisionPublicId
      );
      await stages.enqueue({
        items: planSemanticSourceStages({
          knowledgeBaseId,
          operationPublicId,
          semanticGenerationPublicId: generationPublicId,
          sourceFilePublicId,
          sourceRevisionPublicId,
          extractionContractVersion: 'extract-v1',
          embeddingConfigurationRevisionPublicId: 'embedding-revision',
          settingsSnapshot: { generationModelRevisionPublicId: 'model-v1' },
          dirtyCommunityPartitionKeys: [],
          includeValidation: false,
          maximumAttempts: 2
        }),
        enqueuedAt: '2027-08-08T00:30:00.000Z'
      });
    }
    await sql`
      UPDATE focowiki.semantic_stage_work_items
      SET state = 'completed', completed_at = '2027-08-08T00:30:01.000Z',
          next_attempt_at = '2027-08-08T00:30:01.000Z'
      WHERE operation_public_id = ${operationA}
        AND stage_kind = 'extraction'
    `;
    await sql`
      UPDATE focowiki.semantic_stage_work_items
      SET next_attempt_at = CASE
        WHEN operation_public_id = ${operationA}
          AND stage_kind = 'reconciliation'
          THEN '2027-08-08T00:30:01.000Z'::timestamptz
        WHEN operation_public_id = ${operationB}
          AND stage_kind = 'extraction'
          THEN '2027-08-08T00:30:02.000Z'::timestamptz
        ELSE next_attempt_at
      END
      WHERE knowledge_base_id = ${knowledgeBaseId}
    `;

    const claims = await stages.claim({
      stageKinds: ['extraction', 'reconciliation'],
      owner: 'semantic-stage-wave-worker',
      limit: 1,
      now: '2027-08-08T00:30:03.000Z',
      leaseExpiresAt: '2027-08-08T00:31:03.000Z'
    });

    expect(claims).toHaveLength(1);
    expect(claims[0]).toMatchObject({
      operationPublicId: operationB,
      stageKind: 'extraction'
    });
  });

  it('marks the current source failed when semantic stage retries are exhausted', async () => {
    const knowledgeBaseId = 'kb-semantic-stage-failed';
    const operationPublicId = 'operation-semantic-stage-failed';
    const semanticGenerationPublicId = 'semantic-stage-failed';
    const sourceFilePublicId = 'file-semantic-stage-failed';
    const sourceRevisionPublicId = 'revision-semantic-stage-failed';
    await seedKnowledgeBase(knowledgeBaseId, [operationPublicId]);
    await seedSource(knowledgeBaseId, sourceFilePublicId, sourceRevisionPublicId);
    await sql`
      UPDATE focowiki.source_files SET status = 'processing'
      WHERE knowledge_base_id = ${knowledgeBaseId}
        AND public_id = ${sourceFilePublicId}
    `;
    await generations.createCandidate({
      operationPublicId,
      candidatePublicId: semanticGenerationPublicId,
      expectedPredecessorPublicId: null,
      target: target(knowledgeBaseId),
      contractFingerprintSha256: '9'.repeat(64)
    });
    const plan = planSemanticSourceStages({
      knowledgeBaseId,
      operationPublicId,
      semanticGenerationPublicId,
      sourceFilePublicId,
      sourceRevisionPublicId,
      extractionContractVersion: 'extract-v1',
      embeddingConfigurationRevisionPublicId: 'embedding-revision',
      settingsSnapshot: { generationModelRevisionPublicId: 'model-v1' },
      dirtyCommunityPartitionKeys: [],
      includeValidation: false,
      maximumAttempts: 1
    });
    await stages.enqueue({ items: plan, enqueuedAt: '2026-08-08T02:00:00.000Z' });
    const claims = await stages.claim({
      stageKinds: ['extraction'], owner: 'failing-stage-worker', limit: 1,
      now: '2026-08-08T02:00:01.000Z',
      leaseExpiresAt: '2026-08-08T02:01:00.000Z'
    });
    expect(claims).toHaveLength(1);
    await expect(stages.finish({
      claim: claims[0]!,
      outcome: 'retry',
      safeCode: 'semantic_generation_model_unavailable',
      nextAttemptAt: '2026-08-08T02:00:02.000Z',
      completedAt: '2026-08-08T02:00:02.000Z'
    })).resolves.toBe(true);

    await expect(sql<Array<{ status: string; safe_error_code: string | null }>>`
      SELECT status, safe_error_code
      FROM focowiki.source_files
      WHERE knowledge_base_id = ${knowledgeBaseId}
        AND public_id = ${sourceFilePublicId}
    `).resolves.toEqual([{
      status: 'failed',
      safe_error_code: 'semantic_generation_model_unavailable'
    }]);
  });

  it('registers only owned incremental vector impacts before provider projection', async () => {
    await seedKnowledgeBase('kb-semantic-vector', ['operation-vector']);
    await seedSource('kb-semantic-vector', 'file-vector', 'revision-vector');
    await generations.createCandidate({
      operationPublicId: 'operation-vector',
      candidatePublicId: 'semantic-vector',
      expectedPredecessorPublicId: null,
      target: target('kb-semantic-vector'),
      contractFingerprintSha256: '6'.repeat(64)
    });
    await seedVectorArtifact({
      knowledgeBaseId: 'kb-semantic-vector',
      semanticGenerationPublicId: 'semantic-vector',
      operationPublicId: 'operation-vector',
      sourceFilePublicId: 'file-vector',
      sourceRevisionPublicId: 'revision-vector',
      ownerPublicId: 'entity-vector',
      artifactPublicId: 'artifact-vector'
    });
    const plan = planSemanticVectorProjection({
      indexPrefix: 'focowiki',
      knowledgeBaseId: 'kb-semantic-vector',
      semanticGenerationPublicId: 'semantic-vector',
      projectionContractPublicId: 'semantic-contract-semantic-vector',
      embeddingConfigurationRevisionPublicId: 'embedding-revision',
      dimension: 8,
      mappingFingerprintSha256: '7'.repeat(64),
      upserts: [{
        publicId: 'vector-document-main',
        ownerPublicId: 'entity-vector',
        family: 'entity',
        sourceFilePublicId: 'file-vector',
        sourceRevisionPublicId: 'revision-vector',
        artifactPublicId: 'artifact-vector',
        evidenceTargetPath: 'file-vector.md',
        sourceExcerpt: 'Source-grounded excerpt.',
        fileKind: 'page',
        okfStatus: null,
        okfTrustTier: null,
        okfStaleAfterEpochDay: null,
        vector: [1, 0, 0, 0, 0, 0, 0, 0]
      }],
      deletes: []
    });
    await expect(vectors.prepareImpacts({
      plan, preparedAt: '2027-08-08T00:00:00.000Z'
    })).resolves.toEqual({ prepared: 1, deleted: 0 });
    await expect(vectors.confirmImpacts({
      plan, confirmedAt: '2027-08-08T00:00:01.000Z'
    })).resolves.toBe(true);
    await expect(countRows(
      'semantic_vector_documents', 'kb-semantic-vector'
    )).resolves.toBe(1);
    const unowned = planSemanticVectorProjection({
      indexPrefix: 'focowiki',
      knowledgeBaseId: 'kb-semantic-vector',
      semanticGenerationPublicId: 'semantic-vector',
      projectionContractPublicId: 'semantic-contract-semantic-vector',
      embeddingConfigurationRevisionPublicId: 'embedding-revision',
      dimension: 8,
      mappingFingerprintSha256: '7'.repeat(64),
      upserts: [{
        ...plan.providerDocuments[0]!,
        publicId: 'vector-document-unowned',
        artifactPublicId: 'artifact-missing',
        sourceExcerpt: plan.providerDocuments[0]!.sourceExcerpt
          ?? 'Source-grounded excerpt.',
        fileKind: plan.providerDocuments[0]!.fileKind ?? 'page',
        okfStatus: plan.providerDocuments[0]!.okfStatus ?? null,
        okfTrustTier: plan.providerDocuments[0]!.okfTrustTier ?? null,
        okfStaleAfterEpochDay:
          plan.providerDocuments[0]!.okfStaleAfterEpochDay ?? null,
        vector: [1, 0, 0, 0, 0, 0, 0, 0]
      }],
      deletes: []
    });
    await expect(vectors.prepareImpacts({
      plan: unowned, preparedAt: '2027-08-08T00:00:02.000Z'
    })).rejects.toMatchObject({ code: 'artifact_ownership_invalid' });
    await expect(countRows(
      'semantic_vector_documents', 'kb-semantic-vector'
    )).resolves.toBe(1);
  });

  it('claims, pages, checkpoints, and supersedes one bounded community partition', async () => {
    await seedKnowledgeBase('kb-semantic-community', ['operation-community']);
    await seedSource('kb-semantic-community', 'file-community', 'revision-community');
    await generations.createCandidate({
      operationPublicId: 'operation-community',
      candidatePublicId: 'semantic-community',
      expectedPredecessorPublicId: null,
      target: target('kb-semantic-community'),
      contractFingerprintSha256: 'e'.repeat(64)
    });
    const desired = desiredFacts(
      'kb-semantic-community', 'semantic-community',
      'file-community', 'revision-community'
    );
    await facts.replaceSourceFacts(desired);
    const assignments = deriveEntityPartitionAssignments({
      entityPublicIds: desired.entities.map((entity) => entity.publicId),
      inputVersion: 'graph-input-v1'
    });
    await communityPartitions.upsertAssignments({
      knowledgeBaseId: 'kb-semantic-community',
      semanticGenerationPublicId: 'semantic-community',
      assignments
    });
    const selected = assignments[0]!;
    const partitions = deriveDirtyCommunityPartitions({
      knowledgeBaseId: 'kb-semantic-community',
      semanticGenerationPublicId: 'semantic-community',
      inputVersion: 'graph-input-v1',
      reasonKind: 'entity_changed',
      changedEntityPublicIds: [selected.entityPublicId],
      changedRelationships: [],
      priorMembershipPartitionKeys: [],
      boundaryNeighborEntityPublicIds: [],
      maximumBoundaryNeighbors: 0
    }).filter((partition) => partition.partitionKey === selected.partitionKey);
    await communityPartitions.enqueueDirty({
      knowledgeBaseId: 'kb-semantic-community',
      semanticGenerationPublicId: 'semantic-community',
      partitions
    });
    const claim = await communityPartitions.claimNext({
      workerId: 'community-worker-1',
      knowledgeBaseId: 'kb-semantic-community',
      semanticGenerationPublicId: 'semantic-community',
      now: '2027-08-08T00:00:00.000Z',
      leaseExpiresAt: '2027-08-08T00:01:00.000Z'
    });
    expect(claim).toMatchObject({
      partitionKey: selected.partitionKey,
      attemptCount: 1,
      leaseOwner: 'community-worker-1'
    });
    const page = await communityPartitions.loadPage({
      claim: claim!,
      maximumEntities: 1,
      maximumRelationships: 2,
      maximumBoundaryRelationships: 2
    });
    expect(page.entityPublicIds).toEqual([selected.entityPublicId]);
    await expect(communityPartitions.isCurrent({ claim: claim! })).resolves.toBe(true);
    const communityOutput = [{
      communityPublicId: 'community-output-main',
      level: 0,
      entityPublicIds: [selected.entityPublicId],
      summary: 'A bounded community summary.',
      checksumSha256: 'f'.repeat(64)
    }];
    await expect(communityPartitions.replacePartition({
      claim: claim!, boundaryVersion: 'boundary-v1', outputs: communityOutput
    })).resolves.toBe('created');
    await expect(communityPartitions.replacePartition({
      claim: claim!, boundaryVersion: 'boundary-v1', outputs: communityOutput
    })).resolves.toBe('reused');
    await expect(countRows(
      'semantic_community_reports', 'kb-semantic-community'
    )).resolves.toBe(1);
    await expect(communityPartitions.saveCheckpoint({
      claim: claim!,
      entityCursor: page.nextEntityCursor,
      relationshipTruncated: page.relationshipTruncated,
      outcome: 'continue',
      safeCode: null,
      nextAttemptAt: '2027-08-08T00:00:01.000Z'
    })).resolves.toBe(true);
    const retry = await communityPartitions.claimNext({
      workerId: 'community-worker-2',
      knowledgeBaseId: 'kb-semantic-community',
      semanticGenerationPublicId: 'semantic-community',
      now: '2027-08-08T00:00:02.000Z',
      leaseExpiresAt: '2027-08-08T00:01:02.000Z'
    });
    expect(retry).toMatchObject({ attemptCount: 2, leaseOwner: 'community-worker-2' });
    await sql`UPDATE focowiki.semantic_generations SET state = 'cancelled' WHERE public_id = 'semantic-community'`;
    await expect(communityPartitions.isCurrent({ claim: retry! })).resolves.toBe(false);
    await expect(communityPartitions.saveCheckpoint({
      claim: retry!, entityCursor: null, relationshipTruncated: false,
      outcome: 'superseded', safeCode: null,
      nextAttemptAt: '2027-08-08T00:00:03.000Z'
    })).resolves.toBe(true);
  });

  it('hides failed-cleanup candidates from active reads', async () => {
    await seedKnowledgeBase('kb-semantic-cleanup', ['operation-cleanup']);
    const candidate = await generations.createCandidate({
      operationPublicId: 'operation-cleanup',
      candidatePublicId: 'semantic-cleanup',
      expectedPredecessorPublicId: null,
      target: target('kb-semantic-cleanup'),
      contractFingerprintSha256: '5'.repeat(64)
    });
    await sql`UPDATE focowiki.semantic_generations SET state = 'failed' WHERE public_id = 'semantic-cleanup'`;
    await expect(generations.markCleanupFailed({
      knowledgeBaseId: 'kb-semantic-cleanup',
      candidatePublicId: 'semantic-cleanup',
      expectedRevision: candidate.revision
    })).resolves.toBe(true);
    await expect(generations.getActive('kb-semantic-cleanup')).resolves.toBeNull();
  });

  it('enforces cross-scope reads and hard-delete cascade', async () => {
    await seedKnowledgeBase('kb-semantic-delete', ['operation-delete']);
    await seedSource('kb-semantic-delete', 'file-delete', 'revision-delete');
    const candidate = await generations.createCandidate({
      operationPublicId: 'operation-delete',
      candidatePublicId: 'semantic-delete',
      expectedPredecessorPublicId: null,
      target: target('kb-semantic-delete'),
      contractFingerprintSha256: '6'.repeat(64)
    });
    await facts.replaceSourceFacts(desiredFacts('kb-semantic-delete', 'semantic-delete', 'file-delete', 'revision-delete'));
    await sql`UPDATE focowiki.semantic_generations SET state = 'ready', revision = revision + 1 WHERE public_id = 'semantic-delete'`;
    await generations.activateCandidate({
      knowledgeBaseId: 'kb-semantic-delete',
      candidatePublicId: 'semantic-delete',
      expectedPredecessorPublicId: null,
      expectedCandidateRevision: candidate.revision + 1,
      activatedAt: '2026-08-08T00:00:00.000Z'
    });
    await expect(facts.listActiveEntities({ knowledgeBaseId: 'kb-semantic-main', limit: 10, cursor: null }))
      .resolves.toMatchObject({ items: [
        expect.objectContaining({ publicId: 'entity-main-a' }),
        expect.objectContaining({ publicId: 'entity-main-b' })
      ] });
    await sql`DELETE FROM focowiki.knowledge_bases WHERE public_id = 'kb-semantic-delete'`;
    await expect(countRows('semantic_generations', 'kb-semantic-delete')).resolves.toBe(0);
    await expect(countRows('semantic_entities', 'kb-semantic-delete')).resolves.toBe(0);
    await expect(generations.getActive('kb-semantic-main')).resolves.toMatchObject({ publicId: 'semantic-main' });
  });

  it('pages provider vectors before purging one source semantic scope', async () => {
    await seedKnowledgeBase('kb-semantic-source-delete', ['operation-source-delete']);
    await seedSource(
      'kb-semantic-source-delete',
      'file-source-delete',
      'revision-source-delete'
    );
    await seedSource(
      'kb-semantic-source-delete',
      'file-source-survivor',
      'revision-source-survivor'
    );
    const sourceDeleteCandidate = await generations.createCandidate({
      operationPublicId: 'operation-source-delete',
      candidatePublicId: 'semantic-source-delete',
      expectedPredecessorPublicId: null,
      target: target('kb-semantic-source-delete'),
      contractFingerprintSha256: '8'.repeat(64)
    });
    await facts.replaceSourceFacts(desiredFacts(
      'kb-semantic-source-delete',
      'semantic-source-delete',
      'file-source-delete',
      'revision-source-delete'
    ));
    const deletionAssignments = deriveEntityPartitionAssignments({
      entityPublicIds: ['entity-source-delete-a'],
      inputVersion: 'source-delete-input-v1'
    });
    await communityPartitions.upsertAssignments({
      knowledgeBaseId: 'kb-semantic-source-delete',
      semanticGenerationPublicId: 'semantic-source-delete',
      assignments: deletionAssignments
    });
    const deletionPartitions = deriveDirtyCommunityPartitions({
      knowledgeBaseId: 'kb-semantic-source-delete',
      semanticGenerationPublicId: 'semantic-source-delete',
      inputVersion: 'source-delete-input-v1',
      reasonKind: 'entity_changed',
      changedEntityPublicIds: ['entity-source-delete-a'],
      changedRelationships: [],
      priorMembershipPartitionKeys: [],
      boundaryNeighborEntityPublicIds: [],
      maximumBoundaryNeighbors: 0
    });
    await communityPartitions.enqueueDirty({
      knowledgeBaseId: 'kb-semantic-source-delete',
      semanticGenerationPublicId: 'semantic-source-delete',
      partitions: deletionPartitions
    });
    const deletionCommunityClaim = await communityPartitions.claimNext({
      workerId: 'community-source-delete-worker',
      knowledgeBaseId: 'kb-semantic-source-delete',
      semanticGenerationPublicId: 'semantic-source-delete',
      now: '2027-08-08T00:00:00.000Z',
      leaseExpiresAt: '2027-08-08T00:01:00.000Z'
    });
    await communityPartitions.replacePartition({
      claim: deletionCommunityClaim!,
      boundaryVersion: 'source-delete-boundary-v1',
      outputs: [{
        communityPublicId: 'community-source-delete',
        level: 0,
        entityPublicIds: ['entity-source-delete-a'],
        summary: 'A community invalidated by source deletion.',
        checksumSha256: '9'.repeat(64)
      }]
    });
    await sql`
      UPDATE focowiki.semantic_generations
      SET state = 'ready', revision = revision + 1
      WHERE public_id = 'semantic-source-delete'
    `;
    await generations.activateCandidate({
      knowledgeBaseId: 'kb-semantic-source-delete',
      candidatePublicId: 'semantic-source-delete',
      expectedPredecessorPublicId: null,
      expectedCandidateRevision: sourceDeleteCandidate.revision + 1,
      activatedAt: '2027-08-08T00:00:00.000Z'
    });
    await seedVectorArtifact({
      knowledgeBaseId: 'kb-semantic-source-delete',
      semanticGenerationPublicId: 'semantic-source-delete',
      operationPublicId: 'operation-source-delete',
      sourceFilePublicId: 'file-source-delete',
      sourceRevisionPublicId: 'revision-source-delete',
      ownerPublicId: 'entity-source-delete-a',
      artifactPublicId: 'artifact-source-delete'
    });
    await seedVectorArtifact({
      knowledgeBaseId: 'kb-semantic-source-delete',
      semanticGenerationPublicId: 'semantic-source-delete',
      operationPublicId: 'operation-source-delete',
      sourceFilePublicId: 'file-source-survivor',
      sourceRevisionPublicId: 'revision-source-survivor',
      ownerPublicId: 'community-source-delete',
      artifactPublicId: 'artifact-community-source-delete',
      family: 'community'
    });
    const plan = planSemanticVectorProjection({
      indexPrefix: 'focowiki',
      knowledgeBaseId: 'kb-semantic-source-delete',
      semanticGenerationPublicId: 'semantic-source-delete',
      projectionContractPublicId: 'semantic-contract-semantic-source-delete',
      embeddingConfigurationRevisionPublicId: 'embedding-revision',
      dimension: 8,
      mappingFingerprintSha256: '7'.repeat(64),
      upserts: [{
        publicId: 'vector-source-delete',
        ownerPublicId: 'entity-source-delete-a',
        family: 'entity',
        sourceFilePublicId: 'file-source-delete',
        sourceRevisionPublicId: 'revision-source-delete',
        artifactPublicId: 'artifact-source-delete',
        evidenceTargetPath: 'file-source-delete.md',
        sourceExcerpt: 'Source-grounded excerpt.',
        fileKind: 'page',
        okfStatus: null,
        okfTrustTier: null,
        okfStaleAfterEpochDay: null,
        vector: [1, 0, 0, 0, 0, 0, 0, 0]
      }],
      deletes: []
    });
    await vectors.prepareImpacts({
      plan,
      preparedAt: '2027-08-08T00:00:00.000Z'
    });
    await vectors.confirmImpacts({
      plan,
      confirmedAt: '2027-08-08T00:00:01.000Z'
    });
    const communityPlan = planSemanticVectorProjection({
      indexPrefix: 'focowiki',
      knowledgeBaseId: 'kb-semantic-source-delete',
      semanticGenerationPublicId: 'semantic-source-delete',
      projectionContractPublicId: 'semantic-contract-semantic-source-delete',
      embeddingConfigurationRevisionPublicId: 'embedding-revision',
      dimension: 8,
      mappingFingerprintSha256: '7'.repeat(64),
      upserts: [{
        publicId: 'vector-community-source-delete',
        ownerPublicId: 'community-source-delete',
        family: 'community',
        sourceFilePublicId: 'file-source-survivor',
        sourceRevisionPublicId: 'revision-source-survivor',
        artifactPublicId: 'artifact-community-source-delete',
        evidenceTargetPath: 'file-source-survivor.md',
        sourceExcerpt: 'Source-grounded excerpt.',
        fileKind: 'page',
        okfStatus: null,
        okfTrustTier: null,
        okfStaleAfterEpochDay: null,
        vector: [1, 0, 0, 0, 0, 0, 0, 0]
      }],
      deletes: []
    });
    await vectors.prepareImpacts({
      plan: communityPlan,
      preparedAt: '2027-08-08T00:00:00.000Z'
    });
    await vectors.confirmImpacts({
      plan: communityPlan,
      confirmedAt: '2027-08-08T00:00:01.000Z'
    });
    const requestedVectorHits = [plan, communityPlan].flatMap((value) =>
      value.providerDocuments.map((document) => ({
        documentId: document.id,
        ownerPublicId: document.ownerPublicId,
        family: document.family,
        sourceFilePublicId: document.sourceFilePublicId,
        sourceRevisionPublicId: document.sourceRevisionPublicId,
        evidenceTargetPath: document.evidenceTargetPath
      })));
    await expect(activeVectorHits.resolveActive({
      knowledgeBaseId: 'kb-semantic-source-delete',
      semanticGenerationPublicId: 'semantic-source-delete',
      documents: requestedVectorHits,
      limit: requestedVectorHits.length
    })).resolves.toEqual(['vector-source-delete']);

    await expect(deletions.listSourceVectorPage({
      knowledgeBaseId: 'kb-semantic-source-delete',
      sourceFilePublicIds: ['file-source-delete'],
      cursor: null,
      limit: 10
    })).resolves.toMatchObject({
      items: [{
        semanticGenerationPublicId: 'semantic-source-delete',
        searchProviderKind: 'opensearch',
        documentIds: [
          'vector-community-source-delete',
          'vector-source-delete'
        ]
      }],
      nextCursor: null
    });
    await expect(deletions.purgeSourceState({
      knowledgeBaseId: 'kb-semantic-source-delete',
      sourceFilePublicIds: ['file-source-delete'],
      deletedAt: '2027-08-08T00:00:02.000Z'
    })).resolves.toBeUndefined();
    await expect(countRows(
      'semantic_vector_documents', 'kb-semantic-source-delete'
    )).resolves.toBe(0);
    await expect(countRows(
      'semantic_entity_observations', 'kb-semantic-source-delete'
    )).resolves.toBe(0);
    await expect(countRows(
      'semantic_embedding_artifact_refs', 'kb-semantic-source-delete'
    )).resolves.toBe(0);
    await expect(countRows(
      'semantic_entities', 'kb-semantic-source-delete'
    )).resolves.toBeGreaterThan(0);
    await expect(countRows(
      'semantic_communities', 'kb-semantic-source-delete'
    )).resolves.toBe(0);
    await expect(communityPartitions.isCurrent({
      claim: deletionCommunityClaim!
    })).resolves.toBe(false);
    await expect(sql<Array<{ state: string; safe_error_code: string | null }>>`
      SELECT state, safe_error_code
      FROM focowiki.semantic_dirty_partitions
      WHERE semantic_generation_public_id = 'semantic-source-delete'
    `).resolves.toEqual([{
      state: 'superseded',
      safe_error_code: 'semantic_partition_superseded'
    }]);
    await expect(activeVectorHits.resolveActive({
      knowledgeBaseId: 'kb-semantic-source-delete',
      semanticGenerationPublicId: 'semantic-source-delete',
      documents: requestedVectorHits,
      limit: requestedVectorHits.length
    })).resolves.toEqual([]);
    await expect(sql<Array<{ state: string }>>`
      SELECT state FROM focowiki.embedding_artifacts
      WHERE public_id = 'artifact-source-delete'
    `).resolves.toEqual([{ state: 'orphaned' }]);
  });

  async function seedEmbeddingConfiguration() {
    await sql`
      INSERT INTO focowiki.model_configs (
        public_id, provider, model, secret_reference, config,
        enabled, revision, created_at, updated_at
      ) VALUES (
        'model-config-test', 'openai-compatible', 'test-generation',
        'runtime/model-config-test', '{}'::jsonb, true, 1,
        '2026-08-08T00:00:00.000Z', '2026-08-08T00:00:00.000Z'
      )
    `;
    await sql`INSERT INTO focowiki.embedding_configurations (public_id, display_name, lifecycle_status, revision) VALUES ('embedding-config', 'Test embedding', 'active', 1)`;
    await sql`
      INSERT INTO focowiki.embedding_configuration_revisions (
        public_id, configuration_public_id, revision_number, authentication_mode,
        base_url, encrypted_api_key, model_name, requested_dimension,
        resolved_dimension, normalization, maximum_input_tokens, batch_size,
        timeout_ms, retry_count, minimum_interval_ms, concurrency,
        maximum_response_bytes, minimum_vector_relevance,
        vector_producing_revision_public_id, validation_status,
        validation_fingerprint_sha256, validated_at
      ) VALUES (
        'embedding-revision', 'embedding-config', 1, 'none',
        'http://127.0.0.1:8080/v1', NULL, 'test-embedding', 8, 8, 'l2',
        8192, 16, 5000, 1, 0, 2, 1048576, 0.7,
        'embedding-revision', 'valid',
        ${'2'.repeat(64)}, '2026-08-08T00:00:00.000Z'
      )
    `;
    await sql`UPDATE focowiki.embedding_configurations SET active_revision_public_id = 'embedding-revision' WHERE public_id = 'embedding-config'`;
  }

  async function seedKnowledgeBase(knowledgeBaseId: string, operationPublicIds: readonly string[]) {
    await sql`INSERT INTO focowiki.knowledge_bases (public_id, name, revision) VALUES (${knowledgeBaseId}, ${knowledgeBaseId}, 1)`;
    for (const operationPublicId of operationPublicIds) {
      await sql`INSERT INTO focowiki.operations (public_id, knowledge_base_id, operation_kind, state) VALUES (${operationPublicId}, ${knowledgeBaseId}, 'mutation', 'processing')`;
    }
  }

  async function seedSource(knowledgeBaseId: string, sourceFilePublicId: string, sourceRevisionPublicId: string) {
    const objectId = 'source-object-' + sourceRevisionPublicId;
    await sql`
      INSERT INTO focowiki.object_registrations (
        object_id, storage_key, checksum_sha256, byte_count, content_type,
        object_format, state, write_attempt_public_id, verified_at
      ) VALUES (
        ${objectId}, ${'sources/' + sourceRevisionPublicId}, ${'1'.repeat(64)},
        10, 'text/markdown', 'source-markdown-v1', 'verified',
        ${'write-' + sourceRevisionPublicId}, '2026-08-08T00:00:00.000Z'
      )
    `;
    await sql`INSERT INTO focowiki.source_files (public_id, knowledge_base_id, logical_path, normalized_path, title, status, revision) VALUES (${sourceFilePublicId}, ${knowledgeBaseId}, ${sourceFilePublicId + '.md'}, ${sourceFilePublicId + '.md'}, ${sourceFilePublicId}, 'ready', 1)`;
    await sql`INSERT INTO focowiki.source_revisions (public_id, knowledge_base_id, source_file_public_id, object_id, checksum_sha256, byte_count, content_type, revision_role) VALUES (${sourceRevisionPublicId}, ${knowledgeBaseId}, ${sourceFilePublicId}, ${objectId}, ${'1'.repeat(64)}, 10, 'text/markdown', 'current')`;
    await sql`INSERT INTO focowiki.source_file_current_revisions (knowledge_base_id, source_file_public_id, source_revision_public_id, revision) VALUES (${knowledgeBaseId}, ${sourceFilePublicId}, ${sourceRevisionPublicId}, 1)`;
  }

  async function seedVectorArtifact(input: {
    knowledgeBaseId: string;
    semanticGenerationPublicId: string;
    operationPublicId: string;
    sourceFilePublicId: string;
    sourceRevisionPublicId: string;
    ownerPublicId: string;
    artifactPublicId: string;
    family?: 'content' | 'entity' | 'relationship' | 'community';
  }) {
    const family = input.family ?? 'entity';
    const objectId = 'object-' + input.artifactPublicId;
    await sql`
      INSERT INTO focowiki.object_registrations (
        object_id, storage_key, checksum_sha256, byte_count, content_type,
        object_format, state, write_attempt_public_id, verified_at
      ) VALUES (
        ${objectId}, ${'semantic/' + input.artifactPublicId}, ${'3'.repeat(64)},
        128, 'application/octet-stream', 'semantic-vector-v1', 'verified',
        ${'write-' + input.artifactPublicId}, '2027-08-08T00:00:00.000Z'
      )
    `;
    await sql`
      INSERT INTO focowiki.embedding_artifacts (
        public_id, knowledge_base_id, object_id, owner_kind, owner_public_id,
        source_revision_public_id, canonical_input_sha256, input_kind,
        embedding_configuration_revision_public_id, normalization, dimension,
        artifact_schema_version, vector_checksum_sha256, byte_count, state
      ) VALUES (
        ${input.artifactPublicId}, ${input.knowledgeBaseId}, ${objectId},
        ${family}, ${input.ownerPublicId}, ${input.sourceRevisionPublicId},
        ${'4'.repeat(64)}, ${family}, 'embedding-revision', 'l2', 8,
        'artifact-v1', ${'5'.repeat(64)}, 128, 'verified'
      )
    `;
    await sql`
      INSERT INTO focowiki.embedding_artifact_owners (
        knowledge_base_id, artifact_public_id, semantic_generation_public_id,
        operation_public_id, source_revision_public_id, owner_kind,
        owner_public_id, retention_kind
      ) VALUES (
        ${input.knowledgeBaseId}, ${input.artifactPublicId},
        ${input.semanticGenerationPublicId}, ${input.operationPublicId},
        ${input.sourceRevisionPublicId}, ${family}, ${input.ownerPublicId}, 'candidate'
      )
    `;
    await sql`
      INSERT INTO focowiki.semantic_embedding_artifact_refs (
        knowledge_base_id, semantic_generation_public_id, artifact_public_id,
        semantic_owner_kind, semantic_owner_public_id, source_file_public_id,
        source_excerpt
      ) VALUES (
        ${input.knowledgeBaseId}, ${input.semanticGenerationPublicId},
        ${input.artifactPublicId}, ${family}, ${input.ownerPublicId},
        ${input.sourceFilePublicId}, ${'Grounded source excerpt for ' + family}
      )
    `;
  }

  async function countRows(tableName: string, knowledgeBaseId: string): Promise<number> {
    if (!/^[a-z_]+$/u.test(tableName)) throw new Error('Unsafe table name');
    const rows = await sql.unsafe<Array<{ count: string }>>(
      'SELECT count(*) AS count FROM focowiki.' + tableName + ' WHERE knowledge_base_id = $1',
      [knowledgeBaseId]
    );
    return Number(rows[0]?.count ?? 0);
  }

  async function completeStages(
    operationPublicId: string,
    stageKinds: readonly string[]
  ): Promise<void> {
    await sql`
      UPDATE focowiki.semantic_stage_work_items
      SET state = 'completed', completed_at = now(), updated_at = now()
      WHERE operation_public_id = ${operationPublicId}
        AND stage_kind = ANY(${stageKinds})
    `;
  }

  async function readSharedPresentation() {
    const [entity] = await sql<Array<{ description: string | null }>>`
      SELECT description
      FROM focowiki.semantic_entities
      WHERE semantic_generation_public_id = 'semantic-shared'
        AND public_id = 'entity-shared-a'
    `;
    const [relationship] = await sql<Array<{ description: string | null }>>`
      SELECT description
      FROM focowiki.semantic_relationships
      WHERE semantic_generation_public_id = 'semantic-shared'
        AND public_id = 'relationship-shared'
    `;
    const aliases = await sql<Array<{ display_alias: string }>>`
      SELECT display_alias
      FROM focowiki.semantic_entity_aliases
      WHERE semantic_generation_public_id = 'semantic-shared'
        AND entity_public_id = 'entity-shared-a'
      ORDER BY normalized_alias COLLATE "C"
    `;
    return {
      aliases: aliases.map((row) => row.display_alias),
      entityDescription: entity?.description ?? null,
      relationshipDescription: relationship?.description ?? null,
      entityObservationCount: await countRows(
        'semantic_entity_observations', 'kb-semantic-shared'
      ),
      relationshipObservationCount: await countRows(
        'semantic_relationship_observations', 'kb-semantic-shared'
      )
    };
  }
});

function target(knowledgeBaseId: string): SemanticMaintenanceTarget {
  return {
    knowledgeBaseId,
    generationModelConfigurationPublicId: 'model-config-test',
    generationModelConfigurationRevision: 1,
    extractionContractVersion: 'extract-v1',
    graphSchemaVersion: 'graph-v1',
    promptContractVersion: 'prompt-v1',
    embeddingConfigurationRevisionPublicId: 'embedding-revision',
    embeddingQueryPolicyRevisionPublicId: 'embedding-revision',
    minimumVectorRelevance: 0.7,
    resolvedDimension: 8,
    normalization: 'l2',
    artifactSchemaVersion: 'artifact-v1',
    vectorSchemaVersion: 'vector-v1',
    searchProviderKind: 'opensearch',
    mappingFingerprintSha256: '7'.repeat(64)
  };
}

function extractionManifest() {
  return {
    extractionContractVersion: 'extract-v1',
    canonicalInputSha256: 'e'.repeat(64),
    skeletonPolicyVersion: 'semantic-skeleton-policy-v2',
    skeletonSelected: true,
    sourceChunkCount: 1,
    selectedChunkCount: 1,
    selectionReasons: ['stable_sample'],
    selectionDecisionSha256: 'f'.repeat(64)
  };
}

function desiredFacts(knowledgeBaseId: string, semanticGenerationPublicId: string, sourceFilePublicId: string, sourceRevisionPublicId: string): SemanticDesiredFactSet {
  const suffix = sourceFilePublicId.replace('file-', '');
  return {
    knowledgeBaseId, semanticGenerationPublicId, sourceFilePublicId, sourceRevisionPublicId,
    entities: ['a', 'b'].map((part) => ({
      publicId: 'entity-' + suffix + '-' + part,
      canonicalKey: 'concept:' + suffix + ':' + part,
      kind: 'concept', label: suffix + ' ' + part.toUpperCase(), description: null,
      aliases: part === 'a' ? [suffix[0]!.toUpperCase() + suffix.slice(1) + ' A'] : [],
      extractionContractVersion: 'extract-v1', confidence: 1,
      provenance: 'deterministic' as const, revision: 1
    })),
    evidence: [{
      publicId: 'evidence-' + suffix, sourceFilePublicId, sourceRevisionPublicId,
      logicalPath: 'pages/' + sourceFilePublicId + '.md', startOffset: 0,
      endOffset: 4, excerptChecksumSha256: '8'.repeat(64),
      extractionContractVersion: 'extract-v1'
    }],
    mentions: [{
      publicId: 'mention-' + suffix, entityPublicId: 'entity-' + suffix + '-a',
      evidencePublicId: 'evidence-' + suffix, sourceFilePublicId,
      sourceRevisionPublicId, text: suffix + ' A', confidence: 1
    }],
    relationships: [{
      publicId: 'relationship-' + suffix,
      fromEntityPublicId: 'entity-' + suffix + '-a',
      toEntityPublicId: 'entity-' + suffix + '-b', kind: 'related_to',
      description: null, evidencePublicIds: ['evidence-' + suffix],
      confidence: 1, provenance: 'deterministic', revision: 1
    }],
    communities: [], communityReports: []
  };
}

function presentationFacts(input: {
  knowledgeBaseId?: string;
  semanticGenerationPublicId?: string;
  sourceFilePublicId: string;
  sourceRevisionPublicId: string;
  mentionedEntityPublicId: 'entity-presentation-from' | 'entity-presentation-to';
  evidenceSuffix: 'a' | 'b';
  labelPrefix?: string;
}): SemanticDesiredFactSet {
  const evidencePublicId = 'evidence-presentation-' + input.evidenceSuffix;
  const labelPrefix = input.labelPrefix ?? '';
  return {
    knowledgeBaseId: input.knowledgeBaseId ?? 'kb-semantic-presentation',
    semanticGenerationPublicId:
      input.semanticGenerationPublicId ?? 'semantic-presentation',
    sourceFilePublicId: input.sourceFilePublicId,
    sourceRevisionPublicId: input.sourceRevisionPublicId,
    entities: [{
      publicId: 'entity-presentation-from',
      canonicalKey: 'component:input-service',
      kind: 'component',
      label: labelPrefix + 'Input service',
      description: 'Receives source records.',
      aliases: [],
      extractionContractVersion: 'extract-v1',
      confidence: 0.95,
      provenance: 'model',
      revision: 1
    }, {
      publicId: 'entity-presentation-to',
      canonicalKey: 'component:output-service',
      kind: 'component',
      label: labelPrefix + 'Output service',
      description: 'Publishes processed records.',
      aliases: [],
      extractionContractVersion: 'extract-v1',
      confidence: 0.93,
      provenance: 'model',
      revision: 1
    }],
    evidence: [{
      publicId: evidencePublicId,
      sourceFilePublicId: input.sourceFilePublicId,
      sourceRevisionPublicId: input.sourceRevisionPublicId,
      logicalPath: input.sourceFilePublicId + '.md',
      startOffset: 0,
      endOffset: 32,
      excerptChecksumSha256: input.evidenceSuffix.repeat(64),
      extractionContractVersion: 'extract-v1'
    }],
    mentions: [{
      publicId: 'mention-presentation-' + input.evidenceSuffix,
      entityPublicId: input.mentionedEntityPublicId,
      evidencePublicId,
      sourceFilePublicId: input.sourceFilePublicId,
      sourceRevisionPublicId: input.sourceRevisionPublicId,
      text: input.mentionedEntityPublicId === 'entity-presentation-from'
        ? labelPrefix + 'Input service'
        : labelPrefix + 'Output service',
      confidence: 0.9
    }],
    relationships: [{
      publicId: 'relationship-presentation',
      fromEntityPublicId: 'entity-presentation-from',
      toEntityPublicId: 'entity-presentation-to',
      kind: 'feeds',
      description: 'Input service feeds output service.',
      evidencePublicIds: [evidencePublicId],
      confidence: 0.9,
      provenance: 'model',
      revision: 1
    }],
    communities: [],
    communityReports: []
  };
}

function sharedDesiredFacts(input: {
  sourceFilePublicId: string;
  sourceRevisionPublicId: string;
  alias: string;
  entityDescription: string;
  relationshipDescription: string;
}): SemanticDesiredFactSet {
  const suffix = input.sourceFilePublicId.endsWith('-a') ? 'a' : 'b';
  const evidencePublicId = 'evidence-shared-' + suffix;
  return {
    knowledgeBaseId: 'kb-semantic-shared',
    semanticGenerationPublicId: 'semantic-shared',
    sourceFilePublicId: input.sourceFilePublicId,
    sourceRevisionPublicId: input.sourceRevisionPublicId,
    entities: ['a', 'b'].map((part) => ({
      publicId: 'entity-shared-' + part,
      canonicalKey: 'concept:shared:' + part,
      kind: 'concept',
      label: 'Shared ' + part.toUpperCase(),
      description: part === 'a' ? input.entityDescription : null,
      aliases: part === 'a' ? [input.alias] : [],
      extractionContractVersion: 'extract-v1',
      confidence: 0,
      provenance: 'model' as const,
      revision: 1
    })),
    evidence: [{
      publicId: evidencePublicId,
      sourceFilePublicId: input.sourceFilePublicId,
      sourceRevisionPublicId: input.sourceRevisionPublicId,
      logicalPath: 'pages/' + input.sourceFilePublicId + '.md',
      startOffset: 0,
      endOffset: 6,
      excerptChecksumSha256: suffix.repeat(64),
      extractionContractVersion: 'extract-v1'
    }],
    mentions: [{
      publicId: 'mention-shared-' + suffix,
      entityPublicId: 'entity-shared-a',
      evidencePublicId,
      sourceFilePublicId: input.sourceFilePublicId,
      sourceRevisionPublicId: input.sourceRevisionPublicId,
      text: 'Shared A',
      confidence: 0
    }],
    relationships: [{
      publicId: 'relationship-shared',
      fromEntityPublicId: 'entity-shared-a',
      toEntityPublicId: 'entity-shared-b',
      kind: 'related_to',
      description: input.relationshipDescription,
      evidencePublicIds: [evidencePublicId],
      confidence: 0,
      provenance: 'model',
      revision: 1
    }],
    communities: [],
    communityReports: []
  };
}

function databaseConnectionUrl(connectionUrl: string, databaseName: string): string {
  const url = new URL(connectionUrl);
  url.pathname = '/' + databaseName;
  return url.toString();
}

function quoteIdentifier(value: string): string {
  const quote = String.fromCharCode(34);
  return quote + value.replaceAll(quote, quote + quote) + quote;
}
