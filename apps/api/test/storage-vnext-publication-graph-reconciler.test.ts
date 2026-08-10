import { describe, expect, it, vi } from "vitest";
import {
  createStorageVnextPublicationGraphReconciler
} from "../src/storage-vnext/publication/graph-reconciler.js";
import type {
  StorageVnextCurrentSourceFact
} from "../src/storage-vnext/catalog/ports.js";
import type {
  StorageVnextGraphNodeFact
} from "../src/storage-vnext/graph/ports.js";

describe("storage vNext publication graph reconciler", () => {
  it("reconciles only candidate source dependencies in bounded pages without changing stored nodes", async () => {
    const sources = [currentSource("alpha"), currentSource("beta")];
    const nodes = new Map(sources.map((source) => [
      source.sourceFile.publicId,
      graphNode(source)
    ]));
    const listCandidateDependencies = vi.fn(async (input: { cursor: string | null }) =>
      input.cursor === null
        ? {
            items: [{ kind: "search" as const, publicId: "source-alpha", reasonCode: "search_document" }],
            nextCursor: "next"
          }
        : {
            items: [{ kind: "search" as const, publicId: "source-beta", reasonCode: "search_document" }],
            nextCursor: null
          });
    const replaceSourceFileGraph = vi.fn(async () => undefined);
    const addCandidateFacts = vi.fn(async () => candidateDelta());
    const reconcileEdges = vi.fn(async (input: { node: StorageVnextGraphNodeFact }) => [{
      publicId: `edge-${input.node.sourceFilePublicId}`,
      knowledgeBaseId: "kb-one",
      fromNodePublicId: input.node.publicId,
      toNodePublicId: input.node.publicId,
      relation: "self-test",
      weight: 1,
      reason: null,
      evidence: [],
      revision: 1
    }]);
    const reconciler = createStorageVnextPublicationGraphReconciler({
      releases: { listCandidateDependencies, addCandidateFacts },
      catalog: {
        listSourceFilesByPublicIds: vi.fn(async (input: { publicIds: readonly string[] }) =>
          sources
            .map((source) => source.sourceFile)
            .filter((source) => input.publicIds.includes(source.publicId))),
        getCurrentSourceRevision: vi.fn(async (input: { sourceFilePublicId: string }) =>
          sources.find((source) => source.sourceFile.publicId === input.sourceFilePublicId)
            ?.sourceRevision ?? null)
      },
      sourceBodies: {
        readVerifiedStream: vi.fn(async (input: { objectId: string }) =>
          bytes(`# ${input.objectId}\n`))
      },
      graph: {
        listBySourceFile: vi.fn(async (input: { sourceFilePublicId: string }) => ({
          items: [nodes.get(input.sourceFilePublicId)!],
          nextCursor: null
        })),
        listNeighborhood: vi.fn(async (input: { nodePublicId: string }) => ({
          items: [{
            publicId: `old-edge-${input.nodePublicId}`,
            knowledgeBaseId: "kb-one",
            fromNodePublicId: input.nodePublicId,
            toNodePublicId: input.nodePublicId,
            relation: "old-test",
            weight: 1,
            reason: null,
            evidence: [],
            revision: 1
          }],
          nextCursor: null
        })),
        replaceSourceFileGraph
      },
      reconcileEdges,
      sourcePageSize: 1,
      sourceConcurrency: 1,
      maximumSourceBytes: 1_024
    });
    const signal = new AbortController().signal;

    await expect(reconciler.reconcile({
      knowledgeBaseId: "kb-one",
      candidatePublicId: "candidate-one",
      operationPublicId: "publication-one",
      searchProjectionPublicId: "candidate-one",
      signal
    })).resolves.toEqual({ sourceCount: 2, edgeCount: 2 });

    expect(listCandidateDependencies).toHaveBeenCalledTimes(2);
    expect(reconcileEdges).toHaveBeenCalledTimes(2);
    expect(addCandidateFacts).toHaveBeenCalledWith({
      candidatePublicId: "candidate-one",
      changedFacts: expect.arrayContaining([
        { kind: "graph_edge", publicId: "edge-source-alpha", change: "updated" },
        { kind: "graph_edge", publicId: "old-edge-node-source-alpha", change: "deleted" }
      ]),
      dependencies: expect.arrayContaining([
        {
          kind: "graph",
          publicId: "edge-source-alpha",
          reasonCode: "graph_edge"
        },
        {
          kind: "link",
          publicId: "old-edge-node-source-alpha",
          reasonCode: "graph_edge"
        }
      ])
    });
    expect(replaceSourceFileGraph).toHaveBeenNthCalledWith(1, {
      knowledgeBaseId: "kb-one",
      sourceFilePublicId: "source-alpha",
      sourceRevisionPublicId: "revision-alpha",
      node: nodes.get("source-alpha"),
      edges: [expect.objectContaining({ publicId: "edge-source-alpha" })]
    });
  });

  it("rejects a graph node that no longer matches the current source revision", async () => {
    const source = currentSource("alpha");
    const node = { ...graphNode(source), sourceRevisionPublicId: "revision-old" };
    const reconciler = createStorageVnextPublicationGraphReconciler({
      releases: {
        listCandidateDependencies: vi.fn(async () => ({
          items: [{
            kind: "search" as const,
            publicId: "source-alpha",
            reasonCode: "search_document"
          }],
          nextCursor: null
        })),
        addCandidateFacts: vi.fn()
      },
      catalog: {
        listSourceFilesByPublicIds: vi.fn(async () => [source.sourceFile]),
        getCurrentSourceRevision: vi.fn(async () => source.sourceRevision)
      },
      sourceBodies: { readVerifiedStream: vi.fn() },
      graph: {
        listBySourceFile: vi.fn(async () => ({ items: [node], nextCursor: null })),
        listNeighborhood: vi.fn(async () => ({ items: [], nextCursor: null })),
        replaceSourceFileGraph: vi.fn()
      },
      reconcileEdges: vi.fn(),
      sourcePageSize: 10,
      sourceConcurrency: 1,
      maximumSourceBytes: 1_024
    });

    await expect(reconciler.reconcile({
      knowledgeBaseId: "kb-one",
      candidatePublicId: "candidate-one",
      operationPublicId: "publication-one",
      searchProjectionPublicId: "candidate-one",
      signal: new AbortController().signal
    })).rejects.toMatchObject({ code: "graph_source_conflict" });
  });

  it("bounds concurrent source reconciliation while preserving complete results", async () => {
    const sources = ["alpha", "beta", "gamma", "delta"].map(currentSource);
    const nodes = new Map(sources.map((source) => [
      source.sourceFile.publicId,
      graphNode(source)
    ]));
    let active = 0;
    let maximumActive = 0;
    const reconciler = createStorageVnextPublicationGraphReconciler({
      releases: {
        listCandidateDependencies: vi.fn(async () => ({
          items: sources.map((source) => ({
            kind: "search" as const,
            publicId: source.sourceFile.publicId,
            reasonCode: "search_document"
          })),
          nextCursor: null
        })),
        addCandidateFacts: vi.fn(async () => candidateDelta())
      },
      catalog: {
        listSourceFilesByPublicIds: vi.fn(async () =>
          sources.map((source) => source.sourceFile)),
        getCurrentSourceRevision: vi.fn(async (input: { sourceFilePublicId: string }) =>
          sources.find((source) => source.sourceFile.publicId === input.sourceFilePublicId)
            ?.sourceRevision ?? null)
      },
      sourceBodies: {
        readVerifiedStream: vi.fn(async (input: { objectId: string }) =>
          bytes(`# ${input.objectId}\n`))
      },
      graph: {
        listBySourceFile: vi.fn(async (input: { sourceFilePublicId: string }) => ({
          items: [nodes.get(input.sourceFilePublicId)!],
          nextCursor: null
        })),
        listNeighborhood: vi.fn(async () => ({ items: [], nextCursor: null })),
        replaceSourceFileGraph: vi.fn(async () => undefined)
      },
      async reconcileEdges(input) {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active -= 1;
        return [{
          publicId: `edge-${input.node.sourceFilePublicId}`,
          knowledgeBaseId: "kb-one",
          fromNodePublicId: input.node.publicId,
          toNodePublicId: input.node.publicId,
          relation: "self-test",
          weight: 1,
          reason: null,
          evidence: [],
          revision: 1
        }];
      },
      sourcePageSize: 10,
      sourceConcurrency: 2,
      maximumSourceBytes: 1_024
    });

    await expect(reconciler.reconcile({
      knowledgeBaseId: "kb-one",
      candidatePublicId: "candidate-one",
      operationPublicId: "publication-one",
      searchProjectionPublicId: "candidate-one",
      signal: new AbortController().signal
    })).resolves.toEqual({ sourceCount: 4, edgeCount: 4 });
    expect(maximumActive).toBe(2);
  });
});

function currentSource(name: string): StorageVnextCurrentSourceFact {
  return {
    sourceFile: {
      publicId: `source-${name}`,
      knowledgeBaseId: "kb-one",
      directoryPublicId: null,
      logicalPath: `${name}.md`,
      normalizedPath: `${name}.md`,
      title: name,
      metadata: {},
      currentRevisionPublicId: `revision-${name}`,
      status: "ready",
      safeErrorCode: null,
      safeErrorMessage: null,
      revision: 1,
      visibility: "current"
    },
    sourceRevision: {
      publicId: `revision-${name}`,
      sourceFilePublicId: `source-${name}`,
      knowledgeBaseId: "kb-one",
      objectId: `object-${name}`,
      checksum: "a".repeat(64),
      byteCount: 12,
      contentType: "text/markdown",
      createdAt: "2026-08-02T00:00:00.000Z"
    }
  };
}

function graphNode(source: StorageVnextCurrentSourceFact): StorageVnextGraphNodeFact {
  return {
    publicId: `node-${source.sourceFile.publicId}`,
    knowledgeBaseId: source.sourceFile.knowledgeBaseId,
    sourceFilePublicId: source.sourceFile.publicId,
    sourceRevisionPublicId: source.sourceRevision.publicId,
    logicalPath: `pages/${source.sourceFile.logicalPath}`,
    label: source.sourceFile.title,
    kind: "page",
    metadata: {},
    evidence: [],
    revision: 1
  };
}

async function* bytes(value: string): AsyncGenerator<Uint8Array> {
  yield Buffer.from(value, "utf8");
}

function candidateDelta() {
  return {
    publicId: "candidate-one",
    knowledgeBaseId: "kb-one",
    operationPublicId: "publication-one",
    candidateRootPublicId: "root-candidate-one",
    expectedActiveRootPublicId: null,
    expectedActiveRevision: 0,
    state: "building" as const,
    factRevision: 1,
    changedFactCount: 1,
    affectedDependencyCount: 1,
    manifestChecksum: null,
    createdAt: "2026-08-02T00:00:00.000Z",
    updatedAt: "2026-08-02T00:00:00.000Z"
  };
}
