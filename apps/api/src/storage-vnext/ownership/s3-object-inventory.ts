import {
  HeadObjectCommand,
  ListMultipartUploadsCommand,
  ListObjectsV2Command,
  ListObjectVersionsCommand,
  type S3Client
} from "@aws-sdk/client-s3";
import { isS3VersionListingUnsupported } from "../../storage/s3.js";

export type StorageVnextProviderInventoryItem =
  | { kind: "current"; storageKey: string; byteCount: number }
  | {
    kind: "version";
    storageKey: string;
    versionId: string;
    isLatest: boolean;
    byteCount: number;
  }
  | {
    kind: "delete_marker";
    storageKey: string;
    versionId: string;
    isLatest: boolean;
    byteCount: 0;
  }
  | {
    kind: "multipart";
    storageKey: string;
    uploadId: string;
    initiatedAt: string;
    byteCount: 0;
  };

export type StorageVnextObjectInventory = {
  listPage(input: {
    limit: number;
    cursor: string | null;
  }): Promise<{ items: readonly StorageVnextProviderInventoryItem[]; nextCursor: string | null }>;
  headCurrent(storageKey: string): Promise<boolean>;
};

type InventoryCursor =
  | { phase: "current"; continuationToken: string }
  | { phase: "versions"; keyMarker: string | null; versionIdMarker: string | null }
  | { phase: "multipart"; keyMarker: string | null; uploadIdMarker: string | null };

export function createS3StorageVnextObjectInventory(input: {
  client: S3Client;
  bucket: string;
  prefix: string;
}): StorageVnextObjectInventory {
  const bucket = requireValue(input.bucket);
  const prefix = requireValue(input.prefix).replace(/\/+$/gu, "");
  return {
    async listPage(request) {
      const limit = assertLimit(request.limit);
      const cursor = decodeCursor(request.cursor) ?? {
        phase: "current" as const,
        continuationToken: ""
      };
      if (cursor.phase === "current") {
        const page = await input.client.send(new ListObjectsV2Command({
          Bucket: bucket,
          Prefix: `${prefix}/`,
          MaxKeys: limit,
          ...(cursor.continuationToken
            ? { ContinuationToken: cursor.continuationToken }
            : {})
        }));
        const items = (page.Contents ?? []).map((item) => ({
          kind: "current" as const,
          storageKey: assertOwnedKey(prefix, item.Key),
          byteCount: safeByteCount(item.Size)
        }));
        const nextCursor = page.IsTruncated
          ? encodeCursor({
            phase: "current",
            continuationToken: requirePageMarker(page.NextContinuationToken)
          })
          : encodeCursor({ phase: "versions", keyMarker: null, versionIdMarker: null });
        return { items, nextCursor };
      }
      if (cursor.phase === "versions") {
        let page;
        try {
          page = await input.client.send(new ListObjectVersionsCommand({
            Bucket: bucket,
            Prefix: `${prefix}/`,
            MaxKeys: limit,
            ...(cursor.keyMarker ? { KeyMarker: cursor.keyMarker } : {}),
            ...(cursor.versionIdMarker ? { VersionIdMarker: cursor.versionIdMarker } : {})
          }));
        } catch (error) {
          if (!isS3VersionListingUnsupported(error)) throw error;
          return {
            items: [],
            nextCursor: encodeCursor({
              phase: "multipart",
              keyMarker: null,
              uploadIdMarker: null
            })
          };
        }
        const versions: StorageVnextProviderInventoryItem[] = (page.Versions ?? []).map(
          (item) => ({
            kind: "version",
            storageKey: assertOwnedKey(prefix, item.Key),
            versionId: requirePageMarker(item.VersionId),
            isLatest: item.IsLatest === true,
            byteCount: safeByteCount(item.Size)
          })
        );
        const markers: StorageVnextProviderInventoryItem[] = (page.DeleteMarkers ?? []).map(
          (item) => ({
            kind: "delete_marker",
            storageKey: assertOwnedKey(prefix, item.Key),
            versionId: requirePageMarker(item.VersionId),
            isLatest: item.IsLatest === true,
            byteCount: 0
          })
        );
        const nextCursor = page.IsTruncated
          ? encodeCursor({
            phase: "versions",
            keyMarker: requirePageMarker(page.NextKeyMarker),
            versionIdMarker: page.NextVersionIdMarker ?? null
          })
          : encodeCursor({ phase: "multipart", keyMarker: null, uploadIdMarker: null });
        return { items: [...versions, ...markers], nextCursor };
      }
      const page = await input.client.send(new ListMultipartUploadsCommand({
        Bucket: bucket,
        Prefix: `${prefix}/`,
        MaxUploads: limit,
        ...(cursor.keyMarker ? { KeyMarker: cursor.keyMarker } : {}),
        ...(cursor.uploadIdMarker ? { UploadIdMarker: cursor.uploadIdMarker } : {})
      }));
      const items = (page.Uploads ?? []).map((item) => ({
        kind: "multipart" as const,
        storageKey: assertOwnedKey(prefix, item.Key),
        uploadId: requirePageMarker(item.UploadId),
        initiatedAt: timestamp(item.Initiated),
        byteCount: 0 as const
      }));
      const nextCursor = page.IsTruncated
        ? encodeCursor({
          phase: "multipart",
          keyMarker: requirePageMarker(page.NextKeyMarker),
          uploadIdMarker: page.NextUploadIdMarker ?? null
        })
        : null;
      return { items, nextCursor };
    },

    async headCurrent(storageKey) {
      assertOwnedKey(prefix, storageKey);
      try {
        await input.client.send(new HeadObjectCommand({ Bucket: bucket, Key: storageKey }));
        return true;
      } catch (error) {
        if (isMissing(error)) return false;
        throw error;
      }
    }
  };
}

function assertOwnedKey(prefix: string, value: string | undefined): string {
  if (!value || !value.startsWith(`${prefix}/`) || value.includes("\0")) {
    throw inventoryError("scope_conflict");
  }
  return value;
}

function assertLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 1_000) {
    throw inventoryError("invalid_input");
  }
  return value;
}

function safeByteCount(value: number | undefined): number {
  if (!Number.isSafeInteger(value) || (value ?? -1) < 0) {
    throw inventoryError("invalid_provider_response");
  }
  return value!;
}

function timestamp(value: Date | undefined): string {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw inventoryError("invalid_provider_response");
  }
  return value.toISOString();
}

function requireValue(value: string): string {
  if (!value || value.trim() !== value) throw inventoryError("invalid_input");
  return value;
}

function requirePageMarker(value: string | undefined): string {
  if (!value) throw inventoryError("pagination_incomplete");
  return value;
}

function encodeCursor(cursor: InventoryCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeCursor(value: string | null): InventoryCursor | null {
  if (!value) return null;
  try {
    const cursor = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (!cursor || typeof cursor !== "object" || Array.isArray(cursor)) {
      throw new Error("invalid cursor");
    }
    if (
      cursor.phase === "current"
      && typeof cursor.continuationToken === "string"
      && cursor.continuationToken
    ) return cursor as InventoryCursor;
    if (
      ["versions", "multipart"].includes(cursor.phase)
      && (cursor.keyMarker === null || typeof cursor.keyMarker === "string")
    ) return cursor as InventoryCursor;
    throw new Error("invalid cursor");
  } catch {
    throw inventoryError("invalid_cursor");
  }
}

function isMissing(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const status = "$metadata" in error
    ? (error.$metadata as { httpStatusCode?: number }).httpStatusCode
    : undefined;
  return error.name === "NotFound" || error.name === "NoSuchKey" || status === 404;
}

function inventoryError(code: string): Error {
  return Object.assign(new Error(`Storage vNext S3 inventory error: ${code}`), { code });
}
