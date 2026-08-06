import type { GeneratedPageSummary } from "../../okf/publication-files.js";
import type { StorageVnextCurrentSourceFact } from "../catalog/ports.js";
import type { StorageVnextSourceBodyReadPort } from
  "../catalog/s3-source-body-store.js";
import type {
  StorageVnextGraphEdgeFact,
  StorageVnextGraphNodeFact,
  StorageVnextGraphReadPort
} from "../graph/ports.js";
import { renderStorageVnextPageArtifact } from "../publication/rendering.js";
import type { StorageVnextPublicationArtifact } from "../publication/types.js";

type CurrentPageFact = {
  source: StorageVnextCurrentSourceFact;
  page: GeneratedPageSummary;
};

type ProjectionRepairCursor = {
  version: 1;
  stage: "source" | "node" | "edge";
  cursor: string | null;
};

type ProjectionRepairWriter = {
  writePageBatch(input: {
    knowledgeBaseId: string;
    candidatePublicId: string;
    operationPublicId: string;
    batchOrdinal: number;
    artifacts: readonly StorageVnextPublicationArtifact[];
  }): Promise<void>;
  writeGraphBatch(input: {
    knowledgeBaseId: string;
    candidatePublicId: string;
    operationPublicId: string;
    batchOrdinal: number;
    nodes: readonly StorageVnextGraphNodeFact[];
    edges: readonly StorageVnextGraphEdgeFact[];
  }): Promise<void>;
  finalizeCurrentFacts(input: {
    knowledgeBaseId: string;
    candidatePublicId: string;
    operationPublicId: string;
  }): Promise<void>;
};

export function createStorageVnextMaintenanceProjectionRepair(input: {
  pages: {
    listCurrentPages(request: {
      knowledgeBaseId: string;
      limit: number;
      cursor: string | null;
    }): Promise<{ items: readonly CurrentPageFact[]; nextCursor: string | null }>;
  };
  sourceBodies: StorageVnextSourceBodyReadPort;
  graph: Pick<StorageVnextGraphReadPort, "listNodes" | "listEdges">;
  writer: ProjectionRepairWriter;
  limits: { pageSize: number; graphPageSize: number; maxSourceBytes: number };
}) {
  validateLimits(input.limits);
  return {
    async runPage(request: {
      knowledgeBaseId: string;
      candidatePublicId: string;
      operationPublicId: string;
      cursor: string | null;
      batchOrdinal: number;
      signal?: AbortSignal;
    }) {
      validateRequest(request);
      const cursor = decodeCursor(request.cursor) ?? {
        version: 1 as const,
        stage: "source" as const,
        cursor: null
      };
      if (cursor.stage === "source") {
        return repairSourcePage(input, request, cursor.cursor);
      }
      return repairGraphPage(input, request, cursor);
    }
  };
}

async function repairSourcePage(
  input: Parameters<typeof createStorageVnextMaintenanceProjectionRepair>[0],
  request: {
    knowledgeBaseId: string;
    candidatePublicId: string;
    operationPublicId: string;
    batchOrdinal: number;
    signal?: AbortSignal;
  },
  cursor: string | null
) {
  throwIfAborted(request.signal);
  const page = await input.pages.listCurrentPages({
    knowledgeBaseId: request.knowledgeBaseId,
    limit: input.limits.pageSize,
    cursor
  });
  const artifacts: StorageVnextPublicationArtifact[] = [];
  let processedBytes = 0;
  for (const [index, item] of page.items.entries()) {
    assertCurrentPage(request.knowledgeBaseId, item);
    const chunks = await input.sourceBodies.readVerifiedStream({
      objectId: item.source.sourceRevision.objectId,
      checksum: item.source.sourceRevision.checksum,
      byteCount: item.source.sourceRevision.byteCount,
      contentType: item.source.sourceRevision.contentType,
      maxBytes: input.limits.maxSourceBytes,
      ...(request.signal ? { signal: request.signal } : {})
    });
    const sourceBody = await readUtf8(chunks, input.limits.maxSourceBytes, request.signal);
    artifacts.push(renderStorageVnextPageArtifact({
      page: item.page,
      sourceBody,
      ordinal: request.batchOrdinal + index
    }));
    processedBytes += item.source.sourceRevision.byteCount;
  }
  if (artifacts.length > 0) {
    await input.writer.writePageBatch({
      knowledgeBaseId: request.knowledgeBaseId,
      candidatePublicId: request.candidatePublicId,
      operationPublicId: request.operationPublicId,
      batchOrdinal: request.batchOrdinal,
      artifacts
    });
  }
  return {
    outcome: "progress" as const,
    cursor: page.nextCursor === null
      ? encodeCursor({ version: 1, stage: "node", cursor: null })
      : encodeCursor({ version: 1, stage: "source", cursor: page.nextCursor }),
    completedDelta: page.items.length,
    expectedCount: page.items.length,
    processedBytesDelta: processedBytes,
    batchOrdinalDelta: artifacts.length
  };
}

async function repairGraphPage(
  input: Parameters<typeof createStorageVnextMaintenanceProjectionRepair>[0],
  request: {
    knowledgeBaseId: string;
    candidatePublicId: string;
    operationPublicId: string;
    batchOrdinal: number;
    signal?: AbortSignal;
  },
  cursor: ProjectionRepairCursor
) {
  throwIfAborted(request.signal);
  const page = cursor.stage === "node"
    ? await input.graph.listNodes({
        knowledgeBaseId: request.knowledgeBaseId,
        limit: input.limits.graphPageSize,
        cursor: cursor.cursor
      })
    : await input.graph.listEdges({
        knowledgeBaseId: request.knowledgeBaseId,
        limit: input.limits.graphPageSize,
        cursor: cursor.cursor
      });
  const nodes = cursor.stage === "node"
    ? page.items as readonly StorageVnextGraphNodeFact[]
    : [];
  const edges = cursor.stage === "edge"
    ? page.items as readonly StorageVnextGraphEdgeFact[]
    : [];
  if (page.items.length > 0) {
    await input.writer.writeGraphBatch({
      knowledgeBaseId: request.knowledgeBaseId,
      candidatePublicId: request.candidatePublicId,
      operationPublicId: request.operationPublicId,
      batchOrdinal: request.batchOrdinal,
      nodes,
      edges
    });
  }
  const stageCompleted = page.nextCursor === null;
  const allCompleted = cursor.stage === "edge" && stageCompleted;
  if (allCompleted) {
    await input.writer.finalizeCurrentFacts({
      knowledgeBaseId: request.knowledgeBaseId,
      candidatePublicId: request.candidatePublicId,
      operationPublicId: request.operationPublicId
    });
  }
  const nextCursor = allCompleted
    ? null
    : stageCompleted
      ? encodeCursor({ version: 1, stage: "edge", cursor: null })
      : encodeCursor({
          version: 1,
          stage: cursor.stage,
          cursor: page.nextCursor
        });
  return {
    outcome: allCompleted ? "phase_completed" as const : "progress" as const,
    cursor: nextCursor,
    completedDelta: page.items.length,
    expectedCount: page.items.length,
    processedBytesDelta: Buffer.byteLength(JSON.stringify(page.items)),
    batchOrdinalDelta: page.items.length > 0 ? 1 : 0
  };
}

function assertCurrentPage(knowledgeBaseId: string, item: CurrentPageFact): void {
  if (
    item.source.sourceFile.knowledgeBaseId !== knowledgeBaseId
    || item.source.sourceRevision.knowledgeBaseId !== knowledgeBaseId
    || item.source.sourceFile.currentRevisionPublicId
      !== item.source.sourceRevision.publicId
    || item.source.sourceFile.visibility !== "current"
    || item.page.fileId !== item.source.sourceFile.publicId
  ) throw projectionRepairError("scope_conflict");
}

async function readUtf8(
  chunks: AsyncIterable<Uint8Array>,
  maximumBytes: number,
  signal: AbortSignal | undefined
): Promise<string> {
  const parts: Uint8Array[] = [];
  let bytes = 0;
  for await (const chunk of chunks) {
    throwIfAborted(signal);
    bytes += chunk.byteLength;
    if (bytes > maximumBytes) throw projectionRepairError("source_too_large");
    parts.push(chunk);
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(parts));
  } catch {
    throw projectionRepairError("invalid_source_utf8");
  }
}

function encodeCursor(cursor: ProjectionRepairCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeCursor(value: string | null): ProjectionRepairCursor | null {
  if (!value) return null;
  try {
    const decoded = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (
      decoded?.version === 1
      && ["source", "node", "edge"].includes(decoded.stage)
      && (decoded.cursor === null || typeof decoded.cursor === "string")
    ) return decoded as ProjectionRepairCursor;
  } catch {
    // Mapped to one stable input error below.
  }
  throw projectionRepairError("invalid_cursor");
}

function validateLimits(limits: {
  pageSize: number;
  graphPageSize: number;
  maxSourceBytes: number;
}): void {
  if (
    !Number.isSafeInteger(limits.pageSize)
    || limits.pageSize < 1
    || limits.pageSize > 1_000
    || !Number.isSafeInteger(limits.graphPageSize)
    || limits.graphPageSize < 1
    || limits.graphPageSize > 1_000
    || !Number.isSafeInteger(limits.maxSourceBytes)
    || limits.maxSourceBytes < 1
  ) throw projectionRepairError("invalid_configuration");
}

function validateRequest(request: {
  knowledgeBaseId: string;
  candidatePublicId: string;
  operationPublicId: string;
  batchOrdinal: number;
}): void {
  for (const value of [
    request.knowledgeBaseId,
    request.candidatePublicId,
    request.operationPublicId
  ]) {
    if (!value || Buffer.byteLength(value) > 255) {
      throw projectionRepairError("invalid_input");
    }
  }
  if (!Number.isSafeInteger(request.batchOrdinal) || request.batchOrdinal < 0) {
    throw projectionRepairError("invalid_input");
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw signal.reason ?? projectionRepairError("aborted");
}

function projectionRepairError(code: string): Error {
  return Object.assign(
    new Error(`Storage vNext maintenance projection repair error: ${code}`),
    { code }
  );
}
