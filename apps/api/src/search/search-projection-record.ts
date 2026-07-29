import type { SearchEngineDocument } from "../application/ports/search-engine-transport.js";
import {
  SEARCH_CONTENT_SCHEMA_VERSION,
  createContentSegmentId,
  normalizeSearchMetadata,
  stableSearchJson,
  type ContentSegmentDocument
} from "./content-segment-mapper.js";
import {
  mapGraphSeedDocument,
  type GraphSeedDocument
} from "./graph-seed-mapper.js";

export type SearchProjectionAction = "upsert" | "close";

export type SearchProjectionRecord = {
  key: string;
  document: SearchEngineDocument;
};

export type ContentProjectionFact = {
  action: SearchProjectionAction;
  knowledgeBaseId: string;
  sourceFileId: string;
  sourceRevisionId: string;
  pathRevision: number;
  logicalPath: string;
  fileKind: string;
  title: string | null;
  heading: string | null;
  body: string;
  metadata: Record<string, unknown>;
  sourceUrl: string | null;
  checksumSha256: string;
  segmentOrdinal: number;
  segmentTotal: number;
  activeEpoch: number;
  pendingEpoch: number;
};

export type GraphProjectionFact = {
  action: SearchProjectionAction;
  knowledgeBaseId: string;
  sourceFileId: string;
  sourceRevisionId: string;
  logicalPath: string;
  title: string;
  sourceUrl: string | null;
  lexicalText: string;
  exactTerms: string[];
  phraseTerms: string[];
  explicitReferences: string[];
  fingerprint: string;
  activeEpoch: number;
  pendingEpoch: number;
};

export function createContentProjectionRecord(
  input: ContentProjectionFact
): SearchProjectionRecord & { document: ContentSegmentDocument } {
  const metadata = normalizeSearchMetadata(input.metadata);
  return {
    key: [
      "content",
      input.action,
      input.sourceRevisionId,
      input.pathRevision,
      input.segmentOrdinal
    ].join(":"),
    document: {
      id: createContentSegmentId(input, input.segmentOrdinal),
      knowledgeBaseId: input.knowledgeBaseId,
      sourceFileId: input.sourceFileId,
      sourceRevisionId: input.sourceRevisionId,
      pathRevision: input.pathRevision,
      logicalPath: input.logicalPath,
      fileKind: input.fileKind,
      title: input.title,
      headingPath: input.heading ? [input.heading] : [],
      body: input.body,
      metadata,
      metadataText: Object.keys(metadata).length > 0
        ? stableSearchJson(metadata)
        : "",
      sourceUrl: input.sourceUrl,
      checksumSha256: input.checksumSha256,
      segmentOrdinal: input.segmentOrdinal,
      segmentTotal: input.segmentTotal,
      visibleFromEpoch: input.action === "upsert"
        ? input.pendingEpoch
        : 1,
      visibleUntilEpoch: input.action === "close"
        ? input.pendingEpoch
        : null,
      schemaVersion: SEARCH_CONTENT_SCHEMA_VERSION
    }
  };
}

export function createGraphProjectionRecord(
  input: GraphProjectionFact
): SearchProjectionRecord & { document: GraphSeedDocument } {
  return {
    key: `graph:${input.action}:${input.sourceFileId}`,
    document: mapGraphSeedDocument({
      knowledgeBaseId: input.knowledgeBaseId,
      sourceFileId: input.sourceFileId,
      sourceRevisionId: input.sourceRevisionId,
      logicalPath: input.logicalPath,
      title: input.title,
      sourceUrl: input.sourceUrl,
      lexicalText: input.lexicalText,
      exactTerms: input.exactTerms,
      phraseTerms: input.phraseTerms,
      explicitReferences: input.explicitReferences,
      fingerprint: input.fingerprint,
      visibleFromEpoch: input.action === "upsert"
        ? input.pendingEpoch
        : 1,
      visibleUntilEpoch: input.action === "close"
        ? input.pendingEpoch
        : null
    })
  };
}
