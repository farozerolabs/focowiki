import type { DatabaseClient } from "../../db/client.js";
import type { StorageVnextBoundedMetadata } from "../shared/types.js";
import type { StorageVnextLiveWork } from "../workflow/ports.js";
import {
  MAX_STORAGE_VNEXT_CANDIDATE_CHANGED_FACTS,
  MAX_STORAGE_VNEXT_CANDIDATE_DEPENDENCIES,
  type StorageVnextReleaseReadPort,
  type StorageVnextReleaseWritePort
} from "../release/ports.js";
import {
  createStorageVnextMutationReleaseHandoff,
  planStorageVnextMutationCandidate
} from "./candidate-planning.js";

type ReleasePort = Pick<
  StorageVnextReleaseReadPort & StorageVnextReleaseWritePort,
  "getActiveRoot" | "getLiveCandidate" | "createCandidate" | "addCandidateFacts"
>;

type MutationCheckpoint = StorageVnextBoundedMetadata & {
  version: number;
  kind: string;
  targetKind: string;
  targetPublicId: string;
  expectedResourceRevision: number;
  currentLogicalPath?: string;
  currentNormalizedPath?: string;
  candidateLogicalPath?: string | null;
  candidateRevisionPublicId?: string;
  terminalFailureCode?: "RESOURCE_PATH_CONFLICT";
};

type SourceRow = {
  public_id: string;
  logical_path: string;
};

type DirectoryRow = {
  logical_path: string;
};

export function createPostgresStorageVnextMutationCandidatePreparer(input: {
  sql: DatabaseClient;
  releases: ReleasePort;
  clock(): string;
}) {
  const handoff = createStorageVnextMutationReleaseHandoff(input.releases);
  return {
    async prepare(request: {
      work: StorageVnextLiveWork;
      signal?: AbortSignal;
    }): Promise<{ checkpoint: StorageVnextBoundedMetadata }> {
      assertMutationWork(request.work);
      throwIfAborted(request.signal);
      const checkpoint = parseCheckpoint(request.work.checkpoint);
      if (checkpoint.terminalFailureCode) {
        throw preparerError(checkpoint.terminalFailureCode);
      }
      const scope = await readMutationScope(input.sql, request.work, checkpoint);
      throwIfAborted(request.signal);
      const plan = planStorageVnextMutationCandidate({
        knowledgeBaseId: request.work.knowledgeBaseId,
        operationPublicId: request.work.publicId,
        mutationKind: mutationKind(checkpoint),
        targetKind: targetKind(checkpoint),
        targetPublicId: checkpoint.targetPublicId,
        ...(checkpoint.candidateRevisionPublicId
          ? { candidateRevisionPublicId: checkpoint.candidateRevisionPublicId }
          : {}),
        sourceFilePublicIds: scope.sources.map((source) => source.public_id),
        sourceLogicalPaths: scope.sources.map((source) => candidateSourcePath(
          checkpoint,
          source.logical_path
        )),
        previousSourceLogicalPaths: scope.sources.map((source) => source.logical_path),
        directoryLogicalPaths: scope.directoryPaths,
        graphSourceFilePublicIds: scope.sources.map((source) => source.public_id),
        graphEdgePublicIds: scope.graphEdgePublicIds,
        maximumChangedFacts: MAX_STORAGE_VNEXT_CANDIDATE_CHANGED_FACTS,
        maximumDependencies: MAX_STORAGE_VNEXT_CANDIDATE_DEPENDENCIES
      });
      const candidate = await handoff.apply({
        ...plan,
        idempotency: {
          key: request.work.idempotency.key,
          requestHash: request.work.idempotency.requestHash
        },
        createdAt: input.clock()
      });
      return {
        checkpoint: {
          ...checkpoint,
          phase: "planning",
          candidatePublicId: candidate.candidatePublicId
        }
      };
    }
  };
}

async function readMutationScope(
  sql: DatabaseClient,
  work: StorageVnextLiveWork,
  checkpoint: MutationCheckpoint
): Promise<{
  sources: SourceRow[];
  directoryPaths: string[];
  graphEdgePublicIds: string[];
}> {
  const sources = checkpoint.kind === "knowledge_base_metadata"
    ? []
    : checkpoint.kind === "source_directory_move"
      ? await sql<SourceRow[]>`
          SELECT public_id, logical_path
          FROM focowiki.source_files
          WHERE knowledge_base_id = ${work.knowledgeBaseId}
            AND deleted_at IS NULL
            AND normalized_path LIKE
              ${`${escapeLike(requiredString(checkpoint.currentNormalizedPath))}/%`}
              ESCAPE '\\'
          ORDER BY normalized_path COLLATE "C", public_id COLLATE "C"
        `
      : await sql<SourceRow[]>`
          SELECT public_id, logical_path
          FROM focowiki.source_files
          WHERE knowledge_base_id = ${work.knowledgeBaseId}
            AND public_id = ${checkpoint.targetPublicId}
            AND deleted_at IS NULL
        `;
  if (checkpoint.kind !== "knowledge_base_metadata" && sources.length === 0) {
    throw preparerError("mutation_target_missing");
  }
  const directories = checkpoint.kind === "source_directory_move"
    ? await sql<DirectoryRow[]>`
        SELECT logical_path
        FROM focowiki.source_directories
        WHERE knowledge_base_id = ${work.knowledgeBaseId}
          AND deleted_at IS NULL
          AND (
            normalized_path = ${requiredString(checkpoint.currentNormalizedPath)}
            OR normalized_path LIKE
              ${`${escapeLike(requiredString(checkpoint.currentNormalizedPath))}/%`}
              ESCAPE '\\'
          )
        ORDER BY normalized_path COLLATE "C"
      `
    : [];
  const sourceIds = sources.map((source) => source.public_id);
  const graphEdges = sourceIds.length === 0
    ? []
    : await sql<Array<{ public_id: string }>>`
        SELECT graph_edge.public_id
        FROM (
          SELECT DISTINCT edge.public_id
          FROM focowiki.graph_edges edge
          JOIN focowiki.graph_nodes node
            ON node.knowledge_base_id = edge.knowledge_base_id
           AND node.public_id IN (edge.from_node_public_id, edge.to_node_public_id)
          WHERE edge.knowledge_base_id = ${work.knowledgeBaseId}
            AND node.source_file_public_id = ANY(${sourceIds})
        ) graph_edge
        ORDER BY graph_edge.public_id COLLATE "C"
      `;
  const directoryPaths = directories.flatMap((directory) => [
    directory.logical_path,
    rewritePrefix(
      directory.logical_path,
      requiredString(checkpoint.currentLogicalPath),
      requiredString(checkpoint.candidateLogicalPath)
    )
  ]);
  return {
    sources,
    directoryPaths: stableUnique(directoryPaths),
    graphEdgePublicIds: graphEdges.map((edge) => edge.public_id)
  };
}

function parseCheckpoint(value: StorageVnextBoundedMetadata): MutationCheckpoint {
  if (
    value.version !== 1
    || typeof value.kind !== "string"
    || ![
      "knowledge_base_metadata",
      "source_file_metadata",
      "source_file_move",
      "source_directory_move",
      "source_replace"
    ].includes(value.kind)
    || typeof value.targetKind !== "string"
    || typeof value.targetPublicId !== "string"
    || !Number.isSafeInteger(value.expectedResourceRevision)
    || value.terminalFailureCode !== undefined
      && value.terminalFailureCode !== "RESOURCE_PATH_CONFLICT"
  ) throw preparerError("invalid_checkpoint");
  return value as MutationCheckpoint;
}

function targetKind(
  checkpoint: MutationCheckpoint
): "knowledge_base" | "source_file" | "source_directory" {
  if (checkpoint.targetKind === "knowledge_base") return "knowledge_base";
  if (checkpoint.targetKind === "source_file") return "source_file";
  if (checkpoint.targetKind === "source_directory") return "source_directory";
  throw preparerError("invalid_checkpoint");
}

function mutationKind(
  checkpoint: MutationCheckpoint
): "metadata" | "replacement" | "rename" | "move" {
  if (["knowledge_base_metadata", "source_file_metadata"].includes(checkpoint.kind)) {
    return "metadata";
  }
  if (checkpoint.kind === "source_replace") return "replacement";
  if (checkpoint.kind === "source_directory_move") return "move";
  const currentParent = parentPath(requiredString(checkpoint.currentLogicalPath));
  const candidateParent = parentPath(requiredString(checkpoint.candidateLogicalPath));
  return currentParent === candidateParent ? "rename" : "move";
}

function candidateSourcePath(
  checkpoint: MutationCheckpoint,
  currentLogicalPath: string
): string {
  if (checkpoint.kind === "source_directory_move") {
    return rewritePrefix(
      currentLogicalPath,
      requiredString(checkpoint.currentLogicalPath),
      requiredString(checkpoint.candidateLogicalPath)
    );
  }
  return checkpoint.candidateLogicalPath || currentLogicalPath;
}

function rewritePrefix(value: string, current: string, candidate: string): string {
  if (value === current) return candidate;
  if (!value.startsWith(`${current}/`)) throw preparerError("scope_conflict");
  return `${candidate}${value.slice(current.length)}`;
}

function parentPath(value: string): string {
  return value.split("/").slice(0, -1).join("/");
}

function stableUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right, "en"));
}

function requiredString(value: unknown): string {
  if (typeof value !== "string" || !value) throw preparerError("invalid_checkpoint");
  return value;
}

function assertMutationWork(work: StorageVnextLiveWork): void {
  if (work.kind !== "mutation" || work.state !== "running" || !work.leaseOwner) {
    throw preparerError("invalid_work");
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  throw signal.reason ?? new DOMException("Mutation preparation aborted", "AbortError");
}

function escapeLike(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
}

function preparerError(code: string): Error & { code: string } {
  return Object.assign(
    new Error(`Storage vNext mutation candidate preparer error: ${code}`),
    { code }
  );
}
