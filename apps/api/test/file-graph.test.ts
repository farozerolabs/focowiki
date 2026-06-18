import { describe, expect, it } from "vitest";
import type { OkfGraphEdge, OkfGraphNode } from "@focowiki/okf";
import { buildSourceFileGraph } from "../src/graph/file-graph.js";
import type { FileGraphRepository, SourceFileRecord } from "../src/db/admin-repositories.js";

const now = "2026-06-18T00:00:00.000Z";

describe("file graph", () => {
  it("builds graph edges with bounded candidate reads", async () => {
    const source = createSourceFile("source-current", "current.md");
    const candidates = Array.from({ length: 5 }, (_, index) =>
      createGraphNode(`source-${index}`, `related-${index}.md`)
    );
    const storedNodes = new Map<string, OkfGraphNode>();
    const storedEdges: OkfGraphEdge[] = [];
    let nodePageCalls = 0;
    const graph: FileGraphRepository = {
      async upsertGraphNode(input) {
        storedNodes.set(input.node.fileId, input.node);
      },
      async upsertGraphEdges(input) {
        storedEdges.push(...input.edges);
      },
      async listGraphNodes(input) {
        nodePageCalls += 1;
        const offset = input.cursor ? Number(input.cursor) : 0;
        const items = candidates.slice(offset, offset + input.limit);
        const nextOffset = offset + input.limit;
        return {
          items,
          nextCursor: nextOffset < candidates.length ? String(nextOffset) : null
        };
      },
      async listGraphEdges() {
        return { items: storedEdges, nextCursor: null };
      },
      async listGraphNeighborhood() {
        return { items: [], nextCursor: null };
      },
      async deleteGraphForSourceFile() {
        return undefined;
      }
    };

    const result = await buildSourceFileGraph({
      graph,
      knowledgeBaseId: source.knowledgeBaseId,
      source,
      metadata: {
        title: "Current",
        type: "page",
        tags: ["shared"]
      },
      body: "# Current\n\nThis file is related.",
      suggestions: null,
      pageSize: 2,
      maxCandidateNodes: 3
    });

    expect(storedNodes.get(source.id)?.path).toBe("pages/current.md");
    expect(result.edgeCount).toBe(3);
    expect(storedEdges).toHaveLength(3);
    expect(storedEdges.map((edge) => edge.toFileId)).toEqual(["source-0", "source-1", "source-2"]);
    expect(nodePageCalls).toBe(2);
  });
});

function createSourceFile(id: string, originalName: string): SourceFileRecord {
  return {
    id,
    knowledgeBaseId: "kb-graph",
    originalName,
    objectKey: `tenant/demo/knowledge-bases/kb-graph/sources/${id}/${originalName}`,
    contentType: "text/markdown; charset=utf-8",
    sizeBytes: 10,
    checksumSha256: "checksum",
    metadata: {},
    modelSuggestions: null,
    processingStatus: "completed",
    processingStage: "release_activation",
    processingStartedAt: now,
    processingEndedAt: now,
    processingErrorCode: null,
    processingErrorMessage: null,
    retryCount: 0,
    createdAt: now,
    deletedAt: null
  };
}

function createGraphNode(fileId: string, fileName: string): OkfGraphNode {
  return {
    fileId,
    path: `pages/${fileName}`,
    title: fileName.replace(/\.md$/u, ""),
    type: "page",
    tags: ["shared"],
    headings: ["Current"],
    keywords: ["shared"],
    metadata: {
      title: fileName.replace(/\.md$/u, ""),
      type: "page",
      tags: ["shared"]
    }
  };
}
