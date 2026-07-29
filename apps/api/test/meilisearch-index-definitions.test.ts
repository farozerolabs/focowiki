import { describe, expect, it } from "vitest";
import {
  SEARCH_CONTENT_INDEX_VERSION,
  SEARCH_GRAPH_INDEX_VERSION,
  createSearchIndexDefinition,
  createSearchIndexSettingsChecksum
} from "../src/search/index-definitions.js";

describe("Meilisearch index definitions", () => {
  it("treats engine-normalized set ordering as one settings contract", () => {
    const definition = createSearchIndexDefinition({
      indexPrefix: "focowiki",
      knowledgeBaseId: "kb-one",
      kind: "graph",
      pendingEpoch: 1
    });
    const reordered = structuredClone(definition.settings);
    reordered.typoTolerance.disableOnAttributes.reverse();

    expect(createSearchIndexSettingsChecksum(reordered))
      .toBe(definition.settingsChecksum);
  });

  it("creates stable and staging UIDs without exposing knowledge-base IDs", () => {
    const content = createSearchIndexDefinition({
      indexPrefix: "focowiki",
      knowledgeBaseId: "kb-sensitive-identifier",
      kind: "content",
      pendingEpoch: 7
    });
    const graph = createSearchIndexDefinition({
      indexPrefix: "focowiki",
      knowledgeBaseId: "kb-sensitive-identifier",
      kind: "graph",
      pendingEpoch: 7
    });

    expect(content.schemaVersion).toBe(SEARCH_CONTENT_INDEX_VERSION);
    expect(graph.schemaVersion).toBe(SEARCH_GRAPH_INDEX_VERSION);
    expect(content.activeUid).toMatch(/^focowiki_content_[a-f0-9]{16}$/u);
    expect(content.stagingUid).toBe(`${content.activeUid}_staging_7`);
    expect(graph.activeUid).toMatch(/^focowiki_graph_[a-f0-9]{16}$/u);
    expect(content.activeUid).not.toContain("sensitive");
  });

  it("keeps settings bounded and source-file distinct", () => {
    const definition = createSearchIndexDefinition({
      indexPrefix: "focowiki",
      knowledgeBaseId: "kb-1",
      kind: "content",
      pendingEpoch: 1
    });

    expect(definition.primaryKey).toBe("id");
    expect(definition.settings.distinctAttribute).toBe("sourceFileId");
    expect(definition.settings.filterableAttributes).toEqual(expect.arrayContaining([
      "knowledgeBaseId",
      "sourceFileId",
      "visibleFromEpoch",
      "visibleUntilEpoch",
      "schemaVersion"
    ]));
    expect(definition.settings.sortableAttributes).toEqual([]);
    expect(definition.settings.searchableAttributes[0]).toBe("title");
    expect(definition.settings.searchableAttributes).toContain("body");
    expect(definition.settings.pagination.maxTotalHits).toBeLessThanOrEqual(2_000);
    expect(definition.settings.searchCutoffMs).toBeLessThanOrEqual(2_000);
  });

  it("produces a byte-stable settings checksum", () => {
    const definition = createSearchIndexDefinition({
      indexPrefix: "focowiki",
      knowledgeBaseId: "kb-1",
      kind: "content",
      pendingEpoch: 1
    });

    expect(createSearchIndexSettingsChecksum(definition.settings))
      .toBe(createSearchIndexSettingsChecksum(structuredClone(definition.settings)));
    expect(definition.settingsChecksum).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("binds the runtime search cutoff into immutable index settings", () => {
    const definition = createSearchIndexDefinition({
      indexPrefix: "focowiki",
      knowledgeBaseId: "kb-1",
      kind: "content",
      pendingEpoch: 1,
      searchCutoffMs: 750
    });

    expect(definition.settings.searchCutoffMs).toBe(750);
    expect(definition.settingsChecksum).toBe(
      createSearchIndexSettingsChecksum(definition.settings)
    );
  });
});
