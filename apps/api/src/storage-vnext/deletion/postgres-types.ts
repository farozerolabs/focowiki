import type { TransactionSql } from "postgres";
import type { SearchProviderKind } from
  "../../application/ports/search-provider-runtime.js";
import type {
  StorageVnextDeletionAcceptance,
  StorageVnextNormalizedDeletionRequest
} from "./ports.js";

export type StorageVnextDeletionTransaction = TransactionSql;

export type StorageVnextDeletionTarget = {
  revision: number;
  normalizedPath: string | null;
};

export type StorageVnextDeletionVisibilityResult = {
  sourceFileCount: number;
  directoryCount: number;
};

export type StorageVnextTerminatedCandidate = {
  operationPublicId: string | null;
  providerKind: SearchProviderKind | null;
  providerIndexUid: string | null;
};

export type StorageVnextDeletionTransactionInput = {
  transaction: StorageVnextDeletionTransaction;
  request: StorageVnextNormalizedDeletionRequest;
};

export type StorageVnextDeletionTransactionResult =
  StorageVnextDeletionAcceptance;
