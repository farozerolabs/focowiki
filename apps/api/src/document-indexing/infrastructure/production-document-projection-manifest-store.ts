import { createHash } from "node:crypto";
import type { StorageVnextImmutableObjectWriter } from
  "../../storage-vnext/ownership/immutable-object-writer.js";
import type { StorageVnextOwnershipRepository } from
  "../../storage-vnext/ownership/ports.js";
import type { DocumentKnowledgeProjectionManifest } from
  "../application/document-knowledge-projection-manifest.js";
import { canonicalDocumentProjectionJson } from
  "./document-knowledge-projection-support.js";
import {
  immutableArtifactWriteAttempt,
  ownerIdentity
} from "./production-document-identities.js";

export async function storeDocumentProjectionManifest(input: {
  manifest: DocumentKnowledgeProjectionManifest;
  objectWriter: StorageVnextImmutableObjectWriter;
  ownership: StorageVnextOwnershipRepository;
  signal: AbortSignal;
}) {
  const bytes = new TextEncoder().encode(
    canonicalDocumentProjectionJson(input.manifest)
  );
  const checksum = createHash("sha256").update(bytes).digest("hex");
  const stored = await input.objectWriter.putVerified({
    bytes,
    objectFormat: "okf-generated-json-v1",
    writeAttemptPublicId: immutableArtifactWriteAttempt(
      input.manifest.documentJobPublicId,
      "knowledge-projection-manifest",
      checksum
    ),
    createdAt: input.manifest.projectedAt,
    signal: input.signal
  });
  await input.ownership.attach({
    publicId: ownerIdentity(
      input.manifest.sourceRevisionPublicId,
      `knowledge_projection:${stored.objectId}`
    ),
    knowledgeBaseId: input.manifest.knowledgeBaseId,
    objectId: stored.objectId,
    kind: "source_revision",
    ownerPublicId: input.manifest.sourceRevisionPublicId,
    createdAt: input.manifest.projectedAt
  });
  return {
    key: "closure",
    outputFingerprintSha256: checksum,
    value: {
      schemaVersion: "document-knowledge-projection-receipt-v1",
      manifest: {
        objectId: stored.objectId,
        storageKey: stored.storageKey,
        checksumSha256: stored.checksum,
        byteCount: stored.byteCount,
        contentType: stored.contentType,
        objectFormat: stored.objectFormat
      }
    },
    serviceEndedAt: input.manifest.projectedAt
  };
}
