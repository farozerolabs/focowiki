import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { StorageVnextGraphNodeFact } from
  "../src/storage-vnext/graph/ports.js";
import {
  hydrateStorageVnextGraphSeedHits,
  mapStorageVnextGraphSeedDocument,
  readStorageVnextGraphCatalogPage
} from "../src/storage-vnext/graph/read-models.js";

const node: StorageVnextGraphNodeFact = {
  publicId: "graph-node-file-a",
  knowledgeBaseId: "kb-read",
  sourceFilePublicId: "file-a",
  sourceRevisionPublicId: "revision-a",
  logicalPath: "pages/Folder/A.md",
  label: "Generic architecture",
  kind: "guide",
  metadata: { language: "en", audience: "developers" },
  evidence: [],
  revision: 1
};

describe("storage vNext bounded graph read models", () => {
  it("reads exactly one bounded keyset page for graph catalog shards", async () => {
    const listNodes = vi.fn(async () => ({
      items: [node],
      nextCursor: "next-node"
    }));
    const listEdges = vi.fn();

    const page = await readStorageVnextGraphCatalogPage({
      graph: { listNodes, listEdges },
      knowledgeBaseId: "kb-read",
      kind: "node",
      limit: 250,
      cursor: null
    });

    expect(listNodes).toHaveBeenCalledExactlyOnceWith({
      knowledgeBaseId: "kb-read",
      limit: 250,
      cursor: null
    });
    expect(listEdges).not.toHaveBeenCalled();
    expect(page).toEqual({
      items: [{
        kind: "node",
        publicId: node.publicId,
        logicalPath: node.logicalPath,
        sourceFilePublicId: node.sourceFilePublicId,
        label: node.label
      }],
      nextCursor: "next-node"
    });
    await expect(readStorageVnextGraphCatalogPage({
      graph: { listNodes, listEdges },
      knowledgeBaseId: "kb-read",
      kind: "node",
      limit: 1_001,
      cursor: null
    })).rejects.toThrow("Graph catalog page limit must be between 1 and 1000");
  });

  it("maps one minimal deterministic graph seed without body, metadata, or evidence", () => {
    const document = mapStorageVnextGraphSeedDocument(node);
    expect(document).toMatchObject({
      knowledgeBaseId: "kb-read",
      sourceFilePublicId: "file-a",
      sourceRevisionPublicId: "revision-a",
      logicalPath: "pages/Folder/A.md",
      title: "Generic architecture",
      searchText: "Generic architecture guide"
    });
    expect(document.publicId).toMatch(/^graph-seed:[0-9a-f]{64}$/u);
    expect(mapStorageVnextGraphSeedDocument(node).publicId).toBe(document.publicId);
    expect(Object.keys(document).sort()).toEqual([
      "knowledgeBaseId",
      "logicalPath",
      "publicId",
      "searchText",
      "sourceFilePublicId",
      "sourceRevisionPublicId",
      "title"
    ]);
  });

  it("hydrates only current deduplicated source revisions and readable paths", async () => {
    const document = mapStorageVnextGraphSeedDocument(node);
    const loadCurrentFiles = vi.fn(async () => [{
      publicId: "file-a",
      knowledgeBaseId: "kb-read",
      logicalPath: "Folder/A.md",
      title: "A",
      currentRevisionPublicId: "revision-a"
    }]);
    const result = await hydrateStorageVnextGraphSeedHits({
      knowledgeBaseId: "kb-read",
      hits: [
        { document, score: 0.9 },
        { document, score: 0.8 },
        {
          document: {
            ...mapStorageVnextGraphSeedDocument(node),
            publicId: "graph-seed:kb-read:file-stale:revision-old",
            sourceFilePublicId: "file-stale",
            sourceRevisionPublicId: "revision-old",
            logicalPath: "pages/Stale.md"
          },
          score: 0.7
        }
      ],
      limit: 10,
      loadCurrentFiles
    });

    expect(loadCurrentFiles).toHaveBeenCalledExactlyOnceWith(
      ["file-a", "file-stale"],
      10
    );
    expect(result).toEqual([{
      publicId: document.publicId,
      sourceFilePublicId: "file-a",
      sourceRevisionPublicId: "revision-a",
      logicalPath: "pages/Folder/A.md",
      title: "Generic architecture",
      score: 0.9
    }]);
  });

  it("uses bounded keyset SQL and never loads the complete graph", () => {
    const repository = readFileSync(resolve(
      import.meta.dirname,
      "../src/storage-vnext/graph/postgres-repository.ts"
    ), "utf8");
    expect(repository).toContain("async listNodes");
    expect(repository).toContain("async listEdges");
    expect(repository).toContain("LIMIT ${limit + 1}");
    expect(repository).not.toMatch(/\bOFFSET\b/u);
    expect(repository).not.toMatch(/SELECT\s+\*\s+FROM\s+focowiki\.graph_/iu);
  });
});
