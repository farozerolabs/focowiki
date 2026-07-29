import type {
  SearchIndexKind
} from "./search-projection-state-repository.js";
import type {
  SearchProjectionRecord
} from "../../search/search-projection-record.js";

export type SearchProjectionDocumentScope = {
  knowledgeBaseId: string;
  generationId: string;
  activeGenerationId: string | null;
  activeEpoch: number;
  pendingEpoch: number;
  indexKind: SearchIndexKind;
};

export interface SearchProjectionDocumentRepository {
  listRecords(input: SearchProjectionDocumentScope & {
    cursor: string | null;
    limit: number;
  }): Promise<{
    records: SearchProjectionRecord[];
    nextCursor: string | null;
  }>;
  loadRecords(input: SearchProjectionDocumentScope & {
    recordKeys: string[];
  }): Promise<SearchProjectionRecord[]>;
}
