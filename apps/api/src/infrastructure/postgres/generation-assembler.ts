import { randomUUID } from "node:crypto";
import type { TransactionSql } from "postgres";
import type { PublicationGenerationRepository } from "../../application/ports/publication-generation-repository.js";
import type { SerializableJson } from "../../application/ports/source-dispatch-repository.js";
import type { ChangeFactKind } from "../../domain/generation.js";
import { resolveGenerationSchedule } from "../../publication/generation-schedule.js";
import {
  planPublicationImpactBatch,
  type PublicationImpactBatch,
  type PublicationImpactPlanningFact
} from "../../publication/generation-impact-batch.js";
import type { PublicationImpact } from "../../publication/impact-planner.js";
import type { DatabaseClient } from "../../db/client.js";
import type { PublicationChangePlanningPayload } from "./publication-change-fact-writer.js";
import {
  capturePublicationProjectionInputsBatch,
  persistCapturedProjectionInputs,
  type CapturedProjectionInput,
  type PublicationProjectionCaptureChange
} from "./publication-projection-input-capture.js";

type GenerationRow = {
  id: string;
  predecessor_generation_id: string | null;
  state: string;
  created_at: Date;
};

type ChangeFactRow = {
  id: string;
  knowledge_base_id: string;
  source_file_id: string | null;
  source_revision_id: string | null;
  operation_id: string | null;
  kind: ChangeFactKind;
  previous_path: string | null;
  path: string | null;
  planning_payload_json: PublicationChangePlanningPayload;
  settings_snapshot_json: SerializableJson;
  publication_max_attempts: number;
  created_at: Date;
};

export async function assemblePendingPublicationChanges(
  sql: DatabaseClient,
  input: Parameters<PublicationGenerationRepository["assemblePendingChanges"]>[0]
): Promise<Awaited<ReturnType<PublicationGenerationRepository["assemblePendingChanges"]>>> {
  if (!Number.isSafeInteger(input.limit) || input.limit <= 0) {
    throw new Error("Generation assembly limit must be a positive integer");
  }
  return sql.begin(async (transaction) => {
    const facts = await transaction<ChangeFactRow[]>`
      SELECT id, knowledge_base_id, source_file_id, source_revision_id,
             operation_id, kind, previous_path, path, planning_payload_json,
             settings_snapshot_json, publication_max_attempts, created_at
      FROM focowiki.publication_change_facts
      WHERE knowledge_base_id = ${input.knowledgeBaseId}
        AND generation_id IS NULL
        AND assembly_state = 'pending'
      ORDER BY created_at, id
      LIMIT ${input.limit}
      FOR UPDATE SKIP LOCKED
    `;
    if (facts.length === 0) {
      return {
        generationId: null,
        assembledChangeCount: 0,
        impactCount: 0,
        hasMore: false
      };
    }

    const publishableFacts = facts.filter((fact) =>
      fact.planning_payload_json.skipGeneration !== true
    );
    const skippedFacts = facts.filter((fact) =>
      fact.planning_payload_json.skipGeneration === true
    );
    if (skippedFacts.length > 0) {
      await markFactsAssembled(transaction, {
        factIds: skippedFacts.map((fact) => fact.id),
        generationId: null,
        assemblerJobId: input.assemblerJobId,
        assembledAt: input.assembledAt
      });
    }

    let generation: GenerationRow | null = null;
    let impactCount = 0;
    if (publishableFacts.length > 0) {
      const impactBatch = planPublicationImpactBatch(publishableFacts.map(toPlanningFact));
      const planned = publishableFacts.map((fact, index) => ({
        fact,
        impacts: impactBatch.plannedFacts[index]!.impacts
      }));
      const captureChanges: PublicationProjectionCaptureChange[] = planned.map((entry) => ({
        changeKind: entry.fact.kind,
        sourceFileId: entry.fact.source_file_id,
        sourceRevisionId: entry.fact.source_revision_id,
        previousPath: entry.fact.previous_path,
        path: entry.fact.path,
        impacts: entry.impacts
      }));
      const capturedInputs = await capturePublicationProjectionInputsBatch(transaction, {
        knowledgeBaseId: input.knowledgeBaseId,
        generationId: "unassigned",
        changes: captureChanges,
        now: input.assembledAt
      });

      await transaction`
        SELECT pg_advisory_xact_lock(
          hashtextextended('focowiki:generation:' || ${input.knowledgeBaseId}, 0)
        )
      `;
      generation = await requireOpenGeneration(transaction, {
        knowledgeBaseId: input.knowledgeBaseId,
        now: input.assembledAt,
        allowDeletedKnowledgeBase: publishableFacts.some((fact) =>
          fact.planning_payload_json.allowDeletedKnowledgeBase === true
        )
      });
      await persistCapturedProjectionInputs(transaction, {
        knowledgeBaseId: input.knowledgeBaseId,
        generationId: generation.id,
        captured: capturedInputs,
        now: input.assembledAt
      });
      impactCount = await persistPublicationImpactBatch(transaction, {
        knowledgeBaseId: input.knowledgeBaseId,
        generationId: generation.id,
        impactBatch,
        capturedInputs,
        now: input.assembledAt
      });
      await markFactsAssembled(transaction, {
        factIds: publishableFacts.map((fact) => fact.id),
        generationId: generation.id,
        assemblerJobId: input.assemblerJobId,
        assembledAt: input.assembledAt
      });
      const changeCount = await incrementGenerationChangeCount(
        transaction,
        generation.id,
        publishableFacts.length
      );
      const scheduledFacts = publishableFacts.filter((fact) =>
        fact.planning_payload_json.schedulePublication !== false
      );
      if (scheduledFacts.length > 0) {
        await scheduleGenerationPublication(transaction, {
          knowledgeBaseId: input.knowledgeBaseId,
          generation,
          settingsSnapshot: scheduledFacts.at(-1)!.settings_snapshot_json,
          publicationMaxAttempts: Math.max(
            ...scheduledFacts.map((fact) => fact.publication_max_attempts)
          ),
          changeCount,
          now: input.assembledAt
        });
      }
    }

    const hasMoreRows = await transaction<Array<{ has_more: boolean }>>`
      SELECT EXISTS (
        SELECT 1
        FROM focowiki.publication_change_facts
        WHERE knowledge_base_id = ${input.knowledgeBaseId}
          AND generation_id IS NULL
          AND assembly_state = 'pending'
        LIMIT 1
      ) AS has_more
    `;
    const hasMore = hasMoreRows[0]?.has_more ?? false;
    return {
      generationId: generation?.id ?? null,
      assembledChangeCount: facts.length,
      impactCount,
      hasMore
    };
  });
}

function toPlanningFact(fact: ChangeFactRow): PublicationImpactPlanningFact {
  const payload = fact.planning_payload_json;
  return {
    id: fact.id,
    kind: fact.kind,
    sourceFileId: fact.source_file_id,
    previousPath: fact.previous_path,
    path: fact.path,
    graphNeighborSourceFileIds: payload.graphNeighborSourceFileIds ?? [],
    graphEdgeIds: payload.graphEdgeIds ?? [],
    removedGraphEdgeIds: payload.removedGraphEdgeIds ?? [],
    preplannedImpacts: payload.preplannedImpacts,
    impactPlanner: payload.impactPlanner ?? null
  };
}

async function persistPublicationImpactBatch(
  transaction: TransactionSql<Record<string, never>>,
  input: {
    knowledgeBaseId: string;
    generationId: string;
    impactBatch: PublicationImpactBatch;
    capturedInputs: Map<string, CapturedProjectionInput>;
    now: string;
  }
): Promise<number> {
  const effective = new Map(
    input.impactBatch.effectiveImpacts.map((impact) => [projectionTargetKey(impact), impact])
  );
  const rows: Array<{
    ordinal: number;
    changeFactId: string;
    id: string;
    projectionKind: string;
    projectionKey: string;
    recordIdentity: string;
    action: string;
  }> = [];
  for (const cause of input.impactBatch.causeRows) {
    rows.push({
      ordinal: cause.ordinal,
      changeFactId: cause.changeFactId,
      id: cause.impact.id,
      projectionKind: cause.impact.projectionKind,
      projectionKey: cause.impact.projectionKey,
      recordIdentity: cause.impact.recordIdentity,
      action: cause.impact.action
    });
  }
  if (rows.length === 0) return 0;
  const enrichedRows = rows.map((row) => {
    const effectiveImpact = effective.get(
      `${row.projectionKind}\u0000${row.projectionKey}\u0000${row.recordIdentity}`
    )!;
    return {
      ...row,
      projectionInputKey: input.capturedInputs.get(effectiveImpact.id)?.inputKey ?? null
    };
  });
  const counts = await transaction<Array<{ impact_count: number }>>`
    WITH raw AS MATERIALIZED (
      SELECT item.*
      FROM jsonb_to_recordset(${transaction.json(enrichedRows as never)}) AS item(
        "ordinal" integer,
        "changeFactId" text,
        "id" text,
        "projectionKind" text,
        "projectionKey" text,
        "recordIdentity" text,
        "action" text,
        "projectionInputKey" text
      )
    ), targets AS MATERIALIZED (
      SELECT DISTINCT ON ("projectionKind", "projectionKey", "recordIdentity")
             "id", "projectionKind", "projectionKey", "recordIdentity",
             "action", "projectionInputKey"
      FROM raw
      ORDER BY "projectionKind", "projectionKey", "recordIdentity", "ordinal" DESC
    ), upserted AS MATERIALIZED (
      INSERT INTO focowiki.publication_impacts (
        id, knowledge_base_id, generation_id, projection_kind, projection_key,
        record_identity, action, projection_input_key, run_after, created_at, updated_at
      )
      SELECT target."id", ${input.knowledgeBaseId}, ${input.generationId},
             target."projectionKind", target."projectionKey", target."recordIdentity",
             target."action", target."projectionInputKey",
             ${input.now}::timestamptz,
             ${input.now}::timestamptz,
             ${input.now}::timestamptz
      FROM targets target
      ON CONFLICT (generation_id, projection_kind, projection_key, record_identity)
      DO UPDATE SET action = EXCLUDED.action,
        projection_input_key = EXCLUDED.projection_input_key,
        run_after = least(focowiki.publication_impacts.run_after, EXCLUDED.run_after),
        updated_at = EXCLUDED.updated_at
      RETURNING id, projection_kind, projection_key, record_identity
    ), causes AS (
      INSERT INTO focowiki.publication_impact_causes (
        impact_id, change_fact_id, created_at
      )
      SELECT DISTINCT upserted.id, raw."changeFactId", ${input.now}::timestamptz
      FROM raw
      JOIN upserted
        ON upserted.projection_kind = raw."projectionKind"
       AND upserted.projection_key = raw."projectionKey"
       AND upserted.record_identity = raw."recordIdentity"
      ON CONFLICT (impact_id, change_fact_id) DO NOTHING
    )
    SELECT count(*)::int AS impact_count FROM upserted
  `;
  return Number(counts[0]?.impact_count ?? 0);
}

async function markFactsAssembled(
  transaction: TransactionSql<Record<string, never>>,
  input: {
    factIds: string[];
    generationId: string | null;
    assemblerJobId: string;
    assembledAt: string;
  }
): Promise<void> {
  if (input.factIds.length === 0) return;
  await transaction`
    UPDATE focowiki.publication_change_facts
    SET generation_id = ${input.generationId},
        assembly_state = 'assembled',
        assembly_claimed_by = ${input.assemblerJobId},
        assembly_claimed_at = coalesce(assembly_claimed_at, ${input.assembledAt}),
        assembled_at = ${input.assembledAt}
    WHERE id = ANY(${input.factIds})
      AND assembly_state = 'pending'
  `;
}

async function incrementGenerationChangeCount(
  transaction: TransactionSql<Record<string, never>>,
  generationId: string,
  increment: number
): Promise<number> {
  const rows = await transaction<Array<{ assembled_change_count: number | string }>>`
    UPDATE focowiki.publication_generations
    SET assembled_change_count = assembled_change_count + ${increment},
        updated_at = now()
    WHERE id = ${generationId}
    RETURNING assembled_change_count
  `;
  return Number(rows[0]?.assembled_change_count ?? 0);
}

async function scheduleGenerationPublication(
  transaction: TransactionSql<Record<string, never>>,
  input: {
    knowledgeBaseId: string;
    generation: GenerationRow;
    settingsSnapshot: SerializableJson;
    publicationMaxAttempts: number;
    changeCount: number;
    now: string;
  }
): Promise<void> {
  const schedule = resolveGenerationSchedule({
    settingsSnapshot: input.settingsSnapshot,
    generationCreatedAt: input.generation.created_at.toISOString(),
    completedAt: input.now,
    changeCount: input.changeCount
  });
  if (!schedule.enqueue) return;
  await transaction`
    INSERT INTO focowiki.role_jobs (
      id, role, kind, knowledge_base_id, generation_id,
      payload_json, settings_snapshot_json, run_after, max_attempts,
      early_claim_on_upstream_drain, created_at, updated_at
    ) VALUES (
      ${`role-job-publication-${input.generation.id}`}, 'publication',
      'generation_publication', ${input.knowledgeBaseId}, ${input.generation.id},
      ${transaction.json({ generationId: input.generation.id })},
      ${transaction.json(input.settingsSnapshot as never)},
      ${schedule.runAfter!}, ${input.publicationMaxAttempts}, true, ${input.now}, ${input.now}
    )
    ON CONFLICT (generation_id) WHERE role = 'publication' AND generation_id IS NOT NULL
    DO UPDATE SET
      run_after = least(focowiki.role_jobs.run_after, EXCLUDED.run_after),
      settings_snapshot_json = EXCLUDED.settings_snapshot_json,
      max_attempts = greatest(focowiki.role_jobs.max_attempts, EXCLUDED.max_attempts),
      early_claim_on_upstream_drain = true,
      updated_at = EXCLUDED.updated_at
  `;
}

async function requireOpenGeneration(
  transaction: TransactionSql<Record<string, never>>,
  input: { knowledgeBaseId: string; now: string; allowDeletedKnowledgeBase: boolean }
): Promise<GenerationRow> {
  const existing = await transaction<GenerationRow[]>`
    SELECT id, predecessor_generation_id, state, created_at
    FROM focowiki.publication_generations
    WHERE knowledge_base_id = ${input.knowledgeBaseId} AND state = 'open'
    FOR UPDATE
  `;
  if (existing[0]) return existing[0];
  const active = await transaction<Array<{ active_generation_id: string | null }>>`
    SELECT active_generation_id
    FROM focowiki.knowledge_bases
    WHERE id = ${input.knowledgeBaseId}
      AND (${input.allowDeletedKnowledgeBase} OR deleted_at IS NULL)
    FOR UPDATE
  `;
  if (!active[0]) throw new Error("Knowledge base is unavailable");
  const generationId = `generation-${randomUUID()}`;
  const created = await transaction<GenerationRow[]>`
    INSERT INTO focowiki.publication_generations (
      id, knowledge_base_id, predecessor_generation_id, state, created_at, updated_at
    ) VALUES (
      ${generationId}, ${input.knowledgeBaseId}, ${active[0].active_generation_id},
      'open', ${input.now}, ${input.now}
    )
    RETURNING id, predecessor_generation_id, state, created_at
  `;
  return created[0]!;
}

function projectionTargetKey(impact: PublicationImpact): string {
  return `${impact.projectionKind}\u0000${impact.projectionKey}\u0000${impact.recordIdentity}`;
}
