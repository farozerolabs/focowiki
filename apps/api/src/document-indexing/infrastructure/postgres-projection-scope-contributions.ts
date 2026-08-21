import { createHash } from "node:crypto";
import type { TransactionSql } from "postgres";
import type { DatabaseClient } from "../../db/client.js";
import { MAXIMUM_PROJECTION_SCOPE_CONTRIBUTORS_PER_RENDER } from
  "../domain/document-projection-limits.js";
import {
  assertRepositoryIdentity,
  assertRepositoryPositiveInteger,
  assertRepositorySha256,
  assertRepositoryTimestamp,
  repositoryContractError
} from "./document-repository-validation.js";

export function createPostgresProjectionScopeContributions(sql: DatabaseClient) {
  return {
    async contribute(input: {
      knowledgeBaseId: string;
      sourceFilePublicId: string;
      sourceRevisionPublicId: string;
      documentJobPublicId: string;
      scopes: readonly { publicId: string; requiredSequence: number }[];
    }): Promise<readonly string[]> {
      if (input.scopes.length < 1 || input.scopes.length > 256) {
        throw repositoryContractError("projection_scope_contribution_count_invalid");
      }
      const rows = input.scopes.map((scope) => ({
        public_id: contributionId(input.sourceRevisionPublicId,
          scope.publicId, scope.requiredSequence),
        scope_public_id: assertRepositoryIdentity(scope.publicId, "scope_public_id"),
        required_sequence: assertRepositoryPositiveInteger(
          scope.requiredSequence, "required_sequence"
        )
      }));
      return transaction(sql, async (tx) => {
        const scopeIds = rows.map((row) => row.scope_public_id);
        const lockedScopes = await tx<Array<{ public_id: string }>>`
          SELECT public_id
          FROM focowiki.projection_dirty_scopes
          WHERE knowledge_base_id = ${assertRepositoryIdentity(input.knowledgeBaseId, "knowledge_base_id")}
            AND public_id IN ${tx(scopeIds)}
          ORDER BY public_id COLLATE "C"
          FOR UPDATE
        `;
        if (lockedScopes.length !== scopeIds.length) {
          throw repositoryContractError("projection_scope_missing");
        }
        const stored = await tx<Array<{ public_id: string }>>`
          INSERT INTO focowiki.projection_scope_contributions (
            public_id, knowledge_base_id, source_file_public_id,
            source_revision_public_id, document_job_public_id,
            scope_public_id, required_sequence
          )
          SELECT desired.public_id, ${input.knowledgeBaseId},
                 ${assertRepositoryIdentity(input.sourceFilePublicId, "source_file_public_id")},
                 ${assertRepositoryIdentity(input.sourceRevisionPublicId, "source_revision_public_id")},
                 ${assertRepositoryIdentity(input.documentJobPublicId, "document_job_public_id")},
                 desired.scope_public_id, desired.required_sequence
          FROM jsonb_to_recordset(${tx.json(rows as never)}::jsonb) AS desired(
            public_id text, scope_public_id text, required_sequence bigint
          )
          ON CONFLICT (
            knowledge_base_id, source_revision_public_id,
            scope_public_id, required_sequence
          ) DO UPDATE SET public_id = projection_scope_contributions.public_id
          RETURNING public_id
        `;
        const acknowledged = await tx<Array<{
          public_id: string;
          scope_public_id: string;
          rendered_sequence: number | string;
          output_fingerprint_sha256: string;
        }>>`
          UPDATE focowiki.projection_scope_contributions contribution
          SET state = 'acknowledged', acknowledged_at = now()
          FROM focowiki.projection_dirty_scopes scope,
               focowiki.projection_scope_outputs output
          WHERE contribution.public_id IN ${tx(stored.map((row) => row.public_id))}
            AND contribution.state = 'waiting'
            AND scope.public_id = contribution.scope_public_id
            AND scope.state = 'completed'
            AND scope.completed_sequence >= contribution.required_sequence
            AND output.scope_public_id = scope.public_id
            AND output.rendered_sequence = scope.completed_sequence
            AND jsonb_array_length(output.pages) = 0
            AND cardinality(output.removed_normalized_paths) = 0
            AND jsonb_array_length(output.navigation_mutations) = 0
          RETURNING contribution.public_id, contribution.scope_public_id,
                    scope.completed_sequence AS rendered_sequence,
                    output.output_fingerprint_sha256
        `;
        if (acknowledged.length > 0) {
          await tx`
            INSERT INTO focowiki.projection_scope_receipts (
              contribution_public_id, scope_public_id, rendered_sequence,
              output_fingerprint_sha256, committed_at
            )
            SELECT receipt.public_id, receipt.scope_public_id,
                   receipt.rendered_sequence, receipt.output_fingerprint_sha256,
                   now()
            FROM jsonb_to_recordset(${tx.json(acknowledged as never)}::jsonb)
              AS receipt(
                public_id text, scope_public_id text,
                rendered_sequence bigint, output_fingerprint_sha256 text
              )
            ON CONFLICT (contribution_public_id) DO NOTHING
          `;
        }
        await tx`
          UPDATE focowiki.projection_dirty_scopes scope
          SET state = 'waiting', next_eligible_at = now(), coalesce_until = now(),
              safe_error_code = NULL, safe_error_message = NULL,
              retryable = false, updated_at = now()
          WHERE scope.public_id IN ${tx(scopeIds)}
            AND scope.state = 'completed'
            AND EXISTS (
              SELECT 1
              FROM focowiki.projection_scope_contributions contribution
              WHERE contribution.scope_public_id = scope.public_id
                AND contribution.public_id IN ${tx(stored.map((row) => row.public_id))}
                AND contribution.state = 'waiting'
            )
        `;
        await refreshScopePressure(tx, scopeIds);
        return stored.map((row) => row.public_id).sort();
      });
    },

    async acknowledge(input: {
      scopePublicId: string;
      renderedSequence: number;
      outputFingerprintSha256: string;
      now: string;
    }): Promise<{
      acknowledgedCount: number;
      documentJobPublicIds: readonly string[];
    }> {
      return transaction(sql, async (tx) => {
        const rows = await tx<Array<{
          public_id: string;
          document_job_public_id: string;
        }>>`
          UPDATE focowiki.projection_scope_contributions
          SET state = 'acknowledged', acknowledged_at = ${assertRepositoryTimestamp(input.now, "now")}
          WHERE scope_public_id = ${assertRepositoryIdentity(input.scopePublicId, "scope_public_id")}
            AND state = 'waiting'
            AND required_sequence <= ${assertRepositoryPositiveInteger(input.renderedSequence, "rendered_sequence")}
          RETURNING public_id, document_job_public_id
        `;
        if (rows.length === 0) {
          await refreshScopePressure(tx, [input.scopePublicId]);
          return { acknowledgedCount: 0, documentJobPublicIds: [] };
        }
        const receipts = rows.map((row) => ({
          contribution_public_id: row.public_id,
          scope_public_id: input.scopePublicId,
          rendered_sequence: input.renderedSequence,
          output_fingerprint_sha256: assertRepositorySha256(
            input.outputFingerprintSha256,
            "output_fingerprint"
          )
        }));
        await tx`
          INSERT INTO focowiki.projection_scope_receipts (
            contribution_public_id, scope_public_id, rendered_sequence,
            output_fingerprint_sha256, committed_at
          )
          SELECT receipt.contribution_public_id, receipt.scope_public_id,
                 receipt.rendered_sequence, receipt.output_fingerprint_sha256,
                 ${input.now}
          FROM jsonb_to_recordset(${tx.json(receipts as never)}::jsonb) AS receipt(
            contribution_public_id text, scope_public_id text,
            rendered_sequence bigint, output_fingerprint_sha256 text
          )
          ON CONFLICT (contribution_public_id) DO NOTHING
        `;
        await refreshScopePressure(tx, [input.scopePublicId]);
        return {
          acknowledgedCount: rows.length,
          documentJobPublicIds: [...new Set(rows.map((row) =>
            row.document_job_public_id))].sort()
        };
      });
    },

    async listCovered(input: {
      scopePublicId: string;
      renderedSequence: number;
      limit: number;
    }): Promise<ReadonlyArray<{
      contributionPublicId: string;
      knowledgeBaseId: string;
      sourceFilePublicId: string;
      sourceRevisionPublicId: string;
      documentJobPublicId: string;
      sourceWorkPublicId: string;
      requiredSequence: number;
    }>> {
      const limit = assertRepositoryPositiveInteger(
        input.limit,
        "limit",
        MAXIMUM_PROJECTION_SCOPE_CONTRIBUTORS_PER_RENDER
      );
      const rows = await sql<Array<{
        public_id: string;
        knowledge_base_id: string;
        source_file_public_id: string;
        source_revision_public_id: string;
        document_job_public_id: string;
        source_work_public_id: string;
        required_sequence: number | string;
      }>>`
        SELECT contribution.public_id, contribution.knowledge_base_id,
               contribution.source_file_public_id,
               contribution.source_revision_public_id,
               contribution.document_job_public_id,
               work.public_id AS source_work_public_id,
               contribution.required_sequence
        FROM focowiki.projection_scope_contributions contribution
        JOIN focowiki.document_artifact_work work
          ON work.knowledge_base_id = contribution.knowledge_base_id
         AND work.document_job_public_id = contribution.document_job_public_id
         AND work.source_revision_public_id
               = contribution.source_revision_public_id
         AND work.work_kind = 'knowledge_projection'
        WHERE contribution.scope_public_id = ${assertRepositoryIdentity(
          input.scopePublicId,
          "scope_public_id"
        )}
          AND contribution.state = 'waiting'
          AND contribution.required_sequence <= ${assertRepositoryPositiveInteger(
            input.renderedSequence,
            "rendered_sequence"
          )}
        ORDER BY contribution.required_sequence,
                 contribution.public_id COLLATE "C"
        LIMIT ${limit + 1}
      `;
      if (rows.length > limit) {
        throw repositoryContractError("projection_scope_contributor_limit_exceeded");
      }
      return rows.map((row) => ({
        contributionPublicId: row.public_id,
        knowledgeBaseId: row.knowledge_base_id,
        sourceFilePublicId: row.source_file_public_id,
        sourceRevisionPublicId: row.source_revision_public_id,
        documentJobPublicId: row.document_job_public_id,
        sourceWorkPublicId: row.source_work_public_id,
        requiredSequence: Number(row.required_sequence)
      }));
    },

    async allAcknowledged(input: {
      documentJobPublicId: string;
    }): Promise<boolean> {
      const rows = await sql<Array<{ pending: number | string }>>`
        SELECT count(*) AS pending
        FROM focowiki.projection_scope_contributions
        WHERE document_job_public_id = ${assertRepositoryIdentity(input.documentJobPublicId, "document_job_public_id")}
          AND state = 'waiting'
      `;
      return Number(rows[0]?.pending ?? 0) === 0;
    }
  };
}

async function refreshScopePressure(
  tx: TransactionSql,
  scopePublicIds: readonly string[]
): Promise<void> {
  const unique = [...new Set(scopePublicIds)];
  if (unique.length === 0) return;
  await tx`
    UPDATE focowiki.projection_dirty_scopes scope
    SET waiting_contribution_count = pressure.waiting_count,
        oldest_waiting_contribution_at = pressure.oldest_waiting_at
    FROM (
      SELECT target.public_id,
             count(contribution.public_id)::integer AS waiting_count,
             min(contribution.created_at) AS oldest_waiting_at
      FROM unnest(${unique}::text[]) AS target(public_id)
      LEFT JOIN focowiki.projection_scope_contributions contribution
        ON contribution.scope_public_id = target.public_id
       AND contribution.state = 'waiting'
      GROUP BY target.public_id
    ) pressure
    WHERE scope.public_id = pressure.public_id
  `;
}

function contributionId(
  sourceRevisionPublicId: string,
  scopePublicId: string,
  requiredSequence: number
): string {
  return `projection-contribution-${createHash("sha256").update(JSON.stringify([
    sourceRevisionPublicId, scopePublicId, requiredSequence
  ])).digest("hex")}`;
}

function transaction<T>(
  sql: DatabaseClient,
  callback: (transactionSql: TransactionSql) => Promise<T>
): Promise<T> {
  return typeof sql.begin === "function"
    ? sql.begin(callback as never) as Promise<T>
    : callback(sql as unknown as TransactionSql);
}
