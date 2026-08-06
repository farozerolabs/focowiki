import { createHash } from "node:crypto";
import type {
  SearchEngineSettings
} from "../../application/ports/search-engine-transport.js";
import {
  STORAGE_VNEXT_CONTENT_SCHEMA_VERSION,
  STORAGE_VNEXT_GRAPH_SEED_SCHEMA_VERSION
} from "./documents.js";

export function createStorageVnextSearchSettings(input: {
  searchCutoffMs: number;
}): SearchEngineSettings {
  if (
    !Number.isSafeInteger(input.searchCutoffMs)
    || input.searchCutoffMs < 50
    || input.searchCutoffMs > 10_000
  ) throw new Error("Storage vNext search cutoff is invalid");
  return {
    searchableAttributes: [
      "title",
      "logicalPath",
      "searchText",
      "rankingTerms"
    ],
    filterableAttributes: [
      {
        attributePatterns: [
          "knowledgeBaseId",
          "documentKind",
          "schemaVersion",
          "sourceFilePublicId"
        ],
        features: {
          facetSearch: false,
          filter: {
            equality: true,
            comparison: false
          }
        }
      }
    ],
    displayedAttributes: [
      "id",
      "schemaVersion",
      "documentKind",
      "contentKind",
      "knowledgeBaseId",
      "sourceFilePublicId",
      "sourceRevisionPublicId",
      "logicalPath",
      "fileKind",
      "title",
      "segmentOrdinal",
      "headingAncestors",
      "searchText",
      "rankingTerms"
    ],
    sortableAttributes: [],
    rankingRules: [
      "words",
      "typo",
      "proximity",
      "attribute",
      "sort",
      "exactness"
    ],
    distinctAttribute: "sourceFilePublicId",
    pagination: { maxTotalHits: 2_000 },
    searchCutoffMs: input.searchCutoffMs,
    localizedAttributes: [],
    typoTolerance: { disableOnAttributes: ["logicalPath"] }
  };
}

export function createStorageVnextSearchSchemaChecksum(): string {
  return createHash("sha256").update(JSON.stringify({
    content: STORAGE_VNEXT_CONTENT_SCHEMA_VERSION,
    graphSeed: STORAGE_VNEXT_GRAPH_SEED_SCHEMA_VERSION,
    primaryKey: "id"
  })).digest("hex");
}
