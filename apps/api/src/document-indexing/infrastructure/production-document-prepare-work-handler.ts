import { createHash } from "node:crypto";
import type { LexicalTokenizer } from
  "../../application/ports/lexical-tokenizer.js";
import type { StorageVnextImmutableObjectWriter } from
  "../../storage-vnext/ownership/immutable-object-writer.js";
import type { StorageVnextOwnershipRepository } from
  "../../storage-vnext/ownership/ports.js";
import type { DocumentSourceBodyReadPort } from
  "../application/document-source-preparation.js";
import {
  createDocumentSourcePreparation,
  type DocumentProfileArtifactStore
} from
  "../application/document-source-preparation.js";
import type { StorageVnextImmutableBodyStore } from
  "../../storage-vnext/ownership/s3-immutable-body-store.js";
import type { ClaimedDocumentArtifactWork } from
  "../application/document-work-port.js";
import {
  buildDocumentIdentityKeys,
  buildDocumentRelationCandidates
} from "../application/document-relation-candidates.js";
import { ownerIdentity, writeAttempt } from
  "./production-document-identities.js";
import { metadataAliases } from "./production-document-metadata.js";
import type { createPostgresDocumentReferenceFactRepository } from
  "./postgres-document-reference-fact-repository.js";
import type { createPostgresDocumentWorkContext } from
  "./postgres-document-work-context.js";
import type { createPostgresDocumentReceiptRepository } from
  "./postgres-document-receipt-repository.js";
import { loadReusableDocumentPreparedSource } from
  "./production-document-prepared-source-reuse.js";

export function createProductionDocumentPrepareWorkHandler(input: {
  contexts: ReturnType<typeof createPostgresDocumentWorkContext>;
  receipts: ReturnType<typeof createPostgresDocumentReceiptRepository>;
  bodyStore: DocumentSourceBodyReadPort;
  snapshotBodies: StorageVnextImmutableBodyStore;
  tokenizer: LexicalTokenizer;
  objectWriter: StorageVnextImmutableObjectWriter;
  ownership: StorageVnextOwnershipRepository;
  referenceFacts: ReturnType<typeof createPostgresDocumentReferenceFactRepository>;
  maximumSourceBytes: number;
  now?: () => string;
}) {
  const clock = input.now ?? (() => new Date().toISOString());
  return async (request: {
    claimed: ClaimedDocumentArtifactWork;
    signal: AbortSignal;
  }) => {
    const context = await input.contexts.read(request.claimed);
    const contentContractSha256 = hash([
      "document-content-profile-v1",
      input.tokenizer.contractVersion
    ]);
    const profiles: DocumentProfileArtifactStore = {
        async putVerifiedJson(profile) {
          const stored = await input.objectWriter.putVerified({
            bytes: profile.bytes,
            objectFormat: "okf-generated-json-v1",
            writeAttemptPublicId: writeAttempt(
              request.claimed.documentJobPublicId,
              profile.artifactKind
            ),
            createdAt: clock(),
            signal: profile.signal
          });
          await input.ownership.attach({
            publicId: ownerIdentity(
              request.claimed.sourceRevisionPublicId,
              `${profile.artifactKind}:${stored.objectId}`
            ),
            knowledgeBaseId: request.claimed.knowledgeBaseId,
            objectId: stored.objectId,
            kind: "source_revision",
            ownerPublicId: request.claimed.sourceRevisionPublicId,
            createdAt: clock()
          });
          return {
            objectId: stored.objectId,
            checksumSha256: stored.checksum,
            byteCount: stored.byteCount
          };
        }
      };
    const preparation = createDocumentSourcePreparation({
      bodyStore: input.bodyStore,
      tokenizer: input.tokenizer,
      profiles
    });
    const reusable = await loadReusableDocumentPreparedSource({
      operationKind: context.job.operationKind,
      knowledgeBaseId: request.claimed.knowledgeBaseId,
      priorActiveSourceRevisionPublicId:
        context.source.priorActiveSourceRevisionPublicId,
      currentSourceChecksumSha256: context.source.checksumSha256,
      currentSourceObjectId: context.source.objectId,
      currentContentContractSha256: contentContractSha256,
      currentLogicalPath: context.source.logicalPath,
      receipts: input.receipts,
      bodies: input.snapshotBodies,
      maximumSnapshotBytes: input.maximumSourceBytes * 3 + 2 * 1_048_576,
      signal: request.signal
    });
    const prepared = reusable
      ? await rebasePreparedSource({
          reusable,
          ownership: input.ownership,
          claimed: request.claimed,
          now: clock
        })
      : {
          ...await preparation({
            sourceFileName: context.source.logicalPath.split("/").at(-1)!,
            sourceLogicalPath: context.source.logicalPath,
            objectId: context.source.objectId,
            checksumSha256: context.source.checksumSha256,
            byteCount: context.source.byteCount,
            contentType: context.source.contentType,
            maximumSourceBytes: input.maximumSourceBytes,
            profileContractSha256: contentContractSha256,
            signal: request.signal
          }),
          sourceLinkBaseLogicalPath: context.source.logicalPath
        };
    const aliases = metadataAliases(prepared.parsedMetadata);
    const preparedSnapshotBytes = new TextEncoder().encode(canonicalJson({
      schemaVersion: "document-prepared-source-v1",
      sourceLinkBaseLogicalPath: prepared.sourceLinkBaseLogicalPath,
      body: prepared.body,
      metadata: prepared.metadata,
      parsedMetadata: prepared.parsedMetadata,
      resolvedMetadata: prepared.resolvedMetadata,
      contentProfile: prepared.contentProfile,
      structureProfile: prepared.structureProfile,
      referenceProfile: prepared.referenceProfile,
      artifacts: prepared.artifacts
    }));
    const preparedSnapshot = await input.objectWriter.putVerified({
      bytes: preparedSnapshotBytes,
      objectFormat: "okf-generated-json-v1",
      writeAttemptPublicId: writeAttempt(
        request.claimed.documentJobPublicId,
        "prepared_source"
      ),
      createdAt: clock(),
      signal: request.signal
    });
    await input.ownership.attach({
      publicId: ownerIdentity(
        request.claimed.sourceRevisionPublicId,
        `prepared_source:${preparedSnapshot.objectId}`
      ),
      knowledgeBaseId: request.claimed.knowledgeBaseId,
      objectId: preparedSnapshot.objectId,
      kind: "source_revision",
      ownerPublicId: request.claimed.sourceRevisionPublicId,
      createdAt: clock()
    });
    const identityKeys = buildDocumentIdentityKeys({
      logicalPath: context.source.logicalPath,
      title: prepared.resolvedMetadata.title,
      aliases
    });
    const deterministicReferences = buildDocumentRelationCandidates({
      sourceLogicalPath: context.source.logicalPath,
      references: prepared.referenceProfile.references,
      metadata: prepared.parsedMetadata,
      semanticCandidates: []
    });
    const referenceFactCount = await input.referenceFacts.replaceRevision({
      knowledgeBaseId: request.claimed.knowledgeBaseId,
      sourceFilePublicId: request.claimed.sourceFilePublicId,
      sourceRevisionPublicId: request.claimed.sourceRevisionPublicId,
      identityKeys,
      references: deterministicReferences
    });
    return {
      key: "source",
      outputFingerprintSha256: hash([
        contentContractSha256,
        prepared.artifacts.contentProfile.checksumSha256,
        prepared.artifacts.structureProfile.checksumSha256,
        prepared.artifacts.referenceProfile.checksumSha256,
        preparedSnapshot.checksum,
        ...identityKeys,
        String(referenceFactCount)
      ]),
      value: {
        schemaVersion: "document-prepared-receipt-v1",
        contentContractSha256,
        sourceObjectId: context.source.objectId,
        sourceChecksumSha256: context.source.checksumSha256,
        sourceLogicalPath: context.source.logicalPath,
        sourceLinkBaseLogicalPath: prepared.sourceLinkBaseLogicalPath,
        referenceFactCount,
        resolvedTitle: prepared.resolvedMetadata.title,
        preparedSnapshot: {
          objectId: preparedSnapshot.objectId,
          storageKey: preparedSnapshot.storageKey,
          checksumSha256: preparedSnapshot.checksum,
          byteCount: preparedSnapshot.byteCount,
          contentType: preparedSnapshot.contentType,
          objectFormat: preparedSnapshot.objectFormat
        },
        artifacts: prepared.artifacts
      },
      serviceEndedAt: clock()
    };
  };
}

async function rebasePreparedSource(input: {
  reusable: Awaited<ReturnType<typeof loadReusableDocumentPreparedSource>> & {};
  ownership: StorageVnextOwnershipRepository;
  claimed: ClaimedDocumentArtifactWork;
  now: () => string;
}) {
  const reusable = input.reusable;
  await Promise.all([
    { kind: "content_profile", profile: reusable.artifacts.contentProfile },
    { kind: "structure_profile", profile: reusable.artifacts.structureProfile },
    { kind: "reference_profile", profile: reusable.artifacts.referenceProfile }
  ].map(({ kind, profile }) => input.ownership.attach({
    publicId: ownerIdentity(
      input.claimed.sourceRevisionPublicId,
      `${kind}:${profile.objectId}`
    ),
    knowledgeBaseId: input.claimed.knowledgeBaseId,
    objectId: profile.objectId,
    kind: "source_revision",
    ownerPublicId: input.claimed.sourceRevisionPublicId,
    createdAt: input.now()
  })));
  return {
    body: reusable.body,
    metadata: reusable.metadata,
    parsedMetadata: reusable.parsedMetadata,
    resolvedMetadata: reusable.resolvedMetadata,
    sourceLinkBaseLogicalPath: reusable.sourceLinkBaseLogicalPath,
    contentProfile: reusable.contentProfile,
    structureProfile: reusable.structureProfile,
    referenceProfile: reusable.referenceProfile,
    artifacts: reusable.artifacts
  };
}

function hash(parts: readonly string[]): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right, "en"))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
    .join(",")}}`;
}
