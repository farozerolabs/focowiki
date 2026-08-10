import { describe, expect, it, vi } from "vitest";
import type { StorageVnextCurrentSourceFact } from
  "../src/storage-vnext/catalog/ports.js";
import type {
  StorageVnextGraphEdgeFact,
  StorageVnextGraphNodeFact
} from "../src/storage-vnext/graph/ports.js";
import {
  assembleStorageVnextMachineProjection
} from "../src/storage-vnext/publication/machine-projection.js";
import type { StorageVnextPublicationPageInput } from
  "../src/storage-vnext/publication/artifact-assembler.js";

describe("semantic publication machine enrichment", () => {
  it("keeps the public path manifest while enriching existing graph resources", async () => {
    const from = graphNode("source-a", "revision-a", "pages/a.md", "A");
    const to = graphNode("source-b", "revision-b", "pages/b.md", "B");
    const edge = semanticEdge(from, to);
    const baselinePage = page(from, to, edge);
    const baselineTargetPage = page(to, from, edge);
    const enrichedPage: StorageVnextPublicationPageInput = {
      ...baselinePage,
      semanticContext: {
        entities: [{
          label: "Input service",
          kind: "component",
          description: "Receives source records.",
          confidence: 0.95,
          evidencePaths: ["pages/a.md"]
        }]
      }
    };
    const baseline = await assemble([baselinePage, baselineTargetPage], edge, [from, to]);
    const enriched = await assemble([enrichedPage, baselineTargetPage], edge, [from, to]);

    expect(enriched.artifacts.map((artifact) => artifact.logicalPath)).toEqual(
      baseline.artifacts.map((artifact) => artifact.logicalPath)
    );
    expect(enriched.artifacts.some((artifact) =>
      artifact.logicalPath.startsWith("_semantic/"))).toBe(false);

    const graphNodeRecord = records(enriched, "/graph_node/")[0]!;
    expect(graphNodeRecord).toMatchObject({
      id: "source-a",
      semanticContext: {
        entities: [{
          label: "Input service",
          kind: "component",
          description: "Receives source records.",
          confidence: 0.95,
          evidencePaths: ["pages/a.md"]
        }]
      }
    });
    const byFileRecord = records(enriched, "_graph/by-file/source-a.json")[0];
    expect(byFileRecord).toMatchObject({
      id: "source-a",
      semanticContext: graphNodeRecord.semanticContext,
      relationships: [{
        fileId: "source-b",
        path: "pages/b.md",
        direction: "outgoing",
        relationType: "semantic_relationship",
        reason: "From \"A\" to \"B\": Input service feeds Output service.",
        source: "semantic_evidence",
        evidence: {
          signal: "semantic_relationship",
          evidencePaths: ["pages/a.md"]
        }
      }]
    });
    expect(records(enriched, "_graph/by-file/source-b.json")[0]).toMatchObject({
      id: "source-b",
      relationships: [{
        fileId: "source-a",
        path: "pages/a.md",
        direction: "incoming",
        relationType: "semantic_relationship"
      }]
    });
    expect(records(enriched, "/links/")[0]).toMatchObject({
      from: "pages/a.md",
      to: "pages/b.md",
      relation_type: "semantic_relationship",
      reason: "Input service feeds Output service.",
      source: "semantic_evidence"
    });
    expect(records(enriched, "/graph_edge/")[0]).toMatchObject({
      fromPath: "pages/a.md",
      toPath: "pages/b.md",
      relationType: "semantic_relationship",
      evidence: {
        signal: "semantic_relationship",
        evidencePaths: ["pages/a.md"]
      }
    });
    expect(JSON.stringify(enriched.artifacts.map((artifact) =>
      Buffer.from(artifact.bytes).toString("utf8")))).not.toMatch(
      /semanticGenerationPublicId|entityPublicId|relationshipPublicId|vector|prompt|GraphRAG/iu
    );
  });

  it("updates existing related-file links for repeated rename and move without stale paths", async () => {
    const source = graphNode("source-a", "revision-a", "pages/a.md", "A");
    const createdTarget = graphNode(
      "source-b", "revision-b", "pages/guides/b.md", "B"
    );
    const renamedTarget = {
      ...createdTarget,
      logicalPath: "pages/guides/renamed.md",
      label: "Renamed B",
      revision: 2
    };
    const movedTarget = {
      ...renamedTarget,
      logicalPath: "pages/archive/renamed.md",
      revision: 3
    };
    const snapshots = [];
    for (const target of [createdTarget, renamedTarget, movedTarget]) {
      const edge = semanticEdge(source, target);
      snapshots.push(await assemble([
        page(source, target, edge),
        page(target, source, edge)
      ], edge, [source, target]));
    }

    const relatedPaths = snapshots.map((snapshot) =>
      (records(snapshot, "_graph/by-file/source-a.json")[0]!
        .relationships as Array<{ path: string }>)[0]!.path);
    expect(relatedPaths).toEqual([
      "pages/guides/b.md",
      "pages/guides/renamed.md",
      "pages/archive/renamed.md"
    ]);
    expect(JSON.stringify(records(
      snapshots[2]!, "_graph/by-file/source-a.json"
    ))).not.toMatch(/pages\/guides\/(?:b|renamed)\.md/u);
    expect(snapshots.map((snapshot) => snapshot.artifacts.map((artifact) =>
      artifact.logicalPath))).toEqual([
        snapshots[0]!.artifacts.map((artifact) => artifact.logicalPath),
        snapshots[0]!.artifacts.map((artifact) => artifact.logicalPath),
        snapshots[0]!.artifacts.map((artifact) => artifact.logicalPath)
      ]);
  });
});

async function assemble(
  pages: readonly StorageVnextPublicationPageInput[],
  edge: StorageVnextGraphEdgeFact,
  nodes: readonly StorageVnextGraphNodeFact[]
) {
  return assembleStorageVnextMachineProjection({
    knowledgeBaseId: "kb-1",
    candidatePublicId: "candidate-1",
    plan: {
      sourcePaths: pages.map((page) => page.node.logicalPath),
      directoryPaths: [],
      graphPublicIds: pages.map((page) => page.current.sourceFile.publicId),
      linkPublicIds: [edge.publicId],
      searchSourceFilePublicIds: pages.map((page) =>
        page.current.sourceFile.publicId),
      rootPaths: []
    },
    affectedSourceFilePublicIds: pages.map((page) =>
      page.current.sourceFile.publicId),
    pages,
    directories: [],
    getEdge: vi.fn(async (publicId) => publicId === edge.publicId ? edge : null),
    getNode: vi.fn(async (publicId) =>
      nodes.find((node) => node.publicId === publicId) ?? null),
    readExisting: vi.fn(async () => []),
    shardCounts: {
      search: 4,
      links: 4,
      manifest: 4,
      tree: 4,
      graphNode: 4,
      graphEdge: 4
    },
    maximumArtifactBytes: 1_048_576,
    relatedFileLimit: 8,
    signal: new AbortController().signal
  });
}

function records(
  projection: Awaited<ReturnType<typeof assemble>>,
  pathPart: string
): Array<Record<string, unknown>> {
  const artifact = projection.artifacts.find((candidate) =>
    candidate.logicalPath.includes(pathPart));
  if (!artifact) throw new Error(`Missing artifact: ${pathPart}`);
  return JSON.parse(Buffer.from(artifact.bytes).toString("utf8")).records;
}

function page(
  from: StorageVnextGraphNodeFact,
  to: StorageVnextGraphNodeFact,
  edge: StorageVnextGraphEdgeFact
): StorageVnextPublicationPageInput {
  return {
    current: currentSource(from),
    node: from,
    neighborhood: [edge],
    endpointNodes: [from, to],
    sourceBody: "# A\n\nInput service feeds output service."
  };
}

function currentSource(node: StorageVnextGraphNodeFact): StorageVnextCurrentSourceFact {
  const logicalPath = node.logicalPath.slice("pages/".length);
  return {
    sourceFile: {
      publicId: node.sourceFilePublicId,
      knowledgeBaseId: "kb-1",
      directoryPublicId: null,
      logicalPath,
      normalizedPath: logicalPath,
      title: node.label,
      status: "ready",
      safeErrorCode: null,
      safeErrorMessage: null,
      metadata: {},
      currentRevisionPublicId: node.sourceRevisionPublicId,
      revision: 1,
      visibility: "current"
    },
    sourceRevision: {
      publicId: node.sourceRevisionPublicId,
      knowledgeBaseId: "kb-1",
      sourceFilePublicId: node.sourceFilePublicId,
      objectId: `object-${node.sourceFilePublicId}`,
      checksum: "a".repeat(64),
      byteCount: 43,
      contentType: "text/markdown",
      createdAt: "2026-08-08T00:00:00.000Z"
    }
  };
}

function graphNode(
  sourceFilePublicId: string,
  sourceRevisionPublicId: string,
  logicalPath: string,
  label: string
): StorageVnextGraphNodeFact {
  return {
    publicId: `node-${sourceFilePublicId}`,
    knowledgeBaseId: "kb-1",
    sourceFilePublicId,
    sourceRevisionPublicId,
    logicalPath,
    label,
    kind: "page",
    metadata: {},
    evidence: [],
    revision: 1
  };
}

function semanticEdge(
  from: StorageVnextGraphNodeFact,
  to: StorageVnextGraphNodeFact
): StorageVnextGraphEdgeFact {
  return {
    publicId: "edge-semantic-a-b",
    knowledgeBaseId: "kb-1",
    fromNodePublicId: from.publicId,
    toNodePublicId: to.publicId,
    relation: "semantic_relationship",
    weight: 0.9,
    reason: "Input service feeds Output service.",
    source: "semantic_evidence",
    metadata: {
      signal: "semantic_relationship",
      evidencePaths: ["pages/a.md"]
    },
    evidence: [{
      publicId: "edge-evidence-a",
      sourceFilePublicId: "source-a",
      sourceRevisionPublicId: "revision-a",
      logicalPath: "pages/a.md",
      startOffset: 4,
      endOffset: 42,
      checksum: "b".repeat(64)
    }],
    revision: 1
  };
}
