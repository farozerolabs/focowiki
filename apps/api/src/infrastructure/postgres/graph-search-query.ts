import type {
  ActiveGenerationPage,
  ActiveGenerationProjection,
  ActiveGenerationScoredCursor
} from "../../application/ports/active-generation-read-repository.js";
import type { LexicalTokenizer } from "../../application/ports/lexical-tokenizer.js";
import type { SerializableJson } from "../../application/ports/source-dispatch-repository.js";
import { GRAPH_LEXICAL_PROJECTION_VERSION } from "../../graph/graph-term-document.js";
import {
  createSearchQueryEvidence,
  SEARCH_MULTI_TERM_MIN_COVERAGE
} from "../../search/search-query-evidence.js";
import type { DatabaseClient } from "../../db/client.js";
import type { TransactionSql } from "postgres";

type ReadSql = DatabaseClient | TransactionSql;

type GraphSearchRow = {
  source_file_id: string;
  logical_path: string;
  title: string;
  summary: string | null;
  score: number;
  payload_json: SerializableJson;
};

const CANDIDATE_MIN = 100;
const CANDIDATE_MAX = 2_000;
const CANDIDATE_MULTIPLIER = 10;

export async function searchGraphProjection(input: {
  sql: ReadSql;
  tokenizer: LexicalTokenizer;
  knowledgeBaseId: string;
  generationId: string;
  query: string;
  limit: number;
  cursor: ActiveGenerationScoredCursor | null;
}): Promise<ActiveGenerationPage<ActiveGenerationProjection, ActiveGenerationScoredCursor>> {
  const evidence = createSearchQueryEvidence(input.query, input.tokenizer);
  if (!evidence.phrase) return { items: [], nextCursor: null };
  const candidateLimit = Math.min(
    CANDIDATE_MAX,
    Math.max(CANDIDATE_MIN, input.limit * CANDIDATE_MULTIPLIER)
  );
  const rows = await input.sql<GraphSearchRow[]>`
    WITH exact_candidates AS MATERIALIZED (
      SELECT reference.source_file_id, 120::real AS family_score
      FROM focowiki.generation_search_projection_refs reference
      JOIN focowiki.active_projection_records node
        ON node.knowledge_base_id = reference.knowledge_base_id
       AND node.projection_kind = 'graph_node'
       AND node.source_file_id = reference.source_file_id
      WHERE reference.knowledge_base_id = ${input.knowledgeBaseId}
        AND reference.generation_id = ${input.generationId}
        AND (
          lower(reference.title) = lower(${evidence.phrase})
          OR lower(reference.logical_path) = lower(${evidence.phrase})
        )
      ORDER BY reference.source_file_id
      LIMIT ${candidateLimit}
    ), term_candidates AS MATERIALIZED (
      SELECT document.source_file_id,
             (
               50
               + (
                 SELECT count(*)::real
                 FROM unnest(${evidence.terms}::text[]) query_term(value)
                 WHERE query_term.value = ANY(document.exact_terms)
               ) * 10
             )::real AS family_score
      FROM focowiki.source_file_graph_term_documents document
      JOIN focowiki.generation_search_projection_refs reference
        ON reference.knowledge_base_id = document.knowledge_base_id
       AND reference.generation_id = ${input.generationId}
       AND reference.source_file_id = document.source_file_id
       AND reference.source_revision_id = document.source_revision_id
      JOIN focowiki.active_projection_records node
        ON node.knowledge_base_id = document.knowledge_base_id
       AND node.projection_kind = 'graph_node'
       AND node.source_file_id = document.source_file_id
      WHERE document.knowledge_base_id = ${input.knowledgeBaseId}
        AND document.tokenizer_contract_version = ${input.tokenizer.contractVersion}
        AND document.lexical_projection_version = ${GRAPH_LEXICAL_PROJECTION_VERSION}
        AND cardinality(${evidence.terms}::text[]) > 0
        AND document.exact_terms && ${evidence.terms}
      ORDER BY family_score DESC, document.source_file_id
      LIMIT ${candidateLimit}
    ), trigram_candidates AS MATERIALIZED (
      SELECT document.source_file_id,
             (
               35
               + focowiki.similarity(
                   document.lexical_text,
                   ${evidence.phrase}
                 ) * 20
             )::real AS family_score
      FROM focowiki.source_file_graph_term_documents document
      JOIN focowiki.generation_search_projection_refs reference
        ON reference.knowledge_base_id = document.knowledge_base_id
       AND reference.generation_id = ${input.generationId}
       AND reference.source_file_id = document.source_file_id
       AND reference.source_revision_id = document.source_revision_id
      JOIN focowiki.active_projection_records node
        ON node.knowledge_base_id = document.knowledge_base_id
       AND node.projection_kind = 'graph_node'
       AND node.source_file_id = document.source_file_id
      WHERE document.knowledge_base_id = ${input.knowledgeBaseId}
        AND document.tokenizer_contract_version = ${input.tokenizer.contractVersion}
        AND document.lexical_projection_version = ${GRAPH_LEXICAL_PROJECTION_VERSION}
        AND document.lexical_text
            OPERATOR(focowiki.%) ${evidence.phrase}
      ORDER BY family_score DESC, document.source_file_id
      LIMIT ${candidateLimit}
    ), bounded_candidates AS MATERIALIZED (
      SELECT candidate.source_file_id, max(candidate.family_score)::real AS family_score
      FROM (
        SELECT * FROM exact_candidates
        UNION ALL
        SELECT * FROM term_candidates
        UNION ALL
        SELECT * FROM trigram_candidates
      ) candidate
      GROUP BY candidate.source_file_id
      ORDER BY family_score DESC, candidate.source_file_id
      LIMIT ${candidateLimit}
    ), ranked_candidates AS MATERIALIZED (
      SELECT candidate.source_file_id,
             (
               candidate.family_score
               + CASE
                   WHEN lower(reference.title) = lower(${evidence.phrase}) THEN 100
                   WHEN strpos(lower(reference.title), lower(${evidence.phrase})) > 0 THEN 40
                   ELSE 0
                 END
               + CASE
                   WHEN lower(reference.logical_path) = lower(${evidence.phrase}) THEN 50
                   WHEN strpos(lower(reference.logical_path), lower(${evidence.phrase})) > 0 THEN 20
                   ELSE 0
                 END
               + features.token_coverage * 45
               + CASE WHEN features.phrase_match THEN 30 ELSE 0 END
               + features.text_similarity * 20
               + least(features.relationship_count, 10) * 0.5
             )::real AS score
      FROM bounded_candidates candidate
      JOIN focowiki.generation_search_projection_refs reference
        ON reference.knowledge_base_id = ${input.knowledgeBaseId}
       AND reference.generation_id = ${input.generationId}
       AND reference.source_file_id = candidate.source_file_id
      JOIN focowiki.source_file_graph_term_documents document
        ON document.knowledge_base_id = reference.knowledge_base_id
       AND document.source_file_id = reference.source_file_id
       AND document.source_revision_id = reference.source_revision_id
       AND document.tokenizer_contract_version = ${input.tokenizer.contractVersion}
       AND document.lexical_projection_version = ${GRAPH_LEXICAL_PROJECTION_VERSION}
      LEFT JOIN LATERAL (
        SELECT
          CASE
            WHEN cardinality(${evidence.terms}::text[]) = 0 THEN 0::real
            ELSE (
              SELECT count(*)::real
              FROM unnest(${evidence.terms}::text[]) query_term(value)
              WHERE query_term.value = ANY(document.exact_terms)
            ) / cardinality(${evidence.terms}::text[])
          END AS token_coverage,
          strpos(document.lexical_text, ${evidence.phrase}) > 0 AS phrase_match,
          focowiki.similarity(
            document.lexical_text,
            ${evidence.phrase}
          )::real AS text_similarity,
          (
            SELECT count(*)::int
            FROM focowiki.active_projection_records edge
            WHERE edge.knowledge_base_id = reference.knowledge_base_id
              AND edge.projection_kind = 'graph_edge'
              AND (
                edge.source_file_id = reference.source_file_id
                OR edge.related_source_file_id = reference.source_file_id
              )
          ) AS relationship_count
      ) features ON true
      WHERE cardinality(${evidence.terms}::text[]) <= 1
        OR features.phrase_match
        OR strpos(lower(reference.title), lower(${evidence.phrase})) > 0
        OR strpos(lower(reference.logical_path), lower(${evidence.phrase})) > 0
        OR features.token_coverage >= ${SEARCH_MULTI_TERM_MIN_COVERAGE}
    )
    SELECT reference.source_file_id, reference.logical_path,
           reference.title, reference.summary, candidate.score,
           node.payload_json || reference.metadata_json || jsonb_build_object(
             'fileId', file.file_id,
             'path', reference.logical_path,
             'matchType', 'graph_node',
             'sourceUrl', reference.source_url
           ) AS payload_json
    FROM ranked_candidates candidate
    JOIN focowiki.generation_search_projection_refs reference
      ON reference.knowledge_base_id = ${input.knowledgeBaseId}
     AND reference.generation_id = ${input.generationId}
     AND reference.source_file_id = candidate.source_file_id
    JOIN focowiki.active_projection_records node
      ON node.knowledge_base_id = reference.knowledge_base_id
     AND node.projection_kind = 'graph_node'
     AND node.source_file_id = reference.source_file_id
    JOIN focowiki.active_object_refs file
      ON file.knowledge_base_id = reference.knowledge_base_id
     AND file.source_file_id = reference.source_file_id
     AND file.ref_kind = 'page'
    JOIN focowiki.source_files source
      ON source.knowledge_base_id = reference.knowledge_base_id
     AND source.id = reference.source_file_id
     AND source.deleted_at IS NULL
     AND source.deletion_intent_id IS NULL
    WHERE (
      ${input.cursor?.score ?? null}::real IS NULL
      OR candidate.score < ${input.cursor?.score ?? null}
      OR (
        candidate.score = ${input.cursor?.score ?? null}
        AND reference.source_file_id > ${input.cursor?.recordId ?? null}
      )
    )
    ORDER BY candidate.score DESC, reference.source_file_id
    LIMIT ${input.limit + 1}
  `;
  const visible = rows.slice(0, input.limit);
  const last = visible.at(-1);
  return {
    items: visible.map((row) => ({
      generationId: input.generationId,
      projectionKind: "graph_node",
      recordId: row.source_file_id,
      sourceFileId: row.source_file_id,
      relatedSourceFileId: null,
      path: row.logical_path,
      parentPath: parentPath(row.logical_path),
      sortKey: row.logical_path,
      title: row.title,
      summary: row.summary,
      score: Number(row.score),
      payload: row.payload_json
    })),
    nextCursor: rows.length > input.limit && last
      ? { score: Number(last.score), recordId: last.source_file_id }
      : null
  };
}

function parentPath(path: string): string | null {
  const separator = path.lastIndexOf("/");
  return separator > 0 ? path.slice(0, separator) : null;
}
