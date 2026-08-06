import type {
  StorageVnextCatalogReadPort,
  StorageVnextCurrentSourceFact
} from "../catalog/ports.js";
import type {
  StorageVnextSourceBodyReadPort
} from "../catalog/s3-source-body-store.js";
import type {
  StorageVnextGraphEdgeFact,
  StorageVnextGraphNodeFact,
  StorageVnextGraphReadPort,
  StorageVnextGraphWritePort
} from "../graph/ports.js";
import type {
  StorageVnextCandidateChangedFact,
  StorageVnextCandidateDependency,
  StorageVnextReleaseReadPort,
  StorageVnextReleaseWritePort
} from "../release/ports.js";

type ReconciliationRequest = {
  knowledgeBaseId: string;
  candidatePublicId: string;
  operationPublicId: string;
  searchProjectionPublicId: string;
  signal: AbortSignal;
};

export function createStorageVnextPublicationGraphReconciler(input: {
  releases: Pick<
    StorageVnextReleaseReadPort & StorageVnextReleaseWritePort,
    "listCandidateDependencies" | "addCandidateFacts"
  >;
  catalog: Pick<
    StorageVnextCatalogReadPort,
    "listSourceFilesByPublicIds" | "getCurrentSourceRevision"
  >;
  sourceBodies: StorageVnextSourceBodyReadPort;
  graph: Pick<
    StorageVnextGraphReadPort & StorageVnextGraphWritePort,
    "listBySourceFile" | "listNeighborhood" | "replaceSourceFileGraph"
  >;
  reconcileEdges(request: {
    current: StorageVnextCurrentSourceFact;
    node: StorageVnextGraphNodeFact;
    body: string;
    searchProjectionPublicId: string;
    signal: AbortSignal;
  }): Promise<
    | readonly StorageVnextGraphEdgeFact[]
    | {
        node: StorageVnextGraphNodeFact;
        edges: readonly StorageVnextGraphEdgeFact[];
      }
  >;
  sourcePageSize: number;
  sourceConcurrency: number;
  maximumSourceBytes: number;
}) {
  validateLimits(input);
  async function reconcileSource(
    request: ReconciliationRequest,
    sourceById: ReadonlyMap<string, StorageVnextCurrentSourceFact["sourceFile"]>,
    sourceFilePublicId: string
  ): Promise<number | null> {
    throwIfAborted(request.signal);
    const sourceFile = sourceById.get(sourceFilePublicId);
    if (!sourceFile) return null;
    const sourceRevision = await input.catalog.getCurrentSourceRevision({
      knowledgeBaseId: request.knowledgeBaseId,
      sourceFilePublicId
    });
    if (!sourceRevision) throw reconciliationError("source_fact_conflict");
    const current = { sourceFile, sourceRevision };
    assertCurrentSource(request.knowledgeBaseId, current);
    const node = await requireCurrentNode(input.graph, current);
    const chunks = await input.sourceBodies.readVerifiedStream({
      objectId: current.sourceRevision.objectId,
      checksum: current.sourceRevision.checksum,
      byteCount: current.sourceRevision.byteCount,
      contentType: current.sourceRevision.contentType,
      maxBytes: input.maximumSourceBytes,
      signal: request.signal
    });
    const body = await readUtf8(chunks, request.signal);
    const previousEdges = await listOutboundEdges(
      input.graph,
      request.knowledgeBaseId,
      node.publicId,
      request.signal
    );
    const reconciliation = await input.reconcileEdges({
      current,
      node,
      body,
      searchProjectionPublicId: request.searchProjectionPublicId,
      signal: request.signal
    });
    const reconciledNode = "node" in reconciliation
      ? reconciliation.node
      : node;
    const edges = "edges" in reconciliation
      ? reconciliation.edges
      : reconciliation;
    throwIfAborted(request.signal);
    const delta = graphEdgeDelta(previousEdges, edges);
    if (delta.changedFacts.length > 0) {
      await input.releases.addCandidateFacts({
        candidatePublicId: request.candidatePublicId,
        changedFacts: delta.changedFacts,
        dependencies: delta.dependencies
      });
    }
    await input.graph.replaceSourceFileGraph({
      knowledgeBaseId: request.knowledgeBaseId,
      sourceFilePublicId: current.sourceFile.publicId,
      sourceRevisionPublicId: current.sourceRevision.publicId,
      node: reconciledNode,
      edges
    });
    return edges.length;
  }

  return {
    async reconcile(request: ReconciliationRequest): Promise<{
      sourceCount: number;
      edgeCount: number;
    }> {
      validateRequest(request);
      let sourceCount = 0;
      let edgeCount = 0;
      let cursor: string | null = null;
      do {
        throwIfAborted(request.signal);
        const page = await input.releases.listCandidateDependencies({
          candidatePublicId: request.candidatePublicId,
          limit: input.sourcePageSize,
          cursor
        });
        if (page.items.length > input.sourcePageSize) {
          throw reconciliationError("source_page_overflow");
        }
        const sourceFilePublicIds = page.items.flatMap((dependency) =>
          dependency.kind === "search" ? [dependency.publicId] : []);
        const sourceFiles = sourceFilePublicIds.length === 0
          ? []
          : await input.catalog.listSourceFilesByPublicIds({
              knowledgeBaseId: request.knowledgeBaseId,
              publicIds: sourceFilePublicIds,
              limit: sourceFilePublicIds.length
            });
        const sourceById = new Map(sourceFiles.map((source) => [source.publicId, source]));
        const results = await mapWithConcurrency(
          sourceFilePublicIds,
          input.sourceConcurrency,
          (sourceFilePublicId) => reconcileSource(
            request,
            sourceById,
            sourceFilePublicId
          )
        );
        for (const result of results) {
          if (result === null) continue;
          sourceCount += 1;
          edgeCount += result;
        }
        cursor = advancingCursor(cursor, page.nextCursor);
      } while (cursor !== null);
      return { sourceCount, edgeCount };
    }
  };
}

async function listOutboundEdges(
  graph: Pick<StorageVnextGraphReadPort, "listNeighborhood">,
  knowledgeBaseId: string,
  nodePublicId: string,
  signal: AbortSignal
): Promise<StorageVnextGraphEdgeFact[]> {
  const edges = new Map<string, StorageVnextGraphEdgeFact>();
  let cursor: string | null = null;
  do {
    throwIfAborted(signal);
    const page = await graph.listNeighborhood({
      knowledgeBaseId,
      nodePublicId,
      depth: 1,
      limit: 1_000,
      cursor
    });
    for (const edge of page.items) {
      if (edge.knowledgeBaseId !== knowledgeBaseId) {
        throw reconciliationError("graph_scope_conflict");
      }
      if (edge.fromNodePublicId === nodePublicId) edges.set(edge.publicId, edge);
    }
    cursor = advancingCursor(cursor, page.nextCursor);
  } while (cursor !== null);
  return [...edges.values()];
}

function graphEdgeDelta(
  previous: readonly StorageVnextGraphEdgeFact[],
  current: readonly StorageVnextGraphEdgeFact[]
): {
  changedFacts: StorageVnextCandidateChangedFact[];
  dependencies: StorageVnextCandidateDependency[];
} {
  const currentIds = new Set(current.map((edge) => edge.publicId));
  const changedFacts: StorageVnextCandidateChangedFact[] = [
    ...current.map((edge) => ({
      kind: "graph_edge" as const,
      publicId: edge.publicId,
      change: "updated" as const
    })),
    ...previous
      .filter((edge) => !currentIds.has(edge.publicId))
      .map((edge) => ({
        kind: "graph_edge" as const,
        publicId: edge.publicId,
        change: "deleted" as const
      }))
  ].sort((left, right) => left.publicId.localeCompare(right.publicId, "en"));
  const edgeIds = [...new Set(changedFacts.map((fact) => fact.publicId))].sort();
  const dependencies = edgeIds.flatMap((publicId) => [
    { kind: "graph" as const, publicId, reasonCode: "graph_edge" },
    { kind: "link" as const, publicId, reasonCode: "graph_edge" }
  ]);
  return { changedFacts, dependencies };
}

async function requireCurrentNode(
  graph: Pick<StorageVnextGraphReadPort, "listBySourceFile">,
  current: StorageVnextCurrentSourceFact
): Promise<StorageVnextGraphNodeFact> {
  const page = await graph.listBySourceFile({
    knowledgeBaseId: current.sourceFile.knowledgeBaseId,
    sourceFilePublicId: current.sourceFile.publicId,
    limit: 2,
    cursor: null
  });
  const node = page.items[0];
  if (
    page.items.length !== 1
    || page.nextCursor !== null
    || !node
    || node.knowledgeBaseId !== current.sourceFile.knowledgeBaseId
    || node.sourceFilePublicId !== current.sourceFile.publicId
    || node.sourceRevisionPublicId !== current.sourceRevision.publicId
    || node.logicalPath !== `pages/${current.sourceFile.logicalPath}`
  ) throw reconciliationError("graph_source_conflict");
  return node;
}

async function readUtf8(
  chunks: AsyncIterable<Uint8Array>,
  signal: AbortSignal
): Promise<string> {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const output: string[] = [];
  for await (const chunk of chunks) {
    throwIfAborted(signal);
    output.push(decoder.decode(chunk, { stream: true }));
  }
  output.push(decoder.decode());
  return output.join("");
}

function assertCurrentSource(
  knowledgeBaseId: string,
  current: StorageVnextCurrentSourceFact
): void {
  if (
    current.sourceFile.knowledgeBaseId !== knowledgeBaseId
    || current.sourceRevision.knowledgeBaseId !== knowledgeBaseId
    || current.sourceRevision.sourceFilePublicId !== current.sourceFile.publicId
    || current.sourceFile.currentRevisionPublicId !== current.sourceRevision.publicId
    || current.sourceFile.visibility !== "current"
  ) throw reconciliationError("source_fact_conflict");
}

function validateRequest(request: ReconciliationRequest): void {
  for (const value of [
    request.knowledgeBaseId,
    request.candidatePublicId,
    request.operationPublicId,
    request.searchProjectionPublicId
  ]) {
    if (!value || Buffer.byteLength(value) > 255) {
      throw reconciliationError("invalid_request");
    }
  }
  if (request.candidatePublicId !== request.searchProjectionPublicId) {
    throw reconciliationError("search_projection_conflict");
  }
}

function validateLimits(input: {
  sourcePageSize: number;
  sourceConcurrency: number;
  maximumSourceBytes: number;
}): void {
  if (
    !Number.isSafeInteger(input.sourcePageSize)
    || input.sourcePageSize < 1
    || input.sourcePageSize > 1_000
    || !Number.isSafeInteger(input.sourceConcurrency)
    || input.sourceConcurrency < 1
    || input.sourceConcurrency > 32
    || !Number.isSafeInteger(input.maximumSourceBytes)
    || input.maximumSourceBytes < 1
  ) throw reconciliationError("invalid_configuration");
}

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  run: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = [];
  for (let offset = 0; offset < items.length; offset += concurrency) {
    results.push(...await Promise.all(
      items.slice(offset, offset + concurrency).map(run)
    ));
  }
  return results;
}

function advancingCursor(previous: string | null, next: string | null): string | null {
  if (next !== null && next === previous) {
    throw reconciliationError("source_cursor_stalled");
  }
  return next;
}

function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  throw new DOMException("Storage vNext graph reconciliation aborted", "AbortError");
}

function reconciliationError(code: string): Error & { code: string } {
  return Object.assign(
    new Error(`Storage vNext publication graph reconciliation error: ${code}`),
    { code }
  );
}
