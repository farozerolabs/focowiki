import { describe, expect, it } from "vitest";
import {
  createStorageVnextSearchSchemaChecksum,
  createStorageVnextSearchSettings
} from "../src/storage-vnext/search/settings.js";
import {
  createStorageVnextSearchSettingsChecksum
} from "../src/storage-vnext/search/candidate-lifecycle.js";

describe("storage vNext unified search settings", () => {
  it("supports content and graph-seed documents in one index contract", () => {
    const settings = createStorageVnextSearchSettings({ searchCutoffMs: 750 });

    expect(settings.searchableAttributes).toEqual([
      "title",
      "logicalPath",
      "searchText",
      "rankingTerms"
    ]);
    expect(settings.filterableAttributes).toEqual([
      "knowledgeBaseId",
      "documentKind",
      "schemaVersion",
      "sourceFilePublicId"
    ]);
    expect(settings.displayedAttributes).toEqual(expect.arrayContaining([
      "sourceFilePublicId",
      "sourceRevisionPublicId",
      "logicalPath",
      "searchText"
    ]));
    expect(settings.distinctAttribute).toBe("sourceFilePublicId");
    expect(settings.searchCutoffMs).toBe(750);
    expect(createStorageVnextSearchSettingsChecksum(settings)).toMatch(/^[0-9a-f]{64}$/u);
    expect(createStorageVnextSearchSchemaChecksum()).toMatch(/^[0-9a-f]{64}$/u);
  });
});
