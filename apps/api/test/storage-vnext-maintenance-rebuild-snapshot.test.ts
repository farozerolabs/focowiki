import { describe, expect, it, vi } from "vitest";
import {
  createStorageVnextMaintenanceRebuildSnapshot
} from "../src/storage-vnext/maintenance/rebuild-snapshot.js";
import type {
  StorageVnextPublicationSnapshotPort
} from "../src/storage-vnext/publication/projection-loader.js";

describe("storage vNext maintenance rebuild snapshot", () => {
  it("uses an empty generated baseline when inherited object bytes are missing", async () => {
    const missing = Object.assign(new Error("missing"), { code: "object_missing" });
    const snapshot = fixtureSnapshot({
      readDirectoryLeaves: vi.fn(async () => { throw missing; }),
      readProjectionRecords: vi.fn(async () => { throw missing; }),
      listProjectionShards: vi.fn(async () => { throw missing; })
    });
    const rebuild = createStorageVnextMaintenanceRebuildSnapshot(snapshot);

    await expect(rebuild.readDirectoryLeaves(directoryRequest())).resolves.toEqual([]);
    await expect(rebuild.readProjectionRecords(projectionRequest())).resolves.toEqual([]);
    await expect(rebuild.listProjectionShards(shardRequest())).resolves.toEqual([]);
  });

  it("retains strict failures for generated object errors other than missing bytes", async () => {
    const mismatch = Object.assign(new Error("mismatch"), {
      code: "object_verification_failed"
    });
    const snapshot = fixtureSnapshot({
      readProjectionRecords: vi.fn(async () => { throw mismatch; })
    });
    const rebuild = createStorageVnextMaintenanceRebuildSnapshot(snapshot);

    await expect(rebuild.readProjectionRecords(projectionRequest())).rejects.toBe(mismatch);
  });

  it("delegates current fact reads and successful generated snapshot reads", async () => {
    const snapshot = fixtureSnapshot();
    const rebuild = createStorageVnextMaintenanceRebuildSnapshot(snapshot);

    await expect(rebuild.readKnowledgeBaseCounts({ knowledgeBaseId: "kb-one" }))
      .resolves.toEqual({
        sourceFileCount: 1,
        directoryCount: 1,
        graphNodeCount: 1,
        graphEdgeCount: 0
      });
    await expect(rebuild.readProjectionRecords(projectionRequest()))
      .resolves.toEqual([{ id: "record-one" }]);
    expect(snapshot.readKnowledgeBaseCounts).toHaveBeenCalledOnce();
    expect(snapshot.readProjectionRecords).toHaveBeenCalledOnce();
  });
});

function fixtureSnapshot(
  overrides: Partial<StorageVnextPublicationSnapshotPort> = {}
): StorageVnextPublicationSnapshotPort {
  return {
    readKnowledgeBaseCounts: vi.fn(async () => ({
      sourceFileCount: 1,
      directoryCount: 1,
      graphNodeCount: 1,
      graphEdgeCount: 0
    })),
    readDirectoryDescendantFileCounts: vi.fn(async () => new Map([["pages", 1]])),
    readDirectoryLeaves: vi.fn(async () => []),
    readProjectionRecords: vi.fn(async () => [{ id: "record-one" }]),
    listAffectedObsoletePaths: vi.fn(async () => []),
    listProjectionShards: vi.fn(async () => []),
    summarizeCandidate: vi.fn(async () => ({
      sourceFileCount: 1,
      directoryCount: 1,
      generatedEntryCount: 8,
      graphNodeCount: 1,
      graphEdgeCount: 0,
      generatedByteCount: 1
    })),
    ...overrides
  };
}

function directoryRequest() {
  return {
    knowledgeBaseId: "kb-one",
    candidatePublicId: "candidate-one",
    directoryPath: "pages",
    maximumBytes: 1_024,
    signal: new AbortController().signal
  };
}

function projectionRequest() {
  return {
    knowledgeBaseId: "kb-one",
    candidatePublicId: "candidate-one",
    logicalPath: "_index/search/v1/0.json",
    maximumBytes: 1_024,
    signal: new AbortController().signal
  };
}

function shardRequest() {
  return {
    knowledgeBaseId: "kb-one",
    candidatePublicId: "candidate-one",
    limit: 100,
    maximumBytes: 1_024
  };
}
