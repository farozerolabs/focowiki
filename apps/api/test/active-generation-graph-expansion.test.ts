import { describe, expect, it } from "vitest";
import type {
  ActiveGenerationFile,
  ActiveGenerationProjection,
  ActiveGenerationReadScope
} from "../src/application/ports/active-generation-read-repository.js";
import { expandActiveGenerationGraph } from "../src/developer-openapi/active-generation-graph-expansion.js";

describe("active generation graph expansion", () => {
  it("expands breadth and depth while returning unique readable files", async () => {
    const scope = createScope();

    const result = await expandActiveGenerationGraph(scope, {
      fileId: "source-a",
      nodeId: null,
      edgeId: null,
      query: null,
      depth: 2,
      fanout: 5,
      limit: 10,
      cursor: null
    });
    if (!result) throw new Error("Expected file graph expansion");

    expect(result.seedFile).toMatchObject({ fileId: "source-a", path: "pages/a.md" });
    expect(result.relationships.map((item) => item.relatedSourceFileId)).toEqual([
      "source-b",
      "source-c"
    ]);
    expect(result.relationships.every((item) => Boolean(item.path))).toBe(true);
  });

  it("resolves an edge seed inside the active projection", async () => {
    const result = await expandActiveGenerationGraph(createScope(), {
      fileId: null,
      nodeId: null,
      edgeId: "edge-a-b",
      query: null,
      depth: 1,
      fanout: 5,
      limit: 10,
      cursor: null
    });
    if (!result) throw new Error("Expected edge graph expansion");

    expect(result.seedFile).toMatchObject({ fileId: "source-a" });
    expect(result.seedCount).toBe(2);
    expect(result.relationships).toContainEqual(expect.objectContaining({
      relatedSourceFileId: "source-b",
      path: "pages/b.md"
    }));
  });

  it("uses graph search results as query seeds and preserves their cursor", async () => {
    const result = await expandActiveGenerationGraph(createScope(), {
      fileId: null,
      nodeId: null,
      edgeId: null,
      query: "shared subject",
      depth: 1,
      fanout: 5,
      limit: 1,
      cursor: null
    });
    if (!result) throw new Error("Expected query graph expansion");

    expect(result.seedResults).toHaveLength(1);
    expect(result.seedResults[0]).toMatchObject({ sourceFileId: "source-a" });
    expect(result.nextCursor).toEqual({ score: 0.8, recordId: "source-a" });
    expect(result.relationships).toContainEqual(expect.objectContaining({
      relatedSourceFileId: "source-b"
    }));
  });
});

function createScope(): ActiveGenerationReadScope {
  const files = new Map<string, ActiveGenerationFile>([
    ["source-a", file("source-a", "pages/a.md")],
    ["source-b", file("source-b", "pages/b.md")],
    ["source-c", file("source-c", "pages/c.md")]
  ]);
  const related = new Map<string, ActiveGenerationProjection[]>([
    ["source-a", [relationship("edge-a-b", "source-a", "source-b", "pages/b.md", 0.9)]],
    [
      "source-b",
      [
        relationship("edge-a-b", "source-b", "source-a", "pages/a.md", 0.9),
        relationship("edge-b-c", "source-b", "source-c", "pages/c.md", 0.7)
      ]
    ],
    ["source-c", [relationship("edge-b-c", "source-c", "source-b", "pages/b.md", 0.7)]]
  ]);

  return {
    knowledgeBaseId: "kb-test",
    generationId: "generation-active",
    async findFileById(fileId) {
      return files.get(fileId) ?? null;
    },
    async findFileByPath(path) {
      return [...files.values()].find((item) => item.path === path) ?? null;
    },
    async findFilesBySourceIds(sourceFileIds) {
      return [...files.values()].filter(
        (file) => file.sourceFileId && sourceFileIds.includes(file.sourceFileId)
      );
    },
    async findProjection(input) {
      if (input.projectionKind !== "graph_edge" || input.recordId !== "edge-a-b") return null;
      return {
        generationId: "generation-active",
        projectionKind: "graph_edge",
        recordId: "edge-a-b",
        sourceFileId: "source-a",
        relatedSourceFileId: "source-b",
        path: "pages/a.md",
        parentPath: null,
        sortKey: "edge-a-b",
        title: "A to B",
        summary: "Shared subject",
        score: null,
        payload: {
          fromFileId: "source-a",
          fromPath: "pages/a.md",
          toFileId: "source-b",
          toPath: "pages/b.md"
        }
      };
    },
    async listTree() {
      return { items: [], nextCursor: null };
    },
    async listTreeAncestors(paths) {
      return new Map(paths.map((path) => [path, []]));
    },
    async search() {
      return {
        items: [{
          generationId: "generation-active",
          projectionKind: "graph_node",
          recordId: "source-a",
          sourceFileId: "source-a",
          relatedSourceFileId: null,
          path: "pages/a.md",
          parentPath: null,
          sortKey: "pages/a.md",
          title: "A",
          summary: "Shared subject",
          score: 1,
          payload: { fileId: "source-a", path: "pages/a.md" }
        }],
        nextCursor: { score: 0.8, recordId: "source-a" }
      };
    },
    async listRelated(input) {
      return { items: related.get(input.sourceFileId) ?? [], nextCursor: null };
    },
    async listRelatedForSources(input) {
      return new Map(input.sourceFileIds.map((sourceFileId) => [
        sourceFileId,
        related.get(sourceFileId) ?? []
      ]));
    }
  };
}

function file(fileId: string, path: string): ActiveGenerationFile {
  return {
    generationId: "generation-active",
    fileId,
    refKind: "page",
    refKey: fileId,
    lastChangedGenerationId: "generation-active",
    path,
    sourceFileId: fileId,
    objectKey: `generated/${fileId}`,
    contentType: "text/markdown",
    sizeBytes: 10,
    checksumSha256: fileId,
    title: fileId,
    summary: null,
    payload: {}
  };
}

function relationship(
  recordId: string,
  sourceFileId: string,
  relatedSourceFileId: string,
  path: string,
  score: number
): ActiveGenerationProjection {
  return {
    generationId: "generation-active",
    projectionKind: "graph_edge",
    recordId,
    sourceFileId,
    relatedSourceFileId,
    path,
    parentPath: null,
    sortKey: recordId,
    title: relatedSourceFileId,
    summary: "Shared subject",
    score,
    payload: {
      fromFileId: sourceFileId,
      toFileId: relatedSourceFileId,
      relationType: "related",
      weight: score,
      reason: "Shared subject"
    }
  };
}
