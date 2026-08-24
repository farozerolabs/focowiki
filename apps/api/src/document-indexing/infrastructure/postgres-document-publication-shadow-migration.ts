import type { DatabaseClient } from "../../db/client.js";
import {
  decideDocumentPublicationShadowContinuation
} from "../application/document-publication-shadow-migration.js";
import { DOCUMENT_PUBLICATION_RENDERER_CONTRACT_VERSION } from
  "../application/document-publication-renderer-contract.js";
import {
  inferDocumentPublicationOwnerCandidate
} from "../application/document-publication-cutover-preflight.js";
import {
  assertRepositoryIdentity,
  assertRepositoryPositiveInteger,
  assertRepositoryTimestamp
} from "./document-repository-validation.js";
import {
  backfillNonterminalDocumentPublicationFacts,
  documentPublicationShadowError,
  documentPublicationShadowOwnedDirectoryPath,
  documentPublicationShadowPageIdentity,
  EMPTY_SHADOW_SHA256,
  failDocumentPublicationShadow,
  hashDocumentPublicationShadow,
  mapDocumentPublicationShadowState,
  readDocumentPublicationShadowStartSummary,
  safeDocumentPublicationShadowErrorCode,
  type DocumentPublicationShadowPageRow
} from "./postgres-document-publication-shadow-support.js";

export function createPostgresDocumentPublicationShadowMigration(
  sql: DatabaseClient
) {
  return {
    async start(input: Readonly<{
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
          INSERT INTO focowiki.knowledge_base_projection_heads (
            knowledge_base_id, updated_at
          ) VALUES (${knowledgeBaseId}, ${now})
          ON CONFLICT (knowledge_base_id) DO NOTHING
        `;
        await transaction`
          INSERT INTO focowiki.projection_cutover_states (
            knowledge_base_id, writer_mode, updated_at
          ) VALUES (${knowledgeBaseId}, 'legacy', ${now})
          ON CONFLICT (knowledge_base_id) DO NOTHING
        `;
        const existing = await transaction<Array<{
          writer_mode: string;
          shadow_generation_public_id: string | null;
          shadow_expected_path_count: number | string | null;
          shadow_processed_path_count: number | string;
          shadow_cursor: string | null;
          revision: number | string;
        }>>`
          SELECT writer_mode, shadow_generation_public_id,
                 shadow_expected_path_count, shadow_processed_path_count,
                 shadow_cursor, revision
          FROM focowiki.projection_cutover_states
          WHERE knowledge_base_id = ${knowledgeBaseId}
          FOR UPDATE
        `;
        const state = existing[0]!;
        if (state.writer_mode === "shadow"
          && state.shadow_generation_public_id) {
          return mapDocumentPublicationShadowState(state);
        }
        if (state.writer_mode !== "legacy") {
          throw documentPublicationShadowError("SHADOW_WRITER_MODE_INVALID");
        }
        await backfillNonterminalDocumentPublicationFacts(
          transaction as unknown as DatabaseClient,
          knowledgeBaseId,
          now
        );
        const summary = await readDocumentPublicationShadowStartSummary(
          transaction as unknown as DatabaseClient,
          knowledgeBaseId);
        if (summary.unverifiedObjectCount > 0
          || summary.candidateGenerationCount > 0) {
          throw documentPublicationShadowError("SHADOW_PREFLIGHT_BLOCKED");
        }
        const head = await transaction<Array<{
          active_generation_public_id: string | null;
          head_version: number | string;
          active_fact_epoch: number | string;
        }>>`
          SELECT active_generation_public_id, head_version, active_fact_epoch
          FROM focowiki.knowledge_base_projection_heads
          WHERE knowledge_base_id = ${knowledgeBaseId}
          FOR UPDATE
        `;
        const generationIdentity = hashDocumentPublicationShadow([
          knowledgeBaseId,
          head[0]!.active_generation_public_id,
          Number(head[0]!.head_version),
          summary.targetFactEpoch,
          summary.activePathCount,
          Number(state.revision)
        ]);
        const generationPublicId = `projection-shadow-${generationIdentity}`;
        await transaction`
          INSERT INTO focowiki.projection_publication_generations (
            public_id, knowledge_base_id, base_generation_public_id,
            target_fact_epoch, renderer_contract_version,
            deterministic_changed_at, state, input_fingerprint_sha256,
            created_at, updated_at
          ) VALUES (
            ${generationPublicId}, ${knowledgeBaseId},
            ${head[0]!.active_generation_public_id},
            ${summary.targetFactEpoch},
            ${DOCUMENT_PUBLICATION_RENDERER_CONTRACT_VERSION}, ${now},
            'rendering', ${generationIdentity}, ${now}, ${now}
          )
        `;
        await transaction`
          UPDATE focowiki.projection_cutover_states
          SET writer_mode = 'shadow',
              shadow_generation_public_id = ${generationPublicId},
              shadow_cursor = NULL,
              shadow_expected_path_count = ${summary.activePathCount},
              shadow_processed_path_count = 0,
              shadow_target_fact_epoch = ${summary.targetFactEpoch},
              shadow_started_at = ${now}, shadow_completed_at = NULL,
              parity_cursor = NULL, parity_processed_path_count = 0,
              parity_expected_sha256 = NULL, parity_actual_sha256 = NULL,
              safe_error_code = NULL, revision = revision + 1,
              updated_at = ${now}
          WHERE knowledge_base_id = ${knowledgeBaseId}
        `;
        return {
          generationPublicId,
          expectedPathCount: summary.activePathCount,
          processedPathCount: 0,
          cursor: null,
          complete: summary.activePathCount === 0
        };
      });
    },

    async buildNextPage(input: Readonly<{
      knowledgeBaseId: string;
      now: string;
      limit: number;
    }>) {
      const knowledgeBaseId = assertRepositoryIdentity(
        input.knowledgeBaseId,
        "knowledge_base_id"
      );
      const now = assertRepositoryTimestamp(input.now, "now");
      const limit = assertRepositoryPositiveInteger(input.limit, "limit", 500);
      return sql.begin(async (transaction) => {
        const states = await transaction<Array<{
          writer_mode: string;
          shadow_generation_public_id: string | null;
          shadow_cursor: string | null;
          shadow_expected_path_count: number | string | null;
          shadow_processed_path_count: number | string;
        }>>`
          SELECT writer_mode, shadow_generation_public_id, shadow_cursor,
                 shadow_expected_path_count, shadow_processed_path_count
          FROM focowiki.projection_cutover_states
          WHERE knowledge_base_id = ${knowledgeBaseId}
          FOR UPDATE
        `;
        const state = states[0];
        if (!state || state.writer_mode !== "shadow"
          || !state.shadow_generation_public_id
          || state.shadow_expected_path_count === null) {
          throw documentPublicationShadowError("SHADOW_BUILD_NOT_STARTED");
        }
        const cursor = state.shadow_cursor ?? "";
        const rows = await transaction<DocumentPublicationShadowPageRow[]>`
          SELECT logical_path, normalized_path, entry_kind,
                 source_file_public_id, source_revision_public_id,
                 object_id, checksum_sha256, byte_count
          FROM focowiki.generated_page_heads
          WHERE knowledge_base_id = ${knowledgeBaseId}
            AND normalized_path COLLATE "C" > ${cursor} COLLATE "C"
          ORDER BY normalized_path COLLATE "C"
          LIMIT ${limit + 1}
        `;
        const hasMore = rows.length > limit;
        const page = rows.slice(0, limit);
        const owned = page.map((row) => {
          const candidate = inferDocumentPublicationOwnerCandidate({
            normalizedPath: row.normalized_path,
            sourceFilePublicId: row.source_file_public_id
          });
          if (!candidate) return null;
          const [scopeKind, ...keyParts] = candidate.scopeIdentity.split(":");
          return {
            row,
            candidate,
            scopeKind: scopeKind!,
            scopeKey: keyParts.join(":")
          };
        });
        if (owned.some((item) => item === null)) {
          await failDocumentPublicationShadow(
            transaction as unknown as DatabaseClient,
            {
            knowledgeBaseId,
            generationPublicId: state.shadow_generation_public_id,
            now,
            code: "shadow_path_owner_unresolved"
            }
          );
          return { state: "failed" as const, processedPathCount:
            Number(state.shadow_processed_path_count), cursor: state.shadow_cursor };
        }
        const groups = new Map<string, NonNullable<typeof owned[number]>[]>();
        for (const item of owned as NonNullable<typeof owned[number]>[]) {
          const current = groups.get(item.candidate.scopeIdentity) ?? [];
          current.push(item);
          groups.set(item.candidate.scopeIdentity, current);
        }
        for (const [scopeIdentity, items] of groups) {
          const first = items[0]!;
          const scopePublicId = `projection-shadow-scope-${hashDocumentPublicationShadow([
            state.shadow_generation_public_id, scopeIdentity
          ])}`;
          const prior = await transaction<Array<{ maximum: number | string }>>`
            SELECT coalesce(max(scope_generation), 0) AS maximum
            FROM focowiki.projection_scope_generations
            WHERE knowledge_base_id = ${knowledgeBaseId}
              AND scope_identity = ${scopeIdentity}
          `;
          await transaction`
            INSERT INTO focowiki.projection_scope_generations (
              public_id, publication_generation_public_id, knowledge_base_id,
              scope_identity, scope_kind, scope_key, scope_generation,
              state, input_snapshot_fingerprint_sha256, next_eligible_at,
              created_at, updated_at
            ) VALUES (
              ${scopePublicId}, ${state.shadow_generation_public_id},
              ${knowledgeBaseId}, ${scopeIdentity}, ${first.scopeKind},
              ${first.scopeKey}, ${Number(prior[0]!.maximum) + 1}, 'waiting',
              ${hashDocumentPublicationShadow([
                state.shadow_generation_public_id,
                scopeIdentity
              ])},
              ${now}, ${now}, ${now}
            ) ON CONFLICT (public_id) DO NOTHING
          `;
          const sourceRevisionPublicId = items.find((item) =>
            item.row.source_revision_public_id)?.row.source_revision_public_id;
          if (first.scopeKind === "source" && sourceRevisionPublicId) {
            await transaction`
              INSERT INTO focowiki.projection_scope_snapshot_members (
                scope_generation_public_id, member_kind, member_public_id,
                member_version, member_order, created_at
              ) VALUES (
                ${scopePublicId}, 'source_revision',
                ${sourceRevisionPublicId}, ${sourceRevisionPublicId}, 0, ${now}
              ) ON CONFLICT DO NOTHING
            `;
          }
          for (const item of items) {
            await transaction`
              INSERT INTO focowiki.projection_scope_generation_pages (
                scope_generation_public_id,
                publication_generation_public_id, owner_scope_identity,
                logical_path, normalized_path, action, entry_kind, object_id,
                checksum_sha256, byte_count, created_at
              ) VALUES (
                ${scopePublicId}, ${state.shadow_generation_public_id},
                ${scopeIdentity}, ${item.row.logical_path},
                ${item.row.normalized_path}, 'put', ${item.row.entry_kind},
                ${item.row.object_id}, ${item.row.checksum_sha256},
                ${Number(item.row.byte_count)}, ${now}
              ) ON CONFLICT (scope_generation_public_id, normalized_path)
                DO NOTHING
            `;
            await transaction`
              INSERT INTO focowiki.projection_scope_generation_object_refs (
                scope_generation_public_id, object_id, created_at
              ) VALUES (${scopePublicId}, ${item.row.object_id}, ${now})
              ON CONFLICT DO NOTHING
            `;
            const directoryPath = documentPublicationShadowOwnedDirectoryPath(
              item.row.normalized_path
            );
            if (directoryPath !== null) {
              await transaction`
                INSERT INTO focowiki.projection_generation_directory_claims (
                  publication_generation_public_id, directory_path,
                  scope_generation_public_id, owner_scope_identity, created_at
                ) VALUES (
                  ${state.shadow_generation_public_id}, ${directoryPath},
                  ${scopePublicId}, ${scopeIdentity}, ${now}
                ) ON CONFLICT (publication_generation_public_id, directory_path)
                  DO NOTHING
              `;
            }
          }
          const accumulators = await transaction<Array<{
            rolling_sha256: string;
            item_count: number | string;
          }>>`
            SELECT rolling_sha256, item_count
            FROM focowiki.projection_shadow_scope_accumulators
            WHERE scope_generation_public_id = ${scopePublicId}
            FOR UPDATE
          `;
          let rolling = accumulators[0]?.rolling_sha256 ?? EMPTY_SHADOW_SHA256;
          for (const item of items) {
            rolling = hashDocumentPublicationShadow([
              rolling,
              documentPublicationShadowPageIdentity(item.row)
            ]);
          }
          await transaction`
            INSERT INTO focowiki.projection_shadow_scope_accumulators (
              scope_generation_public_id, item_count, rolling_sha256, updated_at
            ) VALUES (
              ${scopePublicId},
              ${Number(accumulators[0]?.item_count ?? 0) + items.length},
              ${rolling}, ${now}
            ) ON CONFLICT (scope_generation_public_id) DO UPDATE
              SET item_count = excluded.item_count,
                  rolling_sha256 = excluded.rolling_sha256,
                  updated_at = excluded.updated_at
          `;
        }
        const nextCursor = hasMore ? page.at(-1)?.normalized_path ?? null : null;
        let continuation;
        try {
          continuation = decideDocumentPublicationShadowContinuation({
            expectedPathCount: Number(state.shadow_expected_path_count),
            processedPathCount: Number(state.shadow_processed_path_count),
            pageItemCount: page.length,
            nextCursor
          });
        } catch (error) {
          await failDocumentPublicationShadow(
            transaction as unknown as DatabaseClient,
            {
            knowledgeBaseId,
            generationPublicId: state.shadow_generation_public_id,
            now,
            code: safeDocumentPublicationShadowErrorCode(error)
            }
          );
          return { state: "failed" as const,
            processedPathCount: Number(state.shadow_processed_path_count),
            cursor: state.shadow_cursor };
        }
        const processedPathCount = Number(state.shadow_processed_path_count)
          + page.length;
        if (continuation.state === "complete") {
          await transaction`
            UPDATE focowiki.projection_scope_generations scope
            SET state = 'completed',
                output_fingerprint_sha256 = accumulator.rolling_sha256,
                validation_evidence = jsonb_build_object(
                  'shadowBootstrap', true,
                  'pageCount', accumulator.item_count
                ), completed_at = ${now}, updated_at = ${now}
            FROM focowiki.projection_shadow_scope_accumulators accumulator
            WHERE scope.publication_generation_public_id
                    = ${state.shadow_generation_public_id}
              AND accumulator.scope_generation_public_id = scope.public_id
              AND scope.state = 'waiting'
          `;
          await transaction`
            UPDATE focowiki.projection_publication_generations
            SET state = 'validating', updated_at = ${now}
            WHERE public_id = ${state.shadow_generation_public_id}
              AND state = 'rendering'
          `;
        }
        await transaction`
          UPDATE focowiki.projection_cutover_states
          SET shadow_cursor = ${continuation.nextCursor},
              shadow_processed_path_count = ${processedPathCount},
              shadow_completed_at = ${continuation.state === "complete"
                ? now : null},
              updated_at = ${now}
          WHERE knowledge_base_id = ${knowledgeBaseId}
        `;
        return {
          state: continuation.state,
          processedPathCount,
          cursor: continuation.nextCursor
        };
      });
    },

    async retryFailed(input: Readonly<{
      knowledgeBaseId: string;
      now: string;
    }>) {
      const knowledgeBaseId = assertRepositoryIdentity(
        input.knowledgeBaseId,
        "knowledge_base_id"
      );
      const now = assertRepositoryTimestamp(input.now, "now");
      const rows = await sql<Array<{ knowledge_base_id: string }>>`
        UPDATE focowiki.projection_cutover_states cutover
        SET shadow_generation_public_id = NULL, shadow_cursor = NULL,
            shadow_expected_path_count = NULL,
            shadow_processed_path_count = 0,
            shadow_target_fact_epoch = NULL, shadow_started_at = NULL,
            shadow_completed_at = NULL, parity_cursor = NULL,
            parity_processed_path_count = 0,
            parity_expected_sha256 = NULL, parity_actual_sha256 = NULL,
            safe_error_code = NULL, revision = revision + 1,
            updated_at = ${now}
        WHERE cutover.knowledge_base_id = ${knowledgeBaseId}
          AND cutover.writer_mode = 'legacy'
          AND cutover.safe_error_code IS NOT NULL
          AND EXISTS (
            SELECT 1
            FROM focowiki.projection_publication_generations generation
            WHERE generation.public_id
                    = cutover.shadow_generation_public_id
              AND generation.state = 'quarantined'
          )
        RETURNING knowledge_base_id
      `;
      return rows.length === 1;
    }
  };
}
