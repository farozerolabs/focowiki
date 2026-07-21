import type { TransactionSql } from "postgres";
import type { ProjectionSegment } from "../../application/ports/projection-segment-repository.js";

export type ProjectionSegmentRegistrationInput = ProjectionSegment & {
  createdAt?: string;
};

export type RegisteredProjectionSegment = {
  requestedId: string;
  segment: ProjectionSegment;
};

type RegisteredSegmentRow = {
  input_index: number;
  requested_id: string;
  id: string;
  knowledge_base_id: string;
  projection_kind: string;
  logical_partition: string;
  segment_kind: ProjectionSegment["segmentKind"];
  sequence_number: number;
  format_version: number;
  checksum_sha256: string;
  object_key: string;
  logical_path: string;
  entry_count: number;
  encoded_bytes: number;
  first_record_identity: string | null;
  last_record_identity: string | null;
  base_segment_id: string | null;
  lifecycle_state: ProjectionSegment["lifecycleState"];
};

export async function registerProjectionSegmentsByIdentity(
  transaction: TransactionSql<Record<string, never>>,
  segments: ProjectionSegmentRegistrationInput[]
): Promise<RegisteredProjectionSegment[]> {
  if (segments.length === 0) return [];

  const records = segments.map((segment, inputIndex) => ({
    input_index: inputIndex,
    requested_id: segment.id,
    id: segment.id,
    knowledge_base_id: segment.knowledgeBaseId,
    projection_kind: segment.projectionKind,
    logical_partition: segment.logicalPartition,
    segment_kind: segment.segmentKind,
    sequence_number: segment.sequenceNumber,
    format_version: segment.formatVersion,
    checksum_sha256: segment.checksumSha256,
    object_key: segment.objectKey,
    logical_path: segment.logicalPath,
    entry_count: segment.entryCount,
    encoded_bytes: segment.encodedBytes,
    first_record_identity: segment.firstRecordIdentity,
    last_record_identity: segment.lastRecordIdentity,
    base_segment_id: segment.baseSegmentId,
    lifecycle_state: segment.lifecycleState,
    created_at: segment.createdAt ?? null
  }));

  await transaction`
    INSERT INTO focowiki.projection_segments (
      id, knowledge_base_id, projection_kind, logical_partition,
      segment_kind, sequence_number, format_version, checksum_sha256,
      object_key, logical_path, entry_count, encoded_bytes,
      first_record_identity, last_record_identity, base_segment_id,
      lifecycle_state, created_at
    )
    SELECT item.id, item.knowledge_base_id, item.projection_kind,
           item.logical_partition, item.segment_kind, item.sequence_number,
           item.format_version, item.checksum_sha256, item.object_key,
           item.logical_path, item.entry_count, item.encoded_bytes,
           item.first_record_identity, item.last_record_identity,
           item.base_segment_id, item.lifecycle_state,
           coalesce(item.created_at, now())
    FROM jsonb_to_recordset(${transaction.json(records as never)}) AS item(
      input_index integer, requested_id text, id text, knowledge_base_id text,
      projection_kind text, logical_partition text, segment_kind text,
      sequence_number integer, format_version integer, checksum_sha256 text,
      object_key text, logical_path text, entry_count integer,
      encoded_bytes bigint, first_record_identity text,
      last_record_identity text, base_segment_id text, lifecycle_state text,
      created_at timestamptz
    )
    ON CONFLICT DO NOTHING
  `;

  const resolved = await transaction<RegisteredSegmentRow[]>`
    SELECT item.input_index, item.requested_id,
           segment.id, segment.knowledge_base_id, segment.projection_kind,
           segment.logical_partition, segment.segment_kind,
           segment.sequence_number, segment.format_version,
           segment.checksum_sha256, segment.object_key, segment.logical_path,
           segment.entry_count, segment.encoded_bytes,
           segment.first_record_identity, segment.last_record_identity,
           segment.base_segment_id, segment.lifecycle_state
    FROM jsonb_to_recordset(${transaction.json(records.map((record) => ({
      input_index: record.input_index,
      requested_id: record.requested_id,
      knowledge_base_id: record.knowledge_base_id,
      projection_kind: record.projection_kind,
      logical_partition: record.logical_partition,
      segment_kind: record.segment_kind,
      sequence_number: record.sequence_number,
      checksum_sha256: record.checksum_sha256
    })) as never)}) AS item(
      input_index integer, requested_id text, knowledge_base_id text,
      projection_kind text, logical_partition text, segment_kind text,
      sequence_number integer, checksum_sha256 text
    )
    JOIN focowiki.projection_segments segment
      ON segment.knowledge_base_id = item.knowledge_base_id
     AND segment.projection_kind = item.projection_kind
     AND segment.logical_partition = item.logical_partition
     AND segment.segment_kind = item.segment_kind
     AND segment.sequence_number = item.sequence_number
     AND segment.checksum_sha256 = item.checksum_sha256
    ORDER BY item.input_index
  `;

  if (resolved.length !== segments.length) {
    throw new Error("Projection segment identity could not be resolved");
  }

  return resolved.map((row) => ({
    requestedId: row.requested_id,
    segment: mapSegment(row)
  }));
}

function mapSegment(row: RegisteredSegmentRow): ProjectionSegment {
  return {
    id: row.id,
    knowledgeBaseId: row.knowledge_base_id,
    projectionKind: row.projection_kind,
    logicalPartition: row.logical_partition,
    segmentKind: row.segment_kind,
    sequenceNumber: Number(row.sequence_number),
    formatVersion: Number(row.format_version),
    checksumSha256: row.checksum_sha256,
    objectKey: row.object_key,
    logicalPath: row.logical_path,
    entryCount: Number(row.entry_count),
    encodedBytes: Number(row.encoded_bytes),
    firstRecordIdentity: row.first_record_identity,
    lastRecordIdentity: row.last_record_identity,
    baseSegmentId: row.base_segment_id,
    lifecycleState: row.lifecycle_state
  };
}
