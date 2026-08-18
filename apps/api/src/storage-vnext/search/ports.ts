import type {
  StorageVnextKnowledgeBaseId,
  StorageVnextOpaqueCursor,
  StorageVnextPage,
  StorageVnextPublicId
} from "../shared/types.js";
import type { OkfSearchFilters } from "./okf-signals.js";
import type { StorageVnextStructuredMetadata } from "../shared/types.js";

export type {
  StorageVnextContentDocument,
  StorageVnextGraphSeedDocument,
  StorageVnextSearchDocument
} from "./documents.js";

export type StorageVnextSearchKind = "file" | "graph";
export type StorageVnextSearchScope = "all" | "path" | "metadata";

export type StorageVnextSearchResult = {
  publicId: StorageVnextPublicId;
  sourceFilePublicId: StorageVnextPublicId;
  logicalPath: string;
  title: string;
  snippet: string | null;
  score: number;
  kind: StorageVnextSearchKind;
  metadata: StorageVnextStructuredMetadata;
  evidenceFamilies?: readonly string[];
  matchedFields?: readonly string[];
  evidenceTypes?: readonly string[];
  sourceExcerpt?: string | null;
};

export type StorageVnextSemanticSearchStatus = {
  state: "ready" | "degraded" | "unavailable";
  safeCode: string | null;
};

export type StorageVnextEvidenceStatus = {
  completedFamilies: readonly string[];
  degradedFamilies: readonly string[];
};

export type StorageVnextRerankerStatus = {
  state: "not_configured" | "skipped" | "applied" | "degraded";
  safeCode: string | null;
};

export type StorageVnextSearchPage = StorageVnextPage<StorageVnextSearchResult> & {
  semanticStatus?: StorageVnextSemanticSearchStatus;
  evidenceStatus?: StorageVnextEvidenceStatus;
  rerankerStatus?: StorageVnextRerankerStatus;
};

export type StorageVnextSearchQueryPort = {
  search(input: {
    knowledgeBaseId: StorageVnextKnowledgeBaseId;
    query: string;
    kinds: readonly StorageVnextSearchKind[];
    scope?: StorageVnextSearchScope;
    fileKind?: string | null;
    limit: number;
    rerank?: boolean;
    rerankTopK?: number | null;
    rerankScoreThreshold?: number | null;
    cursor: StorageVnextOpaqueCursor | null;
    okfFilters?: OkfSearchFilters;
  }): Promise<StorageVnextSearchPage>;
};
