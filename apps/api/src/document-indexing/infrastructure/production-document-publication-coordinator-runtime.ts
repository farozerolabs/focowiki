import type { DatabaseClient } from "../../db/client.js";
import { createDocumentPublicationActivationCoordinator } from
  "../application/document-publication-activation-coordinator.js";
import { planDocumentPublicationActivationReservations } from
  "../application/document-publication-activation.js";
import { planDocumentPublicationGeneration } from
  "../application/document-publication-planner.js";
import { createPostgresDocumentPublicationActivation } from
  "./postgres-document-publication-activation.js";
import { createPostgresDocumentPublicationCoordinator } from
  "./postgres-document-publication-coordinator.js";
import { createPostgresDocumentPublicationRecovery } from
  "./postgres-document-publication-recovery.js";
import { createPostgresDocumentPublicationValidator } from
  "./postgres-document-publication-validator.js";
import { waitForDocumentWork } from
  "./production-document-fixed-runtime-support.js";
import type { DocumentWorkerObservability } from
  "../application/document-worker-observability.js";
import { readGenerationFactDeltas } from
  "./production-document-publication-fact-deltas.js";
import { DOCUMENT_PUBLICATION_RENDERER_CONTRACT_VERSION } from
  "../application/document-publication-renderer-contract.js";

const CONTRIBUTOR_CAP = 256;
const STRANDED_PLAN_LEASE_MILLISECONDS = 30_000;
const RECOVERABLE_QUARANTINE_RECOVERY_LIMIT = 16;
const RECOVERABLE_QUARANTINE_POLL_MILLISECONDS = 30_000;
const INCOMPATIBLE_GENERATION_RECOVERY_LIMIT = 16;

export function createProductionDocumentPublicationCoordinatorRuntime(input: {
  sql: DatabaseClient;
  idlePollMilliseconds?: number;
  observability?: Pick<DocumentWorkerObservability,
    "publication" | "publicationBacklog"> & Partial<Pick<
      DocumentWorkerObservability,
      "publicationRecovery"
    >>;
}) {
  const coordinator = createPostgresDocumentPublicationCoordinator(input.sql);
  const validator = createPostgresDocumentPublicationValidator(input.sql);
  const recovery = createPostgresDocumentPublicationRecovery(input.sql);
  const activation = createDocumentPublicationActivationCoordinator({
    activation: createPostgresDocumentPublicationActivation({ sql: input.sql }),
    recovery
  });
  let nextBacklogObservationAt = 0;
  let nextRemediatedRecoveryAt = 0;

  async function planOne(now: string): Promise<boolean> {
    const stranded = await coordinator.claimStrandedPlan({
      now,
      staleAfterMs: STRANDED_PLAN_LEASE_MILLISECONDS
    });
    const knowledgeBaseId = stranded?.knowledgeBaseId
      ?? await findReadyKnowledgeBase(input.sql);
    if (!knowledgeBaseId) return false;
    const frozen = stranded ?? await coordinator.freezeReady({
      knowledgeBaseId,
      now,
      contributorCap: CONTRIBUTOR_CAP,
      rendererContractVersion: DOCUMENT_PUBLICATION_RENDERER_CONTRACT_VERSION
    });
    if (!frozen) return false;
    const documents = await readGenerationFactDeltas(
      input.sql,
      frozen.generationPublicId
    );
    const plan = planDocumentPublicationGeneration({
      generationPublicId: frozen.generationPublicId,
      baseGenerationPublicId: frozen.baseGenerationPublicId,
      targetFactEpoch: frozen.targetFactEpoch,
      rendererContractVersion: frozen.rendererContractVersion,
      deterministicChangedAt: frozen.deterministicChangedAt,
      documents
    });
    const reservations = planDocumentPublicationActivationReservations({
      documents: documents.map((document) => ({
        documentJobPublicId: document.documentJobPublicId,
        sourceFilePublicId: document.sourceFilePublicId,
        relatedSourceFilePublicIds: document.relatedSourceFilePublicIds
      })),
      putPaths: plan.putPaths,
      deletePaths: plan.deletePaths,
      searchSourceFilePublicIds: plan.searchSourceFilePublicIds,
      directoryPaths: plan.scopes.flatMap((scope) =>
        ["directory", "_index", "_graph", "root"].includes(scope.kind)
          ? [scope.identity] : [])
    });
    await coordinator.persistPlan({
      generationPublicId: frozen.generationPublicId,
      documents,
      scopes: plan.scopes,
      ownerReservations: reservations,
      createdAt: now
    });
    input.observability?.publication({
      event: "planned",
      knowledgeBaseId,
      generationPublicId: frozen.generationPublicId,
      scopeKind: null,
      waitingCount: plan.scopes.length,
      durationMs: 0,
      contentionCount: 0,
      objectPutCount: plan.putPaths.length,
      objectReuseCount: 0,
      errorCode: null
    });
    return true;
  }

  async function validateOne(now: string): Promise<boolean> {
    const generationPublicId = await findValidatableGeneration(input.sql);
    if (!generationPublicId) return false;
    const startedAt = Date.now();
    const result = await validator.validate({ generationPublicId, checkedAt: now });
    const identity = await readGenerationIdentity(input.sql, generationPublicId);
    input.observability?.publication({
      event: "validated",
      knowledgeBaseId: identity.knowledgeBaseId,
      generationPublicId,
      scopeKind: null,
      waitingCount: 0,
      durationMs: Math.max(0, Date.now() - startedAt),
      contentionCount: 0,
      objectPutCount: 0,
      objectReuseCount: 0,
      errorCode: result.state === "ready" ? null
        : "publication_generation_validation_failed"
    });
    return true;
  }

  async function activateOne(now: string): Promise<boolean> {
    const candidate = await findActivatableGeneration(input.sql, now);
    if (!candidate) return false;
    const startedAt = Date.now();
    const outcome = await activation.activate({
      operation: operationKind(candidate.factKinds),
      generationPublicId: candidate.publicId,
      expectedHeadVersion: candidate.headVersion,
      activatedAt: now
    });
    input.observability?.publication({
      event: outcome.state === "active" ? "activated" : outcome.state,
      knowledgeBaseId: candidate.knowledgeBaseId,
      generationPublicId: candidate.publicId,
      scopeKind: null,
      waitingCount: 0,
      durationMs: Math.max(0, Date.now() - startedAt),
      contentionCount: candidate.contentionCount,
      objectPutCount: 0,
      objectReuseCount: 0,
      errorCode: outcome.state === "deferred"
        ? "reason" in outcome && outcome.reason === "deadline"
          ? "publication_activation_deadline_deferred"
          : "publication_activation_contention_deferred"
        : outcome.state === "superseded"
          ? "publication_generation_stale_base" : null
    });
    return true;
  }

  return {
    async runOne(now = new Date().toISOString()): Promise<boolean> {
      const nowMilliseconds = Date.parse(now);
      const incompatible = await recovery.recoverIncompatibleGenerations({
        rendererContractVersion:
          DOCUMENT_PUBLICATION_RENDERER_CONTRACT_VERSION,
        recoveredAt: now,
        limit: INCOMPATIBLE_GENERATION_RECOVERY_LIMIT
      });
      const recovered = nowMilliseconds >= nextRemediatedRecoveryAt
        ? await recovery.recoverRecoverableQuarantines({
          recoveredAt: now,
          limit: RECOVERABLE_QUARANTINE_RECOVERY_LIMIT
        }) : {
          generationCount: 0,
          releasedFactCount: 0,
          replannedFactCount: 0,
          supersededScopeCount: 0
        };
      if (nowMilliseconds >= nextRemediatedRecoveryAt) {
        nextRemediatedRecoveryAt = recovered.generationCount
          === RECOVERABLE_QUARANTINE_RECOVERY_LIMIT
          ? nowMilliseconds
          : nowMilliseconds + RECOVERABLE_QUARANTINE_POLL_MILLISECONDS;
      }
      if (recovered.generationCount > 0) {
        input.observability?.publicationRecovery?.(recovered);
      }
      if (incompatible.generationCount > 0) {
        input.observability?.publicationRecovery?.(incompatible);
      }
      const [planned, validated, activated] = await Promise.all([
        planOne(now), validateOne(now), activateOne(now)
      ]);
      if (input.observability && nowMilliseconds >= nextBacklogObservationAt) {
        const backlogs = await readPublicationBacklogs(input.sql, now);
        backlogs.forEach((backlog) =>
          input.observability?.publicationBacklog(backlog));
        nextBacklogObservationAt = nowMilliseconds + 1_000;
      }
      return incompatible.generationCount > 0
        || recovered.generationCount > 0 || planned || validated || activated;
    },
    async run(signal: AbortSignal): Promise<void> {
      while (!signal.aborted) {
        const progressed = await this.runOne();
        if (!progressed) {
          await waitForDocumentWork(
            input.idlePollMilliseconds ?? 50,
            signal
          );
        }
      }
    }
  };
}

async function readPublicationBacklogs(sql: DatabaseClient, now: string) {
  const rows = await sql<Array<{
    knowledge_base_id: string;
    waiting_scope_count: number | string;
    running_scope_count: number | string;
    dirty_fact_count: number | string;
    oldest_age_milliseconds: number | string;
    status_regression_count: number | string;
  }>>`
    SELECT cutover.knowledge_base_id,
           count(DISTINCT scope.public_id) FILTER (
             WHERE scope.state = 'waiting'
               AND scope_generation.public_id IS NOT NULL
           )
             AS waiting_scope_count,
           count(DISTINCT scope.public_id) FILTER (
             WHERE scope.state = 'running'
               AND scope_generation.public_id IS NOT NULL
           )
             AS running_scope_count,
           count(DISTINCT epoch.fact_epoch) FILTER (WHERE epoch.state = 'ready')
             AS dirty_fact_count,
           greatest(0, coalesce(floor(extract(epoch FROM (
             ${now}::timestamptz - least(
               min(scope.created_at) FILTER (
                 WHERE scope.state IN ('waiting', 'running')
                   AND scope_generation.public_id IS NOT NULL
               ),
               min(epoch.created_at) FILTER (WHERE epoch.state = 'ready')
             )
           )) * 1000), 0))::bigint AS oldest_age_milliseconds,
           (SELECT count(*)
            FROM focowiki.document_processing_jobs job
            WHERE job.knowledge_base_id = cutover.knowledge_base_id
              AND job.state = 'available'
              AND (job.terminal_at IS NULL OR NOT EXISTS (
                SELECT 1 FROM focowiki.document_artifact_work work
                WHERE work.document_job_public_id = job.public_id
                  AND work.work_kind = 'activate'
                  AND work.state = 'completed'
              ))) AS status_regression_count
    FROM focowiki.projection_cutover_states cutover
    LEFT JOIN focowiki.projection_scope_generations scope
      ON scope.knowledge_base_id = cutover.knowledge_base_id
     AND scope.state IN ('waiting', 'running')
    LEFT JOIN focowiki.projection_publication_generations scope_generation
      ON scope_generation.public_id = scope.publication_generation_public_id
     AND scope_generation.state IN (
       'planned', 'rendering', 'validating', 'ready'
     )
    LEFT JOIN focowiki.projection_fact_epochs epoch
      ON epoch.knowledge_base_id = cutover.knowledge_base_id
     AND epoch.state = 'ready'
    WHERE cutover.writer_mode = 'coherent'
    GROUP BY cutover.knowledge_base_id
    ORDER BY cutover.knowledge_base_id COLLATE "C"
    LIMIT 1024
  `;
  return rows.map((row) => ({
    knowledgeBaseId: row.knowledge_base_id,
    waitingScopeCount: Number(row.waiting_scope_count),
    runningScopeCount: Number(row.running_scope_count),
    dirtyFactCount: Number(row.dirty_fact_count),
    oldestAgeMs: Number(row.oldest_age_milliseconds),
    statusRegressionCount: Number(row.status_regression_count)
  }));
}

async function findReadyKnowledgeBase(sql: DatabaseClient) {
  const rows = await sql<Array<{ knowledge_base_id: string }>>`
    SELECT epoch.knowledge_base_id
    FROM focowiki.projection_fact_epochs epoch
    JOIN focowiki.projection_cutover_states cutover
      ON cutover.knowledge_base_id = epoch.knowledge_base_id
     AND cutover.writer_mode = 'coherent'
    LEFT JOIN focowiki.projection_publication_generations candidate
      ON candidate.knowledge_base_id = epoch.knowledge_base_id
     AND candidate.state IN ('planned', 'rendering', 'validating', 'ready')
    WHERE epoch.state = 'ready' AND candidate.public_id IS NULL
    GROUP BY epoch.knowledge_base_id
    ORDER BY min(epoch.created_at), epoch.knowledge_base_id COLLATE "C"
    LIMIT 1
  `;
  return rows[0]?.knowledge_base_id ?? null;
}

async function findValidatableGeneration(sql: DatabaseClient) {
  const rows = await sql<Array<{ public_id: string }>>`
    SELECT generation.public_id
    FROM focowiki.projection_publication_generations generation
    JOIN focowiki.projection_cutover_states cutover
      ON cutover.knowledge_base_id = generation.knowledge_base_id
     AND cutover.writer_mode = 'coherent'
    WHERE generation.state IN ('rendering', 'validating')
      AND NOT EXISTS (
        SELECT 1 FROM focowiki.projection_scope_generations scope
        WHERE scope.publication_generation_public_id = generation.public_id
          AND scope.state <> 'completed'
      )
    ORDER BY generation.updated_at, generation.public_id COLLATE "C"
    LIMIT 1
  `;
  return rows[0]?.public_id ?? null;
}

async function findActivatableGeneration(sql: DatabaseClient, now: string) {
  const rows = await sql<Array<{
    public_id: string;
    knowledge_base_id: string;
    head_version: number | string;
    fact_kinds: string[];
    activation_contention_count: number | string;
  }>>`
    SELECT generation.public_id, generation.knowledge_base_id,
           head.head_version, generation.activation_contention_count,
           array_agg(DISTINCT epoch.fact_kind ORDER BY epoch.fact_kind)
             AS fact_kinds
    FROM focowiki.projection_publication_generations generation
    JOIN focowiki.projection_cutover_states cutover
      ON cutover.knowledge_base_id = generation.knowledge_base_id
     AND cutover.writer_mode = 'coherent'
    JOIN focowiki.knowledge_base_projection_heads head
      ON head.knowledge_base_id = generation.knowledge_base_id
    JOIN focowiki.projection_generation_documents document
      ON document.generation_public_id = generation.public_id
    JOIN focowiki.projection_fact_epochs epoch
      ON epoch.knowledge_base_id = generation.knowledge_base_id
     AND epoch.mutation_public_id = document.mutation_public_id
     AND epoch.fact_epoch = document.fact_epoch
    WHERE generation.state = 'ready'
      AND (generation.activation_next_eligible_at IS NULL
        OR generation.activation_next_eligible_at <= ${now})
    GROUP BY generation.public_id, generation.knowledge_base_id,
             head.head_version, generation.activation_contention_count,
             generation.updated_at
    ORDER BY generation.updated_at, generation.public_id COLLATE "C"
    LIMIT 1
  `;
  const row = rows[0];
  return row ? {
    publicId: row.public_id,
    knowledgeBaseId: row.knowledge_base_id,
    headVersion: Number(row.head_version),
    factKinds: row.fact_kinds,
    contentionCount: Number(row.activation_contention_count)
  } : null;
}

async function readGenerationIdentity(
  sql: DatabaseClient,
  generationPublicId: string
) {
  const rows = await sql<Array<{ knowledge_base_id: string }>>`
    SELECT knowledge_base_id
    FROM focowiki.projection_publication_generations
    WHERE public_id = ${generationPublicId}
  `;
  if (!rows[0]) throw runtimeError("generation_identity_missing");
  return { knowledgeBaseId: rows[0].knowledge_base_id };
}

function operationKind(values: readonly string[]) {
  if (values.includes("delete")) return "delete" as const;
  if (values.includes("move")) return "move" as const;
  if (values.includes("replace")) return "replace" as const;
  if (values.includes("repair") || values.includes("shadow")) {
    return "repair" as const;
  }
  return "create" as const;
}

function runtimeError(code: string): Error & { code: string } {
  return Object.assign(new Error(`Publication coordinator error: ${code}`), {
    code
  });
}
