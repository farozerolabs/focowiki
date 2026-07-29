import { createHash } from "node:crypto";
import type { ActiveGenerationScoredCursor } from "../application/ports/active-generation-read-repository.js";
import { createKnowledgeBaseRuntimeScopeIdentity } from "../redis/runtime-scope-identity.js";

export type SearchRequestIdentity = {
  knowledgeBaseId: string;
  generationId: string;
  queryHash: string;
  mode: "file" | "graph" | "hybrid";
  scope: "all" | "path" | "metadata";
  fileKind: string | null;
  graphDepth: 0 | 1 | 2;
  graphFanout: number;
  activeSearchEpoch: number;
  contentSchemaVersion: string;
  graphSchemaVersion: string;
  contentSettingsChecksum: string;
  graphSettingsChecksum: string;
  retrievalVersion: string;
  fusionVersion: string;
  settingsRevision: string;
};

export type SearchRankCursor = ActiveGenerationScoredCursor & {
  exactPriority?: number;
  queryHash?: string;
  activeSearchEpoch?: number;
  contentSchemaVersion?: string;
  graphSchemaVersion?: string;
  retrievalVersion?: string;
  fusionVersion?: string;
  settingsRevision?: string;
};

export type StoredSearchCursor = {
  version: 1;
  identity: SearchRequestIdentity;
  rankedCursor: SearchRankCursor;
  fusedPosition: {
    score: number;
    exactPriority: number;
  };
  tieBreaker: string;
  expiresAt: string;
};

export class SearchCursorIdentityError extends Error {
  public constructor() {
    super("Search cursor is invalid, expired, or belongs to another search request");
    this.name = "SearchCursorIdentityError";
  }
}

export function createSearchRequestIdentity(input: {
  knowledgeBaseId: string;
  generationId: string;
  normalizedQuery: string;
  mode: SearchRequestIdentity["mode"];
  scope: SearchRequestIdentity["scope"];
  fileKind: string | null;
  graphDepth: SearchRequestIdentity["graphDepth"];
  graphFanout: number;
  activeSearchEpoch: number;
  contentSchemaVersion: string;
  graphSchemaVersion: string;
  contentSettingsChecksum: string;
  graphSettingsChecksum: string;
  retrievalVersion: string;
  fusionVersion: string;
  settingsRevision: string;
}): SearchRequestIdentity {
  const queryHash = createHash("sha256")
    .update(JSON.stringify({
      query: input.normalizedQuery,
      scope: input.scope,
      fileKind: input.fileKind
    }))
    .digest("hex");
  return {
    knowledgeBaseId: input.knowledgeBaseId,
    generationId: input.generationId,
    queryHash,
    mode: input.mode,
    scope: input.scope,
    fileKind: input.fileKind,
    graphDepth: input.graphDepth,
    graphFanout: input.graphFanout,
    activeSearchEpoch: input.activeSearchEpoch,
    contentSchemaVersion: input.contentSchemaVersion,
    graphSchemaVersion: input.graphSchemaVersion,
    contentSettingsChecksum: input.contentSettingsChecksum,
    graphSettingsChecksum: input.graphSettingsChecksum,
    retrievalVersion: input.retrievalVersion,
    fusionVersion: input.fusionVersion,
    settingsRevision: input.settingsRevision
  };
}

export function createSearchCursorScope(identity: SearchRequestIdentity): string {
  return [
    "developer-openapi",
    "generation-search",
    createKnowledgeBaseRuntimeScopeIdentity(identity.knowledgeBaseId),
    identitySignature(identity)
  ].join(":");
}

export function createSearchPageCacheScope(identity: SearchRequestIdentity): string {
  return [
    "active-read",
    "developer-openapi",
    "file-search",
    createKnowledgeBaseRuntimeScopeIdentity(identity.knowledgeBaseId),
    identitySignature(identity)
  ].join(":");
}

export function createStoredSearchCursor(input: {
  identity: SearchRequestIdentity;
  cursor: SearchRankCursor;
  expiresAt: string;
}): StoredSearchCursor {
  return {
    version: 1,
    identity: input.identity,
    rankedCursor: input.cursor,
    fusedPosition: {
      score: input.cursor.score,
      exactPriority: input.cursor.exactPriority ?? 0
    },
    tieBreaker: input.cursor.recordId,
    expiresAt: input.expiresAt
  };
}

export function validateStoredSearchCursor(input: {
  stored: unknown;
  expectedIdentity: SearchRequestIdentity;
  now?: Date;
}): SearchRankCursor {
  const stored = input.stored;
  if (!isStoredSearchCursor(stored)) throw new SearchCursorIdentityError();
  if (
    identitySignature(stored.identity) !== identitySignature(input.expectedIdentity)
    || stored.tieBreaker !== stored.rankedCursor.recordId
    || stored.fusedPosition.score !== stored.rankedCursor.score
    || stored.fusedPosition.exactPriority !== (stored.rankedCursor.exactPriority ?? 0)
  ) {
    throw new SearchCursorIdentityError();
  }
  const expiresAt = Date.parse(stored.expiresAt);
  const now = (input.now ?? new Date()).getTime();
  if (!Number.isFinite(expiresAt) || expiresAt <= now) {
    throw new SearchCursorIdentityError();
  }
  return stored.rankedCursor;
}

function identitySignature(identity: SearchRequestIdentity): string {
  return createHash("sha256")
    .update(JSON.stringify([
      identity.knowledgeBaseId,
      identity.generationId,
      identity.queryHash,
      identity.mode,
      identity.scope,
      identity.fileKind,
      identity.graphDepth,
      identity.graphFanout,
      identity.activeSearchEpoch,
      identity.contentSchemaVersion,
      identity.graphSchemaVersion,
      identity.contentSettingsChecksum,
      identity.graphSettingsChecksum,
      identity.retrievalVersion,
      identity.fusionVersion,
      identity.settingsRevision
    ]))
    .digest("hex");
}

function isStoredSearchCursor(value: unknown): value is StoredSearchCursor {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Partial<StoredSearchCursor>;
  if (
    candidate.version !== 1
    || !candidate.identity
    || !candidate.rankedCursor
    || !candidate.fusedPosition
    || typeof candidate.tieBreaker !== "string"
    || typeof candidate.expiresAt !== "string"
  ) {
    return false;
  }
  const cursor = candidate.rankedCursor;
  return Number.isFinite(cursor.score)
    && typeof cursor.recordId === "string"
    && Number.isFinite(candidate.fusedPosition.score)
    && Number.isFinite(candidate.fusedPosition.exactPriority);
}
