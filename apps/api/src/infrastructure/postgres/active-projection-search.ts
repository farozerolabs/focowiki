import type {
  ActiveGenerationPage,
  ActiveGenerationProjection,
  ActiveGenerationScoredCursor
} from "../../application/ports/active-generation-read-repository.js";
import type { SerializableJson } from "../../application/ports/source-dispatch-repository.js";
import type { DatabaseClient } from "../../db/client.js";
import type { TransactionSql } from "postgres";

type ReadSql = DatabaseClient | TransactionSql;

type SearchMode = "file" | "graph" | "hybrid";

type CandidateRow = {
  projection_kind: string;
  record_id: string;
};

type CandidateRetrieval = "exact" | "full_text" | "trigram";

type ProjectionRow = {
  projection_kind: string;
  record_id: string;
  source_file_id: string | null;
  related_source_file_id: string | null;
  logical_path: string | null;
  parent_path: string | null;
  sort_key: string | null;
  title: string | null;
  summary: string | null;
  score: number | null;
  payload_json: SerializableJson;
};

const SEARCH_CANDIDATE_MIN = 100;
const SEARCH_CANDIDATE_MAX = 2_000;
const SEARCH_CANDIDATE_MULTIPLIER = 10;

export async function searchActiveProjections(input: {
  sql: ReadSql;
  knowledgeBaseId: string;
  generationId: string;
  query: string;
  mode: SearchMode;
  limit: number;
  cursor: ActiveGenerationScoredCursor | null;
}): Promise<ActiveGenerationPage<ActiveGenerationProjection, ActiveGenerationScoredCursor>> {
  const query = input.query.trim();
  if (!query) return { items: [], nextCursor: null };
  const candidateLimit = Math.min(
    SEARCH_CANDIDATE_MAX,
    Math.max(SEARCH_CANDIDATE_MIN, input.limit * SEARCH_CANDIDATE_MULTIPLIER)
  );
  const retrievalInput = {
    sql: input.sql,
    knowledgeBaseId: input.knowledgeBaseId,
    query,
    mode: input.mode,
    candidateLimit
  };
  const candidatePages = await Promise.all([
    retrieveExactCandidates(retrievalInput),
    retrieveFullTextCandidates(retrievalInput),
    retrieveTrigramCandidates(retrievalInput)
  ]);
  const candidates = mergeCandidateIdentities(candidatePages.flat());
  if (candidates.length === 0) return { items: [], nextCursor: null };
  const rows = await hydrateSearchCandidates({
    ...input,
    query,
    candidates
  });
  return mapScoredPage(input.generationId, rows, input.limit);
}

export async function retrieveExactCandidates(input: {
  sql: ReadSql;
  knowledgeBaseId: string;
  query: string;
  mode: SearchMode;
  candidateLimit: number;
}): Promise<CandidateRow[]> {
  return retrieveCandidateFamilies(input, "exact");
}

export async function retrieveFullTextCandidates(input: {
  sql: ReadSql;
  knowledgeBaseId: string;
  query: string;
  mode: SearchMode;
  candidateLimit: number;
}): Promise<CandidateRow[]> {
  return retrieveCandidateFamilies(input, "full_text");
}

export async function retrieveTrigramCandidates(input: {
  sql: ReadSql;
  knowledgeBaseId: string;
  query: string;
  mode: SearchMode;
  candidateLimit: number;
}): Promise<CandidateRow[]> {
  return retrieveCandidateFamilies(input, "trigram");
}

async function retrieveCandidateFamilies(
  input: {
    sql: ReadSql;
    knowledgeBaseId: string;
    query: string;
    mode: SearchMode;
    candidateLimit: number;
  },
  retrieval: CandidateRetrieval
): Promise<CandidateRow[]> {
  const familyLimit = input.mode === "hybrid"
    ? Math.max(1, Math.ceil(input.candidateLimit / 2))
    : input.candidateLimit;
  const familyInput = { ...input, candidateLimit: familyLimit };
  const pages: Array<Promise<CandidateRow[]>> = [];
  if (input.mode === "file" || input.mode === "hybrid") {
    pages.push(retrieveFileCandidates(familyInput, retrieval));
  }
  if (input.mode === "graph" || input.mode === "hybrid") {
    pages.push(retrieveGraphCandidates(familyInput, retrieval));
  }
  return (await Promise.all(pages)).flat();
}

async function retrieveFileCandidates(
  input: {
    sql: ReadSql;
    knowledgeBaseId: string;
    query: string;
    candidateLimit: number;
  },
  retrieval: CandidateRetrieval
): Promise<CandidateRow[]> {
  if (retrieval === "exact") {
    return input.sql<CandidateRow[]>`
      SELECT record.projection_kind, record.record_id
      FROM focowiki.active_projection_records record
      WHERE record.knowledge_base_id = ${input.knowledgeBaseId}
        AND record.projection_kind = 'search'
        AND lower(coalesce(record.title, '')) = lower(${input.query})
      ORDER BY record.record_id
      LIMIT ${input.candidateLimit}
    `;
  }
  if (retrieval === "full_text") {
    return input.sql<CandidateRow[]>`
      WITH bounded_candidates AS MATERIALIZED (
        SELECT record.projection_kind, record.record_id
        FROM focowiki.active_projection_records record
        WHERE record.knowledge_base_id = ${input.knowledgeBaseId}
          AND record.projection_kind = 'search'
          AND to_tsvector('simple', coalesce(record.searchable_text, ''))
              @@ plainto_tsquery('simple', ${input.query})
        LIMIT ${input.candidateLimit}
      )
      SELECT projection_kind, record_id
      FROM bounded_candidates
      ORDER BY record_id
    `;
  }
  const pattern = `%${escapeLikePattern(input.query.toLocaleLowerCase("en-US"))}%`;
  return input.sql<CandidateRow[]>`
    WITH bounded_candidates AS MATERIALIZED (
      SELECT record.projection_kind, record.record_id
      FROM focowiki.active_projection_records record
      WHERE record.knowledge_base_id = ${input.knowledgeBaseId}
        AND record.projection_kind = 'search'
        AND lower(coalesce(record.searchable_text, ''))
            LIKE ${pattern} ESCAPE '\\'
      LIMIT ${input.candidateLimit}
    )
    SELECT projection_kind, record_id
    FROM bounded_candidates
    ORDER BY record_id
  `;
}

async function retrieveGraphCandidates(
  input: {
    sql: ReadSql;
    knowledgeBaseId: string;
    query: string;
    candidateLimit: number;
  },
  retrieval: CandidateRetrieval
): Promise<CandidateRow[]> {
  if (retrieval === "exact") {
    return input.sql<CandidateRow[]>`
      SELECT record.projection_kind, record.record_id
      FROM focowiki.active_projection_records record
      WHERE record.knowledge_base_id = ${input.knowledgeBaseId}
        AND record.projection_kind IN ('graph_node', 'graph_edge')
        AND lower(coalesce(record.title, '')) = lower(${input.query})
      ORDER BY record.projection_kind, record.record_id
      LIMIT ${input.candidateLimit}
    `;
  }
  if (retrieval === "full_text") {
    return input.sql<CandidateRow[]>`
      WITH bounded_candidates AS MATERIALIZED (
        SELECT record.projection_kind, record.record_id
        FROM focowiki.active_projection_records record
        WHERE record.knowledge_base_id = ${input.knowledgeBaseId}
          AND record.projection_kind IN ('graph_node', 'graph_edge')
          AND to_tsvector('simple', coalesce(record.searchable_text, ''))
              @@ plainto_tsquery('simple', ${input.query})
        LIMIT ${input.candidateLimit}
      )
      SELECT projection_kind, record_id
      FROM bounded_candidates
      ORDER BY projection_kind, record_id
    `;
  }
  const pattern = `%${escapeLikePattern(input.query.toLocaleLowerCase("en-US"))}%`;
  return input.sql<CandidateRow[]>`
    WITH bounded_candidates AS MATERIALIZED (
      SELECT record.projection_kind, record.record_id
      FROM focowiki.active_projection_records record
      WHERE record.knowledge_base_id = ${input.knowledgeBaseId}
        AND record.projection_kind IN ('graph_node', 'graph_edge')
        AND lower(coalesce(record.searchable_text, ''))
            LIKE ${pattern} ESCAPE '\\'
      LIMIT ${input.candidateLimit}
    )
    SELECT projection_kind, record_id
    FROM bounded_candidates
    ORDER BY projection_kind, record_id
  `;
}

async function hydrateSearchCandidates(input: {
  sql: ReadSql;
  knowledgeBaseId: string;
  query: string;
  candidates: CandidateRow[];
  limit: number;
  cursor: ActiveGenerationScoredCursor | null;
}): Promise<ProjectionRow[]> {
  const pattern = `%${escapeLikePattern(input.query)}%`;
  const kinds = input.candidates.map((candidate) => candidate.projection_kind);
  const ids = input.candidates.map((candidate) => candidate.record_id);
  return input.sql<ProjectionRow[]>`
    WITH candidate_ids AS MATERIALIZED (
      SELECT projection_kind, record_id
      FROM unnest(${kinds}::text[], ${ids}::text[])
        AS candidate(projection_kind, record_id)
    ), candidate_records AS MATERIALIZED (
      SELECT record.*
      FROM candidate_ids candidate
      JOIN focowiki.active_projection_records record
        ON record.knowledge_base_id = ${input.knowledgeBaseId}
       AND record.projection_kind = candidate.projection_kind
       AND record.record_id = candidate.record_id
    ), raw_candidates AS (
      SELECT record.projection_kind, record.record_id,
             record.source_file_id, record.related_source_file_id,
             file.logical_path, record.parent_path, record.sort_key,
             record.title, record.summary, record.searchable_text,
             record.payload_json || jsonb_build_object(
               'fileId', file.file_id,
               'path', file.logical_path,
               'matchType', CASE WHEN record.projection_kind = 'search'
                 THEN 'file_direct' ELSE 'graph_node' END
             ) AS payload_json
      FROM candidate_records record
      JOIN focowiki.active_object_refs file
        ON file.knowledge_base_id = record.knowledge_base_id
       AND file.source_file_id = record.source_file_id
       AND file.ref_kind = 'page'
      JOIN focowiki.source_files source
        ON source.id = record.source_file_id
       AND source.knowledge_base_id = record.knowledge_base_id
       AND source.deleted_at IS NULL
       AND source.deletion_intent_id IS NULL
      WHERE record.projection_kind IN ('search', 'graph_node')

      UNION ALL

      SELECT record.projection_kind,
             endpoint.source_file_id AS record_id,
             endpoint.source_file_id,
             endpoint.related_source_file_id,
             file.logical_path, NULL::text AS parent_path,
             file.logical_path AS sort_key, endpoint.title,
             record.summary, record.searchable_text,
             record.payload_json || jsonb_build_object(
               'fileId', file.file_id,
               'path', file.logical_path,
               'matchType', 'graph_edge',
               'graphEdgeId', record.record_id
             ) AS payload_json
      FROM candidate_records record
      CROSS JOIN LATERAL (
        VALUES
          (record.source_file_id, record.related_source_file_id, record.payload_json->>'fromTitle'),
          (record.related_source_file_id, record.source_file_id, record.payload_json->>'toTitle')
      ) AS endpoint(source_file_id, related_source_file_id, title)
      JOIN focowiki.active_object_refs file
        ON file.knowledge_base_id = record.knowledge_base_id
       AND file.source_file_id = endpoint.source_file_id
       AND file.ref_kind = 'page'
      JOIN focowiki.source_files source
        ON source.id = endpoint.source_file_id
       AND source.knowledge_base_id = record.knowledge_base_id
       AND source.deleted_at IS NULL
       AND source.deletion_intent_id IS NULL
      JOIN focowiki.source_files related
        ON related.id = endpoint.related_source_file_id
       AND related.knowledge_base_id = record.knowledge_base_id
       AND related.deleted_at IS NULL
       AND related.deletion_intent_id IS NULL
      WHERE record.projection_kind = 'graph_edge'
        AND endpoint.source_file_id IS NOT NULL
    ), scored AS (
      SELECT *, (
        CASE WHEN lower(coalesce(title, '')) = lower(${input.query}) THEN 100 ELSE 0 END
        + CASE WHEN coalesce(title, '') ILIKE ${pattern} ESCAPE '\\' THEN 40 ELSE 0 END
        + CASE WHEN coalesce(logical_path, '') ILIKE ${pattern} ESCAPE '\\' THEN 20 ELSE 0 END
        + ts_rank_cd(
            to_tsvector('simple', coalesce(searchable_text, '')),
            plainto_tsquery('simple', ${input.query})
          ) * 10
        + focowiki.similarity(lower(coalesce(searchable_text, '')), lower(${input.query}))
      )::real AS score
      FROM raw_candidates
    ), deduplicated AS (
      SELECT *, row_number() OVER (
        PARTITION BY source_file_id
        ORDER BY score DESC, projection_kind, record_id
      ) AS candidate_rank
      FROM scored
    )
    SELECT projection_kind, record_id, source_file_id,
           related_source_file_id, logical_path, parent_path,
           sort_key, title, summary, payload_json, score
    FROM deduplicated
    WHERE candidate_rank = 1
      AND (
        ${input.cursor?.score ?? null}::real IS NULL
        OR score < ${input.cursor?.score ?? null}
        OR (score = ${input.cursor?.score ?? null}
            AND record_id > ${input.cursor?.recordId ?? null})
      )
    ORDER BY score DESC, record_id
    LIMIT ${input.limit + 1}
  `;
}

function mergeCandidateIdentities(candidates: CandidateRow[]): CandidateRow[] {
  const seen = new Set<string>();
  const output: CandidateRow[] = [];
  for (const candidate of candidates) {
    const identity = `${candidate.projection_kind}\u0000${candidate.record_id}`;
    if (seen.has(identity)) continue;
    seen.add(identity);
    output.push(candidate);
  }
  return output;
}

function mapScoredPage(
  generationId: string,
  rows: ProjectionRow[],
  limit: number
): ActiveGenerationPage<ActiveGenerationProjection, ActiveGenerationScoredCursor> {
  const visible = rows.slice(0, limit);
  const last = visible.at(-1);
  return {
    items: visible.map((row) => ({
      generationId,
      projectionKind: row.projection_kind,
      recordId: row.record_id,
      sourceFileId: row.source_file_id,
      relatedSourceFileId: row.related_source_file_id,
      path: row.logical_path,
      parentPath: row.parent_path,
      sortKey: row.sort_key ?? "",
      title: row.title,
      summary: row.summary,
      score: row.score === null ? null : Number(row.score),
      payload: row.payload_json
    })),
    nextCursor: rows.length > limit && last
      ? { score: Number(last.score ?? 0), recordId: last.record_id }
      : null
  };
}

function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/gu, (character) => `\\${character}`);
}
