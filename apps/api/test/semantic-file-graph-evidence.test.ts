import { describe, expect, it, vi } from "vitest";
import {
  loadSemanticFileGraphEdges,
  mergeFileGraphEdges,
  planSemanticFileGraphEdges,
  type SemanticFileRelationshipCandidate
} from "../src/semantic/presentation/file-graph-evidence.js";
import type {
  StorageVnextGraphNodeFact
} from "../src/storage-vnext/graph/ports.js";

describe("semantic file graph evidence", () => {
  it("creates a direction-aware file edge only from accepted relationship evidence", () => {
    const source = node("source-a", "revision-a", "pages/a.md", "A");
    const target = node("source-b", "revision-b", "pages/b.md", "B");

    const edges = planSemanticFileGraphEdges({
      knowledgeBaseId: "kb-1",
      source,
      targetNodes: [target],
      relationships: [relationship({
        targetSourceFilePublicId: target.sourceFilePublicId,
        fromEntityLabel: "System A",
        toEntityLabel: "System B",
        kind: "depends_on",
        description: "System A requires System B during startup."
      })],
      maximumEdges: 10
    });

    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({
      knowledgeBaseId: "kb-1",
      fromNodePublicId: source.publicId,
      toNodePublicId: target.publicId,
      relation: "semantic_relationship",
      source: "semantic_evidence",
      reason: "System A depends_on System B. System A requires System B during startup.",
      weight: 0.91,
      metadata: {
        signal: "semantic_relationship",
        relationships: [{
          from: "System A",
          to: "System B",
          type: "depends_on",
          description: "System A requires System B during startup.",
          confidence: 0.91
        }]
      }
    });
    expect(edges[0]!.evidence).toEqual([
      expect.objectContaining({
        sourceFilePublicId: "source-a",
        sourceRevisionPublicId: "revision-a",
        logicalPath: "pages/a.md",
        startOffset: 10,
        endOffset: 42
      })
    ]);
  });

  it.each([
    ["metadata-only", { evidence: [] }],
    ["summary-only", { evidence: [], description: "Generated summary overlap." }],
    ["unsupported target", { targetSourceFilePublicId: "source-missing" }]
  ])("rejects %s relationship candidates", (_label, override) => {
    const source = node("source-a", "revision-a", "pages/a.md", "A");
    const target = node("source-b", "revision-b", "pages/b.md", "B");
    const edges = planSemanticFileGraphEdges({
      knowledgeBaseId: "kb-1",
      source,
      targetNodes: [target],
      relationships: [relationship(override)],
      maximumEdges: 10
    });

    expect(edges).toEqual([]);
  });

  it("deduplicates supported relationships without inventing another target", () => {
    const source = node("source-a", "revision-a", "pages/a.md", "A");
    const target = node("source-b", "revision-b", "pages/b.md", "B");
    const duplicate = relationship({
      targetSourceFilePublicId: target.sourceFilePublicId
    });

    const edges = planSemanticFileGraphEdges({
      knowledgeBaseId: "kb-1",
      source,
      targetNodes: [target],
      relationships: [duplicate, duplicate],
      maximumEdges: 10
    });

    expect(edges).toHaveLength(1);
    expect(edges[0]!.evidence).toHaveLength(1);
    expect(edges[0]!.metadata).toMatchObject({
      relationships: [expect.objectContaining({ type: "related_to" })]
    });
  });

  it("does not create self edges or reverse the semantic direction", () => {
    const source = node("source-a", "revision-a", "pages/a.md", "A");
    const edges = planSemanticFileGraphEdges({
      knowledgeBaseId: "kb-1",
      source,
      targetNodes: [source],
      relationships: [relationship({ targetSourceFilePublicId: "source-a" })],
      maximumEdges: 10
    });

    expect(edges).toEqual([]);
  });

  it("loads only the bounded target-node set and preserves stronger existing edges", async () => {
    const source = node("source-a", "revision-a", "pages/a.md", "A");
    const target = node("source-b", "revision-b", "pages/b.md", "B");
    const listOutboundCandidates = vi.fn(async () => [relationship()]);
    const listNodesBySourceFiles = vi.fn(async () => [target]);
    const semantic = await loadSemanticFileGraphEdges({
      knowledgeBaseId: "kb-1",
      operationPublicId: "operation-one",
      source,
      relationships: { listOutboundCandidates },
      graph: { listNodesBySourceFiles },
      maximumEdges: 5
    });
    const explicit = {
      ...semantic[0]!,
      publicId: "explicit-edge",
      relation: "direct_reference",
      weight: 1,
      source: "deterministic"
    };

    expect(listOutboundCandidates).toHaveBeenCalledWith({
      knowledgeBaseId: "kb-1",
      operationPublicId: "operation-one",
      sourceFilePublicId: "source-a",
      sourceRevisionPublicId: "revision-a",
      limit: 5
    });
    expect(listNodesBySourceFiles).toHaveBeenCalledWith({
      knowledgeBaseId: "kb-1",
      sourceFilePublicIds: ["source-b"],
      limit: 5
    });
    expect(mergeFileGraphEdges({
      primary: [explicit],
      semantic,
      maximumEdges: 1
    })).toEqual([explicit]);
  });

  it("reconciles create, update, rename, move, file delete, add, and directory delete as bounded desired states", () => {
    const source = node("source-a", "revision-a", "pages/a.md", "A");
    const originalTarget = node(
      "source-b", "revision-b", "pages/guides/b.md", "B"
    );
    const created = planSemanticFileGraphEdges({
      knowledgeBaseId: "kb-1",
      source,
      targetNodes: [originalTarget],
      relationships: [relationship()],
      maximumEdges: 4
    });
    const updated = planSemanticFileGraphEdges({
      knowledgeBaseId: "kb-1",
      source,
      targetNodes: [originalTarget],
      relationships: [relationship({ description: "Updated body evidence." })],
      maximumEdges: 4
    });
    const renamedTarget = {
      ...originalTarget,
      logicalPath: "pages/guides/renamed.md",
      label: "Renamed B",
      revision: 2
    };
    const movedTarget = {
      ...renamedTarget,
      logicalPath: "pages/archive/renamed.md",
      revision: 3
    };
    const renamed = planSemanticFileGraphEdges({
      knowledgeBaseId: "kb-1", source, targetNodes: [renamedTarget],
      relationships: [relationship()], maximumEdges: 4
    });
    const moved = planSemanticFileGraphEdges({
      knowledgeBaseId: "kb-1", source, targetNodes: [movedTarget],
      relationships: [relationship()], maximumEdges: 4
    });
    const fileDeleted = planSemanticFileGraphEdges({
      knowledgeBaseId: "kb-1", source, targetNodes: [],
      relationships: [relationship()], maximumEdges: 4
    });
    const addedTarget = node(
      "source-c", "revision-c", "pages/new/c.md", "C"
    );
    const added = planSemanticFileGraphEdges({
      knowledgeBaseId: "kb-1",
      source,
      targetNodes: [addedTarget],
      relationships: [relationship({
        targetSourceFilePublicId: "source-c",
        targetSourceRevisionPublicId: "revision-c",
        toEntityLabel: "Entity C"
      })],
      maximumEdges: 4
    });
    const directoryDeleted = planSemanticFileGraphEdges({
      knowledgeBaseId: "kb-1", source, targetNodes: [],
      relationships: [], maximumEdges: 4
    });

    expect(created).toHaveLength(1);
    expect(updated[0]).toMatchObject({
      publicId: created[0]!.publicId,
      reason: "Entity A related_to Entity B. Updated body evidence."
    });
    expect(renamed[0]!.publicId).toBe(created[0]!.publicId);
    expect(moved[0]!.publicId).toBe(created[0]!.publicId);
    expect(fileDeleted).toEqual([]);
    expect(added).toHaveLength(1);
    expect(added[0]!.toNodePublicId).toBe(addedTarget.publicId);
    expect(added[0]!.publicId).not.toBe(created[0]!.publicId);
    expect(directoryDeleted).toEqual([]);
  });
});

function relationship(
  override: Partial<SemanticFileRelationshipCandidate> = {}
): SemanticFileRelationshipCandidate {
  return {
    targetSourceFilePublicId: "source-b",
    targetSourceRevisionPublicId: "revision-b",
    fromEntityLabel: "Entity A",
    toEntityLabel: "Entity B",
    kind: "related_to",
    description: null,
    confidence: 0.91,
    evidence: [{
      sourceFilePublicId: "source-a",
      sourceRevisionPublicId: "revision-a",
      logicalPath: "pages/a.md",
      startOffset: 10,
      endOffset: 42,
      excerptChecksumSha256: "a".repeat(64)
    }],
    ...override
  };
}

function node(
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
