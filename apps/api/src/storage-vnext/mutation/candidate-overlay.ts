import type {
  StorageVnextCatalogReadPort,
  StorageVnextCurrentSourceFact,
  StorageVnextSourceRevisionFact
} from "../catalog/ports.js";
import type {
  StorageVnextGraphEdgeFact,
  StorageVnextGraphNodeFact,
  StorageVnextGraphReadPort
} from "../graph/ports.js";
import type { StorageVnextStructuredMetadata } from "../shared/types.js";

export type StorageVnextMutationCandidateOverlay = {
  kind:
    | "knowledge_base_metadata"
    | "source_file_metadata"
    | "source_file_move"
    | "source_directory_move"
    | "source_replace";
  knowledgeBaseId: string;
  targetPublicId: string;
  expectedResourceRevision: number;
  currentLogicalPath?: string;
  currentNormalizedPath?: string;
  candidateLogicalPath?: string | null;
  normalizedCandidatePath?: string | null;
  candidateDirectoryPublicId?: string | null;
  candidateParentPublicId?: string | null;
  candidateRevisionPublicId?: string;
  candidateName?: string;
  candidateDescription?: string | null;
  candidateTitle?: string;
  candidateMetadata?: StorageVnextStructuredMetadata;
};

export function overlayStorageVnextMutationCurrentSource(
  mutation: StorageVnextMutationCandidateOverlay,
  current: StorageVnextCurrentSourceFact,
  candidateRevision?: StorageVnextSourceRevisionFact
): StorageVnextCurrentSourceFact {
  assertScope(mutation, current.sourceFile.knowledgeBaseId);
  const source = current.sourceFile;
  const path = candidateSourcePath(mutation, source.publicId, source.logicalPath);
  const normalizedPath = candidateNormalizedSourcePath(
    mutation,
    source.publicId,
    source.normalizedPath
  );
  const targeted = source.publicId === mutation.targetPublicId;
  const metadataChanged = mutation.kind === "source_file_metadata" && targeted;
  const replacement = mutation.kind === "source_replace" && targeted;
  const changed = path !== source.logicalPath
    || normalizedPath !== source.normalizedPath
    || metadataChanged
    || replacement;
  if (!changed) return current;
  if (replacement && (
    !candidateRevision
    || candidateRevision.publicId !== mutation.candidateRevisionPublicId
    || candidateRevision.knowledgeBaseId !== mutation.knowledgeBaseId
    || candidateRevision.sourceFilePublicId !== source.publicId
  )) throw overlayError("candidate_revision_missing");
  return {
    sourceFile: {
      ...source,
      logicalPath: path,
      normalizedPath,
      directoryPublicId: targeted && (
        mutation.kind === "source_file_move"
        || mutation.kind === "source_replace"
      ) && mutation.candidateLogicalPath
        ? mutation.candidateDirectoryPublicId ?? null
        : source.directoryPublicId,
      title: metadataChanged
        ? mutation.candidateTitle ?? source.title
        : source.title,
      metadata: metadataChanged
        ? mutation.candidateMetadata ?? source.metadata
        : source.metadata,
      currentRevisionPublicId: replacement
        ? candidateRevision!.publicId
        : source.currentRevisionPublicId,
      revision: source.revision + 1
    },
    sourceRevision: replacement ? candidateRevision! : current.sourceRevision
  };
}

export function overlayStorageVnextMutationGraphNode(
  mutation: StorageVnextMutationCandidateOverlay,
  node: StorageVnextGraphNodeFact
): StorageVnextGraphNodeFact {
  assertScope(mutation, node.knowledgeBaseId);
  const path = candidateGraphPath(mutation, node.sourceFilePublicId, node.logicalPath);
  const replacement = mutation.kind === "source_replace"
    && node.sourceFilePublicId === mutation.targetPublicId;
  if (path === node.logicalPath && !replacement) return node;
  const sourceRevisionPublicId = replacement
    ? requiredString(mutation.candidateRevisionPublicId)
    : node.sourceRevisionPublicId;
  return {
    ...node,
    logicalPath: path,
    sourceRevisionPublicId,
    evidence: node.evidence.map((evidence) => ({
      ...evidence,
      logicalPath: candidateGraphPath(
        mutation,
        evidence.sourceFilePublicId,
        evidence.logicalPath
      ),
      sourceRevisionPublicId:
        replacement && evidence.sourceFilePublicId === mutation.targetPublicId
          ? sourceRevisionPublicId
          : evidence.sourceRevisionPublicId
    })),
    revision: node.revision + 1
  };
}

export function overlayStorageVnextMutationGraphEdge(
  mutation: StorageVnextMutationCandidateOverlay,
  edge: StorageVnextGraphEdgeFact
): StorageVnextGraphEdgeFact {
  assertScope(mutation, edge.knowledgeBaseId);
  const evidence = edge.evidence.map((item) => {
    const logicalPath = candidateGraphPath(
      mutation,
      item.sourceFilePublicId,
      item.logicalPath
    );
    const replacement = mutation.kind === "source_replace"
      && item.sourceFilePublicId === mutation.targetPublicId;
    if (logicalPath === item.logicalPath && !replacement) return item;
    return {
      ...item,
      logicalPath,
      sourceRevisionPublicId: replacement
        ? requiredString(mutation.candidateRevisionPublicId)
        : item.sourceRevisionPublicId
    };
  });
  return evidence.every((item, index) => item === edge.evidence[index])
    ? edge
    : { ...edge, evidence, revision: edge.revision + 1 };
}

export function createStorageVnextMutationCandidateCatalog(input: {
  mutation: StorageVnextMutationCandidateOverlay;
  catalog: Pick<
    StorageVnextCatalogReadPort,
    "listCurrentSources" | "getSourceRevision"
  >;
}): Pick<StorageVnextCatalogReadPort, "listCurrentSources"> {
  return {
    async listCurrentSources(request) {
      assertScope(input.mutation, request.knowledgeBaseId);
      const page = await input.catalog.listCurrentSources(request);
      let candidateRevision: StorageVnextSourceRevisionFact | undefined;
      if (input.mutation.kind === "source_replace"
        && page.items.some((item) =>
          item.sourceFile.publicId === input.mutation.targetPublicId)) {
        candidateRevision = await input.catalog.getSourceRevision({
          knowledgeBaseId: input.mutation.knowledgeBaseId,
          publicId: requiredString(input.mutation.candidateRevisionPublicId)
        }) ?? undefined;
      }
      return {
        items: page.items.map((current) =>
          overlayStorageVnextMutationCurrentSource(
            input.mutation,
            current,
            current.sourceFile.publicId === input.mutation.targetPublicId
              ? candidateRevision
              : undefined
          )),
        nextCursor: page.nextCursor
      };
    }
  };
}

export function createStorageVnextMutationCandidateGraph(input: {
  mutation: StorageVnextMutationCandidateOverlay;
  graph: Pick<StorageVnextGraphReadPort, "listNodes">;
}): Pick<StorageVnextGraphReadPort, "listNodes"> {
  return {
    async listNodes(request) {
      assertScope(input.mutation, request.knowledgeBaseId);
      const page = await input.graph.listNodes(request);
      return {
        items: page.items.map((node) =>
          overlayStorageVnextMutationGraphNode(input.mutation, node)),
        nextCursor: page.nextCursor
      };
    }
  };
}

function candidateSourcePath(
  mutation: StorageVnextMutationCandidateOverlay,
  sourceFilePublicId: string,
  currentPath: string
): string {
  if ((mutation.kind === "source_file_move" || mutation.kind === "source_replace")
    && sourceFilePublicId === mutation.targetPublicId
    && mutation.candidateLogicalPath) {
    return mutation.candidateLogicalPath;
  }
  if (mutation.kind === "source_directory_move") {
    return rewritePrefix(
      currentPath,
      requiredString(mutation.currentLogicalPath),
      requiredString(mutation.candidateLogicalPath)
    );
  }
  return currentPath;
}

function candidateNormalizedSourcePath(
  mutation: StorageVnextMutationCandidateOverlay,
  sourceFilePublicId: string,
  currentPath: string
): string {
  if ((mutation.kind === "source_file_move" || mutation.kind === "source_replace")
    && sourceFilePublicId === mutation.targetPublicId
    && mutation.normalizedCandidatePath) {
    return mutation.normalizedCandidatePath;
  }
  if (mutation.kind === "source_directory_move") {
    return rewritePrefix(
      currentPath,
      requiredString(mutation.currentNormalizedPath),
      requiredString(mutation.normalizedCandidatePath)
    );
  }
  return currentPath;
}

function candidateGraphPath(
  mutation: StorageVnextMutationCandidateOverlay,
  sourceFilePublicId: string,
  currentPath: string
): string {
  if (mutation.kind === "source_directory_move") {
    return rewriteRawOrGeneratedPrefix(
      currentPath,
      requiredString(mutation.currentLogicalPath),
      requiredString(mutation.candidateLogicalPath)
    );
  }
  if ((mutation.kind === "source_file_move" || mutation.kind === "source_replace")
    && sourceFilePublicId === mutation.targetPublicId
    && mutation.candidateLogicalPath) {
    return rewriteRawOrGeneratedPrefix(
      currentPath,
      requiredString(mutation.currentLogicalPath),
      mutation.candidateLogicalPath
    );
  }
  return currentPath;
}

function rewriteRawOrGeneratedPrefix(
  value: string,
  currentPrefix: string,
  candidatePrefix: string
): string {
  const raw = rewritePrefix(value, currentPrefix, candidatePrefix);
  if (raw !== value) return raw;
  return rewritePrefix(
    value,
    `pages/${currentPrefix}`,
    `pages/${candidatePrefix}`
  );
}

function rewritePrefix(
  value: string,
  currentPrefix: string,
  candidatePrefix: string
): string {
  if (value === currentPrefix) return candidatePrefix;
  return value.startsWith(`${currentPrefix}/`)
    ? `${candidatePrefix}${value.slice(currentPrefix.length)}`
    : value;
}

function assertScope(
  mutation: StorageVnextMutationCandidateOverlay,
  knowledgeBaseId: string
): void {
  if (!mutation.knowledgeBaseId || mutation.knowledgeBaseId !== knowledgeBaseId) {
    throw overlayError("scope_conflict");
  }
}

function requiredString(value: string | null | undefined): string {
  if (!value) throw overlayError("candidate_state_invalid");
  return value;
}

function overlayError(code: string): Error {
  return Object.assign(new Error(`Storage vNext mutation overlay error: ${code}`), {
    code
  });
}
