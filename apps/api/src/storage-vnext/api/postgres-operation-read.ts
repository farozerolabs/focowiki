import type { DatabaseClient } from "../../db/client.js";
import type {
  ResourceOperationKind,
  ResourceOperationRecord,
  ResourceOperationState
} from "../../domain/source-resource.js";
import { SourceResourceError } from "../../domain/source-resource.js";

type OperationRow = {
  public_id: string;
  knowledge_base_id: string;
  operation_kind: string;
  state: string;
  expected_resource_revision: number | string | null;
  target_kind: "source_file" | "source_directory" | "knowledge_base" | null;
  target_public_id: string | null;
  candidate_relative_path: string | null;
  result_summary: unknown;
  result_code: string | null;
  created_at: Date;
  updated_at: Date;
  completed_at: Date | null;
  semantic_total_count: number | string;
  semantic_completed_count: number | string;
  semantic_pending_count: number | string;
  semantic_failed_count: number | string;
  semantic_cancelled_count: number | string;
  semantic_superseded_count: number | string;
  semantic_safe_error_code: string | null;
  semantic_current_stage_kind: string | null;
};

type OperationCursor = { version: 1; createdAt: string; publicId: string };

export type StorageVnextOperationRead = {
  list(input: {
    knowledgeBaseId: string;
    states?: ResourceOperationState[];
    limit: number;
    cursor: string | null;
  }): Promise<{ items: ResourceOperationRecord[]; nextCursor: string | null }>;
  get(input: {
    knowledgeBaseId: string;
    operationId: string;
  }): Promise<ResourceOperationRecord | null>;
};

export function createPostgresStorageVnextOperationRead(
  sql: DatabaseClient
): StorageVnextOperationRead {
  return {
    async list(input) {
      const limit = assertLimit(input.limit);
      const cursor = decodeCursor(input.cursor);
      const providerStates = input.states?.flatMap(toProviderStates) ?? null;
      const rows = await sql<OperationRow[]>`
        SELECT operation.public_id, operation.knowledge_base_id,
               operation.operation_kind, operation.state,
               operation.expected_resource_revision, operation.target_kind,
               operation.target_public_id, operation.candidate_relative_path,
               result.result_summary, result.result_code,
               operation.created_at, operation.updated_at, operation.completed_at,
               semantic.total_count AS semantic_total_count,
               semantic.completed_count AS semantic_completed_count,
               semantic.pending_count AS semantic_pending_count,
               semantic.failed_count AS semantic_failed_count,
               semantic.cancelled_count AS semantic_cancelled_count,
               semantic.superseded_count AS semantic_superseded_count,
               semantic.safe_error_code AS semantic_safe_error_code,
               semantic.current_stage_kind AS semantic_current_stage_kind
        FROM focowiki.operations operation
        LEFT JOIN focowiki.operation_results result
          ON result.knowledge_base_id = operation.knowledge_base_id
         AND result.public_id = operation.public_id
        LEFT JOIN LATERAL (
          SELECT count(*) AS total_count,
                 count(*) FILTER (WHERE stage.state = 'completed')
                   AS completed_count,
                 count(*) FILTER (
                   WHERE stage.state IN ('queued', 'running', 'retry')
                 ) AS pending_count,
                 count(*) FILTER (WHERE stage.state = 'failed') AS failed_count,
                 count(*) FILTER (WHERE stage.state = 'cancelled')
                   AS cancelled_count,
                 count(*) FILTER (WHERE stage.state = 'superseded')
                   AS superseded_count,
                 (array_agg(stage.safe_error_code ORDER BY stage.updated_at DESC)
                   FILTER (WHERE stage.safe_error_code IS NOT NULL))[1]
                   AS safe_error_code,
                 (array_agg(
                   stage.stage_kind
                   ORDER BY
                     CASE WHEN stage.state = 'failed' THEN 0 ELSE 1 END,
                     CASE stage.stage_kind
                       WHEN 'extraction' THEN 1
                       WHEN 'reconciliation' THEN 2
                       WHEN 'community' THEN 3
                       WHEN 'embedding' THEN 4
                       WHEN 'vector' THEN 5
                       WHEN 'publication' THEN 6
                       WHEN 'validation' THEN 7
                       ELSE 100
                     END,
                     stage.public_id COLLATE "C"
                 ) FILTER (WHERE stage.state <> 'completed'))[1]
                   AS current_stage_kind
          FROM focowiki.semantic_stage_work_items stage
          WHERE stage.knowledge_base_id = operation.knowledge_base_id
            AND stage.operation_public_id = operation.public_id
        ) semantic ON true
        WHERE operation.knowledge_base_id = ${input.knowledgeBaseId}
          AND operation.operation_kind <> 'semantic_contract_bootstrap'
          AND (${providerStates}::text[] IS NULL OR operation.state = ANY(${providerStates}))
          AND (
            ${cursor?.createdAt ?? null}::timestamptz IS NULL
            OR (operation.created_at, operation.public_id) <
               (${cursor?.createdAt ?? null}::timestamptz, ${cursor?.publicId ?? null}::text)
          )
        ORDER BY operation.created_at DESC, operation.public_id DESC
        LIMIT ${limit + 1}
      `;
      const pageRows = rows.slice(0, limit);
      const last = pageRows.at(-1);
      return {
        items: pageRows.map(mapOperation),
        nextCursor: rows.length > limit && last
          ? encodeCursor({
              version: 1,
              createdAt: last.created_at.toISOString(),
              publicId: last.public_id
            })
          : null
      };
    },

    async get(input) {
      const rows = await sql<OperationRow[]>`
        SELECT operation.public_id, operation.knowledge_base_id,
               operation.operation_kind, operation.state,
               operation.expected_resource_revision, operation.target_kind,
               operation.target_public_id, operation.candidate_relative_path,
               result.result_summary, result.result_code,
               operation.created_at, operation.updated_at, operation.completed_at,
               semantic.total_count AS semantic_total_count,
               semantic.completed_count AS semantic_completed_count,
               semantic.pending_count AS semantic_pending_count,
               semantic.failed_count AS semantic_failed_count,
               semantic.cancelled_count AS semantic_cancelled_count,
               semantic.superseded_count AS semantic_superseded_count,
               semantic.safe_error_code AS semantic_safe_error_code,
               semantic.current_stage_kind AS semantic_current_stage_kind
        FROM focowiki.operations operation
        LEFT JOIN focowiki.operation_results result
          ON result.knowledge_base_id = operation.knowledge_base_id
         AND result.public_id = operation.public_id
        LEFT JOIN LATERAL (
          SELECT count(*) AS total_count,
                 count(*) FILTER (WHERE stage.state = 'completed')
                   AS completed_count,
                 count(*) FILTER (
                   WHERE stage.state IN ('queued', 'running', 'retry')
                 ) AS pending_count,
                 count(*) FILTER (WHERE stage.state = 'failed') AS failed_count,
                 count(*) FILTER (WHERE stage.state = 'cancelled')
                   AS cancelled_count,
                 count(*) FILTER (WHERE stage.state = 'superseded')
                   AS superseded_count,
                 (array_agg(stage.safe_error_code ORDER BY stage.updated_at DESC)
                   FILTER (WHERE stage.safe_error_code IS NOT NULL))[1]
                   AS safe_error_code,
                 (array_agg(
                   stage.stage_kind
                   ORDER BY
                     CASE WHEN stage.state = 'failed' THEN 0 ELSE 1 END,
                     CASE stage.stage_kind
                       WHEN 'extraction' THEN 1
                       WHEN 'reconciliation' THEN 2
                       WHEN 'community' THEN 3
                       WHEN 'embedding' THEN 4
                       WHEN 'vector' THEN 5
                       WHEN 'publication' THEN 6
                       WHEN 'validation' THEN 7
                       ELSE 100
                     END,
                     stage.public_id COLLATE "C"
                 ) FILTER (WHERE stage.state <> 'completed'))[1]
                   AS current_stage_kind
          FROM focowiki.semantic_stage_work_items stage
          WHERE stage.knowledge_base_id = operation.knowledge_base_id
            AND stage.operation_public_id = operation.public_id
        ) semantic ON true
        WHERE operation.knowledge_base_id = ${input.knowledgeBaseId}
          AND operation.public_id = ${input.operationId}
          AND operation.operation_kind <> 'semantic_contract_bootstrap'
        LIMIT 1
      `;
      return rows[0] ? mapOperation(rows[0]) : null;
    }
  };
}

function mapOperation(row: OperationRow): ResourceOperationRecord {
  const state = presentSemanticOperationState(row.state, row);
  return {
    id: row.public_id,
    knowledgeBaseId: row.knowledge_base_id,
    kind: publicKind(row),
    state,
    expectedResourceRevision: row.expected_resource_revision === null
      ? null
      : Number(row.expected_resource_revision),
    candidateCatalogGeneration: row.expected_resource_revision === null
      ? 0
      : Number(row.expected_resource_revision),
    result: presentSemanticOperationResult(record(row.result_summary), row),
    errorCode: state === "failed"
      ? row.semantic_safe_error_code ?? row.result_code
      : row.result_code,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    completedAt: ["completed", "failed", "cancelled", "superseded"].includes(state)
      ? row.completed_at?.toISOString() ?? null
      : null,
    targetKind: row.target_kind,
    targetId: row.target_public_id,
    candidateRelativePath: row.candidate_relative_path
  };
}

export function presentSemanticOperationState(
  operationState: string,
  counts: Pick<
    OperationRow,
    | "semantic_total_count"
    | "semantic_completed_count"
    | "semantic_pending_count"
    | "semantic_failed_count"
    | "semantic_cancelled_count"
    | "semantic_superseded_count"
  >
): ResourceOperationState {
  const base = publicState(operationState);
  if (base !== "completed") return base;
  const total = Number(counts.semantic_total_count ?? 0);
  if (total === 0) return base;
  if (Number(counts.semantic_failed_count ?? 0) > 0) return "failed";
  if (Number(counts.semantic_pending_count ?? 0) > 0) return "processing";
  if (
    Number(counts.semantic_cancelled_count ?? 0)
      + Number(counts.semantic_superseded_count ?? 0) > 0
  ) return "superseded";
  return Number(counts.semantic_completed_count ?? 0) === total
    ? "completed"
    : "processing";
}

export function presentSemanticOperationResult(
  result: Record<string, unknown> | null,
  counts: Pick<
    OperationRow,
    | "semantic_total_count"
    | "semantic_completed_count"
    | "semantic_pending_count"
    | "semantic_failed_count"
    | "semantic_cancelled_count"
    | "semantic_superseded_count"
    | "semantic_safe_error_code"
    | "semantic_current_stage_kind"
  >
): Record<string, unknown> | null {
  const total = Number(counts.semantic_total_count ?? 0);
  if (total === 0) {
    if (!result || typeof result.semanticState !== "string") return result;
    const semanticState = result.semanticState === "queued"
      ? "pending"
      : result.semanticState === "disabled" || result.semanticState === "blocked"
        ? "degraded"
        : result.semanticState;
    return {
      ...result,
      semanticState,
      ...(result.semanticState === "disabled"
        ? { semanticCurrentStage: "semantic_maintenance_required" }
        : {})
    };
  }
  const completed = Number(counts.semantic_completed_count ?? 0);
  const pending = Number(counts.semantic_pending_count ?? 0);
  const failed = Number(counts.semantic_failed_count ?? 0);
  const cancelled = Number(counts.semantic_cancelled_count ?? 0);
  const superseded = Number(counts.semantic_superseded_count ?? 0);
  const semanticState = failed > 0
    ? "failed"
    : pending > 0
      ? "pending"
      : cancelled + superseded > 0
        ? "superseded"
        : completed === total
          ? "completed"
          : "degraded";
  return {
    ...(result ?? {}),
    semanticState,
    semanticCurrentStage: semanticOperationStage(
      counts.semantic_current_stage_kind,
      completed === total
    ),
    semanticSafeCode: counts.semantic_safe_error_code,
    semanticStageTotalCount: total,
    semanticStageCompletedCount: completed,
    semanticStagePendingCount: pending,
    semanticStageFailedCount: failed,
    semanticStageSupersededCount: cancelled + superseded
  };
}

function semanticOperationStage(
  stageKind: string | null,
  completed: boolean
): string {
  if (completed) return "generation_activation";
  if (stageKind === "extraction") return "graphrag_processing";
  if (stageKind === "reconciliation") return "semantic_reconciliation";
  if (stageKind === "embedding") return "embedding_generation";
  if (stageKind === "community" || stageKind === "vector") {
    return "affected_projection";
  }
  if (stageKind === "publication" || stageKind === "validation") {
    return "search_publication";
  }
  return "metadata_resolution";
}

function publicKind(row: OperationRow): ResourceOperationKind {
  if (row.operation_kind === "source_replace") return "source_file_replace";
  if (row.operation_kind === "source_file_move") return "source_file_move";
  if (row.operation_kind === "source_directory_move") return "source_directory_move";
  if (row.operation_kind === "deletion") {
    if (row.target_kind === "knowledge_base") return "knowledge_base_delete";
    if (row.target_kind === "source_directory") return "source_directory_delete";
  }
  return "source_file_delete";
}

function publicState(state: string): ResourceOperationState {
  if (state === "timed_out") return "failed";
  if (state === "deleted") return "cancelled";
  if ([
    "accepted", "validating", "processing", "publishing",
    "completed", "failed", "cancelled", "superseded"
  ].includes(state)) return state as ResourceOperationState;
  throw new Error("Invalid storage vNext operation state");
}

function toProviderStates(state: ResourceOperationState): string[] {
  if (state === "failed") return ["failed", "timed_out"];
  if (state === "cancelled") return ["cancelled", "deleted"];
  return [state];
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function assertLimit(limit: number): number {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
    throw new Error("Invalid storage vNext operation page limit");
  }
  return limit;
}

function encodeCursor(cursor: OperationCursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString("base64url");
}

function decodeCursor(cursor: string | null): OperationCursor | null {
  if (!cursor) return null;
  try {
    const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as Partial<OperationCursor>;
    if (
      value.version !== 1
      || typeof value.createdAt !== "string"
      || !Number.isFinite(Date.parse(value.createdAt))
      || typeof value.publicId !== "string"
      || !value.publicId
    ) throw new Error("invalid");
    return value as OperationCursor;
  } catch {
    throw new SourceResourceError("INVALID_PAGINATION");
  }
}
