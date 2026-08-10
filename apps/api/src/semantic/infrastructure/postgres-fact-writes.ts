import type { TransactionSql } from "postgres";
import type { SemanticDesiredFactSet } from "../domain/contracts.js";
import type { PriorSemanticSourceFacts } from "./postgres-fact-closure.js";

export async function replaceSemanticSourceFacts(
  sql: TransactionSql,
  input: SemanticDesiredFactSet,
  prior: PriorSemanticSourceFacts
): Promise<void> {
  await upsertEntities(sql, input);
  await insertEvidence(sql, input);
  await insertMentions(sql, input);
  await insertEntityObservations(sql, input);
  await upsertRelationships(sql, input);
  await insertRelationshipEvidence(sql, input);
  await insertRelationshipObservations(sql, input);
  await removeObsoleteSourceFacts(sql, input);
  await rebuildFactPresentation(sql, input, prior);
  await upsertCommunities(sql, input);
  await upsertCommunityReports(sql, input);
}

async function removeObsoleteSourceFacts(
  sql: TransactionSql,
  input: SemanticDesiredFactSet
): Promise<void> {
  await sql`
    DELETE FROM focowiki.semantic_relationship_observations
    WHERE knowledge_base_id = ${input.knowledgeBaseId}
      AND semantic_generation_public_id = ${input.semanticGenerationPublicId}
      AND source_file_public_id = ${input.sourceFilePublicId}
      AND source_revision_public_id = ${input.sourceRevisionPublicId}
      AND NOT (
        relationship_public_id = ANY(${input.relationships.map((item) => item.publicId)})
      )
  `;
  await sql`
    DELETE FROM focowiki.semantic_entity_observations
    WHERE knowledge_base_id = ${input.knowledgeBaseId}
      AND semantic_generation_public_id = ${input.semanticGenerationPublicId}
      AND source_file_public_id = ${input.sourceFilePublicId}
      AND source_revision_public_id = ${input.sourceRevisionPublicId}
      AND NOT (
        entity_public_id = ANY(${input.entities.map((item) => item.publicId)})
      )
  `;
  await sql`
    DELETE FROM focowiki.semantic_mentions
    WHERE knowledge_base_id = ${input.knowledgeBaseId}
      AND semantic_generation_public_id = ${input.semanticGenerationPublicId}
      AND source_file_public_id = ${input.sourceFilePublicId}
      AND source_revision_public_id = ${input.sourceRevisionPublicId}
      AND public_id <> ALL(${input.mentions.map((item) => item.publicId)})
  `;
  const relationshipEvidence = input.relationships.flatMap((relationship) =>
    relationship.evidencePublicIds.map((evidencePublicId) => ({
      relationshipPublicId: relationship.publicId,
      evidencePublicId
    }))
  );
  if (relationshipEvidence.length === 0) {
    await sql`
      DELETE FROM focowiki.semantic_relationship_evidence relationship_evidence
      USING focowiki.semantic_evidence evidence
      WHERE relationship_evidence.knowledge_base_id = ${input.knowledgeBaseId}
        AND relationship_evidence.semantic_generation_public_id
          = ${input.semanticGenerationPublicId}
        AND evidence.knowledge_base_id = relationship_evidence.knowledge_base_id
        AND evidence.semantic_generation_public_id
          = relationship_evidence.semantic_generation_public_id
        AND evidence.public_id = relationship_evidence.evidence_public_id
        AND evidence.source_file_public_id = ${input.sourceFilePublicId}
        AND evidence.source_revision_public_id = ${input.sourceRevisionPublicId}
    `;
  } else {
    await sql`
      WITH desired AS (
        SELECT item."relationshipPublicId", item."evidencePublicId"
        FROM jsonb_to_recordset(${sql.json(relationshipEvidence as never)}) AS item(
          "relationshipPublicId" text, "evidencePublicId" text
        )
      )
      DELETE FROM focowiki.semantic_relationship_evidence relationship_evidence
      USING focowiki.semantic_evidence evidence
      WHERE relationship_evidence.knowledge_base_id = ${input.knowledgeBaseId}
        AND relationship_evidence.semantic_generation_public_id
          = ${input.semanticGenerationPublicId}
        AND evidence.knowledge_base_id = relationship_evidence.knowledge_base_id
        AND evidence.semantic_generation_public_id
          = relationship_evidence.semantic_generation_public_id
        AND evidence.public_id = relationship_evidence.evidence_public_id
        AND evidence.source_file_public_id = ${input.sourceFilePublicId}
        AND evidence.source_revision_public_id = ${input.sourceRevisionPublicId}
        AND NOT EXISTS (
          SELECT 1 FROM desired
          WHERE desired."relationshipPublicId"
            = relationship_evidence.relationship_public_id
            AND desired."evidencePublicId"
              = relationship_evidence.evidence_public_id
        )
    `;
  }
  await sql`
    DELETE FROM focowiki.semantic_evidence
    WHERE knowledge_base_id = ${input.knowledgeBaseId}
      AND semantic_generation_public_id = ${input.semanticGenerationPublicId}
      AND source_file_public_id = ${input.sourceFilePublicId}
      AND source_revision_public_id = ${input.sourceRevisionPublicId}
      AND public_id <> ALL(${input.evidence.map((item) => item.publicId)})
  `;
  await sql`
    DELETE FROM focowiki.semantic_relationships relationship
    WHERE relationship.knowledge_base_id = ${input.knowledgeBaseId}
      AND relationship.semantic_generation_public_id = ${input.semanticGenerationPublicId}
      AND NOT EXISTS (
        SELECT 1 FROM focowiki.semantic_relationship_observations observation
        WHERE observation.semantic_generation_public_id
          = relationship.semantic_generation_public_id
          AND observation.relationship_public_id = relationship.public_id
      )
  `;
  await sql`
    DELETE FROM focowiki.semantic_entities entity
    WHERE entity.knowledge_base_id = ${input.knowledgeBaseId}
      AND entity.semantic_generation_public_id = ${input.semanticGenerationPublicId}
      AND NOT EXISTS (
        SELECT 1 FROM focowiki.semantic_entity_observations observation
        WHERE observation.semantic_generation_public_id
          = entity.semantic_generation_public_id
          AND observation.entity_public_id = entity.public_id
      )
  `;
}

async function upsertEntities(sql: TransactionSql, input: SemanticDesiredFactSet) {
  if (input.entities.length === 0) return;
  const rows = input.entities.map((entity) => ({
    publicId: entity.publicId,
    canonicalKey: entity.canonicalKey,
    kind: entity.kind,
    label: entity.label,
    description: entity.description,
    extractionContractVersion: entity.extractionContractVersion,
    confidence: entity.confidence,
    provenance: entity.provenance,
    revision: entity.revision
  }));
  await sql`
    INSERT INTO focowiki.semantic_entities (
      knowledge_base_id, semantic_generation_public_id, public_id,
      canonical_key, entity_kind, label, description,
      extraction_contract_version, confidence, provenance_kind, revision
    )
    SELECT ${input.knowledgeBaseId}, ${input.semanticGenerationPublicId},
           item."publicId", item."canonicalKey", item.kind, item.label,
           item.description, item."extractionContractVersion", item.confidence,
           item.provenance, item.revision
    FROM jsonb_to_recordset(${sql.json(rows as never)}) AS item(
      "publicId" text, "canonicalKey" text, kind text, label text,
      description text, "extractionContractVersion" text,
      confidence double precision, provenance text, revision bigint
    )
    ON CONFLICT (semantic_generation_public_id, public_id) DO UPDATE SET
      deleted_at = NULL
    WHERE focowiki.semantic_entities.knowledge_base_id = excluded.knowledge_base_id
      AND focowiki.semantic_entities.canonical_key = excluded.canonical_key
      AND focowiki.semantic_entities.entity_kind = excluded.entity_kind
  `;
}

async function insertEvidence(sql: TransactionSql, input: SemanticDesiredFactSet) {
  if (input.evidence.length === 0) return;
  await sql`
    INSERT INTO focowiki.semantic_evidence (
      knowledge_base_id, semantic_generation_public_id, public_id,
      source_file_public_id, source_revision_public_id, logical_path,
      start_offset, end_offset, excerpt_checksum_sha256,
      extraction_contract_version
    )
    SELECT ${input.knowledgeBaseId}, ${input.semanticGenerationPublicId},
           item."publicId", item."sourceFilePublicId",
           item."sourceRevisionPublicId", item."logicalPath",
           item."startOffset", item."endOffset", item."checksum",
           item."contractVersion"
    FROM jsonb_to_recordset(${sql.json(input.evidence.map((evidence) => ({
      publicId: evidence.publicId,
      sourceFilePublicId: evidence.sourceFilePublicId,
      sourceRevisionPublicId: evidence.sourceRevisionPublicId,
      logicalPath: evidence.logicalPath,
      startOffset: evidence.startOffset,
      endOffset: evidence.endOffset,
      checksum: evidence.excerptChecksumSha256,
      contractVersion: evidence.extractionContractVersion
    })) as never)}) AS item(
      "publicId" text, "sourceFilePublicId" text,
      "sourceRevisionPublicId" text, "logicalPath" text,
      "startOffset" bigint, "endOffset" bigint,
      "checksum" text, "contractVersion" text
    )
    ON CONFLICT (semantic_generation_public_id, public_id) DO NOTHING
  `;
}

async function insertMentions(sql: TransactionSql, input: SemanticDesiredFactSet) {
  if (input.mentions.length === 0) return;
  await sql`
    INSERT INTO focowiki.semantic_mentions (
      knowledge_base_id, semantic_generation_public_id, public_id,
      entity_public_id, evidence_public_id, source_file_public_id,
      source_revision_public_id, mention_text, confidence
    )
    SELECT ${input.knowledgeBaseId}, ${input.semanticGenerationPublicId},
           item."publicId", item."entityPublicId", item."evidencePublicId",
           item."sourceFilePublicId", item."sourceRevisionPublicId",
           item.text, item.confidence
    FROM jsonb_to_recordset(${sql.json(input.mentions as never)}) AS item(
      "publicId" text, "entityPublicId" text, "evidencePublicId" text,
      "sourceFilePublicId" text, "sourceRevisionPublicId" text,
      text text, confidence double precision
    )
    ON CONFLICT (semantic_generation_public_id, public_id) DO NOTHING
  `;
}

async function insertEntityObservations(sql: TransactionSql, input: SemanticDesiredFactSet) {
  if (input.entities.length === 0) return;
  const rows = input.entities.map((entity) => ({
    entityPublicId: entity.publicId,
    label: entity.label,
    description: entity.description,
    aliases: entity.aliases.map((alias) => ({
      normalizedAlias: alias.normalize("NFKC").trim().toLocaleLowerCase("en"),
      displayAlias: alias.trim()
    })).filter((alias) => alias.normalizedAlias),
    extractionContractVersion: entity.extractionContractVersion,
    confidence: entity.confidence,
    provenance: entity.provenance
  }));
  await sql`
    INSERT INTO focowiki.semantic_entity_observations (
      knowledge_base_id, semantic_generation_public_id, entity_public_id,
      source_file_public_id, source_revision_public_id, label, description,
      aliases, extraction_contract_version, confidence, provenance_kind
    )
    SELECT ${input.knowledgeBaseId}, ${input.semanticGenerationPublicId},
           item."entityPublicId", ${input.sourceFilePublicId},
           ${input.sourceRevisionPublicId}, item.label, item.description,
           item.aliases, item."extractionContractVersion", item.confidence,
           item.provenance
    FROM jsonb_to_recordset(${sql.json(rows as never)}) AS item(
      "entityPublicId" text, label text, description text, aliases jsonb,
      "extractionContractVersion" text, confidence double precision,
      provenance text
    )
    ON CONFLICT (
      semantic_generation_public_id, entity_public_id,
      source_revision_public_id
    ) DO UPDATE SET
      source_file_public_id = excluded.source_file_public_id,
      label = excluded.label,
      description = excluded.description,
      aliases = excluded.aliases,
      extraction_contract_version = excluded.extraction_contract_version,
      confidence = excluded.confidence,
      provenance_kind = excluded.provenance_kind
    WHERE focowiki.semantic_entity_observations.knowledge_base_id
      = excluded.knowledge_base_id
  `;
}

async function upsertRelationships(sql: TransactionSql, input: SemanticDesiredFactSet) {
  if (input.relationships.length === 0) return;
  const rows = input.relationships.map((relationship) => ({
    publicId: relationship.publicId,
    fromEntityPublicId: relationship.fromEntityPublicId,
    toEntityPublicId: relationship.toEntityPublicId,
    kind: relationship.kind,
    description: relationship.description,
    confidence: relationship.confidence,
    provenance: relationship.provenance,
    revision: relationship.revision
  }));
  await sql`
    INSERT INTO focowiki.semantic_relationships (
      knowledge_base_id, semantic_generation_public_id, public_id,
      from_entity_public_id, to_entity_public_id, relationship_kind,
      description, confidence, provenance_kind, revision
    )
    SELECT ${input.knowledgeBaseId}, ${input.semanticGenerationPublicId},
           item."publicId", item."fromEntityPublicId", item."toEntityPublicId",
           item.kind, item.description, item.confidence, item.provenance,
           item.revision
    FROM jsonb_to_recordset(${sql.json(rows as never)}) AS item(
      "publicId" text, "fromEntityPublicId" text, "toEntityPublicId" text,
      kind text, description text, confidence double precision,
      provenance text, revision bigint
    )
    ON CONFLICT (semantic_generation_public_id, public_id) DO UPDATE SET
      deleted_at = NULL
    WHERE focowiki.semantic_relationships.knowledge_base_id = excluded.knowledge_base_id
      AND focowiki.semantic_relationships.from_entity_public_id
        = excluded.from_entity_public_id
      AND focowiki.semantic_relationships.to_entity_public_id
        = excluded.to_entity_public_id
      AND focowiki.semantic_relationships.relationship_kind
        = excluded.relationship_kind
  `;
}

async function insertRelationshipEvidence(sql: TransactionSql, input: SemanticDesiredFactSet) {
  const rows = input.relationships.flatMap((relationship) =>
    relationship.evidencePublicIds.map((evidencePublicId) => ({
      relationshipPublicId: relationship.publicId,
      evidencePublicId
    }))
  );
  if (rows.length === 0) return;
  await sql`
    INSERT INTO focowiki.semantic_relationship_evidence (
      knowledge_base_id, semantic_generation_public_id,
      relationship_public_id, evidence_public_id
    )
    SELECT ${input.knowledgeBaseId}, ${input.semanticGenerationPublicId},
           item."relationshipPublicId", item."evidencePublicId"
    FROM jsonb_to_recordset(${sql.json(rows as never)}) AS item(
      "relationshipPublicId" text, "evidencePublicId" text
    )
    ON CONFLICT DO NOTHING
  `;
}

async function insertRelationshipObservations(
  sql: TransactionSql,
  input: SemanticDesiredFactSet
) {
  if (input.relationships.length === 0) return;
  const rows = input.relationships.map((relationship) => ({
    relationshipPublicId: relationship.publicId,
    description: relationship.description,
    confidence: relationship.confidence,
    provenance: relationship.provenance
  }));
  await sql`
    INSERT INTO focowiki.semantic_relationship_observations (
      knowledge_base_id, semantic_generation_public_id,
      relationship_public_id, source_file_public_id,
      source_revision_public_id, description, confidence, provenance_kind
    )
    SELECT ${input.knowledgeBaseId}, ${input.semanticGenerationPublicId},
           item."relationshipPublicId", ${input.sourceFilePublicId},
           ${input.sourceRevisionPublicId}, item.description,
           item.confidence, item.provenance
    FROM jsonb_to_recordset(${sql.json(rows as never)}) AS item(
      "relationshipPublicId" text, description text,
      confidence double precision, provenance text
    )
    ON CONFLICT (
      semantic_generation_public_id, relationship_public_id,
      source_revision_public_id
    ) DO UPDATE SET
      source_file_public_id = excluded.source_file_public_id,
      description = excluded.description,
      confidence = excluded.confidence,
      provenance_kind = excluded.provenance_kind
    WHERE focowiki.semantic_relationship_observations.knowledge_base_id
      = excluded.knowledge_base_id
  `;
}

async function rebuildFactPresentation(
  sql: TransactionSql,
  input: SemanticDesiredFactSet,
  prior: PriorSemanticSourceFacts
): Promise<void> {
  const entityPublicIds = unique([
    ...prior.entityPublicIds,
    ...input.entities.map((entity) => entity.publicId)
  ]);
  const relationshipPublicIds = unique([
    ...prior.relationshipPublicIds,
    ...input.relationships.map((relationship) => relationship.publicId)
  ]);
  await rebuildEntityPresentation(sql, input, entityPublicIds);
  await rebuildRelationshipPresentation(sql, input, relationshipPublicIds);
}

async function rebuildEntityPresentation(
  sql: TransactionSql,
  input: SemanticDesiredFactSet,
  entityPublicIds: readonly string[]
): Promise<void> {
  if (entityPublicIds.length === 0) return;
  await sql`
    WITH aggregate AS (
      SELECT observation.entity_public_id,
             (array_agg(observation.label ORDER BY observation.label COLLATE "C"))[1]
               AS label,
             (array_agg(observation.description ORDER BY observation.description COLLATE "C")
               FILTER (WHERE observation.description IS NOT NULL))[1] AS description,
             (array_agg(
               observation.extraction_contract_version
               ORDER BY observation.extraction_contract_version COLLATE "C"
             ))[1] AS extraction_contract_version,
             max(observation.confidence) AS confidence,
             CASE WHEN bool_or(observation.provenance_kind = 'model')
               THEN 'model' ELSE 'deterministic' END AS provenance_kind
      FROM focowiki.semantic_entity_observations observation
      JOIN focowiki.source_file_current_revisions current_revision
        ON current_revision.knowledge_base_id = observation.knowledge_base_id
       AND current_revision.source_file_public_id
         = observation.source_file_public_id
       AND current_revision.source_revision_public_id
         = observation.source_revision_public_id
      WHERE observation.knowledge_base_id = ${input.knowledgeBaseId}
        AND observation.semantic_generation_public_id
          = ${input.semanticGenerationPublicId}
        AND observation.entity_public_id = ANY(${entityPublicIds})
      GROUP BY observation.entity_public_id
    )
    UPDATE focowiki.semantic_entities entity
    SET label = aggregate.label,
        description = aggregate.description,
        extraction_contract_version = aggregate.extraction_contract_version,
        confidence = aggregate.confidence,
        provenance_kind = aggregate.provenance_kind,
        revision = CASE WHEN ROW(
          entity.label, entity.description, entity.extraction_contract_version,
          entity.confidence, entity.provenance_kind
        ) IS DISTINCT FROM ROW(
          aggregate.label, aggregate.description,
          aggregate.extraction_contract_version, aggregate.confidence,
          aggregate.provenance_kind
        ) THEN entity.revision + 1 ELSE entity.revision END
    FROM aggregate
    WHERE entity.knowledge_base_id = ${input.knowledgeBaseId}
      AND entity.semantic_generation_public_id = ${input.semanticGenerationPublicId}
      AND entity.public_id = aggregate.entity_public_id
  `;
  await sql`
    DELETE FROM focowiki.semantic_entity_aliases
    WHERE knowledge_base_id = ${input.knowledgeBaseId}
      AND semantic_generation_public_id = ${input.semanticGenerationPublicId}
      AND entity_public_id = ANY(${entityPublicIds})
  `;
  await sql`
    WITH ranked_aliases AS (
      SELECT observation.entity_public_id,
             alias."normalizedAlias" AS normalized_alias,
             min(alias."displayAlias" COLLATE "C") AS display_alias,
             row_number() OVER (
               PARTITION BY observation.entity_public_id
               ORDER BY alias."normalizedAlias" COLLATE "C"
             ) AS alias_rank
      FROM focowiki.semantic_entity_observations observation
      JOIN focowiki.source_file_current_revisions current_revision
        ON current_revision.knowledge_base_id = observation.knowledge_base_id
       AND current_revision.source_file_public_id
         = observation.source_file_public_id
       AND current_revision.source_revision_public_id
         = observation.source_revision_public_id
      CROSS JOIN LATERAL jsonb_to_recordset(observation.aliases) AS alias(
        "normalizedAlias" text, "displayAlias" text
      )
      WHERE observation.knowledge_base_id = ${input.knowledgeBaseId}
        AND observation.semantic_generation_public_id
          = ${input.semanticGenerationPublicId}
        AND observation.entity_public_id = ANY(${entityPublicIds})
        AND alias."normalizedAlias" <> ''
        AND alias."displayAlias" <> ''
      GROUP BY observation.entity_public_id, alias."normalizedAlias"
    )
    INSERT INTO focowiki.semantic_entity_aliases (
      knowledge_base_id, semantic_generation_public_id, entity_public_id,
      normalized_alias, display_alias
    )
    SELECT ${input.knowledgeBaseId}, ${input.semanticGenerationPublicId},
           entity_public_id, normalized_alias, display_alias
    FROM ranked_aliases
    WHERE alias_rank <= 128
    ON CONFLICT DO NOTHING
  `;
}

async function rebuildRelationshipPresentation(
  sql: TransactionSql,
  input: SemanticDesiredFactSet,
  relationshipPublicIds: readonly string[]
): Promise<void> {
  if (relationshipPublicIds.length === 0) return;
  await sql`
    WITH aggregate AS (
      SELECT observation.relationship_public_id,
             (array_agg(observation.description ORDER BY observation.description COLLATE "C")
               FILTER (WHERE observation.description IS NOT NULL))[1] AS description,
             max(observation.confidence) AS confidence,
             CASE WHEN bool_or(observation.provenance_kind = 'model')
               THEN 'model' ELSE 'deterministic' END AS provenance_kind
      FROM focowiki.semantic_relationship_observations observation
      JOIN focowiki.source_file_current_revisions current_revision
        ON current_revision.knowledge_base_id = observation.knowledge_base_id
       AND current_revision.source_file_public_id
         = observation.source_file_public_id
       AND current_revision.source_revision_public_id
         = observation.source_revision_public_id
      WHERE observation.knowledge_base_id = ${input.knowledgeBaseId}
        AND observation.semantic_generation_public_id
          = ${input.semanticGenerationPublicId}
        AND observation.relationship_public_id = ANY(${relationshipPublicIds})
      GROUP BY observation.relationship_public_id
    )
    UPDATE focowiki.semantic_relationships relationship
    SET description = aggregate.description,
        confidence = aggregate.confidence,
        provenance_kind = aggregate.provenance_kind,
        revision = CASE WHEN ROW(
          relationship.description, relationship.confidence,
          relationship.provenance_kind
        ) IS DISTINCT FROM ROW(
          aggregate.description, aggregate.confidence,
          aggregate.provenance_kind
        ) THEN relationship.revision + 1 ELSE relationship.revision END
    FROM aggregate
    WHERE relationship.knowledge_base_id = ${input.knowledgeBaseId}
      AND relationship.semantic_generation_public_id
        = ${input.semanticGenerationPublicId}
      AND relationship.public_id = aggregate.relationship_public_id
  `;
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

async function upsertCommunities(sql: TransactionSql, input: SemanticDesiredFactSet) {
  if (input.communities.length === 0) return;
  const rows = input.communities.map((community) => ({
    publicId: community.publicId,
    sourcePartitionKey: community.sourcePartitionKey,
    partitionKey: community.partitionKey,
    level: community.level,
    title: community.title,
    revision: community.revision
  }));
  await sql`
    INSERT INTO focowiki.semantic_communities (
      knowledge_base_id, semantic_generation_public_id, public_id,
      source_partition_key, partition_key, level, title, revision
    )
    SELECT ${input.knowledgeBaseId}, ${input.semanticGenerationPublicId},
           item."publicId", item."sourcePartitionKey", item."partitionKey",
           item.level, item.title,
           item.revision
    FROM jsonb_to_recordset(${sql.json(rows as never)}) AS item(
      "publicId" text, "partitionKey" text, "sourcePartitionKey" text, level integer,
      title text, revision bigint
    )
    ON CONFLICT (semantic_generation_public_id, public_id) DO UPDATE SET
      source_partition_key = excluded.source_partition_key,
      partition_key = excluded.partition_key, level = excluded.level,
      title = excluded.title, revision = excluded.revision, deleted_at = NULL
    WHERE focowiki.semantic_communities.knowledge_base_id = excluded.knowledge_base_id
  `;
  const membershipRows = input.communities.flatMap((community) =>
    community.entityPublicIds.map((entityPublicId) => ({
      communityPublicId: community.publicId,
      entityPublicId
    }))
  );
  if (membershipRows.length === 0) return;
  await sql`
    INSERT INTO focowiki.semantic_community_memberships (
      knowledge_base_id, semantic_generation_public_id,
      community_public_id, entity_public_id, membership_weight
    )
    SELECT ${input.knowledgeBaseId}, ${input.semanticGenerationPublicId},
           item."communityPublicId", item."entityPublicId", 1
    FROM jsonb_to_recordset(${sql.json(membershipRows as never)}) AS item(
      "communityPublicId" text, "entityPublicId" text
    )
    ON CONFLICT DO NOTHING
  `;
}

async function upsertCommunityReports(sql: TransactionSql, input: SemanticDesiredFactSet) {
  if (input.communityReports.length === 0) return;
  await sql`
    INSERT INTO focowiki.semantic_community_reports (
      knowledge_base_id, semantic_generation_public_id, public_id,
      community_public_id, input_graph_version, boundary_version,
      summary, report_checksum_sha256
    )
    SELECT ${input.knowledgeBaseId}, ${input.semanticGenerationPublicId},
           item."publicId", item."communityPublicId", item."inputGraphVersion",
           item."boundaryVersion", item.summary, item."checksumSha256"
    FROM jsonb_to_recordset(${sql.json(input.communityReports as never)}) AS item(
      "publicId" text, "communityPublicId" text, "inputGraphVersion" text,
      "boundaryVersion" text, summary text, "checksumSha256" text
    )
    ON CONFLICT (semantic_generation_public_id, public_id) DO UPDATE SET
      community_public_id = excluded.community_public_id,
      input_graph_version = excluded.input_graph_version,
      boundary_version = excluded.boundary_version,
      summary = excluded.summary,
      report_checksum_sha256 = excluded.report_checksum_sha256
    WHERE focowiki.semantic_community_reports.knowledge_base_id
      = excluded.knowledge_base_id
  `;
}
