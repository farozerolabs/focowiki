import type { TransactionSql } from "postgres";
import type { DatabaseClient } from "../../db/client.js";
import type { SemanticFactRepositoryPort } from "../application/ports.js";
import type {
  SemanticAffectedClosure,
  SemanticEntity
} from "../domain/contracts.js";
import {
  assertSemanticDesiredFactSet,
  assertSemanticSourceExtractionManifest
} from "../domain/validation.js";
import { replaceSemanticSourceFacts } from "./postgres-fact-writes.js";
import {
  buildSemanticAffectedClosure,
  capturePriorSemanticSourceFacts,
  replaceSemanticReverseReferences
} from "./postgres-fact-closure.js";

type EntityRow = {
  public_id: string;
  canonical_key: string;
  entity_kind: string;
  label: string;
  description: string | null;
  extraction_contract_version: string;
  confidence: number | string;
  provenance_kind: "deterministic" | "model";
  revision: number | string;
};

export class SemanticFactRepositoryError extends Error {
  public constructor(public readonly code: "invalid_cursor" | "invalid_input" | "scope_conflict") {
    super(`Semantic fact repository error: ${code}`);
    this.name = "SemanticFactRepositoryError";
  }
}

export function createPostgresSemanticFactRepository(
  sql: DatabaseClient
): SemanticFactRepositoryPort {
  return {
    async replaceSourceFacts(input, manifest) {
      assertSemanticDesiredFactSet(input);
      assertSemanticSourceExtractionManifest(manifest);
      return sql.begin(async (transaction) => {
        await lockCandidateAndSource(transaction, input);
        const prior = await capturePriorSemanticSourceFacts(transaction, input);
        await replaceSemanticSourceFacts(transaction, input, prior);
        await replaceSemanticReverseReferences(transaction, input);
        const closure = await buildSemanticAffectedClosure(transaction, input, prior);
        await transaction`
          INSERT INTO focowiki.semantic_source_reconciliations (
            knowledge_base_id, semantic_generation_public_id,
            source_file_public_id, source_revision_public_id,
            extraction_contract_version, canonical_input_sha256,
            skeleton_policy_version, skeleton_selected,
            source_chunk_count, selected_chunk_count, selection_reasons,
            selection_decision_sha256,
            entity_count, relationship_count, evidence_count,
            affected_closure, reconciled_at
          ) VALUES (
            ${input.knowledgeBaseId}, ${input.semanticGenerationPublicId},
            ${input.sourceFilePublicId}, ${input.sourceRevisionPublicId},
            ${manifest.extractionContractVersion}, ${manifest.canonicalInputSha256},
            ${manifest.skeletonPolicyVersion}, ${manifest.skeletonSelected},
            ${manifest.sourceChunkCount}, ${manifest.selectedChunkCount},
            ${transaction.json(manifest.selectionReasons as never)},
            ${manifest.selectionDecisionSha256},
            ${input.entities.length}, ${input.relationships.length},
            ${input.evidence.length}, ${transaction.json(closure as never)}, now()
          )
          ON CONFLICT (
            semantic_generation_public_id, source_file_public_id,
            source_revision_public_id
          )
          DO UPDATE SET
            extraction_contract_version = excluded.extraction_contract_version,
            canonical_input_sha256 = excluded.canonical_input_sha256,
            skeleton_policy_version = excluded.skeleton_policy_version,
            skeleton_selected = excluded.skeleton_selected,
            source_chunk_count = excluded.source_chunk_count,
            selected_chunk_count = excluded.selected_chunk_count,
            selection_reasons = excluded.selection_reasons,
            selection_decision_sha256 = excluded.selection_decision_sha256,
            entity_count = excluded.entity_count,
            relationship_count = excluded.relationship_count,
            evidence_count = excluded.evidence_count,
            affected_closure = excluded.affected_closure,
            reconciled_at = excluded.reconciled_at
          WHERE focowiki.semantic_source_reconciliations.knowledge_base_id
            = excluded.knowledge_base_id
        `;
        return closure;
      });
    },

    async hasSourceRevisionFacts(input) {
      const rows = await sql<Array<{ present: boolean }>>`
        SELECT EXISTS (
          SELECT 1
          FROM focowiki.semantic_source_reconciliations reconciliation
          JOIN focowiki.semantic_generations generation
            ON generation.knowledge_base_id = reconciliation.knowledge_base_id
           AND generation.public_id = reconciliation.semantic_generation_public_id
           AND generation.deleted_at IS NULL
          JOIN focowiki.source_files source
            ON source.knowledge_base_id = reconciliation.knowledge_base_id
           AND source.public_id = reconciliation.source_file_public_id
           AND source.deleted_at IS NULL
          WHERE reconciliation.knowledge_base_id = ${input.knowledgeBaseId}
            AND reconciliation.semantic_generation_public_id
              = ${input.semanticGenerationPublicId}
            AND reconciliation.source_file_public_id = ${input.sourceFilePublicId}
            AND reconciliation.source_revision_public_id
              = ${input.sourceRevisionPublicId}
            AND ${ownedSourceRevisionSql(sql, input)}
            AND (
              generation.generation_role = 'candidate'
                AND generation.state IN ('building', 'validating', 'ready')
              OR generation.generation_role = 'active'
                AND generation.state = 'active'
            )
        ) AS present
      `;
      return rows[0]?.present === true;
    },

    async listSourceEntityPublicIds(input) {
      const limit = assertLimit(input.limit, 2_000);
      const rows = await sql<Array<{ entity_public_id: string }>>`
        SELECT DISTINCT observation.entity_public_id COLLATE "C" AS entity_public_id
        FROM focowiki.semantic_entity_observations observation
        JOIN focowiki.semantic_entities entity
          ON entity.knowledge_base_id = observation.knowledge_base_id
         AND entity.semantic_generation_public_id
           = observation.semantic_generation_public_id
         AND entity.public_id = observation.entity_public_id
         AND entity.deleted_at IS NULL
        WHERE observation.knowledge_base_id = ${input.knowledgeBaseId}
          AND observation.semantic_generation_public_id
            = ${input.semanticGenerationPublicId}
          AND observation.source_file_public_id = ${input.sourceFilePublicId}
          AND observation.source_revision_public_id
            = ${input.sourceRevisionPublicId}
        ORDER BY entity_public_id
        LIMIT ${limit + 1}
      `;
      if (rows.length > limit) {
        throw new SemanticFactRepositoryError("invalid_input");
      }
      return rows.map((row) => row.entity_public_id);
    },

    async getSourceAffectedClosure(input) {
      const rows = await sql<Array<{ affected_closure: unknown }>>`
        SELECT reconciliation.affected_closure
        FROM focowiki.semantic_source_reconciliations reconciliation
        JOIN focowiki.semantic_generations generation
          ON generation.knowledge_base_id = reconciliation.knowledge_base_id
         AND generation.public_id = reconciliation.semantic_generation_public_id
         AND generation.deleted_at IS NULL
        WHERE reconciliation.knowledge_base_id = ${input.knowledgeBaseId}
          AND reconciliation.semantic_generation_public_id
            = ${input.semanticGenerationPublicId}
          AND reconciliation.source_file_public_id = ${input.sourceFilePublicId}
          AND reconciliation.source_revision_public_id
            = ${input.sourceRevisionPublicId}
          AND ${ownedSourceRevisionSql(sql, input)}
          AND (
            generation.generation_role = 'candidate'
              AND generation.state IN ('building', 'validating', 'ready')
            OR generation.generation_role = 'active'
              AND generation.state = 'active'
          )
        LIMIT 1
      `;
      return rows[0] ? parseAffectedClosure(rows[0].affected_closure, input) : null;
    },

    async listActiveEntities(input) {
      const limit = assertLimit(input.limit);
      const cursor = decodeCursor(input.cursor, input.knowledgeBaseId);
      const rows = await sql<EntityRow[]>`
        SELECT entity.public_id, entity.canonical_key, entity.entity_kind,
               entity.label, entity.description,
               entity.extraction_contract_version, entity.confidence,
               entity.provenance_kind, entity.revision
        FROM focowiki.semantic_generations generation
        JOIN focowiki.semantic_entities entity
          ON entity.knowledge_base_id = generation.knowledge_base_id
         AND entity.semantic_generation_public_id = generation.public_id
         AND entity.deleted_at IS NULL
        JOIN focowiki.knowledge_bases knowledge_base
          ON knowledge_base.public_id = generation.knowledge_base_id
         AND knowledge_base.deleted_at IS NULL
        WHERE generation.knowledge_base_id = ${input.knowledgeBaseId}
          AND generation.generation_role = 'active'
          AND generation.state = 'active'
          AND generation.deleted_at IS NULL
          AND EXISTS (
            SELECT 1
            FROM focowiki.semantic_entity_observations observation
            JOIN focowiki.source_files source
              ON source.knowledge_base_id = observation.knowledge_base_id
             AND source.public_id = observation.source_file_public_id
             AND source.deleted_at IS NULL
            JOIN focowiki.source_file_active_revisions active_revision
              ON active_revision.knowledge_base_id = observation.knowledge_base_id
             AND active_revision.source_file_public_id
               = observation.source_file_public_id
             AND active_revision.active_source_revision_public_id
               = observation.source_revision_public_id
            WHERE observation.knowledge_base_id = entity.knowledge_base_id
              AND observation.semantic_generation_public_id
                = entity.semantic_generation_public_id
              AND observation.entity_public_id = entity.public_id
          )
          AND (${cursor}::text IS NULL
            OR entity.public_id COLLATE "C" > ${cursor}::text COLLATE "C")
        ORDER BY entity.public_id COLLATE "C"
        LIMIT ${limit + 1}
      `;
      const pageRows = rows.slice(0, limit);
      const aliases = await readAliases(
        sql,
        input.knowledgeBaseId,
        pageRows.map((row) => row.public_id)
      );
      const last = pageRows.at(-1);
      return {
        items: pageRows.map((row) => mapEntity(row, aliases.get(row.public_id) ?? [])),
        nextCursor: rows.length > limit && last
          ? encodeCursor(input.knowledgeBaseId, last.public_id)
          : null
      };
    }
  };
}

async function lockCandidateAndSource(
  sql: TransactionSql,
  input: Parameters<SemanticFactRepositoryPort["replaceSourceFacts"]>[0]
): Promise<void> {
  const rows = await sql<Array<{ public_id: string }>>`
    SELECT generation.public_id
    FROM focowiki.semantic_generations generation
    JOIN focowiki.source_revisions revision
      ON revision.knowledge_base_id = generation.knowledge_base_id
     AND revision.source_file_public_id = ${input.sourceFilePublicId}
     AND revision.public_id = ${input.sourceRevisionPublicId}
    JOIN focowiki.source_files source
      ON source.knowledge_base_id = revision.knowledge_base_id
     AND source.public_id = revision.source_file_public_id
     AND source.deleted_at IS NULL
    WHERE generation.knowledge_base_id = ${input.knowledgeBaseId}
      AND generation.public_id = ${input.semanticGenerationPublicId}
      AND ${ownedSourceRevisionSql(sql, input)}
      AND (
        generation.generation_role = 'candidate'
          AND generation.state IN ('building', 'validating')
        OR generation.generation_role = 'active'
          AND generation.state = 'active'
      )
      AND generation.deleted_at IS NULL
    FOR UPDATE OF generation
  `;
  if (!rows[0]) throw new SemanticFactRepositoryError("scope_conflict");
}

function ownedSourceRevisionSql(
  sql: DatabaseClient | TransactionSql,
  input: {
    knowledgeBaseId: string;
    semanticGenerationPublicId: string;
    sourceFilePublicId: string;
    sourceRevisionPublicId: string;
  }
) {
  return sql`
    (
      EXISTS (
        SELECT 1
        FROM focowiki.source_file_active_revisions active_revision
        WHERE active_revision.knowledge_base_id = ${input.knowledgeBaseId}
          AND active_revision.source_file_public_id = ${input.sourceFilePublicId}
          AND active_revision.current_source_revision_public_id
            = ${input.sourceRevisionPublicId}
      )
    )
  `;
}

async function readAliases(
  sql: DatabaseClient,
  knowledgeBaseId: string,
  entityPublicIds: readonly string[]
): Promise<Map<string, string[]>> {
  if (entityPublicIds.length === 0) return new Map();
  const rows = await sql<Array<{
    entity_public_id: string;
    display_alias: string;
  }>>`
    SELECT alias.entity_public_id, alias.display_alias
    FROM focowiki.semantic_entity_aliases alias
    JOIN focowiki.semantic_generations generation
      ON generation.knowledge_base_id = alias.knowledge_base_id
     AND generation.public_id = alias.semantic_generation_public_id
     AND generation.generation_role = 'active'
     AND generation.state = 'active'
     AND generation.deleted_at IS NULL
    WHERE alias.knowledge_base_id = ${knowledgeBaseId}
      AND alias.entity_public_id = ANY(${entityPublicIds})
    ORDER BY alias.entity_public_id COLLATE "C", alias.normalized_alias COLLATE "C"
  `;
  const result = new Map<string, string[]>();
  for (const row of rows) {
    const values = result.get(row.entity_public_id) ?? [];
    values.push(row.display_alias);
    result.set(row.entity_public_id, values);
  }
  return result;
}

function mapEntity(row: EntityRow, aliases: readonly string[]): SemanticEntity {
  return {
    publicId: row.public_id,
    canonicalKey: row.canonical_key,
    kind: row.entity_kind,
    label: row.label,
    description: row.description,
    aliases,
    extractionContractVersion: row.extraction_contract_version,
    confidence: Number(row.confidence),
    provenance: row.provenance_kind,
    revision: Number(row.revision)
  };
}

function assertLimit(value: number, maximum = 1_000): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new SemanticFactRepositoryError("invalid_input");
  }
  return value;
}

function parseAffectedClosure(
  value: unknown,
  scope: {
    knowledgeBaseId: string;
    sourceFilePublicId: string;
    sourceRevisionPublicId: string;
  }
): SemanticAffectedClosure {
  if (!isRecord(value) || value.knowledgeBaseId !== scope.knowledgeBaseId) {
    throw new SemanticFactRepositoryError("invalid_input");
  }
  const fields = [
    "sourceFilePublicIds", "sourceRevisionPublicIds", "entityPublicIds",
    "relationshipPublicIds", "evidencePublicIds", "reverseReferencePublicIds",
    "vectorOwnerPublicIds", "dirtyPartitionKeys", "affectedFileNeighborPublicIds",
    "generatedLogicalPaths", "graphShardPublicIds", "searchShardPublicIds"
  ] as const;
  const parsed = Object.fromEntries(fields.map((field) => [
    field,
    stringArray(value[field])
  ])) as unknown as Omit<SemanticAffectedClosure, "knowledgeBaseId">;
  if (!parsed.sourceFilePublicIds.includes(scope.sourceFilePublicId)
    || !parsed.sourceRevisionPublicIds.includes(scope.sourceRevisionPublicId)) {
    throw new SemanticFactRepositoryError("invalid_input");
  }
  return { knowledgeBaseId: scope.knowledgeBaseId, ...parsed };
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 100_000
    || value.some((item) => typeof item !== "string" || !item
      || Buffer.byteLength(item) > 4_096)) {
    throw new SemanticFactRepositoryError("invalid_input");
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function encodeCursor(scope: string, publicId: string): string {
  return Buffer.from(JSON.stringify({ scope, publicId }), "utf8").toString("base64url");
}

function decodeCursor(value: string | null, scope: string): string | null {
  if (value === null) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as {
      scope?: unknown;
      publicId?: unknown;
    };
    if (parsed.scope !== scope || typeof parsed.publicId !== "string" || !parsed.publicId) {
      throw new Error("invalid");
    }
    return parsed.publicId;
  } catch {
    throw new SemanticFactRepositoryError("invalid_cursor");
  }
}
