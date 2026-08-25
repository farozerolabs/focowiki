import type { DatabaseClient } from "../../db/client.js";
import {
  assertRepositoryIdentity,
  assertRepositoryPositiveInteger,
  assertRepositoryTimestamp,
  repositoryContractError
} from "./document-repository-validation.js";
import { createMinimumCompatiblePublicationReplacement } from
  "./postgres-document-publication-minimum-replan.js";
import { recoverPostgresDocumentPublicationQuarantines } from
  "./postgres-document-publication-quarantine-recovery.js";

export function createPostgresDocumentPublicationRecovery(
  sql: DatabaseClient
) {
  return {
    async recoverStrandedReplacements(input: Readonly<{
      rendererContractVersion: string;
      recoveredAt: string;
      limit: number;
    }>) {
      const recoveredAt = assertRepositoryTimestamp(
        input.recoveredAt,
        "recovered_at"
      );
      const limit = assertRepositoryPositiveInteger(input.limit, "limit", 256);
      if (!input.rendererContractVersion
        || Buffer.byteLength(input.rendererContractVersion, "utf8") > 128) {
        throw repositoryContractError("renderer_contract_version_invalid");
      }
      return sql.begin(async (transaction) => {
        const generations = await transaction<Array<{
          public_id: string;
          knowledge_base_id: string;
        }>>`
          SELECT generation.public_id, generation.knowledge_base_id
          FROM focowiki.projection_publication_generations generation
          JOIN focowiki.knowledge_base_projection_heads head
            ON head.knowledge_base_id = generation.knowledge_base_id
          LEFT JOIN focowiki.projection_publication_generations active
            ON active.public_id = head.active_generation_public_id
          LEFT JOIN focowiki.projection_publication_generations successor
            ON successor.public_id =
                 generation.superseded_by_generation_public_id
          WHERE generation.state = 'obsolete'
            AND generation.recovery_evidence->>'outcome'
                  = 'minimum_replacement_planned'
            AND head.active_generation_public_id IS DISTINCT FROM
                  generation.public_id
            AND (successor.public_id IS NULL OR (
              successor.state = 'quarantined'
              AND successor.renderer_contract_version
                    <> ${input.rendererContractVersion}
            ))
            AND NOT COALESCE((
              active.state = 'active'
              AND active.target_fact_epoch >= generation.target_fact_epoch
              AND active.renderer_contract_version
                    = ${input.rendererContractVersion}
            ), false)
            AND NOT EXISTS (
              SELECT 1
              FROM focowiki.projection_publication_generations terminal
              WHERE terminal.knowledge_base_id = generation.knowledge_base_id
                AND terminal.state = 'quarantined'
                AND terminal.target_fact_epoch >= generation.target_fact_epoch
                AND terminal.renderer_contract_version
                      = ${input.rendererContractVersion}
            )
            AND NOT EXISTS (
              SELECT 1
              FROM focowiki.projection_publication_generations live
              WHERE live.knowledge_base_id = generation.knowledge_base_id
                AND live.state IN ('planned', 'rendering', 'validating', 'ready')
            )
          ORDER BY generation.updated_at DESC,
                   generation.public_id COLLATE "C"
          FOR UPDATE OF generation, head SKIP LOCKED
          LIMIT ${limit}
        `;
        const recoveredKnowledgeBases = new Set<string>();
        const replacements = [];
        for (const generation of generations) {
          if (recoveredKnowledgeBases.has(generation.knowledge_base_id)) continue;
          const replacement = await createMinimumCompatiblePublicationReplacement(
            transaction as unknown as DatabaseClient,
            {
              generationPublicId: generation.public_id,
              rendererContractVersion: input.rendererContractVersion,
              supersessionReason: "publication_replacement_stranded",
              recoveredAt,
              recoverObsoleteStranded: true
            }
          );
          if (replacement) {
            replacements.push(replacement);
            recoveredKnowledgeBases.add(generation.knowledge_base_id);
          }
        }
        return {
          generationCount: replacements.length,
          releasedFactCount: 0,
          replannedFactCount: replacements.reduce((total, item) =>
            total + item.factCount, 0),
          supersededScopeCount: replacements.reduce((total, item) =>
            total + item.supersededScopeCount, 0)
        };
      });
    },

    async recoverIncompatibleGenerations(input: Readonly<{
      rendererContractVersion: string;
      recoveredAt: string;
      limit: number;
    }>) {
      const recoveredAt = assertRepositoryTimestamp(
        input.recoveredAt,
        "recovered_at"
      );
      const limit = assertRepositoryPositiveInteger(input.limit, "limit", 256);
      if (!input.rendererContractVersion
        || Buffer.byteLength(input.rendererContractVersion, "utf8") > 128) {
        throw repositoryContractError("renderer_contract_version_invalid");
      }
      return sql.begin(async (transaction) => {
        const generations = await transaction<Array<{
          public_id: string;
          knowledge_base_id: string;
        }>>`
          SELECT generation.public_id, generation.knowledge_base_id
          FROM focowiki.projection_publication_generations generation
          JOIN focowiki.knowledge_base_projection_heads head
            ON head.knowledge_base_id = generation.knowledge_base_id
          WHERE generation.state IN (
              'planned', 'rendering', 'validating', 'ready'
            )
            AND generation.renderer_contract_version
                  <> ${input.rendererContractVersion}
            AND head.active_generation_public_id IS DISTINCT FROM
                  generation.public_id
          ORDER BY generation.updated_at,
                   generation.public_id COLLATE "C"
          FOR UPDATE OF generation, head SKIP LOCKED
          LIMIT ${limit}
        `;
        if (generations.length === 0) {
          return {
            generationCount: 0,
            releasedFactCount: 0,
            replannedFactCount: 0,
            supersededScopeCount: 0
          };
        }
        const replacements = [];
        for (const generation of generations) {
          const replacement = await createMinimumCompatiblePublicationReplacement(
            transaction as unknown as DatabaseClient,
            {
              generationPublicId: generation.public_id,
              rendererContractVersion: input.rendererContractVersion,
              supersessionReason:
                "publication_renderer_contract_incompatible",
              recoveredAt
            }
          );
          if (replacement) replacements.push(replacement);
        }
        return {
          generationCount: replacements.length,
          releasedFactCount: 0,
          replannedFactCount: replacements.reduce((total, item) =>
            total + item.factCount, 0),
          supersededScopeCount: replacements.reduce((total, item) =>
            total + item.supersededScopeCount, 0)
        };
      });
    },

    async recoverRecoverableQuarantines(input: Readonly<{
      recoveredAt: string;
      limit: number;
      rendererContractVersion?: string;
    }>) {
      return recoverPostgresDocumentPublicationQuarantines(sql, input);
    },

    async recoverActivationPrecondition(input: Readonly<{
      generationPublicId: string;
      recoveredAt: string;
      errorCode: "publication_source_precondition_failed"
        | "publication_work_precondition_failed";
    }>) {
      const generationPublicId = assertRepositoryIdentity(
        input.generationPublicId,
        "generation_public_id"
      );
      const recoveredAt = assertRepositoryTimestamp(
        input.recoveredAt,
        "recovered_at"
      );
      if (input.errorCode !== "publication_source_precondition_failed"
        && input.errorCode !== "publication_work_precondition_failed") {
        throw repositoryContractError(
          "publication_activation_precondition_code_invalid"
        );
      }
      return sql.begin(async (transaction) => {
        const generations = await transaction<Array<{
          renderer_contract_version: string;
        }>>`
          SELECT renderer_contract_version
          FROM focowiki.projection_publication_generations
          WHERE public_id = ${generationPublicId}
        `;
        const generation = generations[0];
        if (!generation) {
          throw repositoryContractError("publication_generation_not_found");
        }
        return createMinimumCompatiblePublicationReplacement(
          transaction as unknown as DatabaseClient,
          {
            generationPublicId,
            rendererContractVersion: generation.renderer_contract_version,
            supersessionReason: input.errorCode,
            recoveredAt
          }
        );
      });
    },

    async recoverStaleBase(input: Readonly<{
      generationPublicId: string;
      recoveredAt: string;
    }>) {
      const generationPublicId = assertRepositoryIdentity(
        input.generationPublicId,
        "generation_public_id"
      );
      const recoveredAt = assertRepositoryTimestamp(
        input.recoveredAt,
        "recovered_at"
      );
      return sql.begin(async (transaction) => {
        const generations = await transaction<Array<{
          knowledge_base_id: string;
          base_generation_public_id: string | null;
          target_fact_epoch: number | string;
          active_generation_public_id: string | null;
          active_fact_epoch: number | string;
          state: string;
        }>>`
          SELECT generation.knowledge_base_id,
                 generation.base_generation_public_id,
                 generation.target_fact_epoch, generation.state,
                 head.active_generation_public_id, head.active_fact_epoch
          FROM focowiki.projection_publication_generations generation
          JOIN focowiki.knowledge_base_projection_heads head
            ON head.knowledge_base_id = generation.knowledge_base_id
          WHERE generation.public_id = ${generationPublicId}
          FOR UPDATE OF generation, head
        `;
        const generation = generations[0];
        if (!generation) {
          throw repositoryContractError("publication_generation_not_found");
        }
        if (generation.state === "obsolete") {
          return readRecoveryCounts(
            transaction as unknown as DatabaseClient,
            generationPublicId,
            generation.knowledge_base_id);
        }
        if (!["planned", "rendering", "validating", "ready"]
          .includes(generation.state)) {
          throw repositoryContractError(
            "publication_generation_not_recoverable"
          );
        }
        const baseIsStale = generation.active_generation_public_id
          !== generation.base_generation_public_id;
        const targetIsStale = Number(generation.target_fact_epoch)
          < Number(generation.active_fact_epoch);
        if (!baseIsStale && !targetIsStale) {
          throw repositoryContractError(
            "publication_generation_not_stale"
          );
        }
        const staleCode = targetIsStale
          ? "publication_generation_stale_target"
          : "publication_generation_stale_base";
        const superseded = await transaction<Array<{ public_id: string }>>`
          UPDATE focowiki.projection_scope_generations
          SET state = 'superseded', lease_owner = NULL,
              lease_expires_at = NULL, heartbeat_at = NULL,
              updated_at = ${recoveredAt}
          WHERE publication_generation_public_id = ${generationPublicId}
            AND state IN ('waiting', 'running', 'error')
          RETURNING public_id
        `;
        const released = await transaction<Array<{ fact_epoch: number }>>`
          UPDATE focowiki.projection_fact_epochs epoch
          SET state = 'ready'
          FROM focowiki.projection_generation_documents document
          WHERE document.generation_public_id = ${generationPublicId}
            AND epoch.knowledge_base_id = ${generation.knowledge_base_id}
            AND epoch.mutation_public_id = document.mutation_public_id
            AND epoch.fact_epoch = document.fact_epoch
            AND epoch.state = 'included'
          RETURNING epoch.fact_epoch
        `;
        await transaction`
          UPDATE focowiki.projection_publication_generations
          SET state = 'obsolete', completed_at = ${recoveredAt},
              activation_next_eligible_at = NULL,
              safe_error_code = ${staleCode},
              supersession_reason = ${staleCode},
              updated_at = ${recoveredAt}
          WHERE public_id = ${generationPublicId}
        `;
        return {
          generationPublicId,
          knowledgeBaseId: generation.knowledge_base_id,
          releasedFactCount: released.length,
          supersededScopeCount: superseded.length
        };
      });
    }
  };
}

async function readRecoveryCounts(
  sql: DatabaseClient,
  generationPublicId: string,
  knowledgeBaseId: string
) {
  const rows = await sql<Array<{
    released_fact_count: number | string;
    superseded_scope_count: number | string;
  }>>`
    SELECT
      (SELECT count(*)
       FROM focowiki.projection_generation_documents document
       JOIN focowiki.projection_fact_epochs epoch
         ON epoch.knowledge_base_id = ${knowledgeBaseId}
        AND epoch.mutation_public_id = document.mutation_public_id
        AND epoch.fact_epoch = document.fact_epoch
       WHERE document.generation_public_id = ${generationPublicId}
         AND epoch.state = 'ready') AS released_fact_count,
      (SELECT count(*) FROM focowiki.projection_scope_generations
       WHERE publication_generation_public_id = ${generationPublicId}
         AND state = 'superseded') AS superseded_scope_count
  `;
  return {
    generationPublicId,
    knowledgeBaseId,
    releasedFactCount: Number(rows[0]?.released_fact_count ?? 0),
    supersededScopeCount: Number(rows[0]?.superseded_scope_count ?? 0)
  };
}
