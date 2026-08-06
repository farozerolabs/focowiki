import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createStorageVnextGraphDeleteProjectionChange,
  createStorageVnextGraphUpsertProjectionChange
} from "../src/storage-vnext/graph/mutation-projections.js";
import type { StorageVnextGraphNodeFact } from
  "../src/storage-vnext/graph/ports.js";

const node: StorageVnextGraphNodeFact = {
  publicId: "graph-node-file-move",
  knowledgeBaseId: "kb-mutation",
  sourceFilePublicId: "file-move",
  sourceRevisionPublicId: "revision-move",
  logicalPath: "pages/New/Move.md",
  label: "Move",
  kind: "page",
  metadata: {},
  evidence: [],
  revision: 2
};

describe("storage vNext graph mutation symmetry", () => {
  it("stages one seed upsert and generated navigation refresh for replace or move", () => {
    expect(createStorageVnextGraphUpsertProjectionChange({
      mutationKind: "source_moved",
      node,
      previousLogicalPath: "pages/Old/Move.md",
      affectedSourceFilePublicIds: ["file-related", "file-move", "file-related"],
      affectedEdgePublicIds: ["edge-b", "edge-a", "edge-b"]
    })).toEqual({
      knowledgeBaseId: "kb-mutation",
      mutationKind: "source_moved",
      seedUpserts: [{
        publicId: expect.stringMatching(/^graph-seed:[0-9a-f]{64}$/u),
        knowledgeBaseId: "kb-mutation",
        sourceFilePublicId: "file-move",
        sourceRevisionPublicId: "revision-move",
        logicalPath: "pages/New/Move.md",
        title: "Move",
        searchText: "Move page"
      }],
      seedDeleteSourceFilePublicIds: [],
      affectedSourceFilePublicIds: ["file-move", "file-related"],
      affectedEdgePublicIds: ["edge-a", "edge-b"],
      removedEdgePublicIds: [],
      logicalPaths: ["pages/New/Move.md", "pages/Old/Move.md"],
      refreshGeneratedGraphCatalog: true,
      refreshGeneratedNavigation: true
    });
  });

  it("stages seed deletion and removed relationships from an exact delete closure", () => {
    expect(createStorageVnextGraphDeleteProjectionChange({
      knowledgeBaseId: "kb-mutation",
      mutationKind: "source_deleted",
      deletedSourceFilePublicIds: ["file-delete"],
      closure: {
        nodePublicIds: ["node-delete"],
        edgePublicIds: ["edge-z", "edge-a"],
        affectedSourceFilePublicIds: ["file-related", "file-delete"],
        logicalPaths: ["pages/Delete.md"]
      }
    })).toEqual({
      knowledgeBaseId: "kb-mutation",
      mutationKind: "source_deleted",
      seedUpserts: [],
      seedDeleteSourceFilePublicIds: ["file-delete"],
      affectedSourceFilePublicIds: ["file-delete", "file-related"],
      affectedEdgePublicIds: [],
      removedEdgePublicIds: ["edge-a", "edge-z"],
      logicalPaths: ["pages/Delete.md"],
      refreshGeneratedGraphCatalog: true,
      refreshGeneratedNavigation: true
    });
  });

  it("requires exact path, batch-delete, and knowledge-base-delete repository methods", () => {
    const ports = readFileSync(resolve(
      import.meta.dirname,
      "../src/storage-vnext/graph/ports.ts"
    ), "utf8");
    const repository = readFileSync(resolve(
      import.meta.dirname,
      "../src/storage-vnext/graph/postgres-repository.ts"
    ), "utf8");
    for (const method of [
      "updateSourceFileGraphPath",
      "deleteSourceFileGraphs",
      "deleteKnowledgeBaseGraph"
    ]) {
      expect(ports).toContain(method);
      expect(repository).toContain(`async ${method}`);
    }
    expect(repository).toMatch(
      /UPDATE focowiki\.graph_nodes[\s\S]*logical_path/u
    );
    expect(repository).toMatch(
      /UPDATE focowiki\.graph_evidence_refs[\s\S]*logical_path/u
    );
  });
});
