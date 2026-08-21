import type { DatabaseClient } from "../../db/client.js";
import { MAXIMUM_PROJECTION_SCOPE_OUTPUTS_PER_DOCUMENT } from
  "../domain/document-projection-limits.js";
import type { DocumentDirectoryNavigationMutation } from
  "../application/document-directory-navigation-mutation.js";
import { validateDocumentDirectoryNavigationMutations } from
  "../application/document-directory-navigation-mutation.js";
import type { StagedDocumentPage } from
  "../application/document-generated-page-staging.js";
import {
  assertRepositoryIdentity,
  assertRepositoryPositiveInteger,
  assertRepositorySha256,
  assertRepositoryTimestamp,
  repositoryContractError
} from "./document-repository-validation.js";

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

export function createPostgresProjectionScopeOutputRepository(
  sql: DatabaseClient
) {
  return {
    async persist(input: DocumentProjectionScopeOutput): Promise<void> {
      const normalized = validateOutput(input);
      await sql.begin(async (transaction) => {
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

    async readForDocument(input: {
      knowledgeBaseId: string;
      documentJobPublicId: string;
      limit: number;
    }): Promise<readonly DocumentProjectionScopeOutput[]> {
      const limit = assertRepositoryPositiveInteger(
        input.limit,
        "limit",
        MAXIMUM_PROJECTION_SCOPE_OUTPUTS_PER_DOCUMENT
      );
      const rows = await sql<OutputRow[]>`
        SELECT DISTINCT ON (output.scope_public_id)
               output.scope_public_id, output.rendered_sequence,
               output.knowledge_base_id, output.output_fingerprint_sha256,
               output.pages, output.removed_normalized_paths,
               output.navigation_mutations, output.activation_owner_versions,
               output.created_at
        FROM focowiki.projection_scope_contributions contribution
        JOIN focowiki.projection_scope_receipts receipt
          ON receipt.contribution_public_id = contribution.public_id
        JOIN focowiki.projection_scope_outputs output
          ON output.scope_public_id = receipt.scope_public_id
         AND output.rendered_sequence = receipt.rendered_sequence
        WHERE contribution.knowledge_base_id = ${assertRepositoryIdentity(
          input.knowledgeBaseId,
          "knowledge_base_id"
        )}
          AND contribution.document_job_public_id = ${assertRepositoryIdentity(
            input.documentJobPublicId,
            "document_job_public_id"
          )}
          AND contribution.state = 'acknowledged'
        ORDER BY output.scope_public_id
        LIMIT ${limit + 1}
      `;
      if (rows.length > limit) {
        throw repositoryContractError("projection_scope_output_limit_exceeded");
      }
      return rows.map(mapRow);
    }
  };
}

function validateOutput(
  input: DocumentProjectionScopeOutput
): DocumentProjectionScopeOutput {
  const pages = [...input.pages].sort(comparePage);
  const removedNormalizedPaths = [...new Set(input.removedNormalizedPaths)]
    .sort();
  if (pages.length > 256
    || new Set(pages.map((page) => page.normalizedPath)).size !== pages.length
    || removedNormalizedPaths.length > 256
    || pages.some((page) => !validPage(page))
    || removedNormalizedPaths.some((path) => !validPath(path))) {
    throw repositoryContractError("projection_scope_output_invalid");
  }
  validateDocumentDirectoryNavigationMutations(input.navigationMutations);
  const ownerIdentities = input.activationOwnerVersions.map((owner) =>
    `${owner.kind}\0${owner.key}`);
  if (input.activationOwnerVersions.length > 30_000
    || new Set(ownerIdentities).size !== ownerIdentities.length
    || input.activationOwnerVersions.some((owner) =>
      !["page_head", "directory_leaf", "directory_entry"].includes(owner.kind)
      || !owner.key || Buffer.byteLength(owner.key, "utf8") > 2_048
      || !Number.isSafeInteger(owner.expectedVersion)
      || owner.expectedVersion < 0)) {
    throw repositoryContractError("projection_scope_output_owner_invalid");
  }
  return {
    scopePublicId: assertRepositoryIdentity(input.scopePublicId, "scope_public_id"),
    renderedSequence: assertRepositoryPositiveInteger(
      input.renderedSequence,
      "rendered_sequence"
    ),
    knowledgeBaseId: assertRepositoryIdentity(
      input.knowledgeBaseId,
      "knowledge_base_id"
    ),
    outputFingerprintSha256: assertRepositorySha256(
      input.outputFingerprintSha256,
      "output_fingerprint"
    ),
    pages,
    removedNormalizedPaths,
    navigationMutations: [...input.navigationMutations],
    activationOwnerVersions: [...input.activationOwnerVersions].sort(
      (left, right) => left.kind.localeCompare(right.kind, "en-US")
        || left.key.localeCompare(right.key, "en-US")
    ),
    createdAt: assertRepositoryTimestamp(input.createdAt, "created_at")
  };
}

function validPage(page: DocumentProjectionScopeOutputPage): boolean {
  return validPath(page.logicalPath) && validPath(page.normalizedPath)
    && page.normalizedPath === page.logicalPath.toLocaleLowerCase("en-US")
    && Boolean(page.entryKind) && Buffer.byteLength(page.entryKind, "utf8") <= 128
    && Boolean(page.objectId) && Buffer.byteLength(page.objectId, "utf8") <= 255
    && /^[0-9a-f]{64}$/u.test(page.checksumSha256)
    && Number.isSafeInteger(page.byteCount) && page.byteCount >= 0
    && ((page.sourceFilePublicId === null
      && page.sourceRevisionPublicId === null)
      || (Boolean(page.sourceFilePublicId)
        && Boolean(page.sourceRevisionPublicId)));
}

function validPath(path: string): boolean {
  return Boolean(path) && !path.startsWith("/") && !path.includes("..")
    && Buffer.byteLength(path, "utf8") <= 4096;
}

function mapRow(row: OutputRow): DocumentProjectionScopeOutput {
  return validateOutput({
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

function comparePage(
  left: DocumentProjectionScopeOutputPage,
  right: DocumentProjectionScopeOutputPage
): number {
  return left.normalizedPath.localeCompare(right.normalizedPath, "en-US");
}
