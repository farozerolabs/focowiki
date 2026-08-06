import type { TransactionSql } from "postgres";
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
  providerIndexUid: string | null;
};

export type StorageVnextDeletionTransactionInput = {
  transaction: StorageVnextDeletionTransaction;
  request: StorageVnextNormalizedDeletionRequest;
};

export type StorageVnextDeletionTransactionResult =
  StorageVnextDeletionAcceptance;
