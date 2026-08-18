import type { TransactionSql } from "postgres";
import type { DatabaseClient } from "../../db/client.js";
import type { DocumentNavigationTerm } from
  "../application/document-navigation-terms.js";
import { classifyDocumentNavigationTerm } from
  "../application/document-term-routing.js";
import {
  assertRepositoryIdentity,
  assertRepositorySha256,
  repositoryContractError
} from "./document-repository-validation.js";

export type DocumentProjectionFactInput = Readonly<{
  knowledgeBaseId: string;
  sourceFilePublicId: string;
  sourceRevisionPublicId: string;
  logicalPath: string;
  normalizedPath: string;
  pagePath: string;
  title: string;
  summary: string;
  metadata: Readonly<Record<string, unknown>>;
  headings: readonly string[];
  entities: readonly string[];
  contentType: string;
  checksumSha256: string;
  byteCount: number;
  tokenizerContractVersion: string;
  navigationTermFingerprintSha256: string;
  navigationTerms: readonly DocumentNavigationTerm[];
  directoryPaths: readonly string[];
  incomingRelationshipCount: number;
  outgoingRelationshipCount: number;
}>;

export function createPostgresDocumentProjectionFacts(sql: DatabaseClient) {
  return {
    async replaceRevision(input: DocumentProjectionFactInput): Promise<void> {
      validateInput(input);
      await transaction(sql, async (tx) => {
        await tx`
          INSERT INTO focowiki.document_projection_records (
            knowledge_base_id, source_file_public_id,
            source_revision_public_id, logical_path, normalized_path,
            title, summary, metadata, headings, entities, content_type,
            checksum_sha256, byte_count, tokenizer_contract_version,
            navigation_term_fingerprint_sha256
          ) VALUES (
            ${input.knowledgeBaseId}, ${input.sourceFilePublicId},
            ${input.sourceRevisionPublicId}, ${input.logicalPath},
            ${input.normalizedPath}, ${input.title}, ${input.summary},
            ${tx.json(input.metadata as never)}, ${[...input.headings]},
            ${[...input.entities]}, ${input.contentType}, ${input.checksumSha256},
            ${input.byteCount}, ${input.tokenizerContractVersion},
            ${input.navigationTermFingerprintSha256}
          )
          ON CONFLICT (knowledge_base_id, source_revision_public_id) DO UPDATE
          SET logical_path = excluded.logical_path,
              normalized_path = excluded.normalized_path,
              title = excluded.title, summary = excluded.summary,
              metadata = excluded.metadata, headings = excluded.headings,
              entities = excluded.entities, content_type = excluded.content_type,
              checksum_sha256 = excluded.checksum_sha256,
              byte_count = excluded.byte_count,
              tokenizer_contract_version = excluded.tokenizer_contract_version,
              navigation_term_fingerprint_sha256 =
                excluded.navigation_term_fingerprint_sha256
          WHERE ROW(
            document_projection_records.logical_path,
            document_projection_records.normalized_path,
            document_projection_records.title,
            document_projection_records.summary,
            document_projection_records.metadata,
            document_projection_records.headings,
            document_projection_records.entities,
            document_projection_records.content_type,
            document_projection_records.checksum_sha256,
            document_projection_records.byte_count,
            document_projection_records.tokenizer_contract_version,
            document_projection_records.navigation_term_fingerprint_sha256
          ) IS DISTINCT FROM ROW(
            excluded.logical_path,
            excluded.normalized_path,
            excluded.title,
            excluded.summary,
            excluded.metadata,
            excluded.headings,
            excluded.entities,
            excluded.content_type,
            excluded.checksum_sha256,
            excluded.byte_count,
            excluded.tokenizer_contract_version,
            excluded.navigation_term_fingerprint_sha256
          )
        `;
        const terms = input.navigationTerms.map((item, index) => ({
          term: item.term,
          bucket: classifyDocumentNavigationTerm(item.term),
          priority: 1_000_000 - index,
          fields: [...item.fields]
        }));
        await tx`
          DELETE FROM focowiki.document_navigation_terms existing
          WHERE existing.knowledge_base_id = ${input.knowledgeBaseId}
            AND existing.source_revision_public_id = ${input.sourceRevisionPublicId}
            AND NOT EXISTS (
              SELECT 1
              FROM jsonb_to_recordset(${tx.json(terms as never)}::jsonb)
                AS desired(term text, bucket text, priority integer, fields text[])
              WHERE desired.term = existing.term
            )
        `;
        await tx`
          INSERT INTO focowiki.document_navigation_terms (
            knowledge_base_id, source_revision_public_id,
            term, bucket, priority
          )
          SELECT ${input.knowledgeBaseId}, ${input.sourceRevisionPublicId},
                 desired.term, desired.bucket, desired.priority
          FROM jsonb_to_recordset(${tx.json(terms as never)}::jsonb)
            AS desired(term text, bucket text, priority integer, fields text[])
          ON CONFLICT (knowledge_base_id, source_revision_public_id, term)
          DO UPDATE SET bucket = excluded.bucket, priority = excluded.priority
          WHERE ROW(
            document_navigation_terms.bucket,
            document_navigation_terms.priority
          ) IS DISTINCT FROM ROW(excluded.bucket, excluded.priority)
        `;
        await tx`
          INSERT INTO focowiki.document_navigation_postings (
            knowledge_base_id, source_revision_public_id, term,
            page_path, fields
          )
          SELECT ${input.knowledgeBaseId}, ${input.sourceRevisionPublicId},
                 desired.term, ${input.pagePath}, desired.fields
          FROM jsonb_to_recordset(${tx.json(terms as never)}::jsonb)
            AS desired(term text, bucket text, priority integer, fields text[])
          ON CONFLICT (knowledge_base_id, source_revision_public_id, term)
          DO UPDATE SET page_path = excluded.page_path, fields = excluded.fields
          WHERE ROW(
            document_navigation_postings.page_path,
            document_navigation_postings.fields
          ) IS DISTINCT FROM ROW(excluded.page_path, excluded.fields)
        `;
        const directories = [...new Set(input.directoryPaths)].sort();
        await tx`
          DELETE FROM focowiki.document_semantic_directory_memberships existing
          WHERE existing.knowledge_base_id = ${input.knowledgeBaseId}
            AND existing.source_revision_public_id = ${input.sourceRevisionPublicId}
            AND existing.directory_path NOT IN ${tx(directories)}
        `;
        await tx`
          INSERT INTO focowiki.document_semantic_directory_memberships (
            knowledge_base_id, source_revision_public_id,
            directory_path, page_path
          )
          SELECT ${input.knowledgeBaseId}, ${input.sourceRevisionPublicId},
                 desired.directory_path, ${input.pagePath}
          FROM unnest(${directories}::text[]) AS desired(directory_path)
          ON CONFLICT (knowledge_base_id, source_revision_public_id, directory_path)
          DO UPDATE SET page_path = excluded.page_path
          WHERE document_semantic_directory_memberships.page_path
            IS DISTINCT FROM excluded.page_path
        `;
        await tx`
          INSERT INTO focowiki.document_graph_degrees (
            knowledge_base_id, source_revision_public_id,
            incoming_count, outgoing_count
          ) VALUES (
            ${input.knowledgeBaseId}, ${input.sourceRevisionPublicId},
            ${input.incomingRelationshipCount}, ${input.outgoingRelationshipCount}
          )
          ON CONFLICT (knowledge_base_id, source_revision_public_id) DO UPDATE
          SET incoming_count = excluded.incoming_count,
              outgoing_count = excluded.outgoing_count,
              updated_at = now()
          WHERE ROW(
            document_graph_degrees.incoming_count,
            document_graph_degrees.outgoing_count
          ) IS DISTINCT FROM ROW(excluded.incoming_count, excluded.outgoing_count)
        `;
      });
    },

    async activateRevision(input: {
      knowledgeBaseId: string;
      sourceFilePublicId: string;
      sourceRevisionPublicId: string;
      now: string;
    }): Promise<void> {
      await sql`
        UPDATE focowiki.document_projection_records
        SET active = source_revision_public_id = ${input.sourceRevisionPublicId},
            retired_at = CASE
              WHEN source_revision_public_id = ${input.sourceRevisionPublicId}
              THEN NULL ELSE ${input.now}::timestamptz END
        WHERE knowledge_base_id = ${input.knowledgeBaseId}
          AND source_file_public_id = ${input.sourceFilePublicId}
          AND (active OR source_revision_public_id = ${input.sourceRevisionPublicId})
      `;
    }
  };
}

function validateInput(input: DocumentProjectionFactInput): void {
  assertRepositoryIdentity(input.knowledgeBaseId, "knowledge_base_id");
  assertRepositoryIdentity(input.sourceFilePublicId, "source_file_public_id");
  assertRepositoryIdentity(input.sourceRevisionPublicId, "source_revision_public_id");
  assertRepositorySha256(input.checksumSha256, "checksum");
  assertRepositorySha256(
    input.navigationTermFingerprintSha256,
    "navigation_term_fingerprint"
  );
  if (!input.logicalPath || !input.normalizedPath || !input.pagePath
    || !input.title || !input.contentType
    || !Number.isSafeInteger(input.byteCount) || input.byteCount < 0
    || !input.tokenizerContractVersion
    || input.navigationTerms.length > 256
    || input.directoryPaths.length < 1 || input.directoryPaths.length > 256
    || !Number.isSafeInteger(input.incomingRelationshipCount)
    || input.incomingRelationshipCount < 0
    || !Number.isSafeInteger(input.outgoingRelationshipCount)
    || input.outgoingRelationshipCount < 0) {
    throw repositoryContractError("document_projection_facts_invalid");
  }
}

function transaction<T>(
  sql: DatabaseClient,
  callback: (transactionSql: TransactionSql) => Promise<T>
): Promise<T> {
  return typeof sql.begin === "function"
    ? sql.begin(callback as never) as Promise<T>
    : callback(sql as unknown as TransactionSql);
}
