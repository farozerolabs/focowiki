import type {
  StorageVnextBoundedMetadata,
  StorageVnextKnowledgeBaseId,
  StorageVnextOpaqueCursor,
  StorageVnextPage,
  StorageVnextPublicId,
  StorageVnextTimestamp
} from "../shared/types.js";

export type StorageVnextAuditResult = "success" | "failure" | "blocked";

export type StorageVnextSecurityAuditEvent = {
  publicId: StorageVnextPublicId;
  knowledgeBaseId: StorageVnextKnowledgeBaseId | null;
  actorPublicId: StorageVnextPublicId | null;
  eventType: string;
  targetKind: string | null;
  targetPublicId: StorageVnextPublicId | null;
  result: StorageVnextAuditResult;
  reasonCode: string | null;
  sourceIp: string | null;
  userAgent: string | null;
  metadata: StorageVnextBoundedMetadata;
  createdAt: StorageVnextTimestamp;
  expiresAt: StorageVnextTimestamp;
};

export type StorageVnextAuditPort = {
  append(event: StorageVnextSecurityAuditEvent): Promise<void>;
  list(input: {
    knowledgeBaseId: StorageVnextKnowledgeBaseId | null;
    eventType: string | null;
    result: StorageVnextAuditResult | null;
    createdAfter: StorageVnextTimestamp | null;
    createdBefore: StorageVnextTimestamp | null;
    limit: number;
    cursor: StorageVnextOpaqueCursor | null;
  }): Promise<StorageVnextPage<StorageVnextSecurityAuditEvent>>;
};
