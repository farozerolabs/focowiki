import type { DatabaseClient } from "../../db/client.js";
import type { DocumentDirectoryNavigationMutation } from
  "../application/document-directory-navigation-mutation.js";
import type { StagedDocumentPage } from
  "../application/document-generated-page-staging.js";
import {
  assertRepositoryIdentity,
  assertRepositoryPositiveInteger,
  assertRepositoryTimestamp,
  repositoryContractError
} from "./document-repository-validation.js";
import { validateProjectionScopeOutput } from
  "./document-projection-scope-output-validation.js";
import {
  enqueueProjectionCleanupOutbox,
  type ProjectionCleanupReservation
} from "./postgres-projection-cleanup-outbox.js";

export type DocumentProjectionScopeOutputPage = Omit<
  StagedDocumentPage,
  "pageCandidatePublicId"
>;

export type DocumentProjectionScopeOutput = Readonly<{
  scopePublicId: string;
  renderedSequence: number;
  knowledgeBaseId: string;
  outputFingerprintSha256: string;
  pages: readonly DocumentProjectionScopeOutputPage[];
  removedNormalizedPaths: readonly string[];
  navigationMutations: readonly DocumentDirectoryNavigationMutation[];
  activationOwnerVersions: readonly {
    kind: "page_head" | "directory_leaf" | "directory_entry";
    key: string;
    expectedVersion: number;
  }[];
  createdAt: string;
}>;

type DocumentProjectionScopeOutputWrite = DocumentProjectionScopeOutput &
  Readonly<{
    leaseOwner?: string;
    leaseGeneration?: number;
    leaseCheckedAt?: string;
    cleanupReservations?: readonly ProjectionCleanupReservation[];
  }>;

type OutputRow = {
  scope_public_id: string;
  rendered_sequence: number | string;
  knowledge_base_id: string;
  output_fingerprint_sha256: string;
  pages: DocumentProjectionScopeOutputPage[];
  removed_normalized_paths: string[];
  navigation_mutations: DocumentDirectoryNavigationMutation[];
  activation_owner_versions: DocumentProjectionScopeOutput["activationOwnerVersions"];
  created_at: Date | string;
};

type LockedOutputRow = OutputRow & {
  usable: boolean;
  object_ids: string[];
};

export function createPostgresProjectionScopeOutputRepository(
  sql: DatabaseClient
) {
  return {
    async persist(input: DocumentProjectionScopeOutputWrite): Promise<void> {
      const normalized = validateProjectionScopeOutput(input);
      await sql.begin(async (transaction) => {
        if (input.leaseOwner !== undefined
          || input.leaseGeneration !== undefined
          || input.leaseCheckedAt !== undefined) {
          if (input.leaseOwner === undefined
            || input.leaseGeneration === undefined
            || input.leaseCheckedAt === undefined) {
            throw repositoryContractError("projection_scope_lease_fence_invalid");
          }
          const fenced = await transaction<Array<{ public_id: string }>>`
            SELECT public_id
            FROM focowiki.projection_dirty_scopes
            WHERE public_id = ${normalized.scopePublicId}
              AND knowledge_base_id = ${normalized.knowledgeBaseId}
              AND state = 'running'
              AND lease_owner = ${assertRepositoryIdentity(
                input.leaseOwner,
                "lease_owner"
              )}
              AND lease_generation = ${assertRepositoryPositiveInteger(
                input.leaseGeneration,
                "lease_generation"
              )}
              AND lease_expires_at > ${assertRepositoryTimestamp(
                input.leaseCheckedAt,
                "lease_checked_at"
              )}
            FOR SHARE
          `;
          if (fenced.length !== 1) {
            throw repositoryContractError("projection_scope_lease_lost");
          }
        }
        await transaction`
          INSERT INTO focowiki.projection_scope_object_refs (
            scope_public_id, rendered_sequence, knowledge_base_id,
            object_id, created_at
          )
          SELECT output.scope_public_id, output.rendered_sequence,
                 output.knowledge_base_id, registration.object_id,
                 output.created_at
          FROM focowiki.projection_scope_outputs output
          CROSS JOIN LATERAL jsonb_array_elements(output.pages) page
          JOIN focowiki.object_registrations registration
            ON registration.object_id = page->>'objectId'
           AND registration.state = 'verified'
          WHERE output.scope_public_id = ${normalized.scopePublicId}
            AND output.rendered_sequence = ${normalized.renderedSequence}
          ON CONFLICT (scope_public_id, rendered_sequence, object_id)
          DO NOTHING
        `;
        const existingRows = await transaction<LockedOutputRow[]>`
          SELECT output.scope_public_id, output.rendered_sequence,
                 output.knowledge_base_id, output.output_fingerprint_sha256,
                 output.pages, output.removed_normalized_paths,
                 output.navigation_mutations, output.activation_owner_versions,
                 output.created_at,
                 NOT EXISTS (
                   SELECT 1
                   FROM jsonb_array_elements(output.pages) page
                   LEFT JOIN focowiki.object_registrations registration
                     ON registration.object_id = page->>'objectId'
                    AND registration.state = 'verified'
                   LEFT JOIN focowiki.projection_scope_object_refs reference
                     ON reference.scope_public_id = output.scope_public_id
                    AND reference.rendered_sequence = output.rendered_sequence
                    AND reference.object_id = page->>'objectId'
                   WHERE registration.object_id IS NULL
                      OR reference.object_id IS NULL
                 ) AS usable,
                 ARRAY(
                   SELECT DISTINCT (page->>'objectId') COLLATE "C" AS object_id
                   FROM jsonb_array_elements(output.pages) page
                   WHERE page->>'objectId' IS NOT NULL
                   ORDER BY object_id
                 ) AS object_ids
          FROM focowiki.projection_scope_outputs output
          WHERE output.scope_public_id = ${normalized.scopePublicId}
            AND output.rendered_sequence = ${normalized.renderedSequence}
          FOR UPDATE OF output
        `;
        const existing = existingRows[0];
        const releasedObjectIds = existing && !existing.usable
          ? existing.object_ids
          : [];
        if (existing && !existing.usable) {
          await transaction`
            DELETE FROM focowiki.projection_scope_outputs
            WHERE scope_public_id = ${normalized.scopePublicId}
              AND rendered_sequence = ${normalized.renderedSequence}
          `;
        }
        const rows = await transaction<OutputRow[]>`
          INSERT INTO focowiki.projection_scope_outputs (
            scope_public_id, rendered_sequence, knowledge_base_id,
            output_fingerprint_sha256, pages, removed_normalized_paths,
            navigation_mutations, activation_owner_versions, created_at
          ) VALUES (
            ${normalized.scopePublicId}, ${normalized.renderedSequence},
            ${normalized.knowledgeBaseId},
            ${normalized.outputFingerprintSha256},
            ${transaction.json(normalized.pages as never)},
            ${normalized.removedNormalizedPaths},
            ${transaction.json(normalized.navigationMutations as never)},
            ${transaction.json(normalized.activationOwnerVersions as never)},
            ${normalized.createdAt}
          )
          ON CONFLICT (scope_public_id, rendered_sequence) DO UPDATE
          SET output_fingerprint_sha256 = excluded.output_fingerprint_sha256,
              pages = excluded.pages,
              removed_normalized_paths = excluded.removed_normalized_paths,
              navigation_mutations = excluded.navigation_mutations,
              activation_owner_versions = excluded.activation_owner_versions
          WHERE projection_scope_outputs.output_fingerprint_sha256
                  = excluded.output_fingerprint_sha256
            AND projection_scope_outputs.pages = excluded.pages
            AND projection_scope_outputs.removed_normalized_paths
                  = excluded.removed_normalized_paths
            AND projection_scope_outputs.navigation_mutations
                  = excluded.navigation_mutations
          RETURNING scope_public_id, rendered_sequence, knowledge_base_id,
                    output_fingerprint_sha256, pages, removed_normalized_paths,
                    navigation_mutations, activation_owner_versions, created_at
        `;
        if (rows.length !== 1) {
          throw repositoryContractError("projection_scope_output_conflict");
        }
        const objectIds = [...new Set(normalized.pages.map(
          (page) => page.objectId
        ))];
        if (objectIds.length > 0) {
          await transaction`
            INSERT INTO focowiki.projection_scope_object_refs (
              scope_public_id, rendered_sequence, knowledge_base_id,
              object_id, created_at
            )
            SELECT ${normalized.scopePublicId}, ${normalized.renderedSequence},
                   ${normalized.knowledgeBaseId}, registration.object_id,
                   ${normalized.createdAt}
            FROM focowiki.object_registrations registration
            WHERE registration.object_id IN ${transaction(objectIds)}
              AND registration.state = 'verified'
            ON CONFLICT (scope_public_id, rendered_sequence, object_id)
            DO NOTHING
          `;
          const stored = await transaction<Array<{ object_id: string }>>`
            SELECT object_id
            FROM focowiki.projection_scope_object_refs
            WHERE scope_public_id = ${normalized.scopePublicId}
              AND rendered_sequence = ${normalized.renderedSequence}
              AND object_id IN ${transaction(objectIds)}
          `;
          if (new Set(stored.map((row) => row.object_id)).size
            !== objectIds.length) {
            throw repositoryContractError("projection_scope_object_unverified");
          }
          await transaction`
            UPDATE focowiki.object_registrations
            SET zero_owner_since = NULL
            WHERE object_id IN ${transaction(objectIds)}
              AND state = 'verified'
          `;
        }
        if (releasedObjectIds.length > 0) {
          await queueReleasedProjectionObjects({
            transaction: transaction as unknown as DatabaseClient,
            knowledgeBaseId: normalized.knowledgeBaseId,
            scopePublicId: normalized.scopePublicId,
            renderedSequence: normalized.renderedSequence,
            objectIds: releasedObjectIds,
            releasedAt: normalized.createdAt
          });
          await transaction`
            UPDATE focowiki.projection_scope_receipts
            SET output_fingerprint_sha256 = ${normalized.outputFingerprintSha256},
                committed_at = ${normalized.createdAt}
            WHERE scope_public_id = ${normalized.scopePublicId}
              AND rendered_sequence = ${normalized.renderedSequence}
          `;
        }
        await enqueueProjectionCleanupOutbox({
          transaction: transaction as unknown as DatabaseClient,
          knowledgeBaseId: normalized.knowledgeBaseId,
          scopePublicId: normalized.scopePublicId,
          renderedSequence: normalized.renderedSequence,
          reservations: input.cleanupReservations ?? [],
          createdAt: normalized.createdAt
        });
      });
    },

    async read(input: {
      scopePublicId: string;
      renderedSequence: number;
    }): Promise<DocumentProjectionScopeOutput | null> {
      const rows = await sql<OutputRow[]>`
        SELECT scope_public_id, rendered_sequence, knowledge_base_id,
               output_fingerprint_sha256, pages, removed_normalized_paths,
               navigation_mutations, activation_owner_versions, created_at
        FROM focowiki.projection_scope_outputs
        WHERE scope_public_id = ${assertRepositoryIdentity(
          input.scopePublicId,
          "scope_public_id"
        )}
          AND rendered_sequence = ${assertRepositoryPositiveInteger(
            input.renderedSequence,
            "rendered_sequence"
          )}
          AND NOT EXISTS (
            SELECT 1
            FROM jsonb_array_elements(projection_scope_outputs.pages) page
            LEFT JOIN focowiki.object_registrations registration
              ON registration.object_id = page->>'objectId'
             AND registration.state = 'verified'
            LEFT JOIN focowiki.projection_scope_object_refs reference
              ON reference.scope_public_id
                   = projection_scope_outputs.scope_public_id
             AND reference.rendered_sequence
                   = projection_scope_outputs.rendered_sequence
             AND reference.object_id = page->>'objectId'
            WHERE registration.object_id IS NULL
               OR reference.object_id IS NULL
          )
      `;
      return rows[0] ? mapRow(rows[0]) : null;
    },

  };
}

async function queueReleasedProjectionObjects(input: {
  transaction: DatabaseClient;
  knowledgeBaseId: string;
  scopePublicId: string;
  renderedSequence: number;
  objectIds: readonly string[];
  releasedAt: string;
}): Promise<void> {
  const sql = input.transaction;
  const objectIds = [...new Set(input.objectIds)];
  if (objectIds.length === 0) return;
  const unowned = await sql<Array<{ object_id: string }>>`
    UPDATE focowiki.object_registrations registration
    SET zero_owner_since = coalesce(registration.zero_owner_since,
                                    ${input.releasedAt})
    WHERE registration.object_id IN ${sql(objectIds)}
      AND registration.state = 'verified'
      AND NOT EXISTS (
        SELECT 1 FROM focowiki.object_owners owner
        WHERE owner.object_id = registration.object_id
      )
      AND NOT EXISTS (
        SELECT 1 FROM focowiki.source_revisions revision
        WHERE revision.object_id = registration.object_id
      )
      AND NOT EXISTS (
        SELECT 1 FROM focowiki.generated_page_candidates candidate
        WHERE candidate.object_id = registration.object_id
      )
      AND NOT EXISTS (
        SELECT 1 FROM focowiki.upload_entries entry
        WHERE entry.object_id = registration.object_id
      )
      AND NOT EXISTS (
        SELECT 1 FROM focowiki.embedding_artifacts artifact
        WHERE artifact.object_id = registration.object_id
      )
      AND NOT EXISTS (
        SELECT 1 FROM focowiki.projection_scope_object_refs reference
        WHERE reference.object_id = registration.object_id
      )
    RETURNING registration.object_id
  `;
  if (unowned.length === 0) return;
  const releasedObjectIds = unowned.map((row) => row.object_id);
  await sql`
    INSERT INTO focowiki.cleanup_actions (
      public_id, knowledge_base_id, action_kind, cleanup_plane,
      resource_kind, resource_public_id, required, priority,
      sequence_number, idempotency_key, request_hash, checkpoint,
      state, attempt_count, maximum_attempts, not_before,
      created_at, updated_at
    )
    SELECT 'cleanup-invalid-projection-' || md5(
             ${input.scopePublicId} || chr(31)
             || ${input.renderedSequence.toString()} || chr(31) || object_id
           ), ${input.knowledgeBaseId}, 'zero_owner_object',
           'object_storage', 'zero_owner_object', object_id, true, 40,
           row_number() OVER (ORDER BY object_id COLLATE "C")::integer,
           'invalid-projection-output:' || ${input.scopePublicId} || ':'
             || ${input.renderedSequence.toString()} || ':' || object_id,
           md5(object_id), jsonb_build_object(
             'schemaVersion', 'invalid-projection-output-release-v1'
           ), 'queued', 0, 8, ${input.releasedAt}, ${input.releasedAt},
           ${input.releasedAt}
    FROM unnest(${releasedObjectIds}::text[]) released(object_id)
    ON CONFLICT ON CONSTRAINT cleanup_actions_idempotency_key DO NOTHING
  `;
}

function mapRow(row: OutputRow): DocumentProjectionScopeOutput {
  return validateProjectionScopeOutput({
    scopePublicId: row.scope_public_id,
    renderedSequence: Number(row.rendered_sequence),
    knowledgeBaseId: row.knowledge_base_id,
    outputFingerprintSha256: row.output_fingerprint_sha256,
    pages: row.pages,
    removedNormalizedPaths: row.removed_normalized_paths,
    navigationMutations: row.navigation_mutations,
    activationOwnerVersions: row.activation_owner_versions,
    createdAt: new Date(row.created_at).toISOString()
  });
}
