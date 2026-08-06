import { createHash } from "node:crypto";
import type {
  StorageVnextCatalogRepository,
  StorageVnextSourceRevisionFact
} from "./ports.js";
import type { StorageVnextImmutableBodyWriteResult } from
  "../ownership/s3-immutable-body-store.js";

type SourceRevisionCatalogPort = Pick<
  StorageVnextCatalogRepository,
  | "getSourceFile"
  | "getCurrentSourceRevision"
  | "createImmutableRevision"
  | "compareAndSetCurrentRevision"
>;

type SourceRevisionObjectWriterPort = {
  putVerified(input: {
    bytes: Uint8Array;
    objectFormat: "source-markdown-v1";
    writeAttemptPublicId: string;
    createdAt: string;
  }): Promise<StorageVnextImmutableBodyWriteResult>;
};

export type StorageVnextAcceptSourceRevisionRequest = {
  knowledgeBaseId: string;
  sourceFilePublicId: string;
  expectedRevision: number;
  bytes: Uint8Array;
  contentType: string;
  createdAt: string;
};

export type StorageVnextAcceptSourceRevisionResult = {
  outcome: "activated" | "reused";
  revision: StorageVnextSourceRevisionFact;
};

export async function acceptStorageVnextSourceRevision(input: {
  objectWriter: SourceRevisionObjectWriterPort;
  catalog: SourceRevisionCatalogPort;
  request: StorageVnextAcceptSourceRevisionRequest;
}): Promise<StorageVnextAcceptSourceRevisionResult> {
  if (input.request.contentType !== "text/markdown; charset=utf-8") {
    throw catalogError("invalid_input");
  }
  const checksum = createHash("sha256").update(input.request.bytes).digest("hex");
  const object = await input.objectWriter.putVerified({
    bytes: input.request.bytes,
    objectFormat: "source-markdown-v1",
    writeAttemptPublicId: createStorageVnextSourceWriteAttemptPublicId({
      knowledgeBaseId: input.request.knowledgeBaseId,
      sourceFilePublicId: input.request.sourceFilePublicId,
      checksum
    }),
    createdAt: input.request.createdAt
  });

  const sourceFile = await input.catalog.getSourceFile({
    knowledgeBaseId: input.request.knowledgeBaseId,
    publicId: input.request.sourceFilePublicId,
    visibility: "current"
  });
  if (!sourceFile) throw catalogError("scope_conflict");

  const current = await input.catalog.getCurrentSourceRevision({
    knowledgeBaseId: input.request.knowledgeBaseId,
    sourceFilePublicId: input.request.sourceFilePublicId
  });
  if (current && revisionMatchesObject(current, object)) {
    return { outcome: "reused", revision: current };
  }
  if (sourceFile.revision !== input.request.expectedRevision) {
    throw catalogError("revision_conflict");
  }

  const revision = await input.catalog.createImmutableRevision({
    publicId: createStorageVnextSourceRevisionPublicId({
      knowledgeBaseId: input.request.knowledgeBaseId,
      sourceFilePublicId: input.request.sourceFilePublicId,
      checksum: object.checksum
    }),
    sourceFilePublicId: input.request.sourceFilePublicId,
    knowledgeBaseId: input.request.knowledgeBaseId,
    objectId: object.objectId,
    checksum: object.checksum,
    byteCount: object.byteCount,
    contentType: object.contentType,
    createdAt: input.request.createdAt
  });

  try {
    await input.catalog.compareAndSetCurrentRevision({
      knowledgeBaseId: input.request.knowledgeBaseId,
      sourceFilePublicId: input.request.sourceFilePublicId,
      revisionPublicId: revision.publicId,
      revisionCheck: { expectedRevision: input.request.expectedRevision }
    });
    return { outcome: "activated", revision };
  } catch (error) {
    if (!hasCatalogErrorCode(error, "revision_conflict")) throw error;
    const racedCurrent = await input.catalog.getCurrentSourceRevision({
      knowledgeBaseId: input.request.knowledgeBaseId,
      sourceFilePublicId: input.request.sourceFilePublicId
    });
    if (racedCurrent && sameAcceptedRevision(racedCurrent, revision)) {
      return { outcome: "reused", revision: racedCurrent };
    }
    throw error;
  }
}

export function createStorageVnextSourceRevisionPublicId(input: {
  knowledgeBaseId: string;
  sourceFilePublicId: string;
  checksum: string;
}): string {
  const digest = createHash("sha256")
    .update("storage-vnext-source-revision-v1\0")
    .update(input.knowledgeBaseId)
    .update("\0")
    .update(input.sourceFilePublicId)
    .update("\0")
    .update(input.checksum)
    .digest("hex");
  return `source-revision-${digest}`;
}

export function createStorageVnextSourceWriteAttemptPublicId(input: {
  knowledgeBaseId: string;
  sourceFilePublicId: string;
  checksum: string;
}): string {
  const digest = createHash("sha256")
    .update("storage-vnext-source-write-v1\0")
    .update(input.knowledgeBaseId)
    .update("\0")
    .update(input.sourceFilePublicId)
    .update("\0")
    .update(input.checksum)
    .digest("hex");
  return `source-write-${digest}`;
}

function revisionMatchesObject(
  revision: StorageVnextSourceRevisionFact,
  object: StorageVnextImmutableBodyWriteResult
): boolean {
  return revision.objectId === object.objectId
    && revision.checksum === object.checksum
    && revision.byteCount === object.byteCount
    && revision.contentType === object.contentType;
}

function sameAcceptedRevision(
  left: StorageVnextSourceRevisionFact,
  right: StorageVnextSourceRevisionFact
): boolean {
  return left.publicId === right.publicId
    && left.knowledgeBaseId === right.knowledgeBaseId
    && left.sourceFilePublicId === right.sourceFilePublicId
    && left.objectId === right.objectId
    && left.checksum === right.checksum
    && left.byteCount === right.byteCount
    && left.contentType === right.contentType;
}

function hasCatalogErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error
    && "code" in error
    && error.code === code;
}

function catalogError(code: "invalid_input" | "scope_conflict" | "revision_conflict"): Error {
  return Object.assign(new Error(`Storage vNext source revision error: ${code}`), { code });
}
