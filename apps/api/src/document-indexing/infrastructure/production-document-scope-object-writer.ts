import type { StorageVnextImmutableObjectWriter } from
  "../../storage-vnext/ownership/immutable-object-writer.js";
import type { StorageVnextOwnershipRepository } from
  "../../storage-vnext/ownership/ports.js";
import type { DocumentProjectionScopeClaim } from
  "../application/document-scope-projector-runtime.js";
import { scopeRenderError, writeAttemptId } from
  "./production-document-scope-renderer-support.js";

const PROJECTION_OBJECT_WRITE_BATCH_SIZE = 32;

export async function storeDocumentProjectionPages(input: Readonly<{
  objectWriter: StorageVnextImmutableObjectWriter;
  ownership?: StorageVnextOwnershipRepository;
  scope: DocumentProjectionScopeClaim;
  pages: readonly Readonly<{
    logicalPath: string;
    normalizedPath: string;
    entryKind: string;
    sourceFilePublicId: string | null;
    sourceRevisionPublicId: string | null;
    bytes: Uint8Array;
    checksumSha256: string;
    byteCount: number;
  }>[];
  signal: AbortSignal;
  clock(): string;
  checkpoint?(): Promise<void>;
}>) {
  const settled: PromiseSettledResult<Awaited<ReturnType<
    typeof writeProjectionPage>>>[] = [];
  for (let offset = 0; offset < input.pages.length;
    offset += PROJECTION_OBJECT_WRITE_BATCH_SIZE) {
    await input.checkpoint?.();
    input.signal.throwIfAborted();
    const batch = await Promise.allSettled(input.pages
      .slice(offset, offset + PROJECTION_OBJECT_WRITE_BATCH_SIZE)
      .map((page) => writeProjectionPage({ ...input, page })));
    settled.push(...batch);
    if (batch.some((item) => item.status === "rejected")) break;
  }
  const failed = settled.find((item) => item.status === "rejected");
  if (failed) {
    const releases = await Promise.allSettled(settled.flatMap((item) =>
      item.status === "fulfilled" && input.ownership
        ? [input.ownership.releaseVerifiedReservation({
            objectId: item.value.result.objectId,
            writeAttemptPublicId: item.value.writeAttemptPublicId
          })]
        : []));
    const releaseErrors = releases.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : []);
    if (releaseErrors.length > 0) {
      throw new AggregateError(
        [failed.reason, ...releaseErrors],
        "Projection render and verified reservation release failed"
      );
    }
    throw failed.reason;
  }
  return settled.map((item) => {
    if (item.status !== "fulfilled") throw item.reason;
    return item.value;
  });
}

async function writeProjectionPage(input: Readonly<{
  objectWriter: StorageVnextImmutableObjectWriter;
  ownership?: StorageVnextOwnershipRepository;
  scope: DocumentProjectionScopeClaim;
  page: Readonly<{
    logicalPath: string;
    normalizedPath: string;
    entryKind: string;
    sourceFilePublicId: string | null;
    sourceRevisionPublicId: string | null;
    bytes: Uint8Array;
    checksumSha256: string;
    byteCount: number;
  }>;
  signal: AbortSignal;
  clock(): string;
  checkpoint?(): Promise<void>;
}>) {
  await input.checkpoint?.();
  input.signal.throwIfAborted();
  const writeAttemptPublicId = writeAttemptId(
    input.scope,
    input.page.normalizedPath,
    input.page.checksumSha256
  );
  const result = await input.objectWriter.putVerified({
    bytes: input.page.bytes,
    objectFormat: input.page.normalizedPath.endsWith(".json")
      ? "okf-generated-json-v1" : "okf-generated-markdown-v1",
    writeAttemptPublicId,
    createdAt: input.clock(),
    retainVerifiedReservation: input.ownership !== undefined,
    signal: input.signal
  });
  if (result.checksum !== input.page.checksumSha256
    || result.byteCount !== input.page.byteCount) {
    throw scopeRenderError("projection_scope_object_mismatch");
  }
  return { page: input.page, result, writeAttemptPublicId };
}
