import type { StorageVnextOpaqueCursor } from "../shared/types.js";

type CatalogCursorKind =
  | "knowledge_base"
  | "directory"
  | "source_file"
  | "current_source"
  | "source_revision";

export type StorageVnextCatalogCursor = {
  kind: CatalogCursorKind;
  scope: string;
  normalizedPath: string | null;
  publicId: string;
};

export function encodeStorageVnextCatalogCursor(
  cursor: StorageVnextCatalogCursor
): StorageVnextOpaqueCursor {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

export function decodeStorageVnextCatalogCursor(input: {
  cursor: StorageVnextOpaqueCursor | null;
  kind: CatalogCursorKind;
  scope: string;
}): StorageVnextCatalogCursor | null {
  if (!input.cursor) return null;
  try {
    const value = JSON.parse(Buffer.from(input.cursor, "base64url").toString("utf8"));
    if (
      !value
      || typeof value !== "object"
      || Array.isArray(value)
      || value.kind !== input.kind
      || value.scope !== input.scope
      || typeof value.publicId !== "string"
      || !value.publicId
      || (value.normalizedPath !== null && typeof value.normalizedPath !== "string")
    ) {
      throw new Error("Invalid catalog cursor");
    }
    return value as StorageVnextCatalogCursor;
  } catch {
    throw new Error("Invalid catalog cursor");
  }
}
