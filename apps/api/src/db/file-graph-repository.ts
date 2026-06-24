import { randomUUID } from "node:crypto";
import type { OkfGraphEdge, OkfGraphNode } from "@focowiki/okf";
import type { DatabaseClient } from "./client.js";
import type {
  FileGraphJobRecord,
  FileGraphRelatedRecord,
  FileGraphRepository
} from "./admin-repositories.js";

type FileGraphNodeRow = {
  knowledge_base_id: string;
  source_file_id: string;
  path: string;
  title: string;
  type: string | null;
  description: string | null;
  summary: string | null;
  subjects_json: unknown;
  tags_json: unknown;
  entities_json: unknown;
  explicit_references_json: unknown;
  relationship_hints_json: unknown;
  headings_json: unknown;
  keywords_json: unknown;
  language: string | null;
  profile_version: string | null;
  profile_source: string | null;
  profile_json: unknown;
  metadata_json: unknown;
  updated_at: Date;
};

type FileGraphEdgeRow = {
  id: string;
  knowledge_base_id: string;
  from_source_file_id: string;
  to_source_file_id: string;
  relation_type: string;
  weight: string | number;
  reason: string;
  source: string;
  status: "accepted" | "rejected";
  evidence_json: unknown;
  updated_at: Date;
};

type FileGraphRelatedRow = {
  file_id: string;
  source_file_id: string;
  bundle_file_id: string | null;
  path: string;
  title: string;
  relation_type: string;
  direction: "outgoing" | "incoming";
  weight: string | number;
  reason: string;
  source: string;
  evidence_json: unknown;
  content_available: boolean;
};

type FileGraphJobRow = {
  id: string;
  knowledge_base_id: string;
  source_file_id: string;
  status: FileGraphJobRecord["status"];
  started_at: Date;
  ended_at: Date | null;
  error_code: string | null;
  created_at: Date;
};

export function createPostgresFileGraphRepository(sql: DatabaseClient): FileGraphRepository {
  return {
    async createGraphJob(input) {
      const rows = await sql<FileGraphJobRow[]>`
        INSERT INTO focowiki.source_file_graph_jobs (
          id,
          knowledge_base_id,
          source_file_id,
          status,
          started_at,
          ended_at,
          error_code
        )
        VALUES (
          ${input.id ?? createSourceFileGraphJobId()},
          ${input.knowledgeBaseId},
          ${input.sourceFileId},
          'running',
          ${input.startedAt},
          NULL,
          NULL
        )
        RETURNING id, knowledge_base_id, source_file_id, status, started_at, ended_at, error_code, created_at
      `;
      const row = rows[0];

      if (!row) {
        throw new Error("Graph job creation did not return a row");
      }

      return mapFileGraphJobRow(row);
    },
    async completeGraphJob(input) {
      const rows = await sql<FileGraphJobRow[]>`
        UPDATE focowiki.source_file_graph_jobs
        SET
          status = ${input.status},
          ended_at = ${input.endedAt},
          error_code = ${input.errorCode ?? null}
        WHERE id = ${input.id}
        RETURNING id, knowledge_base_id, source_file_id, status, started_at, ended_at, error_code, created_at
      `;
      const row = rows[0];
      return row ? mapFileGraphJobRow(row) : null;
    },
    async upsertGraphNode({ knowledgeBaseId, node }) {
      await sql`
        INSERT INTO focowiki.source_file_graph_nodes (
          knowledge_base_id,
          source_file_id,
          path,
          title,
          type,
          description,
          summary,
          subjects_json,
          tags_json,
          entities_json,
          explicit_references_json,
          relationship_hints_json,
          headings_json,
          keywords_json,
          language,
          profile_version,
          profile_source,
          profile_json,
          metadata_json,
          updated_at
        )
        VALUES (
          ${knowledgeBaseId},
          ${node.fileId},
          ${node.path},
          ${node.title},
          ${node.type ?? null},
          ${node.description ?? null},
          ${node.summary ?? null},
          ${sql.json((node.subjects ?? []) as never)},
          ${sql.json((node.tags ?? []) as never)},
          ${sql.json((node.entities ?? []) as never)},
          ${sql.json((node.explicitReferences ?? []) as never)},
          ${sql.json((node.relationshipHints ?? []) as never)},
          ${sql.json((node.headings ?? []) as never)},
          ${sql.json((node.keywords ?? []) as never)},
          ${node.language ?? null},
          ${node.profileVersion ?? null},
          ${node.profileSource ?? null},
          ${sql.json(readRecord(node.metadata?.contentProfile) as never)},
          ${sql.json((node.metadata ?? {}) as never)},
          now()
        )
        ON CONFLICT (knowledge_base_id, source_file_id)
        DO UPDATE SET
          path = EXCLUDED.path,
          title = EXCLUDED.title,
          type = EXCLUDED.type,
          description = EXCLUDED.description,
          summary = EXCLUDED.summary,
          subjects_json = EXCLUDED.subjects_json,
          tags_json = EXCLUDED.tags_json,
          entities_json = EXCLUDED.entities_json,
          explicit_references_json = EXCLUDED.explicit_references_json,
          relationship_hints_json = EXCLUDED.relationship_hints_json,
          headings_json = EXCLUDED.headings_json,
          keywords_json = EXCLUDED.keywords_json,
          language = EXCLUDED.language,
          profile_version = EXCLUDED.profile_version,
          profile_source = EXCLUDED.profile_source,
          profile_json = EXCLUDED.profile_json,
          metadata_json = EXCLUDED.metadata_json,
          updated_at = now()
      `;
    },
    async upsertGraphEdges({ knowledgeBaseId, edges }) {
      for (const edge of edges) {
        await sql`
          INSERT INTO focowiki.source_file_graph_edges (
            id,
            knowledge_base_id,
            from_source_file_id,
            to_source_file_id,
            relation_type,
            weight,
            reason,
            source,
            status,
            evidence_json,
            updated_at
          )
          VALUES (
            ${createSourceFileGraphEdgeId()},
            ${knowledgeBaseId},
            ${edge.fromFileId},
            ${edge.toFileId},
            ${edge.relationType},
            ${edge.weight},
            ${edge.reason},
            ${edge.source},
            'accepted',
            ${sql.json((edge.evidence ?? {}) as never)},
            now()
          )
          ON CONFLICT (knowledge_base_id, from_source_file_id, to_source_file_id, relation_type)
          DO UPDATE SET
            weight = EXCLUDED.weight,
            reason = EXCLUDED.reason,
            source = EXCLUDED.source,
            status = 'accepted',
            evidence_json = EXCLUDED.evidence_json,
            updated_at = now()
        `;
      }
    },
    async upsertRejectedGraphEdges({ knowledgeBaseId, edges }) {
      for (const edge of edges) {
        await sql`
          INSERT INTO focowiki.source_file_graph_edges (
            id,
            knowledge_base_id,
            from_source_file_id,
            to_source_file_id,
            relation_type,
            weight,
            reason,
            source,
            status,
            evidence_json,
            updated_at
          )
          VALUES (
            ${createSourceFileGraphEdgeId()},
            ${knowledgeBaseId},
            ${edge.fromFileId},
            ${edge.toFileId},
            ${edge.relationType},
            ${edge.weight},
            ${edge.reason},
            ${edge.source},
            'rejected',
            ${sql.json((edge.evidence ?? {}) as never)},
            now()
          )
          ON CONFLICT (knowledge_base_id, from_source_file_id, to_source_file_id, relation_type)
          DO UPDATE SET
            weight = EXCLUDED.weight,
            reason = EXCLUDED.reason,
            source = EXCLUDED.source,
            status = 'rejected',
            evidence_json = EXCLUDED.evidence_json,
            updated_at = now()
        `;
      }
    },
    async listGraphNodes({ knowledgeBaseId, limit, cursor }) {
      const cursorValue = cursor ? parseGraphIdCursor(cursor) : null;
      const rows = cursorValue
        ? await sql<FileGraphNodeRow[]>`
            SELECT knowledge_base_id, source_file_id, path, title, type, description, summary, subjects_json, tags_json, entities_json, explicit_references_json, relationship_hints_json, headings_json, keywords_json, language, profile_version, profile_source, profile_json, metadata_json, updated_at
            FROM focowiki.source_file_graph_nodes
            WHERE knowledge_base_id = ${knowledgeBaseId}
              AND source_file_id > ${cursorValue.id}
            ORDER BY source_file_id ASC
            LIMIT ${limit + 1}
          `
        : await sql<FileGraphNodeRow[]>`
            SELECT knowledge_base_id, source_file_id, path, title, type, description, summary, subjects_json, tags_json, entities_json, explicit_references_json, relationship_hints_json, headings_json, keywords_json, language, profile_version, profile_source, profile_json, metadata_json, updated_at
            FROM focowiki.source_file_graph_nodes
            WHERE knowledge_base_id = ${knowledgeBaseId}
            ORDER BY source_file_id ASC
            LIMIT ${limit + 1}
          `;
      const pageRows = rows.slice(0, limit);
      const lastRow = pageRows.at(-1);

      return {
        items: pageRows.map(mapFileGraphNodeRow),
        nextCursor:
          rows.length > limit && lastRow
            ? serializeGraphIdCursor({ id: lastRow.source_file_id })
            : null
      };
    },
    async listGraphEdges({ knowledgeBaseId, limit, cursor }) {
      const cursorValue = cursor ? parseGraphIdCursor(cursor) : null;
      const rows = cursorValue
        ? await sql<FileGraphEdgeRow[]>`
            SELECT id, knowledge_base_id, from_source_file_id, to_source_file_id, relation_type, weight, reason, source, status, evidence_json, updated_at
            FROM focowiki.source_file_graph_edges
            WHERE knowledge_base_id = ${knowledgeBaseId}
              AND status = 'accepted'
              AND id > ${cursorValue.id}
            ORDER BY id ASC
            LIMIT ${limit + 1}
          `
        : await sql<FileGraphEdgeRow[]>`
            SELECT id, knowledge_base_id, from_source_file_id, to_source_file_id, relation_type, weight, reason, source, status, evidence_json, updated_at
            FROM focowiki.source_file_graph_edges
            WHERE knowledge_base_id = ${knowledgeBaseId}
              AND status = 'accepted'
            ORDER BY id ASC
            LIMIT ${limit + 1}
          `;
      const pageRows = rows.slice(0, limit);
      const lastRow = pageRows.at(-1);

      return {
        items: pageRows.map(mapFileGraphEdgeRow),
        nextCursor:
          rows.length > limit && lastRow ? serializeGraphIdCursor({ id: lastRow.id }) : null
      };
    },
    async listGraphNeighborhood({ knowledgeBaseId, sourceFileId, limit, cursor }) {
      const cursorValue = cursor ? parseGraphRelationCursor(cursor) : null;
      const rows = cursorValue
        ? await sql<FileGraphRelatedRow[]>`
            ${graphNeighborhoodSql(knowledgeBaseId, sourceFileId)}
            WHERE relationships.weight < ${cursorValue.weight}
               OR (relationships.weight = ${cursorValue.weight} AND node.source_file_id > ${cursorValue.fileId})
            ORDER BY relationships.weight DESC, node.source_file_id ASC
            LIMIT ${limit + 1}
          `
        : await sql<FileGraphRelatedRow[]>`
            ${graphNeighborhoodSql(knowledgeBaseId, sourceFileId)}
            ORDER BY relationships.weight DESC, node.source_file_id ASC
            LIMIT ${limit + 1}
          `;
      const pageRows = rows.slice(0, limit);
      const lastRow = pageRows.at(-1);

      return {
        items: pageRows.map(mapFileGraphRelatedRow),
        nextCursor:
          rows.length > limit && lastRow
            ? serializeGraphRelationCursor({
                weight: Number(lastRow.weight),
                fileId: lastRow.file_id
              })
            : null
      };
    },
    async listGraphCandidates({ knowledgeBaseId, sourceFileId, terms, limit }) {
      const cleanTerms = uniqueStrings(terms).slice(0, 100);

      if (cleanTerms.length === 0 || limit <= 0) {
        return [];
      }

      const lowerTerms = cleanTerms.map((term) => term.toLowerCase());
      const likeTerms = lowerTerms.map((term) => `%${escapeLikePattern(term)}%`);
      const rows = await sql<FileGraphNodeRow[]>`
        SELECT knowledge_base_id, source_file_id, path, title, type, description, summary, subjects_json, tags_json, entities_json, explicit_references_json, relationship_hints_json, headings_json, keywords_json, language, profile_version, profile_source, profile_json, metadata_json, updated_at
        FROM focowiki.source_file_graph_nodes
        WHERE knowledge_base_id = ${knowledgeBaseId}
          AND source_file_id <> ${sourceFileId}
          AND (
            lower(title) LIKE ANY(${likeTerms})
            OR lower(coalesce(description, '')) LIKE ANY(${likeTerms})
            OR lower(coalesce(summary, '')) LIKE ANY(${likeTerms})
            OR subjects_json ?| ${cleanTerms}
            OR tags_json ?| ${cleanTerms}
            OR entities_json ?| ${cleanTerms}
            OR keywords_json ?| ${cleanTerms}
          )
        ORDER BY (
          CASE WHEN lower(title) = ANY(${lowerTerms}) THEN 100 ELSE 0 END
          + CASE WHEN lower(title) LIKE ANY(${likeTerms}) THEN 40 ELSE 0 END
          + CASE WHEN lower(coalesce(description, '')) LIKE ANY(${likeTerms}) THEN 20 ELSE 0 END
          + CASE WHEN lower(coalesce(summary, '')) LIKE ANY(${likeTerms}) THEN 20 ELSE 0 END
          + CASE WHEN subjects_json ?| ${cleanTerms} THEN 25 ELSE 0 END
          + CASE WHEN tags_json ?| ${cleanTerms} THEN 15 ELSE 0 END
          + CASE WHEN entities_json ?| ${cleanTerms} THEN 25 ELSE 0 END
          + CASE WHEN keywords_json ?| ${cleanTerms} THEN 20 ELSE 0 END
        ) DESC,
        updated_at DESC,
        source_file_id ASC
        LIMIT ${limit}
      `;

      return rows.map(mapFileGraphNodeRow);
    },
    async getGraphSummary({ knowledgeBaseId, sourceFileId, limit }) {
      const countRows = await sql<Array<{ relationship_count: number | string }>>`
        SELECT count(*)::int AS relationship_count
        FROM focowiki.source_file_graph_edges
        WHERE knowledge_base_id = ${knowledgeBaseId}
          AND status = 'accepted'
          AND (
            from_source_file_id = ${sourceFileId}
            OR to_source_file_id = ${sourceFileId}
          )
      `;
      const rows = await sql<FileGraphRelatedRow[]>`
        ${graphNeighborhoodSql(knowledgeBaseId, sourceFileId)}
        ORDER BY relationships.weight DESC, node.source_file_id ASC
        LIMIT ${limit}
      `;

      return {
        sourceFileId,
        relationshipCount: Number(countRows[0]?.relationship_count ?? 0),
        relationships: rows.map(mapFileGraphRelatedRow)
      };
    },
    async deleteGraphForSourceFile({ knowledgeBaseId, sourceFileId }) {
      await sql.begin(async (transaction) => {
        await transaction`
          DELETE FROM focowiki.source_file_graph_edges
          WHERE knowledge_base_id = ${knowledgeBaseId}
            AND (
              from_source_file_id = ${sourceFileId}
              OR to_source_file_id = ${sourceFileId}
            )
        `;
        await transaction`
          DELETE FROM focowiki.source_file_graph_nodes
          WHERE knowledge_base_id = ${knowledgeBaseId}
            AND source_file_id = ${sourceFileId}
        `;
        await transaction`
          DELETE FROM focowiki.source_file_graph_jobs
          WHERE knowledge_base_id = ${knowledgeBaseId}
            AND source_file_id = ${sourceFileId}
        `;
      });
    }
  };

  function graphNeighborhoodSql(knowledgeBaseId: string, sourceFileId: string) {
    return sql`
      WITH active_release AS (
        SELECT active_release_id
        FROM focowiki.knowledge_bases
        WHERE id = ${knowledgeBaseId}
          AND deleted_at IS NULL
        LIMIT 1
      ),
      relationships AS (
        SELECT
          edge.to_source_file_id AS related_source_file_id,
          edge.relation_type,
          'outgoing'::text AS direction,
          edge.weight,
          edge.reason,
          edge.source,
          edge.evidence_json
        FROM focowiki.source_file_graph_edges edge
        WHERE edge.knowledge_base_id = ${knowledgeBaseId}
          AND edge.status = 'accepted'
          AND edge.from_source_file_id = ${sourceFileId}
        UNION ALL
        SELECT
          edge.from_source_file_id AS related_source_file_id,
          edge.relation_type,
          'incoming'::text AS direction,
          edge.weight,
          edge.reason,
          edge.source,
          edge.evidence_json
        FROM focowiki.source_file_graph_edges edge
        WHERE edge.knowledge_base_id = ${knowledgeBaseId}
          AND edge.status = 'accepted'
          AND edge.to_source_file_id = ${sourceFileId}
      )
      SELECT
        node.source_file_id AS file_id,
        node.source_file_id,
        bundle.id AS bundle_file_id,
        COALESCE(bundle.logical_path, node.path) AS path,
        COALESCE(bundle.title, node.title) AS title,
        relationships.relation_type,
        relationships.direction::text AS direction,
        relationships.weight,
        relationships.reason,
        relationships.source,
        relationships.evidence_json,
        (bundle.id IS NOT NULL) AS content_available
      FROM relationships
      JOIN focowiki.source_file_graph_nodes node
        ON node.knowledge_base_id = ${knowledgeBaseId}
       AND node.source_file_id = relationships.related_source_file_id
      LEFT JOIN active_release release ON true
      LEFT JOIN focowiki.bundle_files bundle
        ON bundle.knowledge_base_id = ${knowledgeBaseId}
       AND bundle.release_id = release.active_release_id
       AND bundle.source_file_id = node.source_file_id
       AND bundle.file_kind = 'page'
    `;
  }
}

function createSourceFileGraphEdgeId(): string {
  return `graph-edge-${randomUUID()}`;
}

function createSourceFileGraphJobId(): string {
  return `graph-job-${randomUUID()}`;
}

function mapFileGraphNodeRow(row: FileGraphNodeRow): OkfGraphNode {
  return {
    fileId: row.source_file_id,
    path: row.path,
    title: row.title,
    ...(row.type ? { type: row.type } : {}),
    ...(row.description ? { description: row.description } : {}),
    ...(row.summary ? { summary: row.summary } : {}),
    subjects: readStringArray(row.subjects_json),
    tags: readStringArray(row.tags_json),
    entities: readStringArray(row.entities_json),
    explicitReferences: readStringArray(row.explicit_references_json),
    relationshipHints: readStringArray(row.relationship_hints_json),
    headings: readStringArray(row.headings_json),
    keywords: readStringArray(row.keywords_json),
    ...(row.language ? { language: row.language } : {}),
    ...(row.profile_version ? { profileVersion: row.profile_version } : {}),
    ...(row.profile_source ? { profileSource: row.profile_source } : {}),
    metadata: readRecord(row.metadata_json)
  };
}

function mapFileGraphEdgeRow(row: FileGraphEdgeRow): OkfGraphEdge {
  return {
    fromFileId: row.from_source_file_id,
    toFileId: row.to_source_file_id,
    relationType: row.relation_type,
    weight: Number(row.weight),
    reason: row.reason,
    source: row.source,
    evidence: readRecord(row.evidence_json)
  };
}

function mapFileGraphRelatedRow(row: FileGraphRelatedRow): FileGraphRelatedRecord {
  return {
    fileId: row.file_id,
    sourceFileId: row.source_file_id,
    bundleFileId: row.bundle_file_id,
    path: row.path,
    title: row.title,
    relationType: row.relation_type,
    direction: row.direction,
    weight: Number(row.weight),
    reason: row.reason,
    source: row.source,
    evidence: readRecord(row.evidence_json),
    contentAvailable: row.content_available
  };
}

function mapFileGraphJobRow(row: FileGraphJobRow): FileGraphJobRecord {
  return {
    id: row.id,
    knowledgeBaseId: row.knowledge_base_id,
    sourceFileId: row.source_file_id,
    status: row.status,
    startedAt: row.started_at.toISOString(),
    endedAt: row.ended_at?.toISOString() ?? null,
    errorCode: row.error_code,
    createdAt: row.created_at.toISOString()
  };
}

function serializeGraphIdCursor(cursor: { id: string }): string {
  return Buffer.from(JSON.stringify(cursor)).toString("base64url");
}

function parseGraphIdCursor(cursor: string): { id: string } {
  const candidate = parseCursorRecord(cursor);

  if (typeof candidate.id !== "string") {
    throw new Error("Invalid graph cursor");
  }

  return { id: candidate.id };
}

function serializeGraphRelationCursor(cursor: { weight: number; fileId: string }): string {
  return Buffer.from(JSON.stringify(cursor)).toString("base64url");
}

function parseGraphRelationCursor(cursor: string): { weight: number; fileId: string } {
  const candidate = parseCursorRecord(cursor);

  if (typeof candidate.weight !== "number" || typeof candidate.fileId !== "string") {
    throw new Error("Invalid graph relation cursor");
  }

  return {
    weight: candidate.weight,
    fileId: candidate.fileId
  };
}

function parseCursorRecord(cursor: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    throw new Error("Invalid cursor");
  }
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function readRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(
    new Set(values.map((value) => value.trim()).filter((value) => value.length > 0))
  );
}

function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}
