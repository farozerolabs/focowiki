import type { DatabaseClient } from "../../db/client.js";
import {
  validateDocumentPublicationGeneration,
  type DocumentPublicationValidationEvidence
} from "../application/document-publication-generation-validation.js";
import {
  assertRepositoryIdentity,
  assertRepositoryTimestamp,
  repositoryContractError
} from "./document-repository-validation.js";

const MAXIMUM_VALIDATION_ROWS = 10_000;

export function createPostgresDocumentPublicationValidator(
  sql: DatabaseClient
) {
  return {
    async validate(input: Readonly<{
      generationPublicId: string;
      checkedAt: string;
    }>) {
      const generationPublicId = assertRepositoryIdentity(
        input.generationPublicId,
        "generation_public_id"
      );
      const checkedAt = assertRepositoryTimestamp(input.checkedAt, "checked_at");
      return sql.begin(async (transaction) => {
        const generations = await transaction<Array<{
          knowledge_base_id: string;
          state: string;
          output_fingerprint_sha256: string | null;
        }>>`
          SELECT knowledge_base_id, state, output_fingerprint_sha256
          FROM focowiki.projection_publication_generations
          WHERE public_id = ${generationPublicId}
          FOR UPDATE
        `;
        const generation = generations[0];
        if (!generation || !["rendering", "validating", "ready"]
          .includes(generation.state)) {
          throw repositoryContractError("publication_generation_not_validatable");
        }
        const statsRows = await transaction<Array<ValidationStats>>`
          SELECT
            (SELECT count(*) FROM focowiki.projection_generation_documents
              WHERE generation_public_id = ${generationPublicId})
              AS generation_document_count,
            (SELECT count(*)
             FROM focowiki.projection_generation_documents document
             JOIN focowiki.projection_fact_epochs epoch
               ON epoch.knowledge_base_id = ${generation.knowledge_base_id}
              AND epoch.mutation_public_id = document.mutation_public_id
              AND epoch.fact_epoch = document.fact_epoch
              AND epoch.state = 'included'
             WHERE document.generation_public_id = ${generationPublicId})
              AS included_fact_count,
            (SELECT count(*) FROM focowiki.projection_scope_generations
              WHERE publication_generation_public_id = ${generationPublicId})
              AS scope_count,
            (SELECT count(*) FROM focowiki.projection_scope_generations
              WHERE publication_generation_public_id = ${generationPublicId}
                AND state <> 'completed') AS incomplete_scope_count,
            (SELECT count(*)
             FROM focowiki.projection_scope_generation_dependencies dependency
             JOIN focowiki.projection_scope_generations scope
               ON scope.public_id = dependency.scope_generation_public_id
             JOIN focowiki.projection_scope_generations prerequisite
               ON prerequisite.public_id
                    = dependency.depends_on_scope_generation_public_id
             WHERE scope.publication_generation_public_id
                     = ${generationPublicId}
               AND prerequisite.state <> 'completed')
              AS incomplete_dependency_count,
            (SELECT count(*)
             FROM focowiki.projection_scope_generation_pages page
             WHERE page.publication_generation_public_id = ${generationPublicId}
               AND page.action = 'put') AS put_count,
            (SELECT count(*)
             FROM focowiki.projection_scope_generation_pages page
             WHERE page.publication_generation_public_id = ${generationPublicId}
               AND page.action = 'delete') AS delete_count,
            (SELECT count(*)
             FROM focowiki.projection_scope_generation_object_refs reference
             JOIN focowiki.projection_scope_generations scope
               ON scope.public_id = reference.scope_generation_public_id
             JOIN focowiki.object_registrations registration
               ON registration.object_id = reference.object_id
             WHERE scope.publication_generation_public_id
                     = ${generationPublicId}
               AND registration.state <> 'verified')
              AS unverified_object_count,
            (SELECT count(*)
             FROM focowiki.projection_scope_generation_pages page
             LEFT JOIN focowiki.projection_scope_generation_object_refs reference
               ON reference.scope_generation_public_id
                    = page.scope_generation_public_id
              AND reference.object_id = page.object_id
             WHERE page.publication_generation_public_id = ${generationPublicId}
               AND page.action = 'put' AND reference.object_id IS NULL)
              AS missing_object_reference_count,
            (SELECT count(*) FROM (
              SELECT normalized_path
              FROM focowiki.projection_scope_generation_pages
              WHERE publication_generation_public_id = ${generationPublicId}
              GROUP BY normalized_path HAVING count(*) > 1
            ) duplicate) AS duplicate_path_count,
            (SELECT count(*) FROM (
              SELECT directory_path
              FROM focowiki.projection_generation_directory_claims
              WHERE publication_generation_public_id = ${generationPublicId}
              GROUP BY directory_path HAVING count(*) > 1
            ) duplicate) AS duplicate_directory_owner_count
        `;
        const pageRows = await transaction<Array<{
          scope_identity: string;
          input_snapshot_fingerprint_sha256: string;
          output_fingerprint_sha256: string;
          validation_evidence: unknown;
          normalized_path: string | null;
          action: "put" | "delete" | null;
          checksum_sha256: string | null;
        }>>`
          SELECT scope.scope_identity,
                 scope.input_snapshot_fingerprint_sha256,
                 scope.output_fingerprint_sha256,
                 scope.validation_evidence,
                 page.normalized_path, page.action, page.checksum_sha256
          FROM focowiki.projection_scope_generations scope
          LEFT JOIN focowiki.projection_scope_generation_pages page
            ON page.scope_generation_public_id = scope.public_id
          WHERE scope.publication_generation_public_id = ${generationPublicId}
            AND scope.state = 'completed'
          ORDER BY scope.scope_identity COLLATE "C",
                   page.normalized_path COLLATE "C"
          LIMIT ${MAXIMUM_VALIDATION_ROWS + 1}
        `;
        if (pageRows.length > MAXIMUM_VALIDATION_ROWS) {
          throw repositoryContractError("publication_validation_row_limit");
        }
        const scopes = groupScopeRows(pageRows);
        const stats = normalizeStats(statsRows[0]);
        const result = validateDocumentPublicationGeneration({
          generationPublicId,
          ...stats,
          scopes,
          evidence: scopes.flatMap((scope) =>
            isValidationEvidence(scope.validationEvidence)
              ? [scope.validationEvidence] : [])
        });
        if (generation.output_fingerprint_sha256
          && generation.output_fingerprint_sha256
            !== result.outputFingerprintSha256) {
          result.failedChecks.push("same_input_output_diverged");
        }
        const finalState = result.failedChecks.length === 0
          ? "ready" : "quarantined";
        await transaction`
          INSERT INTO focowiki.projection_generation_validation_results (
            generation_public_id, check_name, state, checked_count,
            evidence_sha256, safe_detail, checked_at
          ) VALUES (
            ${generationPublicId}, 'coherent_generation',
            ${finalState === "ready" ? "passed" : "failed"},
            ${result.checkedCount}, ${result.outputFingerprintSha256},
            ${transaction.json({ failedChecks: result.failedChecks } as never)},
            ${checkedAt}
          )
          ON CONFLICT (generation_public_id, check_name) DO UPDATE
          SET state = excluded.state,
              checked_count = excluded.checked_count,
              evidence_sha256 = excluded.evidence_sha256,
              safe_detail = excluded.safe_detail,
              checked_at = excluded.checked_at
          WHERE projection_generation_validation_results.evidence_sha256
                  = excluded.evidence_sha256
        `;
        await transaction`
          UPDATE focowiki.projection_publication_generations
          SET state = ${finalState},
              output_fingerprint_sha256 = ${result.outputFingerprintSha256},
              updated_at = ${checkedAt}
          WHERE public_id = ${generationPublicId}
        `;
        return { ...result, state: finalState };
      });
    }
  };
}

type ValidationStats = {
  generation_document_count: number | string;
  included_fact_count: number | string;
  scope_count: number | string;
  incomplete_scope_count: number | string;
  incomplete_dependency_count: number | string;
  put_count: number | string;
  delete_count: number | string;
  unverified_object_count: number | string;
  missing_object_reference_count: number | string;
  duplicate_path_count: number | string;
  duplicate_directory_owner_count: number | string;
};

function normalizeStats(row: ValidationStats | undefined) {
  if (!row) throw repositoryContractError("publication_validation_stats_missing");
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [
    key.replace(/_([a-z])/gu, (_, character: string) => character.toUpperCase()),
    Number(value)
  ])) as Omit<ReturnType<typeof statsShape>, never>;
}

function statsShape() {
  return {
    generationDocumentCount: 0, includedFactCount: 0, scopeCount: 0,
    incompleteScopeCount: 0, incompleteDependencyCount: 0, putCount: 0,
    deleteCount: 0, unverifiedObjectCount: 0,
    missingObjectReferenceCount: 0, duplicatePathCount: 0,
    duplicateDirectoryOwnerCount: 0
  };
}

function groupScopeRows(rows: readonly {
  scope_identity: string;
  input_snapshot_fingerprint_sha256: string;
  output_fingerprint_sha256: string;
  validation_evidence: unknown;
  normalized_path: string | null;
  action: "put" | "delete" | null;
  checksum_sha256: string | null;
}[]) {
  const grouped = new Map<string, {
    scopeIdentity: string;
    inputFingerprintSha256: string;
    outputFingerprintSha256: string;
    validationEvidence: unknown;
    pages: { normalizedPath: string; action: "put" | "delete";
      checksumSha256: string | null }[];
  }>();
  for (const row of rows) {
    const scope = grouped.get(row.scope_identity) ?? {
      scopeIdentity: row.scope_identity,
      inputFingerprintSha256: row.input_snapshot_fingerprint_sha256,
      outputFingerprintSha256: row.output_fingerprint_sha256,
      validationEvidence: row.validation_evidence,
      pages: []
    };
    if (row.normalized_path && row.action) scope.pages.push({
      normalizedPath: row.normalized_path,
      action: row.action,
      checksumSha256: row.checksum_sha256
    });
    grouped.set(row.scope_identity, scope);
  }
  return [...grouped.values()];
}

function isValidationEvidence(
  value: unknown
): value is DocumentPublicationValidationEvidence {
  if (!value || typeof value !== "object") return false;
  const evidence = value as Partial<DocumentPublicationValidationEvidence>;
  return typeof evidence.scopeIdentity === "string"
    && Boolean(evidence.sourceTargets) && Boolean(evidence.linkTargets)
    && Boolean(evidence.continuationChains) && Boolean(evidence.navigation)
    && Boolean(evidence.graph) && Boolean(evidence.indexes)
    && Boolean(evidence.tombstones) && Boolean(evidence.search);
}
