import type {
  StorageVnextBoundedMetadata,
  StorageVnextPublicId,
  StorageVnextTimestamp
} from "../shared/types.js";

export type StorageVnextSettingsRevision = {
  publicId: StorageVnextPublicId;
  checksum: string;
  values: StorageVnextBoundedMetadata;
  createdAt: StorageVnextTimestamp;
  createdByPublicId: StorageVnextPublicId | null;
};

export type StorageVnextSettingsReadPort = {
  getCurrent(): Promise<StorageVnextSettingsRevision>;
  getRevision(publicId: StorageVnextPublicId): Promise<StorageVnextSettingsRevision | null>;
};

export type StorageVnextSettingsWritePort = {
  createAndSetCurrent(input: {
    revision: StorageVnextSettingsRevision;
    expectedCurrentPublicId: StorageVnextPublicId | null;
  }): Promise<StorageVnextSettingsRevision>;
};
