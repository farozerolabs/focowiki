import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createDocumentPageBaseLoader } from
  "../src/document-indexing/infrastructure/document-page-base-loader.js";

describe("document page base loader", () => {
  it("deduplicates concurrent immutable reads and reuses a bounded hot entry", async () => {
    const value = {
      schemaVersion: "document-page-base-v1",
      sourceFilePublicId: "source-1",
      sourceRevisionPublicId: "revision-1",
      resourceRevision: 1,
      logicalPath: "guides/source.md",
      sourceLinkBaseLogicalPath: null,
      title: "Source",
      body: "Body",
      metadata: {},
      sourceMetadata: {},
      modelSuggestions: null,
      checksumSha256: "a".repeat(64),
      byteCount: 4,
      contentType: "text/markdown; charset=utf-8",
      semanticEntities: []
    };
    const bytes = new TextEncoder().encode(JSON.stringify(value));
    const readVerified = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return bytes;
    });
    const loader = createDocumentPageBaseLoader({
      bodies: { readVerified } as never,
      maximumBytes: 1_000,
      cacheMaximumEntries: 2
    });
    const base = {
      publicId: "base-1",
      sourceFilePublicId: "source-1",
      sourceRevisionPublicId: "revision-1",
      inputFingerprintSha256: "b".repeat(64),
      object: {
        objectId: "object-1",
        storageKey: "generated/object-1.json",
        checksumSha256: createHash("sha256").update(bytes).digest("hex"),
        byteCount: bytes.byteLength,
        contentType: "application/json; charset=utf-8" as const,
        objectFormat: "okf-generated-json-v1" as const
      }
    };
    const signal = new AbortController().signal;

    const [first, second] = await Promise.all([
      loader({ base, signal }),
      loader({ base, signal })
    ]);
    const third = await loader({ base, signal });

    expect(first).toEqual(second);
    expect(third).toEqual(first);
    expect(readVerified).toHaveBeenCalledOnce();
  });
});
