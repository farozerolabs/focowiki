import { randomUUID } from "node:crypto";
import type { StorageVnextAuditPort } from
  "../../storage-vnext/audit/ports.js";
import type { EmbeddingConfigurationAuditPort } from "./service.js";

export function createEmbeddingConfigurationAuditAdapter(input: {
  audit: Pick<StorageVnextAuditPort, "append">;
  retentionDays: number;
}): EmbeddingConfigurationAuditPort {
  return {
    async append(event) {
      const createdAt = new Date(event.createdAt);
      await input.audit.append({
        publicId: `audit-${randomUUID()}`,
        knowledgeBaseId: null,
        actorPublicId: event.actorPublicId,
        eventType: event.eventType,
        targetKind: "embedding_configuration",
        targetPublicId: event.configurationPublicId,
        result: event.result,
        reasonCode: event.reasonCode,
        sourceIp: null,
        userAgent: null,
        metadata: {
          ...event.metadata,
          revisionPublicId: event.revisionPublicId
        },
        createdAt: event.createdAt,
        expiresAt: new Date(
          createdAt.getTime() + input.retentionDays * 86_400_000
        ).toISOString()
      });
    }
  };
}
