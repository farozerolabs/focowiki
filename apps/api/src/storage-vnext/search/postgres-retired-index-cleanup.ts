import { createHash } from "node:crypto";
import type { TransactionSql } from "postgres";
import type { SearchProviderKind } from
  "../../application/ports/search-provider-runtime.js";

export type StorageVnextRetiredSearchIndexCleanupDomain =
  | "provider_adoption"
  | "search_projection_retirement";

export async function enqueueStorageVnextRetiredSearchIndexCleanup(
  sql: TransactionSql,
  input: {
    domain: StorageVnextRetiredSearchIndexCleanupDomain;
    operationPublicId: string;
    knowledgeBaseId: string;
    cleanupNotBefore: string;
    providerKind: SearchProviderKind;
    providerIndexUid: string;
    documentCount: number;
  }
): Promise<void> {
  const digest = createHash("sha256")
    .update("storage-vnext-retired-search-index-cleanup-v1")
    .update("\0")
    .update(input.domain)
    .update("\0")
    .update(input.operationPublicId)
    .update("\0")
    .update(input.providerKind)
    .update("\0")
    .update(input.providerIndexUid)
    .digest("hex");
  const publicId = `retired-search-index-cleanup-${digest}`;
  await sql`
    INSERT INTO focowiki.cleanup_actions (
      public_id, operation_public_id, knowledge_base_id, action_kind,
      cleanup_plane, search_provider_kind, resource_kind, resource_public_id,
      required, sequence_number, idempotency_key, request_hash, checkpoint,
      state, attempt_count, not_before
    ) VALUES (
      ${publicId}, ${input.operationPublicId}, ${input.knowledgeBaseId},
      ${input.domain}, 'search', ${input.providerKind}, 'search_index',
      ${input.providerIndexUid}, false, 0, ${publicId}, ${digest},
      ${sql.json({
        providerIndexUid: input.providerIndexUid,
        documentCount: input.documentCount
      })},
      'queued', 0, ${input.cleanupNotBefore}
    )
    ON CONFLICT ON CONSTRAINT cleanup_actions_idempotency_key DO NOTHING
  `;
}
