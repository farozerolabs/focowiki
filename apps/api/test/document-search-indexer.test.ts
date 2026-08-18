import { describe, expect, it, vi } from "vitest";
import { createDocumentSearchIndexer } from
  "../src/document-indexing/application/document-search-indexer.js";

describe("document search indexer", () => {
  it("requires provider acknowledgement before staging ownership", async () => {
    const stageAcknowledged = vi.fn(async () => 2);
    const makeVisible = vi.fn(async () => undefined);
    const writes: Array<Readonly<Record<string, unknown>>> = [];
    const index = createDocumentSearchIndexer({
      batchSize: 2,
      provider: {
        kind: "opensearch",
        async writeAcknowledged(input) {
          writes.push(...input.documents);
          return {
            acknowledgementPublicId: `ack-${input.batchOrdinal}`,
            documentIds: input.documents.map((item) => item.id)
          };
        },
        makeVisible
      },
      owners: { stageAcknowledged }
    });
    await expect(index(request())).resolves.toMatchObject({
      acknowledgedDocumentCount: 2,
      batchCount: 1
    });
    expect(stageAcknowledged).toHaveBeenCalledTimes(1);
    expect(makeVisible).toHaveBeenCalledWith({
      indexUid: "focowiki-a",
      signal: expect.any(AbortSignal)
    });
    expect(writes[0]).toMatchObject({
      schemaVersion: "storage-vnext-content-v2",
      documentKind: "content",
      contentKind: "file",
      fileKind: "page"
    });
    expect(writes[1]).toMatchObject({
      documentKind: "content",
      contentKind: "segment",
      segmentOrdinal: 0
    });
    expect(writes[0]).not.toHaveProperty("metadata");
    expect(writes[1]).not.toHaveProperty("embeddingArtifactPublicId");
    expect(stageAcknowledged).toHaveBeenCalledWith(expect.objectContaining({
      documents: expect.arrayContaining([
        expect.objectContaining({ providerDocumentId: writes[0]!.id }),
        expect.objectContaining({ providerDocumentId: writes[1]!.id })
      ])
    }));
  });

  it("keeps the public page kind separate from OKF metadata type", async () => {
    const writes: Array<Readonly<Record<string, unknown>>> = [];
    const index = createDocumentSearchIndexer({
      batchSize: 10,
      provider: {
        kind: "opensearch",
        async writeAcknowledged(input) {
          writes.push(...input.documents);
          return {
            acknowledgementPublicId: "ack-page-kind",
            documentIds: input.documents.map((item) => item.id)
          };
        },
        async makeVisible() {}
      },
      owners: { async stageAcknowledged(request) { return request.documents.length; } }
    });
    const shared = {
      publicId: "search-okf-document",
      schemaVersion: "document-search-v1" as const,
      knowledgeBaseId: "knowledge-base-a",
      sourceFilePublicId: "source-a",
      sourceRevisionPublicId: "revision-a",
      searchContractSha256: "a".repeat(64),
      logicalPath: "a.md",
      title: "A",
      metadata: { type: "document" },
      segmentOrdinal: null,
      headingAncestors: [],
      searchText: "A body",
      embeddingArtifactPublicId: null
    };

    await index({
      knowledgeBaseId: "knowledge-base-a",
      sourceFilePublicId: "source-a",
      sourceRevisionPublicId: "revision-a",
      searchProjectionPublicId: "projection-a",
      providerIndexUid: "focowiki-a",
      documents: [{ ...shared, documentKind: "file" }, {
        ...shared,
        publicId: "search-okf-graph",
        documentKind: "graph_seed",
        rankingTerms: []
      }, {
        ...shared,
        publicId: "search-okf-relationship",
        documentKind: "file_relationship",
        relationPublicId: "relation-ab",
        evidencePublicId: "evidence-ab",
        targetSourceFilePublicId: "source-b",
        targetSourceRevisionPublicId: "revision-b",
        targetLogicalPath: "b.md",
        targetTitle: "B",
        relationKind: "references",
        direction: "outgoing",
        rankingTerms: []
      }],
      stagedAt: "2026-08-15T05:00:00.000Z",
      signal: new AbortController().signal
    });

    expect(writes).toHaveLength(3);
    expect(writes.every((document) => document.fileKind === "page")).toBe(true);
  });

  it("does not stage ownership for a partial acknowledgement", async () => {
    const stageAcknowledged = vi.fn();
    const index = createDocumentSearchIndexer({
      batchSize: 10,
      provider: {
        kind: "meilisearch",
        async writeAcknowledged(input) {
          return {
            acknowledgementPublicId: "ack-partial",
            documentIds: [input.documents[0]!.id]
          };
        },
        async makeVisible() { throw new Error("unexpected visibility refresh"); }
      }, owners: { stageAcknowledged }
    });
    await expect(index(request())).rejects.toMatchObject({
      code: "provider_acknowledgement_invalid"
    });
    expect(stageAcknowledged).not.toHaveBeenCalled();
  });

  it("accepts the validated runtime search batch maximum", async () => {
    const stageAcknowledged = vi.fn(async () => 2);
    const index = createDocumentSearchIndexer({
      batchSize: 10_000,
      provider: {
        kind: "opensearch",
        async writeAcknowledged(input) {
          return {
            acknowledgementPublicId: `ack-${input.batchOrdinal}`,
            documentIds: input.documents.map((item) => item.id)
          };
        },
        async makeVisible() {}
      },
      owners: { stageAcknowledged }
    });

    await expect(index(request())).resolves.toMatchObject({
      acknowledgedDocumentCount: 2,
      batchCount: 1
    });
  });

  it.each([
    ["first provider write", "provider:1"],
    ["first ownership stage", "owner:1"],
    ["second provider write", "provider:2"],
    ["second ownership stage", "owner:2"],
    ["provider visibility refresh", "visibility:1"]
  ] as const)("does not report indexed completion when %s fails", async (_, failurePoint) => {
    const calls: string[] = [];
    let providerCount = 0;
    let ownerCount = 0;
    const error = new Error(`injected:${failurePoint}`);
    const fail = (point: string): void => {
      calls.push(point);
      if (point === failurePoint) throw error;
    };
    const index = createDocumentSearchIndexer({
      batchSize: 1,
      provider: {
        kind: "opensearch",
        async writeAcknowledged(input) {
          providerCount += 1;
          fail(`provider:${providerCount}`);
          return {
            acknowledgementPublicId: `ack-${providerCount}`,
            documentIds: input.documents.map((item) => item.id)
          };
        },
        async makeVisible() { fail("visibility:1"); }
      },
      owners: {
        async stageAcknowledged() {
          ownerCount += 1;
          fail(`owner:${ownerCount}`);
          return 1;
        }
      }
    });

    await expect(index(request())).rejects.toBe(error);
    expect(calls.at(-1)).toBe(failurePoint);
  });
});

function request() {
  return {
    knowledgeBaseId: "knowledge-base-a",
    sourceFilePublicId: "source-a",
    sourceRevisionPublicId: "revision-a",
    searchProjectionPublicId: "projection-a",
    providerIndexUid: "focowiki-a",
    documents: [document("search-a", "file"), document("search-b", "segment")],
    stagedAt: "2026-08-14T07:00:00.000Z",
    signal: new AbortController().signal
  };
}

function document(publicId: string, documentKind: "file" | "segment") {
  return {
    publicId,
    schemaVersion: "document-search-v1" as const,
    knowledgeBaseId: "knowledge-base-a",
    sourceFilePublicId: "source-a",
    sourceRevisionPublicId: "revision-a",
    searchContractSha256: "a".repeat(64),
    documentKind,
    logicalPath: "a.md",
    title: "A",
    metadata: {}, segmentOrdinal: documentKind === "file" ? null : 0,
    headingAncestors: [], searchText: "A body",
    embeddingArtifactPublicId: null
  };
}
