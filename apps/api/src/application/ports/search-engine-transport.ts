export type SearchEngineTaskStatus =
  | "enqueued"
  | "processing"
  | "succeeded"
  | "failed"
  | "canceled"
  | "unknown";

export type SearchEngineTask = {
  taskUid: number;
  status: SearchEngineTaskStatus;
  errorCode: string | null;
};

export type SearchEngineSettings = {
  searchableAttributes: string[];
  filterableAttributes: Array<
    | string
    | {
        attributePatterns: string[];
        features: {
          facetSearch: boolean;
          filter: {
            equality: boolean;
            comparison: boolean;
          };
        };
      }
  >;
  displayedAttributes: string[];
  sortableAttributes: string[];
  rankingRules: string[];
  distinctAttribute: string | null;
  pagination: {
    maxTotalHits: number;
  };
  searchCutoffMs: number;
  localizedAttributes: Array<{
    attributePatterns: string[];
    locales: string[];
  }>;
  typoTolerance: {
    disableOnAttributes: string[];
  };
};

export type SearchEngineDocument = Record<string, unknown> & {
  id: string;
};

export type SearchEngineDocumentPage = {
  documents: Array<Record<string, unknown>>;
  total: number;
  offset: number;
};

export type SearchEngineIndexPage = {
  indexes: Array<{
    uid: string;
    createdAt: string;
    updatedAt: string;
  }>;
  total: number;
  offset: number;
};

export type SearchEngineFinishedTaskPage = {
  tasks: Array<{
    taskUid: number;
    indexUid: string | null;
    status: "succeeded" | "failed" | "canceled";
    finishedAt: string;
  }>;
  next: number | null;
};

export type SearchEngineDatabaseStats = {
  databaseSizeBytes: number;
  usedDatabaseSizeBytes: number;
};

export type SearchEngineSearchRequest = {
  indexUid: string;
  query: string;
  filter: string;
  limit: number;
  offset?: number;
  attributesToSearchOn?: string[];
  attributesToRetrieve: string[];
  attributesToCrop: string[];
  cropLength: number;
  matchingStrategy: "all" | "last";
  locales?: string[];
  distinct?: string;
};

export type SearchEngineSearchResult = {
  hits: Array<Record<string, unknown>>;
  estimatedTotalHits: number;
  processingTimeMs: number;
};

export type SearchEnginePressure = {
  queueLatencyMs: number;
  residentMemoryBytes: number;
  databaseSizeBytes: number;
  taskQueueSizeBytes: number;
};

export type SearchEngineErrorCode =
  | "SEARCH_ENGINE_UNAVAILABLE"
  | "SEARCH_ENGINE_AUTHENTICATION_FAILED"
  | "SEARCH_ENGINE_OVERLOADED"
  | "SEARCH_ENGINE_VERSION_INCOMPATIBLE"
  | "SEARCH_ENGINE_REQUEST_FAILED";

export class SearchEngineTransportError extends Error {
  public constructor(
    public readonly code: SearchEngineErrorCode,
    public readonly retryable: boolean
  ) {
    super(
      code === "SEARCH_ENGINE_AUTHENTICATION_FAILED"
        ? "Search service authentication failed"
        : code === "SEARCH_ENGINE_VERSION_INCOMPATIBLE"
          ? "Search service version is incompatible"
        : code === "SEARCH_ENGINE_OVERLOADED"
          ? "Search service is temporarily overloaded"
        : code === "SEARCH_ENGINE_UNAVAILABLE"
          ? "Search service is temporarily unavailable"
          : "Search service request failed"
    );
    this.name = "SearchEngineTransportError";
  }
}

export interface SearchEngineTransport {
  health(): Promise<{ available: boolean }>;
  getPressure(): Promise<SearchEnginePressure>;
  createIndex(input: {
    indexUid: string;
    primaryKey: string;
  }): Promise<{ taskUid: number }>;
  getIndex(input: {
    indexUid: string;
  }): Promise<{ uid: string; primaryKey: string | null } | null>;
  getIndexStats?(input: {
    indexUid: string;
  }): Promise<{ numberOfDocuments: number }>;
  listDocuments?(input: {
    indexUid: string;
    offset: number;
    limit: number;
    fields: readonly string[];
  }): Promise<SearchEngineDocumentPage>;
  listIndexes?(input: {
    offset: number;
    limit: number;
  }): Promise<SearchEngineIndexPage>;
  listFinishedTasks?(input: {
    statuses: readonly ["succeeded", "failed", "canceled"];
    beforeFinishedAt: string;
    from: number | null;
    limit: number;
  }): Promise<SearchEngineFinishedTaskPage>;
  deleteFinishedTasks?(input: {
    taskUids: readonly number[];
  }): Promise<{ taskUid: number }>;
  getDatabaseStats?(): Promise<SearchEngineDatabaseStats>;
  compactIndex?(indexUid: string): Promise<{ taskUid: number }>;
  getDocument(input: {
    indexUid: string;
    documentId: string;
  }): Promise<Record<string, unknown> | null>;
  getSettings(indexUid: string): Promise<SearchEngineSettings>;
  updateSettings(input: {
    indexUid: string;
    settings: SearchEngineSettings;
  }): Promise<{ taskUid: number }>;
  addDocuments(input: {
    indexUid: string;
    primaryKey: string;
    documents: SearchEngineDocument[];
    correlation: string;
  }): Promise<{ taskUid: number }>;
  deleteDocuments(input: {
    indexUid: string;
    ids?: string[];
    filter?: string;
    correlation: string;
  }): Promise<{ taskUid: number }>;
  deleteIndex(indexUid: string): Promise<{ taskUid: number }>;
  swapIndexes(input: {
    pairs: Array<{
      left: string;
      right: string;
    }>;
  }): Promise<{ taskUid: number }>;
  findTaskByCorrelation?(input: {
    indexUid: string;
    correlation: string;
  }): Promise<SearchEngineTask | null>;
  findIndexSwapTask?(input: {
    pairs: Array<{
      left: string;
      right: string;
    }>;
  }): Promise<SearchEngineTask | null>;
  getTask(taskUid: number): Promise<SearchEngineTask>;
  search(input: SearchEngineSearchRequest): Promise<SearchEngineSearchResult>;
}
