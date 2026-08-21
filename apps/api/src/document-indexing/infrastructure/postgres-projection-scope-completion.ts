import type { TransactionSql } from "postgres";
import type { DatabaseClient } from "../../db/client.js";
import { createPostgresProjectionDirtyScopeRepository } from
  "./postgres-projection-dirty-scope-repository.js";
import { createPostgresProjectionScopeContributions } from
  "./postgres-projection-scope-contributions.js";
import type { DocumentProjectionStorageRequests } from
  "../application/document-scope-projector-runtime.js";

export function createPostgresProjectionScopeCompletion(sql: DatabaseClient) {
  return {
    async commit(input: {
      publicId: string;
      workerId: string;
      renderedSequence: number;
      outputFingerprintSha256: string;
      storageRequests: DocumentProjectionStorageRequests;
      now: string;
    }): Promise<{
      state: "completed" | "waiting";
      readyDocumentJobPublicIds: readonly string[];
    } | null> {
      return transaction(sql, async (tx) => {
        const transactionClient = tx as unknown as DatabaseClient;
        const outputs = await tx<Array<{ scope_public_id: string }>>`
          SELECT scope_public_id
          FROM focowiki.projection_scope_outputs
          WHERE scope_public_id = ${input.publicId}
            AND rendered_sequence = ${input.renderedSequence}
            AND output_fingerprint_sha256 = ${input.outputFingerprintSha256}
          FOR SHARE
        `;
        if (outputs.length !== 1) {
          throw scopeCompletionError("projection_scope_output_missing");
        }
        const state = await createPostgresProjectionDirtyScopeRepository(
          transactionClient
        ).complete(input);
        if (!state) return null;
        await tx`
          INSERT INTO focowiki.projection_scope_storage_metrics (
            scope_public_id, rendered_sequence, knowledge_base_id,
            put_count, head_count, verification_count, attempted_bytes,
            retry_count, latency_milliseconds, created_at
          )
          SELECT scope.public_id, ${input.renderedSequence},
                 scope.knowledge_base_id, ${input.storageRequests.put},
                 ${input.storageRequests.head},
                 ${input.storageRequests.verification},
                 ${input.storageRequests.attemptedBytes},
                 ${input.storageRequests.retries},
                 ${Math.ceil(input.storageRequests.latencyMilliseconds)},
                 ${input.now}
          FROM focowiki.projection_dirty_scopes scope
          WHERE scope.public_id = ${input.publicId}
          ON CONFLICT (scope_public_id, rendered_sequence) DO UPDATE
          SET put_count = excluded.put_count,
              head_count = excluded.head_count,
              verification_count = excluded.verification_count,
              attempted_bytes = excluded.attempted_bytes,
              retry_count = excluded.retry_count,
              latency_milliseconds = excluded.latency_milliseconds
        `;
        const acknowledged = await createPostgresProjectionScopeContributions(
          transactionClient
        )
          .acknowledge({
            scopePublicId: input.publicId,
            renderedSequence: input.renderedSequence,
            outputFingerprintSha256: input.outputFingerprintSha256,
            now: input.now
          });
        return {
          state,
          readyDocumentJobPublicIds: acknowledged.documentJobPublicIds
        };
      });
    }
  };
}

function scopeCompletionError(code: string): Error & { code: string } {
  return Object.assign(new Error(`Projection scope completion error: ${code}`), {
    code
  });
}

function transaction<T>(
  sql: DatabaseClient,
  callback: (transactionSql: TransactionSql) => Promise<T>
): Promise<T> {
  return typeof sql.begin === "function"
    ? sql.begin(callback as never) as Promise<T>
    : callback(sql as unknown as TransactionSql);
}
