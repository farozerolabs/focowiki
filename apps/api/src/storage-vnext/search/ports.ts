import type {
  StorageVnextKnowledgeBaseId,
  StorageVnextOpaqueCursor,
  StorageVnextPage,
  StorageVnextPublicId
} from "../shared/types.js";
import type {
  StorageVnextSearchDocument
} from "./documents.js";
import type { OkfSearchFilters } from "./okf-signals.js";
import type { StorageVnextStructuredMetadata } from "../shared/types.js";

export type {
  StorageVnextContentDocument,
  StorageVnextGraphSeedDocument,
  StorageVnextSearchDocument
} from "./documents.js";

export type StorageVnextSearchKind = "file" | "graph";

export type StorageVnextSearchResult = {
  publicId: StorageVnextPublicId;
  sourceFilePublicId: StorageVnextPublicId;
  logicalPath: string;
  title: string;
  snippet: string | null;
  score: number;
  kind: StorageVnextSearchKind;
  metadata: StorageVnextStructuredMetadata;
};

export type StorageVnextSearchValidationKind =
  | "exact"
  | "title"
  | "path"
  | "content"
  | "multi_term"
  | "phrase"
  | "typo"
  | "chinese"
  | "mixed_script"
  | "graph_seed"
  | "ranking"
  | "okf_omitted"
  | "okf_malformed"
  | "okf_status"
  | "okf_trust"
  | "okf_fresh"
  | "okf_stale"
  | "okf_combined"
  | "okf_unrelated"
  | "okf_no_match"
  | "okf_boundary";

export type StorageVnextSearchValidationCase = {
  kind: StorageVnextSearchValidationKind;
  query: string;
  attributesToSearchOn: readonly string[];
  documentKind: "content" | "graph_seed";
  limit: number;
  relevantSources: readonly {
    sourceFilePublicId: StorageVnextPublicId;
    relevance: number;
  }[];
  minimumRecall: number;
  minimumNdcg: number;
  okfFilters?: OkfSearchFilters;
};

export type StorageVnextSearchQueryPort = {
  search(input: {
    knowledgeBaseId: StorageVnextKnowledgeBaseId;
    query: string;
    kinds: readonly StorageVnextSearchKind[];
    limit: number;
    cursor: StorageVnextOpaqueCursor | null;
    okfFilters?: OkfSearchFilters;
  }): Promise<StorageVnextPage<StorageVnextSearchResult>>;
};

export type StorageVnextSearchProjectionPort = {
  prepareCandidate(input: {
    knowledgeBaseId: StorageVnextKnowledgeBaseId;
    candidatePublicId: StorageVnextPublicId;
    schemaChecksum: string;
    settingsChecksum: string;
  }): Promise<void>;
  writeDocumentBatch(input: {
    candidatePublicId: StorageVnextPublicId;
    documents: readonly StorageVnextSearchDocument[];
    operationPublicId: StorageVnextPublicId;
    batchOrdinal: number;
    payloadChecksum: string;
    compressedBytes: number;
  }): Promise<void>;
  validateCandidate(input: {
    candidatePublicId: StorageVnextPublicId;
    expectedDocumentCount: number;
    documentChecksum: string;
    schemaChecksum: string;
    settingsChecksum: string;
    queryCases: readonly StorageVnextSearchValidationCase[];
    maxP95ProcessingTimeMs: number;
  }): Promise<void>;
  deleteProjection(publicId: StorageVnextPublicId): Promise<void>;
};
