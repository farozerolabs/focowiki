import { createHash } from "node:crypto";
import type { DatabaseClient } from "../../db/client.js";
import {
  decideDocumentPublicationShadowContinuation
} from "../application/document-publication-shadow-migration.js";
import {
  assertRepositoryIdentity,
  assertRepositoryPositiveInteger,
  assertRepositoryTimestamp
} from "./document-repository-validation.js";

const EMPTY_SHA256 = createHash("sha256").update("").digest("hex");
const PAGE_PARITY_CHECKS = [
  "stable_ids_revisions_paths_checksums_source_content",
  "tree_navigation_leaves",
  "graph_direction_and_counts",
  "machine_index_records",
  "links_and_public_reads"
] as const;

export function createPostgresDocumentPublicationShadowParity(
  sql: DatabaseClient
) {
  return {
    async compareNextPage(input: Readonly<{
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
        const states = await transaction<Array<ParityStateRow>>`
          SELECT writer_mode, shadow_generation_public_id,
                 shadow_expected_path_count, shadow_target_fact_epoch,
                 shadow_completed_at, parity_cursor,
                 parity_processed_path_count, parity_expected_sha256,
                 parity_actual_sha256
          FROM focowiki.projection_cutover_states
          WHERE knowledge_base_id = ${knowledgeBaseId}
          FOR UPDATE
        `;
        const state = states[0];
        if (!state || state.writer_mode !== "shadow"
          || !state.shadow_generation_public_id
          || state.shadow_expected_path_count === null
          || state.shadow_target_fact_epoch === null
          || state.shadow_completed_at === null) {
          throw parityError("SHADOW_PARITY_NOT_READY");
        }
        const cursor = state.parity_cursor ?? "";
        const activeRows = await transaction<ParityPageRow[]>`
          SELECT logical_path, normalized_path, entry_kind,
                 source_file_public_id, source_revision_public_id,
                 object_id, checksum_sha256, byte_count
          FROM focowiki.generated_page_heads
          WHERE knowledge_base_id = ${knowledgeBaseId}
            AND normalized_path COLLATE "C" > ${cursor} COLLATE "C"
          ORDER BY normalized_path COLLATE "C"
          LIMIT ${limit + 1}
        `;
        const hasMore = activeRows.length > limit;
        const activePage = activeRows.slice(0, limit);
        const paths = activePage.map((row) => row.normalized_path);
        const shadowRows = paths.length === 0 ? []
          : await transaction<ParityPageRow[]>`
              SELECT page.logical_path, page.normalized_path, page.entry_kind,
                     CASE WHEN scope.scope_kind = 'source'
                       THEN scope.scope_key ELSE NULL END source_file_public_id,
                     member.source_revision_public_id,
                     page.object_id, page.checksum_sha256, page.byte_count
              FROM focowiki.projection_scope_generation_pages page
              JOIN focowiki.projection_scope_generations scope
                ON scope.public_id = page.scope_generation_public_id
              LEFT JOIN LATERAL (
                SELECT snapshot.member_public_id source_revision_public_id
                FROM focowiki.projection_scope_snapshot_members snapshot
                WHERE snapshot.scope_generation_public_id = scope.public_id
                  AND snapshot.member_kind = 'source_revision'
                ORDER BY snapshot.member_order
                LIMIT 1
              ) member ON true
              WHERE page.publication_generation_public_id
                      = ${state.shadow_generation_public_id}
                AND page.action = 'put'
                AND page.normalized_path IN ${transaction(paths)}
              ORDER BY page.normalized_path COLLATE "C"
            `;
        const shadowByPath = new Map(shadowRows.map((row) => [
          row.normalized_path, row
        ]));
        const mismatch = activePage.find((active) => {
          const shadow = shadowByPath.get(active.normalized_path);
          return !shadow || pageIdentity(active) !== pageIdentity(shadow);
        });
        if (mismatch) {
          await recordParityFailure(transaction as unknown as DatabaseClient, {
            knowledgeBaseId,
            generationPublicId: state.shadow_generation_public_id,
            now,
            code: "shadow_page_parity_failed",
            expectedCount: activePage.length,
            actualCount: shadowRows.length
          });
          return { state: "failed" as const,
            processedPathCount: Number(state.parity_processed_path_count),
            cursor: state.parity_cursor };
        }
        let expectedHash = state.parity_expected_sha256 ?? EMPTY_SHA256;
        let actualHash = state.parity_actual_sha256 ?? EMPTY_SHA256;
        for (const active of activePage) {
          expectedHash = hash([expectedHash, pageIdentity(active)]);
          actualHash = hash([
            actualHash,
            pageIdentity(shadowByPath.get(active.normalized_path)!)
          ]);
        }
        const nextCursor = hasMore
          ? activePage.at(-1)?.normalized_path ?? null : null;
        let continuation;
        try {
          continuation = decideDocumentPublicationShadowContinuation({
            expectedPathCount: Number(state.shadow_expected_path_count),
            processedPathCount: Number(state.parity_processed_path_count),
            pageItemCount: activePage.length,
            nextCursor
          });
        } catch {
          await recordParityFailure(transaction as unknown as DatabaseClient, {
            knowledgeBaseId,
            generationPublicId: state.shadow_generation_public_id,
            now,
            code: "shadow_snapshot_drift",
            expectedCount: Number(state.shadow_expected_path_count),
            actualCount: Number(state.parity_processed_path_count)
              + activePage.length
          });
          return { state: "failed" as const,
            processedPathCount: Number(state.parity_processed_path_count),
            cursor: state.parity_cursor };
        }
        const processedPathCount = Number(state.parity_processed_path_count)
          + activePage.length;
        if (continuation.state === "complete") {
          const closure = await readClosureParity(
            transaction as unknown as DatabaseClient,
            knowledgeBaseId,
            state.shadow_generation_public_id
          );
          const currentTarget = closure.maximumFactEpoch;
          const passed = expectedHash === actualHash
            && closure.activePathCount === closure.shadowPathCount
            && closure.missingObjectReferenceCount === 0
            && closure.unverifiedObjectCount === 0
            && closure.searchOwnerMismatchCount === 0
            && currentTarget === Number(state.shadow_target_fact_epoch);
          if (!passed) {
            await recordParityFailure(
              transaction as unknown as DatabaseClient,
              {
                knowledgeBaseId,
                generationPublicId: state.shadow_generation_public_id,
                now,
                code: "shadow_closure_parity_failed",
                expectedCount: Number(state.shadow_expected_path_count),
                actualCount: closure.shadowPathCount
              }
            );
            return { state: "failed" as const, processedPathCount,
              cursor: continuation.nextCursor };
          }
          await persistPassedParity(transaction as unknown as DatabaseClient, {
            generationPublicId: state.shadow_generation_public_id,
            now,
            expectedHash,
            actualHash,
            pageCount: closure.activePathCount,
            objectCount: closure.referencedObjectCount,
            searchOwnerCount: closure.activeSearchOwnerCount
          });
        }
        await transaction`
          UPDATE focowiki.projection_cutover_states
          SET parity_cursor = ${continuation.nextCursor},
              parity_processed_path_count = ${processedPathCount},
              parity_expected_sha256 = ${expectedHash},
              parity_actual_sha256 = ${actualHash}, updated_at = ${now}
          WHERE knowledge_base_id = ${knowledgeBaseId}
        `;
        return { state: continuation.state, processedPathCount,
          cursor: continuation.nextCursor };
      });
    }
  };
}

type ParityStateRow = {
  writer_mode: string;
  shadow_generation_public_id: string | null;
  shadow_expected_path_count: number | string | null;
  shadow_target_fact_epoch: number | string | null;
  shadow_completed_at: Date | string | null;
  parity_cursor: string | null;
  parity_processed_path_count: number | string;
  parity_expected_sha256: string | null;
  parity_actual_sha256: string | null;
};

type ParityPageRow = {
  logical_path: string;
  normalized_path: string;
  entry_kind: string;
  source_file_public_id: string | null;
  source_revision_public_id: string | null;
  object_id: string;
  checksum_sha256: string;
  byte_count: number | string;
};

async function readClosureParity(
  sql: DatabaseClient,
  knowledgeBaseId: string,
  generationPublicId: string
) {
  const rows = await sql<Array<Record<string, number | string>>>`
    SELECT
      (SELECT count(*) FROM focowiki.generated_page_heads head
       WHERE head.knowledge_base_id = ${knowledgeBaseId}) active_path_count,
      (SELECT count(*) FROM focowiki.projection_scope_generation_pages page
       WHERE page.publication_generation_public_id = ${generationPublicId}
         AND page.action = 'put') shadow_path_count,
      (SELECT count(DISTINCT head.object_id)
       FROM focowiki.generated_page_heads head
       WHERE head.knowledge_base_id = ${knowledgeBaseId}) referenced_object_count,
      (SELECT count(*) FROM focowiki.projection_scope_generation_pages page
       WHERE page.publication_generation_public_id = ${generationPublicId}
         AND page.action = 'put' AND NOT EXISTS (
           SELECT 1 FROM focowiki.projection_scope_generation_object_refs ref
           WHERE ref.scope_generation_public_id
                   = page.scope_generation_public_id
             AND ref.object_id = page.object_id
         )) missing_object_reference_count,
      (SELECT count(*) FROM focowiki.generated_page_heads head
       LEFT JOIN focowiki.object_registrations object
         ON object.object_id = head.object_id
       WHERE head.knowledge_base_id = ${knowledgeBaseId}
         AND (object.object_id IS NULL OR object.state <> 'verified'))
        unverified_object_count,
      (SELECT count(*) FROM focowiki.search_document_owners owner
       WHERE owner.knowledge_base_id = ${knowledgeBaseId}
         AND owner.state = 'active') active_search_owner_count,
      (SELECT count(*) FROM focowiki.search_document_owners owner
       LEFT JOIN focowiki.source_file_active_revisions active
         ON active.knowledge_base_id = owner.knowledge_base_id
        AND active.source_file_public_id = owner.source_file_public_id
       WHERE owner.knowledge_base_id = ${knowledgeBaseId}
         AND owner.state = 'active'
         AND active.active_source_revision_public_id
               IS DISTINCT FROM owner.source_revision_public_id)
        search_owner_mismatch_count,
      (SELECT count(*) FROM focowiki.document_artifact_work work
       WHERE work.knowledge_base_id = ${knowledgeBaseId}
         AND work.state IN ('waiting', 'running', 'waiting_on_projection'))
        unfinished_work_count,
      (SELECT coalesce(max(fact_epoch), 0)
       FROM focowiki.projection_fact_epochs epoch
       WHERE epoch.knowledge_base_id = ${knowledgeBaseId}) maximum_fact_epoch
  `;
  const row = rows[0]!;
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [
    camel(key), Number(value)
  ])) as {
    activePathCount: number;
    shadowPathCount: number;
    referencedObjectCount: number;
    missingObjectReferenceCount: number;
    unverifiedObjectCount: number;
    activeSearchOwnerCount: number;
    searchOwnerMismatchCount: number;
    unfinishedWorkCount: number;
    maximumFactEpoch: number;
  };
}

async function persistPassedParity(sql: DatabaseClient, input: Readonly<{
  generationPublicId: string;
  now: string;
  expectedHash: string;
  actualHash: string;
  pageCount: number;
  objectCount: number;
  searchOwnerCount: number;
}>) {
  const checks = [
    ...PAGE_PARITY_CHECKS.map((checkName) => ({
      check_name: checkName,
      expected_count: input.pageCount,
      actual_count: input.pageCount,
      expected_sha256: input.expectedHash,
      actual_sha256: input.actualHash
    })),
    { check_name: "object_references", expected_count: input.objectCount,
      actual_count: input.objectCount, expected_sha256: null,
      actual_sha256: null },
    { check_name: "search_ownership", expected_count: input.searchOwnerCount,
      actual_count: input.searchOwnerCount, expected_sha256: null,
      actual_sha256: null }
  ];
  await sql`
    INSERT INTO focowiki.projection_shadow_parity_results (
      generation_public_id, check_name, state, expected_count, actual_count,
      expected_sha256, actual_sha256, checked_at
    ) SELECT ${input.generationPublicId}, desired.check_name, 'passed',
             desired.expected_count, desired.actual_count,
             desired.expected_sha256, desired.actual_sha256, ${input.now}
      FROM jsonb_to_recordset(${sql.json(checks as never)}::jsonb) desired(
        check_name text, expected_count bigint, actual_count bigint,
        expected_sha256 text, actual_sha256 text
      )
    ON CONFLICT (generation_public_id, check_name) DO UPDATE
      SET state = excluded.state, expected_count = excluded.expected_count,
          actual_count = excluded.actual_count,
          expected_sha256 = excluded.expected_sha256,
          actual_sha256 = excluded.actual_sha256,
          checked_at = excluded.checked_at
  `;
  await sql`
    INSERT INTO focowiki.projection_generation_validation_results (
      generation_public_id, check_name, state, checked_count,
      evidence_sha256, safe_detail, checked_at
    ) VALUES (
      ${input.generationPublicId}, 'coherent_generation', 'passed',
      ${input.pageCount}, ${input.actualHash},
      jsonb_build_object('shadowParity', true), ${input.now}
    ) ON CONFLICT (generation_public_id, check_name) DO UPDATE
      SET state = excluded.state, checked_count = excluded.checked_count,
          evidence_sha256 = excluded.evidence_sha256,
          safe_detail = excluded.safe_detail, checked_at = excluded.checked_at
  `;
  await sql`
    UPDATE focowiki.projection_publication_generations
    SET state = 'ready', output_fingerprint_sha256 = ${input.actualHash},
        updated_at = ${input.now}
    WHERE public_id = ${input.generationPublicId}
      AND state = 'validating'
  `;
}

async function recordParityFailure(sql: DatabaseClient, input: Readonly<{
  knowledgeBaseId: string;
  generationPublicId: string;
  now: string;
  code: string;
  expectedCount: number;
  actualCount: number;
}>) {
  await sql`
    INSERT INTO focowiki.projection_shadow_parity_results (
      generation_public_id, check_name, state, expected_count,
      actual_count, checked_at
    ) VALUES (
      ${input.generationPublicId}, 'coherent_generation', 'failed',
      ${input.expectedCount}, ${input.actualCount}, ${input.now}
    ) ON CONFLICT (generation_public_id, check_name) DO UPDATE
      SET state = 'failed', expected_count = excluded.expected_count,
          actual_count = excluded.actual_count, checked_at = excluded.checked_at
  `;
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

function pageIdentity(row: ParityPageRow): string {
  return JSON.stringify([row.normalized_path, row.logical_path, row.entry_kind,
    row.source_file_public_id, row.source_revision_public_id, row.object_id,
    row.checksum_sha256, Number(row.byte_count)]);
}

function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function camel(value: string): string {
  return value.replace(/_([a-z])/gu, (_, character: string) =>
    character.toUpperCase());
}

function parityError(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}
