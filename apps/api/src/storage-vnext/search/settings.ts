import { createHash } from "node:crypto";
import type {
  SearchProviderIndexDefinition
} from "../../application/ports/search-provider-runtime.js";
import {
  STORAGE_VNEXT_CONTENT_SCHEMA_VERSION,
  STORAGE_VNEXT_GRAPH_SEED_SCHEMA_VERSION
} from "./documents.js";

export function createStorageVnextSearchSettings(input: {
  searchCutoffMs: number;
}): SearchProviderIndexDefinition {
  if (
    !Number.isSafeInteger(input.searchCutoffMs)
    || input.searchCutoffMs < 50
    || input.searchCutoffMs > 10_000
  ) throw new Error("Storage vNext search cutoff is invalid");
  return {
    primaryKey: "id",
    searchableAttributes: [
      "title",
      "logicalPath",
      "searchText",
      "rankingTerms"
    ],
    filterableAttributes: [
      "knowledgeBaseId",
      "documentKind",
      "contentKind",
      "fileKind",
      "schemaVersion",
      "sourceFilePublicId",
      "okfSignals.status",
      "okfSignals.trustTier",
      "okfSignals.staleAfterEpochDay"
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
      "rankingTerms",
      "okfSignals"
    ],
    rankingRules: [
      "words",
      "typo",
      "proximity",
      "attribute",
      "sort",
      "exactness"
    ],
    distinctAttribute: "sourceFilePublicId",
    maximumTotalHits: 2_000,
    searchCutoffMs: input.searchCutoffMs,
    typoDisabledAttributes: ["logicalPath"]
  };
}

export function createStorageVnextSearchSchemaChecksum(): string {
  return createHash("sha256").update(JSON.stringify({
    content: STORAGE_VNEXT_CONTENT_SCHEMA_VERSION,
    graphSeed: STORAGE_VNEXT_GRAPH_SEED_SCHEMA_VERSION,
    primaryKey: "id"
  })).digest("hex");
}
