import type { DatabaseClient } from "../../db/client.js";
import { repositoryContractError } from "./document-repository-validation.js";

const MAXIMUM_SCOPE_MEMBERS = 10_000;
const MAXIMUM_BASE_ACTIONS = 10_000;

export function createPostgresDocumentPublicationSnapshot(
  sql: DatabaseClient
) {
  return {
    async readScope(scopeGenerationPublicId: string) {
      return sql.begin(async (transaction) => {
        const scopes = await transaction<Array<{
          public_id: string;
          publication_generation_public_id: string;
          knowledge_base_id: string;
          scope_identity: string;
          scope_kind: string;
          scope_key: string;
          scope_generation: number | string;
          target_fact_epoch: number | string;
          input_snapshot_fingerprint_sha256: string;
          renderer_contract_version: string;
          deterministic_changed_at: Date | string;
          base_generation_public_id: string | null;
        }>>`
          SELECT scope.public_id, scope.publication_generation_public_id,
                 scope.knowledge_base_id, scope.scope_identity,
                 scope.scope_kind, scope.scope_key,
                 scope.scope_generation, generation.target_fact_epoch,
                 scope.input_snapshot_fingerprint_sha256,
                 generation.renderer_contract_version,
                 generation.deterministic_changed_at,
                 generation.base_generation_public_id
          FROM focowiki.projection_scope_generations scope
          JOIN focowiki.projection_publication_generations generation
            ON generation.public_id = scope.publication_generation_public_id
          WHERE scope.public_id = ${scopeGenerationPublicId}
        `;
        const scope = scopes[0];
        if (!scope) throw repositoryContractError("scope_snapshot_not_found");
        const members = await transaction<Array<{
          member_kind: string;
          member_public_id: string;
          member_version: string;
          member_order: number;
          source_file_public_id: string | null;
        }>>`
          SELECT member.member_kind, member.member_public_id,
                 member.member_version, member.member_order,
                 CASE WHEN member.member_kind = 'tombstone'
                   THEN member.member_public_id
                   ELSE revision.source_file_public_id END
                   AS source_file_public_id
          FROM focowiki.projection_scope_snapshot_members member
          LEFT JOIN focowiki.source_revisions revision
            ON member.member_kind = 'source_revision'
           AND revision.public_id = member.member_public_id
          WHERE member.scope_generation_public_id = ${scopeGenerationPublicId}
          ORDER BY member.member_order
          LIMIT ${MAXIMUM_SCOPE_MEMBERS + 1}
        `;
        if (members.length > MAXIMUM_SCOPE_MEMBERS) {
          throw repositoryContractError("scope_snapshot_member_limit");
        }
        const basePages = scope.base_generation_public_id === null ? []
          : await transaction<Array<{
            normalized_path: string;
            logical_path: string;
            action: "put" | "delete";
            entry_kind: string | null;
            object_id: string | null;
            checksum_sha256: string | null;
            byte_count: number | string | null;
          }>>`
             SELECT page.logical_path, page.normalized_path, page.action,
                    page.entry_kind, page.object_id, page.checksum_sha256,
                    page.byte_count
             FROM focowiki.projection_scope_generation_pages page
             WHERE page.publication_generation_public_id
                     = ${scope.base_generation_public_id}
               AND page.owner_scope_identity = ${scope.scope_identity}
             ORDER BY page.normalized_path COLLATE "C"
            LIMIT ${MAXIMUM_BASE_ACTIONS + 1}
          `;
        if (basePages.length > MAXIMUM_BASE_ACTIONS) {
          throw repositoryContractError("scope_base_action_limit");
        }
        return {
          publicId: scope.public_id,
          publicationGenerationPublicId:
            scope.publication_generation_public_id,
          knowledgeBaseId: scope.knowledge_base_id,
          scopeIdentity: scope.scope_identity,
          scopeKind: scope.scope_kind,
          scopeKey: scope.scope_key,
          scopeGeneration: Number(scope.scope_generation),
          targetFactEpoch: Number(scope.target_fact_epoch),
          inputSnapshotFingerprintSha256:
            scope.input_snapshot_fingerprint_sha256,
          rendererContractVersion: scope.renderer_contract_version,
          deterministicChangedAt:
            new Date(scope.deterministic_changed_at).toISOString(),
          baseGenerationPublicId: scope.base_generation_public_id,
          members: members.map((member) => ({
            kind: member.member_kind,
            publicId: member.member_public_id,
            version: member.member_version,
            order: member.member_order,
            sourceFilePublicId: member.source_file_public_id
          })),
          basePages: basePages.map((page) => ({
            logicalPath: page.logical_path,
            normalizedPath: page.normalized_path,
            action: page.action,
            entryKind: page.entry_kind,
            objectId: page.object_id,
            checksumSha256: page.checksum_sha256,
            byteCount: page.byte_count === null ? null : Number(page.byte_count)
          }))
        };
      });
    },

    async findVerifiedObjects(input: readonly Readonly<{
      checksumSha256: string;
      objectFormat: string;
    }>[]) {
      if (input.length > 10_000) {
        throw repositoryContractError("verified_object_lookup_limit");
      }
      if (input.length === 0) return [];
      const desired = input.map((item) => ({
        checksum_sha256: item.checksumSha256,
        object_format: item.objectFormat
      }));
      const rows = await sql<Array<{
        object_id: string;
        checksum_sha256: string;
        object_format: string;
        state: string;
      }>>`
        SELECT DISTINCT ON (
          registration.checksum_sha256, registration.object_format
        ) registration.object_id, registration.checksum_sha256,
          registration.object_format, registration.state
        FROM jsonb_to_recordset(${sql.json(desired as never)}::jsonb)
          AS desired(checksum_sha256 text, object_format text)
        JOIN focowiki.object_registrations registration
          ON registration.checksum_sha256 = desired.checksum_sha256
         AND registration.object_format = desired.object_format
         AND registration.state = 'verified'
        ORDER BY registration.checksum_sha256 COLLATE "C",
                 registration.object_format COLLATE "C",
                 registration.object_id COLLATE "C"
      `;
      return rows.map((row) => ({
        objectId: row.object_id,
        checksumSha256: row.checksum_sha256,
        objectFormat: row.object_format,
        state: row.state
      }));
    }
  };
}
