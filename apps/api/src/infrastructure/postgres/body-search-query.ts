import type {
  ActiveGenerationPage,
  ActiveGenerationProjection,
  ActiveGenerationScoredCursor
} from "../../application/ports/active-generation-read-repository.js";
import type { LexicalTokenizer } from "../../application/ports/lexical-tokenizer.js";
import type { SerializableJson } from "../../application/ports/source-dispatch-repository.js";
import type { DatabaseClient } from "../../db/client.js";
import {
  createSearchQueryEvidence,
  SEARCH_MULTI_TERM_MIN_COVERAGE
} from "../../search/search-query-evidence.js";
import type { TransactionSql } from "postgres";

type ReadSql = DatabaseClient | TransactionSql;

type BodySearchRow = {
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

export async function searchBodyProjection(input: {
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
  const tokenQuery = evidence.terms
    .map((term) => `"${term.replaceAll("\"", "")}"`)
    .join(" OR ");
  const hasTerms = evidence.terms.length > 0;
  const rows = await input.sql<BodySearchRow[]>`
    WITH exact_candidates AS MATERIALIZED (
      SELECT reference.source_file_id, 120::real AS family_score
      FROM focowiki.generation_search_projection_refs reference
      WHERE reference.knowledge_base_id = ${input.knowledgeBaseId}
        AND reference.generation_id = ${input.generationId}
        AND (
          lower(reference.title) = lower(${evidence.phrase})
          OR lower(reference.logical_path) = lower(${evidence.phrase})
        )
      ORDER BY reference.source_file_id
      LIMIT ${candidateLimit}
    ), token_segment_candidates AS MATERIALIZED (
      SELECT segment.document_id,
             max(ts_rank_cd(
               segment.lexical_vector,
               websearch_to_tsquery('simple', ${tokenQuery})
             ))::real AS rank_score
      FROM focowiki.search_projection_segments segment
      WHERE ${hasTerms}
        AND segment.knowledge_base_id = ${input.knowledgeBaseId}
        AND segment.lexical_vector
            @@ websearch_to_tsquery('simple', ${tokenQuery})
      GROUP BY segment.document_id
      ORDER BY rank_score DESC, segment.document_id
      LIMIT ${candidateLimit}
    ), token_candidates AS MATERIALIZED (
      SELECT reference.source_file_id,
             (
               55
               + max(segment.rank_score) * 30
             )::real AS family_score
      FROM token_segment_candidates segment
      JOIN focowiki.generation_search_projection_refs reference
        ON reference.knowledge_base_id = ${input.knowledgeBaseId}
       AND reference.search_document_id = segment.document_id
      WHERE reference.knowledge_base_id = ${input.knowledgeBaseId}
        AND reference.generation_id = ${input.generationId}
      GROUP BY reference.source_file_id
      ORDER BY family_score DESC, reference.source_file_id
      LIMIT ${candidateLimit}
    ), trigram_segment_candidates AS MATERIALIZED (
      SELECT segment.document_id,
             max(focowiki.similarity(
               lower(segment.normalized_text),
               lower(${evidence.phrase})
             ))::real AS similarity_score
      FROM focowiki.search_projection_segments segment
      WHERE segment.knowledge_base_id = ${input.knowledgeBaseId}
        AND lower(segment.normalized_text)
            OPERATOR(focowiki.%) lower(${evidence.phrase})
      GROUP BY segment.document_id
      ORDER BY similarity_score DESC, segment.document_id
      LIMIT ${candidateLimit}
    ), trigram_candidates AS MATERIALIZED (
      SELECT candidate.source_file_id, max(candidate.family_score)::real AS family_score
      FROM (
        (
          SELECT reference.source_file_id,
                 (
                   35
                   + greatest(
                       focowiki.similarity(lower(reference.title), lower(${evidence.phrase})),
                       focowiki.similarity(lower(reference.logical_path), lower(${evidence.phrase}))
                     ) * 20
                 )::real AS family_score
          FROM focowiki.generation_search_projection_refs reference
          WHERE reference.knowledge_base_id = ${input.knowledgeBaseId}
            AND reference.generation_id = ${input.generationId}
            AND (
              lower(reference.title) OPERATOR(focowiki.%) lower(${evidence.phrase})
              OR lower(reference.logical_path) OPERATOR(focowiki.%) lower(${evidence.phrase})
            )
          ORDER BY family_score DESC, reference.source_file_id
          LIMIT ${candidateLimit}
        )

        UNION ALL

        (
          SELECT reference.source_file_id,
                 (
                   30
                   + segment.similarity_score * 20
                 )::real AS family_score
          FROM trigram_segment_candidates segment
          JOIN focowiki.generation_search_projection_refs reference
            ON reference.knowledge_base_id = ${input.knowledgeBaseId}
           AND reference.generation_id = ${input.generationId}
           AND reference.search_document_id = segment.document_id
          WHERE reference.knowledge_base_id = ${input.knowledgeBaseId}
            AND reference.generation_id = ${input.generationId}
          ORDER BY family_score DESC, reference.source_file_id
          LIMIT ${candidateLimit}
        )
      ) candidate
      GROUP BY candidate.source_file_id
    ), bounded_candidates AS MATERIALIZED (
      SELECT candidate.source_file_id, max(candidate.family_score)::real AS family_score
      FROM (
        SELECT * FROM exact_candidates
        UNION ALL
        SELECT * FROM token_candidates
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
               + CASE WHEN features.body_phrase_match THEN 35 ELSE 0 END
               + CASE WHEN features.heading_phrase_match THEN 25 ELSE 0 END
               + features.token_coverage * 45
               + features.body_similarity * 20
             )::real AS score
      FROM bounded_candidates candidate
      JOIN focowiki.generation_search_projection_refs reference
        ON reference.knowledge_base_id = ${input.knowledgeBaseId}
       AND reference.generation_id = ${input.generationId}
       AND reference.source_file_id = candidate.source_file_id
      LEFT JOIN LATERAL (
        SELECT
          CASE
            WHEN cardinality(${evidence.terms}::text[]) = 0 THEN 0::real
            ELSE (
              SELECT count(*)::real
              FROM unnest(${evidence.terms}::text[]) query_term(value)
              WHERE EXISTS (
                SELECT 1
                FROM focowiki.search_projection_segments token_segment
                WHERE token_segment.knowledge_base_id = reference.knowledge_base_id
                  AND token_segment.document_id = reference.search_document_id
                  AND query_term.value = ANY(token_segment.tokens)
              )
            ) / cardinality(${evidence.terms}::text[])
          END AS token_coverage,
          coalesce(bool_or(
            strpos(lower(segment.normalized_text), lower(${evidence.phrase})) > 0
          ), false) AS body_phrase_match,
          coalesce(bool_or(
            segment.heading IS NOT NULL
            AND strpos(lower(segment.heading), lower(${evidence.phrase})) > 0
          ), false) AS heading_phrase_match,
          coalesce(max(focowiki.similarity(
            lower(segment.normalized_text),
            lower(${evidence.phrase})
          )), 0)::real AS body_similarity
        FROM focowiki.search_projection_segments segment
        WHERE segment.knowledge_base_id = reference.knowledge_base_id
          AND segment.document_id = reference.search_document_id
      ) features ON true
      WHERE cardinality(${evidence.terms}::text[]) <= 1
        OR features.body_phrase_match
        OR features.heading_phrase_match
        OR strpos(lower(reference.title), lower(${evidence.phrase})) > 0
        OR strpos(lower(reference.logical_path), lower(${evidence.phrase})) > 0
        OR features.token_coverage >= ${SEARCH_MULTI_TERM_MIN_COVERAGE}
    )
    SELECT reference.source_file_id, reference.logical_path,
           reference.title, reference.summary, candidate.score,
           reference.metadata_json || jsonb_build_object(
             'fileId', file.file_id,
             'path', reference.logical_path,
             'matchType', 'file_direct',
             'sourceUrl', reference.source_url
           ) AS payload_json
    FROM ranked_candidates candidate
    JOIN focowiki.generation_search_projection_refs reference
      ON reference.knowledge_base_id = ${input.knowledgeBaseId}
     AND reference.generation_id = ${input.generationId}
     AND reference.source_file_id = candidate.source_file_id
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
      projectionKind: "search",
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
