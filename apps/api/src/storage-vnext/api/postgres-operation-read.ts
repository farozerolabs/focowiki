import type { DatabaseClient } from "../../db/client.js";
import type {
  ResourceOperationKind,
  ResourceOperationRecord,
  ResourceOperationState
} from "../../domain/source-resource.js";

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
               operation.created_at, operation.updated_at, operation.completed_at
        FROM focowiki.operations operation
        LEFT JOIN focowiki.operation_results result
          ON result.knowledge_base_id = operation.knowledge_base_id
         AND result.public_id = operation.public_id
        WHERE operation.knowledge_base_id = ${input.knowledgeBaseId}
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
               operation.created_at, operation.updated_at, operation.completed_at
        FROM focowiki.operations operation
        LEFT JOIN focowiki.operation_results result
          ON result.knowledge_base_id = operation.knowledge_base_id
         AND result.public_id = operation.public_id
        WHERE operation.knowledge_base_id = ${input.knowledgeBaseId}
          AND operation.public_id = ${input.operationId}
        LIMIT 1
      `;
      return rows[0] ? mapOperation(rows[0]) : null;
    }
  };
}

function mapOperation(row: OperationRow): ResourceOperationRecord {
  return {
    id: row.public_id,
    knowledgeBaseId: row.knowledge_base_id,
    kind: publicKind(row),
    state: publicState(row.state),
    expectedResourceRevision: row.expected_resource_revision === null
      ? null
      : Number(row.expected_resource_revision),
    candidateCatalogGeneration: row.expected_resource_revision === null
      ? 0
      : Number(row.expected_resource_revision),
    result: record(row.result_summary),
    errorCode: row.result_code,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    completedAt: row.completed_at?.toISOString() ?? null,
    targetKind: row.target_kind,
    targetId: row.target_public_id,
    candidateRelativePath: row.candidate_relative_path
  };
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
    throw new Error("Invalid storage vNext operation cursor");
  }
}
