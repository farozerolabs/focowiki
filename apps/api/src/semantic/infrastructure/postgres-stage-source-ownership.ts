import type { DatabaseClient } from "../../db/client.js";
import type { SemanticStageWorkClaim } from "../application/stage-ports.js";
import type { SemanticVectorProjectionPlan } from
  "../vector/projection-planner.js";

export function createPostgresSemanticStageSourceOwnership(
  sql: DatabaseClient
) {
  return {
    async isOwnedRevision(claim: SemanticStageWorkClaim): Promise<boolean> {
      const rows = await sql<Array<{ owned: boolean }>>`
        SELECT EXISTS (
          SELECT 1
          FROM focowiki.semantic_stage_work_items stage
          JOIN focowiki.operation_work_items work
            ON work.knowledge_base_id = stage.knowledge_base_id
           AND work.operation_public_id = stage.operation_public_id
           AND work.work_kind = 'mutation'
           AND work.state IN ('queued', 'running', 'retry')
          JOIN focowiki.source_revisions revision
            ON revision.knowledge_base_id = stage.knowledge_base_id
           AND revision.source_file_public_id = stage.source_file_public_id
           AND revision.public_id = stage.source_revision_public_id
           AND revision.revision_role = 'candidate'
          WHERE stage.public_id = ${claim.publicId}
            AND stage.knowledge_base_id = ${claim.knowledgeBaseId}
            AND stage.operation_public_id = ${claim.operationPublicId}
            AND stage.semantic_generation_public_id
              = ${claim.semanticGenerationPublicId}
            AND stage.source_file_public_id = ${claim.sourceFilePublicId}
            AND stage.source_revision_public_id = ${claim.sourceRevisionPublicId}
            AND stage.state = 'running'
            AND work.checkpoint ->> 'candidateRevisionPublicId'
              = stage.source_revision_public_id
        ) AS owned
      `;
      return rows[0]?.owned === true;
    },
    async isOwnedVectorPlan(plan: SemanticVectorProjectionPlan): Promise<boolean> {
      if (!plan.operationPublicId || plan.desiredDocuments.length === 0) return false;
      const sources = [...new Map(plan.desiredDocuments.map((document) => [
        document.sourceFilePublicId,
        {
          sourceFilePublicId: document.sourceFilePublicId,
          sourceRevisionPublicId: document.sourceRevisionPublicId
        }
      ])).values()];
      const rows = await sql<Array<{ owned: boolean }>>`
        WITH desired AS (
          SELECT item."sourceFilePublicId", item."sourceRevisionPublicId"
          FROM jsonb_to_recordset(${sql.json(sources as never)}) AS item(
            "sourceFilePublicId" text, "sourceRevisionPublicId" text
          )
        )
        SELECT EXISTS (
          SELECT 1
          FROM focowiki.operation_work_items work
          WHERE work.knowledge_base_id = ${plan.knowledgeBaseId}
            AND work.operation_public_id = ${plan.operationPublicId}
            AND work.work_kind = 'mutation'
            AND work.state IN ('queued', 'running', 'retry')
            AND NOT EXISTS (
              SELECT 1
              FROM desired
              LEFT JOIN focowiki.source_revisions revision
                ON revision.knowledge_base_id = work.knowledge_base_id
               AND revision.source_file_public_id = desired."sourceFilePublicId"
               AND revision.public_id = desired."sourceRevisionPublicId"
               AND revision.revision_role = 'candidate'
              LEFT JOIN focowiki.semantic_stage_work_items stage
                ON stage.knowledge_base_id = work.knowledge_base_id
               AND stage.operation_public_id = work.operation_public_id
               AND stage.semantic_generation_public_id
                 = ${plan.semanticGenerationPublicId}
               AND stage.source_file_public_id = desired."sourceFilePublicId"
               AND stage.source_revision_public_id = desired."sourceRevisionPublicId"
               AND stage.stage_kind = 'vector'
               AND stage.state = 'running'
              WHERE revision.public_id IS NULL OR stage.public_id IS NULL
            )
        ) AS owned
      `;
      return rows[0]?.owned === true;
    }
  };
}
