import type { TransactionSql } from "postgres";
import type { SerializableJson } from "../../application/ports/source-dispatch-repository.js";
import type { ChangeFactKind } from "../../domain/generation.js";
import type { PublicationImpact } from "../../publication/impact-planner.js";

export type PublicationChangePlanningPayload = {
  preplannedImpacts?: PublicationImpact[];
  graphNeighborSourceFileIds?: string[];
  graphEdgeIds?: string[];
  removedGraphEdgeIds?: string[];
  impactPlanner?: {
    searchShardCount: number;
    linkShardCount: number;
    manifestShardCount: number;
    treeShardCount: number;
    graphNodeShardCount: number;
    graphEdgeShardCount: number;
  };
  schedulePublication: boolean;
  skipGeneration?: boolean;
  allowDeletedKnowledgeBase: boolean;
};

export async function appendPublicationChangeFact(
  transaction: TransactionSql<Record<string, never>>,
  input: {
    changeFactId: string;
    knowledgeBaseId: string;
    sourceFileId: string | null;
    sourceRevisionId: string | null;
    operationId: string | null;
    deletionIntentId: string | null;
    kind: ChangeFactKind;
    previousPath: string | null;
    path: string | null;
    resourceRevision: number;
    planningPayload: PublicationChangePlanningPayload;
    publicationSettingsSnapshot: SerializableJson;
    publicationMaxAttempts: number;
    committedAt: string;
  }
): Promise<boolean> {
  const inserted = await transaction<Array<{ id: string }>>`
    INSERT INTO focowiki.publication_change_facts (
      id, knowledge_base_id, source_file_id, source_revision_id,
      operation_id, deletion_intent_id, kind, previous_path, path,
      resource_revision, generation_id, assembly_state,
      planning_payload_json, settings_snapshot_json,
      publication_max_attempts, created_at
    ) VALUES (
      ${input.changeFactId}, ${input.knowledgeBaseId}, ${input.sourceFileId},
      ${input.sourceRevisionId}, ${input.operationId}, ${input.deletionIntentId},
      ${input.kind}, ${input.previousPath}, ${input.path}, ${input.resourceRevision},
      NULL, 'pending', ${transaction.json(input.planningPayload as never)},
      ${transaction.json(input.publicationSettingsSnapshot as never)},
      ${input.publicationMaxAttempts}, ${input.committedAt}
    )
    ON CONFLICT (id) DO NOTHING
    RETURNING id
  `;
  return inserted.length > 0;
}
