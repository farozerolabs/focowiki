import { createHash, randomUUID } from "node:crypto";
import type { DatabaseClient } from "../../db/client.js";
import {
  assertRepositoryIdentity,
  assertRepositoryPositiveInteger,
  assertRepositorySha256,
  assertRepositoryTimestamp,
  repositoryContractError
} from "./document-repository-validation.js";

export const RELATION_EVIDENCE_KINDS = [
  "explicit_reference",
  "title_alias",
  "first_layer",
  "graphrag"
] as const;
export type RelationEvidenceKind = (typeof RELATION_EVIDENCE_KINDS)[number];

export type RelationPairState =
  | "waiting"
  | "running"
  | "resolved"
  | "ambiguous"
  | "pending_endpoint"
  | "retired";

export type RelationPairInput = {
  knowledgeBaseId: string;
  sourceFilePublicId: string;
  sourceRevisionPublicId: string;
  targetSourceFilePublicId: string;
  targetSourceRevisionPublicId: string;
  evidenceFingerprintSha256: string;
  nextEligibleAt: string;
};

export type CanonicalRelationPairInput = {
  knowledgeBaseId: string;
  firstSourceFilePublicId: string;
  firstSourceRevisionPublicId: string;
  secondSourceFilePublicId: string;
  secondSourceRevisionPublicId: string;
  evidenceFingerprintSha256: string;
  nextEligibleAt: string;
  state: "waiting";
};

export type ReusableRelationEvidence = {
  sourceFilePublicId: string;
  sourceRevisionPublicId: string;
  targetSourceFilePublicId: string;
  targetSourceRevisionPublicId: string;
  relationKind: "references" | "related";
  evidenceKind: RelationEvidenceKind;
  evidenceFingerprintSha256: string;
  evidence: Readonly<Record<string, unknown>>;
};

export function canonicalRelationPairInput(
  input: RelationPairInput
): CanonicalRelationPairInput {
  const sourceFilePublicId = assertRepositoryIdentity(
    input.sourceFilePublicId,
    "source_file_public_id"
  );
  const targetSourceFilePublicId = assertRepositoryIdentity(
    input.targetSourceFilePublicId,
    "target_source_file_public_id"
  );
  if (sourceFilePublicId === targetSourceFilePublicId) {
    throw repositoryContractError("relation_pair_self_reference");
  }
  const sourceFirst = sourceFilePublicId < targetSourceFilePublicId;
  return {
    knowledgeBaseId: assertRepositoryIdentity(input.knowledgeBaseId, "knowledge_base_id"),
    firstSourceFilePublicId: sourceFirst
      ? sourceFilePublicId : targetSourceFilePublicId,
    firstSourceRevisionPublicId: assertRepositoryIdentity(
      sourceFirst
        ? input.sourceRevisionPublicId : input.targetSourceRevisionPublicId,
      "first_source_revision_public_id"
    ),
    secondSourceFilePublicId: sourceFirst
      ? targetSourceFilePublicId : sourceFilePublicId,
    secondSourceRevisionPublicId: assertRepositoryIdentity(
      sourceFirst
        ? input.targetSourceRevisionPublicId : input.sourceRevisionPublicId,
      "second_source_revision_public_id"
    ),
    evidenceFingerprintSha256: assertRepositorySha256(
      input.evidenceFingerprintSha256,
      "evidence_fingerprint"
    ),
    nextEligibleAt: assertRepositoryTimestamp(input.nextEligibleAt, "next_eligible_at"),
    state: "waiting"
  };
}

export function createPostgresRelationPairRepository(sql: DatabaseClient) {
  return {
    async listActiveNeighborSourceFilePublicIds(input: {
      knowledgeBaseId: string;
      sourceFilePublicId: string;
      limit: number;
    }): Promise<readonly string[]> {
      const knowledgeBaseId = assertRepositoryIdentity(
        input.knowledgeBaseId,
        "knowledge_base_id"
      );
      const sourceFilePublicId = assertRepositoryIdentity(
        input.sourceFilePublicId,
        "source_file_public_id"
      );
      const limit = assertRepositoryPositiveInteger(input.limit, "limit", 1_024);
      const rows = await sql<Array<{ source_file_public_id: string }>>`
        SELECT neighbors.source_file_public_id
        FROM (
          SELECT DISTINCT CASE
            WHEN relation.first_source_file_public_id = ${sourceFilePublicId}
            THEN relation.second_source_file_public_id
            ELSE relation.first_source_file_public_id
          END AS source_file_public_id
          FROM focowiki.canonical_file_relations relation
          JOIN focowiki.source_file_active_revisions first_active
            ON first_active.knowledge_base_id = relation.knowledge_base_id
           AND first_active.source_file_public_id
             = relation.first_source_file_public_id
           AND first_active.active_source_revision_public_id
             = relation.first_source_revision_public_id
          JOIN focowiki.source_file_active_revisions second_active
            ON second_active.knowledge_base_id = relation.knowledge_base_id
           AND second_active.source_file_public_id
             = relation.second_source_file_public_id
           AND second_active.active_source_revision_public_id
             = relation.second_source_revision_public_id
          WHERE relation.knowledge_base_id = ${knowledgeBaseId}
            AND relation.active AND relation.retired_at IS NULL
            AND (relation.first_source_file_public_id = ${sourceFilePublicId}
              OR relation.second_source_file_public_id = ${sourceFilePublicId})
        ) neighbors
        ORDER BY neighbors.source_file_public_id COLLATE "C"
        LIMIT ${limit + 1}
      `;
      if (rows.length > limit) {
        throw repositoryContractError("active_relation_neighbor_limit_exceeded");
      }
      return rows.map((row) => row.source_file_public_id);
    },

    async enqueue(rawInput: RelationPairInput): Promise<string> {
      const input = canonicalRelationPairInput(rawInput);
      const identity = createHash("sha256").update(JSON.stringify([
        input.knowledgeBaseId,
        input.firstSourceRevisionPublicId,
        input.secondSourceRevisionPublicId
      ])).digest("hex");
      const rows = await sql<Array<{ public_id: string }>>`
        INSERT INTO focowiki.relation_candidate_pairs (
          public_id, knowledge_base_id,
          first_source_file_public_id, first_source_revision_public_id,
          second_source_file_public_id, second_source_revision_public_id,
          evidence_fingerprint_sha256, state, next_eligible_at
        ) VALUES (
          ${`relation-pair-${identity}`}, ${input.knowledgeBaseId},
          ${input.firstSourceFilePublicId}, ${input.firstSourceRevisionPublicId},
          ${input.secondSourceFilePublicId}, ${input.secondSourceRevisionPublicId},
          ${input.evidenceFingerprintSha256}, 'waiting', ${input.nextEligibleAt}
        )
        ON CONFLICT (
          knowledge_base_id, first_source_revision_public_id,
          second_source_revision_public_id
        ) DO UPDATE SET
          state = CASE
            WHEN relation_candidate_pairs.state = 'retired' THEN 'waiting'
            ELSE relation_candidate_pairs.state
          END,
          evidence_fingerprint_sha256 = least(
            relation_candidate_pairs.evidence_fingerprint_sha256,
            excluded.evidence_fingerprint_sha256
          ),
          next_eligible_at = least(
            relation_candidate_pairs.next_eligible_at,
            excluded.next_eligible_at
          ),
          updated_at = now()
        RETURNING public_id
      `;
      return rows[0]!.public_id;
    },

    async addEvidence(input: {
      knowledgeBaseId: string;
      pairPublicId: string;
      sourceFilePublicId: string;
      sourceRevisionPublicId: string;
      targetSourceFilePublicId: string;
      targetSourceRevisionPublicId: string;
      evidenceKind: RelationEvidenceKind;
      evidenceFingerprintSha256: string;
      evidence: Readonly<Record<string, unknown>>;
    }): Promise<string> {
      if (!RELATION_EVIDENCE_KINDS.includes(input.evidenceKind)) {
        throw repositoryContractError("invalid_evidence_kind");
      }
      if (Buffer.byteLength(JSON.stringify(input.evidence), "utf8") > 65_536) {
        throw repositoryContractError("invalid_evidence");
      }
      const evidencePublicId = `relation-evidence-${randomUUID()}`;
      const rows = await sql<Array<{ public_id: string }>>`
        INSERT INTO focowiki.relation_directed_evidence (
          public_id, knowledge_base_id, pair_public_id,
          source_file_public_id, source_revision_public_id,
          target_source_file_public_id, target_source_revision_public_id,
          evidence_kind, evidence_fingerprint_sha256, evidence, active
        ) VALUES (
          ${evidencePublicId},
          ${assertRepositoryIdentity(input.knowledgeBaseId, "knowledge_base_id")},
          ${assertRepositoryIdentity(input.pairPublicId, "pair_public_id")},
          ${assertRepositoryIdentity(input.sourceFilePublicId, "source_file_public_id")},
          ${assertRepositoryIdentity(input.sourceRevisionPublicId, "source_revision_public_id")},
          ${assertRepositoryIdentity(input.targetSourceFilePublicId, "target_source_file_public_id")},
          ${assertRepositoryIdentity(input.targetSourceRevisionPublicId, "target_source_revision_public_id")},
          ${input.evidenceKind},
          ${assertRepositorySha256(input.evidenceFingerprintSha256, "evidence_fingerprint")},
          ${sql.json(input.evidence as never)}, false
        )
        ON CONFLICT (
          knowledge_base_id, pair_public_id, source_revision_public_id,
          target_source_revision_public_id, evidence_fingerprint_sha256
        ) DO UPDATE SET evidence = excluded.evidence,
          evidence_kind = excluded.evidence_kind, retired_at = NULL
        RETURNING public_id
      `;
      return rows[0]!.public_id;
    },

    async listReusableEvidence(input: {
      knowledgeBaseId: string;
      sourceFilePublicId: string;
      priorSourceRevisionPublicId: string;
      currentSourceRevisionPublicId: string;
      limit: number;
    }): Promise<readonly ReusableRelationEvidence[]> {
      const knowledgeBaseId = assertRepositoryIdentity(
        input.knowledgeBaseId,
        "knowledge_base_id"
      );
      const sourceFilePublicId = assertRepositoryIdentity(
        input.sourceFilePublicId,
        "source_file_public_id"
      );
      const priorSourceRevisionPublicId = assertRepositoryIdentity(
        input.priorSourceRevisionPublicId,
        "prior_source_revision_public_id"
      );
      const currentSourceRevisionPublicId = assertRepositoryIdentity(
        input.currentSourceRevisionPublicId,
        "current_source_revision_public_id"
      );
      const limit = assertRepositoryPositiveInteger(input.limit, "limit", 1_024);
      const rows = await sql<Array<{
        source_file_public_id: string;
        source_revision_public_id: string;
        target_source_file_public_id: string;
        target_source_revision_public_id: string;
        relation_kind: "references" | "related";
        evidence_kind: RelationEvidenceKind;
        evidence_fingerprint_sha256: string;
        evidence: Readonly<Record<string, unknown>>;
      }>>`
        SELECT evidence.source_file_public_id,
               CASE WHEN evidence.source_file_public_id = ${sourceFilePublicId}
                 THEN ${currentSourceRevisionPublicId}
                 ELSE evidence.source_revision_public_id
               END AS source_revision_public_id,
               evidence.target_source_file_public_id,
               CASE WHEN evidence.target_source_file_public_id = ${sourceFilePublicId}
                 THEN ${currentSourceRevisionPublicId}
                 ELSE evidence.target_source_revision_public_id
               END AS target_source_revision_public_id,
               relation.relation_kind, evidence.evidence_kind,
               evidence.evidence_fingerprint_sha256, evidence.evidence
        FROM focowiki.canonical_file_relations relation
        JOIN focowiki.relation_directed_evidence evidence
          ON evidence.knowledge_base_id = relation.knowledge_base_id
         AND evidence.pair_public_id = relation.pair_public_id
         AND evidence.active AND evidence.retired_at IS NULL
        WHERE relation.knowledge_base_id = ${knowledgeBaseId}
          AND relation.active AND relation.retired_at IS NULL
          AND evidence.evidence_kind IN ('title_alias', 'first_layer', 'graphrag')
          AND (
            (relation.first_source_file_public_id = ${sourceFilePublicId}
              AND relation.first_source_revision_public_id
                = ${priorSourceRevisionPublicId}
              AND EXISTS (
                SELECT 1 FROM focowiki.source_file_active_revisions active
                WHERE active.knowledge_base_id = relation.knowledge_base_id
                  AND active.source_file_public_id
                    = relation.second_source_file_public_id
                  AND active.active_source_revision_public_id
                    = relation.second_source_revision_public_id
              ))
            OR
            (relation.second_source_file_public_id = ${sourceFilePublicId}
              AND relation.second_source_revision_public_id
                = ${priorSourceRevisionPublicId}
              AND EXISTS (
                SELECT 1 FROM focowiki.source_file_active_revisions active
                WHERE active.knowledge_base_id = relation.knowledge_base_id
                  AND active.source_file_public_id
                    = relation.first_source_file_public_id
                  AND active.active_source_revision_public_id
                    = relation.first_source_revision_public_id
              ))
          )
        ORDER BY relation.public_id COLLATE "C", evidence.public_id COLLATE "C"
        LIMIT ${limit + 1}
      `;
      if (rows.length > limit) {
        throw repositoryContractError("reusable_relation_evidence_limit_exceeded");
      }
      return rows.map((row) => ({
        sourceFilePublicId: row.source_file_public_id,
        sourceRevisionPublicId: row.source_revision_public_id,
        targetSourceFilePublicId: row.target_source_file_public_id,
        targetSourceRevisionPublicId: row.target_source_revision_public_id,
        relationKind: row.relation_kind,
        evidenceKind: row.evidence_kind,
        evidenceFingerprintSha256: row.evidence_fingerprint_sha256,
        evidence: row.evidence
      }));
    },

    async claim(input: {
      workerId: string;
      now: string;
      leaseDurationMs: number;
      limit: number;
    }): Promise<readonly string[]> {
      const workerId = assertRepositoryIdentity(input.workerId, "worker_id");
      const now = assertRepositoryTimestamp(input.now, "now");
      const limit = assertRepositoryPositiveInteger(input.limit, "limit", 256);
      const leaseDurationMs = assertRepositoryPositiveInteger(
        input.leaseDurationMs,
        "lease_duration",
        300_000
      );
      const leaseExpiresAt = new Date(Date.parse(now) + leaseDurationMs).toISOString();
      const rows = await sql<Array<{ public_id: string }>>`
        WITH claimable AS (
          SELECT public_id
          FROM focowiki.relation_candidate_pairs
          WHERE state = 'waiting' AND next_eligible_at <= ${now}
          ORDER BY next_eligible_at, public_id
          FOR UPDATE SKIP LOCKED
          LIMIT ${limit}
        )
        UPDATE focowiki.relation_candidate_pairs pair
        SET state = 'running', lease_owner = ${workerId},
            lease_expires_at = ${leaseExpiresAt}, updated_at = ${now}
        FROM claimable
        WHERE pair.public_id = claimable.public_id
        RETURNING pair.public_id
      `;
      return rows.map((row) => row.public_id);
    },

    async resolve(input: {
      pairPublicId: string;
      workerId: string;
      state: "resolved" | "ambiguous" | "pending_endpoint";
      ambiguityReason: string | null;
      pendingEndpointSourceFilePublicId: string | null;
      now: string;
    }): Promise<boolean> {
      const rows = await sql<Array<{ public_id: string }>>`
        UPDATE focowiki.relation_candidate_pairs
        SET state = ${input.state}, ambiguity_reason = ${input.ambiguityReason},
            pending_endpoint_source_file_public_id = ${input.pendingEndpointSourceFilePublicId},
            lease_owner = NULL, lease_expires_at = NULL,
            updated_at = ${assertRepositoryTimestamp(input.now, "now")}
        WHERE public_id = ${assertRepositoryIdentity(input.pairPublicId, "pair_public_id")}
          AND state = 'running'
          AND lease_owner = ${assertRepositoryIdentity(input.workerId, "worker_id")}
        RETURNING public_id
      `;
      return rows.length === 1;
    },

    async stageCanonical(input: {
      pairPublicId: string;
      relationKind: "references" | "related";
      now: string;
    }): Promise<string> {
      const pairPublicId = assertRepositoryIdentity(
        input.pairPublicId,
        "pair_public_id"
      );
      const relationPublicId = `canonical-relation-${createHash("sha256")
        .update(JSON.stringify([pairPublicId]))
        .digest("hex")}`;
      const rows = await sql<Array<{ public_id: string }>>`
        WITH pair AS (
          UPDATE focowiki.relation_candidate_pairs
          SET state = 'resolved', ambiguity_reason = NULL,
              pending_endpoint_source_file_public_id = NULL,
              lease_owner = NULL, lease_expires_at = NULL,
              updated_at = ${assertRepositoryTimestamp(input.now, "now")}
          WHERE public_id = ${pairPublicId} AND state <> 'retired'
          RETURNING *
        ), directions AS (
          SELECT pair.*,
                 bool_or(evidence.source_file_public_id
                   = pair.first_source_file_public_id) AS first_to_second,
                 bool_or(evidence.source_file_public_id
                   = pair.second_source_file_public_id) AS second_to_first
          FROM pair
          JOIN focowiki.relation_directed_evidence evidence
            ON evidence.pair_public_id = pair.public_id
           AND evidence.retired_at IS NULL
          GROUP BY pair.public_id, pair.knowledge_base_id,
                   pair.first_source_file_public_id,
                   pair.first_source_revision_public_id,
                   pair.second_source_file_public_id,
                   pair.second_source_revision_public_id,
                   pair.evidence_fingerprint_sha256, pair.state,
                   pair.ambiguity_reason,
                   pair.pending_endpoint_source_file_public_id,
                   pair.next_eligible_at, pair.lease_owner,
                   pair.lease_expires_at, pair.created_at, pair.updated_at
        )
        INSERT INTO focowiki.canonical_file_relations (
          public_id, knowledge_base_id, pair_public_id,
          first_source_file_public_id, first_source_revision_public_id,
          second_source_file_public_id, second_source_revision_public_id,
          relation_kind, direction, active, created_at
        )
        SELECT ${relationPublicId}, knowledge_base_id, public_id,
               first_source_file_public_id, first_source_revision_public_id,
               second_source_file_public_id, second_source_revision_public_id,
               ${input.relationKind},
               CASE WHEN first_to_second AND second_to_first THEN 'bidirectional'
                    WHEN first_to_second THEN 'first_to_second'
                    ELSE 'second_to_first' END,
               false, ${input.now}
        FROM directions
        ON CONFLICT (
          knowledge_base_id, first_source_revision_public_id,
          second_source_revision_public_id
        ) DO UPDATE SET relation_kind = CASE
            WHEN canonical_file_relations.relation_kind = 'references'
              OR excluded.relation_kind = 'references'
            THEN 'references'
            ELSE 'related'
          END,
          direction = excluded.direction, retired_at = NULL
        RETURNING public_id
      `;
      if (!rows[0]) throw repositoryContractError("relation_pair_not_resolvable");
      return rows[0].public_id;
    },

    async retireRevision(input: {
      knowledgeBaseId: string;
      sourceRevisionPublicId: string;
      retiredAt: string;
    }): Promise<number> {
      const rows = await sql<Array<{ public_id: string }>>`
        UPDATE focowiki.relation_candidate_pairs
        SET state = 'retired', lease_owner = NULL, lease_expires_at = NULL,
            updated_at = ${assertRepositoryTimestamp(input.retiredAt, "retired_at")}
        WHERE knowledge_base_id = ${assertRepositoryIdentity(input.knowledgeBaseId, "knowledge_base_id")}
          AND (first_source_revision_public_id = ${assertRepositoryIdentity(input.sourceRevisionPublicId, "source_revision_public_id")}
            OR second_source_revision_public_id = ${input.sourceRevisionPublicId})
          AND state <> 'retired'
        RETURNING public_id
      `;
      return rows.length;
    }
  };
}
