export type SearchProviderKind = "meilisearch" | "opensearch";

export const SEARCH_PROVIDER_KINDS = ["meilisearch", "opensearch"] as const;

export function isSearchProviderKind(value: unknown): value is SearchProviderKind {
  return typeof value === "string"
    && SEARCH_PROVIDER_KINDS.includes(value as SearchProviderKind);
}

export type SearchFilterField =
  | "knowledgeBaseId"
  | "documentKind"
  | "schemaVersion"
  | "sourceFilePublicId"
  | "sourceRevisionPublicId"
  | "okfSignals.status"
  | "okfSignals.trustTier"
  | "okfSignals.staleAfterEpochDay"
  | "visible";

export type SearchFilterExpression =
  | {
      kind: "equals";
      field: Exclude<SearchFilterField, "visible">;
      value: string;
    }
  | {
      kind: "boolean";
      field: "visible";
      value: boolean;
    }
  | {
      kind: "range";
      field: "okfSignals.staleAfterEpochDay";
      operator: "lte" | "gt";
      value: number;
    }
  | {
      kind: "and";
      operands: readonly SearchFilterExpression[];
    }
  | {
      kind: "or";
      operands: readonly SearchFilterExpression[];
    };

export type SearchProviderIndexDefinition = {
  primaryKey: "id";
  searchableAttributes: readonly string[];
  filterableAttributes: readonly string[];
  displayedAttributes: readonly string[];
  rankingRules: readonly string[];
  distinctAttribute: "sourceFilePublicId";
  maximumTotalHits: number;
  searchCutoffMs: number;
  typoDisabledAttributes: readonly string[];
};

export type SearchProviderDocument = Readonly<Record<string, unknown>> & {
  id: string;
};

export type SearchProviderOperationReceipt =
  | { state: "completed" }
  | { state: "pending"; operationRef: string };

export type SearchProviderOperationStatus =
  | { state: "pending" }
  | { state: "completed" }
  | { state: "failed"; errorCode: SearchProviderErrorCode };

export type SearchProviderHit = {
  documentId: string;
  sourceFilePublicId: string;
  sourceRevisionPublicId: string;
  logicalPath: string;
  title: string;
  normalizedScore: number;
  snippets: readonly string[];
  sortKey: readonly (string | number)[];
  continuationAfter: string;
  document: Readonly<Record<string, unknown>>;
};

export type SearchProviderQueryRequest = {
  indexUid: string;
  query: string;
  evidenceFamilies: readonly (
    | "exact"
    | "text"
    | "phrase"
    | "typo"
    | "jieba"
    | "graph"
  )[];
  filters: SearchFilterExpression;
  searchFields: readonly string[];
  returnFields: readonly string[];
  limit: number;
  continuation: string | null;
  cropLength: number;
  deadlineMs: number;
  matchingStrategy: "all" | "last";
  distinctBy: "sourceFilePublicId" | null;
};

export type SearchProviderQueryResult = {
  hits: readonly SearchProviderHit[];
  continuation: string | null;
  processingTimeMs: number;
};

export type SearchProviderDocumentScanPage = {
  documents: readonly Readonly<Record<string, unknown>>[];
  continuation: string | null;
};

export type SearchProviderErrorCode =
  | "SEARCH_ENGINE_UNAVAILABLE"
  | "SEARCH_ENGINE_AUTHENTICATION_FAILED"
  | "SEARCH_ENGINE_AUTHORIZATION_FAILED"
  | "SEARCH_ENGINE_OVERLOADED"
  | "SEARCH_ENGINE_TIMEOUT"
  | "SEARCH_ENGINE_VERSION_INCOMPATIBLE"
  | "SEARCH_ENGINE_MAPPING_INVALID"
  | "SEARCH_ENGINE_REQUEST_FAILED";

export class SearchProviderError extends Error {
  public constructor(
    public readonly code: SearchProviderErrorCode,
    public readonly retryable: boolean
  ) {
    super(
      code === "SEARCH_ENGINE_AUTHENTICATION_FAILED"
        ? "Search service authentication failed"
        : code === "SEARCH_ENGINE_AUTHORIZATION_FAILED"
          ? "Search service authorization failed"
          : code === "SEARCH_ENGINE_OVERLOADED"
            ? "Search service is temporarily overloaded"
            : code === "SEARCH_ENGINE_TIMEOUT"
              ? "Search service request timed out"
              : code === "SEARCH_ENGINE_VERSION_INCOMPATIBLE"
                ? "Search service version is incompatible"
                : code === "SEARCH_ENGINE_UNAVAILABLE"
                  ? "Search service is temporarily unavailable"
                  : "Search service request failed"
    );
    this.name = "SearchProviderError";
  }
}

export interface SearchProviderAdminPort {
  health(): Promise<{ available: boolean; version: string }>;
  createIndex(input: {
    indexUid: string;
    definition: SearchProviderIndexDefinition;
  }): Promise<SearchProviderOperationReceipt>;
  getIndex(input: {
    indexUid: string;
  }): Promise<{ indexUid: string; primaryKey: string | null } | null>;
  getIndexDefinition(input: {
    indexUid: string;
  }): Promise<SearchProviderIndexDefinition | null>;
  updateIndexDefinition(input: {
    indexUid: string;
    definition: SearchProviderIndexDefinition;
  }): Promise<SearchProviderOperationReceipt>;
  deleteIndex(input: {
    indexUid: string;
  }): Promise<SearchProviderOperationReceipt>;
}

export interface SearchProviderWritePort {
  writeDocuments(input: {
    indexUid: string;
    documents: readonly SearchProviderDocument[];
    correlation: string;
  }): Promise<SearchProviderOperationReceipt>;
  deleteDocuments(input: {
    indexUid: string;
    documentIds?: readonly string[];
    filters?: SearchFilterExpression;
    correlation: string;
  }): Promise<SearchProviderOperationReceipt>;
  refreshIndex(input: { indexUid: string }): Promise<void>;
}

export interface SearchProviderQueryPort {
  query(input: SearchProviderQueryRequest): Promise<SearchProviderQueryResult>;
}

export interface SearchProviderValidationPort {
  countDocuments(input: { indexUid: string }): Promise<number>;
  scanDocuments(input: {
    indexUid: string;
    continuation: string | null;
    limit: number;
    fields: readonly string[];
  }): Promise<SearchProviderDocumentScanPage>;
}

export interface SearchProviderOperationPort {
  getOperation(input: {
    operationRef: string;
  }): Promise<SearchProviderOperationStatus>;
  findOperationByCorrelation(input: {
    indexUid: string;
    correlation: string;
  }): Promise<SearchProviderOperationReceipt | null>;
}

export interface SearchProviderMaintenancePort {
  getPressure?(): Promise<{
    queueLatencyMs: number;
    residentMemoryBytes: number;
  }>;
  listOwnedIndexes?(input: {
    indexUidPrefix: string;
    continuation: string | null;
    limit: number;
  }): Promise<{
    indexes: readonly { indexUid: string; updatedAt: string }[];
    restartContinuation: string;
    continuation: string | null;
  }>;
  deleteOwnedFinishedOperations?(input: {
    indexUidPrefix: string;
    beforeFinishedAt: string;
    continuation: string | null;
    limit: number;
  }): Promise<{
    deleted: number;
    continuation: string | null;
    operation: SearchProviderOperationReceipt;
  }>;
  getStorageStats?(): Promise<{
    databaseSizeBytes: number;
    usedDatabaseSizeBytes: number;
  }>;
  compactIndex?(input: {
    indexUid: string;
  }): Promise<SearchProviderOperationReceipt>;
}

export interface SearchProviderRuntime {
  readonly kind: SearchProviderKind;
  readonly admin: SearchProviderAdminPort;
  readonly write: SearchProviderWritePort;
  readonly query: SearchProviderQueryPort;
  readonly validation: SearchProviderValidationPort;
  readonly operations: SearchProviderOperationPort;
  readonly maintenance?: SearchProviderMaintenancePort;
  close(): Promise<void>;
}
