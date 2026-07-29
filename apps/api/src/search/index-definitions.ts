import { createHash } from "node:crypto";
import type { SearchEngineSettings } from "../application/ports/search-engine-transport.js";
import { SEARCH_CONTENT_SCHEMA_VERSION } from "./content-segment-mapper.js";
import { SEARCH_GRAPH_SEED_SCHEMA_VERSION } from "./graph-seed-mapper.js";

export const SEARCH_CONTENT_INDEX_VERSION = "meili-content-v1";
export const SEARCH_GRAPH_INDEX_VERSION = "meili-graph-v1";
export const SEARCH_INDEX_PRIMARY_KEY = "id";

export type SearchIndexKind = "content" | "graph";

export type SearchIndexDefinition = {
  kind: SearchIndexKind;
  schemaVersion: string;
  activeUid: string;
  stagingUid: string;
  primaryKey: string;
  settings: SearchEngineSettings;
  settingsChecksum: string;
};

export type SearchProjectionContract = {
  contentSchemaVersion: string;
  graphSchemaVersion: string;
  contentSettingsChecksum: string;
  graphSettingsChecksum: string;
};

const COMMON_FILTERABLE_ATTRIBUTES = [
  "knowledgeBaseId",
  "sourceFileId",
  "sourceRevisionId",
  "visibleFromEpoch",
  "visibleUntilEpoch",
  "schemaVersion"
];

const CONTENT_SETTINGS: SearchEngineSettings = {
  searchableAttributes: [
    "title",
    "headingPath",
    "logicalPath",
    "body",
    "metadataText"
  ],
  filterableAttributes: [
    ...COMMON_FILTERABLE_ATTRIBUTES,
    "fileKind"
  ],
  displayedAttributes: [
    "id",
    "sourceFileId",
    "sourceRevisionId",
    "logicalPath",
    "fileKind",
    "title",
    "headingPath",
    "body",
    "sourceUrl",
    "checksumSha256",
    "segmentOrdinal",
    "segmentTotal",
    "visibleFromEpoch",
    "visibleUntilEpoch",
    "schemaVersion"
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
  distinctAttribute: "sourceFileId",
  pagination: {
    maxTotalHits: 2_000
  },
  searchCutoffMs: 1_000,
  localizedAttributes: [],
  typoTolerance: {
    disableOnAttributes: ["logicalPath"]
  }
};

const GRAPH_SETTINGS: SearchEngineSettings = {
  searchableAttributes: [
    "title",
    "logicalPath",
    "lexicalText",
    "phraseTerms",
    "exactTerms",
    "explicitReferences"
  ],
  filterableAttributes: [
    ...COMMON_FILTERABLE_ATTRIBUTES
  ],
  displayedAttributes: [
    "id",
    "sourceFileId",
    "sourceRevisionId",
    "logicalPath",
    "title",
    "sourceUrl",
    "lexicalText",
    "exactTerms",
    "phraseTerms",
    "explicitReferences",
    "fingerprint",
    "visibleFromEpoch",
    "visibleUntilEpoch",
    "schemaVersion"
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
  distinctAttribute: "sourceFileId",
  pagination: {
    maxTotalHits: 2_000
  },
  searchCutoffMs: 1_000,
  localizedAttributes: [],
  typoTolerance: {
    disableOnAttributes: ["logicalPath", "explicitReferences"]
  }
};

export function createSearchIndexDefinition(input: {
  indexPrefix: string;
  knowledgeBaseId: string;
  kind: SearchIndexKind;
  pendingEpoch: number;
  searchCutoffMs?: number;
}): SearchIndexDefinition {
  if (!Number.isSafeInteger(input.pendingEpoch) || input.pendingEpoch < 1) {
    throw new Error("Pending search epoch must be a positive integer");
  }
  const activeUid = createStableSearchIndexUid(input);
  const settings = cloneSettings(
    input.kind === "content" ? CONTENT_SETTINGS : GRAPH_SETTINGS
  );
  if (input.searchCutoffMs !== undefined) {
    if (
      !Number.isSafeInteger(input.searchCutoffMs)
      || input.searchCutoffMs < 50
      || input.searchCutoffMs > 10_000
    ) {
      throw new Error("Search cutoff must be between 50 and 10000 milliseconds");
    }
    settings.searchCutoffMs = input.searchCutoffMs;
  }

  return {
    kind: input.kind,
    schemaVersion: input.kind === "content"
      ? SEARCH_CONTENT_INDEX_VERSION
      : SEARCH_GRAPH_INDEX_VERSION,
    activeUid,
    stagingUid: createStagingSearchIndexUid({
      indexPrefix: input.indexPrefix,
      knowledgeBaseId: input.knowledgeBaseId,
      kind: input.kind,
      pendingEpoch: input.pendingEpoch
    }),
    primaryKey: SEARCH_INDEX_PRIMARY_KEY,
    settings,
    settingsChecksum: createSearchIndexSettingsChecksum(settings)
  };
}

export function createStableSearchIndexUid(input: {
  indexPrefix: string;
  knowledgeBaseId: string;
  kind: SearchIndexKind;
}): string {
  const knowledgeBaseHash = createHash("sha256")
    .update(input.knowledgeBaseId)
    .digest("hex")
    .slice(0, 16);
  return `${input.indexPrefix}_${input.kind}_${knowledgeBaseHash}`;
}

export function createStagingSearchIndexUid(input: {
  indexPrefix: string;
  knowledgeBaseId: string;
  kind: SearchIndexKind;
  pendingEpoch: number;
}): string {
  if (!Number.isSafeInteger(input.pendingEpoch) || input.pendingEpoch < 1) {
    throw new Error("Pending search epoch must be a positive integer");
  }
  return `${createStableSearchIndexUid(input)}_staging_${input.pendingEpoch}`;
}

export function createSearchProjectionContract(input: {
  searchCutoffMs: number;
}): SearchProjectionContract {
  const content = createSearchIndexDefinition({
    indexPrefix: "contract",
    knowledgeBaseId: "contract",
    kind: "content",
    pendingEpoch: 1,
    searchCutoffMs: input.searchCutoffMs
  });
  const graph = createSearchIndexDefinition({
    indexPrefix: "contract",
    knowledgeBaseId: "contract",
    kind: "graph",
    pendingEpoch: 1,
    searchCutoffMs: input.searchCutoffMs
  });
  return {
    contentSchemaVersion: SEARCH_CONTENT_SCHEMA_VERSION,
    graphSchemaVersion: SEARCH_GRAPH_SEED_SCHEMA_VERSION,
    contentSettingsChecksum: content.settingsChecksum,
    graphSettingsChecksum: graph.settingsChecksum
  };
}

export function createSearchIndexSettingsChecksum(
  settings: SearchEngineSettings
): string {
  const normalized = structuredClone(settings);
  normalized.typoTolerance.disableOnAttributes.sort((left, right) =>
    left.localeCompare(right)
  );
  return createHash("sha256")
    .update(canonicalJson(normalized))
    .digest("hex");
}

function cloneSettings(settings: SearchEngineSettings): SearchEngineSettings {
  return structuredClone(settings);
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
