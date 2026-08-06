import type { SourceFileFailureStage } from "../../domain/source-file-lifecycle.js";
import type {
  StorageVnextOpaqueCursor,
  StorageVnextPage,
  StorageVnextTimestamp
} from "../shared/types.js";

export type StorageVnextSourceEventSeverity = "info" | "warning" | "error";

export type StorageVnextSourceEventSummary = {
  publicId: string;
  knowledgeBaseId: string;
  sourceFilePublicId: string;
  sourceRevisionPublicId: string;
  sequence: number;
  stageKey: SourceFileFailureStage;
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

export type StorageVnextSourceEventWritePort = {
  record(event: StorageVnextSourceEventSummary): Promise<void>;
};

export type StorageVnextSourceEventRepository =
  StorageVnextSourceEventReadPort & StorageVnextSourceEventWritePort;
