import type { PublicationValidationRepository } from "../../application/ports/publication-validation-repository.js";
import type { DatabaseClient } from "../../db/client.js";

const REQUIRED_ROOT_PATHS = [
  "index.md",
  "schema.md",
  "log.md",
  "_index/index.md",
  "_index/catalog.json",
  "_graph/index.md"
];

export function createPostgresPublicationValidationRepository(
  sql: DatabaseClient
): PublicationValidationRepository {
  return {
    async validateChangedClosure(input) {
      if (!Number.isSafeInteger(input.issueLimit) || input.issueLimit <= 0) {
        throw new Error("issueLimit must be a positive integer");
      }
      return sql<Array<{ code: string; message: string; reference: string | null }>>`
        WITH issues AS (
          SELECT 'IMPACT_INCOMPLETE'::text AS code,
                 'A publication impact is incomplete.'::text AS message,
                 impact.id AS reference
          FROM focowiki.publication_impacts impact
          WHERE impact.knowledge_base_id = ${input.knowledgeBaseId}
            AND impact.generation_id = ${input.generationId}
            AND impact.status <> 'completed'

          UNION ALL

          SELECT 'OBJECT_REFERENCE_INVALID',
                 'A changed object reference has no immutable object.',
                 reference.ref_kind || ':' || reference.ref_key
          FROM focowiki.generation_object_refs reference
          LEFT JOIN focowiki.immutable_objects object
            ON object.checksum_sha256 = reference.checksum_sha256
           AND object.format_version = reference.format_version
          WHERE reference.knowledge_base_id = ${input.knowledgeBaseId}
            AND reference.generation_id = ${input.generationId}
            AND reference.action = 'upsert'
            AND object.checksum_sha256 IS NULL

          UNION ALL

          SELECT 'PROJECTION_PATH_MISSING',
                 'A changed projection record has no direct logical path.',
                 record.projection_kind || ':' || record.record_id
          FROM focowiki.generation_projection_records record
          WHERE record.knowledge_base_id = ${input.knowledgeBaseId}
            AND record.generation_id = ${input.generationId}
            AND record.action = 'upsert'
            AND record.logical_path IS NULL

          UNION ALL

          SELECT 'ROOT_REFERENCE_MISSING',
                 'A required root file is unavailable.',
                 required.path
          FROM unnest(${REQUIRED_ROOT_PATHS}::text[]) AS required(path)
          WHERE NOT EXISTS (
            SELECT 1
            FROM focowiki.generation_object_refs candidate
            WHERE candidate.knowledge_base_id = ${input.knowledgeBaseId}
              AND candidate.generation_id = ${input.generationId}
              AND candidate.ref_kind = 'root'
              AND candidate.ref_key = required.path
              AND candidate.action = 'upsert'
          )
          AND NOT EXISTS (
            SELECT 1
            FROM focowiki.active_object_refs active
            WHERE active.knowledge_base_id = ${input.knowledgeBaseId}
              AND active.ref_kind = 'root'
              AND active.ref_key = required.path
          )
        )
        SELECT code, message, reference
        FROM issues
        ORDER BY code, reference
        LIMIT ${input.issueLimit}
      `;
    }
  };
}
