import { describe, expect, it } from "vitest";
import {
  createStorageVnextSearchSchemaChecksum,
  createStorageVnextSearchSettings
} from "../src/storage-vnext/search/settings.js";
import {
  createStorageVnextSearchSettingsChecksum
} from "../src/storage-vnext/search/index-identity.js";

describe("storage vNext unified search settings", () => {
  it("supports content, graph seed, and relationship documents in one contract", () => {
    const settings = createStorageVnextSearchSettings({ searchCutoffMs: 750 });

    expect(settings.searchableAttributes).toEqual([
      "title",
      "logicalPath",
      "targetTitle",
      "targetLogicalPath",
      "searchText",
      "rankingTerms"
    ]);
    expect(settings.filterableAttributes).toEqual([
      "knowledgeBaseId",
      "documentKind",
      "contentKind",
      "fileKind",
      "schemaVersion",
      "sourceFilePublicId",
      "sourceRevisionPublicId",
      "relationPublicId",
      "evidencePublicId",
      "targetSourceFilePublicId",
      "targetSourceRevisionPublicId",
      "visible",
      "okfSignals.status",
      "okfSignals.trustTier",
      "okfSignals.staleAfterEpochDay"
    ]);
    expect(settings.displayedAttributes).toEqual(expect.arrayContaining([
      "sourceFilePublicId",
      "sourceRevisionPublicId",
      "logicalPath",
      "targetLogicalPath",
      "searchText",
      "okfSignals"
    ]));
    expect(settings.distinctAttribute).toBe("sourceFilePublicId");
    expect(settings.searchCutoffMs).toBe(750);
    expect(createStorageVnextSearchSettingsChecksum(settings)).toMatch(/^[0-9a-f]{64}$/u);
    expect(createStorageVnextSearchSchemaChecksum()).toMatch(/^[0-9a-f]{64}$/u);
  });
});
