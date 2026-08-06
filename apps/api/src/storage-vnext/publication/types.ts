import type {
  StorageVnextReleaseCatalogEntry
} from "../release/ports.js";

export type StorageVnextPublicationArtifact = {
  logicalPath: string;
  kind: StorageVnextReleaseCatalogEntry["kind"];
  sourceFilePublicId: string | null;
  ordinal: number;
  bytes: Uint8Array;
};

export type StorageVnextInternalShardRecord = {
  publicId: string;
  logicalPath: string;
  value: Readonly<Record<string, unknown>>;
};

export type StorageVnextInternalShard = {
  publicId: string;
  logicalKind: string;
  firstLogicalPath: string;
  lastLogicalPath: string;
  recordCount: number;
  ordinal: number;
  bytes: Uint8Array;
};

export type StorageVnextEffectiveCatalogEntry = StorageVnextReleaseCatalogEntry & {
  candidateOwned: boolean;
};
