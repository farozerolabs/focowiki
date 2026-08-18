import type {
  StorageVnextChecksum,
  StorageVnextTimestamp
} from "../shared/types.js";

export type StorageVnextOwnedScopeProof = {
  runId: string;
  nonceHash: StorageVnextChecksum;
  ownerMarker: string;
  postgresScope: string;
  objectScope: string;
  searchScope: string;
  coordinationScope: string;
  filesystemScope: string;
  createdAt: StorageVnextTimestamp;
  proofChecksum: StorageVnextChecksum;
};
