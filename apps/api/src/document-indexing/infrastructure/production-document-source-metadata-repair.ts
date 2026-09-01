import type { S3Client } from "@aws-sdk/client-s3";
import type { RuntimeConfig } from "../../config.js";
import type { DatabaseClient } from "../../db/client.js";
import { createS3StorageVnextSourceBodyStore } from
  "../../storage-vnext/catalog/s3-source-body-store.js";
import { createDocumentSourceMetadataRepair } from
  "../application/document-source-metadata-repair.js";
import { createPostgresDocumentSourceMetadataRepository } from
  "./postgres-document-source-metadata.js";

const REPAIR_CONCURRENCY = 2;
const REPAIR_LEASE_MS = 30 * 60 * 1_000;
const IDLE_SCAN_MS = 30 * 1_000;

export function createProductionDocumentSourceMetadataRepair(input: {
  sql: DatabaseClient;
  config: RuntimeConfig;
  s3: S3Client;
}) {
  const repair = createDocumentSourceMetadataRepair({
    concurrency: REPAIR_CONCURRENCY,
    maximumSourceBytes: input.config.pagination.generatedContentMaxBytes,
    repository: createPostgresDocumentSourceMetadataRepository(input.sql),
    bodies: createS3StorageVnextSourceBodyStore({
      client: input.s3,
      bucket: input.config.storage.bucket,
      prefix: input.config.storage.prefix
    }),
    onFailure(event) {
      console.warn(JSON.stringify({
        timestamp: new Date().toISOString(),
        level: "warn",
        event: "worker.source_metadata_repair_deferred",
        fields: {
          knowledgeBaseId: event.claim.knowledgeBaseId,
          sourceFilePublicId: event.claim.sourceFilePublicId,
          sourceRevisionPublicId: event.claim.sourceRevisionPublicId,
          errorCode: event.safeErrorCode
        }
      }));
    }
  });
  let nextScanAt = 0;
  return {
    async run(request: { now: string; signal: AbortSignal }): Promise<void> {
      if (Date.parse(request.now) < nextScanAt) return;
      const result = await repair.runBatch({
        now: request.now,
        staleBefore: new Date(
          Date.parse(request.now) - REPAIR_LEASE_MS
        ).toISOString(),
        limit: REPAIR_CONCURRENCY,
        signal: request.signal
      });
      nextScanAt = result.claimed === 0
        ? Date.parse(request.now) + IDLE_SCAN_MS
        : Date.parse(request.now);
      if (result.claimed > 0) {
        console.info(JSON.stringify({
          timestamp: request.now,
          level: "info",
          event: "worker.source_metadata_repair_cycle",
          fields: result
        }));
      }
    }
  };
}
