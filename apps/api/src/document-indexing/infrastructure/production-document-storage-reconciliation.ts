import { reconcileStorageVnextRegistrationPage } from
  "../../storage-vnext/ownership/object-reconciliation.js";
import type { createPostgresStorageVnextOwnershipRepository } from
  "../../storage-vnext/ownership/postgres-repository.js";
import type { StorageVnextObjectInventory } from
  "../../storage-vnext/ownership/s3-object-inventory.js";

export function createProductionDocumentStorageReconciliation(input: {
  provider: StorageVnextObjectInventory;
  registrations: Pick<
    ReturnType<typeof createPostgresStorageVnextOwnershipRepository>,
    "listRegistrationsForKnowledgeBase"
  >;
  now?: () => string;
}) {
  return {
    async runPage(request: {
      knowledgeBaseId: string;
      limit: number;
      cursor: string | null;
    }): Promise<{ processedCount: number; nextCursor: string | null }> {
      const page = await reconcileStorageVnextRegistrationPage({
        provider: input.provider,
        registrations: {
          listRegistrations: ({ limit, cursor }) =>
            input.registrations.listRegistrationsForKnowledgeBase({
              knowledgeBaseId: request.knowledgeBaseId,
              limit,
              cursor
            })
        },
        limit: request.limit,
        cursor: request.cursor
      });
      assertNoFindings(page.findings.length);
      return {
        processedCount: request.limit,
        nextCursor: page.nextCursor
      };
    }
  };
}

function assertNoFindings(count: number): void {
  if (count > 0) {
    throw Object.assign(
      new Error("Document storage reconciliation found inconsistent objects"),
      { code: "storage_reconciliation_findings_detected" }
    );
  }
}
