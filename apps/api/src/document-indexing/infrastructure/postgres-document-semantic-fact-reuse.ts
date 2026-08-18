import type { DatabaseClient } from "../../db/client.js";
import type {
  SemanticDesiredFactSet,
  SemanticCommunity,
  SemanticCommunityReport,
  SemanticEntity,
  SemanticEvidence,
  SemanticMention,
  SemanticRelationship,
  SemanticSourceExtractionManifest
} from "../../semantic/domain/contracts.js";
import { rebaseDocumentSemanticFacts } from
  "../application/document-semantic-fact-reuse.js";

type ReconciliationRow = {
  source_revision_public_id: string;
  extraction_contract_version: string;
  canonical_input_sha256: string;
  skeleton_policy_version: string;
  skeleton_selected: boolean;
  source_chunk_count: number | string;
  selected_chunk_count: number | string;
  selection_reasons: unknown;
  selection_decision_sha256: string;
};

export function createPostgresDocumentSemanticFactReuse(sql: DatabaseClient) {
  return async (input: {
    knowledgeBaseId: string;
    semanticGenerationPublicId: string;
    sourceSemanticGenerationPublicId?: string;
    sourceFilePublicId: string;
    fromSourceRevisionPublicId?: string;
    toSourceRevisionPublicId: string;
    targetLogicalPath: string;
    semanticContractVersion: string;
  }): Promise<{
    facts: SemanticDesiredFactSet;
    manifest: SemanticSourceExtractionManifest;
  } | null> => {
    const requestedSourceRevisionPublicId = input.fromSourceRevisionPublicId ?? null;
    const reconciliations = await sql<ReconciliationRow[]>`
      SELECT reconciliation.source_revision_public_id,
             reconciliation.extraction_contract_version,
             reconciliation.canonical_input_sha256,
             reconciliation.skeleton_policy_version,
             reconciliation.skeleton_selected,
             reconciliation.source_chunk_count,
             reconciliation.selected_chunk_count,
             reconciliation.selection_reasons,
             reconciliation.selection_decision_sha256
      FROM focowiki.semantic_source_reconciliations reconciliation
      JOIN focowiki.source_file_active_revisions active
        ON active.knowledge_base_id = reconciliation.knowledge_base_id
       AND active.source_file_public_id = reconciliation.source_file_public_id
      JOIN focowiki.source_revisions source_revision
        ON source_revision.knowledge_base_id = reconciliation.knowledge_base_id
       AND source_revision.source_file_public_id
         = reconciliation.source_file_public_id
       AND source_revision.public_id = reconciliation.source_revision_public_id
       AND source_revision.deleted_at IS NULL
      JOIN focowiki.source_revisions target_revision
        ON target_revision.knowledge_base_id = reconciliation.knowledge_base_id
       AND target_revision.source_file_public_id
         = reconciliation.source_file_public_id
       AND target_revision.public_id = ${input.toSourceRevisionPublicId}
       AND target_revision.deleted_at IS NULL
      WHERE reconciliation.knowledge_base_id = ${input.knowledgeBaseId}
        AND reconciliation.semantic_generation_public_id
          = ${input.sourceSemanticGenerationPublicId
            ?? input.semanticGenerationPublicId}
        AND reconciliation.source_file_public_id = ${input.sourceFilePublicId}
        AND reconciliation.source_revision_public_id = coalesce(
          ${requestedSourceRevisionPublicId},
          active.active_source_revision_public_id
        )
        AND source_revision.checksum_sha256 = target_revision.checksum_sha256
        AND reconciliation.extraction_contract_version
          = ${input.semanticContractVersion}
        AND (
          reconciliation.source_revision_public_id = ${input.toSourceRevisionPublicId}
          OR active.active_source_revision_public_id
            = reconciliation.source_revision_public_id
        )
      LIMIT 1
    `;
    const reconciliation = reconciliations[0];
    if (!reconciliation) return null;
    const resolvedInput: ReuseInput = {
      ...input,
      fromSourceRevisionPublicId: reconciliation.source_revision_public_id
    };
    const [entities, evidence, mentions, relationships, communities] = await Promise.all([
      readEntities(sql, resolvedInput),
      readEvidence(sql, resolvedInput),
      readMentions(sql, resolvedInput),
      readRelationships(sql, resolvedInput),
      readCommunities(sql, resolvedInput)
    ]);
    const communityReports = await readCommunityReports(
      sql,
      resolvedInput,
      communities.map((item) => item.publicId)
    );
    const facts: SemanticDesiredFactSet = {
      knowledgeBaseId: input.knowledgeBaseId,
      semanticGenerationPublicId: input.semanticGenerationPublicId,
      sourceFilePublicId: input.sourceFilePublicId,
      sourceRevisionPublicId: resolvedInput.fromSourceRevisionPublicId,
      entities,
      evidence,
      mentions,
      relationships,
      communities,
      communityReports
    };
    return rebaseDocumentSemanticFacts({
      facts,
      manifest: {
        extractionContractVersion: reconciliation.extraction_contract_version,
        canonicalInputSha256: reconciliation.canonical_input_sha256,
        skeletonPolicyVersion: reconciliation.skeleton_policy_version,
        skeletonSelected: reconciliation.skeleton_selected,
        sourceChunkCount: count(reconciliation.source_chunk_count),
        selectedChunkCount: count(reconciliation.selected_chunk_count),
        selectionReasons: stringArray(reconciliation.selection_reasons),
        selectionDecisionSha256: reconciliation.selection_decision_sha256
      },
      targetSourceRevisionPublicId: input.toSourceRevisionPublicId,
      targetSemanticGenerationPublicId: input.semanticGenerationPublicId,
      targetLogicalPath: input.targetLogicalPath
    });
  };
}

async function readEntities(
  sql: DatabaseClient,
  input: ReuseInput
): Promise<SemanticEntity[]> {
  const rows = await sql<Array<{
    public_id: string; canonical_key: string; entity_kind: string;
    label: string; description: string | null; aliases: unknown;
    extraction_contract_version: string; confidence: number | string;
    provenance_kind: "deterministic" | "model"; revision: number | string;
  }>>`
    SELECT entity.public_id, entity.canonical_key, entity.entity_kind,
           observation.label, observation.description, observation.aliases,
           observation.extraction_contract_version, observation.confidence,
           observation.provenance_kind, entity.revision
    FROM focowiki.semantic_entity_observations observation
    JOIN focowiki.semantic_entities entity
      ON entity.knowledge_base_id = observation.knowledge_base_id
     AND entity.semantic_generation_public_id
       = observation.semantic_generation_public_id
     AND entity.public_id = observation.entity_public_id
     AND entity.deleted_at IS NULL
    WHERE observation.knowledge_base_id = ${input.knowledgeBaseId}
      AND observation.semantic_generation_public_id
        = ${input.sourceSemanticGenerationPublicId
          ?? input.semanticGenerationPublicId}
      AND observation.source_file_public_id = ${input.sourceFilePublicId}
      AND observation.source_revision_public_id
        = ${input.fromSourceRevisionPublicId}
    ORDER BY entity.public_id COLLATE "C"
  `;
  return rows.map((row) => ({
    publicId: row.public_id,
    canonicalKey: row.canonical_key,
    kind: row.entity_kind,
    label: row.label,
    description: row.description,
    aliases: aliasArray(row.aliases),
    extractionContractVersion: row.extraction_contract_version,
    confidence: Number(row.confidence),
    provenance: row.provenance_kind,
    revision: count(row.revision)
  }));
}

async function readEvidence(
  sql: DatabaseClient,
  input: ReuseInput
): Promise<SemanticEvidence[]> {
  const rows = await sql<Array<{
    public_id: string; source_file_public_id: string;
    source_revision_public_id: string; logical_path: string;
    start_offset: number | string; end_offset: number | string;
    excerpt_checksum_sha256: string; extraction_contract_version: string;
  }>>`
    SELECT public_id, source_file_public_id, source_revision_public_id,
           logical_path, start_offset, end_offset, excerpt_checksum_sha256,
           extraction_contract_version
    FROM focowiki.semantic_evidence
    WHERE knowledge_base_id = ${input.knowledgeBaseId}
      AND semantic_generation_public_id = ${input.sourceSemanticGenerationPublicId
        ?? input.semanticGenerationPublicId}
      AND source_file_public_id = ${input.sourceFilePublicId}
      AND source_revision_public_id = ${input.fromSourceRevisionPublicId}
    ORDER BY public_id COLLATE "C"
  `;
  return rows.map((row) => ({
    publicId: row.public_id,
    sourceFilePublicId: row.source_file_public_id,
    sourceRevisionPublicId: row.source_revision_public_id,
    logicalPath: row.logical_path,
    startOffset: count(row.start_offset),
    endOffset: count(row.end_offset),
    excerptChecksumSha256: row.excerpt_checksum_sha256,
    extractionContractVersion: row.extraction_contract_version
  }));
}

async function readMentions(
  sql: DatabaseClient,
  input: ReuseInput
): Promise<SemanticMention[]> {
  const rows = await sql<Array<{
    public_id: string; entity_public_id: string; evidence_public_id: string;
    source_file_public_id: string; source_revision_public_id: string;
    mention_text: string; confidence: number | string;
  }>>`
    SELECT public_id, entity_public_id, evidence_public_id,
           source_file_public_id, source_revision_public_id,
           mention_text, confidence
    FROM focowiki.semantic_mentions
    WHERE knowledge_base_id = ${input.knowledgeBaseId}
      AND semantic_generation_public_id = ${input.sourceSemanticGenerationPublicId
        ?? input.semanticGenerationPublicId}
      AND source_file_public_id = ${input.sourceFilePublicId}
      AND source_revision_public_id = ${input.fromSourceRevisionPublicId}
    ORDER BY public_id COLLATE "C"
  `;
  return rows.map((row) => ({
    publicId: row.public_id,
    entityPublicId: row.entity_public_id,
    evidencePublicId: row.evidence_public_id,
    sourceFilePublicId: row.source_file_public_id,
    sourceRevisionPublicId: row.source_revision_public_id,
    text: row.mention_text,
    confidence: Number(row.confidence)
  }));
}

async function readRelationships(
  sql: DatabaseClient,
  input: ReuseInput
): Promise<SemanticRelationship[]> {
  const rows = await sql<Array<{
    public_id: string; from_entity_public_id: string; to_entity_public_id: string;
    relationship_kind: string; description: string | null;
    confidence: number | string; provenance_kind: "deterministic" | "model";
    revision: number | string; evidence_public_ids: string[];
  }>>`
    SELECT relationship.public_id, relationship.from_entity_public_id,
           relationship.to_entity_public_id, relationship.relationship_kind,
           observation.description, observation.confidence,
           observation.provenance_kind, relationship.revision,
           coalesce(array_agg(evidence.public_id ORDER BY evidence.public_id)
             FILTER (WHERE evidence.public_id IS NOT NULL), '{}'::text[])
             AS evidence_public_ids
    FROM focowiki.semantic_relationship_observations observation
    JOIN focowiki.semantic_relationships relationship
      ON relationship.knowledge_base_id = observation.knowledge_base_id
     AND relationship.semantic_generation_public_id
       = observation.semantic_generation_public_id
     AND relationship.public_id = observation.relationship_public_id
     AND relationship.deleted_at IS NULL
    LEFT JOIN focowiki.semantic_relationship_evidence relationship_evidence
      ON relationship_evidence.knowledge_base_id = relationship.knowledge_base_id
     AND relationship_evidence.semantic_generation_public_id
       = relationship.semantic_generation_public_id
     AND relationship_evidence.relationship_public_id = relationship.public_id
    LEFT JOIN focowiki.semantic_evidence evidence
      ON evidence.knowledge_base_id = relationship_evidence.knowledge_base_id
     AND evidence.semantic_generation_public_id
       = relationship_evidence.semantic_generation_public_id
     AND evidence.public_id = relationship_evidence.evidence_public_id
     AND evidence.source_file_public_id = observation.source_file_public_id
     AND evidence.source_revision_public_id = observation.source_revision_public_id
    WHERE observation.knowledge_base_id = ${input.knowledgeBaseId}
      AND observation.semantic_generation_public_id
        = ${input.sourceSemanticGenerationPublicId
          ?? input.semanticGenerationPublicId}
      AND observation.source_file_public_id = ${input.sourceFilePublicId}
      AND observation.source_revision_public_id
        = ${input.fromSourceRevisionPublicId}
    GROUP BY relationship.public_id, relationship.from_entity_public_id,
             relationship.to_entity_public_id, relationship.relationship_kind,
             observation.description, observation.confidence,
             observation.provenance_kind, relationship.revision
    ORDER BY relationship.public_id COLLATE "C"
  `;
  return rows.map((row) => ({
    publicId: row.public_id,
    fromEntityPublicId: row.from_entity_public_id,
    toEntityPublicId: row.to_entity_public_id,
    kind: row.relationship_kind,
    description: row.description,
    evidencePublicIds: row.evidence_public_ids,
    confidence: Number(row.confidence),
    provenance: row.provenance_kind,
    revision: count(row.revision)
  }));
}

async function readCommunities(
  sql: DatabaseClient,
  input: ReuseInput
): Promise<SemanticCommunity[]> {
  const rows = await sql<Array<{
    public_id: string;
    source_partition_key: string;
    partition_key: string;
    level: number | string;
    title: string | null;
    revision: number | string;
    entity_public_ids: string[];
  }>>`
    SELECT community.public_id, community.source_partition_key,
           community.partition_key, community.level, community.title,
           community.revision,
           array_agg(DISTINCT membership.entity_public_id
             ORDER BY membership.entity_public_id) AS entity_public_ids
    FROM focowiki.semantic_communities community
    JOIN focowiki.semantic_community_memberships membership
      ON membership.knowledge_base_id = community.knowledge_base_id
     AND membership.semantic_generation_public_id
       = community.semantic_generation_public_id
     AND membership.community_public_id = community.public_id
    JOIN focowiki.semantic_entity_observations observation
      ON observation.knowledge_base_id = membership.knowledge_base_id
     AND observation.semantic_generation_public_id
       = membership.semantic_generation_public_id
     AND observation.entity_public_id = membership.entity_public_id
    WHERE community.knowledge_base_id = ${input.knowledgeBaseId}
      AND community.semantic_generation_public_id
        = ${input.sourceSemanticGenerationPublicId
          ?? input.semanticGenerationPublicId}
      AND community.deleted_at IS NULL
      AND observation.source_file_public_id = ${input.sourceFilePublicId}
      AND observation.source_revision_public_id
        = ${input.fromSourceRevisionPublicId}
    GROUP BY community.public_id, community.source_partition_key,
             community.partition_key, community.level, community.title,
             community.revision
    ORDER BY community.public_id COLLATE "C"
  `;
  return rows.map((row) => ({
    publicId: row.public_id,
    sourcePartitionKey: row.source_partition_key,
    partitionKey: row.partition_key,
    level: count(row.level),
    title: row.title,
    entityPublicIds: row.entity_public_ids,
    revision: count(row.revision)
  }));
}

async function readCommunityReports(
  sql: DatabaseClient,
  input: ReuseInput,
  communityPublicIds: readonly string[]
): Promise<SemanticCommunityReport[]> {
  if (communityPublicIds.length === 0) return [];
  const rows = await sql<Array<{
    public_id: string;
    community_public_id: string;
    input_graph_version: string;
    boundary_version: string;
    summary: string;
    report_checksum_sha256: string;
  }>>`
    SELECT public_id, community_public_id, input_graph_version,
           boundary_version, summary, report_checksum_sha256
    FROM focowiki.semantic_community_reports
    WHERE knowledge_base_id = ${input.knowledgeBaseId}
      AND semantic_generation_public_id
        = ${input.sourceSemanticGenerationPublicId
          ?? input.semanticGenerationPublicId}
      AND community_public_id = ANY(${communityPublicIds})
    ORDER BY public_id COLLATE "C"
  `;
  return rows.map((row) => ({
    publicId: row.public_id,
    communityPublicId: row.community_public_id,
    inputGraphVersion: row.input_graph_version,
    boundaryVersion: row.boundary_version,
    summary: row.summary,
    checksumSha256: row.report_checksum_sha256
  }));
}

type ReuseInput = {
  knowledgeBaseId: string;
  semanticGenerationPublicId: string;
  sourceSemanticGenerationPublicId?: string;
  sourceFilePublicId: string;
  fromSourceRevisionPublicId: string;
};

function aliasArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (typeof item !== "object" || item === null) return [];
    const display = (item as { displayAlias?: unknown }).displayAlias;
    return typeof display === "string" && display ? [display] : [];
  });
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function count(value: number | string): number {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 0) {
    throw new Error("Document semantic reuse count is invalid");
  }
  return result;
}
