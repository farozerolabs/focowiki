import type {
  StorageVnextOpaqueCursor,
  StorageVnextPage,
  StorageVnextTimestamp
} from "../shared/types.js";

export type StorageVnextSourceEventSeverity = "info" | "warning" | "error";
export type StorageVnextSourceEventStage = string;

export type StorageVnextSourceEventSummary = {
  publicId: string;
  knowledgeBaseId: string;
  sourceFilePublicId: string;
  sourceRevisionPublicId: string;
  sequence: number;
  stageKey: StorageVnextSourceEventStage;
  messageKey: string;
  startedAt: StorageVnextTimestamp | null;
  endedAt: StorageVnextTimestamp | null;
  severity: StorageVnextSourceEventSeverity;
  createdAt: StorageVnextTimestamp;
  expiresAt: StorageVnextTimestamp;
};

export type StorageVnextSourceEventReadPort = {
  list(input: {
    knowledgeBaseId: string;
    sourceFileId: string;
    limit: number;
    cursor: StorageVnextOpaqueCursor | null;
  }): Promise<StorageVnextPage<StorageVnextSourceEventSummary>>;
};
