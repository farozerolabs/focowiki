import { describe, expect, it } from "vitest";
import { createDocumentSearchProjectionBootstrap } from
  "../src/document-indexing/domain/document-search-projection.js";
import { createStorageVnextSearchSettings } from
  "../src/storage-vnext/search/settings.js";

describe("document search projection", () => {
  it("creates a stable provider-neutral bootstrap identity", () => {
    const definition = createStorageVnextSearchSettings({ searchCutoffMs: 500 });
    const first = createDocumentSearchProjectionBootstrap({
      knowledgeBaseId: "knowledge-base-one",
      providerKind: "opensearch",
      indexUidPrefix: "focowiki",
      definition
    });
    const second = createDocumentSearchProjectionBootstrap({
      knowledgeBaseId: "knowledge-base-one",
      providerKind: "opensearch",
      indexUidPrefix: "focowiki",
      definition
    });

    expect(second).toEqual(first);
    expect(first.publicId).toMatch(/^search-projection-[0-9a-f]{64}$/u);
    expect(first.providerIndexUid).toMatch(/^focowiki_[0-9a-f]{16}_/u);
    expect(first.schemaChecksumSha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(first.settingsChecksumSha256).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("changes identity when the selected provider changes", () => {
    const definition = createStorageVnextSearchSettings({ searchCutoffMs: 500 });
    const openSearch = createDocumentSearchProjectionBootstrap({
      knowledgeBaseId: "knowledge-base-one",
      providerKind: "opensearch",
      indexUidPrefix: "focowiki",
      definition
    });
    const meilisearch = createDocumentSearchProjectionBootstrap({
      knowledgeBaseId: "knowledge-base-one",
      providerKind: "meilisearch",
      indexUidPrefix: "focowiki",
      definition
    });

    expect(meilisearch.publicId).not.toBe(openSearch.publicId);
    expect(meilisearch.providerIndexUid).not.toBe(openSearch.providerIndexUid);
  });
});
