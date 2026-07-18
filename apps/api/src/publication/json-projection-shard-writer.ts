import { createHash } from "node:crypto";
import type { GenerationObjectReferenceRepository } from "../application/ports/generation-object-reference-repository.js";
import type { ProjectionShardRepository } from "../application/ports/projection-shard-repository.js";
import { PUBLICATION_FORMAT_VERSION } from "../domain/generation.js";
import type { StorageAdapter } from "../storage/s3.js";
import type { ImmutableObjectWriteResult } from "./immutable-object-writer.js";
import { createGeneratedFileId } from "../domain/generated-file-id.js";

export type JsonProjectionRecord = {
  id: string;
  [key: string]: unknown;
};

type JsonProjectionShardChange = {
  recordId: string;
  record: JsonProjectionRecord | null;
};

export function createJsonProjectionShardWriter(input: {
  references: GenerationObjectReferenceRepository;
  shards: ProjectionShardRepository;
  immutableObjects: {
    write: (input: {
      body: string | Uint8Array;
      contentType: string;
      formatVersion?: number;
    }) => Promise<ImmutableObjectWriteResult>;
  };
  storage: Pick<StorageAdapter, "getObjectText">;
  maxShardBytes: number;
}) {
  if (!Number.isSafeInteger(input.maxShardBytes) || input.maxShardBytes <= 0) {
    throw new Error("maxShardBytes must be a positive integer");
  }

  const applyBatch = async (change: {
      knowledgeBaseId: string;
      generationId: string;
      projectionKind: string;
      shardKey: string;
      logicalPath: string;
      changes: JsonProjectionShardChange[];
    }) => {
      if (change.changes.length === 0) {
        throw new Error("Projection shard batch must not be empty");
      }
      const staged = await input.references.findStagedByRef({
        knowledgeBaseId: change.knowledgeBaseId,
        generationId: change.generationId,
        refKind: "projection_shard",
        refKey: `${change.projectionKind}:${change.shardKey}`
      });
      const active = staged ?? await input.references.findActiveByRef({
        knowledgeBaseId: change.knowledgeBaseId,
        refKind: "projection_shard",
        refKey: `${change.projectionKind}:${change.shardKey}`
      });
      const records = active
        ? parseShard(await input.storage.getObjectText(active.objectKey, {
          maxBytes: input.maxShardBytes
        }))
        : [];
      const byId = new Map(records.map((record) => [record.id, record]));
      for (const recordChange of change.changes) {
        if (recordChange.record) {
          byId.set(recordChange.recordId, recordChange.record);
        } else {
          byId.delete(recordChange.recordId);
        }
      }
      const next = [...byId.values()].sort((left, right) =>
        left.id.localeCompare(right.id, "en")
      );
      if (next.length === 0) {
        await input.references.stageDelete({
          knowledgeBaseId: change.knowledgeBaseId,
          generationId: change.generationId,
          refKind: "projection_shard",
          refKey: `${change.projectionKind}:${change.shardKey}`,
          logicalPath: change.logicalPath,
          sourceFileId: null
        });
        return { deleted: true, recordCount: 0, reused: false };
      }

      const body = `${JSON.stringify({
        formatVersion: PUBLICATION_FORMAT_VERSION,
        projection: change.projectionKind,
        shard: change.shardKey,
        records: next
      })}\n`;
      if (Buffer.byteLength(body, "utf8") > input.maxShardBytes) {
        throw new Error("Projection shard exceeds the configured byte budget");
      }
      const object = await input.immutableObjects.write({
        body,
        contentType: "application/json; charset=utf-8"
      });
      const shard = await input.shards.register({
        id: projectionShardId({
          knowledgeBaseId: change.knowledgeBaseId,
          projectionKind: change.projectionKind,
          shardKey: change.shardKey,
          checksumSha256: object.checksumSha256
        }),
        knowledgeBaseId: change.knowledgeBaseId,
        projectionKind: change.projectionKind,
        shardKey: change.shardKey,
        formatVersion: object.formatVersion,
        checksumSha256: object.checksumSha256,
        objectKey: object.objectKey,
        recordCount: next.length,
        firstSortKey: next[0]?.id ?? null,
        lastSortKey: next.at(-1)?.id ?? null
      });
      await input.references.stageUpsert({
        knowledgeBaseId: change.knowledgeBaseId,
        generationId: change.generationId,
        refKind: "projection_shard",
        refKey: `${change.projectionKind}:${change.shardKey}`,
        fileId: createGeneratedFileId({
          refKind: "projection_shard",
          refKey: `${change.projectionKind}:${change.shardKey}`,
          sourceFileId: null
        }),
        checksumSha256: object.checksumSha256,
        formatVersion: object.formatVersion,
        logicalPath: change.logicalPath,
        sourceFileId: null,
        projectionShardId: shard.id
      });
      return { deleted: false, recordCount: next.length, reused: object.reused };
  };

  return {
    apply(change: {
      knowledgeBaseId: string;
      generationId: string;
      projectionKind: string;
      shardKey: string;
      recordId: string;
      record: JsonProjectionRecord | null;
      logicalPath: string;
    }) {
      return applyBatch({
        knowledgeBaseId: change.knowledgeBaseId,
        generationId: change.generationId,
        projectionKind: change.projectionKind,
        shardKey: change.shardKey,
        logicalPath: change.logicalPath,
        changes: [{ recordId: change.recordId, record: change.record }]
      });
    },
    applyBatch
  };
}

function parseShard(body: string | null): JsonProjectionRecord[] {
  if (!body) {
    throw new Error("Active projection shard object is unavailable");
  }
  const parsed: unknown = JSON.parse(body);
  if (!parsed || typeof parsed !== "object" || !Array.isArray((parsed as { records?: unknown }).records)) {
    throw new Error("Active projection shard is invalid");
  }
  const records = (parsed as { records: unknown[] }).records;
  if (records.some((record) => !record || typeof record !== "object" || typeof (record as { id?: unknown }).id !== "string")) {
    throw new Error("Active projection shard contains an invalid record");
  }
  return records as JsonProjectionRecord[];
}

function projectionShardId(input: {
  knowledgeBaseId: string;
  projectionKind: string;
  shardKey: string;
  checksumSha256: string;
}): string {
  return `projection-shard-${createHash("sha256")
    .update(`${input.knowledgeBaseId}\u0000${input.projectionKind}\u0000${input.shardKey}\u0000${input.checksumSha256}`)
    .digest("hex")
    .slice(0, 32)}`;
}
