import { createHash } from "node:crypto";
import type { StorageVnextImmutableObjectWriter } from
  "../../storage-vnext/ownership/immutable-object-writer.js";
import type { StorageVnextOwnershipRepository } from
  "../../storage-vnext/ownership/ports.js";
import type { ClaimedDocumentArtifactWork } from
  "../application/document-work-port.js";
import type { AffectedDocumentSource } from
  "../application/document-affected-source-pages.js";
import type { createDocumentPreparedSourceLoader } from
  "./document-prepared-source-loader.js";
import type { createDocumentFirstLayerSourceLoader } from
  "./document-first-layer-source-loader.js";
import type { createPostgresDocumentGeneratedContext } from
  "./postgres-document-generated-context.js";
import type { createPostgresDocumentWorkContext } from
  "./postgres-document-work-context.js";
import type { createPostgresGeneratedPageBaseRepository } from
  "./postgres-generated-page-base-repository.js";
import {
  immutableArtifactWriteAttempt,
  ownerIdentity
} from "./production-document-identities.js";

export type DocumentPageBaseSnapshot = AffectedDocumentSource & {
  schemaVersion: "document-page-base-v1";
};

export function createProductionDocumentPageBase(input: {
  contexts: ReturnType<typeof createPostgresDocumentWorkContext>;
  preparedSources: ReturnType<typeof createDocumentPreparedSourceLoader>;
  firstLayers: ReturnType<typeof createDocumentFirstLayerSourceLoader>;
  generatedContext: ReturnType<typeof createPostgresDocumentGeneratedContext>;
  bases: ReturnType<typeof createPostgresGeneratedPageBaseRepository>;
  objectWriter: StorageVnextImmutableObjectWriter;
  ownership: StorageVnextOwnershipRepository;
  now?: () => string;
}) {
  const clock = input.now ?? (() => new Date().toISOString());
  return async (request: {
    claimed: ClaimedDocumentArtifactWork;
    signal: AbortSignal;
  }): Promise<{ publicId: string; snapshot: DocumentPageBaseSnapshot }> => {
    const [context, prepared, firstLayer, semanticEntities] = await Promise.all([
      input.contexts.read(request.claimed),
      input.preparedSources({ claimed: request.claimed, signal: request.signal }),
      input.firstLayers({ claimed: request.claimed, signal: request.signal }),
      input.generatedContext.readRevisionSemanticEntities({
        knowledgeBaseId: request.claimed.knowledgeBaseId,
        sourceRevisionPublicId: request.claimed.sourceRevisionPublicId,
        limit: 1_000
      })
    ]);
    const snapshot: DocumentPageBaseSnapshot = {
      schemaVersion: "document-page-base-v1",
      sourceFilePublicId: request.claimed.sourceFilePublicId,
      sourceRevisionPublicId: request.claimed.sourceRevisionPublicId,
      resourceRevision: context.source.resourceRevision,
      logicalPath: context.source.logicalPath,
      sourceLinkBaseLogicalPath: prepared.sourceLinkBaseLogicalPath,
      title: prepared.resolvedMetadata.title,
      body: prepared.body,
      metadata: prepared.resolvedMetadata,
      sourceMetadata: prepared.parsedMetadata,
      modelSuggestions: firstLayer.suggestions,
      checksumSha256: context.source.checksumSha256,
      byteCount: context.source.byteCount,
      contentType: context.source.contentType,
      semanticEntities
    };
    const bytes = new TextEncoder().encode(canonicalJson(snapshot));
    const fingerprint = createHash("sha256").update(bytes).digest("hex");
    const stored = await input.objectWriter.putVerified({
      bytes,
      objectFormat: "okf-generated-json-v1",
      writeAttemptPublicId: immutableArtifactWriteAttempt(
        request.claimed.documentJobPublicId,
        "generated-page-base",
        fingerprint
      ),
      createdAt: clock(),
      signal: request.signal
    });
    await input.ownership.attach({
      publicId: ownerIdentity(
        request.claimed.sourceRevisionPublicId,
        `generated_page_base:${stored.objectId}`
      ),
      knowledgeBaseId: request.claimed.knowledgeBaseId,
      objectId: stored.objectId,
      kind: "source_revision",
      ownerPublicId: request.claimed.sourceRevisionPublicId,
      createdAt: clock()
    });
    const publicId = await input.bases.store({
      knowledgeBaseId: request.claimed.knowledgeBaseId,
      sourceFilePublicId: request.claimed.sourceFilePublicId,
      sourceRevisionPublicId: request.claimed.sourceRevisionPublicId,
      inputFingerprintSha256: fingerprint,
      objectId: stored.objectId,
      checksumSha256: stored.checksum
    });
    return { publicId, snapshot };
  };
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => left.localeCompare(right, "en"))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
    .join(",")}}`;
}
