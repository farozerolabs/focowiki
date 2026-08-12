import type { TransactionSql } from "postgres";

type CloneInput = {
  knowledgeBaseId: string;
  predecessorPublicId: string;
  candidatePublicId: string;
};

type FactCountRow = {
  table_name: string;
  predecessor_count: number | string;
  candidate_count: number | string;
};

export async function cloneSemanticGenerationFacts(
  sql: TransactionSql,
  input: CloneInput
): Promise<{
  sourceCount: number;
  factCount: number;
  complete: boolean;
}> {
  await sql`
    INSERT INTO focowiki.semantic_source_reconciliations (
      knowledge_base_id, semantic_generation_public_id,
      source_file_public_id, source_revision_public_id,
      extraction_contract_version, canonical_input_sha256,
      skeleton_policy_version, skeleton_selected,
      source_chunk_count, selected_chunk_count, selection_reasons,
      selection_decision_sha256, entity_count, relationship_count,
      evidence_count, affected_closure, reconciled_at
    )
    SELECT knowledge_base_id, ${input.candidatePublicId},
      source_file_public_id, source_revision_public_id,
      extraction_contract_version, canonical_input_sha256,
      skeleton_policy_version, skeleton_selected,
      source_chunk_count, selected_chunk_count, selection_reasons,
      selection_decision_sha256, entity_count, relationship_count,
      evidence_count, affected_closure, reconciled_at
    FROM focowiki.semantic_source_reconciliations
    WHERE knowledge_base_id = ${input.knowledgeBaseId}
      AND semantic_generation_public_id = ${input.predecessorPublicId}
    ON CONFLICT DO NOTHING
  `;
  await sql`
    INSERT INTO focowiki.semantic_entities (
      knowledge_base_id, semantic_generation_public_id, public_id,
      canonical_key, entity_kind, label, description,
      extraction_contract_version, confidence, provenance_kind,
      revision, deleted_at
    )
    SELECT knowledge_base_id, ${input.candidatePublicId}, public_id,
      canonical_key, entity_kind, label, description,
      extraction_contract_version, confidence, provenance_kind,
      revision, deleted_at
    FROM focowiki.semantic_entities
    WHERE knowledge_base_id = ${input.knowledgeBaseId}
      AND semantic_generation_public_id = ${input.predecessorPublicId}
    ON CONFLICT DO NOTHING
  `;
  await sql`
    INSERT INTO focowiki.semantic_evidence (
      knowledge_base_id, semantic_generation_public_id, public_id,
      source_file_public_id, source_revision_public_id, logical_path,
      start_offset, end_offset, excerpt_checksum_sha256,
      extraction_contract_version
    )
    SELECT knowledge_base_id, ${input.candidatePublicId}, public_id,
      source_file_public_id, source_revision_public_id, logical_path,
      start_offset, end_offset, excerpt_checksum_sha256,
      extraction_contract_version
    FROM focowiki.semantic_evidence
    WHERE knowledge_base_id = ${input.knowledgeBaseId}
      AND semantic_generation_public_id = ${input.predecessorPublicId}
    ON CONFLICT DO NOTHING
  `;
  await sql`
    INSERT INTO focowiki.semantic_entity_aliases (
      knowledge_base_id, semantic_generation_public_id,
      entity_public_id, normalized_alias, display_alias
    )
    SELECT knowledge_base_id, ${input.candidatePublicId},
      entity_public_id, normalized_alias, display_alias
    FROM focowiki.semantic_entity_aliases
    WHERE knowledge_base_id = ${input.knowledgeBaseId}
      AND semantic_generation_public_id = ${input.predecessorPublicId}
    ON CONFLICT DO NOTHING
  `;
  await sql`
    INSERT INTO focowiki.semantic_entity_observations (
      knowledge_base_id, semantic_generation_public_id,
      entity_public_id, source_file_public_id, source_revision_public_id,
      label, description, aliases, extraction_contract_version,
      confidence, provenance_kind
    )
    SELECT knowledge_base_id, ${input.candidatePublicId},
      entity_public_id, source_file_public_id, source_revision_public_id,
      label, description, aliases, extraction_contract_version,
      confidence, provenance_kind
    FROM focowiki.semantic_entity_observations
    WHERE knowledge_base_id = ${input.knowledgeBaseId}
      AND semantic_generation_public_id = ${input.predecessorPublicId}
    ON CONFLICT DO NOTHING
  `;
  await sql`
    INSERT INTO focowiki.semantic_mentions (
      knowledge_base_id, semantic_generation_public_id, public_id,
      entity_public_id, evidence_public_id, source_file_public_id,
      source_revision_public_id, mention_text, confidence
    )
    SELECT knowledge_base_id, ${input.candidatePublicId}, public_id,
      entity_public_id, evidence_public_id, source_file_public_id,
      source_revision_public_id, mention_text, confidence
    FROM focowiki.semantic_mentions
    WHERE knowledge_base_id = ${input.knowledgeBaseId}
      AND semantic_generation_public_id = ${input.predecessorPublicId}
    ON CONFLICT DO NOTHING
  `;
  await sql`
    INSERT INTO focowiki.semantic_relationships (
      knowledge_base_id, semantic_generation_public_id, public_id,
      from_entity_public_id, to_entity_public_id, relationship_kind,
      description, confidence, provenance_kind, revision, deleted_at
    )
    SELECT knowledge_base_id, ${input.candidatePublicId}, public_id,
      from_entity_public_id, to_entity_public_id, relationship_kind,
      description, confidence, provenance_kind, revision, deleted_at
    FROM focowiki.semantic_relationships
    WHERE knowledge_base_id = ${input.knowledgeBaseId}
      AND semantic_generation_public_id = ${input.predecessorPublicId}
    ON CONFLICT DO NOTHING
  `;
  await sql`
    INSERT INTO focowiki.semantic_relationship_evidence (
      knowledge_base_id, semantic_generation_public_id,
      relationship_public_id, evidence_public_id
    )
    SELECT knowledge_base_id, ${input.candidatePublicId},
      relationship_public_id, evidence_public_id
    FROM focowiki.semantic_relationship_evidence
    WHERE knowledge_base_id = ${input.knowledgeBaseId}
      AND semantic_generation_public_id = ${input.predecessorPublicId}
    ON CONFLICT DO NOTHING
  `;
  await sql`
    INSERT INTO focowiki.semantic_relationship_observations (
      knowledge_base_id, semantic_generation_public_id,
      relationship_public_id, source_file_public_id,
      source_revision_public_id, description, confidence, provenance_kind
    )
    SELECT knowledge_base_id, ${input.candidatePublicId},
      relationship_public_id, source_file_public_id,
      source_revision_public_id, description, confidence, provenance_kind
    FROM focowiki.semantic_relationship_observations
    WHERE knowledge_base_id = ${input.knowledgeBaseId}
      AND semantic_generation_public_id = ${input.predecessorPublicId}
    ON CONFLICT DO NOTHING
  `;
  await sql`
    INSERT INTO focowiki.semantic_reverse_references (
      knowledge_base_id, semantic_generation_public_id, target_kind,
      target_public_id, source_file_public_id, source_revision_public_id,
      evidence_public_id
    )
    SELECT knowledge_base_id, ${input.candidatePublicId}, target_kind,
      target_public_id, source_file_public_id, source_revision_public_id,
      evidence_public_id
    FROM focowiki.semantic_reverse_references
    WHERE knowledge_base_id = ${input.knowledgeBaseId}
      AND semantic_generation_public_id = ${input.predecessorPublicId}
    ON CONFLICT DO NOTHING
  `;
  await sql`
    INSERT INTO focowiki.semantic_communities (
      knowledge_base_id, semantic_generation_public_id, public_id,
      source_partition_key, partition_key, level, title, revision, deleted_at
    )
    SELECT knowledge_base_id, ${input.candidatePublicId}, public_id,
      source_partition_key, partition_key, level, title, revision, deleted_at
    FROM focowiki.semantic_communities
    WHERE knowledge_base_id = ${input.knowledgeBaseId}
      AND semantic_generation_public_id = ${input.predecessorPublicId}
    ON CONFLICT DO NOTHING
  `;
  await sql`
    INSERT INTO focowiki.semantic_community_memberships (
      knowledge_base_id, semantic_generation_public_id,
      community_public_id, entity_public_id, membership_weight
    )
    SELECT knowledge_base_id, ${input.candidatePublicId},
      community_public_id, entity_public_id, membership_weight
    FROM focowiki.semantic_community_memberships
    WHERE knowledge_base_id = ${input.knowledgeBaseId}
      AND semantic_generation_public_id = ${input.predecessorPublicId}
    ON CONFLICT DO NOTHING
  `;
  await sql`
    INSERT INTO focowiki.semantic_community_reports (
      knowledge_base_id, semantic_generation_public_id, public_id,
      community_public_id, input_graph_version, boundary_version,
      summary, report_checksum_sha256, created_at
    )
    SELECT knowledge_base_id, ${input.candidatePublicId}, public_id,
      community_public_id, input_graph_version, boundary_version,
      summary, report_checksum_sha256, created_at
    FROM focowiki.semantic_community_reports
    WHERE knowledge_base_id = ${input.knowledgeBaseId}
      AND semantic_generation_public_id = ${input.predecessorPublicId}
    ON CONFLICT DO NOTHING
  `;
  await sql`
    INSERT INTO focowiki.semantic_entity_partitions (
      knowledge_base_id, semantic_generation_public_id,
      entity_public_id, partition_key, input_version, updated_at
    )
    SELECT knowledge_base_id, ${input.candidatePublicId},
      entity_public_id, partition_key, input_version, updated_at
    FROM focowiki.semantic_entity_partitions
    WHERE knowledge_base_id = ${input.knowledgeBaseId}
      AND semantic_generation_public_id = ${input.predecessorPublicId}
    ON CONFLICT DO NOTHING
  `;

  const counts = await readFactCounts(sql, input);
  return {
    sourceCount: Number(counts.find((row) =>
      row.table_name === "semantic_source_reconciliations"
    )?.candidate_count ?? 0),
    factCount: counts.reduce((total, row) =>
      total + Number(row.candidate_count), 0),
    complete: counts.every((row) =>
      Number(row.predecessor_count) === Number(row.candidate_count))
  };
}

async function readFactCounts(
  sql: TransactionSql,
  input: CloneInput
): Promise<FactCountRow[]> {
  return sql<FactCountRow[]>`
    WITH table_names(table_name) AS (
      VALUES
        ('semantic_source_reconciliations'),
        ('semantic_entities'),
        ('semantic_entity_aliases'),
        ('semantic_evidence'),
        ('semantic_mentions'),
        ('semantic_entity_observations'),
        ('semantic_relationships'),
        ('semantic_relationship_evidence'),
        ('semantic_relationship_observations'),
        ('semantic_reverse_references'),
        ('semantic_communities'),
        ('semantic_community_memberships'),
        ('semantic_community_reports'),
        ('semantic_entity_partitions')
    ), fact_rows AS (
      SELECT 'semantic_source_reconciliations' AS table_name,
        semantic_generation_public_id
      FROM focowiki.semantic_source_reconciliations
      WHERE knowledge_base_id = ${input.knowledgeBaseId}
        AND semantic_generation_public_id IN (
          ${input.predecessorPublicId}, ${input.candidatePublicId}
        )
      UNION ALL
      SELECT 'semantic_entities', semantic_generation_public_id
      FROM focowiki.semantic_entities
      WHERE knowledge_base_id = ${input.knowledgeBaseId}
        AND semantic_generation_public_id IN (
          ${input.predecessorPublicId}, ${input.candidatePublicId}
        )
      UNION ALL
      SELECT 'semantic_entity_aliases', semantic_generation_public_id
      FROM focowiki.semantic_entity_aliases
      WHERE knowledge_base_id = ${input.knowledgeBaseId}
        AND semantic_generation_public_id IN (
          ${input.predecessorPublicId}, ${input.candidatePublicId}
        )
      UNION ALL
      SELECT 'semantic_evidence', semantic_generation_public_id
      FROM focowiki.semantic_evidence
      WHERE knowledge_base_id = ${input.knowledgeBaseId}
        AND semantic_generation_public_id IN (
          ${input.predecessorPublicId}, ${input.candidatePublicId}
        )
      UNION ALL
      SELECT 'semantic_mentions', semantic_generation_public_id
      FROM focowiki.semantic_mentions
      WHERE knowledge_base_id = ${input.knowledgeBaseId}
        AND semantic_generation_public_id IN (
          ${input.predecessorPublicId}, ${input.candidatePublicId}
        )
      UNION ALL
      SELECT 'semantic_entity_observations', semantic_generation_public_id
      FROM focowiki.semantic_entity_observations
      WHERE knowledge_base_id = ${input.knowledgeBaseId}
        AND semantic_generation_public_id IN (
          ${input.predecessorPublicId}, ${input.candidatePublicId}
        )
      UNION ALL
      SELECT 'semantic_relationships', semantic_generation_public_id
      FROM focowiki.semantic_relationships
      WHERE knowledge_base_id = ${input.knowledgeBaseId}
        AND semantic_generation_public_id IN (
          ${input.predecessorPublicId}, ${input.candidatePublicId}
        )
      UNION ALL
      SELECT 'semantic_relationship_evidence', semantic_generation_public_id
      FROM focowiki.semantic_relationship_evidence
      WHERE knowledge_base_id = ${input.knowledgeBaseId}
        AND semantic_generation_public_id IN (
          ${input.predecessorPublicId}, ${input.candidatePublicId}
        )
      UNION ALL
      SELECT 'semantic_relationship_observations', semantic_generation_public_id
      FROM focowiki.semantic_relationship_observations
      WHERE knowledge_base_id = ${input.knowledgeBaseId}
        AND semantic_generation_public_id IN (
          ${input.predecessorPublicId}, ${input.candidatePublicId}
        )
      UNION ALL
      SELECT 'semantic_reverse_references', semantic_generation_public_id
      FROM focowiki.semantic_reverse_references
      WHERE knowledge_base_id = ${input.knowledgeBaseId}
        AND semantic_generation_public_id IN (
          ${input.predecessorPublicId}, ${input.candidatePublicId}
        )
      UNION ALL
      SELECT 'semantic_communities', semantic_generation_public_id
      FROM focowiki.semantic_communities
      WHERE knowledge_base_id = ${input.knowledgeBaseId}
        AND semantic_generation_public_id IN (
          ${input.predecessorPublicId}, ${input.candidatePublicId}
        )
      UNION ALL
      SELECT 'semantic_community_memberships', semantic_generation_public_id
      FROM focowiki.semantic_community_memberships
      WHERE knowledge_base_id = ${input.knowledgeBaseId}
        AND semantic_generation_public_id IN (
          ${input.predecessorPublicId}, ${input.candidatePublicId}
        )
      UNION ALL
      SELECT 'semantic_community_reports', semantic_generation_public_id
      FROM focowiki.semantic_community_reports
      WHERE knowledge_base_id = ${input.knowledgeBaseId}
        AND semantic_generation_public_id IN (
          ${input.predecessorPublicId}, ${input.candidatePublicId}
        )
      UNION ALL
      SELECT 'semantic_entity_partitions', semantic_generation_public_id
      FROM focowiki.semantic_entity_partitions
      WHERE knowledge_base_id = ${input.knowledgeBaseId}
        AND semantic_generation_public_id IN (
          ${input.predecessorPublicId}, ${input.candidatePublicId}
        )
    )
    SELECT table_names.table_name,
      count(fact_rows.semantic_generation_public_id) FILTER (
        WHERE fact_rows.semantic_generation_public_id
          = ${input.predecessorPublicId}
      ) AS predecessor_count,
      count(fact_rows.semantic_generation_public_id) FILTER (
        WHERE fact_rows.semantic_generation_public_id
          = ${input.candidatePublicId}
      ) AS candidate_count
    FROM table_names
    LEFT JOIN fact_rows USING (table_name)
    GROUP BY table_names.table_name
    ORDER BY table_names.table_name COLLATE "C"
  `;
}
