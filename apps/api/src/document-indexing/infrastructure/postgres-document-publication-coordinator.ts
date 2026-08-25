import { createHash } from "node:crypto";
import type { DatabaseClient } from "../../db/client.js";
import type { DocumentPublicationFactDelta } from "../application/document-publication-planner.js";
import { documentPublicationScopeMembers } from "../application/document-publication-snapshot-members.js";
import { selectReadyDocumentPublicationWindow } from "../application/document-publication-window.js";
import {
  assertRepositoryIdentity,
  assertRepositoryPositiveInteger,
  assertRepositoryTimestamp,
  repositoryContractError
} from "./document-repository-validation.js";
import { readRelatedSourceRevisionSnapshots } from
  "./postgres-document-publication-related-snapshots.js";
import { replacePostgresDocumentGenerationGraphDegrees } from
  "./postgres-document-generation-graph-degrees.js";
import { replacePostgresDocumentGenerationStatistics } from
  "./postgres-document-generation-statistics.js";
import { buildDocumentPublicationAffectedClosure } from
  "../application/document-publication-affected-closure.js";
import { createPostgresDocumentPublicationStrandedPlanReader } from
  "./postgres-document-publication-stranded-plan.js";
import { createPostgresDocumentPublicationGeneration } from
  "./postgres-document-publication-generation-identity.js";
export function createPostgresDocumentPublicationCoordinator(
  sql: DatabaseClient
) {
  const strandedPlans = createPostgresDocumentPublicationStrandedPlanReader(sql);
  return {
    ...strandedPlans,
    async freezeReady(input: {
      knowledgeBaseId: string;
      now: string;
      contributorCap: number;
      rendererContractVersion: string;
    }) {
      return sql.begin(async (transaction) => {
        const knowledgeBaseId = assertRepositoryIdentity(
          input.knowledgeBaseId,
          "knowledge_base_id"
        );
        const now = assertRepositoryTimestamp(input.now, "now");
        const contributorCap = assertRepositoryPositiveInteger(
          input.contributorCap,
          "contributor_cap",
          256
        );
        await transaction`
          INSERT INTO focowiki.knowledge_base_projection_heads (
            knowledge_base_id
          ) VALUES (${knowledgeBaseId})
          ON CONFLICT (knowledge_base_id) DO NOTHING
        `;
        const heads = await transaction<Array<{
          active_generation_public_id: string | null;
          head_version: number | string;
        }>>`
          SELECT active_generation_public_id, head_version
          FROM focowiki.knowledge_base_projection_heads
          WHERE knowledge_base_id = ${knowledgeBaseId}
          FOR UPDATE
        `;
        const activeCandidate = await transaction<Array<{ public_id: string }>>`
          SELECT public_id
          FROM focowiki.projection_publication_generations
          WHERE knowledge_base_id = ${knowledgeBaseId}
            AND state IN ('planned', 'rendering', 'validating', 'ready')
          LIMIT 1
        `;
        if (activeCandidate[0]) return null;
        const rows = await transaction<ReadyFactRow[]>`
          SELECT epoch.fact_epoch, epoch.mutation_public_id,
                 CASE WHEN epoch.fact_kind = 'delete' THEN NULL
                   ELSE epoch.mutation_public_id END AS document_job_public_id,
                 epoch.source_file_public_id,
                 epoch.source_revision_public_id, epoch.created_at
          FROM focowiki.projection_fact_epochs epoch
          LEFT JOIN focowiki.document_artifact_work work
            ON work.document_job_public_id = epoch.mutation_public_id
           AND work.work_kind = 'knowledge_projection'
          WHERE epoch.knowledge_base_id = ${knowledgeBaseId}
            AND epoch.state = 'ready'
            AND epoch.source_file_public_id IS NOT NULL
            AND epoch.source_revision_public_id IS NOT NULL
            AND (epoch.fact_kind = 'delete'
              OR work.state = 'waiting_on_projection')
          ORDER BY epoch.created_at, epoch.fact_epoch
          FOR UPDATE OF epoch SKIP LOCKED
          LIMIT ${contributorCap}
        `;
        const inFlightRows = await transaction<Array<{
          count: number | string;
        }>>`
          SELECT count(*) AS count
          FROM focowiki.document_artifact_work work
          JOIN focowiki.document_processing_jobs job
            ON job.public_id = work.document_job_public_id
           AND job.knowledge_base_id = work.knowledge_base_id
          WHERE work.knowledge_base_id = ${knowledgeBaseId}
            AND work.work_kind = 'knowledge_projection'
            AND work.state IN ('waiting', 'running')
            AND job.state = 'processing'
        `;
        const window = selectReadyDocumentPublicationWindow({
          documents: rows.map(mapReadyFact),
          now,
          contributorCap,
          inFlightDocumentCount: Number(inFlightRows[0]?.count ?? 0)
        });
        if (!window) return null;
        const head = heads[0]!;
        const identity = canonicalHash({
          knowledgeBaseId,
          base: head.active_generation_public_id,
          headVersion: Number(head.head_version),
          rendererContractVersion: input.rendererContractVersion,
          documents: window.documents.map((document) => [
            document.mutationPublicId,
            document.documentJobPublicId,
            document.sourceRevisionPublicId,
            document.factEpoch
          ])
        });
        const generationIdentity = await createPostgresDocumentPublicationGeneration(
          transaction as unknown as DatabaseClient,
          {
            knowledgeBaseId,
            baseGenerationPublicId: head.active_generation_public_id,
            targetFactEpoch: window.targetFactEpoch,
            rendererContractVersion: contractVersion(
              input.rendererContractVersion
            ),
            deterministicChangedAt: window.deterministicChangedAt,
            inputFingerprintSha256: identity,
            createdAt: now
          }
        );
        if (!generationIdentity) return null;
        const generationPublicId = generationIdentity.generationPublicId;
        await transaction`
          UPDATE focowiki.projection_publication_generations
          SET superseded_by_generation_public_id = ${generationPublicId},
              recovery_evidence = recovery_evidence || jsonb_build_object(
                'replacementGenerationPublicId', (${generationPublicId})::text,
                'replacementRendererContractVersion',
                  (${input.rendererContractVersion})::text,
                'outcome', 'minimum_replacement_planned'
              ),
              updated_at = ${now}
          WHERE knowledge_base_id = ${knowledgeBaseId}
            AND state = 'obsolete'
            AND superseded_by_generation_public_id IS NULL
            AND supersession_reason IN (
              'publication_renderer_contract_incompatible',
              'scope_generation_lease_lost'
            )
            AND target_fact_epoch <= ${window.targetFactEpoch}
        `;
        const documents = window.documents.map((document) => ({
          generation_public_id: generationPublicId,
          mutation_public_id: document.mutationPublicId,
          document_job_public_id: document.documentJobPublicId,
          source_file_public_id: document.sourceFilePublicId,
          source_revision_public_id: document.sourceRevisionPublicId,
          fact_epoch: document.factEpoch
        }));
        await transaction`
          INSERT INTO focowiki.projection_generation_documents (
            generation_public_id, mutation_public_id, document_job_public_id,
            source_file_public_id,
            source_revision_public_id, fact_epoch
          )
          SELECT generation_public_id, mutation_public_id,
                 document_job_public_id, source_file_public_id,
                 source_revision_public_id, fact_epoch
          FROM jsonb_to_recordset(${transaction.json(documents as never)}::jsonb)
            AS desired(
              generation_public_id text, mutation_public_id text,
              document_job_public_id text, source_file_public_id text,
              source_revision_public_id text, fact_epoch bigint
            )
        `;
        await transaction`
          UPDATE focowiki.projection_fact_epochs
          SET state = 'included'
          WHERE knowledge_base_id = ${knowledgeBaseId}
            AND mutation_public_id IN ${transaction(
              window.documents.map((item) => item.mutationPublicId)
            )}
            AND state = 'ready'
        `;
        return {
          generationPublicId,
          baseGenerationPublicId: head.active_generation_public_id,
          targetFactEpoch: window.targetFactEpoch,
          rendererContractVersion: input.rendererContractVersion,
          deterministicChangedAt: window.deterministicChangedAt,
          inputFingerprintSha256: identity,
          documents: window.documents
        };
      });
    },

    async persistPlan(input: {
      generationPublicId: string;
      documents: readonly DocumentPublicationFactDelta[];
      scopes: readonly Readonly<{
        identity: string;
        kind: "source" | "relation" | "directory" | "graph"
          | "_index" | "_graph" | "root" | "validation";
        key: string;
        dependsOn: readonly string[];
      }>[];
      ownerReservations: readonly Readonly<{
        family: "source" | "relation" | "search" | "page" | "directory"
          | "job" | "receipt" | "outbox";
        key: string;
      }>[];
      createdAt: string;
    }): Promise<number> {
      if (input.scopes.length < 1 || input.scopes.length > 10_000) {
        throw repositoryContractError("publication_scope_plan_limit");
      }
      if (input.ownerReservations.length > 50_000) {
        throw repositoryContractError("publication_owner_reservation_limit");
      }
      return sql.begin(async (transaction) => {
        const generations = await transaction<Array<{
          knowledge_base_id: string;
          input_fingerprint_sha256: string;
          base_generation_public_id: string | null;
        }>>`
          SELECT knowledge_base_id, input_fingerprint_sha256,
                 base_generation_public_id
          FROM focowiki.projection_publication_generations
          WHERE public_id = ${assertRepositoryIdentity(
            input.generationPublicId,
            "generation_public_id"
          )} AND state = 'planned'
          FOR UPDATE
        `;
        const generation = generations[0];
        if (!generation) {
          throw repositoryContractError("publication_generation_not_plannable");
        }
        const planningMode = input.documents.every((document) =>
          document.operation === "repair") ? "repair"
          : generation.base_generation_public_id === null ? "initial" : "delta";
        const affectedClosure = buildDocumentPublicationAffectedClosure({
          planningMode,
          documents: input.documents
        });
        await transaction`
          UPDATE focowiki.projection_publication_generations
          SET planning_mode = ${planningMode},
              affected_closure_fingerprint_sha256 =
                ${affectedClosure.fingerprintSha256},
              full_rebuild_reason = ${planningMode === "initial"
                ? "empty_knowledge_base"
                : planningMode === "repair" ? "explicit_repair" : null},
              updated_at = ${input.createdAt}
          WHERE public_id = ${input.generationPublicId}
            AND state = 'planned'
        `;
        if (affectedClosure.members.length > 0) {
          const affectedMembers = affectedClosure.members.map((member) => ({
            publication_generation_public_id: input.generationPublicId,
            knowledge_base_id: generation.knowledge_base_id,
            member_kind: member.kind,
            member_public_id: member.publicId,
            source_file_public_id: member.sourceFilePublicId,
            member_order: member.order,
            created_at: input.createdAt
          }));
          await transaction`
            INSERT INTO focowiki.projection_generation_affected_members (
              publication_generation_public_id, knowledge_base_id,
              member_kind, member_public_id, source_file_public_id,
              member_order, created_at
            )
            SELECT publication_generation_public_id, knowledge_base_id,
                   member_kind, member_public_id, source_file_public_id,
                   member_order, created_at
            FROM jsonb_to_recordset(
              ${transaction.json(affectedMembers as never)}::jsonb
            ) AS desired(
              publication_generation_public_id text, knowledge_base_id text,
              member_kind text, member_public_id text,
              source_file_public_id text, member_order integer,
              created_at timestamptz
            )
          `;
        }
        const priorRows = await transaction<Array<{
          scope_identity: string;
          maximum_generation: number | string | null;
        }>>`
          SELECT desired.scope_identity,
                 max(existing.scope_generation) AS maximum_generation
          FROM unnest(${input.scopes.map((scope) => scope.identity)}::text[])
            desired(scope_identity)
          LEFT JOIN focowiki.projection_scope_generations existing
            ON existing.knowledge_base_id = ${generation.knowledge_base_id}
           AND existing.scope_identity = desired.scope_identity
          GROUP BY desired.scope_identity
        `;
        const sourceRevisionSnapshots = await readRelatedSourceRevisionSnapshots(
          transaction as unknown as DatabaseClient, {
            knowledgeBaseId: generation.knowledge_base_id,
            scopes: input.scopes,
            documents: input.documents
          });
        const membersByScopeIdentity = new Map(input.scopes.map((scope) => [
          scope.identity,
          documentPublicationScopeMembers({
            scope,
            documents: input.documents,
            activeSourceRevisions: sourceRevisionSnapshots
          })
        ]));
        if (input.ownerReservations.length > 0) {
          const reservations = input.ownerReservations.map((reservation) => ({
            generation_public_id: input.generationPublicId,
            knowledge_base_id: generation.knowledge_base_id,
            owner_family: reservation.family,
            owner_key: reservation.key,
            created_at: assertRepositoryTimestamp(
              input.createdAt,
              "created_at"
            )
          }));
          const reserved = await transaction<Array<{ owner_key: string }>>`
            INSERT INTO focowiki.projection_activation_owner_reservations (
              generation_public_id, knowledge_base_id, owner_family,
              owner_key, created_at
            )
            SELECT generation_public_id, knowledge_base_id, owner_family,
                   owner_key, created_at
            FROM jsonb_to_recordset(${transaction.json(reservations as never)}::jsonb)
              AS desired(
                generation_public_id text, knowledge_base_id text,
                owner_family text, owner_key text, created_at timestamptz
              )
            ON CONFLICT (generation_public_id, owner_family, owner_key)
            DO UPDATE SET owner_key = excluded.owner_key
            RETURNING owner_key
          `;
          if (reserved.length !== reservations.length) {
            throw repositoryContractError("publication_owner_reservation_conflict");
          }
        }
        const prior = new Map(priorRows.map((row) => [
          row.scope_identity,
          Number(row.maximum_generation ?? 0)
        ]));
        const records = input.scopes.map((scope) => ({
          public_id: scopePublicId(input.generationPublicId, scope.identity),
          publication_generation_public_id: input.generationPublicId,
          knowledge_base_id: generation.knowledge_base_id,
          scope_identity: scope.identity,
          scope_kind: scope.kind,
          scope_key: scope.key,
          scope_generation: (prior.get(scope.identity) ?? 0) + 1,
          input_snapshot_fingerprint_sha256: canonicalHash({
            generation: generation.input_fingerprint_sha256,
            scope: scope.identity,
            members: membersByScopeIdentity.get(scope.identity) ?? []
          }),
          created_at: assertRepositoryTimestamp(input.createdAt, "created_at")
        }));
        await transaction`
          INSERT INTO focowiki.projection_scope_generations (
            public_id, publication_generation_public_id, knowledge_base_id,
            scope_identity, scope_kind, scope_key, scope_generation,
            input_snapshot_fingerprint_sha256, next_eligible_at, created_at, updated_at
          )
          SELECT public_id, publication_generation_public_id,
                 knowledge_base_id, scope_identity, scope_kind, scope_key,
                 scope_generation, input_snapshot_fingerprint_sha256,
                 created_at, created_at, created_at
          FROM jsonb_to_recordset(${transaction.json(records as never)}::jsonb)
            AS desired(
              public_id text, publication_generation_public_id text,
              knowledge_base_id text, scope_identity text, scope_kind text,
              scope_key text, scope_generation bigint,
              input_snapshot_fingerprint_sha256 text,
              created_at timestamptz
            )
        `;
        const publicIdByIdentity = new Map(records.map((record) => [
          record.scope_identity,
          record.public_id
        ]));
        const members = input.scopes.flatMap((scope) =>
          (membersByScopeIdentity.get(scope.identity) ?? [])
            .map((member) => ({
              scope_generation_public_id: publicIdByIdentity.get(scope.identity)!,
              member_kind: member.kind,
              member_public_id: member.publicId,
              member_version: member.version,
              member_order: member.order
            })));
        if (members.length > 0) {
          await transaction`
            INSERT INTO focowiki.projection_scope_snapshot_members (
              scope_generation_public_id, member_kind, member_public_id,
              member_version, member_order
            )
            SELECT scope_generation_public_id, member_kind, member_public_id,
                   member_version, member_order
            FROM jsonb_to_recordset(${transaction.json(members as never)}::jsonb)
              AS desired(
                scope_generation_public_id text, member_kind text,
                member_public_id text, member_version text,
                member_order integer
              )
          `;
        }
        await replacePostgresDocumentGenerationGraphDegrees({
          transaction: transaction as unknown as DatabaseClient,
          generationPublicId: input.generationPublicId,
          knowledgeBaseId: generation.knowledge_base_id,
          documents: input.documents, createdAt: input.createdAt
        });
        await replacePostgresDocumentGenerationStatistics({
          transaction: transaction as unknown as DatabaseClient,
          generationPublicId: input.generationPublicId,
          baseGenerationPublicId: generation.base_generation_public_id,
          knowledgeBaseId: generation.knowledge_base_id,
          documents: input.documents,
          createdAt: input.createdAt
        });
        const dependencies = input.scopes.flatMap((scope) =>
          scope.dependsOn.map((dependency) => ({
            scope_generation_public_id: publicIdByIdentity.get(scope.identity)!,
            depends_on_scope_generation_public_id:
              publicIdByIdentity.get(dependency)!
          })));
        if (dependencies.some((dependency) =>
          !dependency.depends_on_scope_generation_public_id)) {
          throw repositoryContractError("publication_scope_dependency_missing");
        }
        if (dependencies.length > 0) {
          await transaction`
            INSERT INTO focowiki.projection_scope_generation_dependencies (
              scope_generation_public_id,
              depends_on_scope_generation_public_id
            )
            SELECT scope_generation_public_id,
                   depends_on_scope_generation_public_id
            FROM jsonb_to_recordset(${transaction.json(dependencies as never)}::jsonb)
              AS desired(
                scope_generation_public_id text,
                depends_on_scope_generation_public_id text
              )
          `;
        }
        await transaction`
          UPDATE focowiki.projection_publication_generations
          SET state = 'rendering', updated_at = ${input.createdAt}
          WHERE public_id = ${input.generationPublicId}
        `;
        return records.length;
      }) as Promise<number>;
    }
  };
}
type ReadyFactRow = {
  fact_epoch: number | string; mutation_public_id: string;
  document_job_public_id: string | null; source_file_public_id: string;
  source_revision_public_id: string; created_at: Date | string;
};
function mapReadyFact(row: ReadyFactRow) {
  return {
    mutationPublicId: row.mutation_public_id,
    documentJobPublicId: row.document_job_public_id,
    sourceFilePublicId: row.source_file_public_id,
    sourceRevisionPublicId: row.source_revision_public_id,
    factEpoch: Number(row.fact_epoch),
    readyAt: new Date(row.created_at).toISOString()
  };
}
function scopePublicId(generationPublicId: string, identity: string): string {
  return `projection-scope-generation-${canonicalHash({
    generationPublicId,
    identity
  })}`;
}

function canonicalHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function contractVersion(value: string): string {
  if (!value || Buffer.byteLength(value, "utf8") > 128) {
    throw repositoryContractError("renderer_contract_version_invalid");
  }
  return value;
}
