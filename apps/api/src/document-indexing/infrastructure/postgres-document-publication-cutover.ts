import type { DatabaseClient } from "../../db/client.js";
import {
  assertRepositoryIdentity,
  assertRepositoryTimestamp
} from "./document-repository-validation.js";

const REQUIRED_PARITY_CHECK_COUNT = 7;

export function createPostgresDocumentPublicationCutover(sql: DatabaseClient) {
  return {
    async cutover(input: Readonly<{
      knowledgeBaseId: string;
      now: string;
    }>) {
      const knowledgeBaseId = assertRepositoryIdentity(
        input.knowledgeBaseId,
        "knowledge_base_id"
      );
      const now = assertRepositoryTimestamp(input.now, "now");
      return sql.begin(async (transaction) => {
        await transaction`SET LOCAL lock_timeout = '2s'`;
        await transaction`
          SELECT pg_advisory_xact_lock(hashtextextended(${knowledgeBaseId}, 70701))
        `;
        const states = await transaction<Array<{
          writer_mode: string;
          shadow_generation_public_id: string | null;
          shadow_target_fact_epoch: number | string | null;
          shadow_expected_path_count: number | string | null;
        }>>`
          SELECT writer_mode, shadow_generation_public_id,
                 shadow_target_fact_epoch, shadow_expected_path_count
          FROM focowiki.projection_cutover_states
          WHERE knowledge_base_id = ${knowledgeBaseId}
          FOR UPDATE
        `;
        const state = states[0];
        if (!state || state.writer_mode !== "shadow"
          || !state.shadow_generation_public_id
          || state.shadow_target_fact_epoch === null
          || state.shadow_expected_path_count === null) {
          throw cutoverError("CUTOVER_STATE_INVALID");
        }
        const generationPublicId = state.shadow_generation_public_id;
        const closure = await transaction<Array<{
          generation_state: string;
          base_generation_public_id: string | null;
          target_fact_epoch: number | string;
          active_generation_public_id: string | null;
          head_version: number | string;
          active_fact_epoch: number | string;
          parity_count: number | string;
          active_path_count: number | string;
          shadow_path_count: number | string;
          page_mismatch_count: number | string;
          maximum_fact_epoch: number | string;
          unfinished_work_count: number | string;
        }>>`
          SELECT generation.state generation_state,
                 generation.base_generation_public_id,
                 generation.target_fact_epoch,
                 head.active_generation_public_id, head.head_version,
                 head.active_fact_epoch,
                 (SELECT count(*)
                  FROM focowiki.projection_shadow_parity_results parity
                  WHERE parity.generation_public_id = generation.public_id
                    AND parity.state = 'passed') parity_count,
                 (SELECT count(*) FROM focowiki.generated_page_heads page
                  WHERE page.knowledge_base_id = ${knowledgeBaseId})
                    active_path_count,
                 (SELECT count(*)
                  FROM focowiki.projection_scope_generation_pages page
                  WHERE page.publication_generation_public_id
                          = generation.public_id
                    AND page.action = 'put') shadow_path_count,
                 (SELECT count(*)
                  FROM focowiki.generated_page_heads active
                  LEFT JOIN focowiki.projection_scope_generation_pages shadow
                    ON shadow.publication_generation_public_id
                         = generation.public_id
                   AND shadow.normalized_path = active.normalized_path
                   AND shadow.action = 'put'
                  WHERE active.knowledge_base_id = ${knowledgeBaseId}
                    AND (shadow.normalized_path IS NULL
                      OR shadow.logical_path IS DISTINCT FROM active.logical_path
                      OR shadow.entry_kind IS DISTINCT FROM active.entry_kind
                      OR shadow.object_id IS DISTINCT FROM active.object_id
                      OR shadow.checksum_sha256
                           IS DISTINCT FROM active.checksum_sha256
                      OR shadow.byte_count IS DISTINCT FROM active.byte_count))
                    page_mismatch_count,
                 (SELECT coalesce(max(epoch.fact_epoch), 0)
                  FROM focowiki.projection_fact_epochs epoch
                  WHERE epoch.knowledge_base_id = ${knowledgeBaseId})
                    maximum_fact_epoch,
                 (SELECT count(*) FROM focowiki.document_artifact_work work
                  WHERE work.knowledge_base_id = ${knowledgeBaseId}
                    AND work.state IN (
                      'waiting', 'running', 'waiting_on_projection'
                    )) unfinished_work_count
          FROM focowiki.projection_publication_generations generation
          JOIN focowiki.knowledge_base_projection_heads head
            ON head.knowledge_base_id = generation.knowledge_base_id
          WHERE generation.public_id = ${generationPublicId}
          FOR UPDATE OF generation, head
        `;
        const row = closure[0];
        const expectedPathCount = Number(state.shadow_expected_path_count);
        if (!row || row.generation_state !== "ready"
          || row.base_generation_public_id
              !== row.active_generation_public_id
          || Number(row.target_fact_epoch)
              !== Number(state.shadow_target_fact_epoch)
          || Number(row.parity_count) !== REQUIRED_PARITY_CHECK_COUNT
          || Number(row.active_path_count) !== expectedPathCount
          || Number(row.shadow_path_count) !== expectedPathCount
          || Number(row.page_mismatch_count) !== 0
          || Number(row.maximum_fact_epoch)
              !== Number(state.shadow_target_fact_epoch)
          ) {
          await failCutover(transaction as unknown as DatabaseClient, {
            knowledgeBaseId, generationPublicId, now,
            code: "cutover_closure_changed"
          });
          return { state: "failed" as const, generationPublicId };
        }
        await transaction`
          UPDATE focowiki.projection_cutover_states
          SET writer_mode = 'paused', revision = revision + 1,
              updated_at = ${now}
          WHERE knowledge_base_id = ${knowledgeBaseId}
        `;
        await transaction`
          INSERT INTO focowiki.projection_artifact_owners (
            knowledge_base_id, normalized_path, owner_scope_identity,
            artifact_family, ownership_epoch, generation_public_id, updated_at
          )
          SELECT ${knowledgeBaseId}, page.normalized_path,
                 page.owner_scope_identity,
                 CASE
                   WHEN scope.scope_kind = 'source' THEN 'source'
                   WHEN scope.scope_kind = 'directory' THEN 'page_directory'
                   WHEN scope.scope_kind = '_index'
                     AND scope.scope_key LIKE 'term:%' THEN 'term'
                   WHEN scope.scope_kind = '_index' THEN 'machine_index'
                   WHEN scope.scope_kind = '_graph'
                     AND scope.scope_key = 'catalog' THEN 'graph_catalog'
                   WHEN scope.scope_kind = '_graph' THEN 'graph'
                   ELSE 'root'
                 END,
                 ${Number(state.shadow_target_fact_epoch)},
                 ${generationPublicId}, ${now}
          FROM focowiki.projection_scope_generation_pages page
          JOIN focowiki.projection_scope_generations scope
            ON scope.public_id = page.scope_generation_public_id
          WHERE page.publication_generation_public_id = ${generationPublicId}
            AND page.action = 'put'
          ON CONFLICT (knowledge_base_id, normalized_path) DO UPDATE
          SET owner_scope_identity = excluded.owner_scope_identity,
              artifact_family = excluded.artifact_family,
              ownership_epoch = excluded.ownership_epoch,
              generation_public_id = excluded.generation_public_id,
              updated_at = excluded.updated_at
        `;
        await transaction`
          UPDATE focowiki.generated_page_heads
          SET projection_generation_public_id = ${generationPublicId},
              activation_revision = greatest(
                activation_revision, ${Number(state.shadow_target_fact_epoch)}
              ), updated_at = ${now}
          WHERE knowledge_base_id = ${knowledgeBaseId}
        `;
        await transaction`
          INSERT INTO focowiki.projection_directory_owners (
            knowledge_base_id, directory_path, owner_scope_identity,
            ownership_epoch, generation_public_id, updated_at
          )
          SELECT ${knowledgeBaseId}, claim.directory_path,
                 claim.owner_scope_identity,
                 ${Number(state.shadow_target_fact_epoch)},
                 ${generationPublicId}, ${now}
          FROM focowiki.projection_generation_directory_claims claim
          WHERE claim.publication_generation_public_id = ${generationPublicId}
          ON CONFLICT (knowledge_base_id, directory_path) DO UPDATE
          SET owner_scope_identity = excluded.owner_scope_identity,
              ownership_epoch = excluded.ownership_epoch,
              generation_public_id = excluded.generation_public_id,
              updated_at = excluded.updated_at
        `;
        if (row.base_generation_public_id) {
          await transaction`
            INSERT INTO focowiki.projection_generation_retention (
              generation_public_id, retention_state, reason, updated_at
            ) VALUES (
              ${row.base_generation_public_id}, 'retained',
              'pre-cutover rollback generation', ${now}
            ) ON CONFLICT (generation_public_id) DO UPDATE
              SET retention_state = 'retained',
                  reason = excluded.reason, updated_at = excluded.updated_at
          `;
          await transaction`
            UPDATE focowiki.projection_publication_generations
            SET state = 'obsolete', completed_at = coalesce(completed_at, ${now}),
                updated_at = ${now}
            WHERE public_id = ${row.base_generation_public_id}
              AND state = 'active'
          `;
        }
        await transaction`
          UPDATE focowiki.projection_publication_generations
          SET state = 'active', completed_at = ${now}, updated_at = ${now}
          WHERE public_id = ${generationPublicId} AND state = 'ready'
        `;
        await transaction`
          UPDATE focowiki.knowledge_base_projection_heads
          SET active_generation_public_id = ${generationPublicId},
              active_fact_epoch = ${Number(state.shadow_target_fact_epoch)},
              head_version = head_version + 1, updated_at = ${now}
          WHERE knowledge_base_id = ${knowledgeBaseId}
        `;
        await transaction`
          UPDATE focowiki.projection_fact_epochs
          SET state = 'included'
          WHERE knowledge_base_id = ${knowledgeBaseId}
            AND fact_epoch <= ${Number(state.shadow_target_fact_epoch)}
            AND state = 'ready'
        `;
        await transaction`
          UPDATE focowiki.projection_cutover_states
          SET writer_mode = 'coherent',
              cutover_generation_public_id = ${generationPublicId},
              safe_error_code = NULL, revision = revision + 1,
              updated_at = ${now}
          WHERE knowledge_base_id = ${knowledgeBaseId}
            AND writer_mode = 'paused'
        `;
        return { state: "active" as const, generationPublicId,
          headVersion: Number(row.head_version) + 1 };
      });
    },

    async rollbackBeforeMutation(input: Readonly<{
      knowledgeBaseId: string;
      now: string;
    }>) {
      const knowledgeBaseId = assertRepositoryIdentity(
        input.knowledgeBaseId,
        "knowledge_base_id"
      );
      const now = assertRepositoryTimestamp(input.now, "now");
      return sql.begin(async (transaction) => {
        await transaction`
          SELECT pg_advisory_xact_lock(hashtextextended(${knowledgeBaseId}, 70701))
        `;
        const rows = await transaction<Array<{
          cutover_generation_public_id: string;
          base_generation_public_id: string | null;
          target_fact_epoch: number | string;
          maximum_fact_epoch: number | string;
        }>>`
          SELECT cutover.cutover_generation_public_id,
                 generation.base_generation_public_id,
                 generation.target_fact_epoch,
                 (SELECT coalesce(max(epoch.fact_epoch), 0)
                  FROM focowiki.projection_fact_epochs epoch
                  WHERE epoch.knowledge_base_id = ${knowledgeBaseId})
                    maximum_fact_epoch
          FROM focowiki.projection_cutover_states cutover
          JOIN focowiki.projection_publication_generations generation
            ON generation.public_id = cutover.cutover_generation_public_id
          JOIN focowiki.knowledge_base_projection_heads head
            ON head.knowledge_base_id = cutover.knowledge_base_id
           AND head.active_generation_public_id = generation.public_id
          WHERE cutover.knowledge_base_id = ${knowledgeBaseId}
            AND cutover.writer_mode = 'coherent'
          FOR UPDATE OF cutover, generation, head
        `;
        const state = rows[0];
        if (!state || Number(state.maximum_fact_epoch)
            > Number(state.target_fact_epoch)) {
          return false;
        }
        await transaction`
          DELETE FROM focowiki.projection_artifact_owners
          WHERE knowledge_base_id = ${knowledgeBaseId}
            AND generation_public_id = ${state.cutover_generation_public_id}
        `;
        await transaction`
          DELETE FROM focowiki.projection_directory_owners
          WHERE knowledge_base_id = ${knowledgeBaseId}
            AND generation_public_id = ${state.cutover_generation_public_id}
        `;
        await transaction`
          UPDATE focowiki.generated_page_heads
          SET projection_generation_public_id
                = ${state.base_generation_public_id},
              updated_at = ${now}
          WHERE knowledge_base_id = ${knowledgeBaseId}
            AND projection_generation_public_id
                  = ${state.cutover_generation_public_id}
        `;
        await transaction`
          UPDATE focowiki.knowledge_base_projection_heads
          SET active_generation_public_id = ${state.base_generation_public_id},
              active_fact_epoch = 0, head_version = head_version + 1,
              updated_at = ${now}
          WHERE knowledge_base_id = ${knowledgeBaseId}
        `;
        await transaction`
          UPDATE focowiki.projection_publication_generations
          SET state = 'obsolete', completed_at = coalesce(completed_at, ${now}),
              updated_at = ${now}
          WHERE public_id = ${state.cutover_generation_public_id}
        `;
        if (state.base_generation_public_id) {
          await transaction`
            UPDATE focowiki.projection_publication_generations
            SET state = 'active', updated_at = ${now}
            WHERE public_id = ${state.base_generation_public_id}
              AND state = 'obsolete'
          `;
        }
        await transaction`
          UPDATE focowiki.projection_cutover_states
          SET writer_mode = 'legacy', cutover_generation_public_id = NULL,
              revision = revision + 1, updated_at = ${now}
          WHERE knowledge_base_id = ${knowledgeBaseId}
        `;
        return true;
      });
    }
  };
}

async function failCutover(sql: DatabaseClient, input: Readonly<{
  knowledgeBaseId: string;
  generationPublicId: string;
  now: string;
  code: string;
}>) {
  await sql`
    UPDATE focowiki.projection_publication_generations
    SET state = 'quarantined', safe_error_code = ${input.code},
        updated_at = ${input.now}
    WHERE public_id = ${input.generationPublicId}
      AND state IN ('rendering', 'validating', 'ready')
  `;
  await sql`
    UPDATE focowiki.projection_cutover_states
    SET writer_mode = 'legacy', safe_error_code = ${input.code},
        revision = revision + 1, updated_at = ${input.now}
    WHERE knowledge_base_id = ${input.knowledgeBaseId}
  `;
}

function cutoverError(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}
