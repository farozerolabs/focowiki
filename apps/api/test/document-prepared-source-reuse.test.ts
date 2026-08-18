import { describe, expect, it, vi } from "vitest";
import {
  canReuseDocumentPreparedSource,
  loadReusableDocumentPreparedSource
} from
  "../src/document-indexing/infrastructure/production-document-prepared-source-reuse.js";

describe("document prepared-source reuse", () => {
  const base = {
    operationKind: "source_file_move",
    currentSourceChecksumSha256: "a".repeat(64),
    currentSourceObjectId: "object-source",
    currentContentContractSha256: "b".repeat(64),
    currentLogicalPath: "new/guides/overview.md",
    prior: {
      sourceChecksumSha256: "a".repeat(64),
      sourceObjectId: "object-source",
      contentContractSha256: "b".repeat(64),
      sourceLogicalPath: "old/guides/overview.md",
      parsedMetadata: {}
    }
  } as const;

  it("reuses path-independent preparation when only the parent path moved", () => {
    expect(canReuseDocumentPreparedSource(base)).toBe(true);
    expect(canReuseDocumentPreparedSource({
      ...base,
      operationKind: "source_directory_move"
    })).toBe(true);
  });

  it("reuses a renamed file only when an explicit title keeps content inputs stable", () => {
    expect(canReuseDocumentPreparedSource({
      ...base,
      currentLogicalPath: "new/guides/renamed.md"
    })).toBe(false);
    expect(canReuseDocumentPreparedSource({
      ...base,
      currentLogicalPath: "new/guides/renamed.md",
      prior: { ...base.prior, parsedMetadata: { title: "Stable title" } }
    })).toBe(true);
  });

  it("rejects replacement, changed bodies, objects, or preparation contracts", () => {
    expect(canReuseDocumentPreparedSource({
      ...base,
      operationKind: "source_replace"
    })).toBe(false);
    expect(canReuseDocumentPreparedSource({
      ...base,
      currentSourceChecksumSha256: "c".repeat(64)
    })).toBe(false);
    expect(canReuseDocumentPreparedSource({
      ...base,
      currentSourceObjectId: "different-object"
    })).toBe(false);
    expect(canReuseDocumentPreparedSource({
      ...base,
      currentContentContractSha256: "d".repeat(64)
    })).toBe(false);
  });

  it("loads the prior committed snapshot without reading the source object", async () => {
    const snapshot = {
      schemaVersion: "document-prepared-source-v1",
      body: "# Stable title\n\nBody",
      metadata: {},
      parsedMetadata: { title: "Stable title" },
      resolvedMetadata: { title: "Stable title" },
      contentProfile: {},
      structureProfile: {},
      referenceProfile: {},
      artifacts: {}
    };
    const receipts = {
      findForRevision: vi.fn(async () => ({
        value: {
          schemaVersion: "document-prepared-receipt-v1",
          contentContractSha256: "b".repeat(64),
          sourceObjectId: "object-source",
          sourceChecksumSha256: "a".repeat(64),
          sourceLogicalPath: "old/overview.md",
          sourceLinkBaseLogicalPath: "overview.md",
          preparedSnapshot: {
            objectId: "object-snapshot",
            storageKey: "objects/object-snapshot",
            checksumSha256: "c".repeat(64),
            byteCount: 123,
            contentType: "application/json; charset=utf-8",
            objectFormat: "okf-generated-json-v1"
          }
        }
      }))
    };
    const bodies = {
      readVerified: vi.fn(async () => new TextEncoder().encode(
        JSON.stringify(snapshot)
      ))
    };
    const result = await loadReusableDocumentPreparedSource({
      operationKind: "source_file_move",
      knowledgeBaseId: "knowledge-base-reuse",
      priorActiveSourceRevisionPublicId: "source-revision-prior",
      currentSourceChecksumSha256: "a".repeat(64),
      currentSourceObjectId: "object-source",
      currentContentContractSha256: "b".repeat(64),
      currentLogicalPath: "new/overview.md",
      receipts: receipts as never,
      bodies: bodies as never,
      maximumSnapshotBytes: 4096,
      signal: new AbortController().signal
    });
    expect(result?.body).toBe(snapshot.body);
    expect(result?.sourceLinkBaseLogicalPath).toBe("overview.md");
    expect(receipts.findForRevision).toHaveBeenCalledOnce();
    expect(bodies.readVerified).toHaveBeenCalledOnce();
  });
});
